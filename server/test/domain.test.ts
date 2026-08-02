import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { JournalDatabase } from '../src/db/database.js';
import { JournalExportSchema, type ChangeBatch } from '../src/contracts/index.js';
import { DomainError } from '../src/domain/errors.js';
import { JournalDomain } from '../src/domain/journal.js';
import type { ActorContext } from '../src/domain/types.js';

const roots: string[] = [];
const open: JournalDomain[] = [];

afterEach(() => {
  for (const domain of open.splice(0)) domain.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'journal-domain-test-'));
  roots.push(root);
  let instant = new Date('2026-07-31T10:00:00.000Z');
  const database = new JournalDatabase({ path: join(root, 'journal.db'), now: () => instant });
  const domain = new JournalDomain({
    database,
    config: { timezone: 'UTC', dayBoundaryOffsetMin: 0, deviceCredentialTtlDays: 365 },
    now: () => instant,
  });
  open.push(domain);
  const owner: ActorContext = { kind: 'owner', deviceId: ulid() };
  const agent: ActorContext = {
    kind: 'agent',
    tokenId: ulid(),
    tokenLabel: 'test-agent',
    tool: 'add_entry',
  };
  return {
    root,
    database,
    domain,
    owner,
    agent,
    now: () => instant,
    advance(milliseconds: number) {
      instant = new Date(instant.getTime() + milliseconds);
    },
  };
}

