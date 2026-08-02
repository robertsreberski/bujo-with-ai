import { ApiError, journalApi } from '../api/client';
import type { Collection, Entry, RecentlyDeletedEntry } from '../api/types';
import { createUlid } from './ids';
import type { QueueableCommand } from './models';
import {
  applyPendingCommands,
  recomputeActivityRevertEligibility,
  removeServerEntry,
  upsertServerEntry,
} from './optimistic';
import { mirrorFromState, type JournalFeatureRuntime } from './runtime';
import type { JournalState } from './state';

const RECOVERY_WINDOW_MS = 30 * 86_400_000;
const restoreMutationIds = new Map<string, string>();

export interface RecoveryDependencies {
  runtime: JournalFeatureRuntime;
  enqueueCommand(command: QueueableCommand): Promise<void>;
  activeOutboxMutationId(): string | null;
  flushing(): Promise<void> | null;
  timelineIdsWithRestoredEntry(
    state: Pick<JournalState, 'timelineEntryIds' | 'timelineAnchorDate'>,
    entry: Entry,
  ): string[];
}

type RecoveryActions = Pick<JournalState, 'deleteEntry' | 'restoreEntry' | 'loadRecovery'>;

export function clearRecoveryMutationIds(): void {
  restoreMutationIds.clear();
}

async function restoreEntryCanonically(
  id: string,
  expectedRevision: number,
  runtime: JournalFeatureRuntime,
): Promise<Awaited<ReturnType<typeof journalApi.restoreEntry>>> {
  const attempt = `${id}:${expectedRevision}`;
  const mutationId = restoreMutationIds.get(attempt) ?? createUlid();
  restoreMutationIds.set(attempt, mutationId);
  try {
    const response = await runtime.authenticated(() =>
      journalApi.restoreEntry(id, mutationId, expectedRevision),
    );
    restoreMutationIds.delete(attempt);
    return response;
  } catch (error) {
    // Keep indeterminate attempts idempotent across owner retries.
    if (error instanceof ApiError && error.status > 0 && error.status !== 401 && !error.retryable) {
      restoreMutationIds.delete(attempt);
    }
    throw error;
  }
}

export function recoveryRecord(
  entry: Entry,
  collectionsById: Record<string, Collection>,
): RecentlyDeletedEntry {
  if (entry.deletedAt === null) throw new Error('Only deleted entries belong in Recovery.');
  const collection = entry.collection === null ? undefined : collectionsById[entry.collection];
  return {
    entry,
    expiresAt: new Date(Date.parse(entry.deletedAt) + RECOVERY_WINDOW_MS).toISOString(),
    destination:
      entry.collection === null
        ? { collectionId: null, collectionName: null, status: 'daily' }
        : collection === undefined
          ? { collectionId: entry.collection, collectionName: null, status: 'missing' }
          : {
              collectionId: entry.collection,
              collectionName: collection.name,
              status: collection.archivedAt === null ? 'active' : 'archived',
            },
  };
}

export function localRecoveryRecords(
  entriesById: Record<string, Entry>,
  collectionsById: Record<string, Collection>,
): RecentlyDeletedEntry[] {
  return Object.values(entriesById)
    .filter(
      (entry): entry is Entry & { deletedAt: string } =>
        entry.deletedAt !== null && Date.parse(entry.deletedAt) + RECOVERY_WINDOW_MS > Date.now(),
    )
    .map((entry) => recoveryRecord(entry, collectionsById))
    .sort(
      (left, right) =>
        (right.entry.deletedAt ?? '').localeCompare(left.entry.deletedAt ?? '') ||
        right.entry.id.localeCompare(left.entry.id),
    );
}

