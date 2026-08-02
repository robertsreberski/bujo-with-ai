import type {
  ActivityView,
  AgentToken,
  Collection,
  DateIntent,
  Entry,
  EntryPatch,
  EntryType,
  McpStatus,
  OwnerEntryCreate,
  Settings,
  Summary,
} from '../api/types';
import type { LogViewConfig } from '../views/log-arrangement';

export type ConnectionStatus = 'offline' | 'connecting' | 'connected' | 'error';

/** Whether the canonical rows needed to render the journal are available. */
export type JournalResourceStatus = 'loading' | 'ready' | 'error';

/**
 * Owner-facing availability of the Journal service. This deliberately does
 * not include outbox state: a device can be offline and still have changes
 * safely waiting on it.
 */
export type JournalConnectionState =
  | 'initializing'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'serverUnavailable'
  | 'authenticationRequired';

/** The independently observable state of locally queued changes. */
export type JournalSynchronizationState = 'idle' | 'pending' | 'syncing' | 'attention';

/** Whether the current local mirror and outbox survived their latest durable write. */
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

export interface EntryIndexes {
  entryIdsByDate: Record<string, string[]>;
  entryIdsByCollection: Record<string, string[]>;
}

export interface MirrorData extends EntryIndexes {
  entriesById: Record<string, Entry>;
  collectionsById: Record<string, Collection>;
  activityById: Record<string, ActivityView>;
  activityOrder: string[];
  /** Greatest-weekStart summary fetched for each displayed YYYY-MM month. */
  summariesByMonth: Record<string, Summary | null>;
  latestSummary: Summary | null;
  settings: Settings;
  mcpStatus: McpStatus | null;
  today: string;
  /** Last server-issued date, retained across offline midnight rollover. */
  serverToday: string;
  timezone: string;
  cursor: string | null;
  deviceId: string | null;
}

interface CommandBase {
  at: string;
}

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

export interface JournalClientRecord {
  version: 1;
  savedAt: string;
  mirror: MirrorData;
  draft: string;
  defaultType: EntryType;
  outbox: OutboxItem[];
  deadLetters: DeadLetter[];
  /** Secret-free token metadata retained for offline Activity attribution. */
  agentTokens: AgentToken[];
  /**
   * When the owner last opened Review, for the unseen-change count. Optional
   * because records written before the count existed simply do not have it;
   * they hydrate as `null`, which reads every recorded change as unseen.
   */
  lastReviewSeenAt?: string | null;
  /**
   * Per-device monthly-log arrangement. Optional for the same reason as the
   * review mark: older records lack it and hydrate as `null`, which means
   * "use the default view".
   */
  monthLogView?: LogViewConfig | null;
  /** One shared per-device arrangement for every collection screen. */
  collectionLogView?: LogViewConfig | null;
  /** One bounded chronological page, retained so the Timeline works offline. */
  timeline?: {
    loaded: boolean;
    entryIds: string[];
    nextCursor: string | null;
    anchorDate: string | null;
    latestAgentTouch: ActivityView | null;
    weeklyReflection: Summary | null;
  };
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

export interface CaptureContext {
  dateIntent: DateIntent;
  targetDate: string;
}
