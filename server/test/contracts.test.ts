import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ActivityItemSchema,
  AgentEntryCreateSchema,
  BootstrapResponseSchema,
  ChangeBatchSchema,
  DateIntentSchema,
  EntryPatchSchema,
  EntrySchema,
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
} from '../src/contracts/index.js';

const ENTRY_ID = '01K1A2B3C4D5E6F7G8H9J0K1M2';
const TOKEN_ID = '01K1A2B3C4D5E6F7G8H9J0K1M3';
const ACTIVITY_ID = '01K1A2B3C4D5E6F7G8H9J0K1M4';

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
  createdAt: '2026-07-31T09:00:00.000Z',
  updatedAt: '2026-07-31T09:00:00.000Z',
  revision: 1,
  deletedAt: null,
};

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
