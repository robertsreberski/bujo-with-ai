import {
  ActivityItemSchema,
  ActivitySnapshotSchema,
  ActivityViewSchema,
  AgentTokenSchema,
  CollectionSchema,
  EntrySchema,
  SettingsSchema,
  SummarySchema,
} from '@journal/server/contracts/app';

import type {
  ActivityItem,
  ActivityView,
  AgentToken,
  ChangeBatch,
  Collection,
  Entry,
  Summary,
} from '../api/types';
import type { MirrorData, OutboxItem, QueueableCommand } from './models';

function byNewestEntry(left: Entry, right: Entry): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

export function buildEntryIndexes(
  entriesById: Record<string, Entry>,
): Pick<MirrorData, 'entryIdsByDate' | 'entryIdsByCollection'> {
  const entryIdsByDate: Record<string, string[]> = {};
  const entryIdsByCollection: Record<string, string[]> = {};
  const entries = Object.values(entriesById).filter((entry) => entry.deletedAt === null);

  for (const entry of entries) {
    const index = entry.collection === null ? entryIdsByDate : entryIdsByCollection;
    const key = entry.collection ?? entry.date;
    (index[key] ??= []).push(entry.id);
  }

  for (const index of [entryIdsByDate, entryIdsByCollection]) {
    for (const ids of Object.values(index)) {
      ids.sort((leftId, rightId) => {
        const left = entriesById[leftId];
        const right = entriesById[rightId];
        if (!left || !right) return 0;
        return byNewestEntry(left, right);
      });
    }
  }

  return { entryIdsByDate, entryIdsByCollection };
}

export function activityView(activity: ActivityItem): ActivityView {
  return {
    ...activity,
    revert: {
      eligible: activity.kind !== 'revert' && activity.postImages.length > 0,
      reason:
        activity.kind === 'revert' || activity.postImages.length === 0 ? 'not_reversible' : null,
    },
  };
}

type EntryBucket = { index: 'date' | 'collection'; key: string };

function entryBucket(entry: Entry | undefined): EntryBucket | null {
  if (!entry || entry.deletedAt !== null) return null;
  return entry.collection === null
    ? { index: 'date', key: entry.date }
    : { index: 'collection', key: entry.collection };
}

/**
 * Reindexes only buckets touched by the changed rows. Unrelated bucket arrays
 * retain their identity, keeping a capture/update proportional to that bucket
 * instead of to the full downloaded journal.
 */
function upsertEntries(mirror: MirrorData, entries: Entry[]): MirrorData {
  if (entries.length === 0) return mirror;
  const changedIds = new Set(entries.map((entry) => entry.id));
  const touchedDates = new Set<string>();
  const touchedCollections = new Set<string>();
  const entriesById = { ...mirror.entriesById };

  for (const entry of entries) {
    for (const bucket of [entryBucket(mirror.entriesById[entry.id]), entryBucket(entry)]) {
      if (!bucket) continue;
      (bucket.index === 'date' ? touchedDates : touchedCollections).add(bucket.key);
    }
    entriesById[entry.id] = entry;
  }

  const updateIndex = (
    current: Record<string, string[]>,
    touched: Set<string>,
    kind: EntryBucket['index'],
  ): Record<string, string[]> => {
    if (touched.size === 0) return current;
    const next = { ...current };
    for (const key of touched) {
      const ids = (current[key] ?? []).filter((id) => !changedIds.has(id));
      for (const entry of entries) {
        const bucket = entryBucket(entry);
        if (bucket?.index === kind && bucket.key === key) ids.push(entry.id);
      }
      ids.sort((leftId, rightId) => {
        const left = entriesById[leftId];
        const right = entriesById[rightId];
        if (!left || !right) return 0;
        return byNewestEntry(left, right);
      });
      if (ids.length === 0) delete next[key];
      else next[key] = ids;
    }
    return next;
  };

  return {
    ...mirror,
    entriesById,
    entryIdsByDate: updateIndex(mirror.entryIdsByDate, touchedDates, 'date'),
    entryIdsByCollection: updateIndex(
      mirror.entryIdsByCollection,
      touchedCollections,
      'collection',
    ),
  };
}

