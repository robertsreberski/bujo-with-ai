import { EntryPatchSchema, EntrySchema, MigrationOperationSchema } from '../contracts/index.js';
import { DomainError } from './errors.js';
import {
  actorRefs,
  assertExpectedRevision,
  entryCreatedChange,
  invalid,
  normalizeSource,
  normalizeTag,
  normalizeTags,
  normalizeText,
  snapshotEntry,
  stableJson,
  truncateForActivity,
  upsertChange,
  validateCollectionId,
  validateDate,
  validateId,
  validateTime,
  requireAgentExpectedRevision,
  type ActivityAuditPort,
  type CollectionDestinationPort,
  type EntryPersistencePort,
  type JournalWritePort,
  type RecoveryPolicyPort,
} from './kernel.js';
import type {
  AgentMigrationResult,
  ApplyAgentMigrationInput,
  ActorContext,
  Collection,
  CreateEntryInput,
  Entry,
  EntryPatch,
  EntryType,
  EntryWriteResult,
  MutationContext,
  Snapshot,
} from './types.js';

export type NewEntry = Omit<Entry, 'createdAt' | 'updatedAt' | 'deletedAt' | 'revision'>;

export interface EntryCommandOptions {
  readonly today: () => string;
  readonly idFactory: () => string;
  readonly write: JournalWritePort;
  readonly entries: EntryPersistencePort;
  readonly collections: CollectionDestinationPort;
  readonly recovery: RecoveryPolicyPort;
  readonly audit: ActivityAuditPort;
}

/** Entry mutation use-cases; persistence collaborators arrive through neutral ports. */
export class EntryCommands {
  private readonly today: () => string;
  private readonly idFactory: () => string;
  private readonly write: JournalWritePort;
  private readonly entries: EntryPersistencePort;
  private readonly collections: CollectionDestinationPort;
  private readonly recovery: RecoveryPolicyPort;
  private readonly audit: ActivityAuditPort;

  public constructor(options: EntryCommandOptions) {
    this.today = options.today;
    this.idFactory = options.idFactory;
    this.write = options.write;
    this.entries = options.entries;
    this.collections = options.collections;
    this.recovery = options.recovery;
    this.audit = options.audit;
  }

  /** Normalize once in the facade before it routes legacy Reflection inputs. */
  public normalizeCreate(input: CreateEntryInput, actor: ActorContext): NewEntry {
    return normalizeCreateEntry(input, actor, this.today(), this.idFactory);
  }

