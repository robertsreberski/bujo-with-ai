import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ActivityItemSchema,
  AgentEntryCreateSchema,
  AgentTokenScopeSchema,
  BootstrapResponseSchema,
  ChangeBatchSchema,
  DateIntentSchema,
  EntryPatchSchema,
  EntrySchema,
  JournalExportV2Schema,
  McpAddEntryInputSchema,
  McpAddToCollectionInputSchema,
  McpDeleteEntryInputSchema,
  McpListDayInputSchema,
  McpMigrationInputSchema,
  McpSearchInputSchema,
  McpUpdateEntryInputSchema,
  MigrationOperationSchema,
  OwnerEntryCreateSchema,
  SseReplayReadySchema,
  TagSchema,
  TokenCreateRequestSchema,
  TimelinePageResponseSchema,
  TimelineQuerySchema,
} from '../src/contracts/index.js';

const ENTRY_ID = '01K1A2B3C4D5E6F7G8H9J0K1M2';
const TOKEN_ID = '01K1A2B3C4D5E6F7G8H9J0K1M3';
const ACTIVITY_ID = '01K1A2B3C4D5E6F7G8H9J0K1M4';
const REFLECTION_ID = '01K1A2B3C4D5E6F7G8H9J0K1M5';
const REFLECTION_VERSION_ID = '01K1A2B3C4D5E6F7G8H9J0K1M6';
const SECOND_REFLECTION_ID = '01K1A2B3C4D5E6F7G8H9J0K1M7';
const SECOND_REFLECTION_VERSION_ID = '01K1A2B3C4D5E6F7G8H9J0K1M8';

function findUndescribedProperties(value: unknown, path = 'input'): readonly string[] {
  if (value === null || typeof value !== 'object') return [];
  const schema = value as Record<string, unknown>;
  const missing: string[] = [];
  if (schema.properties !== null && typeof schema.properties === 'object') {
    for (const [name, child] of Object.entries(schema.properties as Record<string, unknown>)) {
      const childSchema = child as Record<string, unknown>;
      if (typeof childSchema.description !== 'string') missing.push(`${path}.${name}`);
      missing.push(...findUndescribedProperties(child, `${path}.${name}`));
    }
  }
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    const alternatives = schema[keyword];
    if (Array.isArray(alternatives)) {
      alternatives.forEach((alternative, index) => {
        missing.push(...findUndescribedProperties(alternative, `${path}.${keyword}[${index}]`));
      });
    }
  }
  if (schema.items !== undefined)
    missing.push(...findUndescribedProperties(schema.items, `${path}[]`));
  return missing;
}

const entry = {
  id: ENTRY_ID,
  date: '2026-07-31',
  type: 'task' as const,
  text: 'Reply to Mira',
  state: 'open' as const,
  time: null,
  tags: ['work'],
  author: 'me' as const,
  source: null,
  migrations: 0,
  collection: null,
  dateStated: true,
  createdAt: '2026-07-31T09:00:00.000Z',
  updatedAt: '2026-07-31T09:00:00.000Z',
  revision: 1,
  deletedAt: null,
};

function reflection(
  id = REFLECTION_ID,
  versionId = REFLECTION_VERSION_ID,
  weekStart = '2026-07-27',
  weekEnd = '2026-08-02',
) {
  const version = {
    id: versionId,
    number: 1,
    text: 'A durable Reflection over the retained source revisions.',
    sourceFrom: weekStart,
    sourceTo: weekEnd,
    generator: {
      tokenId: TOKEN_ID,
      label: 'Reflection worker',
      tool: 'add_entry',
      source: 'Weekly journal Reflection requested by the owner.',
    },
    generatedAt: '2026-08-03T09:00:00.000Z',
    sourceEntries: [{ id: ENTRY_ID, revision: 1 }],
  };
  return {
    id,
    weekStart,
    weekEnd,
    status: 'current' as const,
    revision: 4,
    requestId: null,
    requestedAt: null,
    claimedAt: null,
    claimedBy: null,
    claimedSourceEntries: null,
    failure: null,
    currentVersionId: versionId,
    currentVersion: version,
    versions: [version],
    createdAt: '2026-08-03T08:00:00.000Z',
    updatedAt: '2026-08-03T09:00:00.000Z',
  };
}

