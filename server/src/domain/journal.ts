import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { JournalConfig } from '../config.js';
import { journalDate } from '../config.js';
import {
  ActivityItemSchema,
  ActivityViewSchema,
  AgentTokenScopeSchema,
  AgentTokenSchema,
  CalendarMonthSchema,
  CollectionSchema,
  EntryPatchSchema,
  EntrySchema,
  EntryTypeSchema,
  IsoTimestampSchema,
  JournalExportSchema,
  JournalExportV2Schema,
  MigrationOperationSchema,
  ReflectionSchema,
  ReflectionVersionSchema,
  SearchInputSchema,
  SettingsSchema,
  SummarySchema,
  UlidSchema,
} from '../contracts/index.js';
import type { JournalDatabase } from '../db/database.js';
import { DomainError } from './errors.js';
import { journalSearchNeedles } from './search-query.js';
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
  EntryState,
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
  ReflectionVersion,
  RecentlyDeletedEntry,
  SearchEntriesInput,
  SearchEntriesResult,
  Snapshot,
  Settings,
  Summary,
  TagUsage,
} from './types.js';

interface EntryRow {
  readonly id: string;
  readonly date: string;
  readonly type: EntryType;
  readonly text: string;
  readonly state: EntryState;
  readonly time: string | null;
  readonly tags: string;
  readonly author: 'me' | 'ai';
  readonly source: string | null;
  readonly migrations: number;
  readonly collection: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
  readonly revision: number;
}

type NewEntry = Omit<Entry, 'createdAt' | 'updatedAt' | 'deletedAt' | 'revision'>;

function mapEntry(row: EntryRow): Entry {
  return EntrySchema.parse({
    id: row.id,
    date: row.date,
    type: row.type,
    text: row.text,
    state: row.state,
    time: row.time,
    tags: parseStringArray(row.tags),
    author: row.author,
    source: row.source,
    migrations: row.migrations,
    collection: row.collection,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    deletedAt: row.deleted_at,
  });
}

function mapCollection(row: CollectionRow): Collection {
  return CollectionSchema.parse({
    id: row.id,
    name: row.name,
    note: row.note,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  });
}

function mapSummary(row: SummaryRow): Summary {
  return SummarySchema.parse({
    id: row.id,
    weekStart: row.week_start,
    text: row.text,
    status: row.status,
    source: row.source,
    tokenId: row.token_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    savedEntryId: row.saved_entry_id,
    revision: row.revision,
  });
}

function mapReflectionVersion(row: ReflectionVersionRow): ReflectionVersion {
  return ReflectionVersionSchema.parse({
    id: row.id,
    number: row.version_number,
    text: row.text,
    sourceFrom: row.source_from,
    sourceTo: row.source_to,
    generator: {
      tokenId: row.generator_token_id,
      label: row.generator_label,
      ...(row.generator_tool === null ? {} : { tool: row.generator_tool }),
      source: row.source,
    },
    generatedAt: row.generated_at,
    sourceEntries: JSON.parse(row.source_entries) as unknown,
  });
}

function mapReflection(
  row: ReflectionSlotRow,
  versionRows: readonly ReflectionVersionRow[],
): Reflection {
  const versions = versionRows.map(mapReflectionVersion);
  const currentVersion =
    row.current_version_id === null
      ? null
      : (versions.find((version) => version.id === row.current_version_id) ?? null);
  return ReflectionSchema.parse({
    id: row.id,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    status: row.status,
    revision: row.revision,
    requestId: row.request_id,
    requestedAt: row.requested_at,
    claimedAt: row.claimed_at,
    claimedBy:
      row.claimed_at === null || row.claimed_token_id === null || row.claimed_label === null
        ? null
        : {
            tokenId: row.claimed_token_id,
            label: row.claimed_label,
            ...(row.claimed_tool === null ? {} : { tool: row.claimed_tool }),
          },
    failure: row.failure,
    currentVersionId: row.current_version_id,
    currentVersion,
    versions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapActivity(row: ActivityRow): ActivityItem {
  return ActivityItemSchema.parse({
    id: row.id,
    at: row.at,
    kind: row.kind,
    text: row.text,
    origin: JSON.parse(row.origin) as unknown,
    refs: JSON.parse(row.refs) as unknown,
    preImages: JSON.parse(row.pre_images) as unknown,
    postImages: JSON.parse(row.post_images) as unknown,
    revertedAt: row.reverted_at,
    revertedByActivityId: row.reverted_by_activity_id,
  });
}

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

function normalizeCreateEntry(
  input: CreateEntryInput,
  actor: ActorContext,
  today: string,
  makeId: () => string = ulid,
): NewEntry {
  const id = input.id ?? makeId();
  validateId(id);
  const type = input.type ?? 'task';
  validateEntryType(type);
  const date = input.date ?? today;
  validateDate(date);
  if (actor.kind === 'agent') assertDateWithin(date, today, 366);
  const text = normalizeText(input.text, 500, 'entry text');
  const time = input.time === undefined || input.time === null ? null : validateTime(input.time);
  const tags = normalizeTags(input.tags ?? []);
  const collection = input.collection ?? null;
  if (collection !== null) validateCollectionId(collection);
  const author = actor.kind === 'agent' ? 'ai' : 'me';
  const source = actor.kind === 'agent' ? normalizeSource(input.source ?? '') : null;
  return {
    id,
    date,
    type,
    text,
    state: isActionable(type) ? 'open' : 'logged',
    time,
    tags,
    author,
    source,
    migrations: 0,
    collection,
  };
}

function normalizePatchedEntry(before: Entry, patchInput: EntryPatch): Entry {
  const patch = EntryPatchSchema.parse(patchInput);
  const type = patch.type ?? before.type;
  const implicitState =
    patch.type !== undefined && patch.state === undefined
      ? isActionable(type)
        ? 'open'
        : 'logged'
      : before.state;
  const entry = {
    ...before,
    ...patch,
    type,
    state: patch.state ?? implicitState,
    text: patch.text === undefined ? before.text : normalizeText(patch.text, 500, 'entry text'),
    date: patch.date === undefined ? before.date : validateDate(patch.date),
    time:
      patch.time === undefined
        ? before.time
        : patch.time === null
          ? null
          : validateTime(patch.time),
    tags: patch.tags === undefined ? before.tags : normalizeTags(patch.tags),
    collection: patch.collection === undefined ? before.collection : patch.collection,
  };
  if (entry.collection !== null) validateCollectionId(entry.collection);
  return EntrySchema.parse(entry);
}

function normalizeCollectionInput(input: {
  readonly id: string;
  readonly name: string;
  readonly note?: string | null;
}): Pick<Collection, 'id' | 'name' | 'note'> {
  validateCollectionId(input.id);
  return {
    id: input.id,
    name: validateCollectionName(input.name),
    note: normalizeOptionalLine(input.note ?? null, 300, 'collection note'),
  };
}

function validateCollectionName(value: string): string {
  return normalizeText(value, 120, 'collection name');
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

function validateExport(document: JournalExport): JournalExportV1 | JournalExportV2['journal'] {
  const parsed = JournalExportSchema.parse(document);
  return parsed.version === 1 ? parsed : parsed.journal;
}

function validateSearch(input: SearchEntriesInput): void {
  const canonical = {
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.author === undefined ? {} : { author: input.author }),
    ...(input.tag === undefined ? {} : { tag: input.tag }),
    ...(input.collection === undefined ? {} : { collection: input.collection }),
    ...(input.dateFrom === undefined ? {} : { dateFrom: input.dateFrom }),
    ...(input.dateTo === undefined ? {} : { dateTo: input.dateTo }),
    limit: input.limit ?? 25,
  };
  SearchInputSchema.parse(canonical);
  if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0)) {
    invalid('offset must be a non-negative integer');
  }
}

function validateAgentMigration(input: ApplyAgentMigrationInput): void {
  if (!['split', 'drop', 'retag', 'move', 'other'].includes(input.kind))
    invalid('Unknown migration kind');
  normalizeText(input.title, 120, 'migration title');
  normalizeText(input.detail, 300, 'migration detail');
  if (input.ops.length < 1 || input.ops.length > 10)
    invalid('Migration requires 1 to 10 operations');
  for (const operation of input.ops) {
    if (!MigrationOperationSchema.safeParse(operation).success) {
      invalid('Migration operation does not satisfy the revision-bound contract');
    }
  }
  if ((input.lines?.length ?? 0) > 6) invalid('Migration supports at most 6 display lines');
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

function validateId(id: string): void {
  const result = UlidSchema.safeParse(id);
  if (!result.success) invalid('Expected a canonical ULID');
}

function validateDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('Date must be YYYY-MM-DD');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    invalid('Date is not a valid calendar day');
  }
  return value;
}

function validateTime(value: string): string {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) invalid('Time must be HH:MM');
  return value;
}

function assertDateWithin(value: string, center: string, days: number): void {
  const distance = Math.abs(Date.parse(`${value}T00:00:00Z`) - Date.parse(`${center}T00:00:00Z`));
  if (distance > days * 86_400_000) {
    invalid(`Agent entry date must be within ${days} days of server today`);
  }
}

function validateEntryType(value: string): asserts value is EntryType {
  if (!['task', 'event', 'note', 'idea', 'question', 'habit', 'mood'].includes(value)) {
    invalid('Unknown entry type');
  }
}

function validateCollectionId(value: string): void {
  if (!/^(?:[a-z0-9-]+|month:\d{4}-(?:0[1-9]|1[0-2]))$/.test(value) || value.length > 80) {
    invalid('Collection id must be a lowercase slug or month:YYYY-MM');
  }
}

function normalizeText(value: string, maximum: number, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || /[\r\n]/.test(normalized)) {
    invalid(`${label} must be one line between 1 and ${maximum} characters`);
  }
  return normalized;
}

function normalizeOptionalLine(
  value: string | null,
  maximum: number,
  label: string,
): string | null {
  if (value === null) return null;
  return normalizeText(value, maximum, label);
}

function normalizeSource(value: string): string {
  const source = normalizeText(value, 300, 'source');
  if (source.length < 5) invalid('Agent source must contain at least 5 characters');
  return source;
}