  public createNormalized(
    input: CreateEntryInput,
    normalized: NewEntry,
    actor: ActorContext,
    mutation?: MutationContext,
  ): EntryWriteResult {
    const createIntent = { ...normalized, id: input.id ?? null };
    return this.write.execute('create-entry', createIntent, actor, mutation, (context) => {
      const existing = this.entries.select(normalized.id, true);
      if (existing !== null) {
        if (sameCreateIntent(existing, normalized)) return { kind: 'entry', entry: existing };
        throw new DomainError(
          'CONFLICT',
          `Entry id ${normalized.id} already exists with different content`,
        );
      }
      if (normalized.collection !== null)
        this.collections.ensure(normalized.collection, context.now, context);
      const entry = this.entries.insert(normalized, context.now);
      context.changes.push(entryCreatedChange(entry));
      if (actor.kind !== 'agent') return { kind: 'entry', entry };
      const activity = this.audit.append(
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

  public applyAgentMigration(
    input: ApplyAgentMigrationInput,
    actor: ActorContext,
    mutation?: MutationContext,
  ): AgentMigrationResult {
    if (actor.kind !== 'agent') invalid('Agent migration requires an agent actor');
    validateAgentMigration(input);
    return this.write.execute('agent-migration', input, actor, mutation, (context) => {
      const initial = new Map<string, Entry | null>();
      const touched = new Set<string>();
      const remember = (entryId: string): Entry | null => {
        if (!initial.has(entryId)) initial.set(entryId, this.entries.select(entryId, true));
        return this.entries.select(entryId, true);
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
              this.collections.ensure(normalized.collection, context.now, context);
            const created = this.entries.insert(normalized, context.now);
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
              this.collections.ensure(next.collection, context.now, context);
            const updated = this.entries.replace(next, context.now);
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
            const deleted = this.entries.replace(
              { ...before, deletedAt: context.now },
              context.now,
            );
            touched.add(deleted.id);
            context.changes.push(upsertChange('entry', deleted));
            break;
          }
          case 'retag': {
            const from = normalizeTag(op.from);
            const to = normalizeTag(op.to);
            const rows = this.entries.listLiveByTag(from);
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
            for (const before of rows) {
              if (!initial.has(before.id)) initial.set(before.id, before);
              const tags = normalizeTags(before.tags.map((tag) => (tag === from ? to : tag)));
              const updated = this.entries.replace({ ...before, tags }, context.now);
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
        postImages.push({ entity: 'entry', id: entryId, row: this.entries.select(entryId, true) });
      }
      const activity = this.audit.append(
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
        entries: [...touched].map((entryId) => {
          const entry = this.entries.select(entryId, true);
          if (entry === null)
            throw new DomainError('INTEGRITY_ERROR', `Entry ${entryId} disappeared`);
          return entry;
        }),
        activityId: activity.id,
      };
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
    return this.write.execute(
      'update-entry',
      { id, patch, ...options },
      actor,
      mutation,
      (context) => {
        const before = this.entries.requireLive(id);
        assertExpectedRevision(before, options.expectedRevision);
        // Filing into a collection moves an entry; only an explicit date patch re-dates it.
        const next = normalizePatchedEntry(before, patch);
        if (next.collection !== null)
          this.collections.ensure(next.collection, context.now, context);
        const entry = this.entries.replace(next, context.now);
        context.changes.push(upsertChange('entry', entry));
        const activity = this.audit.appendEntryChange(
          actor,
          'agent-update',
          `Updated “${truncateForActivity(entry.text)}”`,
          before,
          entry,
          context,
          options.reason,
        );
        return activity === null ? { entry } : { entry, activityId: activity.id };
      },
    );
  }

  public toggleEntry(
    id: string,
    actor: ActorContext,
    mutation?: MutationContext,
  ): { readonly entry: Entry; readonly activityId?: string } {
    validateId(id);
    const before = this.entries.requireLive(id);
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
    return this.write.execute('migrate-entry', { id, ...input }, actor, mutation, (context) => {
      const before = this.entries.requireLive(id);
      assertActionableOpen(before, 'migrate');
      assertExpectedRevision(before, input.expectedRevision);
      if (this.entries.select(input.newEntryId, true) !== null) {
        throw new DomainError('CONFLICT', `Entry id ${input.newEntryId} already exists`);
      }
      const original = this.entries.replace({ ...before, state: 'migrated' }, context.now);
      const copy = this.entries.insert(
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
      const activity = this.audit.appendVisibleChange(
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
    return this.write.execute(
      'schedule-monthly',
      { id, ...input, month },
      actor,
      mutation,
      (context) => {
        const before = this.entries.requireLive(id);
        assertActionableOpen(before, 'schedule');
        assertExpectedRevision(before, input.expectedRevision);
        if (this.entries.select(input.copyId, true) !== null) {
          throw new DomainError('CONFLICT', `Entry id ${input.copyId} already exists`);
        }
        const collectionId = `month:${month}`;
        const collection = this.collections.ensure(collectionId, context.now, context);
        const original = this.entries.replace({ ...before, state: 'scheduled' }, context.now);
        const copy = this.entries.insert(
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
        const activity = this.audit.appendVisibleChange(
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
      },
    );
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
    return this.write.execute(
      'file-entry',
      { id, collectionId, ...options },
      actor,
      mutation,
      (context) => {
        const before = this.entries.requireLive(id);
        assertExpectedRevision(before, options.expectedRevision);
        const collection =
          collectionId === null
            ? undefined
            : this.collections.ensure(collectionId, context.now, context);
        const entry = this.entries.replace(
          {
            ...before,
            collection: collectionId,
            date: options.filingDate ?? (collectionId === null ? before.date : this.today()),
          },
          context.now,
        );
        context.changes.push(upsertChange('entry', entry));
        const activity = this.audit.appendEntryChange(
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
    return this.write.execute('delete-entry', { id, ...options }, actor, mutation, (context) => {
      const before = this.entries.requireLive(id);
      assertExpectedRevision(before, options.expectedRevision);
      const entry = this.entries.replace({ ...before, deletedAt: context.now }, context.now);
      context.changes.push(upsertChange('entry', entry));
      const activity = this.audit.appendEntryChange(
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
    options: { readonly expectedRevision?: number; readonly retentionDays?: number } = {},
  ): {
    readonly entry: Entry;
    readonly activityId?: string;
    readonly fallbackFromCollection?: string;
  } {
    validateId(id);
    return this.write.execute('restore-entry', { id, ...options }, actor, mutation, (context) => {
      const before = this.entries.select(id, true);
      if (before === null || before.deletedAt === null) {
        throw new DomainError('NOT_FOUND', `Deleted entry ${id} was not found`);
      }
      this.recovery.assertRestorable(before.deletedAt, options.retentionDays);
      assertExpectedRevision(before, options.expectedRevision);
      let collection = before.collection;
      let fallbackFromCollection: string | undefined;
      if (collection !== null) {
        const existingCollection = this.collections.get(collection);
        if (existingCollection === null && !collection.startsWith('month:')) {
          fallbackFromCollection = collection;
          collection = null;
        } else {
          this.collections.ensure(collection, context.now, context);
        }
      }
      const entry = this.entries.replace({ ...before, collection, deletedAt: null }, context.now);
      context.changes.push(upsertChange('entry', entry));
      const activity = this.audit.appendEntryChange(
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
}

function normalizeCreateEntry(
  input: CreateEntryInput,
  actor: ActorContext,
  today: string,
  makeId: () => string,
): NewEntry {
  const id = input.id ?? makeId();
  validateId(id);
  const type = input.type ?? 'task';
  validateEntryType(type);
  const date = input.date ?? today;
  validateDate(date);
  if (actor.kind === 'agent') assertDateWithin(date, today, 366);
  const text = normalizeEntryText(input.text);
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
    text: patch.text === undefined ? before.text : normalizeEntryText(patch.text),
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

function normalizeEntryText(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 500 || /[\r\n]/.test(normalized)) {
    invalid('entry text must be one line between 1 and 500 characters');
  }
  return normalized;
}

function validateEntryType(value: string): asserts value is EntryType {
  if (!['task', 'event', 'note', 'idea', 'question', 'habit', 'mood'].includes(value)) {
    invalid('Unknown entry type');
  }
}

function assertDateWithin(value: string, center: string, days: number): void {
  const distance = Math.abs(Date.parse(`${value}T00:00:00Z`) - Date.parse(`${center}T00:00:00Z`));
  if (distance > days * 86_400_000) {
    invalid(`Agent entry date must be within ${days} days of server today`);
  }
}

function isActionable(type: EntryType): boolean {
  return type === 'task' || type === 'habit';
}

function assertActionableOpen(entry: Entry, operation: string): void {
  if (!isActionable(entry.type) || entry.state !== 'open') {
    throw new DomainError('CONFLICT', `Only open tasks or habits can ${operation}`);
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