function v2Export(reflections?: readonly ReturnType<typeof reflection>[]) {
  return {
    version: 2 as const,
    exportedAt: '2026-08-03T10:00:00.000Z',
    journal: {
      entries: [],
      collections: [],
      activity: [],
      summaries: [],
      settings: {
        density: 'comfortable' as const,
        showTypeBadges: true,
        highlightAiEntries: true,
        updatedAt: '2026-08-03T10:00:00.000Z',
      },
    },
    ...(reflections === undefined
      ? {}
      : { derived: { reflections: { version: 1 as const, items: reflections } } }),
  };
}

describe('journal entity contracts', () => {
  it('accepts a canonical entry and rejects unknown properties', () => {
    expect(EntrySchema.parse(entry)).toEqual(entry);
    expect(EntrySchema.safeParse({ ...entry, forged: true }).success).toBe(false);
  });

  it('enforces legal type/state combinations', () => {
    expect(EntrySchema.safeParse({ ...entry, type: 'note', state: 'open' }).success).toBe(false);
    expect(EntrySchema.safeParse({ ...entry, type: 'task', state: 'logged' }).success).toBe(false);
    expect(EntrySchema.safeParse({ ...entry, type: 'note', state: 'logged' }).success).toBe(true);
  });

  it('requires provenance for AI-authored entries', () => {
    expect(EntrySchema.safeParse({ ...entry, author: 'ai' }).success).toBe(false);
    expect(
      EntrySchema.safeParse({ ...entry, author: 'ai', source: 'From an owner-authorized email.' })
        .success,
    ).toBe(true);
  });

  it('keeps tag storage canonical', () => {
    expect(TagSchema.safeParse('work').success).toBe(true);
    expect(TagSchema.safeParse('Work').success).toBe(false);
    expect(TagSchema.safeParse('foo_bar').success).toBe(false);
  });

  it('accepts non-empty nullable patches and rejects empty patches', () => {
    expect(EntryPatchSchema.safeParse({ time: null, collection: null }).success).toBe(true);
    expect(EntryPatchSchema.safeParse({}).success).toBe(false);
  });

  it('prevents clients from forging server-owned entry fields', () => {
    const request = {
      id: ENTRY_ID,
      text: 'Reply to Mira',
      type: 'task',
      time: null,
      tags: ['work'],
      collection: null,
      dateIntent: {
        kind: 'today',
        capturedAt: '2026-07-31T10:00:00.000+02:00',
        baseToday: '2026-07-31',
        timezone: 'Europe/Amsterdam',
      },
    };
    expect(OwnerEntryCreateSchema.safeParse(request).success).toBe(true);
    expect(OwnerEntryCreateSchema.safeParse({ ...request, author: 'me' }).success).toBe(false);
    expect(
      OwnerEntryCreateSchema.parse({
        id: request.id,
        text: request.text,
        dateIntent: request.dateIntent,
      }),
    ).toMatchObject({ type: 'task', time: null, tags: [], collection: null });
  });

  it('requires an absolute date only for absolute date intent', () => {
    const context = {
      capturedAt: '2026-07-31T10:00:00.000+02:00',
      baseToday: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    };
    expect(DateIntentSchema.safeParse({ kind: 'tomorrow', ...context }).success).toBe(true);
    expect(DateIntentSchema.safeParse({ kind: 'absolute', ...context }).success).toBe(false);
    expect(
      DateIntentSchema.safeParse({ kind: 'absolute', date: '2026-08-04', ...context }).success,
    ).toBe(true);
  });
});

