import type Database from 'better-sqlite3';
import { CalendarMonthSchema, CollectionSchema, EntryTypeSchema } from '../contracts/index.js';
import { DomainError } from './errors.js';
import {
  collectionChange,
  expiredActivityLabel,
  formatMonthName,
  invalid,
  mapCollection,
  mapEntry,
  normalizeOptionalLine,
  normalizeText,
  snapshotCollection,
  upsertChange,
  validateCollectionId,
  type CollectionRow,
  type EntryRow,
  type JournalWritePort,
  type WriteContext,
} from './kernel.js';
import type {
  ActivityKind,
  ActorContext,
  Collection,
  EntryType,
  MutationContext,
  RecentlyDeletedEntry,
  Snapshot,
  TagUsage,
} from './types.js';

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

export interface JournalIndexAggregates {
  readonly collections: ReadonlyArray<Collection & { readonly count: number }>;
  readonly months: ReadonlyArray<{ readonly month: string; readonly count: number }>;
  readonly types: ReadonlyArray<{ readonly type: EntryType; readonly count: number }>;
}

export interface CollectionRecoveryOptions {
  readonly db: Database.Database;
  readonly now: () => Date;
  readonly write: JournalWritePort;
}

/** Collection destinations plus the complete soft-delete recovery lifecycle. */
export class CollectionRecovery {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly write: JournalWritePort;

  public constructor(options: CollectionRecoveryOptions) {
    this.db = options.db;
    this.now = options.now;
    this.write = options.write;
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
            ? { collectionId, collectionName: null, status: 'missing' as const }
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

  public createCollection(
    input: { readonly id: string; readonly name: string; readonly note?: string | null },
    actor: ActorContext,
    mutation?: MutationContext,
  ): Collection {
    const normalized = normalizeCollectionInput(input);
    if (normalized.id.startsWith('month:')) invalid('Month collections are created automatically');
    return this.write.execute('create-collection', normalized, actor, mutation, (context) => {
      const existing = this.getCollection(normalized.id);
      if (existing !== null) {
        const collection = this.updateRow(
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
    return this.write.execute('update-collection', { id, patch }, actor, mutation, (context) => {
      const before = this.getCollection(id);
      if (before === null) throw new DomainError('NOT_FOUND', `Collection ${id} was not found`);
      if (patch.archived !== undefined && id.startsWith('month:'))
        invalid('Month collections cannot be archived');
      const name = patch.name === undefined ? before.name : validateCollectionName(patch.name);
      const note =
        patch.note === undefined
          ? before.note
          : normalizeOptionalLine(patch.note, 300, 'collection note');
      const collection = this.updateRow(
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
    return this.write.execute(
      'archive-collection',
      { id, archived },
      actor,
      mutation,
      (context) => {
        const before = this.getCollection(id);
        if (before === null) throw new DomainError('NOT_FOUND', `Collection ${id} was not found`);
        const collection = this.updateRow(
          { ...before, archivedAt: archived ? context.now : null },
          context.now,
        );
        context.changes.push(upsertChange('collection', collection));
        return collection;
      },
    );
  }

  /** Resolve or create a destination as part of the caller's existing write transaction. */
  public ensure(id: string, now: string, context: WriteContext): Collection {
    validateCollectionId(id);
    const existing = this.getCollection(id);
    if (existing !== null) {
      if (existing.archivedAt === null) return existing;
      const collection = this.updateRow({ ...existing, archivedAt: null }, now);
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

  public updateRow(collectionInput: Collection, now: string): Collection {
    const collection = CollectionSchema.parse(collectionInput);
    this.db
      .prepare(
        'UPDATE collections SET name = ?, note = ?, updated_at = ?, archived_at = ? WHERE id = ?',
      )
      .run(collection.name, collection.note, now, collection.archivedAt, collection.id);
    return collection;
  }

  /**
   * Purge and audit redaction intentionally share one SQLite transaction. If
   * either step fails, neither the entry deletion nor its content redaction is
   * committed.
   */
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
        const update = this.db.prepare(
          'UPDATE activity SET text = ?, pre_images = ?, post_images = ? WHERE id = ?',
        );
        for (const row of rows) {
          update.run(
            expiredActivityLabel(row.kind),
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
        // Idempotency records are durable and never silently expire.
        mutations: 0,
        devices: this.db
          .prepare('DELETE FROM device_tokens WHERE expires_at < ? OR revoked_at < ?')
          .run(now, cutoff).changes,
      };
    });
    return transaction();
  }
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
