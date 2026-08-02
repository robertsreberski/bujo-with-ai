import type Database from 'better-sqlite3';
import {
  ActivityItemSchema,
  CollectionSchema,
  EntrySchema,
  ReflectionSchema,
  ReflectionVersionSchema,
  SummarySchema,
  UlidSchema,
} from '../contracts/index.js';
import { DomainError } from './errors.js';
import type {
  ActivityItem,
  ActivityKind,
  ActorContext,
  Collection,
  EntityChange,
  Entry,
  EntryState,
  EntryType,
  MutationContext,
  Reflection,
  ReflectionVersion,
  Snapshot,
  Summary,
} from './types.js';

/**
 * Persistence rows and transaction ports shared by the extracted domain seams.
 *
 * This module is deliberately feature-neutral: feature services may depend on
 * the kernel, while the kernel never imports a feature service or the
 * JournalDomain facade.
 */
export interface EntryRow {
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

export interface CollectionRow {
  readonly id: string;
  readonly name: string;
  readonly note: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
}

export interface SummaryRow {
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

export interface ReflectionSlotRow {
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
  readonly claimed_source_entries: string | null;
  readonly failure: string | null;
  readonly current_version_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly revision: number;
}

export interface ReflectionVersionRow {
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

export interface ActivityRow {
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

export interface WriteContext {
  readonly now: string;
  readonly changes: EntityChange[];
  readonly implicitSnapshots: Array<{ readonly pre: Snapshot; readonly post: Snapshot }>;
}

export interface JournalWritePort {
  execute<T>(
    operation: string,
    input: unknown,
    actor: ActorContext,
    mutation: MutationContext | undefined,
    command: (context: WriteContext) => T,
  ): T;
}

export interface EntryPersistencePort {
  select(id: string, includeDeleted: boolean): Entry | null;
  requireLive(id: string): Entry;
  listLiveByTag(tag: string): readonly Entry[];
  insert(
    input: Omit<Entry, 'createdAt' | 'updatedAt' | 'deletedAt' | 'revision'> &
      Partial<Pick<Entry, 'createdAt' | 'updatedAt' | 'deletedAt' | 'revision'>>,
    now: string,
  ): Entry;
  replace(input: Entry, now: string): Entry;
}

export interface CollectionDestinationPort {
  get(id: string): Collection | null;
  ensure(id: string, now: string, context: WriteContext): Collection;
}

export interface RecoveryPolicyPort {
  assertRestorable(deletedAt: string, retentionDays?: number): void;
}

export interface ActivityAuditInput {
  readonly id?: string;
  readonly kind: ActivityKind;
  readonly text: string;
  readonly refs: ActivityItem['refs'];
  readonly preImages: readonly Snapshot[];
  readonly postImages: readonly Snapshot[];
}

export interface ActivityAuditPort {
  append(input: ActivityAuditInput, actor: ActorContext, context: WriteContext): ActivityItem;
  appendEntryChange(
    actor: ActorContext,
    kind: Extract<ActivityKind, 'agent-update' | 'agent-delete'>,
    text: string,
    before: Entry,
    after: Entry,
    context: WriteContext,
    reason?: string,
  ): ActivityItem | null;
  appendVisibleChange(
    actor: ActorContext,
    kind: ActivityKind,
    text: string,
    refs: ActivityItem['refs'],
    preImages: readonly Snapshot[],
    postImages: readonly Snapshot[],
    context: WriteContext,
  ): ActivityItem | null;
}

const EXPIRED_ACTIVITY_LABELS: Readonly<Record<ActivityKind, string>> = {
  'agent-add': 'Added an entry (content expired)',
  'agent-update': 'Updated an entry (content expired)',
  'agent-delete': 'Deleted an entry (content expired)',
  'agent-migration': 'Migrated entries (content expired)',
  'summary-filed': 'Filed a reflection (content expired)',
  'summary-saved': 'Saved a reflection (content expired)',
  revert: 'Reverted a change (content expired)',
};

export function expiredActivityLabel(kind: ActivityKind): string {
  return EXPIRED_ACTIVITY_LABELS[kind];
}

export function activityContentExpired(text: string): boolean {
  return text.endsWith('(content expired)');
}

export function mapEntry(row: EntryRow): Entry {
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

export function mapCollection(row: CollectionRow): Collection {
  return CollectionSchema.parse({
    id: row.id,
    name: row.name,
    note: row.note,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  });
}

export function mapSummary(row: SummaryRow): Summary {
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

export function mapReflectionVersion(row: ReflectionVersionRow): ReflectionVersion {
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

export function mapReflection(
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
    claimedSourceEntries:
      row.claimed_source_entries === null
        ? null
        : (JSON.parse(row.claimed_source_entries) as unknown),
    failure: row.failure,
    currentVersionId: row.current_version_id,
    currentVersion,
    versions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function mapActivity(row: ActivityRow): ActivityItem {
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

export function selectEntry(
  db: Database.Database,
  id: string,
  includeDeleted: boolean,
): Entry | null {
  const row = db
    .prepare(`SELECT * FROM entries WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`)
    .get(id) as EntryRow | undefined;
  return row === undefined ? null : mapEntry(row);
}

export function insertEntry(
  db: Database.Database,
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
  db.prepare(
    `INSERT INTO entries(
      id,date,type,text,state,time,tags,author,source,migrations,collection,
      created_at,updated_at,deleted_at,revision
    ) VALUES (
      @id,@date,@type,@text,@state,@time,@tags,@author,@source,@migrations,@collection,
      @createdAt,@updatedAt,@deletedAt,@revision
    )`,
  ).run({ ...entry, tags: JSON.stringify(entry.tags) });
  return entry;
}

export function replaceEntry(db: Database.Database, input: Entry, now: string): Entry {
  const current = selectEntry(db, input.id, true);
  if (current === null) throw new DomainError('NOT_FOUND', `Entry ${input.id} was not found`);
  const entry = EntrySchema.parse({
    ...input,
    createdAt: current.createdAt,
    updatedAt: now,
    revision: current.revision + 1,
  });
  db.prepare(
    `UPDATE entries SET
      date=@date,type=@type,text=@text,state=@state,time=@time,tags=@tags,author=@author,
      source=@source,migrations=@migrations,collection=@collection,updated_at=@updatedAt,
      deleted_at=@deletedAt,revision=@revision
     WHERE id=@id`,
  ).run({ ...entry, tags: JSON.stringify(entry.tags) });
  return entry;
}

export function validateId(id: string): void {
  if (!UlidSchema.safeParse(id).success) invalid('Expected a canonical ULID');
}

export function validateDate(value: string): string {
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

export function validateTime(value: string): string {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) invalid('Time must be HH:MM');
  return value;
}

export function validateCollectionId(value: string): void {
  if (!/^(?:[a-z0-9-]+|month:\d{4}-(?:0[1-9]|1[0-2]))$/.test(value) || value.length > 80) {
    invalid('Collection id must be a lowercase slug or month:YYYY-MM');
  }
}

export function normalizeText(value: string, maximum: number, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || /[\r\n]/.test(normalized)) {
    invalid(`${label} must be one line between 1 and ${maximum} characters`);
  }
  return normalized;
}

export function normalizeOptionalLine(
  value: string | null,
  maximum: number,
  label: string,
): string | null {
  if (value === null) return null;
  return normalizeText(value, maximum, label);
}

export function normalizeSource(value: string): string {
  const source = normalizeText(value, 300, 'source');
  if (source.length < 5) invalid('Agent source must contain at least 5 characters');
  return source;
}

export function normalizeTag(value: string): string {
  const tag = value.replace(/^#/, '').trim().toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(tag)) invalid('Tags use lowercase letters, digits, and hyphens');
  return tag;
}

export function normalizeTags(values: readonly string[]): string[] {
  if (values.length > 50) invalid('An entry can have at most 50 tags');
  return [...new Set(values.map(normalizeTag))];
}

export function assertExpectedRevision(entry: Entry, expected: number | undefined): void {
  if (expected !== undefined && entry.revision !== expected) {
    throw new DomainError('CONFLICT', `Entry changed since revision ${expected}`, {
      details: { expectedRevision: expected, actualRevision: entry.revision },
    });
  }
}

export function requireAgentExpectedRevision(
  actor: ActorContext,
  expected: number | undefined,
): void {
  if (actor.kind === 'agent' && expected === undefined) {
    invalid('Agent update and delete operations require expectedRevision');
  }
}

export function actorRefs(_actor: ActorContext, entryIds: readonly string[]): ActivityItem['refs'] {
  return { entryIds: [...entryIds] };
}

export function snapshotEntry(entry: Entry): Snapshot {
  return { entity: 'entry', id: entry.id, row: entry };
}

export function snapshotSummary(summary: Summary): Snapshot {
  return { entity: 'summary', id: summary.id, row: summary };
}

export function snapshotCollection(collection: Collection): Snapshot {
  return { entity: 'collection', id: collection.id, row: collection };
}

export function snapshotEqual(left: Snapshot['row'], right: Snapshot['row']): boolean {
  return stableJson(left) === stableJson(right);
}

export function upsertChange(
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

export function entryChange(entry: Entry): EntityChange {
  return { kind: entry.deletedAt === null ? 'entry.updated' : 'entry.deleted', payload: entry };
}

export function entryCreatedChange(entry: Entry): EntityChange {
  return { kind: 'entry.created', payload: entry };
}

export function collectionChange(collection: Collection | null, id?: string): EntityChange {
  if (collection !== null) return { kind: 'collection.changed', payload: collection };
  if (id === undefined) throw new Error('Removed collection changes require an id');
  return { kind: 'collection.changed', payload: { id } };
}

export function summaryChange(summary: Summary | null, id?: string): EntityChange {
  if (summary !== null) return { kind: 'summary.changed', payload: summary };
  if (id === undefined) throw new Error('Removed summary changes require an id');
  return { kind: 'summary.changed', payload: { id } };
}

export function reflectionChange(reflection: Reflection): EntityChange {
  return { kind: 'reflection.changed', payload: reflection };
}

export function activityChange(activity: ActivityItem): EntityChange {
  return { kind: 'activity.appended', payload: activity };
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

export function mondayOf(dateString: string): string {
  const date = new Date(`${validateDate(dateString)}T00:00:00Z`);
  const weekday = date.getUTCDay();
  const delta = weekday === 0 ? -6 : 1 - weekday;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function addCalendarDays(dateString: string, days: number): string {
  const date = new Date(`${validateDate(dateString)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isMonday(dateString: string): boolean {
  return new Date(`${validateDate(dateString)}T00:00:00Z`).getUTCDay() === 1;
}

export function formatMonthName(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year ?? 0, (monthNumber ?? 1) - 1, 1)),
  );
}

export function truncateForActivity(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 117)}…`;
}

export function invalid(message: string): never {
  throw new DomainError('VALIDATION_ERROR', message);
}

export function parseStringArray(json: string): string[] {
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new DomainError('INTEGRITY_ERROR', 'Invalid string array stored in the journal database');
  }
  return value;
}
