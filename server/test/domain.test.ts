import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { JournalDatabase } from '../src/db/database.js';
import {
  ActivityItemSchema,
  ActivityViewSchema,
  EntrySchema,
  JournalExportSchema,
  type ChangeBatch,
} from '../src/contracts/index.js';
import { DomainError } from '../src/domain/errors.js';
import { JournalDomain } from '../src/domain/journal.js';
import type { ActorContext } from '../src/domain/types.js';

const roots: string[] = [];
const open: JournalDomain[] = [];

afterEach(() => {
  for (const domain of open.splice(0)) domain.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { readonly recoveryRetentionDays?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'journal-domain-test-'));
  roots.push(root);
  let instant = new Date('2026-07-31T10:00:00.000Z');
  const database = new JournalDatabase({ path: join(root, 'journal.db'), now: () => instant });
  const domain = new JournalDomain({
    database,
    config: { timezone: 'UTC', dayBoundaryOffsetMin: 0, deviceCredentialTtlDays: 365 },
    now: () => instant,
    ...(options.recoveryRetentionDays === undefined
      ? {}
      : { recoveryRetentionDays: options.recoveryRetentionDays }),
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

  it('requires revisions for agent updates and deletes at the domain boundary', () => {
    const { domain, owner, agent } = fixture();
    const created = domain.createEntry(
      { id: ulid(), text: 'Revision guarded', type: 'note' },
      owner,
    );
    if (created.kind !== 'entry') throw new Error('Expected entry');
    expect(() =>
      domain.updateEntry(created.entry.id, { text: 'Blind update' }, agent, undefined, {
        reason: 'Attempt an unguarded agent update.',
      }),
    ).toThrowError(/require expectedRevision/i);
    expect(() =>
      domain.deleteEntry(created.entry.id, agent, undefined, {
        reason: 'Attempt an unguarded agent delete.',
      }),
    ).toThrowError(/require expectedRevision/i);
    expect(domain.requireEntry(created.entry.id)).toMatchObject({
      text: 'Revision guarded',
      revision: 1,
      deletedAt: null,
    });
  });

  it('keeps guarded agent edits attributed, reasoned, and reversible', () => {
    const { domain, owner, agent } = fixture();
    const created = domain.createEntry(
      { id: ulid(), text: 'Original owner wording', type: 'note' },
      owner,
    );
    if (created.kind !== 'entry') throw new Error('Expected entry');
    const updated = domain.updateEntry(
      created.entry.id,
      { text: 'Clarified owner wording' },
      { ...agent, tool: 'update_entry' },
      undefined,
      {
        expectedRevision: created.entry.revision,
        reason: 'Clarify the wording requested by the owner.',
      },
    );
    if (!updated.activityId) throw new Error('Expected an attributed activity');
    expect(domain.getActivity(updated.activityId)).toMatchObject({
      origin: { actor: 'mcp', tokenId: agent.tokenId, tool: 'update_entry' },
      text: expect.stringContaining('Clarify the wording requested by the owner.'),
    });
    domain.revertActivity(updated.activityId, owner);
    expect(domain.requireEntry(created.entry.id).text).toBe('Original owner wording');
  });

  it('derives readable co-authorship and a compact Timeline touch from audit records', () => {
    const { domain, owner, advance } = fixture();
    const issued = domain.createAgentToken('Planning agent', ['journal:full'], owner);
    const actor: ActorContext = {
      kind: 'agent',
      tokenId: issued.token.id,
      tokenLabel: issued.token.label,
      tool: 'update_entry',
    };
    const created = domain.createEntry(
      { id: ulid(), text: 'Book the train to Lisbon', type: 'task' },
      owner,
    );
    if (created.kind !== 'entry') throw new Error('Expected entry');
    advance(1_000);
    const updated = domain.updateEntry(created.entry.id, { time: '09:30' }, actor, undefined, {
      expectedRevision: 1,
      reason: 'The itinerary now includes a departure time.',
    });
    if (!updated.activityId) throw new Error('Expected attributed activity');

    expect(domain.activityView(updated.activityId).presentation).toEqual(
      expect.objectContaining({
        actor: expect.objectContaining({ kind: 'agent', label: 'Planning agent' }),
        action: 'updated',
        objectLabel: '“Book the train to Lisbon”',
        primaryEntryId: created.entry.id,
        reason: 'The itinerary now includes a departure time.',
        attribution: [
          expect.objectContaining({
            entryId: created.entry.id,
            originalAuthor: 'owner',
            latestModifier: expect.objectContaining({ label: 'Planning agent' }),
          }),
        ],
        latestAgentTouch: expect.objectContaining({
          activityId: updated.activityId,
          entryId: created.entry.id,
          action: 'updated',
        }),
      }),
    );

    advance(1_000);
    domain.updateEntry(created.entry.id, { text: 'Book the morning train to Lisbon' }, owner);
    // A single historical row cannot prove whether a later revision came from
    // the owner or another agent without an extra unbounded history query.
    expect(
      domain.activityView(updated.activityId).presentation?.attribution[0]?.latestModifier,
    ).toBeNull();
  });

  it('derives forward and reverse entry lineage for a migration and its revert', () => {
    const { domain, owner, agent } = fixture();
    const source = domain.createEntry(
      { id: ulid(), text: 'Prepare launch', type: 'task', date: '2026-07-31' },
      owner,
    );
    if (source.kind !== 'entry') throw new Error('Expected entry');
    const migrated = domain.applyAgentMigration(
      {
        kind: 'split',
        title: 'Turn launch into the next action',
        detail: 'Preserve the source and add one concrete task.',
        ops: [
          {
            op: 'update',
            id: source.entry.id,
            expectedRevision: source.entry.revision,
            patch: { state: 'cancelled' },
          },
          {
            op: 'create',
            entry: {
              text: 'Draft launch checklist',
              type: 'task',
              time: null,
              tags: [],
              collection: null,
              source: 'From launch planning.',
            },
          },
        ],
      },
      agent,
    );
    const createdId = migrated.entries.find((entry) => entry.id !== source.entry.id)?.id;
    if (!createdId) throw new Error('Expected created migration entry');
    expect(domain.activityView(migrated.activityId).presentation?.lineage).toEqual({
      fromEntryIds: [source.entry.id],
      toEntryIds: [createdId],
      relatedActivityId: null,
    });

    const reverted = domain.revertActivity(migrated.activityId, owner);
    expect(domain.activityView(reverted.activity.id).presentation?.lineage).toEqual({
      fromEntryIds: [createdId],
      toEntryIds: [source.entry.id],
      relatedActivityId: migrated.activityId,
    });
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
        ops: [
          {
            op: 'retag',
            from: 'old',
            to: 'new',
            sources: ids.map((id) => ({ id, expectedRevision: 1 })),
          },
        ],
      },
      agent,
    );
    const expected = [...ids].sort().reverse();
    expect(result.entries.map((entry) => entry.id)).toEqual(expected);
    expect(
      domain.getActivity(result.activityId)?.postImages.map((snapshot) => snapshot.id),
    ).toEqual(expected);
    expect(domain.getActivity(result.activityId)?.text).toMatch(/^Applied migration:/);
  });

  it('rejects stale or incomplete retag source sets without changing any entry', () => {
    const { domain, owner, agent } = fixture();
    const first = domain.createEntry(
      { id: ulid(), text: 'First retag source', type: 'note', tags: ['old'] },
      owner,
    );
    const second = domain.createEntry(
      { id: ulid(), text: 'Second retag source', type: 'note', tags: ['old'] },
      owner,
    );
    if (first.kind !== 'entry' || second.kind !== 'entry') throw new Error('Expected entries');

    expect(() =>
      domain.applyAgentMigration(
        {
          kind: 'retag',
          title: 'Rename the old tag',
          detail: 'Reject a source set that was not observed completely.',
          ops: [
            {
              op: 'retag',
              from: 'old',
              to: 'new',
              sources: [{ id: first.entry.id, expectedRevision: first.entry.revision }],
            },
          ],
        },
        agent,
      ),
    ).toThrowError(/source set changed/i);
    expect(domain.requireEntry(first.entry.id).tags).toEqual(['old']);
    expect(domain.requireEntry(second.entry.id).tags).toEqual(['old']);

    const changed = domain.updateEntry(second.entry.id, { text: 'Changed second source' }, owner);
    try {
      domain.applyAgentMigration(
        {
          kind: 'retag',
          title: 'Rename the old tag',
          detail: 'Reject a source whose observed revision became stale.',
          ops: [
            {
              op: 'retag',
              from: 'old',
              to: 'new',
              sources: [
                { id: first.entry.id, expectedRevision: first.entry.revision },
                { id: second.entry.id, expectedRevision: second.entry.revision },
              ],
            },
          ],
        },
        agent,
      );
      throw new Error('Expected a revision conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).details).toEqual({
        expectedRevision: second.entry.revision,
        actualRevision: changed.entry.revision,
      });
    }
    expect(domain.requireEntry(first.entry.id).tags).toEqual(['old']);
    expect(domain.requireEntry(second.entry.id).tags).toEqual(['old']);
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

  it('applies exact-tag and free-text search predicates together', () => {
    const { domain, owner } = fixture();
    const match = domain.createEntry(
      {
        id: ulid(),
        text: 'Plan the Lisbon rail connection',
        type: 'note',
        tags: ['travel'],
        date: '2026-07-31',
      },
      owner,
    );
    domain.createEntry(
      {
        id: ulid(),
        text: 'Plan the Kyoto rail connection',
        type: 'note',
        tags: ['travel'],
        date: '2026-07-31',
      },
      owner,
    );
    domain.createEntry(
      {
        id: ulid(),
        text: 'Plan the Lisbon rail connection',
        type: 'note',
        tags: ['work'],
        date: '2026-07-31',
      },
      owner,
    );
    if (match.kind !== 'entry') throw new Error('Expected matching entry');

    const result = domain.searchEntries({ query: 'Lisbon', tag: 'travel', limit: 25 });
    expect(result).toMatchObject({ total: 1 });
    expect(result.entries.map((entry) => entry.id)).toEqual([match.entry.id]);
  });

  it('matches Unicode case-insensitive substrings', () => {
    const { domain, owner } = fixture();
    domain.createEntry(
      { id: ulid(), text: 'CAFÉ planning', type: 'note', date: '2026-07-31' },
      owner,
    );
    expect(domain.searchEntries({ query: 'afé', limit: 25 }).total).toBe(1);
  });

  it('requires every text needle while keeping Unicode prefix behavior', () => {
    const { domain, owner } = fixture();
    domain.createEntry({ id: ulid(), text: 'Alpha only', type: 'note', date: '2026-07-31' }, owner);
    domain.createEntry({ id: ulid(), text: 'Beta only', type: 'note', date: '2026-07-31' }, owner);
    domain.createEntry(
      { id: ulid(), text: 'Alpha and BÉTA together', type: 'note', date: '2026-07-31' },
      owner,
    );
    const matches = domain.searchEntries({ query: 'alpha beta', limit: 25 });
    expect(matches.total).toBe(1);
    expect(matches.entries[0]?.text).toBe('Alpha and BÉTA together');
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

describe('JournalDomain index aggregates', () => {
  it('assigns each live entry to one month while retaining renamed and archived collections', () => {
    const { domain, owner } = fixture();
    domain.createCollection({ id: 'focus-a', name: 'Focus' }, owner);
    domain.createCollection({ id: 'focus-b', name: 'Focus' }, owner);

    const create = (input: Parameters<JournalDomain['createEntry']>[0]) => {
      const result = domain.createEntry({ id: ulid(), ...input }, owner);
      if (result.kind !== 'entry') throw new Error('Expected entry');
      return result.entry;
    };
    create({ text: 'Daily August note', type: 'note', date: '2026-08-04' });
    create({
      text: 'Archived collection entry',
      type: 'task',
      date: '2026-08-05',
      collection: 'focus-a',
    });
    create({
      text: 'Duplicate-name collection entry',
      type: 'idea',
      date: '2026-09-02',
      collection: 'focus-b',
    });
    create({
      text: 'August destination with a September date',
      type: 'event',
      date: '2026-09-03',
      collection: 'month:2026-08',
    });
    const deleted = create({
      text: 'Deleted row',
      type: 'note',
      date: '2026-08-06',
      collection: 'focus-b',
    });
    domain.deleteEntry(deleted.id, owner);
    domain.updateCollection('focus-a', { name: 'Earlier focus', archived: true }, owner);

    const index = domain.getIndexAggregates();
    expect(index.collections).toEqual([
      expect.objectContaining({ id: 'focus-b', name: 'Focus', archivedAt: null, count: 1 }),
      expect.objectContaining({
        id: 'focus-a',
        name: 'Earlier focus',
        archivedAt: expect.any(String),
        count: 1,
      }),
    ]);
    expect(index.months).toEqual([
      { month: '2026-09', count: 1 },
      { month: '2026-08', count: 3 },
    ]);
    expect(Object.fromEntries(index.types.map((row) => [row.type, row.count]))).toMatchObject({
      task: 1,
      event: 1,
      note: 1,
      idea: 1,
      habit: 0,
    });
  });

  it('persists saved owner queries through settings export and import', () => {
    const source = fixture();
    const savedViews = [
      { id: 'open-work', name: 'Open work', query: 'is:open #work' },
      { id: 'assistant', name: 'From assistant', query: 'by:assistant' },
    ];
    source.domain.setSettings({ savedViews }, source.owner);
    expect(source.domain.getSettings().savedViews).toEqual(savedViews);

    const exported = source.domain.exportJournal();
    const target = fixture();
    target.domain.importJournal(exported);
    expect(target.domain.getSettings().savedViews).toEqual(savedViews);
  });

  it('rejects invalid saved-view grammar at settings and import write boundaries', () => {
    const source = fixture();
    expect(() =>
      source.domain.setSettings(
        {
          savedViews: [{ id: 'broken', name: 'Broken', query: 'by:nobody' }],
        },
        source.owner,
      ),
    ).toThrowError(/Saved view broken has an invalid query.*by:me or by:assistant/i);
    expect(source.domain.getSettings().savedViews).toEqual([]);

    const exported = source.domain.exportJournal();
    const target = fixture();
    expect(() =>
      target.domain.importJournal({
        ...exported,
        journal: {
          ...exported.journal,
          settings: {
            ...exported.journal.settings,
            savedViews: [{ id: 'broken-import', name: 'Broken import', query: 'is:done' }],
          },
        },
      }),
    ).toThrowError(/Saved view broken-import has an invalid query.*is:open/i);
    expect(target.domain.searchEntries({ limit: 25 }).total).toBe(0);
  });
});

describe('JournalDomain weekly Reflections', () => {
  it('persists an explicit request lifecycle, version provenance, staleness, failure, and restore', () => {
    const { domain, owner, agent } = fixture();
    const firstSource = domain.createEntry(
      { id: ulid(), date: '2026-07-20', type: 'note', text: 'Started the week deliberately' },
      owner,
    );
    const secondSource = domain.createEntry(
      { id: ulid(), date: '2026-07-24', type: 'note', text: 'Closed the week calmly' },
      owner,
    );
    if (firstSource.kind !== 'entry' || secondSource.kind !== 'entry') {
      throw new Error('Expected owner entries');
    }

    const [slot] = domain.listReflections('2026-07-20', '2026-07-26');
    expect(slot).toMatchObject({
      weekStart: '2026-07-20',
      weekEnd: '2026-07-26',
      status: 'notRequested',
      revision: 1,
      versions: [],
    });
    if (!slot) throw new Error('Expected completed-week Reflection slot');

    const queued = domain.requestReflection(slot.id, owner, {
      expectedRevision: slot.revision,
    }).reflection;
    expect(queued).toMatchObject({ status: 'queued', revision: 2 });
    expect(queued.requestId).toEqual(expect.any(String));
    // With no assistant claim, a durable request remains honestly queued.
    expect(domain.getReflection(slot.id)?.status).toBe('queued');
    if (!queued.requestId) throw new Error('Expected durable request id');

    const claimed = domain.createEntry(
      {
        text: 'Claim Reflection request',
        type: 'note',
        tags: ['summary'],
        source: 'Weekly Reflection worker.',
        summaryWeekStart: slot.weekStart,
        reflectionAction: 'claim',
        reflectionRequestId: queued.requestId,
      },
      agent,
      { id: 'reflection-claim-1' },
    );
    expect(claimed.kind).toBe('reflection');
    if (claimed.kind !== 'reflection') throw new Error('Expected Reflection claim');
    expect(claimed.reflection).toMatchObject({
      status: 'running',
      claimedBy: { tokenId: agent.tokenId, label: 'test-agent', tool: 'add_entry' },
    });

    const completed = domain.createEntry(
      {
        text: 'A deliberate start made the calm close possible.',
        type: 'note',
        tags: ['summary'],
        source: 'Synthesized only from the requested weekly range.',
        summaryWeekStart: slot.weekStart,
        reflectionAction: 'complete',
        reflectionRequestId: queued.requestId,
      },
      agent,
      { id: 'reflection-complete-1' },
    );
    expect(completed.kind).toBe('reflection');
    if (completed.kind !== 'reflection') throw new Error('Expected completed Reflection');
    expect(completed.reflection).toMatchObject({ status: 'current', revision: 4 });
    expect(completed.reflection.currentVersion).toMatchObject({
      number: 1,
      sourceFrom: '2026-07-20',
      sourceTo: '2026-07-26',
      generator: {
        tokenId: agent.tokenId,
        label: 'test-agent',
        tool: 'add_entry',
        source: 'Synthesized only from the requested weekly range.',
      },
      sourceEntries: expect.arrayContaining([
        { id: firstSource.entry.id, revision: 1 },
        { id: secondSource.entry.id, revision: 1 },
      ]),
    });
    expect(
      domain.searchEntries({ query: 'deliberate start made the calm close', limit: 25 }).total,
    ).toBe(0);

    domain.updateEntry(
      firstSource.entry.id,
      { text: 'Started the week with a revised plan' },
      owner,
    );
    const stale = domain.getReflection(slot.id);
    expect(stale?.status).toBe('stale');
    if (!stale) throw new Error('Expected stale Reflection');

    const rewrite = domain.requestReflection(slot.id, owner, {
      expectedRevision: stale.revision,
    }).reflection;
    expect(rewrite.status).toBe('queued');
    expect(rewrite.versions).toHaveLength(1);
    if (!rewrite.requestId) throw new Error('Expected rewrite request id');
    domain.claimReflection(slot.weekStart, rewrite.requestId, agent);
    const failed = domain.failReflection(
      {
        weekStart: slot.weekStart,
        requestId: rewrite.requestId,
        reason: 'Generator timed out before producing text.',
      },
      agent,
    ).reflection;
    expect(failed).toMatchObject({
      status: 'failed',
      failure: 'Generator timed out before producing text.',
    });
    const retried = domain.retryReflection(slot.id, owner, {
      expectedRevision: failed.revision,
    }).reflection;
    expect(retried.status).toBe('queued');
    if (!retried.requestId) throw new Error('Expected retry request id');
    domain.claimReflection(slot.weekStart, retried.requestId, agent);
    const rewritten = domain.completeReflection(
      {
        weekStart: slot.weekStart,
        requestId: retried.requestId,
        text: 'The revised plan still led to a calm close.',
        source: 'Second bounded weekly synthesis.',
      },
      agent,
    ).reflection;
    expect(rewritten.status).toBe('current');
    expect(rewritten.versions.map((version) => version.number)).toEqual([2, 1]);

    const prior = rewritten.versions.find((version) => version.number === 1);
    if (!prior) throw new Error('Expected prior version');
    const restored = domain.restoreReflectionVersion(slot.id, prior.id, owner, {
      expectedRevision: rewritten.revision,
    }).reflection;
    expect(restored.currentVersionId).toBe(prior.id);
    expect(restored.status).toBe('stale');
    expect(() =>
      domain.restoreReflectionVersion(slot.id, rewritten.versions[0]!.id, owner, {
        expectedRevision: rewritten.revision,
      }),
    ).toThrowError(/changed since revision/i);

    domain.deleteEntry(secondSource.entry.id, owner);
    const afterDelete = domain.getReflection(slot.id);
    expect(afterDelete?.currentVersion?.sourceEntries).toContainEqual({
      id: secondSource.entry.id,
      revision: 1,
    });
    const ownerReflection = domain.createEntry(
      {
        id: ulid(),
        date: slot.weekEnd,
        type: 'note',
        text: 'My own reflection remains an ordinary journal note.',
      },
      owner,
    );
    expect(ownerReflection.kind).toBe('entry');
    if (ownerReflection.kind === 'entry') expect(ownerReflection.entry.author).toBe('me');
  });

  it('binds a claim to exact source revisions and requires a fresh claim after an edit', () => {
    const { domain, owner, agent } = fixture();
    const source = domain.createEntry(
      {
        id: ulid(),
        date: '2026-07-22',
        type: 'note',
        text: 'Initial Reflection source text.',
      },
      owner,
    );
    if (source.kind !== 'entry') throw new Error('Expected Reflection source entry');
    const slot = domain.listReflections('2026-07-20', '2026-07-26')[0];
    if (slot === undefined) throw new Error('Expected completed-week Reflection slot');
    const queued = domain.requestReflection(slot.id, owner, {
      expectedRevision: slot.revision,
    }).reflection;
    if (queued.requestId === null) throw new Error('Expected Reflection request id');
    const claimed = domain.claimReflection(slot.weekStart, queued.requestId, agent).reflection;
    expect(claimed).toMatchObject({
      status: 'running',
      claimedSourceEntries: [{ id: source.entry.id, revision: source.entry.revision }],
    });

    const edited = domain.updateEntry(
      source.entry.id,
      { text: 'Edited after the first claim.' },
      owner,
      undefined,
      { expectedRevision: source.entry.revision },
    ).entry;
    expect(domain.getReflection(slot.id)).toMatchObject({
      status: 'queued',
      requestId: queued.requestId,
      claimedAt: null,
      claimedBy: null,
      claimedSourceEntries: null,
    });
    expect(() =>
      domain.completeReflection(
        {
          weekStart: slot.weekStart,
          requestId: queued.requestId!,
          text: 'This completion was synthesized before the edit.',
          source: 'Stale claim-time source binding fixture.',
        },
        agent,
      ),
    ).toThrowError(/not claimed|sources changed/i);

    domain.claimReflection(slot.weekStart, queued.requestId, agent);
    const completed = domain.completeReflection(
      {
        weekStart: slot.weekStart,
        requestId: queued.requestId,
        text: 'This completion uses the edited source.',
        source: 'Fresh claim-time source binding fixture.',
      },
      agent,
    ).reflection;
    expect(completed).toMatchObject({ status: 'current', claimedSourceEntries: null });
    expect(completed.currentVersion?.sourceEntries).toEqual([
      { id: source.entry.id, revision: edited.revision },
    ]);
  });

  it.each([
    {
      label: 'date edit',
      move: (domain: JournalDomain, id: string, owner: ActorContext) =>
        domain.updateEntry(id, { date: '2026-07-23' }, owner),
    },
    {
      label: 'collection filing',
      move: (domain: JournalDomain, id: string, owner: ActorContext) =>
        domain.fileEntry(id, 'moved-notes', owner, undefined, { filingDate: '2026-07-23' }),
    },
  ])('invalidates source and destination Reflections after a cross-week $label', ({ move }) => {
    const { domain, owner, agent } = fixture();
    domain.createCollection({ id: 'moved-notes', name: 'Moved notes' }, owner);
    const source = domain.createEntry(
      { id: ulid(), date: '2026-07-14', type: 'note', text: 'Source week entry' },
      owner,
    );
    domain.createEntry(
      { id: ulid(), date: '2026-07-22', type: 'note', text: 'Destination week entry' },
      owner,
    );
    if (source.kind !== 'entry') throw new Error('Expected source entry');
    for (const weekStart of ['2026-07-13', '2026-07-20']) {
      domain.fileSummary(
        {
          weekStart,
          text: `Current Reflection for ${weekStart}.`,
          source: 'Cross-week invalidation fixture.',
        },
        agent,
      );
    }
    expect(
      domain
        .listReflections('2026-07-13', '2026-07-26')
        .map((reflection) => [reflection.weekStart, reflection.status]),
    ).toEqual([
      ['2026-07-20', 'current'],
      ['2026-07-13', 'current'],
    ]);

    move(domain, source.entry.id, owner);

    expect(
      domain
        .listReflections('2026-07-13', '2026-07-26')
        .map((reflection) => [reflection.weekStart, reflection.status]),
    ).toEqual([
      ['2026-07-20', 'stale'],
      ['2026-07-13', 'stale'],
    ]);
    expect(domain.listSummaries().map((summary) => [summary.weekStart, summary.status])).toEqual([
      ['2026-07-20', 'stale'],
      ['2026-07-13', 'stale'],
    ]);
  });

  it('uses the configured journal timezone before completing a week boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-reflection-timezone-test-'));
    roots.push(root);
    let instant = new Date('2026-08-03T06:30:00.000Z');
    const database = new JournalDatabase({ path: join(root, 'journal.db'), now: () => instant });
    const domain = new JournalDomain({
      database,
      config: {
        timezone: 'America/Los_Angeles',
        dayBoundaryOffsetMin: 0,
        deviceCredentialTtlDays: 365,
      },
      now: () => instant,
    });
    open.push(domain);
    domain.createEntry(
      {
        id: ulid(),
        date: '2026-07-28',
        type: 'note',
        text: 'A source entry near the journal time-zone boundary.',
      },
      { kind: 'owner', deviceId: ulid() },
    );

    expect(domain.today()).toBe('2026-08-02');
    expect(domain.listReflections('2026-07-27', '2026-08-02')).toEqual([]);
    instant = new Date('2026-08-03T07:30:00.000Z');
    expect(domain.today()).toBe('2026-08-03');
    expect(domain.listReflections('2026-07-27', '2026-08-02')).toMatchObject([
      { weekStart: '2026-07-27', weekEnd: '2026-08-02', status: 'notRequested' },
    ]);
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

  it('detaches a saved summary when its note is deleted and saves a replacement from the repaired revision', () => {
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
    const changes: ChangeBatch[] = [];
    const unsubscribe = domain.subscribe((change) => changes.push(change));
    domain.deleteEntry(first.entry.id, owner, undefined, {
      expectedRevision: first.entry.revision,
    });
    unsubscribe();

    const repaired = domain.getSummary(first.summary.id);
    expect(repaired).toMatchObject({
      status: 'stale',
      savedEntryId: null,
      revision: first.summary.revision + 1,
    });
    expect(() => JournalExportSchema.parse(domain.exportJournal())).not.toThrow();
    expect(changes.flatMap((batch) => batch.changes.map((change) => change.kind))).toEqual(
      expect.arrayContaining(['entry.deleted', 'summary.changed']),
    );
    if (repaired === null) throw new Error('Expected repaired summary');

    const replacement = domain.saveSummaryToToday(first.summary.id, owner, undefined, {
      expectedRevision: repaired.revision,
    });

    expect(replacement.entry.id).not.toBe(first.entry.id);
    expect(replacement.entry.deletedAt).toBeNull();
    expect(replacement.summary.savedEntryId).toBe(replacement.entry.id);
  });

  it('detaches a saved summary when its note loses the summary tag', () => {
    const { domain, agent, owner } = fixture();
    const filed = domain.fileSummary(
      {
        weekStart: '2026-07-27',
        text: 'A tagged summary note.',
        source: 'Weekly synthesis for the saved-note mutation test.',
      },
      agent,
    );
    const saved = domain.saveSummaryToToday(filed.summary.id, owner);

    domain.updateEntry(saved.entry.id, { tags: [] }, owner, undefined, {
      expectedRevision: saved.entry.revision,
    });

    expect(domain.getSummary(saved.summary.id)).toMatchObject({
      status: 'stale',
      savedEntryId: null,
      revision: saved.summary.revision + 1,
    });
    expect(() => JournalExportSchema.parse(domain.exportJournal())).not.toThrow();
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

  it('persists narrow agent scopes and keeps journal:full tokens compatible', () => {
    const { domain, owner } = fixture();
    const reader = domain.createAgentToken('reader', ['timeline:read'], owner);
    expect(reader.token.scopes).toEqual(['timeline:read']);
    expect(domain.authenticateAgent(reader.secret)?.scopes).toEqual(['timeline:read']);

    const legacy = domain.createAgentToken('legacy', undefined, owner);
    expect(legacy.token.scopes).toEqual(['journal:full']);
    expect(domain.authenticateAgent(legacy.secret)?.scopes).toEqual(['journal:full']);
    expect(() => domain.createAgentToken('unknown', ['journal:everything'], owner)).toThrowError(
      /unknown agent token scope/i,
    );
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

  it('uses one configured retention policy for listing, restore, and purge', () => {
    const { domain, owner, advance } = fixture({ recoveryRetentionDays: 45 });
    const created = domain.createEntry(
      { id: ulid(), text: 'Extended recovery row', type: 'note', date: '2026-07-31' },
      owner,
    );
    if (created.kind !== 'entry') throw new Error('Expected entry');
    const deleted = domain.deleteEntry(created.entry.id, owner);

    advance(31 * 86_400_000);
    expect(domain.listRecentlyDeleted()).toHaveLength(1);
    expect(domain.purgeExpired().entries).toBe(0);
    domain.restoreEntry(created.entry.id, owner, undefined, {
      expectedRevision: deleted.entry.revision,
    });

    domain.deleteEntry(created.entry.id, owner);
    advance(45 * 86_400_000 + 1);
    expect(domain.listRecentlyDeleted()).toEqual([]);
    expect(() => domain.restoreEntry(created.entry.id, owner)).toThrowError(/45-day recovery/i);
    expect(domain.purgeExpired().entries).toBe(1);
  });

  it('rejects per-operation retention overrides that could make recovery disagree', () => {
    const { domain, owner, advance } = fixture();
    const created = domain.createEntry(
      { id: ulid(), text: 'One recovery policy', type: 'note', date: '2026-07-31' },
      owner,
    );
    if (created.kind !== 'entry') throw new Error('Expected entry');
    const deleted = domain.deleteEntry(created.entry.id, owner);
    advance(31 * 86_400_000);

    expect(() => domain.listRecentlyDeleted(60)).toThrowError(/configured as 30/i);
    expect(() => domain.purgeExpired(60)).toThrowError(/configured as 30/i);
    expect(() =>
      domain.restoreEntry(created.entry.id, owner, undefined, {
        expectedRevision: deleted.entry.revision,
        retentionDays: 60,
      }),
    ).toThrowError(/configured as 30/i);
  });

  it('describes recovery destinations, reopens archives, and falls back from missing collections', () => {
    const { domain, database, owner } = fixture();
    domain.createCollection({ id: 'archive-me', name: 'Archive me' }, owner);
    const created = domain.createEntry(
      {
        id: ulid(),
        text: 'Restore with destination context',
        type: 'note',
        date: '2026-07-31',
        collection: 'archive-me',
      },
      owner,
    );
    if (created.kind !== 'entry') throw new Error('Expected entry');

    const firstDelete = domain.deleteEntry(created.entry.id, owner);
    domain.updateCollection('archive-me', { archived: true }, owner);
    expect(domain.listRecentlyDeleted()).toMatchObject([
      {
        entry: { id: created.entry.id },
        destination: {
          collectionId: 'archive-me',
          collectionName: 'Archive me',
          status: 'archived',
        },
      },
    ]);
    const reopened = domain.restoreEntry(created.entry.id, owner, undefined, {
      expectedRevision: firstDelete.entry.revision,
    });
    expect(reopened.entry.collection).toBe('archive-me');
    expect(domain.getCollection('archive-me')?.archivedAt).toBeNull();

    const secondDelete = domain.deleteEntry(created.entry.id, owner);
    database.raw.prepare('DELETE FROM collections WHERE id = ?').run('archive-me');
    expect(domain.listRecentlyDeleted()[0]?.destination).toEqual({
      collectionId: 'archive-me',
      collectionName: null,
      status: 'missing',
    });
    const fallback = domain.restoreEntry(created.entry.id, owner, undefined, {
      expectedRevision: secondDelete.entry.revision,
    });
    expect(fallback).toMatchObject({
      entry: { collection: null, date: '2026-07-31' },
      fallbackFromCollection: 'archive-me',
    });
  });

  it('redacts expired entry content from audit snapshots without weakening revert safety', () => {
    const { domain, database, agent, advance } = fixture();
    const sentinel = 'Private expired recovery text';
    const created = domain.createEntry(
      {
        id: ulid(),
        text: sentinel,
        type: 'note',
        date: '2026-07-31',
        source: 'Recovery retention fixture.',
      },
      agent,
    );
    if (created.kind !== 'entry' || created.activityId === undefined)
      throw new Error('Expected agent entry activity');
    const deleted = domain.deleteEntry(created.entry.id, agent, undefined, {
      expectedRevision: created.entry.revision,
      reason: 'Retention fixture cleanup.',
    });
    if (deleted.activityId === undefined) throw new Error('Expected agent delete activity');

    // Legacy/imported audit rows may retain the entry only in their snapshots.
    // Purge must discover both the create post-image and delete pre-image even
    // when refs.entryIds is absent.
    database.raw
      .prepare('UPDATE activity SET refs = ? WHERE id IN (?, ?)')
      .run('{"entryIds":[]}', created.activityId, deleted.activityId);

    advance(30 * 86_400_000 + 1);
    expect(domain.purgeExpired().entries).toBe(1);
    const activities = domain.listActivityViews();
    expect(JSON.stringify(activities)).not.toContain(sentinel);
    for (const activity of activities) {
      expect(activity.text).toMatch(/content expired/i);
      expect(activity.revert).toEqual({ eligible: false, reason: 'not_reversible' });
      expect(
        [...activity.preImages, ...activity.postImages]
          .filter((snapshot) => snapshot.entity === 'entry')
          .every((snapshot) => snapshot.row === null),
      ).toBe(true);
    }
    expect(() => domain.revertActivity(deleted.activityId!, agent)).toThrowError(/expired/i);
  });

  it('redacts Activity for omitted entries across export and legacy raw import replays', () => {
    const source = fixture();
    const sentinel = 'Portable audit content must expire outside its entry tombstone';
    const created = source.domain.createEntry(
      {
        id: ulid(),
        text: sentinel,
        type: 'note',
        date: '2026-07-31',
        source: 'Portable retention fixture.',
      },
      source.agent,
    );
    if (created.kind !== 'entry') throw new Error('Expected agent entry');
    const legacyRaw = source.domain.exportJournal();
    source.domain.deleteEntry(created.entry.id, source.owner, undefined, {
      expectedRevision: created.entry.revision,
    });

    const portable = source.domain.exportJournal();
    expect(portable.journal.entries).toEqual([]);
    expect(JSON.stringify(portable)).not.toContain(sentinel);
    expect(source.domain.importJournal(portable).skipped.activity).toBe(
      portable.journal.activity.length,
    );

    const legacyOrphan = {
      ...legacyRaw,
      journal: { ...legacyRaw.journal, entries: [] },
    };
    const target = fixture();
    expect(target.domain.importJournal(legacyOrphan).inserted.activity).toBe(
      legacyOrphan.journal.activity.length,
    );
    expect(target.domain.importJournal(legacyOrphan).skipped.activity).toBe(
      legacyOrphan.journal.activity.length,
    );
    const reexported = target.domain.exportJournal();
    expect(JSON.stringify(reexported)).not.toContain(sentinel);
    expect(reexported.journal.activity).toEqual(portable.journal.activity.slice(0, 1));
    target.advance(31 * 86_400_000);
    expect(target.domain.purgeExpired().entries).toBe(0);
    expect(JSON.stringify(target.domain.exportJournal())).not.toContain(sentinel);
  });

  it('scrubs expired content from durable idempotency responses without re-executing', () => {
    const { domain, database, owner, advance } = fixture();
    const sentinel = 'Private content must not survive in replay storage';
    const input = {
      id: ulid(),
      text: sentinel,
      type: 'note' as const,
      date: '2026-07-31',
      tags: ['private'],
    };
    const created = domain.createEntry(input, owner, {
      id: 'expiring-create-replay',
      statusCode: 201,
    });
    if (created.kind !== 'entry') throw new Error('Expected entry');
    domain.deleteEntry(
      created.entry.id,
      owner,
      { id: 'expiring-delete-replay' },
      { expectedRevision: created.entry.revision },
    );
    const before = database.raw
      .prepare(
        `SELECT mutation_id, request_hash, status_code, result FROM processed_mutations
         ORDER BY mutation_id`,
      )
      .all() as Array<{
      mutation_id: string;
      request_hash: string;
      status_code: number;
      result: string;
    }>;
    expect(JSON.stringify(before)).toContain(sentinel);

    advance(30 * 86_400_000 + 1);
    expect(domain.purgeExpired()).toMatchObject({ entries: 1, mutations: 2 });
    const after = database.raw
      .prepare(
        `SELECT mutation_id, request_hash, status_code, result FROM processed_mutations
         ORDER BY mutation_id`,
      )
      .all() as Array<{
      mutation_id: string;
      request_hash: string;
      status_code: number;
      result: string;
    }>;
    expect(
      after.map(({ mutation_id, request_hash, status_code }) => ({
        mutation_id,
        request_hash,
        status_code,
      })),
    ).toEqual(
      before.map(({ mutation_id, request_hash, status_code }) => ({
        mutation_id,
        request_hash,
        status_code,
      })),
    );
    expect(JSON.stringify(after)).not.toContain(sentinel);
    expect(after.every((row) => row.result.includes('Content expired'))).toBe(true);

    const replay = domain.createEntry(input, owner, {
      id: 'expiring-create-replay',
      statusCode: 201,
    });
    expect(replay).toMatchObject({
      kind: 'entry',
      entry: { id: input.id, text: 'Content expired', tags: [], deletedAt: expect.any(String) },
    });
    if (replay.kind !== 'entry') throw new Error('Expected entry replay');
    expect(() => EntrySchema.parse(replay.entry)).not.toThrow();
    expect(domain.getEntry(input.id, { includeDeleted: true })).toBeNull();
    expect(() =>
      domain.createEntry({ ...input, text: 'A different request' }, owner, {
        id: 'expiring-create-replay',
      }),
    ).toThrowError(/different request/i);
  });

  it('scrubs expired Activity replay text and its derived presentation atomically', () => {
    const { domain, database, owner, agent, advance } = fixture();
    const originalText = 'Original safe wording';
    const sentinel = 'Private reverted text must expire from mutation replay';
    const created = domain.createEntry(
      {
        id: ulid(),
        text: originalText,
        type: 'note',
        date: '2026-07-31',
        source: 'Activity replay retention fixture.',
      },
      agent,
    );
    if (created.kind !== 'entry') throw new Error('Expected entry');
    const updated = domain.updateEntry(created.entry.id, { text: sentinel }, agent, undefined, {
      expectedRevision: created.entry.revision,
      reason: 'Exercise Activity replay retention.',
    });
    if (updated.activityId === undefined) throw new Error('Expected update activity');
    const reverted = domain.revertActivity(updated.activityId, owner, {
      id: 'expiring-revert-replay',
      statusCode: 200,
    });
    expect(JSON.stringify(reverted)).toContain(sentinel);
    domain.deleteEntry(created.entry.id, owner);

    const before = database.raw
      .prepare(
        `SELECT request_hash, status_code, result FROM processed_mutations
         WHERE mutation_id = ?`,
      )
      .get('expiring-revert-replay') as {
      request_hash: string;
      status_code: number;
      result: string;
    };
    expect(before.result).toContain(sentinel);
    advance(30 * 86_400_000 + 1);

    expect(domain.purgeExpired()).toMatchObject({ entries: 1, mutations: 1 });
    const after = database.raw
      .prepare(
        `SELECT request_hash, status_code, result FROM processed_mutations
         WHERE mutation_id = ?`,
      )
      .get('expiring-revert-replay') as {
      request_hash: string;
      status_code: number;
      result: string;
    };
    expect(after).toMatchObject({
      request_hash: before.request_hash,
      status_code: before.status_code,
    });
    expect(after.result).not.toContain(sentinel);
    expect(after.result).not.toContain(originalText);
    expect(after.result).toContain('content expired');

    const replay = domain.revertActivity(updated.activityId, owner, {
      id: 'expiring-revert-replay',
      statusCode: 200,
    });
    expect(() => ActivityItemSchema.parse(replay.activity)).not.toThrow();
    expect(replay.activity.text).toMatch(/content expired/i);
    expect(
      [...replay.activity.preImages, ...replay.activity.postImages, ...replay.reverted]
        .filter((snapshot) => snapshot.entity === 'entry')
        .every((snapshot) => snapshot.row === null),
    ).toBe(true);
    const replayView = domain.activityView(replay.activity);
    expect(() => ActivityViewSchema.parse(replayView)).not.toThrow();
    expect(JSON.stringify(replayView)).not.toContain(sentinel);
    expect(JSON.stringify(replayView)).not.toContain(originalText);
    expect(replayView.presentation?.reason).toBeNull();
    expect(domain.getEntry(created.entry.id, { includeDeleted: true })).toBeNull();
    expect(() =>
      domain.revertActivity(ulid(), owner, {
        id: 'expiring-revert-replay',
        statusCode: 200,
      }),
    ).toThrowError(/different request/i);
  });

  it('reconciles current Reflection and Summary state after a merge import', () => {
    const target = fixture();
    target.domain.createEntry(
      {
        id: ulid(),
        text: 'Existing source for the current Reflection',
        type: 'note',
        date: '2026-07-21',
      },
      target.owner,
    );
    const filed = target.domain.fileSummary(
      {
        weekStart: '2026-07-20',
        text: 'Current before historical merge.',
        source: 'Merge import staleness fixture.',
      },
      target.agent,
    );
    const beforeReflection = target.domain.listReflections('2026-07-20', '2026-07-26')[0];
    if (beforeReflection === undefined) throw new Error('Expected current Reflection');
    expect(beforeReflection.status).toBe('current');
    expect(filed.summary.status).toBe('current');

    const source = fixture();
    const imported = source.domain.createEntry(
      {
        id: ulid(),
        text: 'Historical source arriving through merge import',
        type: 'note',
        date: '2026-07-23',
      },
      source.owner,
    );
    if (imported.kind !== 'entry') throw new Error('Expected imported entry');

    const report = target.domain.importJournal(source.domain.exportJournal());

    expect(report.inserted.entries).toBe(1);
    expect(target.domain.requireEntry(imported.entry.id).text).toBe(imported.entry.text);
    expect(target.domain.getReflection(beforeReflection.id)).toMatchObject({
      status: 'stale',
      revision: beforeReflection.revision + 1,
    });
    expect(target.domain.getSummary(filed.summary.id)).toMatchObject({
      status: 'stale',
      revision: filed.summary.revision + 1,
    });
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
    expect(report.inserted.entries).toBe(exported.journal.entries.length);
    expect(report.inserted.reflections).toBe(exported.derived.reflections.items.length);
    const roundTrip = target.domain.exportJournal();
    expect(roundTrip.journal.entries).toEqual(exported.journal.entries);
    expect(roundTrip.journal.collections).toEqual(exported.journal.collections);
    expect(roundTrip.journal.activity).toEqual(exported.journal.activity);
    expect(roundTrip.journal.summaries).toEqual(exported.journal.summaries);
    expect(roundTrip.journal.settings).toEqual(exported.journal.settings);
    expect(roundTrip.derived.reflections).toEqual(exported.derived.reflections);
    const importedReflection = exported.derived.reflections.items[0];
    if (importedReflection === undefined) throw new Error('Expected portable Reflection');
    expect(target.domain.getReflection(importedReflection.id)).toEqual(importedReflection);
    expect(target.domain.importJournal(exported).skipped.reflections).toBe(
      exported.derived.reflections.items.length,
    );

    target.domain.updateEntry(created.entry.id, { text: 'Conflicting local row' }, target.owner);
    expect(() => target.domain.importJournal(exported)).toThrowError(/different content/i);
    expect(target.domain.requireEntry(created.entry.id).text).toBe('Conflicting local row');
  });

  it('requeues an imported running Reflection without portable agent credentials', () => {
    const source = fixture();
    source.domain.createEntry(
      { id: ulid(), text: 'Claimed portable source', type: 'note', date: '2026-07-22' },
      source.owner,
    );
    const slot = source.domain.listReflections('2026-07-20', '2026-07-26')[0];
    if (slot === undefined) throw new Error('Expected Reflection slot');
    const queued = source.domain.requestReflection(slot.id, source.owner, {
      expectedRevision: slot.revision,
    }).reflection;
    if (queued.requestId === null) throw new Error('Expected Reflection request');
    const running = source.domain.claimReflection(
      slot.weekStart,
      queued.requestId,
      source.agent,
    ).reflection;
    const exported = source.domain.exportJournal();
    const legacyExport = structuredClone(exported);
    const legacyRunning = legacyExport.derived.reflections.items[0];
    if (legacyRunning === undefined) throw new Error('Expected exported running Reflection');
    delete (legacyRunning as { claimedSourceEntries?: unknown }).claimedSourceEntries;

    const target = fixture();
    target.domain.importJournal(legacyExport);
    const imported = target.domain.getReflection(running.id);
    expect(imported).toMatchObject({
      status: 'queued',
      requestId: queued.requestId,
      claimedAt: null,
      claimedBy: null,
      claimedSourceEntries: null,
      revision: running.revision + 1,
    });
    expect(target.domain.importJournal(legacyExport).skipped.reflections).toBe(1);
    expect(
      target.domain.claimReflection(slot.weekStart, queued.requestId, target.agent).reflection,
    ).toMatchObject({ status: 'running', claimedBy: { tokenId: target.agent.tokenId } });
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
    expect(exported.journal.entries).toHaveLength(0);
    expect(exported.journal.summaries).toHaveLength(0);
    const target = fixture();
    target.domain.importJournal(exported);
    expect(target.domain.exportJournal()).toMatchObject({
      journal: exported.journal,
    });
  });

  it('imports flat v1 and enveloped v2 exports while ignoring unknown derived projections', () => {
    const source = fixture();
    source.domain.createEntry(
      { id: ulid(), text: 'Portable across export versions', type: 'note', date: '2026-07-31' },
      source.owner,
    );
    const v2 = source.domain.exportJournal();
    const legacySettings = { ...v2.journal.settings };
    delete legacySettings.savedViews;
    const v1 = {
      version: 1 as const,
      exportedAt: v2.exportedAt,
      ...v2.journal,
      settings: legacySettings,
    };

    const fromV1 = fixture();
    expect(fromV1.domain.importJournal(v1).inserted.entries).toBe(1);
    expect(fromV1.domain.getSettings().savedViews).toEqual([]);
    const fromV2 = fixture();
    expect(
      fromV2.domain.importJournal({
        ...v2,
        derived: {
          'entry-titles': [{ entryId: ulid(), title: 'Ignored Future Projection' }],
          unknownOptionalField: { nested: true },
        },
      }).inserted.entries,
    ).toBe(1);
    expect(fromV2.domain.exportJournal().journal).toEqual(fromV1.domain.exportJournal().journal);
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
      journal: {
        ...exported.journal,
        entries: exported.journal.entries.map((entry) => ({
          ...entry,
          collection: 'missing-collection',
        })),
      },
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
      journal: {
        ...exported.journal,
        collections: exported.journal.collections.map((collection) =>
          collection.id === 'month:2026-08'
            ? { ...collection, archivedAt: '2026-07-31T10:00:00.000Z' }
            : collection,
        ),
      },
    };
    expect(() => target.domain.importJournal(archivedMonth)).toThrowError(/cannot be archived/i);

    const savedId = exported.journal.summaries[0]?.savedEntryId;
    const brokenReference = {
      ...exported,
      journal: {
        ...exported.journal,
        entries: exported.journal.entries.map((entry) =>
          entry.id === savedId ? { ...entry, author: 'me' as const, source: null } : entry,
        ),
      },
    };
    expect(() => target.domain.importJournal(brokenReference)).toThrowError(/AI-authored summary/i);
  });
});