function normalizeTag(value: string): string {
  const tag = value.replace(/^#/, '').trim().toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(tag)) invalid('Tags use lowercase letters, digits, and hyphens');
  return tag;
}

function normalizeTags(values: readonly string[]): string[] {
  if (values.length > 50) invalid('An entry can have at most 50 tags');
  return [...new Set(values.map(normalizeTag))];
}

function normalizeScope(value: string): AgentTokenScope {
  const parsed = AgentTokenScopeSchema.safeParse(value);
  if (!parsed.success) invalid(`Unknown agent token scope: ${value}`);
  return parsed.data;
}

function isActionable(type: EntryType): boolean {
  return type === 'task' || type === 'habit';
}

function assertActionableOpen(entry: Entry, operation: string): void {
  if (!isActionable(entry.type) || entry.state !== 'open') {
    throw new DomainError('CONFLICT', `Only open tasks or habits can ${operation}`);
  }
}

function assertExpectedRevision(entry: Entry, expected: number | undefined): void {
  if (expected !== undefined && entry.revision !== expected) {
    throw new DomainError('CONFLICT', `Entry changed since revision ${expected}`, {
      details: { expectedRevision: expected, actualRevision: entry.revision },
    });
  }
}

function requireAgentExpectedRevision(actor: ActorContext, expected: number | undefined): void {
  if (actor.kind === 'agent' && expected === undefined) {
    invalid('Agent update and delete operations require expectedRevision');
  }
}

function assertExpectedSummaryRevision(summary: Summary, expected: number | undefined): void {
  if (expected !== undefined && summary.revision !== expected) {
    throw new DomainError('CONFLICT', `Summary changed since revision ${expected}`, {
      details: { expectedRevision: expected, actualRevision: summary.revision },
    });
  }
}

function sameCreateIntent(existing: Entry, input: NewEntry): boolean {
  return (
    existing.deletedAt === null &&
    existing.date === input.date &&
    existing.type === input.type &&
    existing.text === input.text &&
    existing.time === input.time &&
    stableJson(existing.tags) === stableJson(input.tags) &&
    existing.author === input.author &&
    existing.source === input.source &&
    existing.collection === input.collection
  );
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

function activityOrigin(actor: ActorContext): ActivityItem['origin'] {
  switch (actor.kind) {
    case 'owner':
      return { actor: 'app', deviceId: actor.deviceId };
    case 'agent':
      return {
        actor: 'mcp',
        tokenId: actor.tokenId,
        ...(actor.tool === undefined ? {} : { tool: actor.tool }),
        ...(actor.tailscaleUserLogin === undefined
          ? {}
          : { tailscaleUserLogin: actor.tailscaleUserLogin }),
      };
    case 'system':
      return { actor: 'system' };
  }
}

function actorRefs(_actor: ActorContext, entryIds: readonly string[]): ActivityItem['refs'] {
  return { entryIds: [...entryIds] };
}

function snapshotEntry(entry: Entry): Snapshot {
  return { entity: 'entry', id: entry.id, row: entry };
}

function snapshotSummary(summary: Summary): Snapshot {
  return { entity: 'summary', id: summary.id, row: summary };
}

function snapshotCollection(collection: Collection): Snapshot {
  return { entity: 'collection', id: collection.id, row: collection };
}

function snapshotEqual(left: Snapshot['row'], right: Snapshot['row']): boolean {
  return stableJson(left) === stableJson(right);
}

function upsertChange(
  entity: 'entry' | 'collection' | 'summary',
  row: Entry | Collection | Summary,
): EntityChange {
  switch (entity) {
    case 'entry':
      return entryChange(row as Entry);
    case 'collection':
      return collectionChange(row as Collection);
    case 'summary':
      return summaryChange(row as Summary);
  }
}

function entryChange(entry: Entry): EntityChange {
  return { kind: entry.deletedAt === null ? 'entry.updated' : 'entry.deleted', payload: entry };
}

function entryCreatedChange(entry: Entry): EntityChange {
  return { kind: 'entry.created', payload: entry };
}

function collectionChange(collection: Collection | null, id?: string): EntityChange {
  if (collection !== null) return { kind: 'collection.changed', payload: collection };
  if (id === undefined) throw new Error('Removed collection changes require an id');
  return { kind: 'collection.changed', payload: { id } };
}

function summaryChange(summary: Summary | null, id?: string): EntityChange {
  if (summary !== null) return { kind: 'summary.changed', payload: summary };
  if (id === undefined) throw new Error('Removed summary changes require an id');
  return { kind: 'summary.changed', payload: { id } };
}

function reflectionChange(reflection: Reflection): EntityChange {
  return { kind: 'reflection.changed', payload: reflection };
}

function activityChange(activity: ActivityItem): EntityChange {
  return { kind: 'activity.appended', payload: activity };
}

function settingsChange(settings: Settings): EntityChange {
  return { kind: 'settings.changed', payload: settings };
}

function tokenChange(token: AgentTokenRecord): EntityChange {
  return { kind: 'token.changed', payload: token };
}

function addWhere(where: string[], params: unknown[], clause: string, value: unknown): void {
  where.push(clause);
  params.push(value);
}

function ftsPrefixQuery(value: string): string {
  const tokens = value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return '"journal-no-token-sentinel"';
  return tokens.map((token) => `"${token}"*`).join(' AND ');
}

function entryPredicate(input: SearchEntriesInput): { predicate: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.includeDeleted !== true) where.push('e.deleted_at IS NULL');
  if (input.excludeMonthlyCollections === true) {
    where.push("(e.collection IS NULL OR e.collection NOT LIKE 'month:%')");
  }
  if (input.type !== undefined) addWhere(where, params, 'e.type = ?', input.type);
  if (input.state !== undefined) addWhere(where, params, 'e.state = ?', input.state);
  if (input.author !== undefined) addWhere(where, params, 'e.author = ?', input.author);
  if (input.dateFrom !== undefined) addWhere(where, params, 'e.date >= ?', input.dateFrom);
  if (input.dateTo !== undefined) addWhere(where, params, 'e.date <= ?', input.dateTo);
  if (input.collection === 'daily') where.push('e.collection IS NULL');
  else if (input.collection !== undefined)
    addWhere(where, params, 'e.collection = ?', input.collection);
  const exactTag =
    input.tag ?? (input.query?.trim().startsWith('#') ? input.query.trim().slice(1) : undefined);
  if (exactTag !== undefined && exactTag !== '') {
    const tag = normalizeTag(exactTag);
    where.push('EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value = ?)');
    params.push(tag);
  } else if (input.query !== undefined && input.query.trim() !== '') {
    const needles = journalSearchNeedles(input.query);
    for (const needle of needles) {
      where.push(
        `(e.rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)
          OR instr(journal_search_normalize(e.text), ?) > 0
          OR instr(journal_search_normalize(e.tags), ?) > 0)`,
      );
      params.push(ftsPrefixQuery(needle), needle, needle);
    }
  }
  return { predicate: where.length === 0 ? '1 = 1' : where.join(' AND '), params };
}

function parseStringArray(json: string): string[] {
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new DomainError('INTEGRITY_ERROR', 'Invalid string array stored in the journal database');
  }
  return value;
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

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function mondayOf(dateString: string): string {
  const date = new Date(`${validateDate(dateString)}T00:00:00Z`);
  const weekday = date.getUTCDay();
  const delta = weekday === 0 ? -6 : 1 - weekday;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function addCalendarDays(dateString: string, days: number): string {
  const date = new Date(`${validateDate(dateString)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isMonday(dateString: string): boolean {
  return new Date(`${validateDate(dateString)}T00:00:00Z`).getUTCDay() === 1;
}

function formatMonthName(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year ?? 0, (monthNumber ?? 1) - 1, 1)),
  );
}

function truncateForActivity(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 117)}…`;
}

function migrationActivityText(input: ApplyAgentMigrationInput): string {
  const lines = (input.lines ?? []).map((line, index) => `${index + 1}. ${line}`).join(' ');
  const sources = [
    ...new Set(
      input.ops
        .filter((operation) => operation.op === 'create')
        .map((operation) => operation.entry.source),
    ),
  ];
  const parts = [`Applied migration: ${input.title}`, input.detail];
  if (lines !== '') parts.push(lines);
  if (sources.length > 0) parts.push(`Source: ${sources.join('; ')}`);
  const text = parts.join(' — ').replace(/\s+/g, ' ').trim();
  return text.length <= 500 ? text : `${text.slice(0, 499)}…`;
}

function assertImportMatch(entity: string, id: string, existing: unknown, incoming: unknown): void {
  if (stableJson(existing) !== stableJson(incoming)) {
    throw new DomainError('CONFLICT', `${entity} ${id} already exists with different content`);
  }
}

function invalid(message: string): never {
  throw new DomainError('VALIDATION_ERROR', message);
}

interface CollectionRow {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
}

interface CountedCollectionRow extends CollectionRow {
  readonly count: number;
}

interface MonthCountRow {
  readonly month: string;
  readonly count: number;
}

interface TypeCountRow {
  readonly type: string;
  readonly count: number;
}

interface SummaryRow {
  readonly id: string;
  readonly week_start: string;
  readonly text: string;
  readonly status: Summary['status'];
  readonly source: string;
  readonly token_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly saved_entry_id: string | null;
  readonly revision: number;
}

interface ReflectionSlotRow {
  readonly id: string;
  readonly week_start: string;
  readonly week_end: string;
  readonly status: Reflection['status'];
  readonly request_id: string | null;
  readonly requested_at: string | null;
  readonly claimed_at: string | null;
  readonly claimed_token_id: string | null;
  readonly claimed_label: string | null;
  readonly claimed_tool: string | null;
  readonly failure: string | null;
  readonly current_version_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly revision: number;
}

interface ReflectionVersionRow {
  readonly id: string;
  readonly reflection_id: string;
  readonly version_number: number;
  readonly text: string;
  readonly source_from: string;
  readonly source_to: string;
  readonly generator_token_id: string;
  readonly generator_label: string;
  readonly generator_tool: string | null;
  readonly source: string;
  readonly generated_at: string;
  readonly source_entries: string;
}

interface ActivityRow {
  readonly id: string;
  readonly at: string;
  readonly kind: ActivityKind;
  readonly text: string;
  readonly origin: string;
  readonly refs: string;
  readonly pre_images: string;
  readonly post_images: string;
  readonly reverted_at: string | null;
  readonly reverted_by_activity_id: string | null;
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

interface WriteContext {
  readonly now: string;
  readonly changes: EntityChange[];
  readonly implicitSnapshots: Array<{ readonly pre: Snapshot; readonly post: Snapshot }>;
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
}

export class JournalDomain {
  private readonly database: JournalDatabase;
  private readonly db: Database.Database;
  private readonly config: JournalDomainOptions['config'];
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly listeners = new Set<ChangeListener>();

  public constructor(options: JournalDomainOptions) {
    this.database = options.database;
    this.db = options.database.raw;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => ulid());
  }

  public today(at = this.now()): string {
    return journalDate(this.config, at);
  }

  public subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getEntry(id: string, options: { includeDeleted?: boolean } = {}): Entry | null {
    validateId(id);
    const row = this.db
      .prepare(
        `SELECT * FROM entries WHERE id = ? ${options.includeDeleted === true ? '' : 'AND deleted_at IS NULL'}`,
      )
      .get(id) as EntryRow | undefined;
    return row === undefined ? null : mapEntry(row);
  }

  public requireEntry(id: string, options: { includeDeleted?: boolean } = {}): Entry {
    const entry = this.getEntry(id, options);
    if (entry === null) throw new DomainError('NOT_FOUND', `Entry ${id} was not found`);
    return entry;
  }

  public searchEntries(input: SearchEntriesInput = {}): SearchEntriesResult {
    validateSearch(input);
    const { predicate, params } = entryPredicate(input);
    const total = this.countEntries(input);
    const limit = input.limit ?? 25;
    const offset = input.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entries e WHERE ${predicate}
         ORDER BY e.date DESC, e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as EntryRow[];
    return { total, entries: rows.map(mapEntry) };
  }

  public listRecentlyDeleted(retentionDays = 30): readonly RecentlyDeletedEntry[] {
    if (!Number.isInteger(retentionDays) || retentionDays < 1)
      invalid('retentionDays must be a positive integer');
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT e.*, c.name AS recovery_collection_name, c.archived_at AS recovery_archived_at
         FROM entries e
         LEFT JOIN collections c ON c.id = e.collection
         WHERE e.deleted_at IS NOT NULL AND e.deleted_at >= ?
         ORDER BY e.deleted_at DESC, e.id DESC`,
      )
      .all(cutoff) as Array<
      EntryRow & { recovery_collection_name: string | null; recovery_archived_at: string | null }
    >;
    return rows.map((row) => {
      const entry = mapEntry(row);
      const deletedAt = entry.deletedAt;
      if (deletedAt === null) throw new DomainError('INTEGRITY_ERROR', 'Recovery row is live');
      const collectionId = entry.collection;
      const destination =
        collectionId === null
          ? { collectionId: null, collectionName: null, status: 'daily' as const }
          : row.recovery_collection_name === null
            ? {
                collectionId,
                collectionName: null,
                status: 'missing' as const,
              }
            : {
                collectionId,
                collectionName: row.recovery_collection_name,
                status:
                  row.recovery_archived_at === null ? ('active' as const) : ('archived' as const),
              };
      return {
        entry,
        expiresAt: new Date(Date.parse(deletedAt) + retentionDays * 86_400_000).toISOString(),
        destination,
      };
    });
  }

  public countEntries(input: SearchEntriesInput = {}): number {
    validateSearch(input);
    const { predicate, params } = entryPredicate(input);
    return (
      this.db
        .prepare(`SELECT count(*) AS count FROM entries e WHERE ${predicate}`)
        .get(...params) as { count: number }
    ).count;
  }

  public pageEntries(
    input: Omit<SearchEntriesInput, 'limit' | 'offset'> & { readonly limit: number },
    before?: EntryPageBoundary,
  ): EntryPage {
    validateSearch(input);
    if (before !== undefined) {
      validateDate(before.date);
      if (!IsoTimestampSchema.safeParse(before.createdAt).success)
        invalid('Invalid entry cursor timestamp');
      validateId(before.id);
    }
    const { predicate, params } = entryPredicate(input);
    const boundary =
      before === undefined
        ? ''
        : ` AND (e.date < ? OR (e.date = ? AND e.created_at < ?)
             OR (e.date = ? AND e.created_at = ? AND e.id < ?))`;
    if (before !== undefined) {
      params.push(
        before.date,
        before.date,
        before.createdAt,
        before.date,
        before.createdAt,
        before.id,
      );
    }
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entries e WHERE ${predicate}${boundary}
         ORDER BY e.date DESC, e.created_at DESC, e.id DESC LIMIT ?`,
      )
      .all(...params, input.limit + 1) as EntryRow[];
    return { items: rows.slice(0, input.limit).map(mapEntry), hasMore: rows.length > input.limit };
  }

  public listDay(date = this.today()): DayResult {
    validateDate(date);
    const entries = (
      this.db
        .prepare(
          `SELECT * FROM entries WHERE date = ? AND collection IS NULL AND deleted_at IS NULL
           ORDER BY created_at DESC, id DESC`,
        )
        .all(date) as EntryRow[]
    ).map(mapEntry);
    const isToday = date === this.today();
    const leftovers = isToday
      ? (
          this.db
            .prepare(
              `SELECT * FROM entries WHERE date < ? AND collection IS NULL AND type = 'task'
               AND state = 'open' AND deleted_at IS NULL ORDER BY date ASC, created_at ASC`,
            )
            .all(date) as EntryRow[]
        ).map(mapEntry)
      : [];
    return { date, isToday, entries, leftovers: { count: leftovers.length, entries: leftovers } };
  }

  public listCollections(
    options: { includeArchived?: boolean; includeMonths?: boolean } = {},
  ): readonly Collection[] {
    const clauses: string[] = [];
    if (options.includeArchived !== true) clauses.push('archived_at IS NULL');
    if (options.includeMonths !== true) clauses.push("id NOT LIKE 'month:%'");
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    return (
      this.db
        .prepare(`SELECT * FROM collections ${where} ORDER BY name COLLATE NOCASE`)
        .all() as CollectionRow[]
    ).map(mapCollection);
  }

  /**
   * One bounded read model for Index. Collection and type counts are dimensions;
   * month ownership is exclusive: a month-log destination wins, otherwise the
   * entry's calendar date owns it.
   */
  public getIndexAggregates(): JournalIndexAggregates {
    const collections = (
      this.db
        .prepare(
          `SELECT c.*, count(e.id) AS count
           FROM collections c
           LEFT JOIN entries e ON e.collection = c.id AND e.deleted_at IS NULL
           WHERE c.id NOT LIKE 'month:%'
           GROUP BY c.id
           ORDER BY (c.archived_at IS NOT NULL), c.name COLLATE NOCASE, c.id`,
        )
        .all() as CountedCollectionRow[]
    ).map((row) => ({ ...mapCollection(row), count: row.count }));

    const months = (
      this.db
        .prepare(
          `SELECT CASE
             WHEN substr(e.collection, 1, 6) = 'month:' THEN substr(e.collection, 7, 7)
             ELSE substr(e.date, 1, 7)
           END AS month,
           count(*) AS count
           FROM entries e
           WHERE e.deleted_at IS NULL
           GROUP BY month
           ORDER BY month DESC`,
        )
        .all() as MonthCountRow[]
    ).map((row) => ({ month: CalendarMonthSchema.parse(row.month), count: row.count }));

    const countedTypes = new Map<EntryType, number>(
      (
        this.db
          .prepare(
            `SELECT e.type AS type, count(*) AS count
           FROM entries e
           WHERE e.deleted_at IS NULL
           GROUP BY e.type`,
          )
          .all() as TypeCountRow[]
      ).map((row) => [EntryTypeSchema.parse(row.type), row.count]),
    );
    const types = (['task', 'event', 'note', 'idea', 'question', 'habit', 'mood'] as const).map(
      (type) => ({ type, count: countedTypes.get(type) ?? 0 }),
    );

    return { collections, months, types };
  }

  /** Tag vocabulary ranked by use, so capture can suggest what the owner already writes. */
  public listTags(limit = 300): readonly TagUsage[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      invalid('limit must be between 1 and 500');
    return this.db
      .prepare(
        `SELECT value AS tag, COUNT(*) AS uses, MAX(e.created_at) AS lastUsedAt
         FROM entries e, json_each(e.tags)
         WHERE e.deleted_at IS NULL
         GROUP BY value
         ORDER BY uses DESC, tag ASC
         LIMIT ?`,
      )
      .all(limit) as TagUsage[];
  }

  public getCollection(id: string): Collection | null {
    validateCollectionId(id);
    const row = this.db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as
      | CollectionRow
      | undefined;
    return row === undefined ? null : mapCollection(row);
  }

  /** Resolve only the destination labels needed by one bounded Timeline page. */
  public listCollectionsByIds(ids: readonly string[]): readonly Collection[] {
    const unique = [...new Set(ids)];
    for (const id of unique) validateCollectionId(id);
    if (unique.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT * FROM collections
           WHERE id IN (SELECT value FROM json_each(?))
           ORDER BY name COLLATE NOCASE, id`,
        )
        .all(JSON.stringify(unique)) as CollectionRow[]
    ).map(mapCollection);
  }

  public listActivity(limit = 100, offset = 0): readonly ActivityItem[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      invalid('limit must be between 1 and 500');
    if (!Number.isInteger(offset) || offset < 0) invalid('offset must be a non-negative integer');
    return (
      this.db
        .prepare('SELECT * FROM activity ORDER BY at DESC, id DESC LIMIT ? OFFSET ?')
        .all(limit, offset) as ActivityRow[]
    ).map(mapActivity);
  }

  public getActivity(id: string): ActivityItem | null {
    validateId(id);
    const row = this.db.prepare('SELECT * FROM activity WHERE id = ?').get(id) as
      | ActivityRow
      | undefined;
    return row === undefined ? null : mapActivity(row);
  }

  public activityView(activityOrId: ActivityItem | string): ActivityView {
    const activity =
      typeof activityOrId === 'string' ? this.getActivity(activityOrId) : activityOrId;
    if (activity === null)
      throw new DomainError('NOT_FOUND', `Activity ${activityOrId} was not found`);
    return this.activityViews([activity])[0]!;
  }

  public listActivityViews(limit = 100, offset = 0): readonly ActivityView[] {
    return this.activityViews(this.listActivity(limit, offset));
  }

  public listActivityPage(limit = 50, before?: ActivityPageBoundary): ActivityPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      invalid('limit must be between 1 and 100');
    if (before !== undefined) {
      if (!IsoTimestampSchema.safeParse(before.at).success) invalid('Invalid activity cursor time');
      if (before.id !== undefined) validateId(before.id);
    }
    const rows = (
      before === undefined
        ? this.db.prepare('SELECT * FROM activity ORDER BY at DESC, id DESC LIMIT ?').all(limit + 1)
        : before.id === undefined
          ? this.db
              .prepare('SELECT * FROM activity WHERE at <= ? ORDER BY at DESC, id DESC LIMIT ?')
              .all(before.at, limit + 1)
          : this.db
              .prepare(
                `SELECT * FROM activity WHERE at < ? OR (at = ? AND id < ?)
                 ORDER BY at DESC, id DESC LIMIT ?`,
              )
              .all(before.at, before.at, before.id, limit + 1)
    ) as ActivityRow[];
    return {
      items: this.activityViews(rows.slice(0, limit).map(mapActivity)),
      hasMore: rows.length > limit,
    };
  }

  private activityViews(activities: readonly ActivityItem[]): readonly ActivityView[] {
    const snapshots = activities.flatMap((activity) => activity.postImages);
    const current = new Map<string, Snapshot['row']>();
    const load = <Row>(
      entity: Snapshot['entity'],
      rows: readonly Row[],
      idOf: (row: Row) => string,
      map: (row: Row) => Snapshot['row'],
    ): void => {
      for (const row of rows) current.set(`${entity}\0${idOf(row)}`, map(row));
    };
    const ids = (entity: Snapshot['entity']): string[] => [
      ...new Set(
        snapshots.filter((snapshot) => snapshot.entity === entity).map((snapshot) => snapshot.id),
      ),
    ];
    const entryIds = ids('entry');
    if (entryIds.length > 0) {
      load(
        'entry',
        this.db
          .prepare('SELECT * FROM entries WHERE id IN (SELECT value FROM json_each(?))')
          .all(JSON.stringify(entryIds)) as EntryRow[],
        (row) => row.id,
        mapEntry,
      );
    }
    const collectionIds = ids('collection');
    if (collectionIds.length > 0) {
      load(
        'collection',
        this.db
          .prepare('SELECT * FROM collections WHERE id IN (SELECT value FROM json_each(?))')
          .all(JSON.stringify(collectionIds)) as CollectionRow[],
        (row) => row.id,
        mapCollection,
      );
    }
    const summaryIds = ids('summary');
    if (summaryIds.length > 0) {
      load(
        'summary',
        this.db
          .prepare('SELECT * FROM summaries WHERE id IN (SELECT value FROM json_each(?))')
          .all(JSON.stringify(summaryIds)) as SummaryRow[],
        (row) => row.id,
        mapSummary,
      );
    }

    return activities.map((activity) => {
      let reason: 'already_reverted' | 'post_image_mismatch' | 'not_reversible' | null = null;
      if (activity.revertedAt !== null) reason = 'already_reverted';
      else if (
        activity.kind === 'revert' ||
        activity.postImages.length === 0 ||
        activity.text.endsWith('(content expired)')
      )
        reason = 'not_reversible';
      else if (
        activity.postImages.some(
          (snapshot) =>
            !snapshotEqual(current.get(`${snapshot.entity}\0${snapshot.id}`) ?? null, snapshot.row),
        )
      ) {
        reason = 'post_image_mismatch';
      }
      return ActivityViewSchema.parse({
        ...activity,
        revert: { eligible: reason === null, reason },
      });
    });
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
    validateDate(from);
    validateDate(to);
    if (from > to) invalid('Reflection range end cannot precede its start');
    this.materializeReflectionSlots(from, to);
    const rows = this.db
      .prepare(
        `SELECT * FROM reflection_slots
         WHERE week_start <= ? AND week_end >= ? AND week_end < ?
         ORDER BY week_start DESC`,
      )
      .all(to, from, this.today()) as ReflectionSlotRow[];
    return rows.map((row) => this.mapReflectionRow(row));
  }

  public getReflection(id: string): Reflection | null {
    validateId(id);
    const row = this.db.prepare('SELECT * FROM reflection_slots WHERE id = ?').get(id) as
      | ReflectionSlotRow
      | undefined;
    return row === undefined ? null : this.mapReflectionRow(row);
  }

  public listPendingReflections(): readonly Reflection[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reflection_slots
         WHERE status IN ('queued', 'running')
         ORDER BY requested_at ASC, week_start ASC`,
      )
      .all() as ReflectionSlotRow[];
    return rows.map((row) => this.mapReflectionRow(row));
  }

  public requestReflection(
    id: string,
    actor: ActorContext,
    options: { readonly expectedRevision: number },
  ): { readonly reflection: Reflection; readonly activityId: string } {
    return this.queueReflection('request-reflection', id, actor, options, [
      'notRequested',
      'current',
      'stale',
    ]);
  }

  public retryReflection(
    id: string,
    actor: ActorContext,
    options: { readonly expectedRevision: number },
  ): { readonly reflection: Reflection; readonly activityId: string } {
    return this.queueReflection('retry-reflection', id, actor, options, ['failed']);
  }

  public claimReflection(
    weekStart: string,
    requestId: string,
    actor: ActorContext,
    mutation?: MutationContext,
  ): { readonly kind: 'reflection'; readonly reflection: Reflection; readonly activityId: string } {
    if (actor.kind !== 'agent') invalid('Only an authenticated assistant can claim a Reflection');
    validateDate(weekStart);
    validateId(requestId);
    return this.write('claim-reflection', { weekStart, requestId }, actor, mutation, (context) => {
      const before = this.requireReflectionForWeek(weekStart);
      if (before.status !== 'queued' || before.requestId !== requestId) {
        throw new DomainError('CONFLICT', 'Reflection request is no longer queued');
      }
      this.db
        .prepare(
          `UPDATE reflection_slots SET
              status='running', claimed_at=?, claimed_token_id=?, claimed_label=?, claimed_tool=?,
              failure=NULL, updated_at=?, revision=revision+1
             WHERE id=?`,
        )
        .run(
          context.now,
          actor.tokenId,
          actor.tokenLabel,
          actor.tool ?? null,
          context.now,
          before.id,
        );
      const reflection = this.requireReflection(before.id);
      context.changes.push(reflectionChange(reflection));
      const activity = this.insertActivity(
        {
          kind: 'summary-filed',
          text: `Claimed weekly Reflection for ${weekStart}`,
          refs: { ...actorRefs(actor, []), summaryId: reflection.id },
          preImages: [],
          postImages: [],
        },
        actor,
        context,
      );
      return { kind: 'reflection', reflection, activityId: activity.id };
    });
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
    if (actor.kind !== 'agent')
      invalid('Only an authenticated assistant can complete a Reflection');
    validateDate(input.weekStart);
    validateId(input.requestId);
    const text = normalizeText(input.text, 500, 'reflection text');
    const source = normalizeSource(input.source);
    return this.write('complete-reflection', input, actor, mutation, (context) => {
      const before = this.requireReflectionForWeek(input.weekStart);
      if (
        before.status !== 'running' ||
        before.requestId !== input.requestId ||
        before.claimedBy?.tokenId !== actor.tokenId
      ) {
        throw new DomainError('CONFLICT', 'Reflection request is not claimed by this assistant');
      }
      const sourceEntries = this.reflectionSourceEntries(before.weekStart, before.weekEnd);
      const versionId = this.idFactory();
      const versionNumber = (before.versions[0]?.number ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO reflection_versions(
            id,reflection_id,version_number,text,source_from,source_to,generator_token_id,
            generator_label,generator_tool,source,generated_at,source_entries
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          versionId,
          before.id,
          versionNumber,
          text,
          before.weekStart,
          before.weekEnd,
          actor.tokenId,
          actor.tokenLabel,
          actor.tool ?? null,
          source,
          context.now,
          JSON.stringify(sourceEntries),
        );
      this.db
        .prepare(
          `UPDATE reflection_slots SET
            status='current', request_id=NULL, requested_at=NULL, claimed_at=NULL,
            claimed_token_id=NULL, claimed_label=NULL, claimed_tool=NULL, failure=NULL,
            current_version_id=?, updated_at=?, revision=revision+1
           WHERE id=?`,
        )
        .run(versionId, context.now, before.id);
      const reflection = this.requireReflection(before.id);
      context.changes.push(reflectionChange(reflection));
      const activity = this.insertActivity(
        {
          kind: 'summary-filed',
          text: `Completed weekly Reflection for ${before.weekStart}`,
          refs: {
            ...actorRefs(
              actor,
              sourceEntries.map((entry) => entry.id),
            ),
            summaryId: before.id,
          },
          preImages: [],
          postImages: [],
        },
        actor,
        context,
      );
      return { kind: 'reflection', reflection, activityId: activity.id };
    });
  }

  public failReflection(
    input: { readonly weekStart: string; readonly requestId: string; readonly reason: string },
    actor: ActorContext,
    mutation?: MutationContext,
  ): { readonly kind: 'reflection'; readonly reflection: Reflection; readonly activityId: string } {
    if (actor.kind !== 'agent') invalid('Only an authenticated assistant can fail a Reflection');
    validateDate(input.weekStart);
    validateId(input.requestId);
    const reason = normalizeText(input.reason, 500, 'reflection failure');
    return this.write('fail-reflection', input, actor, mutation, (context) => {
      const before = this.requireReflectionForWeek(input.weekStart);
      if (
        before.status !== 'running' ||
        before.requestId !== input.requestId ||
        before.claimedBy?.tokenId !== actor.tokenId
      ) {
        throw new DomainError('CONFLICT', 'Reflection request is not claimed by this assistant');
      }
      this.db
        .prepare(
          `UPDATE reflection_slots SET
            status='failed', claimed_at=NULL, claimed_token_id=NULL, claimed_label=NULL,
            claimed_tool=NULL, failure=?, updated_at=?, revision=revision+1
           WHERE id=?`,
        )
        .run(reason, context.now, before.id);
      const reflection = this.requireReflection(before.id);
      context.changes.push(reflectionChange(reflection));
      const activity = this.insertActivity(
        {
          kind: 'summary-filed',
          text: `Weekly Reflection failed for ${before.weekStart}: ${truncateForActivity(reason)}`,
          refs: { ...actorRefs(actor, []), summaryId: before.id },
          preImages: [],
          postImages: [],
        },
        actor,
        context,
      );
      return { kind: 'reflection', reflection, activityId: activity.id };
    });
  }

  public restoreReflectionVersion(
    id: string,
    versionId: string,
    actor: ActorContext,
    options: { readonly expectedRevision: number },
  ): { readonly reflection: Reflection; readonly activityId: string } {
    validateId(id);
    validateId(versionId);
    return this.write(
      'restore-reflection-version',
      { id, versionId, expectedRevision: options.expectedRevision },
      actor,
      undefined,
      (context) => {
        const before = this.requireReflection(id);
        this.assertExpectedReflectionRevision(before, options.expectedRevision);
        const version = before.versions.find((candidate) => candidate.id === versionId);
        if (!version) throw new DomainError('NOT_FOUND', 'Reflection version was not found');
        const current = this.reflectionVersionIsCurrent(version);
        this.db
          .prepare(
            `UPDATE reflection_slots SET
              status=?, request_id=NULL, requested_at=NULL, claimed_at=NULL,
              claimed_token_id=NULL, claimed_label=NULL, claimed_tool=NULL, failure=NULL,
              current_version_id=?, updated_at=?, revision=revision+1
             WHERE id=?`,
          )
          .run(current ? 'current' : 'stale', version.id, context.now, before.id);
        const reflection = this.requireReflection(id);
        context.changes.push(reflectionChange(reflection));
        const activity = this.insertActivity(
          {
            kind: 'summary-filed',
            text: `Restored Reflection version ${version.number} for ${before.weekStart}`,
            refs: {
              ...actorRefs(
                actor,
                version.sourceEntries.map((entry) => entry.id),
              ),
              summaryId: before.id,
            },
            preImages: [],
            postImages: [],
          },
          actor,
          context,
        );
        return { reflection, activityId: activity.id };
      },
    );
  }

  public createEntry(
    input: CreateEntryInput,
    actor: ActorContext,
    mutation?: MutationContext,
  ): EntryWriteResult {
    const normalized = normalizeCreateEntry(input, actor, this.today(), this.idFactory);
    if (
      actor.kind === 'agent' &&
      input.reflectionAction !== undefined &&
      input.reflectionRequestId !== undefined &&
      input.summaryWeekStart !== undefined
    ) {
      switch (input.reflectionAction) {
        case 'claim':
          return this.claimReflection(
            input.summaryWeekStart,
            input.reflectionRequestId,
            actor,
            mutation,
          );
        case 'complete':
          return this.completeReflection(
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
          return this.failReflection(
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

    const createIntent = { ...normalized, id: input.id ?? null };
    return this.write('create-entry', createIntent, actor, mutation, (context) => {
      const existing = this.selectEntry(normalized.id, true);
      if (existing !== null) {
        if (sameCreateIntent(existing, normalized)) return { kind: 'entry', entry: existing };
        throw new DomainError(
          'CONFLICT',
          `Entry id ${normalized.id} already exists with different content`,
        );
      }
      if (normalized.collection !== null)
        this.ensureCollection(normalized.collection, context.now, context);
      const entry = this.insertEntry(normalized, context.now);
      context.changes.push(entryCreatedChange(entry));
      if (actor.kind !== 'agent') return { kind: 'entry', entry };
      const activity = this.insertActivity(
        {
          kind: 'agent-add',
          text: `Added “${truncateForActivity(entry.text)}” — ${entry.source ?? 'assistant source'}`,
          refs: actorRefs(actor, [entry.id]),
          preImages: [{ entity: 'entry', id: entry.id, row: null }],
          postImages: [snapshotEntry(entry)],
        },
        actor,
        context,
      );
      return { kind: 'entry', entry, activityId: activity.id };
    });
  }

  public updateEntry(
    id: string,
    patch: EntryPatch,
    actor: ActorContext,
    mutation?: MutationContext,
    options: { expectedRevision?: number; reason?: string } = {},
  ): { readonly entry: Entry; readonly activityId?: string } {
    validateId(id);
    if (Object.keys(patch).length === 0) invalid('Entry patch must contain at least one field');
    requireAgentExpectedRevision(actor, options.expectedRevision);
    return this.write('update-entry', { id, patch, ...options }, actor, mutation, (context) => {
      const before = this.requireLiveEntry(id);
      assertExpectedRevision(before, options.expectedRevision);
      // Filing an entry into a collection moves it; it does not recapture it.
      // Only an explicit date patch re-dates an entry.
      const next = normalizePatchedEntry(before, patch);
      if (next.collection !== null) this.ensureCollection(next.collection, context.now, context);
      const entry = this.replaceEntry(next, context.now);
      context.changes.push(upsertChange('entry', entry));
      const activity = this.maybeRecordEntryActivity(
        actor,
        'agent-update',
        `Updated “${truncateForActivity(entry.text)}”`,
        before,
        entry,
        context,
        options.reason,
      );
      return activity === null ? { entry } : { entry, activityId: activity.id };
    });
  }

  public toggleEntry(
    id: string,
    actor: ActorContext,
    mutation?: MutationContext,
  ): { readonly entry: Entry; readonly activityId?: string } {
    const before = this.requireEntry(id);
    if (before.type !== 'task' && before.type !== 'habit')
      invalid('Only tasks and habits can be toggled');
    if (before.state !== 'open' && before.state !== 'done') {
      throw new DomainError('CONFLICT', `Entry in ${before.state} state cannot be toggled`);
    }
    return this.updateEntry(
      id,
      { state: before.state === 'open' ? 'done' : 'open' },
      actor,
      mutation,
    );
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
    validateId(id);
    validateId(input.newEntryId);
    if (input.targetDate !== undefined) validateDate(input.targetDate);
    return this.write('migrate-entry', { id, ...input }, actor, mutation, (context) => {
      const before = this.requireLiveEntry(id);
      assertActionableOpen(before, 'migrate');
      assertExpectedRevision(before, input.expectedRevision);
      if (this.selectEntry(input.newEntryId, true) !== null) {
        throw new DomainError('CONFLICT', `Entry id ${input.newEntryId} already exists`);
      }
      const original = this.replaceEntry({ ...before, state: 'migrated' }, context.now);
      const copy = this.insertEntry(
        {
          id: input.newEntryId,
          date: input.targetDate ?? this.today(),
          type: before.type,
          text: before.text,
          state: 'open',
          time: before.time,
          tags: before.tags,
          author: before.author,
          source: before.source,
          migrations: before.migrations + 1,
          collection: null,
        },
        context.now,
      );
      context.changes.push(upsertChange('entry', original), entryCreatedChange(copy));
      const activity = this.maybeRecordActivity(
        actor,
        'agent-migration',
        `Moved “${truncateForActivity(before.text)}” forward`,
        actorRefs(actor, [original.id, copy.id]),
        [snapshotEntry(before), { entity: 'entry', id: copy.id, row: null }],
        [snapshotEntry(original), snapshotEntry(copy)],
        context,
      );
      return activity === null ? { original, copy } : { original, copy, activityId: activity.id };
    });
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
    validateId(id);
    validateId(input.copyId);
    const month = input.month ?? this.today().slice(0, 7);
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) invalid('month must be YYYY-MM');
    return this.write('schedule-monthly', { id, ...input, month }, actor, mutation, (context) => {
      const before = this.requireLiveEntry(id);
      assertActionableOpen(before, 'schedule');
      assertExpectedRevision(before, input.expectedRevision);
      if (this.selectEntry(input.copyId, true) !== null) {
        throw new DomainError('CONFLICT', `Entry id ${input.copyId} already exists`);
      }
      const collectionId = `month:${month}`;
      const collection = this.ensureCollection(collectionId, context.now, context);
      const original = this.replaceEntry({ ...before, state: 'scheduled' }, context.now);
      const copy = this.insertEntry(
        {
          id: input.copyId,
          date: this.today(),
          type: before.type,
          text: before.text,
          state: 'open',
          time: before.time,
          tags: before.tags,
          author: before.author,
          source: before.source,
          migrations: before.migrations,
          collection: collectionId,
        },
        context.now,
      );
      context.changes.push(upsertChange('entry', original), entryCreatedChange(copy));
      const activity = this.maybeRecordActivity(
        actor,
        'agent-migration',
        `Scheduled “${truncateForActivity(before.text)}” for ${month}`,
        actorRefs(actor, [original.id, copy.id]),
        [snapshotEntry(before), { entity: 'entry', id: copy.id, row: null }],
        [snapshotEntry(original), snapshotEntry(copy)],
        context,
      );
      return activity === null
        ? { original, copy, collection }
        : { original, copy, collection, activityId: activity.id };
    });
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
    validateId(id);
    if (collectionId !== null) validateCollectionId(collectionId);
    if (options.filingDate !== undefined) validateDate(options.filingDate);
    return this.write(
      'file-entry',
      { id, collectionId, ...options },
      actor,
      mutation,
      (context) => {
        const before = this.requireLiveEntry(id);
        assertExpectedRevision(before, options.expectedRevision);
        const collection =
          collectionId === null
            ? undefined
            : this.ensureCollection(collectionId, context.now, context);
        const entry = this.replaceEntry(
          {
            ...before,
            collection: collectionId,
            date: options.filingDate ?? (collectionId === null ? before.date : this.today()),
          },
          context.now,
        );
        context.changes.push(upsertChange('entry', entry));
        const activity = this.maybeRecordEntryActivity(
          actor,
          'agent-update',
          collectionId === null
            ? `Returned “${truncateForActivity(entry.text)}” to the daily log`
            : `Filed “${truncateForActivity(entry.text)}” in ${collectionId}`,
          before,
          entry,
          context,
          options.reason,
        );
        return {
          entry,
          ...(collection === undefined ? {} : { collection }),
          ...(activity === null ? {} : { activityId: activity.id }),
        };
      },
    );
  }

  public deleteEntry(
    id: string,
    actor: ActorContext,
    mutation?: MutationContext,
    options: { readonly expectedRevision?: number; readonly reason?: string } = {},
  ): { readonly entry: Entry; readonly activityId?: string } {
    validateId(id);
    requireAgentExpectedRevision(actor, options.expectedRevision);
    return this.write('delete-entry', { id, ...options }, actor, mutation, (context) => {
      const before = this.requireLiveEntry(id);
      assertExpectedRevision(before, options.expectedRevision);
      const entry = this.replaceEntry({ ...before, deletedAt: context.now }, context.now);
      context.changes.push(upsertChange('entry', entry));
      const activity = this.maybeRecordEntryActivity(
        actor,
        'agent-delete',
        `Deleted “${truncateForActivity(before.text)}”`,
        before,
        entry,
        context,
        options.reason,
      );
      return activity === null ? { entry } : { entry, activityId: activity.id };
    });
  }

  public restoreEntry(
    id: string,
    actor: ActorContext,
    mutation?: MutationContext,
    options: { readonly expectedRevision?: number } = {},
  ): {
    readonly entry: Entry;
    readonly activityId?: string;
    readonly fallbackFromCollection?: string;
  } {
    validateId(id);
    return this.write('restore-entry', { id, ...options }, actor, mutation, (context) => {
      const before = this.selectEntry(id, true);
      if (before === null || before.deletedAt === null) {
        throw new DomainError('NOT_FOUND', `Deleted entry ${id} was not found`);
      }
      const recoveryCutoff = this.now().getTime() - 30 * 86_400_000;
      if (Date.parse(before.deletedAt) < recoveryCutoff) {
        throw new DomainError('CONFLICT', 'The 30-day recovery window for this entry has expired');
      }
      assertExpectedRevision(before, options.expectedRevision);
      let collection = before.collection;
      let fallbackFromCollection: string | undefined;
      if (collection !== null) {
        const existingCollection = this.getCollection(collection);
        if (existingCollection === null && !collection.startsWith('month:')) {
          fallbackFromCollection = collection;
          collection = null;
        } else {
          this.ensureCollection(collection, context.now, context);
        }
      }
      const entry = this.replaceEntry({ ...before, collection, deletedAt: null }, context.now);
      context.changes.push(upsertChange('entry', entry));
      const activity = this.maybeRecordEntryActivity(
        actor,
        'agent-update',
        `Restored “${truncateForActivity(entry.text)}”`,
        before,
        entry,
        context,
      );
      return {
        entry,
        ...(activity === null ? {} : { activityId: activity.id }),
        ...(fallbackFromCollection === undefined ? {} : { fallbackFromCollection }),
      };
    });
  }

  public createCollection(
    input: { readonly id: string; readonly name: string; readonly note?: string | null },
    actor: ActorContext,
    mutation?: MutationContext,
  ): Collection {
    const normalized = normalizeCollectionInput(input);
    if (normalized.id.startsWith('month:')) invalid('Month collections are created automatically');
    return this.write('create-collection', normalized, actor, mutation, (context) => {
      const existing = this.getCollection(normalized.id);
      if (existing !== null) {
        const collection = this.updateCollectionRow(
          { ...existing, name: normalized.name, note: normalized.note, archivedAt: null },
          context.now,
        );
        context.changes.push(upsertChange('collection', collection));
        return collection;
      }
      const collection: Collection = {
        ...normalized,
        createdAt: context.now,
        archivedAt: null,
      };
      this.db
        .prepare(
          `INSERT INTO collections(id, name, note, created_at, updated_at, archived_at)
           VALUES (@id, @name, @note, @createdAt, @createdAt, @archivedAt)`,
        )
        .run(collection);
      context.changes.push(upsertChange('collection', collection));
      return collection;
    });
  }

  public updateCollection(
    id: string,
    patch: { readonly name?: string; readonly note?: string | null; readonly archived?: boolean },
    actor: ActorContext,
    mutation?: MutationContext,
  ): Collection {
    validateCollectionId(id);
    if (Object.keys(patch).length === 0) invalid('Collection patch must not be empty');
    return this.write('update-collection', { id, patch }, actor, mutation, (context) => {
      const before = this.getCollection(id);
      if (before === null) throw new DomainError('NOT_FOUND', `Collection ${id} was not found`);
      if (patch.archived !== undefined && id.startsWith('month:'))
        invalid('Month collections cannot be archived');
      const name = patch.name === undefined ? before.name : validateCollectionName(patch.name);
      const note =
        patch.note === undefined
          ? before.note
          : normalizeOptionalLine(patch.note, 300, 'collection note');
      const collection = this.updateCollectionRow(
        {
          ...before,
          name,
          note,
          archivedAt:
            patch.archived === undefined ? before.archivedAt : patch.archived ? context.now : null,
        },
        context.now,
      );
      context.changes.push(upsertChange('collection', collection));
      return collection;
    });
  }

  public archiveCollection(
    id: string,
    archived: boolean,
    actor: ActorContext,
    mutation?: MutationContext,
  ): Collection {
    validateCollectionId(id);
    if (id.startsWith('month:')) invalid('Month collections cannot be archived');
    return this.write('archive-collection', { id, archived }, actor, mutation, (context) => {
      const before = this.getCollection(id);
      if (before === null) throw new DomainError('NOT_FOUND', `Collection ${id} was not found`);
      const collection = this.updateCollectionRow(
        { ...before, archivedAt: archived ? context.now : null },
        context.now,
      );
      context.changes.push(upsertChange('collection', collection));
      return collection;
    });
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
              updated_at=?, revision=revision+1
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
      return { summary, activityId: activity.id };
    });
  }

  public applyAgentMigration(
    input: ApplyAgentMigrationInput,
    actor: ActorContext,
    mutation?: MutationContext,
  ): AgentMigrationResult {
    if (actor.kind !== 'agent') invalid('Agent migration requires an agent actor');
    validateAgentMigration(input);
    return this.write('agent-migration', input, actor, mutation, (context) => {
      const initial = new Map<string, Entry | null>();
      const touched = new Set<string>();
      const remember = (entryId: string): Entry | null => {
        if (!initial.has(entryId)) initial.set(entryId, this.selectEntry(entryId, true));
        return this.selectEntry(entryId, true);
      };

      for (const op of input.ops) {
        switch (op.op) {
          case 'create': {
            const normalized = normalizeCreateEntry(
              {
                text: op.entry.text,
                type: op.entry.type,
                ...(op.entry.date === undefined ? {} : { date: op.entry.date }),
                time: op.entry.time,
                tags: op.entry.tags,
                collection: op.entry.collection,
                source: op.entry.source,
              },
              actor,
              this.today(),
              this.idFactory,
            );
            if (remember(normalized.id) !== null) {
              throw new DomainError('CONFLICT', `Entry id ${normalized.id} already exists`);
            }
            if (normalized.collection !== null)
              this.ensureCollection(normalized.collection, context.now, context);
            const created = this.insertEntry(normalized, context.now);
            touched.add(created.id);
            context.changes.push(entryCreatedChange(created));
            break;
          }
          case 'update': {
            validateId(op.id);
            const before = remember(op.id);
            if (before === null || before.deletedAt !== null) {
              throw new DomainError('NOT_FOUND', `Entry ${op.id} was not found`);
            }
            assertExpectedRevision(before, op.expectedRevision);
            const next = normalizePatchedEntry(before, op.patch);
            if (next.collection !== null)
              this.ensureCollection(next.collection, context.now, context);
            const updated = this.replaceEntry(next, context.now);
            touched.add(updated.id);
            context.changes.push(upsertChange('entry', updated));
            break;
          }
          case 'delete': {
            validateId(op.id);
            const before = remember(op.id);
            if (before === null || before.deletedAt !== null) {
              throw new DomainError('NOT_FOUND', `Entry ${op.id} was not found`);
            }
            assertExpectedRevision(before, op.expectedRevision);
            const deleted = this.replaceEntry({ ...before, deletedAt: context.now }, context.now);
            touched.add(deleted.id);
            context.changes.push(upsertChange('entry', deleted));
            break;
          }
          case 'retag': {
            const from = normalizeTag(op.from);
            const to = normalizeTag(op.to);
            const rows = this.db
              .prepare(
                `SELECT e.* FROM entries e WHERE e.deleted_at IS NULL
                 AND EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value = ?)
                 ORDER BY e.date DESC, e.created_at DESC, e.id DESC`,
              )
              .all(from) as EntryRow[];
            const expectedById = new Map(
              op.sources.map((source) => [source.id, source.expectedRevision] as const),
            );
            for (const row of rows) {
              if (!expectedById.has(row.id)) {
                throw new DomainError(
                  'CONFLICT',
                  `Retag source set changed: entry ${row.id} now carries #${from}`,
                  {
                    details: {
                      reason: 'source_set_changed',
                      entryId: row.id,
                      actualRevision: row.revision,
                    },
                  },
                );
              }
            }
            for (const source of op.sources) {
              const before = remember(source.id);
              if (before === null || before.deletedAt !== null) {
                throw new DomainError('CONFLICT', `Retag source ${source.id} is no longer live`, {
                  details: {
                    reason: 'source_set_changed',
                    entryId: source.id,
                    expectedRevision: source.expectedRevision,
                    actualRevision: before?.revision ?? null,
                  },
                });
              }
              assertExpectedRevision(before, source.expectedRevision);
              if (!before.tags.includes(from)) {
                throw new DomainError(
                  'CONFLICT',
                  `Retag source ${source.id} no longer carries #${from}`,
                  {
                    details: {
                      reason: 'source_set_changed',
                      entryId: source.id,
                      expectedRevision: source.expectedRevision,
                      actualRevision: before.revision,
                    },
                  },
                );
              }
            }
            for (const row of rows) {
              const before = mapEntry(row);
              if (!initial.has(before.id)) initial.set(before.id, before);
              const tags = normalizeTags(before.tags.map((tag) => (tag === from ? to : tag)));
              const updated = this.replaceEntry({ ...before, tags }, context.now);
              touched.add(updated.id);
              context.changes.push(upsertChange('entry', updated));
            }
            break;
          }
        }
      }

      const preImages: Snapshot[] = [];
      const postImages: Snapshot[] = [];
      for (const entryId of touched) {
        preImages.push({ entity: 'entry', id: entryId, row: initial.get(entryId) ?? null });
        postImages.push({ entity: 'entry', id: entryId, row: this.selectEntry(entryId, true) });
      }
      const activity = this.insertActivity(
        {
          kind: 'agent-migration',
          text: migrationActivityText(input),
          refs: actorRefs(actor, [...touched]),
          preImages,
          postImages,
        },
        actor,
        context,
      );
      return {
        entries: [...touched].map((entryId) =>
          this.requireEntry(entryId, { includeDeleted: true }),
        ),
        activityId: activity.id,
      };
    });
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
      if (original.text.endsWith('(content expired)'))
        invalid('Expired entry content cannot be restored from activity history');
      if (original.revertedAt !== null) {
        throw new DomainError('CONFLICT', 'This activity has already been reverted');
      }
      if (original.postImages.length === 0) invalid('This activity has no reversible snapshots');

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

      const beforeRevert = original.postImages.map((snapshot) => ({
        ...snapshot,
        row: this.selectSnapshot(snapshot.entity, snapshot.id),
      })) as Snapshot[];
      const restored: Snapshot[] = [];
      for (const preImage of original.preImages) {
        restored.push(this.restoreSnapshot(preImage, context));
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
      return JournalExportV2Schema.parse({
        version: 2,
        exportedAt: this.now().toISOString(),
        journal: {
          entries: (
            this.db
              .prepare('SELECT * FROM entries WHERE deleted_at IS NULL ORDER BY created_at')
              .all() as EntryRow[]
          ).map(mapEntry),
          collections: (
            this.db
              .prepare('SELECT * FROM collections ORDER BY created_at')
              .all() as CollectionRow[]
          ).map(mapCollection),
          activity: (
            this.db.prepare('SELECT * FROM activity ORDER BY at').all() as ActivityRow[]
          ).map(mapActivity),
          summaries: (
            this.db.prepare('SELECT * FROM summaries ORDER BY week_start').all() as SummaryRow[]
          ).map(mapSummary),
          settings,
        },
        derived: {},
      });
    });
    return snapshot();
  }

  public importJournal(document: JournalExport): ImportReport {
    const journal = validateExport(document);
    const inserted = { entries: 0, collections: 0, activity: 0, summaries: 0, settings: 0 };
    const skipped = { entries: 0, collections: 0, activity: 0, summaries: 0, settings: 0 };
    const transaction = this.db.transaction(() => {
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
        else inserted.entries++;
      }
      for (const summary of journal.summaries) {
        validateSummary(summary);
        const existingRow = this.db
          .prepare('SELECT * FROM summaries WHERE id = ?')
          .get(summary.id) as SummaryRow | undefined;
        if (existingRow !== undefined) {
          assertImportMatch('summary', summary.id, mapSummary(existingRow), summary);
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
      for (const activity of journal.activity) {
        validateActivity(activity);
        const existingRow = this.db
          .prepare('SELECT * FROM activity WHERE id = ?')
          .get(activity.id) as ActivityRow | undefined;
        if (existingRow !== undefined) {
          assertImportMatch('activity', activity.id, mapActivity(existingRow), activity);
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
      const settingCount = (
        this.db.prepare('SELECT count(*) AS count FROM settings').get() as { count: number }
      ).count;
      if (settingCount > 0) {
        assertImportMatch('settings', 'singleton', this.getSettings(), {
          ...journal.settings,
          savedViews: journal.settings.savedViews ?? [],
        });
        skipped.settings++;
        return;
      }
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
    });
    transaction();
    return { inserted, skipped };
  }

  public purgeExpired(retentionDays = 30): {
    readonly entries: number;
    readonly mutations: number;
    readonly devices: number;
  } {
    if (!Number.isInteger(retentionDays) || retentionDays < 1)
      invalid('retentionDays must be a positive integer');
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    const now = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      const expiredIds = (
        this.db
          .prepare('SELECT id FROM entries WHERE deleted_at IS NOT NULL AND deleted_at < ?')
          .all(cutoff) as Array<{ id: string }>
      ).map(({ id }) => id);
      if (expiredIds.length > 0) {
        const expired = new Set(expiredIds);
        const rows = this.db
          .prepare(
            `SELECT id, kind, pre_images, post_images FROM activity
             WHERE EXISTS (
               SELECT 1 FROM json_each(activity.refs, '$.entryIds')
               WHERE value IN (SELECT value FROM json_each(?))
             )`,
          )
          .all(JSON.stringify(expiredIds)) as Array<{
          id: string;
          kind: ActivityKind;
          pre_images: string;
          post_images: string;
        }>;
        const redact = (json: string): string => {
          const snapshots = JSON.parse(json) as Snapshot[];
          return JSON.stringify(
            snapshots.map((snapshot) =>
              snapshot.entity === 'entry' && expired.has(snapshot.id)
                ? { ...snapshot, row: null }
                : snapshot,
            ),
          );
        };
        const activityLabel: Record<ActivityKind, string> = {
          'agent-add': 'Added an entry (content expired)',
          'agent-update': 'Updated an entry (content expired)',
          'agent-delete': 'Deleted an entry (content expired)',
          'agent-migration': 'Migrated entries (content expired)',
          'summary-filed': 'Filed a reflection (content expired)',
          'summary-saved': 'Saved a reflection (content expired)',
          revert: 'Reverted a change (content expired)',
        };
        const update = this.db.prepare(
          'UPDATE activity SET text = ?, pre_images = ?, post_images = ? WHERE id = ?',
        );
        for (const row of rows) {
          update.run(
            activityLabel[row.kind],
            redact(row.pre_images),
            redact(row.post_images),
            row.id,
          );
        }
      }
      return {
        entries: this.db
          .prepare('DELETE FROM entries WHERE deleted_at IS NOT NULL AND deleted_at < ?')
          .run(cutoff).changes,
        // Idempotency records are durable: DM-11/API-4 define no expiry after which a
        // caller key may silently execute again.
        mutations: 0,
        devices: this.db
          .prepare('DELETE FROM device_tokens WHERE expires_at < ? OR revoked_at < ?')
          .run(now, cutoff).changes,
      };
    });
    return transaction();
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
      this.markReflectionsStaleForEntryChanges(context);
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
    const row = this.db
      .prepare(
        `SELECT * FROM entries WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
      )
      .get(id) as EntryRow | undefined;
    return row === undefined ? null : mapEntry(row);
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
    const entry = EntrySchema.parse({
      ...input,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      deletedAt: input.deletedAt ?? null,
      revision: input.revision ?? 1,
    });
    this.db
      .prepare(
        `INSERT INTO entries(
          id,date,type,text,state,time,tags,author,source,migrations,collection,
          created_at,updated_at,deleted_at,revision
        ) VALUES (
          @id,@date,@type,@text,@state,@time,@tags,@author,@source,@migrations,@collection,
          @createdAt,@updatedAt,@deletedAt,@revision
        )`,
      )
      .run({ ...entry, tags: JSON.stringify(entry.tags) });
    return entry;
  }

  private replaceEntry(input: Entry, now: string): Entry {
    const current = this.selectEntry(input.id, true);
    if (current === null) throw new DomainError('NOT_FOUND', `Entry ${input.id} was not found`);
    const entry = EntrySchema.parse({
      ...input,
      createdAt: current.createdAt,
      updatedAt: now,
      revision: current.revision + 1,
    });
    this.db
      .prepare(
        `UPDATE entries SET
          date=@date,type=@type,text=@text,state=@state,time=@time,tags=@tags,author=@author,
          source=@source,migrations=@migrations,collection=@collection,updated_at=@updatedAt,
          deleted_at=@deletedAt,revision=@revision
         WHERE id=@id`,
      )
      .run({ ...entry, tags: JSON.stringify(entry.tags) });
    return entry;
  }

  private ensureCollection(id: string, now: string, context: WriteContext): Collection {
    validateCollectionId(id);
    const existing = this.getCollection(id);
    if (existing !== null) {
      if (existing.archivedAt === null) return existing;
      const collection = this.updateCollectionRow({ ...existing, archivedAt: null }, now);
      context.changes.push(collectionChange(collection));
      context.implicitSnapshots.push({
        pre: snapshotCollection(existing),
        post: snapshotCollection(collection),
      });
      return collection;
    }
    if (!id.startsWith('month:'))
      throw new DomainError('NOT_FOUND', `Collection ${id} was not found`);
    const month = id.slice('month:'.length);
    const collection = CollectionSchema.parse({
      id,
      name: formatMonthName(month),
      note: 'Monthly log',
      createdAt: now,
      archivedAt: null,
    });
    this.db
      .prepare(
        `INSERT INTO collections(id,name,note,created_at,updated_at,archived_at)
         VALUES (@id,@name,@note,@createdAt,@createdAt,@archivedAt)`,
      )
      .run(collection);
    context.changes.push(collectionChange(collection));
    context.implicitSnapshots.push({
      pre: { entity: 'collection', id: collection.id, row: null },
      post: snapshotCollection(collection),
    });
    return collection;
  }

  private updateCollectionRow(collectionInput: Collection, now: string): Collection {
    const collection = CollectionSchema.parse(collectionInput);
    this.db
      .prepare(
        'UPDATE collections SET name = ?, note = ?, updated_at = ?, archived_at = ? WHERE id = ?',
      )
      .run(collection.name, collection.note, now, collection.archivedAt, collection.id);
    return collection;
  }

  private materializeReflectionSlots(from: string, to: string): void {
    const today = this.today();
    const now = this.now().toISOString();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO reflection_slots(
        id,week_start,week_end,status,request_id,requested_at,claimed_at,claimed_token_id,
        claimed_label,claimed_tool,failure,current_version_id,created_at,updated_at,revision
       ) VALUES (?, ?, ?, 'notRequested', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, 1)`,
    );
    const hasSourceEntries = this.db.prepare(
      `SELECT 1 FROM entries
       WHERE date >= ? AND date <= ? AND deleted_at IS NULL
       LIMIT 1`,
    );
    const transaction = this.db.transaction(() => {
      let weekStart = mondayOf(from);
      while (weekStart <= to) {
        const weekEnd = addCalendarDays(weekStart, 6);
        if (
          weekEnd <= to &&
          weekEnd < today &&
          hasSourceEntries.get(weekStart, weekEnd) !== undefined
        ) {
          insert.run(this.idFactory(), weekStart, weekEnd, now, now);
        }
        weekStart = addCalendarDays(weekStart, 7);
      }
    });
    transaction();
  }

  private markReflectionsStaleForEntryChanges(context: WriteContext): void {
    const dates = new Set(
      context.changes.flatMap((change) => {
        if (!change.kind.startsWith('entry.')) return [];
        const parsed = EntrySchema.safeParse(change.payload);
        return parsed.success ? [parsed.data.date] : [];
      }),
    );
    if (dates.size === 0) return;
    const rows = this.db
      .prepare("SELECT * FROM reflection_slots WHERE status = 'current'")
      .all() as ReflectionSlotRow[];
    for (const row of rows) {
      if (![...dates].some((date) => date >= row.week_start && date <= row.week_end)) continue;
      this.db
        .prepare(
          `UPDATE reflection_slots
           SET status='stale', updated_at=?, revision=revision+1
           WHERE id=?`,
        )
        .run(context.now, row.id);
      const reflection = this.requireReflection(row.id);
      context.changes.push(reflectionChange(reflection));
      const summary = this.getSummaryForWeek(row.week_start);
      if (summary?.status === 'current') {
        const stale: Summary = {
          ...summary,
          status: 'stale',
          updatedAt: context.now,
          revision: summary.revision + 1,
        };
        this.updateSummaryRow(stale);
        context.changes.push(upsertChange('summary', stale));
      }
    }
  }

  private mapReflectionRow(row: ReflectionSlotRow): Reflection {
    const versions = this.db
      .prepare(
        'SELECT * FROM reflection_versions WHERE reflection_id = ? ORDER BY version_number DESC',
      )
      .all(row.id) as ReflectionVersionRow[];
    return mapReflection(row, versions);
  }

  private requireReflection(id: string): Reflection {
    const reflection = this.getReflection(id);
    if (reflection === null) throw new DomainError('NOT_FOUND', `Reflection ${id} was not found`);
    return reflection;
  }

  private requireReflectionForWeek(weekStart: string): Reflection {
    if (!isMonday(weekStart)) invalid('Reflection weekStart must be a Monday');
    const row = this.db
      .prepare('SELECT * FROM reflection_slots WHERE week_start = ?')
      .get(weekStart) as ReflectionSlotRow | undefined;
    if (!row) throw new DomainError('NOT_FOUND', `Reflection week ${weekStart} was not found`);
    return this.mapReflectionRow(row);
  }

  private assertExpectedReflectionRevision(reflection: Reflection, expectedRevision: number): void {
    if (reflection.revision !== expectedRevision) {
      throw new DomainError('CONFLICT', `Reflection changed since revision ${expectedRevision}`, {
        details: { expectedRevision, actualRevision: reflection.revision },
      });
    }
  }

  private queueReflection(
    operation: string,
    id: string,
    actor: ActorContext,
    options: { readonly expectedRevision: number },
    allowedStatuses: readonly Reflection['status'][],
  ): { readonly reflection: Reflection; readonly activityId: string } {
    if (actor.kind !== 'owner') invalid('Only the owner can request a weekly Reflection');
    validateId(id);
    return this.write(
      operation,
      { id, expectedRevision: options.expectedRevision },
      actor,
      undefined,
      (context) => {
        const before = this.requireReflection(id);
        this.assertExpectedReflectionRevision(before, options.expectedRevision);
        if (!allowedStatuses.includes(before.status)) {
          throw new DomainError('CONFLICT', `Reflection is already ${before.status}`);
        }
        const requestId = this.idFactory();
        this.db
          .prepare(
            `UPDATE reflection_slots SET
              status='queued', request_id=?, requested_at=?, claimed_at=NULL,
              claimed_token_id=NULL, claimed_label=NULL, claimed_tool=NULL, failure=NULL,
              updated_at=?, revision=revision+1
             WHERE id=?`,
          )
          .run(requestId, context.now, context.now, before.id);
        const reflection = this.requireReflection(before.id);
        context.changes.push(reflectionChange(reflection));
        const activity = this.insertActivity(
          {
            kind: 'summary-filed',
            text: `${operation === 'retry-reflection' ? 'Retried' : 'Requested'} weekly Reflection for ${before.weekStart}`,
            refs: { ...actorRefs(actor, []), summaryId: before.id },
            preImages: [],
            postImages: [],
          },
          actor,
          context,
        );
        return { reflection, activityId: activity.id };
      },
    );
  }

  private reflectionSourceEntries(
    sourceFrom: string,
    sourceTo: string,
  ): ReflectionVersion['sourceEntries'] {
    return this.db
      .prepare(
        `SELECT id, revision FROM entries
         WHERE date >= ? AND date <= ? AND deleted_at IS NULL
         ORDER BY id`,
      )
      .all(sourceFrom, sourceTo) as ReflectionVersion['sourceEntries'];
  }

  private reflectionVersionIsCurrent(version: ReflectionVersion): boolean {
    return (
      stableJson(version.sourceEntries) ===
      stableJson(this.reflectionSourceEntries(version.sourceFrom, version.sourceTo))
    );
  }

  private getSummaryForWeek(weekStart: string): Summary | null {
    const row = this.db.prepare('SELECT * FROM summaries WHERE week_start = ?').get(weekStart) as
      | SummaryRow
      | undefined;
    return row === undefined ? null : mapSummary(row);
  }

  private upsertLegacyReflection(
    summary: Summary,
    actor: Extract<ActorContext, { readonly kind: 'agent' }>,
    context: WriteContext,
  ): Reflection {
    const existingRow = this.db
      .prepare('SELECT * FROM reflection_slots WHERE week_start = ?')
      .get(summary.weekStart) as ReflectionSlotRow | undefined;
    const weekEnd = addCalendarDays(summary.weekStart, 6);
    const reflectionId = existingRow?.id ?? summary.id;
    if (existingRow === undefined) {
      this.db
        .prepare(
          `INSERT INTO reflection_slots(
            id,week_start,week_end,status,request_id,requested_at,claimed_at,claimed_token_id,
            claimed_label,claimed_tool,failure,current_version_id,created_at,updated_at,revision
           ) VALUES (?, ?, ?, 'notRequested', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, 1)`,
        )
        .run(reflectionId, summary.weekStart, weekEnd, context.now, context.now);
    }
    const versionNumber =
      (this.db
        .prepare(
          'SELECT coalesce(max(version_number), 0) FROM reflection_versions WHERE reflection_id = ?',
        )
        .pluck()
        .get(reflectionId) as number) + 1;
    const versionId = this.idFactory();
    this.db
      .prepare(
        `INSERT INTO reflection_versions(
          id,reflection_id,version_number,text,source_from,source_to,generator_token_id,
          generator_label,generator_tool,source,generated_at,source_entries
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        versionId,
        reflectionId,
        versionNumber,
        summary.text,
        summary.weekStart,
        weekEnd,
        actor.tokenId,
        actor.tokenLabel,
        actor.tool ?? null,
        summary.source,
        context.now,
        JSON.stringify(this.reflectionSourceEntries(summary.weekStart, weekEnd)),
      );
    this.db
      .prepare(
        `UPDATE reflection_slots SET
          status='current', request_id=NULL, requested_at=NULL, claimed_at=NULL,
          claimed_token_id=NULL, claimed_label=NULL, claimed_tool=NULL, failure=NULL,
          current_version_id=?, updated_at=?, revision=revision+1
         WHERE id=?`,
      )
      .run(versionId, context.now, reflectionId);
    return this.requireReflection(reflectionId);
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
    const activity = ActivityItemSchema.parse({
      id: input.id ?? this.idFactory(),
      at: context.now,
      kind: input.kind,
      text: normalizeText(input.text, 500, 'activity text'),
      origin: activityOrigin(actor),
      refs: input.refs,
      preImages: [...input.preImages, ...context.implicitSnapshots.map((snapshot) => snapshot.pre)],
      postImages: [
        ...input.postImages,
        ...context.implicitSnapshots.map((snapshot) => snapshot.post),
      ],
      revertedAt: null,
      revertedByActivityId: null,
    });
    this.db
      .prepare(
        `INSERT INTO activity(
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
    context.changes.push(activityChange(activity));
    return activity;
  }

  private maybeRecordEntryActivity(
    actor: ActorContext,
    kind: Extract<ActivityKind, 'agent-update' | 'agent-delete'>,
    text: string,
    before: Entry,
    after: Entry,
    context: WriteContext,
    reason?: string,
  ): ActivityItem | null {
    return this.maybeRecordActivity(
      actor,
      kind,
      reason === undefined ? text : `${text} — ${reason}`,
      actorRefs(actor, [after.id]),
      [snapshotEntry(before)],
      [snapshotEntry(after)],
      context,
    );
  }

  private maybeRecordActivity(
    actor: ActorContext,
    kind: ActivityKind,
    text: string,
    refs: ActivityItem['refs'],
    preImages: readonly Snapshot[],
    postImages: readonly Snapshot[],
    context: WriteContext,
  ): ActivityItem | null {
    if (actor.kind === 'owner' && !kind.startsWith('summary-') && kind !== 'revert') return null;
    return this.insertActivity({ kind, text, refs, preImages, postImages }, actor, context);
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
          updatedAt: context.now,
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