export function applyOptimisticCommand(mirror: MirrorData, command: QueueableCommand): MirrorData {
  switch (command.kind) {
    case 'entry.create':
      return upsertEntries(mirror, [command.entry]);

    case 'entry.update': {
      const current = mirror.entriesById[command.id];
      if (!current) return mirror;
      const entry: Entry = {
        ...current,
        updatedAt: command.at,
        revision: (command.expectedRevision ?? current.revision) + 1,
      };
      if (command.patch.text !== undefined) entry.text = command.patch.text;
      if (command.patch.type !== undefined) entry.type = command.patch.type;
      if (command.patch.state !== undefined) entry.state = command.patch.state;
      if (command.patch.date !== undefined) entry.date = command.patch.date;
      if (command.patch.time !== undefined) entry.time = command.patch.time;
      if (command.patch.tags !== undefined) entry.tags = command.patch.tags;
      if (command.patch.collection !== undefined) entry.collection = command.patch.collection;
      return upsertEntries(mirror, [entry]);
    }

    case 'entry.delete': {
      const current = mirror.entriesById[command.id];
      if (!current) return mirror;
      const entry: Entry = {
        ...current,
        updatedAt: command.at,
        deletedAt: command.at,
        revision: (command.expectedRevision ?? current.revision) + 1,
      };
      return upsertEntries(mirror, [entry]);
    }

    case 'entry.migrate': {
      const current = mirror.entriesById[command.id];
      if (!current) return mirror;
      const original: Entry = {
        ...current,
        state: 'migrated',
        updatedAt: command.at,
        revision: (command.expectedRevision ?? current.revision) + 1,
      };
      return upsertEntries(mirror, [original, command.copy]);
    }

    case 'entry.schedule': {
      const current = mirror.entriesById[command.id];
      if (!current) return mirror;
      const original: Entry = {
        ...current,
        state: 'scheduled',
        updatedAt: command.at,
        revision: (command.expectedRevision ?? current.revision) + 1,
      };
      return upsertEntries(
        {
          ...mirror,
          collectionsById: {
            ...mirror.collectionsById,
            [command.collection.id]: command.collection,
          },
        },
        [original, command.copy],
      );
    }

    case 'collection.create':
      return {
        ...mirror,
        collectionsById: {
          ...mirror.collectionsById,
          [command.collection.id]: command.collection,
        },
      };

    case 'collection.update': {
      const current = mirror.collectionsById[command.id];
      if (!current) return mirror;
      const updated: Collection = {
        ...current,
        ...(command.patch.name === undefined ? {} : { name: command.patch.name }),
        ...(command.patch.note === undefined ? {} : { note: command.patch.note }),
        ...(command.patch.archived === undefined
          ? {}
          : { archivedAt: command.patch.archived ? command.at : null }),
      };
      return {
        ...mirror,
        collectionsById: { ...mirror.collectionsById, [updated.id]: updated },
      };
    }
  }
}

export function applyPendingCommands(mirror: MirrorData, outbox: OutboxItem[]): MirrorData {
  return outbox.reduce((current, item) => applyOptimisticCommand(current, item.command), mirror);
}

export function upsertServerEntry(mirror: MirrorData, entry: Entry): MirrorData {
  const current = mirror.entriesById[entry.id];
  if (current && current.revision > entry.revision) return mirror;
  return upsertEntries(mirror, [entry]);
}