describe('JournalDomain entry commands', () => {
  it('replays an identical mutation and rejects same-key payload drift', () => {
    const { domain, database, owner } = fixture();
    const input = {
      id: ulid(),
      text: 'Captured offline',
      type: 'task' as const,
      date: '2026-07-31',
    };
    const first = domain.createEntry(input, owner, { id: 'offline-mutation-1', statusCode: 201 });
    const replay = domain.createEntry(input, owner, { id: 'offline-mutation-1', statusCode: 201 });
    expect(replay).toEqual(first);
    expect(domain.searchEntries({ limit: 100 }).total).toBe(1);
    try {
      domain.createEntry({ ...input, text: 'Different payload' }, owner, {
        id: 'offline-mutation-1',
      });
      throw new Error('Expected idempotency conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
    expect(
      database.raw
        .prepare('SELECT actor_type, actor_id, mutation_id, status_code FROM processed_mutations')
        .get(),
    ).toEqual({
      actor_type: 'device',
      actor_id: owner.deviceId,
      mutation_id: 'offline-mutation-1',
      status_code: 201,
    });
  });

  it('retains idempotency records beyond the soft-delete recovery window', () => {
    const { domain, agent, advance } = fixture();
    const input = {
      text: 'Durable retry-safe assistant line',
      type: 'note' as const,
      date: '2026-07-31',
      source: 'From the durable idempotency fixture.',
    };
    const first = domain.createEntry(input, agent, { id: 'durable-agent-retry' });
    advance(91 * 86_400_000);
    expect(domain.purgeExpired().mutations).toBe(0);
    expect(domain.createEntry(input, agent, { id: 'durable-agent-retry' })).toEqual(first);
    expect(domain.searchEntries({ query: input.text, limit: 25 }).total).toBe(1);
  });

  it('enforces AI provenance and makes automatic additions safely reversible', () => {
    const { domain, agent, owner } = fixture();
    expect(() => domain.createEntry({ text: 'No source', type: 'note' }, agent)).toThrowError(
      /source/i,
    );
    const result = domain.createEntry(
      { text: 'Assistant line', type: 'note', source: 'From the fixture email.' },
      agent,
    );
    expect(result.kind).toBe('entry');
    if (result.kind !== 'entry' || result.activityId === undefined)
      throw new Error('Expected agent entry');
    const view = domain.activityView(result.activityId);
    expect(view.revert).toEqual({ eligible: true, reason: null });
    expect(view.origin).toMatchObject({ actor: 'mcp', tool: 'add_entry' });
    const reverted = domain.revertActivity(result.activityId, owner);
    expect(reverted.activity.kind).toBe('revert');
    expect(domain.requireEntry(result.entry.id, { includeDeleted: true }).deletedAt).not.toBeNull();
    expect(domain.activityView(result.activityId).revert.reason).toBe('already_reverted');
    expect(() => domain.revertActivity(result.activityId, owner)).toThrowError(/already/i);
  });

  it('replays server-generated agent entry and summary ids from the caller key', () => {
    const { domain, agent } = fixture();
    const entryInput = {
      text: 'Retry-safe assistant line',
      type: 'note' as const,
      source: 'From retry fixture.',
    };
    const first = domain.createEntry(entryInput, agent, { id: 'agent-retry-entry' });
    const replay = domain.createEntry(entryInput, agent, { id: 'agent-retry-entry' });
    expect(replay).toEqual(first);
    expect(domain.searchEntries({ query: entryInput.text, limit: 25 }).total).toBe(1);

    const summaryInput = {
      text: 'Retry-safe weekly reflection.',
      type: 'note' as const,
      tags: ['summary'],
      source: 'From retry summary fixture.',
      summaryWeekStart: '2026-07-27',
    };
    const summary = domain.createEntry(summaryInput, agent, { id: 'agent-retry-summary' });
    const summaryReplay = domain.createEntry(summaryInput, agent, { id: 'agent-retry-summary' });
    expect(summaryReplay).toEqual(summary);
    expect(domain.listSummaries()).toHaveLength(1);
  });

  it('bounds agent daily dates to server today plus or minus 366 days', () => {
    const { domain, agent, owner } = fixture();
    const source = 'From the date boundary fixture.';
    expect(() =>
      domain.createEntry({ text: 'Lower edge', type: 'note', date: '2025-07-30', source }, agent),
    ).not.toThrow();
    expect(() =>
      domain.createEntry({ text: 'Upper edge', type: 'note', date: '2027-08-01', source }, agent),
    ).not.toThrow();
    expect(() =>
      domain.createEntry({ text: 'Too old', type: 'note', date: '2025-07-29', source }, agent),
    ).toThrowError(/366 days/i);
    expect(() =>
      domain.createEntry({ text: 'Too new', type: 'note', date: '2027-08-02', source }, agent),
    ).toThrowError(/366 days/i);
    expect(() =>
      domain.createEntry({ text: 'Owner history import', type: 'note', date: '2020-01-01' }, owner),
    ).not.toThrow();
  });

  it('refuses a revert after a later owner edit', () => {
    const { domain, agent, owner } = fixture();
    const result = domain.createEntry(
      { text: 'Original assistant line', type: 'note', source: 'From a fixture message.' },
      agent,
    );
    if (result.kind !== 'entry' || result.activityId === undefined)
      throw new Error('Expected agent entry');
    domain.updateEntry(result.entry.id, { text: 'Owner edited line' }, owner);
    expect(domain.activityView(result.activityId).revert.reason).toBe('post_image_mismatch');
    expect(() => domain.revertActivity(result.activityId, owner)).toThrowError(/newer work/i);
  });

  it('copies migrations and monthly scheduling while preserving the paper trail', () => {
    const { domain, owner } = fixture();
    const source = domain.createEntry(
      { id: ulid(), text: 'Carry this forward', type: 'task', date: '2026-07-30' },
      owner,
    );
    if (source.kind !== 'entry') throw new Error('Expected entry');
    const migrated = domain.migrateEntry(
      source.entry.id,
      { newEntryId: ulid(), targetDate: '2026-07-31', expectedRevision: 1 },
      owner,
    );
    expect(migrated.original.state).toBe('migrated');
    expect(migrated.copy).toMatchObject({ state: 'open', migrations: 1, date: '2026-07-31' });

    const monthlySource = domain.createEntry(
      { id: ulid(), text: 'Plan August launch', type: 'task', date: '2026-07-31' },
      owner,
    );
    if (monthlySource.kind !== 'entry') throw new Error('Expected entry');
    const scheduled = domain.scheduleMonthly(
      monthlySource.entry.id,
      { copyId: ulid(), month: '2026-08', expectedRevision: 1 },
      owner,
    );
    expect(scheduled.original.state).toBe('scheduled');
    expect(scheduled.copy).toMatchObject({ collection: 'month:2026-08', state: 'open' });
    expect(scheduled.collection.id).toBe('month:2026-08');
  });

  it('rolls back daily and monthly migration when copy insertion fails after the first update', () => {
    const { domain, database, owner } = fixture();
    const daily = domain.createEntry(
      { id: ulid(), text: 'Daily atomic source', type: 'task', date: '2026-07-30' },
      owner,
    );
    const monthly = domain.createEntry(
      { id: ulid(), text: 'Monthly atomic source', type: 'task', date: '2026-07-31' },
      owner,
    );
    if (daily.kind !== 'entry' || monthly.kind !== 'entry') throw new Error('Expected entries');
    const dailyCopyId = ulid();
    const monthlyCopyId = ulid();
    database.raw.exec(`
      CREATE TEMP TRIGGER inject_copy_failure BEFORE INSERT ON entries
      WHEN NEW.id IN ('${dailyCopyId}', '${monthlyCopyId}')
      BEGIN SELECT RAISE(ABORT, 'injected copy failure'); END;
    `);

    expect(() =>
      domain.migrateEntry(
        daily.entry.id,
        { newEntryId: dailyCopyId, targetDate: '2026-07-31', expectedRevision: 1 },
        owner,
      ),
    ).toThrow(/injected copy failure/i);
    expect(domain.requireEntry(daily.entry.id)).toMatchObject({ state: 'open', revision: 1 });
    expect(domain.getEntry(dailyCopyId, { includeDeleted: true })).toBeNull();

    expect(() =>
      domain.scheduleMonthly(
        monthly.entry.id,
        { copyId: monthlyCopyId, month: '2026-08', expectedRevision: 1 },
        owner,
      ),
    ).toThrow(/injected copy failure/i);
    expect(domain.requireEntry(monthly.entry.id)).toMatchObject({ state: 'open', revision: 1 });
    expect(domain.getEntry(monthlyCopyId, { includeDeleted: true })).toBeNull();
    expect(domain.getCollection('month:2026-08')).toBeNull();
  });

  it('keeps an entry on its own date when an update moves it into a collection', () => {
    const { domain, owner } = fixture();
    domain.createCollection({ id: 'books', name: 'Books' }, owner);
    const created = domain.createEntry(
      { id: ulid(), text: 'Read the systems book', type: 'note', date: '2026-07-01' },
      owner,
    );
    if (created.kind !== 'entry') throw new Error('Expected entry');
    // Filing is a move, not a recapture: only an explicit date patch re-dates an entry.
    const filed = domain.updateEntry(created.entry.id, { collection: 'books' }, owner);
    expect(filed.entry).toMatchObject({ collection: 'books', date: '2026-07-01' });
    const redated = domain.updateEntry(created.entry.id, { date: '2026-07-31' }, owner);
    expect(redated.entry).toMatchObject({ collection: 'books', date: '2026-07-31' });
  });

  it('applies an agent migration atomically with revision checks', () => {
    const { domain, owner, agent } = fixture();
    const source = domain.createEntry(
      { id: ulid(), text: 'Vague task', type: 'task', date: '2026-07-31' },
      owner,
    );
    if (source.kind !== 'entry') throw new Error('Expected entry');
    expect(() =>
      domain.applyAgentMigration(
        {
          kind: 'split',
          title: 'Split the vague task',
          detail: 'Replace it with a concrete first step.',
          ops: [
            {
              op: 'update',
              id: source.entry.id,
              expectedRevision: 999,
              patch: { state: 'cancelled' },
            },
            {
              op: 'create',
              entry: {
                text: 'Concrete first step',
                type: 'task',
                time: null,
                tags: [],
                collection: null,
                source: 'From journal hygiene review.',
              },
            },
          ],
        },
        agent,
      ),
    ).toThrowError(/revision/i);
    expect(domain.requireEntry(source.entry.id).state).toBe('open');
    expect(domain.searchEntries({ query: 'Concrete first step', limit: 100 }).total).toBe(0);
  });

  it('orders bulk retag results and snapshots deterministically', () => {
    const { domain, owner, agent } = fixture();
    const ids = [ulid(), ulid(), ulid()];
    for (const [index, id] of ids.entries()) {
      domain.createEntry(
        { id, text: `Retag candidate ${index}`, type: 'note', date: '2026-07-31', tags: ['old'] },
        owner,
      );
    }
    const result = domain.applyAgentMigration(
      {
        kind: 'retag',
        title: 'Rename the old tag',
        detail: 'Use the canonical replacement across all live entries.',
        ops: [{ op: 'retag', from: 'old', to: 'new' }],
      },
      agent,
    );
    const expected = [...ids].sort().reverse();
    expect(result.entries.map((entry) => entry.id)).toEqual(expected);
    expect(
      domain.getActivity(result.activityId)?.postImages.map((snapshot) => snapshot.id),
    ).toEqual(expected);
  });

  it('batches created rows and auto-created month collections, then reverts both', () => {
    const { domain, agent, owner } = fixture();
    const batches: ChangeBatch[] = [];
    domain.subscribe((batch) => batches.push(batch));
    const result = domain.createEntry(
      {
        text: 'August assistant item',
        type: 'task',
        collection: 'month:2026-08',
        source: 'From the August planning fixture.',
      },
      { ...agent, tool: 'add_to_collection' },
      { id: 'mcp-month-add-1' },
    );
    if (result.kind !== 'entry' || result.activityId === undefined)
      throw new Error('Expected agent entry');
    expect(batches).toHaveLength(1);
    expect(batches[0]?.mutationId).toBe('mcp-month-add-1');
    expect(batches[0]?.changes.map((change) => change.kind)).toEqual([
      'collection.changed',
      'entry.created',
      'activity.appended',
    ]);
    const activity = domain.getActivity(result.activityId);
    expect(activity?.preImages.map((snapshot) => [snapshot.entity, snapshot.row])).toEqual([
      ['entry', null],
      ['collection', null],
    ]);
    domain.revertActivity(result.activityId, owner);
    expect(domain.getCollection('month:2026-08')).toBeNull();
    expect(domain.requireEntry(result.entry.id, { includeDeleted: true }).deletedAt).not.toBeNull();
    domain.restoreEntry(result.entry.id, owner);
    expect(domain.getCollection('month:2026-08')).not.toBeNull();
    expect(domain.requireEntry(result.entry.id).collection).toBe('month:2026-08');
  });

  it('combines FTS prefix candidates with permissive substring matching', () => {
    const { domain, owner } = fixture();
    domain.createEntry(
      {
        id: ulid(),
        text: 'Planning Lisbon flights',
        type: 'note',
        tags: ['travel'],
        date: '2026-07-31',
      },
      owner,
    );
    expect(domain.searchEntries({ query: 'plan', limit: 25 }).total).toBe(1);
    expect(domain.searchEntries({ query: 'annin', limit: 25 }).total).toBe(1);
    expect(domain.searchEntries({ query: '#travel', limit: 25 }).total).toBe(1);
  });

  it('matches Unicode case-insensitive substrings', () => {
    const { domain, owner } = fixture();
    domain.createEntry(
      { id: ulid(), text: 'CAFÉ planning', type: 'note', date: '2026-07-31' },
      owner,
    );
    expect(domain.searchEntries({ query: 'afé', limit: 25 }).total).toBe(1);
  });

  it('ranks the tag vocabulary by use, then alphabetically, ignoring deleted entries', () => {
    const { domain, owner, advance } = fixture();
    const first = domain.createEntry(
      { id: ulid(), text: 'Tagged one', type: 'note', tags: ['work', 'home'] },
      owner,
    );
    advance(60_000);
    domain.createEntry(
      { id: ulid(), text: 'Tagged two', type: 'note', tags: ['work', 'zone'] },
      owner,
    );
    advance(60_000);
    const removed = domain.createEntry(
      { id: ulid(), text: 'Tagged three', type: 'note', tags: ['archive', 'work'] },
      owner,
    );
    if (first.kind !== 'entry' || removed.kind !== 'entry') throw new Error('Expected entries');
    domain.deleteEntry(removed.entry.id, owner);

    expect(domain.listTags()).toEqual([
      { tag: 'work', uses: 2, lastUsedAt: '2026-07-31T10:01:00.000Z' },
      { tag: 'home', uses: 1, lastUsedAt: first.entry.createdAt },
      { tag: 'zone', uses: 1, lastUsedAt: '2026-07-31T10:01:00.000Z' },
    ]);
    expect(domain.listTags(1)).toEqual([
      { tag: 'work', uses: 2, lastUsedAt: '2026-07-31T10:01:00.000Z' },
    ]);
    expect(() => domain.listTags(0)).toThrowError(/limit/i);
  });
});

describe('JournalDomain summaries and credentials', () => {
  it('files one summary per week, rewrites it, and saves it to today', () => {
    const { domain, agent, owner } = fixture();
    const filed = domain.createEntry(
      {
        text: 'The week clarified the next travel decision.',
        type: 'note',
        tags: ['summary'],
        source: 'Weekly synthesis from July 27 through July 31.',
        summaryWeekStart: '2026-07-27',
      },
      agent,
    );
    expect(filed.kind).toBe('summary');
    if (filed.kind !== 'summary') throw new Error('Expected summary');
    const stale = domain.rewriteSummary(filed.summary.id, owner, undefined, {
      expectedRevision: 1,
    });
    expect(stale.summary.status).toBe('stale');
    const replacement = domain.createEntry(
      {
        text: 'The revised week points to booking the flight.',
        type: 'note',
        tags: ['summary'],
        source: 'Rewritten weekly synthesis after owner request.',
        summaryWeekStart: '2026-07-27',
      },
      agent,
    );
    if (replacement.kind !== 'summary') throw new Error('Expected summary');
    expect(replacement.summary.id).toBe(filed.summary.id);
    expect(domain.listSummaries()).toHaveLength(1);
    const saved = domain.saveSummaryToToday(replacement.summary.id, owner, undefined, {
      expectedRevision: replacement.summary.revision,
    });
    expect(saved.summary.status).toBe('saved');
    expect(saved.entry).toMatchObject({ type: 'note', tags: ['summary'], author: 'ai' });
  });

  it('relinks a saved summary when its saved note was soft-deleted', () => {
    const { domain, agent, owner } = fixture();
    const filed = domain.fileSummary(
      {
        weekStart: '2026-07-27',
        text: 'A week worth preserving.',
        source: 'Weekly synthesis for the replacement-note test.',
      },
      agent,
    );
    const first = domain.saveSummaryToToday(filed.summary.id, owner);
    domain.deleteEntry(first.entry.id, owner, undefined, {
      expectedRevision: first.entry.revision,
    });
    const changes: ChangeBatch[] = [];
    const unsubscribe = domain.subscribe((change) => changes.push(change));
    const replacement = domain.saveSummaryToToday(first.summary.id, owner, undefined, {
      expectedRevision: first.summary.revision,
    });
    unsubscribe();

    expect(replacement.entry.id).not.toBe(first.entry.id);
    expect(replacement.entry.deletedAt).toBeNull();
    expect(replacement.summary.savedEntryId).toBe(replacement.entry.id);
    expect(changes.flatMap((batch) => batch.changes.map((change) => change.kind))).toEqual(
      expect.arrayContaining(['entry.created', 'summary.changed', 'activity.appended']),
    );
  });

  it('returns the greatest weekly summary within an explicitly validated month', () => {
    const { domain, agent } = fixture();
    for (const weekStart of ['2026-07-06', '2026-07-27', '2026-08-03']) {
      domain.fileSummary(
        {
          weekStart,
          text: `Reflection for ${weekStart}.`,
          source: 'From the monthly summary fixture.',
        },
        agent,
      );
    }
    expect(domain.getLatestSummary()?.weekStart).toBe('2026-08-03');
    expect(domain.getLatestSummary('2026-07')?.weekStart).toBe('2026-07-27');
    expect(domain.getSummaryForMonth('2026-06')).toBeNull();
    expect(() => domain.getLatestSummary('July 2026')).toThrowError(/YYYY-MM/);
  });

  it('hashes credentials and enforces a persisted anchored write window', () => {
    const { domain, owner, advance } = fixture();
    const issued = domain.createAgentToken('test agent', ['journal:full'], owner);
    expect(issued.secret).toMatch(/^jrn_/);
    expect(domain.authenticateAgent(issued.secret)).toMatchObject({ tokenId: issued.token.id });
    expect(domain.consumeWriteRateLimit(issued.token.id, 2)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(domain.consumeWriteRateLimit(issued.token.id, 2)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(domain.consumeWriteRateLimit(issued.token.id, 2)).toMatchObject({ allowed: false });
    advance(3_600_001);
    expect(domain.consumeWriteRateLimit(issued.token.id, 2)).toMatchObject({ allowed: true });
    domain.revokeAgentToken(issued.token.id, owner);
    expect(domain.authenticateAgent(issued.secret)).toBeNull();

    const device = domain.pairDevice('phone');
    expect(domain.authenticateDevice(device.secret)).toMatchObject({ deviceId: device.deviceId });
    const renewed = domain.renewDevice(device.secret);
    expect(renewed?.secret).not.toBe(device.secret);
    expect(domain.authenticateDevice(device.secret)).toBeNull();
  });

  it('keeps the anchored write window across a domain restart', () => {
    const { root, domain, owner, now } = fixture();
    const issued = domain.createAgentToken('restart-safe rate limit', ['journal:full'], owner);
    expect(domain.consumeWriteRateLimit(issued.token.id, 2)).toMatchObject({
      allowed: true,
      remaining: 1,
    });

    open.splice(open.indexOf(domain), 1);
    domain.close();
    const reopened = new JournalDomain({
      database: new JournalDatabase({ path: join(root, 'journal.db'), now }),
      config: { timezone: 'UTC', dayBoundaryOffsetMin: 0, deviceCredentialTtlDays: 365 },
      now,
    });
    open.push(reopened);

    expect(reopened.consumeWriteRateLimit(issued.token.id, 2)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(reopened.consumeWriteRateLimit(issued.token.id, 2)).toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it('emits secret-free settings and token changes for other connected devices', () => {
    const { domain, owner } = fixture();
    const batches: ChangeBatch[] = [];
    domain.subscribe((batch) => batches.push(batch));
    const issued = domain.createAgentToken('shared assistant', ['journal:full'], owner);
    domain.setSettings({ density: 'compact' }, owner);
    domain.revokeAgentToken(issued.token.id, owner);

    expect(batches.map((batch) => batch.changes.map((change) => change.kind))).toEqual([
      ['token.changed'],
      ['settings.changed'],
      ['token.changed'],
    ]);
    expect(batches[0]?.changes[0]?.payload).toEqual(issued.token);
    expect(JSON.stringify(batches)).not.toContain(issued.secret);
    expect(batches[2]?.changes[0]?.payload).toMatchObject({
      id: issued.token.id,
      revokedAt: '2026-07-31T10:00:00.000Z',
    });
  });

  it('restores only inside the 30-day recovery window and purges expired rows', () => {
    const { domain, owner, advance } = fixture();
    const created = domain.createEntry(
      { id: ulid(), text: 'Recoverable row', type: 'note', date: '2026-07-31' },
      owner,
    );
    if (created.kind !== 'entry') throw new Error('Expected entry');
    const firstDelete = domain.deleteEntry(created.entry.id, owner);
    advance(29 * 86_400_000);
    const restored = domain.restoreEntry(created.entry.id, owner, undefined, {
      expectedRevision: firstDelete.entry.revision,
    });
    expect(restored.entry.deletedAt).toBeNull();

    domain.deleteEntry(created.entry.id, owner);
    advance(30 * 86_400_000 + 1);
    expect(() => domain.restoreEntry(created.entry.id, owner)).toThrowError(/30-day recovery/i);
    expect(domain.purgeExpired().entries).toBe(1);
    expect(domain.getEntry(created.entry.id, { includeDeleted: true })).toBeNull();
  });

  it('round-trips a clean export and rejects id collisions with different payloads', () => {
    const source = fixture();
    const created = source.domain.createEntry(
      { id: ulid(), text: 'Portable journal row', type: 'note', date: '2026-07-31' },
      source.owner,
    );
    if (created.kind !== 'entry') throw new Error('Expected entry');
    source.domain.createCollection(
      { id: 'travel', name: 'Travel', note: 'Trips and planning' },
      source.owner,
    );
    source.domain.fileSummary(
      {
        weekStart: '2026-07-27',
        text: 'A portable weekly reflection.',
        source: 'Weekly synthesis for the export round-trip fixture.',
      },
      source.agent,
    );
    source.domain.setSettings({ density: 'compact' }, source.owner);
    const exported = source.domain.exportJournal();

    const target = fixture();
    const report = target.domain.importJournal(exported);
    expect(report.inserted.entries).toBe(exported.entries.length);
    const roundTrip = target.domain.exportJournal();
    expect(roundTrip.entries).toEqual(exported.entries);
    expect(roundTrip.collections).toEqual(exported.collections);
    expect(roundTrip.activity).toEqual(exported.activity);
    expect(roundTrip.summaries).toEqual(exported.summaries);
    expect(roundTrip.settings).toEqual(exported.settings);

    target.domain.updateEntry(created.entry.id, { text: 'Conflicting local row' }, target.owner);
    expect(() => target.domain.importJournal(exported)).toThrowError(/different content/i);
    expect(target.domain.requireEntry(created.entry.id).text).toBe('Conflicting local row');
  });

  it('exports one validated SQLite snapshot while a writer commits between table reads', () => {
    const source = fixture();
    let injected = false;
    const readerDatabase = new JournalDatabase({
      path: join(source.root, 'journal.db'),
      applyMigrations: false,
      readonly: true,
      onStatement: (sql) => {
        if (injected || !/FROM collections/i.test(sql)) return;
        injected = true;
        const filed = source.domain.fileSummary(
          {
            weekStart: '2026-07-27',
            text: 'Committed during the export read.',
            source: 'Concurrent writer export-snapshot fixture.',
          },
          source.agent,
        );
        source.domain.saveSummaryToToday(filed.summary.id, source.owner);
      },
    });
    const reader = new JournalDomain({
      database: readerDatabase,
      config: { timezone: 'UTC', dayBoundaryOffsetMin: 0, deviceCredentialTtlDays: 365 },
      now: () => new Date('2026-07-31T10:00:00.000Z'),
    });
    open.push(reader);

    const exported = reader.exportJournal();
    expect(injected).toBe(true);
    expect(JournalExportSchema.parse(exported)).toEqual(exported);
    expect(exported.entries).toHaveLength(0);
    expect(exported.summaries).toHaveLength(0);
    const target = fixture();
    target.domain.importJournal(exported);
    expect(target.domain.exportJournal()).toMatchObject({
      entries: exported.entries,
      collections: exported.collections,
      activity: exported.activity,
      summaries: exported.summaries,
      settings: exported.settings,
    });
  });

  it('rejects an export whose entry references a missing collection', () => {
    const source = fixture();
    const created = source.domain.createEntry(
      { id: ulid(), text: 'Orphan candidate', type: 'note', date: '2026-07-31' },
      source.owner,
    );
    if (created.kind !== 'entry') throw new Error('Expected entry');
    const exported = source.domain.exportJournal();
    const invalid = {
      ...exported,
      entries: exported.entries.map((entry) => ({ ...entry, collection: 'missing-collection' })),
    };
    const target = fixture();
    expect(() => target.domain.importJournal(invalid)).toThrowError(/missing collection/i);
    expect(target.domain.searchEntries({ limit: 25 }).total).toBe(0);
  });

  it('rejects archived month collections and broken saved-summary references on import', () => {
    const source = fixture();
    const task = source.domain.createEntry(
      { id: ulid(), text: 'Schedule this', type: 'task', date: '2026-07-31' },
      source.owner,
    );
    if (task.kind !== 'entry') throw new Error('Expected entry');
    source.domain.scheduleMonthly(
      task.entry.id,
      { copyId: ulid(), month: '2026-08' },
      source.owner,
    );
    const filed = source.domain.fileSummary(
      {
        weekStart: '2026-07-27',
        text: 'Saved reference integrity.',
        source: 'Weekly synthesis for import validation.',
      },
      source.agent,
    );
    source.domain.saveSummaryToToday(filed.summary.id, source.owner);
    const exported = source.domain.exportJournal();
    const target = fixture();

    const archivedMonth = {
      ...exported,
      collections: exported.collections.map((collection) =>
        collection.id === 'month:2026-08'
          ? { ...collection, archivedAt: '2026-07-31T10:00:00.000Z' }
          : collection,
      ),
    };
    expect(() => target.domain.importJournal(archivedMonth)).toThrowError(/cannot be archived/i);

    const savedId = exported.summaries[0]?.savedEntryId;
    const brokenReference = {
      ...exported,
      entries: exported.entries.map((entry) =>
        entry.id === savedId ? { ...entry, author: 'me' as const, source: null } : entry,
      ),
    };
    expect(() => target.domain.importJournal(brokenReference)).toThrowError(/AI-authored summary/i);
  });
});