export function createRecoveryActions(dependencies: RecoveryDependencies): RecoveryActions {
  const { runtime } = dependencies;
  return {
    deleteEntry: async (id) => {
      const entry = runtime.get().entriesById[id];
      if (!entry || entry.deletedAt !== null) throw new Error('Entry no longer exists.');
      await dependencies.enqueueCommand({
        kind: 'entry.delete',
        id,
        expectedRevision: entry.revision,
        original: entry,
        at: new Date().toISOString(),
      });
      const deleted = runtime.get().entriesById[id];
      if (deleted?.deletedAt) {
        runtime.set((state) => ({
          recentlyDeleted: [
            recoveryRecord(deleted, state.collectionsById),
            ...state.recentlyDeleted.filter((item) => item.entry.id !== id),
          ],
        }));
      }
    },

    restoreEntry: async (id) => {
      const state = runtime.get();
      const pending = state.outbox.find(
        (item) => item.command.kind === 'entry.delete' && item.command.id === id,
      );
      if (pending?.command.kind === 'entry.delete') {
        const pendingDelete = pending.command;
        const inFlight =
          dependencies.activeOutboxMutationId() === pending.mutationId
            ? dependencies.flushing()
            : null;
        const deleted =
          state.entriesById[id] ??
          state.recentlyDeleted.find((item) => item.entry.id === id)?.entry;
        const original =
          pendingDelete.original ??
          (deleted
            ? {
                ...deleted,
                deletedAt: null,
                revision: pendingDelete.expectedRevision ?? Math.max(1, deleted.revision - 1),
              }
            : undefined);
        if (!original) throw new Error('Deleted entry is no longer available locally.');
        runtime.set((current) => {
          const outbox = current.outbox.filter((item) => item.mutationId !== pending.mutationId);
          const mirror = recomputeActivityRevertEligibility(
            applyPendingCommands(
              upsertServerEntry(removeServerEntry(mirrorFromState(current), id), original),
              outbox,
            ),
          );
          return {
            ...mirror,
            indexSource: mirror.index === null ? 'none' : 'cached',
            timelineEntryIds: dependencies.timelineIdsWithRestoredEntry(current, original),
            outbox,
            outboxCount: outbox.length,
            recentlyDeleted: current.recentlyDeleted.filter((item) => item.entry.id !== id),
          };
        });
        await runtime.persistNow();
        if (!inFlight) {
          return {
            entry: original,
            outcome: 'cancelled_offline_delete' as const,
            originalCollectionId: original.collection,
          };
        }
        await inFlight;
        if (!runtime.get().networkOnline || runtime.pairingExpired()) {
          throw new ApiError(
            0,
            'network_error',
            'The delete may have reached the server. Reconnect and restore it from Recovery.',
          );
        }
        try {
          const response = await restoreEntryCanonically(
            id,
            (pendingDelete.expectedRevision ?? original.revision) + 1,
            runtime,
          );
          const mirror = upsertServerEntry(mirrorFromState(runtime.get()), response.entry);
          runtime.set((current) => ({
            ...mirror,
            indexSource: mirror.index === null ? 'none' : 'cached',
            timelineEntryIds: dependencies.timelineIdsWithRestoredEntry(current, response.entry),
            recentlyDeleted: current.recentlyDeleted.filter((item) => item.entry.id !== id),
          }));
          await runtime.persistNow();
          return {
            entry: response.entry,
            outcome: response.destination.outcome,
            originalCollectionId: response.destination.originalCollectionId,
          };
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            return {
              entry: original,
              outcome: 'cancelled_offline_delete' as const,
              originalCollectionId: original.collection,
            };
          }
          throw error;
        }
      }

      runtime.requireOnline();
      const deleted =
        state.recentlyDeleted.find((item) => item.entry.id === id)?.entry ?? state.entriesById[id];
      if (!deleted?.deletedAt) throw new Error('Deleted entry is no longer recoverable.');
      const response = await restoreEntryCanonically(id, deleted.revision, runtime);
      const mirror = upsertServerEntry(mirrorFromState(runtime.get()), response.entry);
      runtime.set((current) => ({
        ...mirror,
        indexSource: mirror.index === null ? 'none' : 'cached',
        timelineEntryIds: dependencies.timelineIdsWithRestoredEntry(current, response.entry),
        recentlyDeleted: current.recentlyDeleted.filter((item) => item.entry.id !== id),
      }));
      await runtime.persistNow();
      return {
        entry: response.entry,
        outcome: response.destination.outcome,
        originalCollectionId: response.destination.originalCollectionId,
      };
    },

    loadRecovery: async () => {
      const state = runtime.get();
      runtime.set({
        recentlyDeleted: localRecoveryRecords(state.entriesById, state.collectionsById),
      });
      if (!state.online) return;
      const lifecycle = runtime.lifecycleGeneration();
      runtime.set({ recoveryLoading: true });
      try {
        const response = await runtime.authenticated(() => journalApi.listRecentlyDeleted());
        if (lifecycle !== runtime.lifecycleGeneration()) return;
        runtime.set((current) => {
          // Merge at commit time so intervening restores suppress stale tombstones.
          const items = new Map<string, RecentlyDeletedEntry>();
          for (const item of response.items) {
            const currentEntry = current.entriesById[item.entry.id];
            if (currentEntry?.deletedAt === null) continue;
            items.set(item.entry.id, item);
          }
          for (const item of localRecoveryRecords(current.entriesById, current.collectionsById)) {
            items.set(item.entry.id, item);
          }
          return { recentlyDeleted: [...items.values()] };
        });
      } finally {
        if (lifecycle === runtime.lifecycleGeneration()) runtime.set({ recoveryLoading: false });
      }
    },
  };
}
