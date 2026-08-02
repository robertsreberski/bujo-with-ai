import type { Collection, Entry, EntryPatch, EntryType, OwnerEntryCreate } from '../api/types';

/** Canonical entry-type order shared by domain policy and presentation. */
export const ENTRY_TYPES = [
  'task',
  'event',
  'note',
  'idea',
  'question',
  'habit',
  'mood',
] as const satisfies readonly EntryType[];

/** Where a capture lands: a calendar day, or a (possibly monthly) collection. */
export type Destination = { kind: 'date'; date: string } | { kind: 'collection'; id: string };

export type DestinationSource = 'token' | 'chip' | 'screen';

export interface ResolvedDestination {
  destination: Destination;
  source: DestinationSource;
  /** True when filing here would mint a collection the mirror has never seen. */
  createsCollection: boolean;
  /** A date explicitly stated alongside a collection destination. */
  statedDate: string | null;
}

/** Persisted arrangement for monthly and collection logs. */
export type LogSort = 'newest' | 'oldest';
export type LogGroup = 'none' | 'type';
export type LogStateFilter = 'open' | 'all' | 'closed';

export interface LogViewConfig {
  sort: LogSort;
  group: LogGroup;
  stateFilter: LogStateFilter;
  /** Type narrowing; empty means every type. */
  types: EntryType[];
}

/** Day 1 up, the way a paper monthly log reads. */
export const DEFAULT_LOG_VIEW: LogViewConfig = Object.freeze({
  sort: 'oldest',
  group: 'none',
  stateFilter: 'open',
  types: [],
});

export type ConnectionStatus = 'offline' | 'connecting' | 'connected' | 'error';

/** Whether the canonical rows needed to render the journal are available. */
export type JournalResourceStatus = 'loading' | 'ready' | 'error';

/** Owner-facing availability of the Journal service. */
export type JournalConnectionState =
  | 'initializing'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'serverUnavailable'
  | 'authenticationRequired';

/** Independently observable state of locally queued changes. */
export type JournalSynchronizationState = 'idle' | 'pending' | 'syncing' | 'attention';

/** Whether the latest durable local write succeeded. */
export type JournalPersistenceState = 'available' | 'unavailable';

/** One authoritative search page, either from Journal or the downloaded mirror. */
export interface JournalSearchPage {
  items: Entry[];
  nextCursor: string | null;
  hasMore: boolean;
  source: 'journal' | 'downloaded';
  reason: 'offline' | 'unavailable' | null;
}

/** A truthful UI projection over resource, transport, and mutation state. */
export interface JournalStatus {
  resource: JournalResourceStatus;
  connection: JournalConnectionState;
  synchronization: JournalSynchronizationState;
  persistence: JournalPersistenceState;
  pendingChanges: number;
  failedChanges: number;
}

interface CommandBase {
  at: string;
}

/** Durable mutation vocabulary shared by the store and Recovery UI. */
export type QueueableCommand =
  | (CommandBase & {
      kind: 'entry.create';
      input: OwnerEntryCreate;
      entry: Entry;
    })
  | (CommandBase & {
      kind: 'entry.update';
      id: string;
      patch: EntryPatch;
      expectedRevision?: number;
    })
  | (CommandBase & {
      kind: 'entry.delete';
      id: string;
      expectedRevision?: number;
      /** Canonical pre-delete row retained so an offline delete can be undone exactly. */
      original?: Entry;
    })
  | (CommandBase & {
      kind: 'entry.migrate';
      id: string;
      target: string;
      expectedRevision?: number;
      copy: Entry;
    })
  | (CommandBase & {
      kind: 'entry.schedule';
      id: string;
      month: string;
      expectedRevision?: number;
      copy: Entry;
      collection: Collection;
    })
  | (CommandBase & {
      kind: 'collection.create';
      collection: Collection;
    })
  | (CommandBase & {
      kind: 'collection.update';
      id: string;
      patch: { name?: string; note?: string | null; archived?: boolean };
    });

export interface OutboxItem {
  mutationId: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  enqueuedAt: string;
  command: QueueableCommand;
}

export interface DeadLetter {
  id: string;
  mutationId: string;
  message: string;
  code: string;
  failedAt: string;
  operation: QueueableCommand['kind'];
  item: OutboxItem;
}

export interface JournalNotice {
  id: string;
  kind: 'assistant' | 'device' | 'error' | 'info';
  message: string;
  at: string;
}

export interface CreateEntryInput {
  id?: string;
  text: string;
  type: EntryType;
  time?: string | null;
  tags?: string[];
  collection?: string | null;
  date?: string;
  dateShift?: 'tomorrow' | null;
  /** Accepted for view-model compatibility; the server owns initial state. */
  state?: Entry['state'];
}