export function removeServerEntry(mirror: MirrorData, id: string): MirrorData {
  const current = mirror.entriesById[id];
  if (!current) return mirror;
  const entriesById = { ...mirror.entriesById };
  delete entriesById[id];
  const bucket = entryBucket(current);
  if (!bucket) return { ...mirror, entriesById };

  const source = bucket.index === 'date' ? mirror.entryIdsByDate : mirror.entryIdsByCollection;
  const next = { ...source };
  const ids = (source[bucket.key] ?? []).filter((entryId) => entryId !== id);
  if (ids.length === 0) delete next[bucket.key];
  else next[bucket.key] = ids;

  return {
    ...mirror,
    entriesById,
    ...(bucket.index === 'date' ? { entryIdsByDate: next } : { entryIdsByCollection: next }),
  };
}

export function upsertServerCollection(mirror: MirrorData, collection: Collection): MirrorData {
  return {
    ...mirror,
    collectionsById: { ...mirror.collectionsById, [collection.id]: collection },
  };
}

export function removeServerCollection(mirror: MirrorData, id: string): MirrorData {
  if (!(id in mirror.collectionsById)) return mirror;
  const collectionsById = { ...mirror.collectionsById };
  delete collectionsById[id];
  return { ...mirror, collectionsById };
}

/** Keeps both the global-greatest summary and each loaded month projection coherent. */
export function upsertServerSummary(mirror: MirrorData, summary: Summary): MirrorData {
  const month = summary.weekStart.slice(0, 7);
  const currentMonth = mirror.summariesByMonth[month];
  const monthSummary =
    currentMonth === undefined ||
    currentMonth === null ||
    (currentMonth.id === summary.id && currentMonth.revision <= summary.revision) ||
    summary.weekStart > currentMonth.weekStart
      ? summary
      : currentMonth;
  const latestSummary =
    mirror.latestSummary === null ||
    (mirror.latestSummary.id === summary.id && mirror.latestSummary.revision <= summary.revision) ||
    summary.weekStart > mirror.latestSummary.weekStart
      ? summary
      : mirror.latestSummary;
  return {
    ...mirror,
    latestSummary,
    summariesByMonth: { ...mirror.summariesByMonth, [month]: monthSummary },
  };
}

export function removeServerSummary(mirror: MirrorData, id: string): MirrorData {
  const summariesByMonth = Object.fromEntries(
    Object.entries(mirror.summariesByMonth).map(([month, summary]) => [
      month,
      summary?.id === id ? null : summary,
    ]),
  );
  const loadedFallback =
    Object.values(summariesByMonth)
      .filter((summary): summary is Summary => summary !== null)
      .sort(
        (left, right) =>
          right.weekStart.localeCompare(left.weekStart) ||
          right.revision - left.revision ||
          right.id.localeCompare(left.id),
      )[0] ?? null;
  return {
    ...mirror,
    summariesByMonth,
    latestSummary: mirror.latestSummary?.id === id ? loadedFallback : mirror.latestSummary,
  };
}

export function upsertServerSettings(
  mirror: MirrorData,
  settings: MirrorData['settings'],
): MirrorData {
  if (mirror.settings.updatedAt > settings.updatedAt) return mirror;
  return { ...mirror, settings };
}

export function upsertActivity(mirror: MirrorData, activity: ActivityView): MirrorData {
  const activityById = { ...mirror.activityById, [activity.id]: activity };
  const activityOrder = Object.values(activityById)
    .sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id))
    .map((item) => item.id);
  return { ...mirror, activityById, activityOrder };
}

function tombstoneId(payload: unknown, entity: 'collection' | 'summary'): string | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 1 ||
    !('id' in payload)
  ) {
    return null;
  }
  const parsed = ActivitySnapshotSchema.safeParse({ entity, id: payload.id, row: null });
  return parsed.success ? parsed.data.id : null;
}

