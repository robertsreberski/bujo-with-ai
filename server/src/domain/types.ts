import type {
  ActivityItem,
  ActivityKind,
  ActivitySnapshot,
  ActivityView,
  AgentToken,
  AgentTokenScope,
  Change,
  ChangeBatch,
  Collection,
  Entry,
  EntryAuthor,
  EntryPatch,
  EntryState,
  EntryType,
  JournalExport,
  JournalExportV1,
  JournalExportV2,
  MigrationKind,
  MigrationOperation,
  SearchInput,
  Settings,
  Summary,
  TagUsage,
} from '../contracts/index.js';

export type {
  ActivityItem,
  ActivityKind,
  ActivitySnapshot,
  ActivityView,
  AgentToken,
  AgentTokenScope,
  Change,
  ChangeBatch,
  Collection,
  Entry,
  EntryAuthor,
  EntryPatch,
  EntryState,
  EntryType,
  JournalExport,
  JournalExportV1,
  JournalExportV2,
  Settings,
  Summary,
  TagUsage,
};

export type Author = EntryAuthor;
export type Snapshot = ActivitySnapshot;
export type AgentTokenRecord = AgentToken;
export type SearchEntriesInput = Omit<SearchInput, 'limit'> & {
  readonly limit?: number;
  readonly includeDeleted?: boolean;
  readonly offset?: number;
};

export interface SearchEntriesResult {
  readonly total: number;
  readonly entries: readonly Entry[];
}

export interface RecentlyDeletedEntry {
  readonly entry: Entry;
  readonly expiresAt: string;
  readonly destination: {
    readonly collectionId: string | null;
    readonly collectionName: string | null;
    readonly status: 'daily' | 'active' | 'archived' | 'missing';
  };
}

export interface DayResult {
  readonly date: string;
  readonly isToday: boolean;
  readonly entries: readonly Entry[];
  readonly leftovers: { readonly count: number; readonly entries: readonly Entry[] };
}

export type ActorKind = 'owner' | 'agent' | 'system';

export type ActorContext =
  | {
      readonly kind: 'owner';
      readonly deviceId: string;
      readonly label?: string;
    }
  | {
      readonly kind: 'agent';
      readonly tokenId: string;
      readonly tokenLabel: string;
      readonly tool?: string;
      readonly tailscaleUserLogin?: string;
    }
  | {
      readonly kind: 'system';
      readonly label?: string;
    };

export interface MutationContext {
  /** REST mutation ULID or MCP caller idempotency key. */
  readonly id: string;
  /** Original HTTP success status retained with replay metadata. */
  readonly statusCode?: number;
  /** Full canonical transport command when it contains intent beyond the reduced domain input. */
  readonly request?: unknown;
}

export interface CreateEntryInput {
  readonly id?: string;
  readonly text: string;
  readonly type?: EntryType;
  readonly date?: string;
  readonly time?: string | null;
  readonly tags?: readonly string[];
  readonly collection?: string | null;
  readonly source?: string;
  readonly summaryWeekStart?: string;
  /** Compatibility alias accepted internally; summaryWeekStart is canonical. */
  readonly weekStart?: string;
}

export type AgentMigrationOp = MigrationOperation;

export interface ApplyAgentMigrationInput {
  readonly kind: MigrationKind;
  readonly title: string;
  readonly detail: string;
  readonly ops: readonly AgentMigrationOp[];
  readonly lines?: readonly string[];
  readonly source?: string;
}

export type EntryWriteResult =
  | { readonly kind: 'entry'; readonly entry: Entry; readonly activityId?: string }
  | { readonly kind: 'summary'; readonly summary: Summary; readonly activityId: string };

export interface AgentMigrationResult {
  readonly entries: readonly Entry[];
  readonly activityId: string;
}

export interface IssuedAgentToken {
  readonly token: AgentToken;
  readonly secret: string;
}

export interface AuthenticatedAgent {
  readonly tokenId: string;
  readonly tokenLabel: string;
  readonly scopes: readonly AgentTokenScope[];
}

export interface PairedDevice {
  readonly deviceId: string;
  readonly secret: string;
  readonly expiresAt: string;
}

export interface AuthenticatedDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly expiresAt: string;
}

export interface ImportReport {
  readonly inserted: Readonly<
    Record<'entries' | 'collections' | 'activity' | 'summaries' | 'settings', number>
  >;
  readonly skipped: Readonly<
    Record<'entries' | 'collections' | 'activity' | 'summaries' | 'settings', number>
  >;
}

export type ActivityRefs = ActivityItem['refs'];
export type EntityChange = Change;

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}