describe('autonomous write contracts', () => {
  it('requires compare-and-set revisions for direct MCP mutations', () => {
    const update = {
      id: ENTRY_ID,
      patch: { text: 'Changed' },
      reason: 'Keep the mutation attributable.',
    };
    const remove = {
      id: ENTRY_ID,
      reason: 'Remove the obsolete journal entry.',
    };
    expect(McpUpdateEntryInputSchema.safeParse(update).success).toBe(false);
    expect(McpUpdateEntryInputSchema.safeParse({ ...update, expectedRevision: 1 }).success).toBe(
      true,
    );
    expect(McpDeleteEntryInputSchema.safeParse(remove).success).toBe(false);
    expect(McpDeleteEntryInputSchema.safeParse({ ...remove, expectedRevision: 1 }).success).toBe(
      true,
    );
  });

  it('accepts least-privilege token scopes while defaulting legacy creation to full access', () => {
    expect(TokenCreateRequestSchema.parse({ label: 'Legacy assistant' }).scopes).toEqual([
      'journal:full',
    ]);
    expect(
      TokenCreateRequestSchema.parse({
        label: 'Timeline reader',
        scopes: ['timeline:read'],
      }).scopes,
    ).toEqual(['timeline:read']);
    expect(AgentTokenScopeSchema.safeParse('preview:write').success).toBe(true);
    expect(AgentTokenScopeSchema.safeParse('journal:everything').success).toBe(false);
    expect(
      TokenCreateRequestSchema.safeParse({
        label: 'Duplicate scope',
        scopes: ['entry:write', 'entry:write'],
      }).success,
    ).toBe(false);
  });

  it('describes every named MCP tool parameter, including nested patches and migration ops', () => {
    const inputs = [
      McpAddEntryInputSchema,
      McpAddToCollectionInputSchema,
      McpListDayInputSchema,
      McpSearchInputSchema,
      McpUpdateEntryInputSchema,
      McpDeleteEntryInputSchema,
      McpMigrationInputSchema,
      AgentEntryCreateSchema,
      EntryPatchSchema,
    ];
    for (const input of inputs) {
      expect(findUndescribedProperties(z.toJSONSchema(input))).toEqual([]);
    }
  });

  it('requires revisions for targeted migration operations', () => {
    expect(
      MigrationOperationSchema.safeParse({
        op: 'update',
        id: ENTRY_ID,
        patch: { text: 'Changed' },
      }).success,
    ).toBe(false);
    expect(
      MigrationOperationSchema.safeParse({
        op: 'update',
        id: ENTRY_ID,
        expectedRevision: 1,
        patch: { text: 'Changed' },
      }).success,
    ).toBe(true);
    expect(
      MigrationOperationSchema.safeParse({ op: 'retag', from: 'old', to: 'new' }).success,
    ).toBe(false);
    expect(
      MigrationOperationSchema.safeParse({
        op: 'retag',
        from: 'old',
        to: 'new',
        sources: [{ id: ENTRY_ID, expectedRevision: 1 }],
      }).success,
    ).toBe(true);
  });

  it('uses explicit, constrained weekly summary filing', () => {
    const base = {
      text: 'A concise reflection on the week.',
      type: 'note',
      tags: ['summary'],
      source: 'Weekly journal review requested by the owner.',
      summaryWeekStart: '2026-07-27',
    };
    expect(McpAddEntryInputSchema.safeParse(base).success).toBe(true);
    expect(McpAddEntryInputSchema.safeParse({ ...base, type: 'task' }).success).toBe(false);
    expect(McpAddEntryInputSchema.safeParse({ ...base, tags: [] }).success).toBe(false);
    expect(McpAddEntryInputSchema.safeParse({ ...base, date: '2026-07-31' }).success).toBe(false);
    expect(
      McpAddEntryInputSchema.safeParse({ ...base, summaryWeekStart: '2026-07-28' }).success,
    ).toBe(false);
  });

  it('lets a collection entry carry the date it belongs to', () => {
    const base = {
      collection: 'month:2026-08',
      text: 'Dentist appointment',
      type: 'event',
      source: 'From the August planning conversation.',
    };
    expect(McpAddToCollectionInputSchema.safeParse(base).success).toBe(true);
    expect(
      McpAddToCollectionInputSchema.safeParse({ ...base, date: '2026-08-26', time: '12:00' })
        .success,
    ).toBe(true);
  });

  it('keeps a dated month-log entry inside its own month', () => {
    const base = { text: 'Rent due', type: 'task', source: 'From the August planning fixture.' };
    expect(
      McpAddToCollectionInputSchema.safeParse({
        ...base,
        collection: 'month:2026-08',
        date: '2026-09-01',
      }).success,
    ).toBe(false);
    // A flat collection has no month to contradict, so any date is fair game.
    expect(
      McpAddToCollectionInputSchema.safeParse({ ...base, collection: 'ideas', date: '2026-09-01' })
        .success,
    ).toBe(true);
  });

  it('requires aligned before/after activity snapshots', () => {
    const before = { entity: 'entry' as const, id: ENTRY_ID, row: entry };
    const after = {
      entity: 'entry' as const,
      id: ENTRY_ID,
      row: { ...entry, text: 'Updated', updatedAt: '2026-07-31T09:05:00.000Z', revision: 2 },
    };
    const activity = {
      id: ACTIVITY_ID,
      at: '2026-07-31T09:05:00.000Z',
      text: 'Updated an entry',
      kind: 'agent-update',
      origin: { actor: 'mcp', tokenId: TOKEN_ID, tool: 'update_entry' },
      refs: { entryIds: [ENTRY_ID] },
      preImages: [before],
      postImages: [after],
      revertedAt: null,
      revertedByActivityId: null,
    };
    expect(ActivityItemSchema.safeParse(activity).success).toBe(true);
    expect(ActivityItemSchema.safeParse({ ...activity, postImages: [] }).success).toBe(false);
  });
});