/** Applies a validated SSE transaction atomically to the normalized server mirror. */
export function applyServerChangeBatch(mirror: MirrorData, batch: ChangeBatch): MirrorData {
  let next = mirror;
  for (const change of batch.changes) {
    if (change.kind.startsWith('entry.')) {
      const parsed = EntrySchema.safeParse(change.payload);
      if (parsed.success) next = upsertServerEntry(next, parsed.data);
      continue;
    }
    if (change.kind === 'collection.changed') {
      const parsed = CollectionSchema.safeParse(change.payload);
      if (parsed.success) {
        next = upsertServerCollection(next, parsed.data);
      } else {
        const id = tombstoneId(change.payload, 'collection');
        if (id) next = removeServerCollection(next, id);
      }
      continue;
    }
    if (change.kind === 'activity.appended') {
      const view = ActivityViewSchema.safeParse(change.payload);
      if (view.success) {
        next = upsertActivity(next, view.data);
      } else {
        const item = ActivityItemSchema.safeParse(change.payload);
        if (item.success) next = upsertActivity(next, activityView(item.data));
      }
      continue;
    }
    if (change.kind === 'summary.changed') {
      const parsed = SummarySchema.safeParse(change.payload);
      if (parsed.success) {
        next = upsertServerSummary(next, parsed.data);
      } else {
        const id = tombstoneId(change.payload, 'summary');
        if (id) next = removeServerSummary(next, id);
      }
      continue;
    }
    if ((change.kind as string) === 'settings.changed') {
      const parsed = SettingsSchema.safeParse(change.payload);
      if (parsed.success) next = upsertServerSettings(next, parsed.data);
    }
  }
  return next;
}

export function applyAgentTokenChanges(tokens: AgentToken[], batch: ChangeBatch): AgentToken[] {
  let next = tokens;
  for (const change of batch.changes) {
    if ((change.kind as string) !== 'token.changed') continue;
    const parsed = AgentTokenSchema.safeParse(change.payload);
    if (!parsed.success) continue;
    const byId = new Map(next.map((token) => [token.id, token]));
    const current = byId.get(parsed.data.id);
    byId.set(parsed.data.id, current ? mergeAgentToken(current, parsed.data) : parsed.data);
    next = [...byId.values()].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  }
  return next;
}

export function mergeAgentToken(current: AgentToken, incoming: AgentToken): AgentToken {
  const newestNullableTimestamp = (left: string | null, right: string | null): string | null => {
    if (left === null) return right;
    if (right === null) return left;
    return left > right ? left : right;
  };
  return {
    ...incoming,
    lastUsedAt: newestNullableTimestamp(current.lastUsedAt, incoming.lastUsedAt),
    revokedAt: newestNullableTimestamp(current.revokedAt, incoming.revokedAt),
  };
}

export function countNotifiableChanges(batch: ChangeBatch): number {
  return batch.changes.filter((change) => change.kind !== 'activity.appended').length;
}

function currentSnapshotRow(
  mirror: MirrorData,
  snapshot: ActivityView['postImages'][number],
): unknown {
  if (snapshot.entity === 'entry') return mirror.entriesById[snapshot.id] ?? null;
  if (snapshot.entity === 'collection') return mirror.collectionsById[snapshot.id] ?? null;
  if (mirror.latestSummary?.id === snapshot.id) return mirror.latestSummary;
  return (
    Object.values(mirror.summariesByMonth).find((summary) => summary?.id === snapshot.id) ?? null
  );
}

function sameSnapshot(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Conservatively prevents a stale Review action after any local or live row change. */
export function recomputeActivityRevertEligibility(mirror: MirrorData): MirrorData {
  const activityById = Object.fromEntries(
    Object.entries(mirror.activityById).map(([id, activity]) => {
      let reason: ActivityView['revert']['reason'] = null;
      if (activity.revertedAt !== null) reason = 'already_reverted';
      else if (activity.kind === 'revert' || activity.postImages.length === 0)
        reason = 'not_reversible';
      else if (
        activity.postImages.some(
          (snapshot) => !sameSnapshot(currentSnapshotRow(mirror, snapshot), snapshot.row),
        )
      ) {
        reason = 'post_image_mismatch';
      }
      return [id, { ...activity, revert: { eligible: reason === null, reason } }];
    }),
  );
  return { ...mirror, activityById };
}
