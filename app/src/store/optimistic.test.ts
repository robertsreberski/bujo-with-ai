import { describe, expect, it } from 'vitest';

import type {
  ActivityView,
  AgentToken,
  ChangeBatch,
  Collection,
  Entry,
  Reflection,
  Settings,
  Summary,
} from '../api/types';
import type { MirrorData, OutboxItem, QueueableCommand } from './models';
import {
  applyOptimisticCommand,
  applyPendingCommands,
  applyAgentTokenChanges,
  applyServerChangeBatch,
  buildEntryIndexes,
  countNotifiableChanges,
  recomputeActivityRevertEligibility,
  removeServerEntry,
  upsertServerEntry,
} from './optimistic';

const settings: Settings = {
  density: 'comfortable',
  showTypeBadges: true,
  highlightAiEntries: true,
  updatedAt: '2026-07-31T08:00:00.000Z',
};

const reflection: Reflection = {
  id: '01K1H000000000000000000041',
  weekStart: '2026-07-20',
  weekEnd: '2026-07-26',
  status: 'notRequested',
  revision: 1,
  requestId: null,
  requestedAt: null,
  claimedAt: null,
  claimedBy: null,
  failure: null,
  currentVersionId: null,
  currentVersion: null,
  versions: [],
  createdAt: '2026-07-27T08:00:00.000Z',
  updatedAt: '2026-07-27T08:00:00.000Z',
};

function entry(patch: Partial<Entry> = {}): Entry {
  return {
    id: '01K1H000000000000000000001',
    date: '2026-07-31',
    type: 'task',
    text: 'Book the train',
    state: 'open',
    time: null,
    tags: [],
    author: 'me',
    source: null,
    migrations: 0,
    collection: null,
    createdAt: '2026-07-31T08:00:00.000Z',
    updatedAt: '2026-07-31T08:00:00.000Z',
    revision: 1,
    deletedAt: null,
    ...patch,
  };
}

function mirror(entries: Entry[] = []): MirrorData {
  return {
    entriesById: Object.fromEntries(entries.map((item) => [item.id, item])),
    entryIdsByDate: {},
    entryIdsByCollection: {},
    collectionsById: {},
    activityById: {},
    activityOrder: [],
    summariesByMonth: {},
    latestSummary: null,
    settings,
    mcpStatus: null,
    today: '2026-07-31',
    serverToday: '2026-07-31',
    timezone: 'Europe/Amsterdam',
    cursor: 'epoch:1',
    deviceId: '01K1H000000000000000000009',
  };
}