describe('sync contracts', () => {
  it('accepts old V2 exports without Reflections and new V2 exports with full aggregates', () => {
    expect(JournalExportV2Schema.safeParse(v2Export()).success).toBe(true);
    expect(JournalExportV2Schema.safeParse(v2Export([reflection()])).success).toBe(true);
  });

  it('rejects duplicate Reflection slot ids and week starts', () => {
    const second = reflection(
      SECOND_REFLECTION_ID,
      SECOND_REFLECTION_VERSION_ID,
      '2026-07-20',
      '2026-07-26',
    );
    expect(
      JournalExportV2Schema.safeParse(v2Export([{ ...second, id: REFLECTION_ID }, reflection()]))
        .success,
    ).toBe(false);
    expect(
      JournalExportV2Schema.safeParse(
        v2Export([
          {
            ...second,
            weekStart: '2026-07-27',
            weekEnd: '2026-08-02',
            currentVersion: {
              ...second.currentVersion,
              sourceFrom: '2026-07-27',
              sourceTo: '2026-08-02',
            },
            versions: [
              {
                ...second.versions[0],
                sourceFrom: '2026-07-27',
                sourceTo: '2026-08-02',
              },
            ],
          },
          reflection(),
        ]),
      ).success,
    ).toBe(false);
  });

  it('rejects Reflection version ids reused across different slots', () => {
    const second = reflection(
      SECOND_REFLECTION_ID,
      REFLECTION_VERSION_ID,
      '2026-07-20',
      '2026-07-26',
    );
    expect(JournalExportV2Schema.safeParse(v2Export([reflection(), second])).success).toBe(false);
  });

  it('rejects a selected currentVersion that differs from its retained version', () => {
    const aggregate = reflection();
    const mismatched = {
      ...aggregate,
      currentVersion: {
        ...aggregate.currentVersion,
        text: 'A different body with the same selected version id.',
      },
    };
    expect(JournalExportV2Schema.safeParse(v2Export([mismatched])).success).toBe(false);
  });

  it('requires the selected Reflection id and representation as an exact pair for every status', () => {
    const aggregate = reflection();
    const statuses = [
      {
        status: 'notRequested' as const,
        requestId: null,
        requestedAt: null,
        claimedAt: null,
        claimedBy: null,
        claimedSourceEntries: null,
        failure: null,
      },
      {
        status: 'queued' as const,
        requestId: ACTIVITY_ID,
        requestedAt: '2026-08-03T09:10:00.000Z',
        claimedAt: null,
        claimedBy: null,
        claimedSourceEntries: null,
        failure: null,
      },
      {
        status: 'running' as const,
        requestId: ACTIVITY_ID,
        requestedAt: '2026-08-03T09:10:00.000Z',
        claimedAt: '2026-08-03T09:15:00.000Z',
        claimedBy: { tokenId: TOKEN_ID, label: 'Reflection worker' },
        claimedSourceEntries: [],
        failure: null,
      },
      {
        status: 'current' as const,
        requestId: null,
        requestedAt: null,
        claimedAt: null,
        claimedBy: null,
        claimedSourceEntries: null,
        failure: null,
      },
      {
        status: 'stale' as const,
        requestId: null,
        requestedAt: null,
        claimedAt: null,
        claimedBy: null,
        claimedSourceEntries: null,
        failure: null,
      },
      {
        status: 'failed' as const,
        requestId: ACTIVITY_ID,
        requestedAt: '2026-08-03T09:10:00.000Z',
        claimedAt: null,
        claimedBy: null,
        claimedSourceEntries: null,
        failure: 'Worker failed.',
      },
    ];
    for (const state of statuses) {
      const candidate = { ...aggregate, ...state };
      expect(JournalExportV2Schema.safeParse(v2Export([candidate])).success).toBe(true);
      expect(
        JournalExportV2Schema.safeParse(v2Export([{ ...candidate, currentVersionId: null }]))
          .success,
      ).toBe(false);
      expect(
        JournalExportV2Schema.safeParse(v2Export([{ ...candidate, currentVersion: null }])).success,
      ).toBe(false);
    }
  });

  it('rejects malformed Reflection ranges, timestamps, and duplicate source bindings', () => {
    const aggregate = reflection();
    const wrongRangeVersion = {
      ...aggregate.versions[0],
      sourceTo: '2026-08-03',
    };
    expect(
      JournalExportV2Schema.safeParse(
        v2Export([
          {
            ...aggregate,
            weekEnd: '2026-08-03',
            currentVersion: wrongRangeVersion,
            versions: [wrongRangeVersion],
          },
        ]),
      ).success,
    ).toBe(false);
    expect(
      JournalExportV2Schema.safeParse(
        v2Export([{ ...aggregate, updatedAt: '2026-08-03T07:59:59.000Z' }]),
      ).success,
    ).toBe(false);

    const duplicateSources = [
      { id: ENTRY_ID, revision: 1 },
      { id: ENTRY_ID, revision: 2 },
    ];
    const duplicateSourceVersion = {
      ...aggregate.versions[0],
      sourceEntries: duplicateSources,
    };
    expect(
      JournalExportV2Schema.safeParse(
        v2Export([
          {
            ...aggregate,
            currentVersion: duplicateSourceVersion,
            versions: [duplicateSourceVersion],
          },
        ]),
      ).success,
    ).toBe(false);
    expect(
      JournalExportV2Schema.safeParse(
        v2Export([
          {
            ...aggregate,
            status: 'running',
            requestId: ACTIVITY_ID,
            requestedAt: '2026-08-03T09:10:00.000Z',
            claimedAt: '2026-08-03T09:15:00.000Z',
            claimedBy: { tokenId: TOKEN_ID, label: 'Reflection worker' },
            claimedSourceEntries: duplicateSources,
          },
        ]),
      ).success,
    ).toBe(false);
  });

  it('bounds the extensible Timeline page and its cursor query', () => {
    expect(TimelineQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(TimelineQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(
      TimelinePageResponseSchema.safeParse({
        today: '2026-07-31',
        timezone: 'Europe/Amsterdam',
        items: [entry],
        collections: [],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      TimelinePageResponseSchema.safeParse({
        today: '2026-07-31',
        timezone: 'Europe/Amsterdam',
        items: Array.from({ length: 101 }, () => entry),
        collections: [],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it('accepts only an exact epoch-qualified replay-ready cursor', () => {
    expect(SseReplayReadySchema.safeParse({ cursor: 'epoch:7' }).success).toBe(true);
    expect(SseReplayReadySchema.safeParse({ cursor: 'epoch:7', ready: true }).success).toBe(false);
    expect(SseReplayReadySchema.safeParse({ cursor: 'not-a-cursor' }).success).toBe(false);
  });

  it('validates one post-commit change batch', () => {
    expect(
      ChangeBatchSchema.safeParse({
        transactionId: ACTIVITY_ID,
        mutationId: ENTRY_ID,
        origin: { kind: 'app', deviceId: TOKEN_ID },
        changes: [{ kind: 'entry.created', payload: entry }],
      }).success,
    ).toBe(true);
  });

  it('uses the reconciled bootstrap envelope without proposal fields', () => {
    const result = BootstrapResponseSchema.safeParse({
      entries: [entry],
      collections: [],
      latestSummary: null,
      activity: [],
      settings: {
        density: 'comfortable',
        showTypeBadges: true,
        highlightAiEntries: true,
        updatedAt: '2026-07-31T09:00:00.000Z',
      },
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
      deviceId: TOKEN_ID,
      cursor: 'epoch:0',
    });
    expect(result.success).toBe(true);
  });
});
