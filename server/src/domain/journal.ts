import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { JournalConfig } from '../config.js';
import { journalDate } from '../config.js';
import {
  ActivityItemSchema,
  AgentTokenScopeSchema,
  AgentTokenSchema,
  CalendarMonthSchema,
  EntrySchema,
  JournalExportSchema,
  JournalExportV2Schema,
  ReflectionSchema,
  SettingsSchema,
  SummaryReflectionRevertSchema,
  SummarySchema,
} from '../contracts/index.js';
import type { JournalDatabase } from '../db/database.js';
import { ActivityReflection } from './activity-reflection.js';
import { CollectionRecovery } from './collection-recovery.js';
import { EntryCommands } from './entry-commands.js';
import { DomainError } from './errors.js';
import {
  activityChange,
  activityContentExpired,
  actorRefs,
  collectionChange,
  entryChange,
  entryCreatedChange,
  expiredActivityLabel,
  invalid,
  insertEntry as insertStoredEntry,
  isMonday,
  mapActivity,
  mapCollection,
  mapEntry,
  mapSummary,
  matchesAutomaticStaleDelta,
  monotonicTimestamp,
  mondayOf,
  normalizeSource,
  normalizeText,
  parseStringArray,
  reflectionChange,
  replaceEntry as replaceStoredEntry,
  selectEntry as selectStoredEntry,
  snapshotEntry,
  snapshotEqual,
  snapshotSummary,
  stableJson,
  summaryChange,
  upsertChange,
  validateDate,
  validateId,
} from './kernel.js';
import type {
  ActivityAuditPort,
  ActivityRow,
  CollectionRow,
  CollectionDestinationPort,
  EntryRow,
  EntryPersistencePort,
  JournalWritePort,
  ReflectionSlotRow,
  SummaryRow,
  WriteContext,
} from './kernel.js';
import { JournalSearchParseError, parseJournalSearch } from './search-query.js';
import type {
  ActivityItem,
  ActivityKind,
  ActivityView,
  ActorContext,
  AgentMigrationResult,
  AgentTokenRecord,
  AgentTokenScope,
  ApplyAgentMigrationInput,
  AuthenticatedAgent,
  AuthenticatedDevice,
  ChangeBatch,
  Collection,
  CreateEntryInput,
  DayResult,
  EntityChange,
  Entry,
  EntryPatch,
  EntryType,
  EntryWriteResult,
  ImportReport,
  IssuedAgentToken,
  JournalExport,
  JournalExportV1,
  JournalExportV2,
  MutationContext,
  PairedDevice,
  RateLimitResult,
  Reflection,
  RecentlyDeletedEntry,
  SearchEntriesInput,
  SearchEntriesResult,
  Snapshot,
  Settings,
  Summary,
  SummaryReflectionRevert,
  TagUsage,
} from './types.js';
import { TimelineQueries } from './timeline-queries.js';

function mapAgentToken(row: AgentTokenRow): AgentTokenRecord {
  return AgentTokenSchema.parse({
    id: row.id,
    label: row.label,
    scopes: parseStringArray(row.scopes),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  });
}

function validateEntry(entry: Entry): void {
  EntrySchema.parse(entry);
}

function validateSummary(summary: Summary): void {
  SummarySchema.parse(summary);
}

function validateActivity(activity: ActivityItem): void {
  ActivityItemSchema.parse(activity);
}

function validateExport(document: JournalExport): {
  readonly journal: JournalExportV1 | JournalExportV2['journal'];
  readonly reflections: readonly Reflection[];
  readonly summaryReflectionReverts: readonly SummaryReflectionRevert[];
} {
  const parsed = JournalExportSchema.parse(document);
  return parsed.version === 1
    ? { journal: parsed, reflections: [], summaryReflectionReverts: [] }
    : {
        journal: parsed.journal,
        reflections: parsed.derived?.reflections?.items ?? [],
        summaryReflectionReverts: parsed.derived?.summaryReflectionReverts?.items ?? [],
      };
}

function validateSavedViewQueries(views: NonNullable<Settings['savedViews']> | undefined): void {
  for (const view of views ?? []) {
    try {
      parseJournalSearch(view.query);
    } catch (error) {
      if (error instanceof JournalSearchParseError) {
        invalid(`Saved view ${view.id} has an invalid query: ${error.message}`);
      }
      throw error;
    }
  }
}

function validateActor(actor: ActorContext): void {
  switch (actor.kind) {
    case 'owner':
      validateId(actor.deviceId);
      return;
    case 'agent':
      validateId(actor.tokenId);
      normalizeText(actor.tokenLabel, 80, 'token label');
      if (actor.tool !== undefined) normalizeText(actor.tool, 80, 'tool name');
      return;
    case 'system':
      return;
  }
}

function validateMutationKey(value: string): void {
  if (!/^[\x21-\x7e]{8,128}$/.test(value))
    invalid('Mutation key must be 8 to 128 visible ASCII characters');
}

function normalizeScope(value: string): AgentTokenScope {
  const parsed = AgentTokenScopeSchema.safeParse(value);
  if (!parsed.success) invalid(`Unknown agent token scope: ${value}`);
  return parsed.data;
}

function assertExpectedSummaryRevision(summary: Summary, expected: number | undefined): void {
  if (expected !== undefined && summary.revision !== expected) {
    throw new DomainError('CONFLICT', `Summary changed since revision ${expected}`, {
      details: { expectedRevision: expected, actualRevision: summary.revision },
    });
  }
}

function actorStorageIdentity(actor: ActorContext): {
  type: 'device' | 'token' | 'system';
  id: string;
} {
  switch (actor.kind) {
    case 'owner':
      return { type: 'device', id: actor.deviceId };
    case 'agent':
      return { type: 'token', id: actor.tokenId };
    case 'system':
      return { type: 'system', id: actor.label ?? 'journald' };
  }
}

function changeOrigin(actor: ActorContext): ChangeBatch['origin'] {
  switch (actor.kind) {
    case 'owner':
      return { kind: 'app', deviceId: actor.deviceId };
    case 'agent':
      return {
        kind: 'mcp',
        tokenId: actor.tokenId,
        tokenLabel: actor.tokenLabel,
        ...(actor.tool === undefined ? {} : { tool: actor.tool }),
      };
    case 'system':
      return { kind: 'system' };
  }
}

function settingsChange(settings: Settings): EntityChange {
  return { kind: 'settings.changed', payload: settings };
}