describe('optimistic command projection', () => {
  it('reapplies a dependent update idempotently after its create is acknowledged', () => {
    const created = entry();
    const create: QueueableCommand = {
      kind: 'entry.create',
      at: created.createdAt,
      entry: created,
      input: {
        id: created.id,
        text: created.text,
        type: created.type,
        time: null,
        tags: [],
        collection: null,
        dateIntent: {
          kind: 'today',
          capturedAt: created.createdAt,
          baseToday: created.date,
          timezone: 'Europe/Amsterdam',
        },
      },
    };
    const update: QueueableCommand = {
      kind: 'entry.update',
      id: created.id,
      patch: { text: 'Book the night train' },
      expectedRevision: 1,
      at: '2026-07-31T08:01:00.000Z',
    };
    const item: OutboxItem = {
      mutationId: '01K1H000000000000000000010',
      method: 'PATCH',
      path: `/api/entries/${created.id}`,
      enqueuedAt: update.at,
      command: update,
    };

    const optimistic = applyOptimisticCommand(applyOptimisticCommand(mirror(), create), update);
    const replayed = applyPendingCommands(optimistic, [item]);

    expect(replayed.entriesById[created.id]).toMatchObject({
      text: 'Book the night train',
      revision: 2,
    });
    expect(replayed.entryIdsByDate['2026-07-31']).toEqual([created.id]);
  });

  it('projects monthly scheduling into a stable copy and collection index', () => {
    const original = entry();
    const copy = entry({
      id: '01K1H000000000000000000002',
      collection: 'month:2026-08',
      migrations: original.migrations,
      revision: 1,
    });
    const collection: Collection = {
      id: 'month:2026-08',
      name: 'August 2026',
      note: 'Monthly log',
      createdAt: '2026-07-31T08:02:00.000Z',
      archivedAt: null,
    };
    const projected = applyOptimisticCommand(mirror([original]), {
      kind: 'entry.schedule',
      id: original.id,
      month: '2026-08',
      expectedRevision: 1,
      copy,
      collection,
      at: collection.createdAt,
    });

    expect(projected.entriesById[original.id]?.state).toBe('scheduled');
    expect(projected.entriesById[copy.id]?.migrations).toBe(original.migrations);
    expect(projected.entryIdsByCollection['month:2026-08']).toEqual([copy.id]);
    expect(projected.collectionsById['month:2026-08']).toEqual(collection);
  });

  it('reindexes only affected buckets in a large downloaded journal', () => {
    const entries = Array.from({ length: 10_000 }, (_, index) =>
      entry({
        id: `entry-${String(index).padStart(5, '0')}`,
        date: `2026-${String(Math.floor(index / 1_000) + 1).padStart(2, '0')}-${String(
          (index % 20) + 1,
        ).padStart(2, '0')}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
      }),
    );
    const indexes = buildEntryIndexes(Object.fromEntries(entries.map((item) => [item.id, item])));
    const base = { ...mirror(entries), ...indexes };
    const unchangedBucket = base.entryIdsByDate['2026-05-11'];
    const moving = entries[1_500]!;
    const targetDate = '2026-01-01';

    const projected = upsertServerEntry(base, {
      ...moving,
      date: targetDate,
      revision: moving.revision + 1,
      updatedAt: '2026-07-31T09:00:00.000Z',
    });

    expect(projected.entryIdsByDate['2026-02-01']).not.toContain(moving.id);
    expect(projected.entryIdsByDate[targetDate]).toContain(moving.id);
    expect(projected.entryIdsByDate['2026-05-11']).toBe(unchangedBucket);
    expect(projected.entryIdsByCollection).toBe(base.entryIdsByCollection);
    expect(projected.entryIdsByDate[targetDate]).toEqual(
      [...projected.entryIdsByDate[targetDate]!].sort(
        (leftId, rightId) =>
          projected.entriesById[rightId]!.createdAt.localeCompare(
            projected.entriesById[leftId]!.createdAt,
          ) || rightId.localeCompare(leftId),
      ),
    );

    const removed = removeServerEntry(projected, moving.id);
    expect(removed.entriesById[moving.id]).toBeUndefined();
    expect(removed.entryIdsByDate[targetDate]).not.toContain(moving.id);
    expect(removed.entryIdsByDate['2026-05-11']).toBe(unchangedBucket);
  });

  it('disables a stale revert as soon as a row changes locally', () => {
    const original = entry();
    const activity: ActivityView = {
      id: '01K1H000000000000000000003',
      at: '2026-07-31T08:00:00.000Z',
      text: 'Added the train task',
      kind: 'agent-add',
      origin: { actor: 'mcp', tokenId: '01K1H000000000000000000004', tool: 'add_entry' },
      refs: { entryIds: [original.id] },
      preImages: [{ entity: 'entry', id: original.id, row: null }],
      postImages: [{ entity: 'entry', id: original.id, row: original }],
      revertedAt: null,
      revertedByActivityId: null,
      revert: { eligible: true, reason: null },
    };
    const base = {
      ...mirror([original]),
      activityById: { [activity.id]: activity },
      activityOrder: [activity.id],
    };
    const changed = applyOptimisticCommand(base, {
      kind: 'entry.update',
      id: original.id,
      patch: { text: 'Book the sleeper train' },
      expectedRevision: 1,
      at: '2026-07-31T08:01:00.000Z',
    });

    expect(recomputeActivityRevertEligibility(changed).activityById[activity.id]?.revert).toEqual({
      eligible: false,
      reason: 'post_image_mismatch',
    });
  });

  it('applies strict tombstones and falls back to the greatest loaded summary', () => {
    const collection: Collection = {
      id: 'month:2026-08',
      name: 'August 2026',
      note: 'Monthly log',
      createdAt: '2026-07-31T08:00:00.000Z',
      archivedAt: null,
    };
    const summary: Summary = {
      id: '01K1H000000000000000000020',
      weekStart: '2026-08-03',
      text: 'A thoughtful week.',
      status: 'current',
      source: 'Weekly assistant review',
      tokenId: '01K1H000000000000000000021',
      savedEntryId: null,
      createdAt: '2026-08-09T08:00:00.000Z',
      updatedAt: '2026-08-09T08:00:00.000Z',
      revision: 1,
    };
    const olderSummary: Summary = {
      ...summary,
      id: '01K1H000000000000000000027',
      weekStart: '2026-07-27',
      createdAt: '2026-08-02T08:00:00.000Z',
      updatedAt: '2026-08-02T08:00:00.000Z',
    };
    const base = {
      ...mirror(),
      collectionsById: { [collection.id]: collection },
      summariesByMonth: { '2026-07': olderSummary, '2026-08': summary },
      latestSummary: summary,
    };
    const batch = {
      transactionId: '01K1H000000000000000000022',
      mutationId: null,
      origin: { kind: 'system' },
      changes: [
        { kind: 'collection.changed', payload: { id: collection.id } },
        { kind: 'summary.changed', payload: { id: summary.id } },
      ],
    } as ChangeBatch;

    const projected = applyServerChangeBatch(base, batch);

    expect(projected.collectionsById[collection.id]).toBeUndefined();
    expect(projected.summariesByMonth['2026-08']).toBeNull();
    expect(projected.latestSummary).toEqual(olderSummary);
  });

  it('removes only the Reflection named by a typed tombstone', () => {
    const base = {
      ...mirror(),
      reflectionsByWeek: { [reflection.weekStart]: reflection },
    };
    const removed = applyServerChangeBatch(base, {
      transactionId: '01K1H000000000000000000042',
      mutationId: null,
      origin: { kind: 'system' },
      changes: [
        {
          kind: 'reflection.changed',
          payload: { id: reflection.id, weekStart: reflection.weekStart },
        },
      ],
    } as unknown as ChangeBatch);

    expect(removed.reflectionsByWeek?.[reflection.weekStart]).toBeUndefined();

    const staleTombstone = applyServerChangeBatch(base, {
      transactionId: '01K1H000000000000000000043',
      mutationId: null,
      origin: { kind: 'system' },
      changes: [
        {
          kind: 'reflection.changed',
          payload: { id: '01K1H000000000000000000044', weekStart: reflection.weekStart },
        },
      ],
    } as unknown as ChangeBatch);
    expect(staleTombstone.reflectionsByWeek?.[reflection.weekStart]).toEqual(reflection);
  });

  it('converges settings and secret-free token metadata from SSE', () => {
    const updatedSettings: Settings = {
      ...settings,
      density: 'compact',
      updatedAt: '2026-07-31T09:00:00.000Z',
    };
    const token: AgentToken = {
      id: '01K1H000000000000000000023',
      label: 'Weekly review',
      scopes: ['journal:full'],
      createdAt: '2026-07-31T08:00:00.000Z',
      lastUsedAt: null,
      revokedAt: '2026-07-31T09:00:00.000Z',
    };
    const batch = {
      transactionId: '01K1H000000000000000000024',
      mutationId: null,
      origin: { kind: 'app', deviceId: '01K1H000000000000000000025' },
      changes: [
        { kind: 'settings.changed', payload: updatedSettings },
        { kind: 'token.changed', payload: token },
      ],
    } as unknown as ChangeBatch;

    expect(applyServerChangeBatch(mirror(), batch).settings).toEqual(updatedSettings);
    expect(applyAgentTokenChanges([], batch)).toEqual([token]);
  });

  it('counts changed journal entities instead of activity metadata in assistant bursts', () => {
    const oneAdd = {
      transactionId: '01K1H000000000000000000026',
      mutationId: null,
      origin: { kind: 'mcp' },
      changes: [
        { kind: 'entry.created', payload: {} },
        { kind: 'activity.appended', payload: {} },
      ],
    } as ChangeBatch;
    const twoAdds = {
      ...oneAdd,
      changes: [
        { kind: 'entry.created', payload: {} },
        { kind: 'activity.appended', payload: {} },
        { kind: 'entry.created', payload: {} },
        { kind: 'activity.appended', payload: {} },
      ],
    } as ChangeBatch;

    expect(countNotifiableChanges(oneAdd)).toBe(1);
    expect(countNotifiableChanges(twoAdds)).toBe(2);
  });
});
