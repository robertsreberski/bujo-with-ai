import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { createDomainAdapters } from '../../src/adapters.js';
import type { OwnerActor } from '../../src/api/routes.js';
import type { JournalConfig } from '../../src/config.js';
import type { ActivityView, AgentEntry, Collection, Entry } from '../../src/contracts/index.js';
import { JournalDatabase } from '../../src/db/database.js';
import { JournalDomain } from '../../src/domain/journal.js';

const roots: string[] = [];
const domains: JournalDomain[] = [];

afterEach(() => {
  for (const domain of domains.splice(0)) domain.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(onStatement?: (sql: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'journal-adapter-test-'));
  roots.push(root);
  let instant = new Date('2026-07-31T10:00:00.000Z');
  const config: JournalConfig = {
    port: 5_178,
    bindHost: '127.0.0.1',
    dataDir: root,
    databasePath: join(root, 'journal.db'),
    backupDir: join(root, 'backups'),
    logDir: join(root, 'logs'),
    hostAllowlist: ['localhost:5178'],
    timezone: 'UTC',
    dayBoundaryOffsetMin: 0,
    deviceCookieName: 'journal_device',
    deviceCredentialTtlDays: 365,
    isDevelopment: true,
    version: 'test',
  };
  const database = new JournalDatabase({
    path: config.databasePath,
    now: () => instant,
    ...(onStatement === undefined ? {} : { onStatement }),
  });
  const domain = new JournalDomain({ database, config, now: () => instant });
  domains.push(domain);
  const owner: OwnerActor = { kind: 'owner', deviceId: ulid() };
  return {
    database,
    domain,
    owner,
    adapters: createDomainAdapters(domain, config),
    advance(milliseconds = 1_000) {
      instant = new Date(instant.getTime() + milliseconds);
    },
  };
}

function createdEntry(
  domain: JournalDomain,
  owner: OwnerActor,
  input: Parameters<JournalDomain['createEntry']>[0],
): Entry {
  const result = domain.createEntry(input, owner);
  if (result.kind !== 'entry') throw new Error('Expected an entry result.');
  return result.entry;
}

describe('HTTP and MCP domain adapters', () => {
  it('uses add_entry to claim and complete a durable Reflection request', async () => {
    const { domain, owner, adapters } = fixture();
    createdEntry(domain, owner, {
      id: ulid(),
      date: '2026-07-22',
      type: 'note',
      text: 'A bounded weekly source',
    });
    const listed = (await adapters.api.listReflections(
      { from: '2026-07-20', to: '2026-07-26' },
      owner,
    )) as { items: Array<{ id: string; revision: number; weekStart: string }> };
    const slot = listed.items[0];
    if (!slot) throw new Error('Expected Reflection slot');
    const queued = (await adapters.api.requestReflection(slot.id, slot.revision, owner)) as {
      reflection: { requestId: string; status: string };
    };
    expect(await adapters.mcp.reflectionRequests()).toMatchObject({
      items: [
        {
          id: slot.id,
          weekStart: slot.weekStart,
          status: 'queued',
          requestId: queued.reflection.requestId,
        },
      ],
    });
    const agent = {
      kind: 'agent' as const,
      tokenId: ulid(),
      tokenLabel: 'weekly helper',
      scopes: ['journal:full'] as const,
      tool: 'add_entry',
    };
    const claim = (await adapters.mcp.addEntry(
      {
        text: 'Claim weekly Reflection',
        type: 'note',
        tags: ['summary'],
        source: 'Weekly Reflection worker.',
        summaryWeekStart: slot.weekStart,
        reflectionAction: 'claim',
        reflectionRequestId: queued.reflection.requestId,
      },
      agent,
      'adapter-reflection-claim',
    )) as { kind: string; reflection: { status: string } };
    expect(claim).toMatchObject({ kind: 'reflection', reflection: { status: 'running' } });
    const complete = (await adapters.mcp.addEntry(
      {
        text: 'The bounded source shows a deliberate week.',
        type: 'note',
        tags: ['summary'],
        source: 'Bounded weekly source synthesis.',
        summaryWeekStart: slot.weekStart,
        reflectionAction: 'complete',
        reflectionRequestId: queued.reflection.requestId,
      },
      agent,
      'adapter-reflection-complete',
    )) as {
      kind: string;
      reflection: { status: string; versions: Array<{ sourceEntries: unknown[] }> };
    };
    expect(complete).toMatchObject({ kind: 'reflection', reflection: { status: 'current' } });
    expect(complete.reflection.versions[0]?.sourceEntries).toHaveLength(1);
    expect(await adapters.mcp.reflectionRequests()).toEqual({ items: [] });
  });

  it('creates least-privilege tokens through the owner API adapter', async () => {
    const { domain, owner, adapters } = fixture();
    const issued = (await adapters.api.createToken(
      'timeline reader',
      ['timeline:read'],
      owner,
    )) as {
      token: { scopes: string[] };
      secret: string;
    };
    expect(issued.token.scopes).toEqual(['timeline:read']);
    expect(domain.authenticateAgent(issued.secret)?.scopes).toEqual(['timeline:read']);
  });

  it('replays an owner restore by its canonical mutation key', async () => {
    const { domain, owner, adapters } = fixture();
    const created = createdEntry(domain, owner, {
      id: ulid(),
      date: '2026-07-31',
      type: 'note',
      text: 'Retry-safe restore',
    });
    const deleted = domain.deleteEntry(created.id, owner).entry;
    const mutation = { id: ulid() };
    if (!adapters.api.restoreEntry) throw new Error('Expected restore adapter');

    const first = await adapters.api.restoreEntry(created.id, deleted.revision, owner, mutation);
    const replay = await adapters.api.restoreEntry(created.id, deleted.revision, owner, mutation);

    expect(replay).toEqual(first);
    expect(domain.getEntry(created.id)?.revision).toBe(deleted.revision + 1);
  });

  it('selects summaries by month and mutates an explicitly selected older summary', async () => {
    const { domain, owner, adapters } = fixture();
    const agent = {
      kind: 'agent' as const,
      tokenId: ulid(),
      tokenLabel: 'summary-agent',
      tool: 'add_entry',
    };
    const june = domain.fileSummary(
      {
        weekStart: '2026-06-29',
        text: 'June weekly summary.',
        source: 'From the adapter integration test.',
      },
      agent,
    ).summary;
    const july = domain.fileSummary(
      {
        weekStart: '2026-07-06',
        text: 'July weekly summary.',
        source: 'From the adapter integration test.',
      },
      agent,
    ).summary;
    const august = domain.fileSummary(
      {
        weekStart: '2026-08-03',
        text: 'August weekly summary.',
        source: 'From the adapter integration test.',
      },
      agent,
    ).summary;

    const julyResponse = (await adapters.api.latestSummary(owner, '2026-07')) as {
      summary: { id: string } | null;
    };
    const globalResponse = (await adapters.api.latestSummary(owner)) as {
      summary: { id: string } | null;
    };
    expect(julyResponse.summary?.id).toBe(july.id);
    expect(globalResponse.summary?.id).toBe(august.id);

    const rewritten = (await adapters.api.rewriteLatestSummary(june.id, 1, owner)) as {
      summary: { id: string; status: string };
    };
    expect(rewritten.summary).toMatchObject({ id: june.id, status: 'stale' });
    expect(domain.getSummary(august.id)?.status).toBe('current');

    const saved = (await adapters.api.saveLatestSummary(july.id, 1, owner)) as {
      summary: { id: string; status: string };
      entry: Entry;
    };
    expect(saved.summary).toMatchObject({ id: july.id, status: 'saved' });
    expect(saved.entry.tags).toContain('summary');
    expect(domain.getSummary(august.id)?.status).toBe('current');
  });

  it('persists the original REST and MCP success status with idempotency records', async () => {
    const { database, owner, adapters } = fixture();
    const restKey = ulid();
    const entryId = ulid();
    const createInput = {
      id: entryId,
      text: 'Created through REST adapter',
      type: 'note' as const,
      tags: [],
      dateIntent: {
        kind: 'today' as const,
        capturedAt: '2026-07-31T10:00:00.000Z',
        baseToday: '2026-07-31',
        timezone: 'UTC',
      },
    };
    await adapters.api.createEntry(createInput, owner, { id: restKey, statusCode: 201 });
    await adapters.api.createEntry(createInput, owner, { id: restKey, statusCode: 201 });

    const tokenId = ulid();
    await adapters.mcp.addEntry(
      {
        text: 'Created through MCP adapter',
        type: 'note',
        tags: [],
        source: 'From the adapter integration test.',
      },
      {
        kind: 'agent',
        tokenId,
        tokenLabel: 'integration',
        scopes: ['journal:full'],
        tool: 'add_entry',
      },
      'mcp-persist-key',
    );

    const rows = database.raw
      .prepare(
        'SELECT actor_type, actor_id, mutation_id, status_code FROM processed_mutations ORDER BY actor_type',
      )
      .all() as Array<{
      actor_type: string;
      actor_id: string;
      mutation_id: string;
      status_code: number;
    }>;
    expect(rows).toEqual(
      expect.arrayContaining([
        { actor_type: 'device', actor_id: owner.deviceId, mutation_id: restKey, status_code: 201 },
        {
          actor_type: 'token',
          actor_id: tokenId,
          mutation_id: 'mcp-persist-key',
          status_code: 200,
        },
      ]),
    );
  });

  it('stamps a collection entry with the date it belongs to rather than the filing date', async () => {
    const { adapters } = fixture();
    const agent = {
      kind: 'agent' as const,
      tokenId: ulid(),
      tokenLabel: 'integration',
      scopes: ['journal:full'] as const,
      tool: 'add_to_collection',
    };
    const dated = (await adapters.mcp.addToCollection(
      {
        collection: 'month:2026-08',
        text: 'Dentist appointment',
        type: 'event',
        tags: [],
        date: '2026-08-26',
        time: '12:00',
        source: 'From the adapter integration test.',
      },
      agent,
    )) as { entry: AgentEntry };
    expect(dated.entry).toMatchObject({
      collection: 'month:2026-08',
      date: '2026-08-26',
      time: '12:00',
    });

    // Today is still the sensible default, so existing callers keep working.
    const undated = (await adapters.mcp.addToCollection(
      {
        collection: 'month:2026-08',
        text: 'Submit water meter reading',
        type: 'task',
        tags: [],
        source: 'From the adapter integration test.',
      },
      agent,
    )) as { entry: AgentEntry };
    expect(undated.entry).toMatchObject({ date: '2026-07-31', time: null });
  });

  it('resolves stale offline date intents from their frozen base without rebasing at sync time', () => {
    const { owner, adapters } = fixture();
    const staleContext = {
      capturedAt: '2026-08-01T00:30:00.000+02:00',
      baseToday: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    } as const;
    const tomorrow = adapters.api.createEntry(
      {
        id: ulid(),
        text: 'Captured offline before midnight',
        type: 'note',
        dateIntent: { kind: 'tomorrow', ...staleContext },
      },
      owner,
      { id: ulid(), statusCode: 201 },
    ) as { entry: Entry };
    const absolute = adapters.api.createEntry(
      {
        id: ulid(),
        text: 'Absolute date remains absolute',
        type: 'note',
        dateIntent: {
          kind: 'absolute',
          date: '2026-09-15',
          ...staleContext,
        },
      },
      owner,
      { id: ulid(), statusCode: 201 },
    ) as { entry: Entry };

    expect(tomorrow.entry.date).toBe('2026-08-01');
    expect(absolute.entry.date).toBe('2026-09-15');
  });

  it('uses the frozen absolute capture intent instead of recomputing a parser date token', () => {
    const { owner, adapters } = fixture();
    const captured = adapters.api.capture(
      {
        draft: '- Offline follow-up >tomorrow',
        defaultType: 'note',
        dateIntent: {
          kind: 'absolute',
          date: '2026-08-02',
          baseToday: '2026-07-31',
          capturedAt: '2026-08-01T00:30:00.000+02:00',
          timezone: 'Europe/Amsterdam',
        },
      },
      owner,
      { id: ulid(), statusCode: 201 },
    ) as { entry: Entry; parsed: { dateShift: unknown } };

    expect(captured.parsed.dateShift).toEqual({ kind: 'tomorrow' });
    expect(captured.entry).toMatchObject({
      date: '2026-08-02',
      text: 'Offline follow-up',
      type: 'note',
    });
  });

  it('files a captured collection token and refuses an unknown slug', () => {
    const { domain, owner, adapters } = fixture();
    domain.createCollection({ id: 'errands', name: 'Errands' }, owner);
    const dateIntent = {
      kind: 'today' as const,
      capturedAt: '2026-07-31T10:00:00.000Z',
      baseToday: '2026-07-31',
      timezone: 'UTC',
    };

    const filed = adapters.api.capture(
      { draft: '. Post the parcel /errands', defaultType: 'task', dateIntent },
      owner,
      { id: ulid(), statusCode: 201 },
    ) as { entry: Entry; parsed: { collection: string | null } };
    expect(filed.parsed.collection).toBe('errands');
    expect(filed.entry).toMatchObject({ text: 'Post the parcel', collection: 'errands' });

    expect(() =>
      adapters.api.capture(
        { draft: '. Post the parcel /erands', defaultType: 'task', dateIntent },
        owner,
        { id: ulid(), statusCode: 201 },
      ),
    ).toThrowError(/collection erands was not found/i);

    const escaped = adapters.api.capture(
      { draft: '. Ship //errands', defaultType: 'task', dateIntent },
      owner,
      { id: ulid(), statusCode: 201 },
    ) as { entry: Entry; parsed: { collection: string | null } };
    expect(escaped.parsed.collection).toBeNull();
    expect(escaped.entry).toMatchObject({ text: 'Ship /errands', collection: null });
  });

  it('serves the tag vocabulary ranked by use', () => {
    const { domain, owner, adapters } = fixture();
    createdEntry(domain, owner, { text: 'Tagged one', type: 'note', tags: ['work', 'home'] });
    createdEntry(domain, owner, { text: 'Tagged two', type: 'note', tags: ['work'] });
    expect(adapters.api.listTags(owner)).toEqual({
      items: [
        { tag: 'work', uses: 2, lastUsedAt: '2026-07-31T10:00:00.000Z' },
        { tag: 'home', uses: 1, lastUsedAt: '2026-07-31T10:00:00.000Z' },
      ],
    });
  });

  it('hashes the full canonical capture request instead of only its reduced entry', () => {
    const { owner, adapters } = fixture();
    const key = ulid();
    const dateIntent = {
      kind: 'today' as const,
      capturedAt: '2026-07-31T10:00:00.000Z',
      baseToday: '2026-07-31',
      timezone: 'UTC',
    };
    const first = adapters.api.capture(
      { draft: '. same', defaultType: 'idea', dateIntent },
      owner,
      { id: key, statusCode: 201 },
    ) as { entry: Entry };
    expect(first.entry).toMatchObject({ text: 'same', type: 'task' });
    expect(() =>
      adapters.api.capture({ draft: 'same', defaultType: 'task', dateIntent }, owner, {
        id: key,
        statusCode: 201,
      }),
    ).toThrowError(/different request/i);
  });

  it('replays an undated MCP add after midnight from the canonical tool input', async () => {
    const { adapters, advance } = fixture();
    const input = {
      text: 'Midnight-safe MCP retry',
      type: 'note' as const,
      tags: [],
      source: 'From the midnight retry integration test.',
    };
    const actor = {
      kind: 'agent' as const,
      tokenId: ulid(),
      tokenLabel: 'integration',
      scopes: ['journal:full'] as const,
    };
    const first = await adapters.mcp.addEntry(input, actor, 'midnight-safe-key');
    advance(86_400_000);
    expect(await adapters.mcp.addEntry(input, actor, 'midnight-safe-key')).toEqual(first);
  });

  it('uses a tuple cursor that remains stable when a newer entry is inserted', async () => {
    const { domain, owner, adapters, advance } = fixture();
    const oldest = createdEntry(domain, owner, { text: 'Oldest', type: 'note' });
    advance();
    const middle = createdEntry(domain, owner, { text: 'Middle', type: 'note' });
    advance();
    const newest = createdEntry(domain, owner, { text: 'Newest', type: 'note' });

    const first = (await adapters.api.listEntries({ limit: 2 }, owner)) as {
      items: Entry[];
      nextCursor: string | null;
    };
    expect(first.items.map((entry) => entry.id)).toEqual([newest.id, middle.id]);
    expect(first.nextCursor).toEqual(expect.any(String));
    if (!first.nextCursor) throw new Error('Expected a second entries page.');

    advance();
    const insertedAtHead = createdEntry(domain, owner, { text: 'New head', type: 'note' });
    const second = (await adapters.api.listEntries(
      { limit: 2, cursor: first.nextCursor },
      owner,
    )) as { items: Entry[]; nextCursor: string | null };

    expect(second.items.map((entry) => entry.id)).toEqual([oldest.id]);
    expect(second.items.map((entry) => entry.id)).not.toContain(insertedAtHead.id);
    expect(second.nextCursor).toBeNull();
  });

  it('applies the shared search grammar before cursor paging', async () => {
    const { domain, owner, adapters, advance } = fixture();
    const wanted = createdEntry(domain, owner, {
      text: 'CAFÉ launch plan',
      type: 'note',
      tags: ['work'],
      date: '2026-07-30',
    });
    advance();
    createdEntry(domain, owner, {
      text: 'CAFÉ launch plan outside the date range',
      type: 'note',
      tags: ['work'],
      date: '2026-06-30',
    });
    createdEntry(domain, owner, {
      text: 'CAFÉ launch plan with the wrong type',
      type: 'task',
      tags: ['work'],
      date: '2026-07-30',
    });

    const page = (await adapters.api.listEntries(
      {
        q: 'type:note #work from:2026-07-01 to:2026-07-31 cafe launch',
        limit: 50,
      },
      owner,
    )) as { items: Entry[]; nextCursor: string | null };
    expect(page.items.map((entry) => entry.id)).toEqual([wanted.id]);
    expect(page.nextCursor).toBeNull();
    expect(() => adapters.api.listEntries({ q: 'type:unknown', limit: 50 }, owner)).toThrowError(
      /Type must/i,
    );
    expect(() =>
      adapters.api.listEntries({ q: 'type:note', type: 'task', limit: 50 }, owner),
    ).toThrowError(/Conflicting entry type/i);
  });

  it('builds one deduplicated Timeline page with referenced collection labels', async () => {
    const { domain, owner, adapters, advance } = fixture();
    domain.createCollection({ id: 'projects', name: 'Projects' }, owner);
    const daily = createdEntry(domain, owner, { text: 'Daily thought', type: 'note' });
    advance();
    const filed = createdEntry(domain, owner, {
      text: 'Filed thought',
      type: 'note',
      collection: 'projects',
    });
    advance();
    const monthly = createdEntry(domain, owner, {
      text: 'Monthly planning thought',
      type: 'note',
      collection: 'month:2026-08',
    });

    const page = (await adapters.api.timeline({ limit: 100 }, owner)) as {
      items: Entry[];
      collections: Collection[];
      nextCursor: string | null;
      latestAgentTouch?: unknown;
      weeklyReflection?: unknown;
    };

    expect(page.items.map((entry) => entry.id)).toEqual([filed.id, daily.id]);
    expect(page.items.map((entry) => entry.id)).not.toContain(monthly.id);
    expect(new Set(page.items.map((entry) => entry.id)).size).toBe(page.items.length);
    expect(page.collections).toEqual([
      expect.objectContaining({ id: 'projects', name: 'Projects' }),
    ]);
    expect(page).not.toHaveProperty('latestAgentTouch');
    expect(page).not.toHaveProperty('weeklyReflection');
  });

  it.each([5_000, 20_000])(
    'keeps bootstrap and Timeline bounded for a %,i-entry journal',
    async (entryCount) => {
      const statements: string[] = [];
      const { database, owner, adapters } = fixture((sql) => statements.push(sql));
      const insert = database.raw.prepare(
        `INSERT INTO entries(
        id,date,type,text,state,time,tags,author,source,migrations,collection,
        created_at,updated_at,deleted_at,revision
      ) VALUES (?,?,'note',?,'logged',NULL,'[]','me',NULL,0,NULL,?,?,NULL,1)`,
      );
      database.raw.transaction(() => {
        for (let index = 0; index < entryCount; index += 1) {
          const timestamp = '2026-07-31T09:00:00.000Z';
          insert.run(ulid(), '2026-07-31', `Timeline fixture ${index}`, timestamp, timestamp);
        }
      })();

      statements.length = 0;
      const bootstrap = (await adapters.api.bootstrap(owner)) as {
        entries: Entry[];
        timeline: { items: Entry[]; nextCursor: string | null };
      };
      expect(bootstrap.entries).toHaveLength(100);
      expect(bootstrap.timeline.items).toHaveLength(100);
      expect(bootstrap.timeline.nextCursor).toEqual(expect.any(String));
      expect(statements.filter((sql) => /^SELECT e\.\*/i.test(sql.trim()))).toHaveLength(1);
    },
  );

  it('pages a large entry fixture with one bounded SQL query per page', async () => {
    const statements: string[] = [];
    const { database, owner, adapters } = fixture((sql) => statements.push(sql));
    const insert = database.raw.prepare(
      `INSERT INTO entries(
        id,date,type,text,state,time,tags,author,source,migrations,collection,
        created_at,updated_at,deleted_at,revision
      ) VALUES (?,?,'note',?,'logged',NULL,'[]','me',NULL,0,NULL,?,?,NULL,1)`,
    );
    database.raw.transaction(() => {
      for (let index = 0; index < 2_000; index += 1) {
        const timestamp = '2026-07-31T09:00:00.000Z';
        insert.run(ulid(), '2026-07-31', `Large fixture ${index}`, timestamp, timestamp);
      }
    })();

    statements.length = 0;
    const first = (await adapters.api.listEntries({ limit: 100 }, owner)) as {
      items: Entry[];
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(statements.filter((sql) => /^SELECT\b/i.test(sql.trim()))).toHaveLength(1);
    expect(statements.join('\n')).not.toMatch(/count\s*\(/i);

    statements.length = 0;
    const second = (await adapters.api.listEntries(
      { limit: 100, cursor: first.nextCursor! },
      owner,
    )) as { items: Entry[]; nextCursor: string | null };
    expect(second.items).toHaveLength(100);
    expect(statements.filter((sql) => /^SELECT\b/i.test(sql.trim()))).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((entry) => entry.id)).size).toBe(200);
  });

  it('indexes every owning month and returns every entry in a collection resource', async () => {
    const statements: string[] = [];
    const { domain, owner, adapters } = fixture((sql) => statements.push(sql));
    domain.createCollection({ id: 'ideas', name: 'Ideas' }, owner);
    for (let index = 0; index < 105; index += 1) {
      createdEntry(domain, owner, {
        text: `Idea ${index + 1}`,
        type: 'note',
        collection: 'ideas',
      });
    }
    createdEntry(domain, owner, {
      text: 'August plan',
      type: 'task',
      collection: 'month:2026-08',
    });
    const emptyMonthEntry = createdEntry(domain, owner, {
      text: 'September plan',
      type: 'task',
      collection: 'month:2026-09',
    });
    domain.deleteEntry(emptyMonthEntry.id, owner);

    const index = (await adapters.mcp.index()) as {
      collections: Array<Collection & { count: number }>;
      months: Array<{ month: string; count: number }>;
    };
    expect(index.collections.find((collection) => collection.id === 'ideas')?.count).toBe(105);
    expect(index.months).toEqual([
      { month: '2026-08', count: 1 },
      { month: '2026-07', count: 105 },
    ]);

    statements.length = 0;
    const collection = (await adapters.mcp.collection('ideas')) as {
      total: number;
      entries: Entry[];
    };
    expect(collection.total).toBe(105);
    expect(collection.entries).toHaveLength(105);
    const reads = statements.filter((sql) => /^SELECT\b/i.test(sql.trim()));
    expect(reads).toHaveLength(3);
    expect(reads.join('\n')).not.toMatch(/\bOFFSET\b|count\s*\(/i);
  });

  it('serves a bounded aggregate index across a large history and counts persisted queries', async () => {
    const statements: string[] = [];
    const { database, domain, owner, adapters } = fixture((sql) => statements.push(sql));
    domain.createCollection({ id: 'ideas', name: 'Ideas' }, owner);
    domain.setSettings(
      {
        savedViews: [{ id: 'large-notes', name: 'Large notes', query: 'Large fixture' }],
      },
      owner,
    );
    const insert = database.raw.prepare(
      `INSERT INTO entries(
        id,date,type,text,state,time,tags,author,source,migrations,collection,
        created_at,updated_at,deleted_at,revision
      ) VALUES (?,?,'note',?,'logged',NULL,'[]','me',NULL,0,'ideas',?,?,NULL,1)`,
    );
    database.raw.transaction(() => {
      for (let index = 0; index < 2_500; index += 1) {
        const timestamp = '2026-07-31T09:00:00.000Z';
        insert.run(
          ulid(),
          index % 2 === 0 ? '2026-08-05' : '2026-09-05',
          `Large fixture ${index}`,
          timestamp,
          timestamp,
        );
      }
    })();

    statements.length = 0;
    const index = (await adapters.api.getIndex(owner)) as {
      collections: Array<Collection & { count: number }>;
      months: Array<{ month: string; count: number }>;
      savedViews: Array<{ id: string; query: string; count: number }>;
    };

    expect(index.collections).toEqual([expect.objectContaining({ id: 'ideas', count: 2_500 })]);
    expect(index.months).toEqual([
      { month: '2026-09', count: 1_250 },
      { month: '2026-08', count: 1_250 },
    ]);
    expect(index.savedViews).toEqual([
      { id: 'large-notes', name: 'Large notes', query: 'Large fixture', count: 2_500 },
    ]);
    const reads = statements.filter((sql) => /^SELECT\b/iu.test(sql.trim()));
    expect(reads).toHaveLength(5);
    expect(reads.join('\n')).not.toMatch(/SELECT\s+e\.\*|\bLIMIT\b|\bOFFSET\b/iu);
  });

  it('isolates a legacy saved view with invalid grammar from the Index response', async () => {
    const { database, domain, owner, adapters } = fixture();
    database.raw
      .prepare(
        `INSERT INTO settings(
          id,density,show_type_badges,highlight_ai_entries,saved_views,updated_at
        ) VALUES (1,'comfortable',1,1,?,'2026-07-31T09:00:00.000Z')`,
      )
      .run(
        JSON.stringify([
          { id: 'legacy-broken', name: 'Legacy broken', query: 'type:unknown' },
          { id: 'legacy-valid', name: 'Legacy valid', query: 'type:note' },
        ]),
      );

    const index = (await adapters.api.getIndex(owner)) as {
      savedViews: Array<{ id: string; count: number; name: string; query: string }>;
    };

    expect(domain.getSettings().savedViews).toHaveLength(2);
    expect(index.savedViews).toEqual([
      { id: 'legacy-valid', name: 'Legacy valid', query: 'type:note', count: 0 },
    ]);
  });

  it('pages through more than 500 same-timestamp activity rows without skips', async () => {
    const statements: string[] = [];
    const { domain, owner, adapters } = fixture((sql) => statements.push(sql));
    const agent = {
      kind: 'agent' as const,
      tokenId: ulid(),
      tokenLabel: 'activity-pager',
      tool: 'add_entry',
    };
    for (let index = 0; index < 505; index += 1) {
      domain.createEntry(
        {
          text: `Paged activity ${index + 1}`,
          type: 'note',
          source: 'From the activity pagination integration test.',
        },
        agent,
      );
    }

    statements.length = 0;
    const legacyPage = (await adapters.api.listActivity(
      { before: '2026-07-31T10:00:00.000Z', limit: 50 },
      owner,
    )) as { items: ActivityView[]; nextCursor: string | null };
    expect(legacyPage.items).toHaveLength(50);
    expect(legacyPage.nextCursor).toEqual(expect.any(String));
    const selects = statements.filter((sql) => /^SELECT\b/i.test(sql.trim()));
    expect(selects).toHaveLength(2);
    expect(selects.some((sql) => sql.includes('json_each'))).toBe(true);

    const ids: string[] = [];
    let before: string | undefined;
    do {
      const page = (await adapters.api.listActivity(
        { ...(before === undefined ? {} : { before }), limit: 50 },
        owner,
      )) as { items: ActivityView[]; nextCursor: string | null };
      ids.push(...page.items.map((item) => item.id));
      before = page.nextCursor ?? undefined;
    } while (before !== undefined);

    expect(ids).toHaveLength(505);
    expect(new Set(ids).size).toBe(505);
  });
});
