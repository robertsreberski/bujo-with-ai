import type {
  ActivityView,
  AgentToken,
  Collection,
  DateIntent,
  Entry,
  EntryType,
  IndexResponse,
  McpStatus,
  Reflection,
  Settings,
  Summary,
} from '../api/types';
import type { DeadLetter, LogViewConfig, OutboxItem } from '../domain/contracts';

/** Compatibility exports for store consumers; neutral contracts own these types. */
export type {
  ConnectionStatus,
  CreateEntryInput,
  DeadLetter,
  JournalConnectionState,
  JournalNotice,
  JournalPersistenceState,
  JournalResourceStatus,
  JournalSearchPage,
  JournalStatus,
  JournalSynchronizationState,
  OutboxItem,
  QueueableCommand,
} from '../domain/contracts';

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
  /** Versioned weekly Reflections keyed by their Monday boundary. */
  reflectionsByWeek?: Record<string, Reflection>;
  settings: Settings;
  /** Bounded server-owned aggregate snapshot; optional on pre-index persisted records. */
  index?: IndexResponse | null;
  mcpStatus: McpStatus | null;
  today: string;
  /** Last server-issued date, retained across offline midnight rollover. */
  serverToday: string;
  timezone: string;
  cursor: string | null;
  deviceId: string | null;
}

export interface ActivitySeenCursor {
  at: string;
  id: string;
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
   * Legacy Activity timestamp from records written before exact cursors and
   * visible-row acknowledgement. New writes retain it for rollback safety.
   */
  lastReviewSeenAt?: string | null;
  /** Exact high-water mark set only by the explicit "Mark all seen" action. */
  activitySeenThrough?: ActivitySeenCursor | null;
  /** Individually acknowledged rows that actually crossed the Activity viewport. */
  seenActivityIds?: string[];
  /**
   * Per-device monthly-log arrangement. Optional for the same reason as the
   * Activity mark: older records lack it and hydrate as `null`, which means
   * "use the default view".
   */
  monthLogView?: LogViewConfig | null;
  /** One shared per-device arrangement for every collection screen. */
  collectionLogView?: LogViewConfig | null;
  /**
   * The month whose start-of-month review has been waved off, as `YYYY-MM`.
   * Per-device like the arrangements: declining the ritual is a preference,
   * not a fact about the journal.
   */
  monthReviewDismissed?: string | null;
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

export interface CaptureContext {
  dateIntent: DateIntent;
  targetDate: string;
}
