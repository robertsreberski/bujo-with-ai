import type { JournalSearchFilters as SharedJournalSearchFilters } from '@journal/server/contracts/app';

import type { Destination } from '../components/destination';
import type {
  ActivityView,
  AgentToken,
  Collection,
  Entry,
  EntryPatch,
  EntryType,
  IndexResponse,
  RecentlyDeletedEntry,
  Reflection,
  Settings,
  Summary,
  TagUsage,
} from '../api/types';
import type { LogViewConfig } from '../views/log-arrangement';
import type {
  ActivitySeenCursor,
  ConnectionStatus,
  CreateEntryInput,
  DeadLetter,
  JournalNotice,
  JournalPersistenceState,
  JournalResourceStatus,
  JournalSearchPage,
  MirrorData,
  OutboxItem,
} from './models';

export interface RestoreResult {
  entry: Entry;
  outcome: 'original' | 'daily_fallback' | 'cancelled_offline_delete';
  originalCollectionId: string | null;
}

export type JournalSearchFilters = SharedJournalSearchFilters;

export interface LoadEntriesQuery extends JournalSearchFilters {
  collection?: string;
}

/**
 * The stable state/action contract consumed by the application. Feature modules
 * implement slices of this interface, while journal-store composes the facade.
 */
export interface JournalState extends MirrorData {
  index: IndexResponse | null;
  /** Request lifecycle is separate from the last bounded aggregate snapshot. */
  indexStatus: 'idle' | 'loading' | 'ready' | 'error';
  /** Cached snapshots stay renderable, but are never presented as freshly counted. */
  indexSource: 'none' | 'cached' | 'journal';
  indexError: string | null;
  reflectionsByWeek: Record<string, Reflection>;
  hydrated: boolean;
  loading: boolean;
  /** Canonical rows are kept separate from service availability. */
  resourceStatus: JournalResourceStatus;
  /** Journal endpoint reachability, used by the UI's offline affordance. */
  online: boolean;
  /** Browser network signal, used only to decide whether retries can run. */
  networkOnline: boolean;
  connectionStatus: ConnectionStatus;
  /** Sticky until reload after a 401; never inferred from generic reachability errors. */
  authenticationRequired: boolean;
  /** Latest IndexedDB write result; unavailable means state is only in this open tab. */
  persistenceStatus: JournalPersistenceState;
  syncing: boolean;
  draft: string;
  defaultType: EntryType;
  outbox: OutboxItem[];
  outboxCount: number;
  deadLetters: DeadLetter[];
  recentlyDeleted: RecentlyDeletedEntry[];
  recoveryLoading: boolean;
  notices: JournalNotice[];
  updateReady: boolean;
  offlineReady: boolean;
  agentTokens: AgentToken[];
  tokensLoading: boolean;
  activityLoading: boolean;
  activityHasMore: boolean;
  activityNextCursor: string | null;
  /** IDs mounted by the bounded Timeline projection, never the entire mirror. */
  timelineEntryIds: string[];
  timelineNextCursor: string | null;
  timelineAnchorDate: string | null;
  timelineLoaded: boolean;
  timelineLoading: boolean;
  timelineLoadingEarlier: boolean;
  timelineLatestAgentTouch: ActivityView | null;
  timelineWeeklyReflection: Summary | null;
  /** Capture tag vocabulary; in-memory only, never part of the persisted record. */
  tagSuggestions: TagUsage[];
  tagsFetchedAt: string | null;
  /** Legacy Activity timestamp retained only to hydrate pre-cursor records. */
  lastReviewSeenAt: string | null;
  /** Exact all-seen watermark; unlike the legacy timestamp it cannot hide a same-time event. */
  activitySeenThrough: ActivitySeenCursor | null;
  /** Events acknowledged by actually becoming visible, independent of the all-seen watermark. */
  seenActivityIds: string[];
  markActivityVisible(ids: readonly string[]): void;
  markAllActivitySeen(): void;
  /** @deprecated Compatibility alias for markAllActivitySeen. */
  markReviewSeen(): void;
  /** Per-device monthly-log arrangement; null means the default view. */
  monthLogView: LogViewConfig | null;
  setMonthLogView(config: LogViewConfig | null): void;
  /** One shared per-device arrangement for every collection screen. */
  collectionLogView: LogViewConfig | null;
  setCollectionLogView(config: LogViewConfig | null): void;
  initialize(): Promise<void>;
  shutdown(): void;
  setDraft(draft: string): void;
  setDefaultType(type: EntryType): void;
  createEntry(input: CreateEntryInput): Promise<Entry>;
  updateEntry(id: string, patch: EntryPatch): Promise<Entry>;
  deleteEntry(id: string): Promise<void>;
  restoreEntry(id: string): Promise<RestoreResult>;
  loadRecovery(): Promise<void>;
  toggleEntry(id: string): Promise<Entry>;
  migrateEntry(id: string, target?: string): Promise<Entry>;
  scheduleEntry(id: string, month?: string): Promise<Entry>;
  createCollection(input: { id: string; name: string; note?: string | null }): Promise<Collection>;
  updateCollection(
    id: string,
    patch: { name?: string; note?: string | null; archived?: boolean },
  ): Promise<Collection>;
  saveSummary(id?: string): Promise<Summary>;
  rewriteSummary(id?: string): Promise<Summary>;
  loadReflections(): Promise<Reflection[]>;
  requestReflection(id: string): Promise<Reflection>;
  retryReflection(id: string): Promise<Reflection>;
  restoreReflectionVersion(id: string, versionId: string): Promise<Reflection>;
  revertActivity(id: string): Promise<ActivityView>;
  updateSettings(
    patch: Partial<
      Pick<Settings, 'density' | 'showTypeBadges' | 'highlightAiEntries' | 'savedViews'>
    >,
  ): Promise<Settings>;
  searchEntries(query: string, cursor?: string): Promise<JournalSearchPage>;
  loadEntry(id: string): Promise<Entry>;
  loadEntries(query: LoadEntriesQuery): Promise<Entry[]>;
  loadTimeline(anchorDate?: string | null): Promise<Entry[]>;
  loadEarlierTimeline(): Promise<Entry[]>;
  loadIndex(): Promise<IndexResponse>;
  loadDate(date: string): Promise<Entry[]>;
  loadMonth(month: string): Promise<Entry[]>;
  loadCollection(id: string): Promise<Entry[]>;
  loadMoreActivity(): Promise<void>;
  loadTagSuggestions(): Promise<void>;
  retryDeadLetter(id: string): Promise<void>;
  discardDeadLetter(id: string): Promise<void>;
  dismissNotice(id: string): void;
  refreshTokens(): Promise<void>;
  createToken(label: string): Promise<{ token: AgentToken; secret: string }>;
  revokeToken(id: string): Promise<void>;
  activateUpdate(): Promise<void>;
  composerPreset: { destination: Destination | null; nonce: number } | null;
  focusComposer(destination?: Destination): void;
}