function tokenChange(token: AgentTokenRecord): EntityChange {
  return { kind: 'token.changed', payload: token };
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function assertImportMatch(entity: string, id: string, existing: unknown, incoming: unknown): void {
  if (stableJson(existing) !== stableJson(incoming)) {
    throw new DomainError('CONFLICT', `${entity} ${id} already exists with different content`);
  }
}

function portableActivity(
  activityInput: ActivityItem,
  liveEntryIds: ReadonlySet<string>,
): ActivityItem {
  const activity = ActivityItemSchema.parse(activityInput);
  const referenced = new Set([
    ...activity.refs.entryIds,
    ...[...activity.preImages, ...activity.postImages]
      .filter((snapshot) => snapshot.entity === 'entry')
      .map((snapshot) => snapshot.id),
  ]);
  const unavailable = new Set([...referenced].filter((id) => !liveEntryIds.has(id)));
  if (unavailable.size === 0) return activity;
  const redact = (snapshot: Snapshot): Snapshot =>
    snapshot.entity === 'entry' && unavailable.has(snapshot.id)
      ? { ...snapshot, row: null }
      : snapshot;
  return ActivityItemSchema.parse({
    ...activity,
    text: expiredActivityLabel(activity.kind),
    preImages: activity.preImages.map(redact),
    postImages: activity.postImages.map(redact),
  });
}

interface AgentTokenRow {
  readonly id: string;
  readonly label: string;
  readonly token_hash: string;
  readonly scopes: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
  readonly rate_window_start: string | null;
  readonly rate_write_count: number;
}

interface DeviceRow {
  readonly id: string;
  readonly label: string;
  readonly token_hash: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly expires_at: string;
  readonly revoked_at: string | null;
}

interface MutationRow {
  readonly request_hash: string;
  readonly status_code: number;
  readonly result: string;
}

interface SummaryReflectionRevertRow {
  readonly activity_id: string;
  readonly reflection_id: string;
  readonly legacy_summary_id: string | null;
  readonly pre_state: string;
  readonly post_state: string;
  readonly created_at: string;
}

interface MutationOutcome<T> {
  readonly result: T;
  readonly replayed: boolean;
  readonly batch?: ChangeBatch;
}

export type ChangeListener = (batch: ChangeBatch) => void;

export interface ActivityPageBoundary {
  readonly at: string;
  readonly id?: string;
}

export interface EntryPageBoundary {
  readonly date: string;
  readonly createdAt: string;
  readonly id: string;
}

export interface EntryPage {
  readonly items: readonly Entry[];
  readonly hasMore: boolean;
}

export interface JournalIndexAggregates {
  readonly collections: ReadonlyArray<Collection & { readonly count: number }>;
  readonly months: ReadonlyArray<{ readonly month: string; readonly count: number }>;
  readonly types: ReadonlyArray<{ readonly type: EntryType; readonly count: number }>;
}

export interface ActivityPage {
  readonly items: readonly ActivityView[];
  readonly hasMore: boolean;
}

export interface JournalDomainOptions {
  readonly database: JournalDatabase;
  readonly config: Pick<
    JournalConfig,
    'timezone' | 'dayBoundaryOffsetMin' | 'deviceCredentialTtlDays'
  >;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly recoveryRetentionDays?: number;
}

export class JournalDomain {
  private readonly database: JournalDatabase;
  private readonly db: Database.Database;
  private readonly config: JournalDomainOptions['config'];
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly listeners = new Set<ChangeListener>();
  private readonly timelineQueries: TimelineQueries;
  private readonly collectionRecovery: CollectionRecovery;
  private readonly activityReflection: ActivityReflection;
  private readonly entryCommands: EntryCommands;

  public constructor(options: JournalDomainOptions) {
    this.database = options.database;
    this.db = options.database.raw;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => ulid());
    const write: JournalWritePort = {
      execute: <T>(
        operation: string,
        input: unknown,
        actor: ActorContext,
        mutation: MutationContext | undefined,
        command: (context: WriteContext) => T,
      ): T => this.write(operation, input, actor, mutation, command),
    };
    this.timelineQueries = new TimelineQueries({ db: this.db, today: () => this.today() });
    this.collectionRecovery = new CollectionRecovery({
      db: this.db,
      now: this.now,
      write,
      ...(options.recoveryRetentionDays === undefined
        ? {}
        : { retentionDays: options.recoveryRetentionDays }),
    });
    this.activityReflection = new ActivityReflection({
      db: this.db,
      today: () => this.today(),
      now: this.now,
      idFactory: this.idFactory,
      write,
    });
    if (!options.database.readonlyMode && this.hasSummaryReflectionRevertStorage()) {
      this.reconcileRevertedSummaryReflections();
    }
    const entries: EntryPersistencePort = {
      select: (id, includeDeleted) => this.selectEntry(id, includeDeleted),
      requireLive: (id) => this.requireLiveEntry(id),
      listLiveByTag: (tag) =>
        (
          this.db
            .prepare(
              `SELECT e.* FROM entries e WHERE e.deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value = ?)
               ORDER BY e.date DESC, e.created_at DESC, e.id DESC`,
            )
            .all(tag) as EntryRow[]
        ).map(mapEntry),
      insert: (input, now) => this.insertEntry(input, now),
      replace: (input, now) => this.replaceEntry(input, now),
    };
    const collections: CollectionDestinationPort = {
      get: (id) => this.collectionRecovery.getCollection(id),
      ensure: (id, now, context) => this.collectionRecovery.ensure(id, now, context),
    };
    const audit: ActivityAuditPort = {
      append: (input, actor, context) => this.activityReflection.append(input, actor, context),
      appendEntryChange: (actor, kind, text, before, after, context, reason) =>
        this.activityReflection.appendEntryChange(
          actor,
          kind,
          text,
          before,
          after,
          context,
          reason,
        ),
      appendVisibleChange: (actor, kind, text, refs, preImages, postImages, context) =>
        this.activityReflection.appendVisibleChange(
          actor,
          kind,
          text,
          refs,
          preImages,
          postImages,
          context,
        ),
    };
    this.entryCommands = new EntryCommands({
      today: () => this.today(),
      idFactory: this.idFactory,
      write,
      entries,
      collections,
      recovery: this.collectionRecovery,
      audit,
    });
  }

  public today(at = this.now()): string {
    return journalDate(this.config, at);
  }

  public subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getEntry(id: string, options: { includeDeleted?: boolean } = {}): Entry | null {
    return this.timelineQueries.getEntry(id, options);
  }

  public requireEntry(id: string, options: { includeDeleted?: boolean } = {}): Entry {
    return this.timelineQueries.requireEntry(id, options);
  }

  public searchEntries(input: SearchEntriesInput = {}): SearchEntriesResult {
    return this.timelineQueries.searchEntries(input);
  }

  public listRecentlyDeleted(retentionDays?: number): readonly RecentlyDeletedEntry[] {
    return this.collectionRecovery.listRecentlyDeleted(retentionDays);
  }

  public countEntries(input: SearchEntriesInput = {}): number {
    return this.timelineQueries.countEntries(input);
  }

  public pageEntries(
    input: Omit<SearchEntriesInput, 'limit' | 'offset'> & { readonly limit: number },
    before?: EntryPageBoundary,
  ): EntryPage {
    return this.timelineQueries.pageEntries(input, before);
  }

  public listDay(date = this.today()): DayResult {
    return this.timelineQueries.listDay(date);
  }

  public listCollections(
    options: { includeArchived?: boolean; includeMonths?: boolean } = {},
  ): readonly Collection[] {
    return this.collectionRecovery.listCollections(options);
  }

  /**
   * One bounded read model for Index. Collection and type counts are dimensions;
   * month ownership is exclusive: a month-log destination wins, otherwise the
   * entry's calendar date owns it.
   */
  public getIndexAggregates(): JournalIndexAggregates {
    return this.collectionRecovery.getIndexAggregates();
  }

  /** Tag vocabulary ranked by use, so capture can suggest what the owner already writes. */
  public listTags(limit = 300): readonly TagUsage[] {
    return this.collectionRecovery.listTags(limit);
  }

  public getCollection(id: string): Collection | null {
    return this.collectionRecovery.getCollection(id);
  }

  /** Resolve only the destination labels needed by one bounded Timeline page. */
  public listCollectionsByIds(ids: readonly string[]): readonly Collection[] {
    return this.collectionRecovery.listCollectionsByIds(ids);
  }

  public listActivity(limit = 100, offset = 0): readonly ActivityItem[] {
    return this.activityReflection.listActivity(limit, offset);
  }

  public getActivity(id: string): ActivityItem | null {
    return this.activityReflection.getActivity(id);
  }

  public activityView(activityOrId: ActivityItem | string): ActivityView {
    return this.activityReflection.activityView(activityOrId);
  }

  public listActivityViews(limit = 100, offset = 0): readonly ActivityView[] {
    return this.activityReflection.listActivityViews(limit, offset);
  }

  public listActivityPage(limit = 50, before?: ActivityPageBoundary): ActivityPage {
    return this.activityReflection.listActivityPage(limit, before);
  }

  public listSummaries(limit = 20): readonly Summary[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      invalid('limit must be between 1 and 100');
    return (
      this.db
        .prepare('SELECT * FROM summaries ORDER BY week_start DESC LIMIT ?')
        .all(limit) as SummaryRow[]
    ).map(mapSummary);
  }

  public getLatestSummary(month?: string): Summary | null {
    if (month !== undefined && !CalendarMonthSchema.safeParse(month).success) {
      invalid('month must use YYYY-MM');
    }
    const row = (
      month === undefined
        ? this.db.prepare('SELECT * FROM summaries ORDER BY week_start DESC LIMIT 1').get()
        : this.db
            .prepare(
              'SELECT * FROM summaries WHERE substr(week_start, 1, 7) = ? ORDER BY week_start DESC LIMIT 1',
            )
            .get(month)
    ) as SummaryRow | undefined;
    return row === undefined ? null : mapSummary(row);
  }

  public getSummaryForMonth(month: string): Summary | null {
    return this.getLatestSummary(month);
  }

  public getSummary(id: string): Summary | null {
    validateId(id);
    const row = this.db.prepare('SELECT * FROM summaries WHERE id = ?').get(id) as
      | SummaryRow
      | undefined;
    return row === undefined ? null : mapSummary(row);
  }

  public listReflections(from: string, to: string): readonly Reflection[] {
    return this.activityReflection.listReflections(from, to);
  }

  public getReflection(id: string): Reflection | null {
    return this.activityReflection.getReflection(id);
  }

  public listPendingReflections(): readonly Reflection[] {
    return this.activityReflection.listPendingReflections();
  }

  public requestReflection(
    id: string,
    actor: ActorContext,
    options: { readonly expectedRevision: number },
  ): { readonly reflection: Reflection; readonly activityId: string } {
    return this.activityReflection.requestReflection(id, actor, options);
  }

  public retryReflection(
    id: string,
    actor: ActorContext,
    options: { readonly expectedRevision: number },
  ): { readonly reflection: Reflection; readonly activityId: string } {
    return this.activityReflection.retryReflection(id, actor, options);
  }

  public claimReflection(
    weekStart: string,
    requestId: string,
    actor: ActorContext,
    mutation?: MutationContext,
  ): { readonly kind: 'reflection'; readonly reflection: Reflection; readonly activityId: string } {
    return this.activityReflection.claimReflection(weekStart, requestId, actor, mutation);
  }

  public completeReflection(
    input: {
      readonly weekStart: string;
      readonly requestId: string;
      readonly text: string;
      readonly source: string;
    },
    actor: ActorContext,
    mutation?: MutationContext,
  ): { readonly kind: 'reflection'; readonly reflection: Reflection; readonly activityId: string } {
    return this.activityReflection.completeReflection(input, actor, mutation);
  }

  public failReflection(
    input: { readonly weekStart: string; readonly requestId: string; readonly reason: string },
    actor: ActorContext,
    mutation?: MutationContext,
  ): { readonly kind: 'reflection'; readonly reflection: Reflection; readonly activityId: string } {
    return this.activityReflection.failReflection(input, actor, mutation);
  }

  public restoreReflectionVersion(
    id: string,
    versionId: string,
    actor: ActorContext,
    options: { readonly expectedRevision: number },
  ): { readonly reflection: Reflection; readonly activityId: string } {
    return this.activityReflection.restoreReflectionVersion(id, versionId, actor, options);
  }

  public createEntry(
    input: CreateEntryInput,
    actor: ActorContext,
    mutation?: MutationContext,
  ): EntryWriteResult {
    const normalized = this.entryCommands.normalizeCreate(input, actor);
    if (
      actor.kind === 'agent' &&
      input.reflectionAction !== undefined &&
      input.reflectionRequestId !== undefined &&
      input.summaryWeekStart !== undefined
    ) {
      switch (input.reflectionAction) {
        case 'claim':
          return this.activityReflection.claimReflection(
            input.summaryWeekStart,
            input.reflectionRequestId,
            actor,
            mutation,
          );
        case 'complete':
          return this.activityReflection.completeReflection(
            {
              weekStart: input.summaryWeekStart,
              requestId: input.reflectionRequestId,
              text: normalized.text,
              source: normalized.source ?? '',
            },
            actor,
            mutation,
          );
        case 'fail':
          return this.activityReflection.failReflection(
            {
              weekStart: input.summaryWeekStart,
              requestId: input.reflectionRequestId,
              reason: normalized.text,
            },
            actor,
            mutation,
          );
      }
    }
    if (
      actor.kind === 'agent' &&
      normalized.type === 'note' &&
      normalized.tags.includes('summary') &&
      (input.summaryWeekStart !== undefined || input.weekStart !== undefined)
    ) {
      return this.fileSummary(
        {
          ...(input.id === undefined ? {} : { id: input.id }),
          weekStart: input.summaryWeekStart ?? input.weekStart ?? mondayOf(normalized.date),
          text: normalized.text,
          source: normalized.source ?? '',
        },
        actor,
        mutation,
      );
    }
    return this.entryCommands.createNormalized(input, normalized, actor, mutation);
  }

  public updateEntry(
    id: string,
    patch: EntryPatch,
    actor: ActorContext,
    mutation?: MutationContext,
    options: { expectedRevision?: number; reason?: string } = {},
  ): { readonly entry: Entry; readonly activityId?: string } {
    return this.entryCommands.updateEntry(id, patch, actor, mutation, options);
  }

  public toggleEntry(
    id: string,
    actor: ActorContext,
    mutation?: MutationContext,
  ): { readonly entry: Entry; readonly activityId?: string } {
    return this.entryCommands.toggleEntry(id, actor, mutation);
  }

  public migrateEntry(
    id: string,
    input: {
      readonly newEntryId: string;
      readonly targetDate?: string;
      readonly expectedRevision?: number;
    },
    actor: ActorContext,
    mutation?: MutationContext,
  ): { readonly original: Entry; readonly copy: Entry; readonly activityId?: string } {
    return this.entryCommands.migrateEntry(id, input, actor, mutation);
  }

  public scheduleMonthly(
    id: string,
    input: { readonly copyId: string; readonly month?: string; readonly expectedRevision?: number },
    actor: ActorContext,
    mutation?: MutationContext,
  ): {
    readonly original: Entry;
    readonly copy: Entry;
    readonly collection: Collection;
    readonly activityId?: string;
  } {
    return this.entryCommands.scheduleMonthly(id, input, actor, mutation);
  }

  public fileEntry(
    id: string,
    collectionId: string | null,
    actor: ActorContext,
    mutation?: MutationContext,
    options: {
      readonly expectedRevision?: number;
      readonly filingDate?: string;
      readonly reason?: string;
    } = {},
  ): { readonly entry: Entry; readonly collection?: Collection; readonly activityId?: string } {
    return this.entryCommands.fileEntry(id, collectionId, actor, mutation, options);
  }

  public deleteEntry(
    id: string,
    actor: ActorContext,
    mutation?: MutationContext,
    options: { readonly expectedRevision?: number; readonly reason?: string } = {},
  ): { readonly entry: Entry; readonly activityId?: string } {
    return this.entryCommands.deleteEntry(id, actor, mutation, options);
  }

  public restoreEntry(
    id: string,
    actor: ActorContext,
    mutation?: MutationContext,
    options: { readonly expectedRevision?: number; readonly retentionDays?: number } = {},
  ): {
    readonly entry: Entry;
    readonly activityId?: string;
    readonly fallbackFromCollection?: string;
  } {
    return this.entryCommands.restoreEntry(id, actor, mutation, options);
  }

  public createCollection(
    input: { readonly id: string; readonly name: string; readonly note?: string | null },
    actor: ActorContext,
    mutation?: MutationContext,
  ): Collection {
    return this.collectionRecovery.createCollection(input, actor, mutation);
  }

  public updateCollection(
    id: string,
    patch: { readonly name?: string; readonly note?: string | null; readonly archived?: boolean },
    actor: ActorContext,
    mutation?: MutationContext,
  ): Collection {
    return this.collectionRecovery.updateCollection(id, patch, actor, mutation);
  }

  public archiveCollection(
    id: string,
    archived: boolean,
    actor: ActorContext,
    mutation?: MutationContext,
  ): Collection {
    return this.collectionRecovery.archiveCollection(id, archived, actor, mutation);
  }

  public fileSummary(
    input: {
      readonly id?: string;
      readonly weekStart: string;
      readonly text: string;
      readonly source: string;
    },
    actor: ActorContext,
    mutation?: MutationContext,
  ): { readonly kind: 'summary'; readonly summary: Summary; readonly activityId: string } {
    if (actor.kind !== 'agent')
      invalid('Only an authenticated agent can file an automatic summary');
    validateDate(input.weekStart);
    if (!isMonday(input.weekStart)) invalid('weekStart must be a Monday');
    const text = normalizeText(input.text, 500, 'summary text');
    const source = normalizeSource(input.source);
    if (input.id !== undefined) validateId(input.id);
    return this.write(
      'file-summary',
      { id: input.id ?? null, weekStart: input.weekStart, text, source },
      actor,
      mutation,
      (context) => {
        const id = input.id ?? this.idFactory();
        const row = this.db
          .prepare('SELECT * FROM summaries WHERE week_start = ?')
          .get(input.weekStart) as SummaryRow | undefined;
        const before = row === undefined ? null : mapSummary(row);
        const reflectionBeforeRow = this.db
          .prepare('SELECT id,legacy_summary_id FROM reflection_slots WHERE week_start = ?')
          .get(input.weekStart) as { id: string; legacy_summary_id: string | null } | undefined;
        const reflectionBefore =
          reflectionBeforeRow === undefined ? null : this.requireReflection(reflectionBeforeRow.id);
        const summary: Summary =
          before === null
            ? {
                id,
                weekStart: input.weekStart,
                text,
                status: 'current',
                source,
                tokenId: actor.tokenId,
                createdAt: context.now,
                updatedAt: context.now,
                savedEntryId: null,
                revision: 1,
              }
            : {
                ...before,
                text,
                status: 'current',
                source,
                tokenId: actor.tokenId,
                updatedAt: context.now,
                savedEntryId: null,
                revision: before.revision + 1,
              };
        if (before === null) this.insertSummary(summary);
        else this.updateSummaryRow(summary);
        const reflection = this.upsertLegacyReflection(summary, actor, context);
        context.changes.push(upsertChange('summary', summary), reflectionChange(reflection));
        const activity = this.insertActivity(
          {
            kind: 'summary-filed',
            text: `Filed weekly summary for ${input.weekStart}`,
            refs: { ...actorRefs(actor, []), summaryId: summary.id },
            preImages: [{ entity: 'summary', id: summary.id, row: before }],
            postImages: [snapshotSummary(summary)],
          },
          actor,
          context,
        );
        this.insertSummaryReflectionRevert(
          {
            activityId: activity.id,
            reflectionId: reflection.id,
            legacySummaryId: reflectionBeforeRow?.legacy_summary_id ?? null,
            before: reflectionBefore,
            after: reflection,
          },
          context.now,
        );
        return { kind: 'summary', summary, activityId: activity.id };
      },
    );
  }

  public saveSummaryToToday(
    id: string,
    actor: ActorContext,
    mutation?: MutationContext,
    options: { readonly entryId?: string; readonly expectedRevision?: number } = {},
  ): { readonly summary: Summary; readonly entry: Entry; readonly activityId: string } {
    validateId(id);
    if (options.entryId !== undefined) validateId(options.entryId);
    return this.write(
      'save-summary',
      { id, ...options, entryId: options.entryId ?? null },
      actor,
      mutation,
      (context) => {
        const entryId = options.entryId ?? this.idFactory();
        const before = this.requireSummary(id);
        assertExpectedSummaryRevision(before, options.expectedRevision);
        if (before.status === 'saved' && before.savedEntryId !== null) {
          const existingEntry = this.selectEntry(before.savedEntryId, true);
          if (existingEntry !== null && existingEntry.deletedAt === null) {
            const previousActivity = this.findActivityForSummary('summary-saved', before.id);
            return {
              summary: before,
              entry: existingEntry,
              activityId: previousActivity?.id ?? '',
            };
          }
        }
        if (this.selectEntry(entryId, true) !== null) {
          throw new DomainError('CONFLICT', `Entry id ${entryId} already exists`);
        }
        const entry = this.insertEntry(
          {
            id: entryId,
            date: this.today(),
            type: 'note',
            text: normalizeText(before.text, 500, 'summary entry text'),
            state: 'logged',
            time: null,
            tags: ['summary'],
            author: 'ai',
            source: `Weekly summary, saved by you on ${this.today()}.`,
            migrations: 0,
            collection: null,
          },
          context.now,
        );
        const summary: Summary = {
          ...before,
          status: 'saved',
          savedEntryId: entry.id,
          updatedAt: context.now,
          revision: before.revision + 1,
        };
        this.updateSummaryRow(summary);
        context.changes.push(entryCreatedChange(entry), upsertChange('summary', summary));
        const activity = this.insertActivity(
          {
            kind: 'summary-saved',
            text: `Saved weekly summary to ${entry.date}`,
            refs: { ...actorRefs(actor, [entry.id]), summaryId: summary.id },
            preImages: [snapshotSummary(before), { entity: 'entry', id: entry.id, row: null }],
            postImages: [snapshotSummary(summary), snapshotEntry(entry)],
          },
          actor,
          context,
        );
        return { summary, entry, activityId: activity.id };
      },
    );
  }

  public rewriteSummary(
    id: string,
    actor: ActorContext,
    mutation?: MutationContext,
    options: { readonly expectedRevision?: number } = {},
  ): { readonly summary: Summary; readonly activityId: string } {
    validateId(id);
    return this.write('rewrite-summary', { id, ...options }, actor, mutation, (context) => {
      const before = this.requireSummary(id);
      assertExpectedSummaryRevision(before, options.expectedRevision);
      const reflectionBeforeRow = this.db
        .prepare('SELECT id,legacy_summary_id FROM reflection_slots WHERE week_start = ?')
        .get(before.weekStart) as { id: string; legacy_summary_id: string | null } | undefined;
      const reflectionBefore =
        reflectionBeforeRow === undefined ? null : this.requireReflection(reflectionBeforeRow.id);
      const summary: Summary = {
        ...before,
        status: 'stale',
        savedEntryId: null,
        updatedAt: context.now,
        revision: before.revision + 1,
      };
      this.updateSummaryRow(summary);
      context.changes.push(upsertChange('summary', summary));
      const reflectionRow = this.db
        .prepare('SELECT * FROM reflection_slots WHERE week_start = ?')
        .get(summary.weekStart) as ReflectionSlotRow | undefined;
      if (reflectionRow !== undefined) {
        this.db
          .prepare(
            `UPDATE reflection_slots SET
              status='queued', request_id=?, requested_at=?, claimed_at=NULL,
              claimed_token_id=NULL, claimed_label=NULL, claimed_tool=NULL, failure=NULL,
              claimed_source_entries=NULL, updated_at=?, revision=revision+1
             WHERE id=?`,
          )
          .run(this.idFactory(), context.now, context.now, reflectionRow.id);
        context.changes.push(reflectionChange(this.requireReflection(reflectionRow.id)));
      }
      const activity = this.insertActivity(
        {
          kind: 'summary-filed',
          text: `Requested a rewrite for the week of ${summary.weekStart}`,
          refs: { ...actorRefs(actor, []), summaryId: summary.id },
          preImages: [snapshotSummary(before)],
          postImages: [snapshotSummary(summary)],
        },
        actor,
        context,
      );
      if (reflectionBefore !== null) {
        this.insertSummaryReflectionRevert(
          {
            activityId: activity.id,
            reflectionId: reflectionBefore.id,
            legacySummaryId: reflectionBeforeRow?.legacy_summary_id ?? null,
            before: reflectionBefore,
            after: this.requireReflection(reflectionBefore.id),
          },
          context.now,
        );
      }
      return { summary, activityId: activity.id };
    });
  }

  public applyAgentMigration(
    input: ApplyAgentMigrationInput,
    actor: ActorContext,
    mutation?: MutationContext,
  ): AgentMigrationResult {
    return this.entryCommands.applyAgentMigration(input, actor, mutation);
  }

  public revertActivity(
    id: string,
    actor: ActorContext,
    mutation?: MutationContext,
  ): { readonly activity: ActivityItem; readonly reverted: readonly Snapshot[] } {
    validateId(id);
    return this.write('revert-activity', { id }, actor, mutation, (context) => {
      const original = this.getActivity(id);
      if (original === null) throw new DomainError('NOT_FOUND', `Activity ${id} was not found`);
      if (original.kind === 'revert') invalid('A revert activity cannot itself be reverted');
      if (activityContentExpired(original.text))
        invalid('Expired entry content cannot be restored from activity history');
      if (original.revertedAt !== null) {
        throw new DomainError('CONFLICT', 'This activity has already been reverted');
      }
      if (original.postImages.length === 0) invalid('This activity has no reversible snapshots');
      const summaryReflectionRevert =
        original.kind === 'summary-filed' &&
        original.postImages.some((snapshot) => snapshot.entity === 'summary')
          ? this.getSummaryReflectionRevert(original.id)
          : null;
      if (
        original.kind === 'summary-filed' &&
        original.postImages.some((snapshot) => snapshot.entity === 'summary') &&
        summaryReflectionRevert === null
      ) {
        invalid('This summary Activity has no Reflection revert provenance');
      }

      for (const expected of original.postImages) {
        const current = this.selectSnapshot(expected.entity, expected.id);
        if (!snapshotEqual(current, expected.row)) {
          throw new DomainError(
            'CONFLICT',
            'The journal changed after this activity; reverting would overwrite newer work',
            {
              details: { entity: expected.entity, id: expected.id },
            },
          );
        }
      }
      if (summaryReflectionRevert !== null) {
        const current = this.getReflection(summaryReflectionRevert.reflectionId);
        if (stableJson(current) !== stableJson(summaryReflectionRevert.after)) {
          throw new DomainError(
            'CONFLICT',
            'The Reflection changed after this activity; reverting would overwrite newer work',
            { details: { reflectionId: summaryReflectionRevert.reflectionId } },
          );
        }
      }

      const beforeRevert = original.postImages.map((snapshot) => ({
        ...snapshot,
        row: this.selectSnapshot(snapshot.entity, snapshot.id),
      })) as Snapshot[];
      const restored: Snapshot[] = [];
      for (const preImage of original.preImages) {
        restored.push(this.restoreSnapshot(preImage, context));
      }
      if (summaryReflectionRevert !== null) {
        this.restoreSummaryReflection(summaryReflectionRevert, context);
      }
      const revertId = this.idFactory();
      this.db
        .prepare('UPDATE activity SET reverted_at = ?, reverted_by_activity_id = ? WHERE id = ?')
        .run(context.now, revertId, original.id);
      const markedOriginal: ActivityItem = {
        ...original,
        revertedAt: context.now,
        revertedByActivityId: revertId,
      };
      context.changes.push(activityChange(markedOriginal));
      const revertActivity = this.insertActivity(
        {
          id: revertId,
          kind: 'revert',
          text: `Reverted: ${original.text}`,
          refs: { ...actorRefs(actor, original.refs.entryIds), activityId: original.id },
          preImages: beforeRevert,
          postImages: restored,
        },
        actor,
        context,
      );
      return { activity: revertActivity, reverted: restored };
    });
  }

  public createAgentToken(
    labelInput: string,
    scopesInput: readonly string[] = ['journal:full'],
    actor: ActorContext,
    mutation?: MutationContext,
  ): IssuedAgentToken {
    if (mutation !== undefined)
      invalid('Token creation is online-only and cannot use mutation replay');
    const label = normalizeText(labelInput, 80, 'token label');
    const scopes = [...new Set(scopesInput.map((scope) => normalizeScope(scope)))];
    if (scopes.length === 0) invalid('At least one token scope is required');
    return this.write('create-agent-token', { label, scopes }, actor, mutation, (context) => {
      const secret = `jrn_${randomBytes(32).toString('base64url')}`;
      const token = AgentTokenSchema.parse({
        id: this.idFactory(),
        label,
        scopes,
        createdAt: context.now,
        lastUsedAt: null,
        revokedAt: null,
      });
      this.db
        .prepare(
          `INSERT INTO agent_tokens(id, label, token_hash, scopes, created_at, last_used_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(token.id, token.label, hashSecret(secret), JSON.stringify(scopes), token.createdAt);
      context.changes.push(tokenChange(token));
      return { token, secret };
    });
  }

  public listAgentTokens(): readonly AgentTokenRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM agent_tokens ORDER BY created_at DESC')
        .all() as AgentTokenRow[]
    ).map(mapAgentToken);
  }

  public authenticateAgent(
    secret: string,
    options: { touch?: boolean } = {},
  ): AuthenticatedAgent | null {
    if (!secret.startsWith('jrn_') || secret.length < 20) return null;
    const candidateHash = hashSecret(secret);
    const row = this.db
      .prepare('SELECT * FROM agent_tokens WHERE token_hash = ?')
      .get(candidateHash) as AgentTokenRow | undefined;
    if (
      row === undefined ||
      row.revoked_at !== null ||
      !safeHashEqual(candidateHash, row.token_hash)
    )
      return null;
    if (options.touch !== false) {
      this.db
        .prepare('UPDATE agent_tokens SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(this.now().toISOString(), row.id);
    }
    return { tokenId: row.id, tokenLabel: row.label, scopes: mapAgentToken(row).scopes };
  }

  public revokeAgentToken(
    id: string,
    actor: ActorContext,
    mutation?: MutationContext,
  ): AgentTokenRecord {
    validateId(id);
    return this.write('revoke-agent-token', { id }, actor, mutation, (context) => {
      const row = this.db.prepare('SELECT * FROM agent_tokens WHERE id = ?').get(id) as
        | AgentTokenRow
        | undefined;
      if (row === undefined) throw new DomainError('NOT_FOUND', `Agent token ${id} was not found`);
      this.db.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE id = ?').run(context.now, id);
      const token: AgentTokenRecord = { ...mapAgentToken(row), revokedAt: context.now };
      context.changes.push(tokenChange(token));
      return token;
    });
  }

  public consumeAgentWriteQuota(
    tokenId: string,
    limit = 60,
  ): { readonly remaining: number; readonly resetAt: string } {
    const result = this.consumeWriteRateLimit(tokenId, limit);
    const resetAt = new Date(this.now().getTime() + result.retryAfterSeconds * 1_000).toISOString();
    if (!result.allowed) {
      throw new DomainError('RATE_LIMITED', `Write limit reached; retry after ${resetAt}`, {
        details: { limit, resetAt },
      });
    }
    return { remaining: result.remaining, resetAt };
  }

  public consumeWriteRateLimit(tokenId: string, limit = 60): RateLimitResult {
    validateId(tokenId);
    if (!Number.isInteger(limit) || limit < 1) invalid('Rate limit must be a positive integer');
    const transact = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM agent_tokens WHERE id = ?').get(tokenId) as
        | AgentTokenRow
        | undefined;
      if (row === undefined || row.revoked_at !== null)
        throw new DomainError('UNAUTHORIZED', 'Agent token is invalid or revoked');
      const now = this.now();
      const previousStart = row.rate_window_start === null ? null : new Date(row.rate_window_start);
      const expired =
        previousStart === null || now.getTime() - previousStart.getTime() >= 3_600_000;
      const windowStart = expired ? now : previousStart;
      const count = expired ? 0 : row.rate_write_count;
      if (count >= limit) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((windowStart.getTime() + 3_600_000 - now.getTime()) / 1_000),
        );
        return { allowed: false, remaining: 0, retryAfterSeconds };
      }
      this.db
        .prepare('UPDATE agent_tokens SET rate_window_start = ?, rate_write_count = ? WHERE id = ?')
        .run(windowStart.toISOString(), count + 1, tokenId);
      return {
        allowed: true,
        remaining: limit - count - 1,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((windowStart.getTime() + 3_600_000 - now.getTime()) / 1_000),
        ),
      };
    });
    return transact();
  }

  public pairDevice(labelInput = 'Journal device'): PairedDevice {
    const label = normalizeText(labelInput, 100, 'device label');
    const secret = `jdev_${randomBytes(32).toString('base64url')}`;
    const now = this.now();
    const expiresAt = new Date(
      now.getTime() + this.config.deviceCredentialTtlDays * 86_400_000,
    ).toISOString();
    const deviceId = this.idFactory();
    this.db
      .prepare(
        `INSERT INTO device_tokens(id, label, token_hash, created_at, last_used_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(deviceId, label, hashSecret(secret), now.toISOString(), now.toISOString(), expiresAt);
    return { deviceId, secret, expiresAt };
  }

  public authenticateDevice(
    secret: string,
    options: { touch?: boolean } = {},
  ): AuthenticatedDevice | null {
    if (!secret.startsWith('jdev_') || secret.length < 20) return null;
    const candidateHash = hashSecret(secret);
    const row = this.db
      .prepare('SELECT * FROM device_tokens WHERE token_hash = ?')
      .get(candidateHash) as DeviceRow | undefined;
    const now = this.now();
    if (
      row === undefined ||
      row.revoked_at !== null ||
      new Date(row.expires_at).getTime() <= now.getTime() ||
      !safeHashEqual(candidateHash, row.token_hash)
    ) {
      return null;
    }
    if (options.touch !== false) {
      this.db
        .prepare('UPDATE device_tokens SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(now.toISOString(), row.id);
    }
    return { deviceId: row.id, label: row.label, expiresAt: row.expires_at };
  }

  public renewDevice(secret: string): PairedDevice | null {
    const authenticated = this.authenticateDevice(secret, { touch: false });
    if (authenticated === null) return null;
    const replacement = `jdev_${randomBytes(32).toString('base64url')}`;
    const now = this.now();
    const expiresAt = new Date(
      now.getTime() + this.config.deviceCredentialTtlDays * 86_400_000,
    ).toISOString();
    this.db
      .prepare(
        'UPDATE device_tokens SET token_hash = ?, last_used_at = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL',
      )
      .run(hashSecret(replacement), now.toISOString(), expiresAt, authenticated.deviceId);
    return { deviceId: authenticated.deviceId, secret: replacement, expiresAt };
  }

  public revokeDevice(id: string): void {
    validateId(id);
    const result = this.db
      .prepare('UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(this.now().toISOString(), id);
    if (result.changes === 0) throw new DomainError('NOT_FOUND', `Device ${id} was not found`);
  }

  public getSettings(): Settings {
    const row = this.db.prepare('SELECT * FROM settings WHERE id = 1').get() as
      | {
          density: Settings['density'];
          show_type_badges: number;
          highlight_ai_entries: number;
          saved_views: string;
          updated_at: string;
        }
      | undefined;
    return SettingsSchema.parse(
      row === undefined
        ? {
            density: 'comfortable',
            showTypeBadges: true,
            highlightAiEntries: true,
            savedViews: [],
            updatedAt: '1970-01-01T00:00:00.000Z',
          }
        : {
            density: row.density,
            showTypeBadges: row.show_type_badges === 1,
            highlightAiEntries: row.highlight_ai_entries === 1,
            savedViews: JSON.parse(row.saved_views) as unknown,
            updatedAt: row.updated_at,
          },
    );
  }

  public setSettings(
    patch: Partial<
      Pick<Settings, 'density' | 'showTypeBadges' | 'highlightAiEntries' | 'savedViews'>
    >,
    actor: ActorContext,
    mutation?: MutationContext,
  ): Settings {
    if (Object.keys(patch).length === 0) invalid('Settings patch must not be empty');
    const allowed = new Set(['density', 'showTypeBadges', 'highlightAiEntries', 'savedViews']);
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) invalid(`Unknown setting: ${key}`);
    }
    if (
      patch.density !== undefined &&
      patch.density !== 'comfortable' &&
      patch.density !== 'compact'
    ) {
      invalid('density must be comfortable or compact');
    }
    if (patch.showTypeBadges !== undefined && typeof patch.showTypeBadges !== 'boolean') {
      invalid('showTypeBadges must be boolean');
    }
    if (patch.highlightAiEntries !== undefined && typeof patch.highlightAiEntries !== 'boolean') {
      invalid('highlightAiEntries must be boolean');
    }
    validateSavedViewQueries(patch.savedViews);
    return this.write('set-settings', patch, actor, mutation, (context) => {
      const settings = SettingsSchema.parse({
        ...this.getSettings(),
        ...patch,
        updatedAt: context.now,
      });
      this.db
        .prepare(
          `INSERT INTO settings(id,density,show_type_badges,highlight_ai_entries,saved_views,updated_at)
           VALUES (1,@density,@showTypeBadges,@highlightAiEntries,@savedViews,@updatedAt)
           ON CONFLICT(id) DO UPDATE SET density=excluded.density,
             show_type_badges=excluded.show_type_badges,
             highlight_ai_entries=excluded.highlight_ai_entries,
             saved_views=excluded.saved_views,
             updated_at=excluded.updated_at`,
        )
        .run({
          ...settings,
          showTypeBadges: Number(settings.showTypeBadges),
          highlightAiEntries: Number(settings.highlightAiEntries),
          savedViews: JSON.stringify(settings.savedViews ?? []),
        });
      context.changes.push(settingsChange(settings));
      return settings;
    });
  }

  public exportJournal(): JournalExportV2 {
    const snapshot = this.db.transaction((): JournalExportV2 => {
      const settings = this.getSettings();
      const entries = (
        this.db
          .prepare('SELECT * FROM entries WHERE deleted_at IS NULL ORDER BY created_at')
          .all() as EntryRow[]
      ).map(mapEntry);
      const liveEntryIds = new Set(entries.map((entry) => entry.id));
      return JournalExportV2Schema.parse({
        version: 2,
        exportedAt: this.now().toISOString(),
        journal: {
          entries,
          collections: (
            this.db
              .prepare('SELECT * FROM collections ORDER BY created_at')
              .all() as CollectionRow[]
          ).map(mapCollection),
          activity: (this.db.prepare('SELECT * FROM activity ORDER BY at').all() as ActivityRow[])
            .map(mapActivity)
            .map((activity) => portableActivity(activity, liveEntryIds)),
          summaries: (
            this.db.prepare('SELECT * FROM summaries ORDER BY week_start').all() as SummaryRow[]
          ).map(mapSummary),
          settings,
        },
        derived: {
          reflections: {
            version: 1,
            items: this.activityReflection.listStoredReflections(),
          },
          summaryReflectionReverts: {
            version: 1,
            items: this.listSummaryReflectionReverts(),
          },
        },
      });
    });
    return snapshot();
  }

  public importJournal(document: JournalExport): ImportReport {
    const { journal, reflections, summaryReflectionReverts } = validateExport(document);
    // Imports are a write boundary too. Parsing before the transaction keeps an
    // invalid saved query from partially importing otherwise valid rows.
    validateSavedViewQueries(journal.settings.savedViews);
    const inserted = {
      entries: 0,
      collections: 0,
      activity: 0,
      summaries: 0,
      reflections: 0,
      summaryReflectionReverts: 0,
      settings: 0,
    };
    const skipped = {
      entries: 0,
      collections: 0,
      activity: 0,
      summaries: 0,
      reflections: 0,
      summaryReflectionReverts: 0,
      settings: 0,
    };
    const importedLiveEntryIds = new Set(
      journal.entries.filter((entry) => entry.deletedAt === null).map((entry) => entry.id),
    );
    const transaction = this.db.transaction(() => {
      const context: WriteContext = {
        now: this.now().toISOString(),
        changes: [],
        implicitSnapshots: [],
      };
      for (const collection of journal.collections) {
        const existingRow = this.db
          .prepare('SELECT * FROM collections WHERE id = ?')
          .get(collection.id) as CollectionRow | undefined;
        if (existingRow !== undefined) {
          assertImportMatch('collection', collection.id, mapCollection(existingRow), collection);
          skipped.collections++;
          continue;
        }
        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO collections(id,name,note,created_at,updated_at,archived_at)
             VALUES (@id,@name,@note,@createdAt,@createdAt,@archivedAt)`,
          )
          .run(collection);
        if (result.changes === 0) skipped.collections++;
        else inserted.collections++;
      }
      for (const entry of journal.entries) {
        validateEntry(entry);
        const existingRow = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(entry.id) as
          | EntryRow
          | undefined;
        if (existingRow !== undefined) {
          assertImportMatch('entry', entry.id, mapEntry(existingRow), entry);
          skipped.entries++;
          continue;
        }
        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO entries(
              id,date,type,text,state,time,tags,author,source,migrations,collection,
              created_at,updated_at,deleted_at,revision
            ) VALUES (
              @id,@date,@type,@text,@state,@time,@tags,@author,@source,@migrations,@collection,
              @createdAt,@updatedAt,@deletedAt,@revision
            )`,
          )
          .run({ ...entry, tags: JSON.stringify(entry.tags) });
        if (result.changes === 0) skipped.entries++;
        else {
          inserted.entries++;
          context.changes.push(entryCreatedChange(entry));
        }
      }
      for (const summary of journal.summaries) {
        validateSummary(summary);
        const existingRow = this.db
          .prepare('SELECT * FROM summaries WHERE id = ?')
          .get(summary.id) as SummaryRow | undefined;
        if (existingRow !== undefined) {
          const existing = mapSummary(existingRow);
          if (!matchesAutomaticStaleDelta(existing, summary)) {
            assertImportMatch('summary', summary.id, existing, summary);
          }
          skipped.summaries++;
          continue;
        }
        const sameWeekRow = this.db
          .prepare('SELECT * FROM summaries WHERE week_start = ?')
          .get(summary.weekStart) as SummaryRow | undefined;
        if (sameWeekRow !== undefined) {
          throw new DomainError(
            'CONFLICT',
            `Summary week ${summary.weekStart} already belongs to a different row`,
          );
        }
        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO summaries(
              id,week_start,text,status,source,token_id,created_at,updated_at,saved_entry_id,revision
            ) VALUES (@id,@weekStart,@text,@status,@source,@tokenId,@createdAt,@updatedAt,@savedEntryId,@revision)`,
          )
          .run(summary);
        if (result.changes === 0) skipped.summaries++;
        else inserted.summaries++;
      }
      for (const reflection of reflections) {
        const outcome = this.activityReflection.importReflection(reflection, context);
        this.markImportedLegacySummaryProjection(reflection, journal.summaries);
        if (outcome === 'inserted') inserted.reflections++;
        else skipped.reflections++;
      }
      for (const activityInput of journal.activity) {
        const activity = portableActivity(activityInput, importedLiveEntryIds);
        validateActivity(activity);
        const existingRow = this.db
          .prepare('SELECT * FROM activity WHERE id = ?')
          .get(activity.id) as ActivityRow | undefined;
        if (existingRow !== undefined) {
          assertImportMatch(
            'activity',
            activity.id,
            portableActivity(mapActivity(existingRow), importedLiveEntryIds),
            activity,
          );
          skipped.activity++;
          continue;
        }
        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO activity(
              id,at,kind,text,origin,refs,pre_images,post_images,reverted_at,reverted_by_activity_id
            ) VALUES (@id,@at,@kind,@text,@origin,@refs,@preImages,@postImages,@revertedAt,@revertedByActivityId)`,
          )
          .run({
            ...activity,
            origin: JSON.stringify(activity.origin),
            refs: JSON.stringify(activity.refs),
            preImages: JSON.stringify(activity.preImages),
            postImages: JSON.stringify(activity.postImages),
          });
        if (result.changes === 0) skipped.activity++;
        else inserted.activity++;
      }
      for (const provenance of summaryReflectionReverts) {
        this.validateImportedSummaryReflectionRevert(provenance, journal.activity);
        const existing = this.db
          .prepare('SELECT * FROM summary_reflection_reverts WHERE activity_id = ?')
          .get(provenance.activityId) as SummaryReflectionRevertRow | undefined;
        if (existing !== undefined) {
          assertImportMatch(
            'summary Reflection revert provenance',
            provenance.activityId,
            this.parseSummaryReflectionRevert(existing),
            provenance,
          );
          skipped.summaryReflectionReverts++;
        } else {
          this.insertSummaryReflectionRevert(provenance, context.now);
          inserted.summaryReflectionReverts++;
        }
        this.restoreImportedLegacySummaryMarker(provenance);
      }
      const settingCount = (
        this.db.prepare('SELECT count(*) AS count FROM settings').get() as { count: number }
      ).count;
      if (settingCount > 0) {
        assertImportMatch('settings', 'singleton', this.getSettings(), {
          ...journal.settings,
          savedViews: journal.settings.savedViews ?? [],
        });
        skipped.settings++;
      } else {
        this.db
          .prepare(
            `INSERT INTO settings(id,density,show_type_badges,highlight_ai_entries,saved_views,updated_at)
             VALUES (1,@density,@showTypeBadges,@highlightAiEntries,@savedViews,@updatedAt)`,
          )
          .run({
            ...journal.settings,
            showTypeBadges: Number(journal.settings.showTypeBadges),
            highlightAiEntries: Number(journal.settings.highlightAiEntries),
            savedViews: JSON.stringify(journal.settings.savedViews ?? []),
          });
        inserted.settings++;
      }
      // Merge imports can change the historical source set of an existing
      // current Reflection. Reconcile it before this same transaction commits,
      // exactly like command writes do.
      this.reconcileRevertedSummaryReflectionsInContext(context);
      this.activityReflection.beforeCommit(context);
    });
    transaction();
    return { inserted, skipped };
  }

  public purgeExpired(retentionDays?: number): {
    readonly entries: number;
    readonly mutations: number;
    readonly devices: number;
  } {
    return this.collectionRecovery.purgeExpired(retentionDays);
  }

  public close(): void {
    this.listeners.clear();
    this.database.close();
  }

  private write<T>(
    operation: string,
    input: unknown,
    actor: ActorContext,
    mutation: MutationContext | undefined,
    command: (context: WriteContext) => T,
  ): T {
    validateActor(actor);
    if (mutation !== undefined) validateMutationKey(mutation.id);
    const actorIdentity = actorStorageIdentity(actor);
    const requestHash = stableHash({ operation, input: mutation?.request ?? input });
    const transactionId = this.idFactory();
    const transact = this.db.transaction((): MutationOutcome<T> => {
      if (mutation !== undefined) {
        const row = this.db
          .prepare(
            `SELECT request_hash, status_code, result FROM processed_mutations
             WHERE actor_type = ? AND actor_id = ? AND mutation_id = ?`,
          )
          .get(actorIdentity.type, actorIdentity.id, mutation.id) as MutationRow | undefined;
        if (row !== undefined) {
          if (row.request_hash !== requestHash) {
            throw new DomainError(
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency key was already used for a different request',
            );
          }
          return { result: JSON.parse(row.result) as T, replayed: true };
        }
      }

      const context: WriteContext = {
        now: this.now().toISOString(),
        changes: [],
        implicitSnapshots: [],
      };
      const result = command(context);
      // Reflection staleness is a before-commit participant in this same
      // SQLite transaction, never a follow-up write.
      this.activityReflection.beforeCommit(context);
      if (mutation !== undefined) {
        this.db
          .prepare(
            `INSERT INTO processed_mutations(
              actor_type, actor_id, mutation_id, request_hash, status_code, result, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            actorIdentity.type,
            actorIdentity.id,
            mutation.id,
            requestHash,
            mutation.statusCode ?? 200,
            JSON.stringify(result),
            context.now,
          );
      }
      if (context.changes.length === 0) return { result, replayed: false };
      const batch: ChangeBatch = {
        transactionId,
        mutationId: mutation?.id ?? null,
        origin: changeOrigin(actor),
        changes: context.changes,
      };
      return { result, replayed: false, batch };
    });
    const outcome = transact();
    if (!outcome.replayed && outcome.batch !== undefined) this.emit(outcome.batch);
    return outcome.result;
  }

  private emit(batch: ChangeBatch): void {
    for (const listener of this.listeners) {
      try {
        listener(batch);
      } catch {
        // A transport subscriber cannot roll back a committed journal transaction.
      }
    }
  }

  private selectEntry(id: string, includeDeleted: boolean): Entry | null {
    return selectStoredEntry(this.db, id, includeDeleted);
  }

  private requireLiveEntry(id: string): Entry {
    const entry = this.selectEntry(id, false);
    if (entry === null) throw new DomainError('NOT_FOUND', `Entry ${id} was not found`);
    return entry;
  }

  private insertEntry(
    input: Omit<Entry, 'createdAt' | 'updatedAt' | 'deletedAt' | 'revision'> &
      Partial<Pick<Entry, 'createdAt' | 'updatedAt' | 'deletedAt' | 'revision'>>,
    now: string,
  ): Entry {
    return insertStoredEntry(this.db, input, now);
  }

  private replaceEntry(input: Entry, now: string): Entry {
    return replaceStoredEntry(this.db, input, now);
  }

  private updateCollectionRow(collectionInput: Collection, now: string): Collection {
    return this.collectionRecovery.updateRow(collectionInput, now);
  }

  private requireReflection(id: string): Reflection {
    const reflection = this.getReflection(id);
    if (reflection === null) throw new DomainError('NOT_FOUND', `Reflection ${id} was not found`);
    return reflection;
  }

  private insertSummaryReflectionRevert(input: SummaryReflectionRevert, createdAt: string): void {
    const provenance = SummaryReflectionRevertSchema.parse(input);
    this.db
      .prepare(
        `INSERT INTO summary_reflection_reverts(
          activity_id, reflection_id, legacy_summary_id, pre_state, post_state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        provenance.activityId,
        provenance.reflectionId,
        provenance.legacySummaryId,
        stableJson(provenance.before),
        stableJson(provenance.after),
        createdAt,
      );
  }

  private hasSummaryReflectionRevertStorage(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='summary_reflection_reverts'",
        )
        .get() !== undefined
    );
  }

  private listSummaryReflectionReverts(): readonly SummaryReflectionRevert[] {
    if (!this.hasSummaryReflectionRevertStorage()) return [];
    return (
      this.db
        .prepare('SELECT * FROM summary_reflection_reverts ORDER BY activity_id')
        .all() as SummaryReflectionRevertRow[]
    ).map((row) => this.parseSummaryReflectionRevert(row));
  }

  private getSummaryReflectionRevert(activityId: string): SummaryReflectionRevert | null {
    const row = this.db
      .prepare('SELECT * FROM summary_reflection_reverts WHERE activity_id = ?')
      .get(activityId) as SummaryReflectionRevertRow | undefined;
    if (row === undefined) return null;
    return this.parseSummaryReflectionRevert(row);
  }

  private parseSummaryReflectionRevert(row: SummaryReflectionRevertRow): SummaryReflectionRevert {
    try {
      const before = JSON.parse(row.pre_state) as unknown;
      const after = JSON.parse(row.post_state) as unknown;
      const provenance = SummaryReflectionRevertSchema.parse({
        activityId: row.activity_id,
        reflectionId: row.reflection_id,
        legacySummaryId: row.legacy_summary_id,
        before,
        after,
      });
      if (stableJson(before) !== row.pre_state || stableJson(after) !== row.post_state) {
        throw new Error('non-canonical state');
      }
      return provenance;
    } catch (error) {
      throw new DomainError(
        'INTEGRITY_ERROR',
        `Summary Reflection revert provenance for Activity ${row.activity_id} is invalid`,
        { cause: error },
      );
    }
  }

  private validateImportedSummaryReflectionRevert(
    provenance: SummaryReflectionRevert,
    activities: readonly ActivityItem[],
  ): void {
    const activity = activities.find((candidate) => candidate.id === provenance.activityId);
    const beforeSummary = activity?.preImages.find((snapshot) => snapshot.entity === 'summary');
    const afterSummary = activity?.postImages.find((snapshot) => snapshot.entity === 'summary');
    if (
      activity?.kind !== 'summary-filed' ||
      beforeSummary?.entity !== 'summary' ||
      afterSummary?.entity !== 'summary' ||
      afterSummary.row === null ||
      activity.refs.summaryId !== afterSummary.id ||
      provenance.after.weekStart !== afterSummary.row.weekStart ||
      (provenance.before !== null && provenance.before.weekStart !== provenance.after.weekStart)
    ) {
      throw new DomainError(
        'INTEGRITY_ERROR',
        `Summary Reflection revert provenance for Activity ${provenance.activityId} is not linked to its Activity`,
      );
    }
    const after = provenance.after;
    const before = provenance.before;
    const appended = after.versions.filter(
      (version) => !before?.versions.some((candidate) => candidate.id === version.id),
    );
    const retainedBefore =
      before === null
        ? []
        : after.versions.filter((version) =>
            before.versions.some((candidate) => candidate.id === version.id),
          );
    const versionsPreserved =
      before === null ||
      stableJson([...retainedBefore].sort((left, right) => left.id.localeCompare(right.id))) ===
        stableJson([...before.versions].sort((left, right) => left.id.localeCompare(right.id)));
    const filed =
      appended.length === 1 &&
      after.versions.length === (before?.versions.length ?? 0) + 1 &&
      versionsPreserved &&
      after.currentVersionId === appended[0]!.id &&
      after.currentVersion?.id === appended[0]!.id &&
      appended[0]!.number ===
        Math.max(0, ...(before?.versions.map((version) => version.number) ?? [])) + 1 &&
      after.currentVersion.text === afterSummary.row.text &&
      after.currentVersion.generator.tokenId === afterSummary.row.tokenId &&
      after.currentVersion.generator.source === afterSummary.row.source &&
      after.currentVersion.generatedAt === afterSummary.row.updatedAt &&
      after.status === 'current' &&
      after.requestId === null &&
      after.requestedAt === null &&
      after.claimedAt === null &&
      after.claimedBy === null &&
      after.claimedSourceEntries === null &&
      after.failure === null &&
      after.revision === (before?.revision ?? 1) + 1 &&
      after.updatedAt === afterSummary.row.updatedAt &&
      (before === null ||
        (after.id === before.id &&
          after.weekStart === before.weekStart &&
          after.weekEnd === before.weekEnd &&
          after.createdAt === before.createdAt)) &&
      (before !== null || after.id === afterSummary.row.id);
    const rewritten =
      before !== null &&
      appended.length === 0 &&
      versionsPreserved &&
      after.status === 'queued' &&
      after.requestId !== null &&
      after.requestedAt === afterSummary.row.updatedAt &&
      after.claimedAt === null &&
      after.claimedBy === null &&
      after.claimedSourceEntries === null &&
      after.failure === null &&
      after.currentVersionId === before.currentVersionId &&
      after.id === before.id &&
      after.weekStart === before.weekStart &&
      after.weekEnd === before.weekEnd &&
      after.createdAt === before.createdAt &&
      after.updatedAt === afterSummary.row.updatedAt &&
      after.revision === before.revision + 1;
    if (!filed && !rewritten) {
      throw new DomainError(
        'INTEGRITY_ERROR',
        `Summary Reflection revert provenance for Activity ${provenance.activityId} is not a valid filing transition`,
      );
    }
  }

  private markImportedLegacySummaryProjection(
    reflection: Reflection,
    summaries: readonly Summary[],
  ): void {
    const version = reflection.versions[0];
    const summary = summaries.find(
      (candidate) => candidate.id === reflection.id && candidate.weekStart === reflection.weekStart,
    );
    if (
      summary === undefined ||
      version === undefined ||
      reflection.versions.length !== 1 ||
      reflection.currentVersionId !== reflection.id ||
      version.id !== reflection.id ||
      version.number !== 1 ||
      version.generator.label !== 'Legacy assistant' ||
      version.generator.tool !== undefined ||
      version.sourceEntries.length !== 0 ||
      version.text !== summary.text ||
      version.generator.tokenId !== summary.tokenId ||
      version.generator.source !== summary.source ||
      version.generatedAt !== summary.updatedAt ||
      reflection.requestId !== null ||
      reflection.requestedAt !== null ||
      reflection.claimedAt !== null ||
      reflection.claimedBy !== null ||
      reflection.claimedSourceEntries !== null ||
      reflection.failure !== null
    ) {
      return;
    }
    this.db
      .prepare(
        'UPDATE reflection_slots SET legacy_summary_id=? WHERE id=? AND legacy_summary_id IS NULL',
      )
      .run(reflection.id, reflection.id);
  }

  private restoreImportedLegacySummaryMarker(provenance: SummaryReflectionRevert): void {
    if (provenance.legacySummaryId === null) return;
    const existing = this.db
      .prepare('SELECT legacy_summary_id FROM reflection_slots WHERE id=?')
      .pluck()
      .get(provenance.reflectionId) as string | null;
    if (existing !== null && existing !== provenance.legacySummaryId) {
      throw new DomainError(
        'CONFLICT',
        `Reflection ${provenance.reflectionId} has different legacy Summary provenance`,
      );
    }
    this.db
      .prepare('UPDATE reflection_slots SET legacy_summary_id=? WHERE id=?')
      .run(provenance.legacySummaryId, provenance.reflectionId);
  }

  private restoreSummaryReflection(
    provenance: SummaryReflectionRevert,
    context: WriteContext,
  ): void {
    const current = this.getReflection(provenance.reflectionId);
    if (stableJson(current) !== stableJson(provenance.after)) {
      throw new DomainError(
        'CONFLICT',
        'The Reflection changed after this activity; reverting would overwrite newer work',
        { details: { reflectionId: provenance.reflectionId } },
      );
    }
    if (current === null) {
      throw new DomainError('INTEGRITY_ERROR', 'Recorded Reflection post-state is missing');
    }
    this.db.prepare('DELETE FROM reflection_versions WHERE reflection_id = ?').run(current.id);
    this.db.prepare('DELETE FROM reflection_slots WHERE id = ?').run(current.id);
    if (provenance.before === null) {
      context.changes.push(reflectionChange(null, current.id, current.weekStart));
      return;
    }

    const safeBefore =
      provenance.before.status === 'running'
        ? {
            ...provenance.before,
            status: 'queued' as const,
            claimedAt: null,
            claimedBy: null,
            claimedSourceEntries: null,
          }
        : provenance.before;
    const restored = ReflectionSchema.parse({
      ...safeBefore,
      updatedAt: [safeBefore.updatedAt, current.updatedAt, context.now].sort(
        (left, right) => Date.parse(right) - Date.parse(left),
      )[0],
      revision: current.revision + 1,
    });
    this.db
      .prepare(
        `INSERT INTO reflection_slots(
          id,week_start,week_end,status,request_id,requested_at,claimed_at,claimed_token_id,
          claimed_label,claimed_tool,claimed_source_entries,failure,current_version_id,
          created_at,updated_at,revision,legacy_summary_id
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        restored.id,
        restored.weekStart,
        restored.weekEnd,
        restored.status,
        restored.requestId,
        restored.requestedAt,
        restored.claimedAt,
        restored.claimedBy?.tokenId ?? null,
        restored.claimedBy?.label ?? null,
        restored.claimedBy?.tool ?? null,
        restored.claimedSourceEntries == null
          ? null
          : JSON.stringify(restored.claimedSourceEntries),
        restored.failure,
        restored.currentVersionId,
        restored.createdAt,
        restored.updatedAt,
        restored.revision,
        provenance.legacySummaryId,
      );
    const insertVersion = this.db.prepare(
      `INSERT INTO reflection_versions(
        id,reflection_id,version_number,text,source_from,source_to,generator_token_id,
        generator_label,generator_tool,source,generated_at,source_entries
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const version of restored.versions) {
      insertVersion.run(
        version.id,
        restored.id,
        version.number,
        version.text,
        version.sourceFrom,
        version.sourceTo,
        version.generator.tokenId,
        version.generator.label,
        version.generator.tool ?? null,
        version.generator.source,
        version.generatedAt,
        JSON.stringify(version.sourceEntries),
      );
    }
    context.changes.push(reflectionChange(this.requireReflection(restored.id)));
  }

  private reconcileRevertedSummaryReflections(): void {
    const reconcile = this.db.transaction(() => {
      const context: WriteContext = {
        now: this.now().toISOString(),
        changes: [],
        implicitSnapshots: [],
      };
      this.reconcileRevertedSummaryReflectionsInContext(context);
      this.activityReflection.beforeCommit(context);
    });
    reconcile();
  }

  private reconcileRevertedSummaryReflectionsInContext(context: WriteContext): void {
    const rows = this.db
      .prepare('SELECT * FROM summary_reflection_reverts ORDER BY created_at, activity_id')
      .all() as SummaryReflectionRevertRow[];
    for (const row of rows) {
      const provenance = this.parseSummaryReflectionRevert(row);
      const activity = this.getActivity(provenance.activityId);
      if (activity === null) {
        throw new DomainError(
          'INTEGRITY_ERROR',
          `Summary Reflection revert provenance references missing Activity ${provenance.activityId}`,
        );
      }
      this.validateImportedSummaryReflectionRevert(provenance, [activity]);
      if (activity.revertedAt === null) continue;
      const summaryBefore = activity.preImages.find((snapshot) => snapshot.entity === 'summary');
      if (summaryBefore?.entity !== 'summary') continue;
      const currentSummary = this.getSummary(summaryBefore.id);
      const summaryWasRestored =
        summaryBefore.row === null
          ? currentSummary === null
          : currentSummary !== null &&
            stableJson({
              ...currentSummary,
              updatedAt: summaryBefore.row.updatedAt,
              revision: summaryBefore.row.revision,
            }) === stableJson(summaryBefore.row);
      if (!summaryWasRestored) continue;
      const currentReflection = this.getReflection(provenance.reflectionId);
      if (stableJson(currentReflection) !== stableJson(provenance.after)) continue;
      this.restoreSummaryReflection(provenance, context);
    }
  }

  private upsertLegacyReflection(
    summary: Summary,
    actor: Extract<ActorContext, { readonly kind: 'agent' }>,
    context: WriteContext,
  ): Reflection {
    return this.activityReflection.upsertLegacyReflection(summary, actor, context);
  }

  private insertSummary(summaryInput: Summary): void {
    const summary = SummarySchema.parse(summaryInput);
    this.db
      .prepare(
        `INSERT INTO summaries(
          id,week_start,text,status,source,token_id,created_at,updated_at,saved_entry_id,revision
        ) VALUES (@id,@weekStart,@text,@status,@source,@tokenId,@createdAt,@updatedAt,@savedEntryId,@revision)`,
      )
      .run(summary);
  }

  private updateSummaryRow(summaryInput: Summary): void {
    const summary = SummarySchema.parse(summaryInput);
    this.db
      .prepare(
        `UPDATE summaries SET text=@text,status=@status,source=@source,token_id=@tokenId,
         updated_at=@updatedAt,saved_entry_id=@savedEntryId,revision=@revision WHERE id=@id`,
      )
      .run(summary);
  }

  private requireSummary(id: string): Summary {
    const summary = this.getSummary(id);
    if (summary === null) throw new DomainError('NOT_FOUND', `Summary ${id} was not found`);
    return summary;
  }

  private findActivityForSummary(kind: ActivityKind, summaryId: string): ActivityItem | null {
    const rows = this.db
      .prepare('SELECT * FROM activity WHERE kind = ? ORDER BY at DESC')
      .all(kind) as ActivityRow[];
    return rows.map(mapActivity).find((activity) => activity.refs.summaryId === summaryId) ?? null;
  }

  private insertActivity(
    input: {
      readonly id?: string;
      readonly kind: ActivityKind;
      readonly text: string;
      readonly refs: ActivityItem['refs'];
      readonly preImages: readonly Snapshot[];
      readonly postImages: readonly Snapshot[];
    },
    actor: ActorContext,
    context: WriteContext,
  ): ActivityItem {
    return this.activityReflection.append(input, actor, context);
  }

  private selectSnapshot(entity: Snapshot['entity'], id: string): Snapshot['row'] {
    switch (entity) {
      case 'entry':
        return this.selectEntry(id, true);
      case 'collection':
        return this.getCollection(id);
      case 'summary':
        return this.getSummary(id);
    }
  }

  private restoreSnapshot(snapshot: Snapshot, context: WriteContext): Snapshot {
    switch (snapshot.entity) {
      case 'entry': {
        const current = this.selectEntry(snapshot.id, true);
        if (current === null)
          throw new DomainError('CONFLICT', `Entry ${snapshot.id} no longer exists`);
        const restored =
          snapshot.row === null
            ? this.replaceEntry({ ...current, deletedAt: context.now }, context.now)
            : this.replaceEntry({ ...snapshot.row, revision: current.revision }, context.now);
        context.changes.push(entryChange(restored));
        return snapshotEntry(restored);
      }
      case 'collection': {
        const current = this.getCollection(snapshot.id);
        if (snapshot.row === null) {
          if (current === null) return { ...snapshot, row: null };
          const entries = this.searchEntries({ collection: snapshot.id, limit: 1 }).total;
          if (entries > 0)
            throw new DomainError(
              'CONFLICT',
              'Collection now contains entries and cannot be removed',
            );
          this.db.prepare('DELETE FROM collections WHERE id = ?').run(snapshot.id);
          context.changes.push(collectionChange(null, snapshot.id));
          return { ...snapshot, row: null };
        }
        if (current === null) {
          this.db
            .prepare(
              `INSERT INTO collections(id,name,note,created_at,updated_at,archived_at)
               VALUES (@id,@name,@note,@createdAt,@createdAt,@archivedAt)`,
            )
            .run(snapshot.row);
        } else this.updateCollectionRow(snapshot.row, context.now);
        context.changes.push(collectionChange(snapshot.row));
        return snapshot;
      }
      case 'summary': {
        const current = this.getSummary(snapshot.id);
        if (snapshot.row === null) {
          this.db.prepare('DELETE FROM summaries WHERE id = ?').run(snapshot.id);
          context.changes.push(summaryChange(null, snapshot.id));
          return { ...snapshot, row: null };
        }
        const restored = SummarySchema.parse({
          ...snapshot.row,
          updatedAt: monotonicTimestamp(current?.updatedAt ?? snapshot.row.updatedAt, context.now),
          revision: (current?.revision ?? snapshot.row.revision) + 1,
        });
        if (current === null) this.insertSummary(restored);
        else this.updateSummaryRow(restored);
        context.changes.push(summaryChange(restored));
        return snapshotSummary(restored);
      }
    }
  }
}
