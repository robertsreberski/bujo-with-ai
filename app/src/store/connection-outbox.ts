import { journalApi } from '../api/client';
import type { Collection, Entry } from '../api/types';
import { createUlid } from './ids';
import type { JournalStatus, MirrorData, OutboxItem, QueueableCommand } from './models';
import { upsertServerCollection, upsertServerEntry } from './optimistic';
import type { JournalState } from './state';

export interface ServerRows {
  entries?: Entry[];
  collections?: Collection[];
}

/** Converts optimistic domain commands into the durable HTTP outbox contract. */
export function descriptorForCommand(
  command: QueueableCommand,
  mutationId = createUlid(),
): OutboxItem {
  switch (command.kind) {
    case 'entry.create':
      return {
        mutationId,
        method: 'POST',
        path: '/api/entries',
        body: command.input,
        enqueuedAt: command.at,
        command,
      };
    case 'entry.update':
      return {
        mutationId,
        method: 'PATCH',
        path: `/api/entries/${command.id}`,
        body: {
          patch: command.patch,
          ...(command.expectedRevision === undefined
            ? {}
            : { expectedRevision: command.expectedRevision }),
        },
        enqueuedAt: command.at,
        command,
      };
    case 'entry.delete':
      return {
        mutationId,
        method: 'DELETE',
        path: `/api/entries/${command.id}`,
        enqueuedAt: command.at,
        command,
      };
    case 'entry.migrate':
      return {
        mutationId,
        method: 'POST',
        path: `/api/entries/${command.id}/migrate`,
        body: {
          newEntryId: command.copy.id,
          target: command.target,
          ...(command.expectedRevision === undefined
            ? {}
            : { expectedRevision: command.expectedRevision }),
        },
        enqueuedAt: command.at,
        command,
      };
    case 'entry.schedule':
      return {
        mutationId,
        method: 'POST',
        path: `/api/entries/${command.id}/schedule`,
        body: {
          copyId: command.copy.id,
          month: command.month,
          ...(command.expectedRevision === undefined
            ? {}
            : { expectedRevision: command.expectedRevision }),
        },
        enqueuedAt: command.at,
        command,
      };
    case 'collection.create':
      return {
        mutationId,
        method: 'POST',
        path: '/api/collections',
        body: {
          id: command.collection.id,
          name: command.collection.name,
          note: command.collection.note,
        },
        enqueuedAt: command.at,
        command,
      };
    case 'collection.update':
      return {
        mutationId,
        method: 'PATCH',
        path: `/api/collections/${command.id}`,
        body: command.patch,
        enqueuedAt: command.at,
        command,
      };
  }
}

export function affectedEntryIds(command: QueueableCommand): ReadonlySet<string> {
  switch (command.kind) {
    case 'entry.create':
      return new Set([command.entry.id]);
    case 'entry.update':
    case 'entry.delete':
      return new Set([command.id]);
    case 'entry.migrate':
    case 'entry.schedule':
      return new Set([command.id, command.copy.id]);
    case 'collection.create':
    case 'collection.update':
      return new Set();
  }
}

export function affectedCollectionIds(command: QueueableCommand): ReadonlySet<string> {
  switch (command.kind) {
    case 'collection.create':
      return new Set([command.collection.id]);
    case 'collection.update':
      return new Set([command.id]);
    case 'entry.create':
    case 'entry.update':
    case 'entry.delete':
    case 'entry.migrate':
    case 'entry.schedule':
      return new Set();
  }
}

/** Executes exactly one outbox descriptor; ordering/retry remains the facade's responsibility. */
export async function sendOutboxItem(item: OutboxItem): Promise<ServerRows> {
  const command = item.command;
  switch (command.kind) {
    case 'entry.create': {
      const response = await journalApi.createEntry(command.input, item.mutationId);
      return { entries: [response.entry] };
    }
    case 'entry.update': {
      const response = await journalApi.updateEntry(
        command.id,
        command.patch,
        item.mutationId,
        command.expectedRevision,
      );
      return { entries: [response.entry] };
    }
    case 'entry.delete': {
      const response = await journalApi.deleteEntry(
        command.id,
        item.mutationId,
        command.expectedRevision,
      );
      return { entries: [response.entry] };
    }
    case 'entry.migrate': {
      const response = await journalApi.migrateEntry(
        command.id,
        {
          newEntryId: command.copy.id,
          target: command.target,
          ...(command.expectedRevision === undefined
            ? {}
            : { expectedRevision: command.expectedRevision }),
        },
        item.mutationId,
      );
      return { entries: [response.original, response.copy] };
    }
    case 'entry.schedule': {
      const response = await journalApi.scheduleEntry(
        command.id,
        {
          copyId: command.copy.id,
          month: command.month,
          ...(command.expectedRevision === undefined
            ? {}
            : { expectedRevision: command.expectedRevision }),
        },
        item.mutationId,
      );
      return {
        entries: [response.original, response.copy],
        ...(response.collection ? { collections: [response.collection] } : {}),
      };
    }
    case 'collection.create': {
      const response = await journalApi.createCollection(
        {
          id: command.collection.id,
          name: command.collection.name,
          note: command.collection.note,
        },
        item.mutationId,
      );
      return { collections: [response.collection] };
    }
    case 'collection.update': {
      const response = await journalApi.updateCollection(
        command.id,
        command.patch,
        item.mutationId,
      );
      return { collections: [response.collection] };
    }
  }
}

export function applyServerRows(mirror: MirrorData, rows: ServerRows): MirrorData {
  let next = mirror;
  for (const entry of rows.entries ?? []) next = upsertServerEntry(next, entry);
  for (const collection of rows.collections ?? []) next = upsertServerCollection(next, collection);
  return next;
}

export function rebaseCommand(
  command: QueueableCommand,
  state: Pick<JournalState, 'entriesById'>,
  at = new Date().toISOString(),
): QueueableCommand {
  if (
    command.kind === 'entry.update' ||
    command.kind === 'entry.delete' ||
    command.kind === 'entry.migrate' ||
    command.kind === 'entry.schedule'
  ) {
    const current = state.entriesById[command.id];
    if (current) return { ...command, at, expectedRevision: current.revision };
    const rebased = { ...command, at };
    delete rebased.expectedRevision;
    return rebased;
  }
  return { ...command, at };
}

/** Projects transport and outbox facts into the shell's stable owner vocabulary. */
export const selectJournalStatus = (state: JournalState): JournalStatus => {
  const connection: JournalStatus['connection'] =
    !state.hydrated || state.resourceStatus === 'loading'
      ? 'initializing'
      : state.authenticationRequired
        ? 'authenticationRequired'
        : !state.networkOnline || state.connectionStatus === 'offline'
          ? 'offline'
          : state.connectionStatus === 'error'
            ? 'serverUnavailable'
            : state.connectionStatus === 'connecting' || !state.online
              ? 'reconnecting'
              : 'online';
  const synchronization: JournalStatus['synchronization'] =
    state.deadLetters.length > 0 || state.persistenceStatus === 'unavailable'
      ? 'attention'
      : state.syncing
        ? 'syncing'
        : state.outboxCount > 0
          ? 'pending'
          : 'idle';

  return {
    resource: state.resourceStatus,
    connection,
    synchronization,
    persistence: state.persistenceStatus,
    pendingChanges: state.outboxCount,
    failedChanges: state.deadLetters.length,
  };
};
