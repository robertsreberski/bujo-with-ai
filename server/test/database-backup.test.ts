import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupAbortedError, JournalDatabase } from '../src/db/database.js';
import { migrations } from '../src/db/migrations.js';
import { BackupManager } from '../src/jobs/backups.js';

const roots: string[] = [];
const migrationVersions = migrations.map((migration) => migration.version);
const futureMigrationVersion = migrationVersions.length + 1;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('JournalDatabase and backups', () => {
  it('applies numbered migrations, enables WAL, and verifies online backups', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-db-test-'));
    roots.push(root);
    const database = new JournalDatabase({
      path: join(root, 'journal.db'),
      backupDir: join(root, 'backups'),
    });
    expect(database.raw.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(
      database.raw.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all(),
    ).toEqual(migrationVersions);
    database.quickCheck();
    const manager = new BackupManager({
      database,
      backupDir: join(root, 'backups'),
      timezone: 'UTC',
      now: () => new Date('2026-08-02T04:00:00.000Z'),
    });
    const result = await manager.run();
    expect(result.daily).toMatch(/journal-2026-08-02\.db$/);
    expect(result.weekly).toMatch(/journal-weekly-2026-08-02\.db$/);
    await manager.verify(result.daily);
    database.close();
    expect(readdirSync(join(root, 'backups'))).toContain('journal-2026-08-02.db');
  });

  it('takes a verified Online Backup API snapshot before migrating an existing database', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-pre-migration-test-'));
    roots.push(root);
    const path = join(root, 'journal.db');
    const legacy = new JournalDatabase({ path, applyMigrations: false });
    legacy.raw.exec(
      "CREATE TABLE legacy_data (value TEXT NOT NULL); INSERT INTO legacy_data VALUES ('kept')",
    );
    legacy.close();

    const migrated = new JournalDatabase({ path, backupDir: join(root, 'backups') });
    expect(migrated.raw.prepare('SELECT value FROM legacy_data').pluck().get()).toBe('kept');
    migrated.close();
    const backups = readdirSync(join(root, 'backups')).filter(
      (name) => name.startsWith('pre-migration-') && name.endsWith('.db'),
    );
    expect(backups).toHaveLength(1);
    const backup = new Database(join(root, 'backups', backups[0]!), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(backup.pragma('quick_check', { simple: true })).toBe('ok');
      expect(backup.prepare('SELECT value FROM legacy_data').pluck().get()).toBe('kept');
    } finally {
      backup.close();
    }
  });

  it('repairs legacy Reflection claims, saved-summary links, and orphan Activity after migrations are recorded', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-reflection-binding-migration-test-'));
    roots.push(root);
    const path = join(root, 'journal.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const recordMigration = legacy.prepare(
      'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    );
    for (const migration of migrations.filter(({ version }) => version <= 4)) {
      legacy.exec(migration.sql);
      recordMigration.run(
        migration.version,
        migration.name,
        createHash('sha256')
          .update(`${migration.version}\0${migration.name}\0${migration.sql}`)
          .digest('hex'),
        '2026-08-03T08:00:00.000Z',
      );
    }
    legacy
      .prepare(
        `INSERT INTO entries(
           id, date, type, text, state, time, tags, author, source, migrations,
           collection, created_at, updated_at, deleted_at, revision
         ) VALUES (?, ?, 'note', ?, 'logged', NULL, ?, 'ai', ?, 0, NULL, ?, ?, ?, 2)`,
      )
      .run(
        '01K1A2B3C4D5E6F7G8H9J0K1M2',
        '2026-07-27',
        'Deleted legacy summary note',
        JSON.stringify(['summary']),
        'Legacy summary fixture.',
        '2026-08-03T08:00:00.000Z',
        '2026-08-03T08:05:00.000Z',
        '2026-08-03T08:05:00.000Z',
      );
    legacy
      .prepare(
        `INSERT INTO summaries(
           id, week_start, text, status, source, token_id, created_at,
           updated_at, saved_entry_id, revision
         ) VALUES (?, ?, ?, 'saved', ?, ?, ?, ?, ?, 7)`,
      )
      .run(
        '01K1A2B3C4D5E6F7G8H9J0K1M5',
        '2026-07-27',
        'Legacy retained Reflection text',
        'Legacy weekly summary fixture.',
        '01K1A2B3C4D5E6F7G8H9J0K1M3',
        '2026-08-03T08:00:00.000Z',
        '2026-08-03T08:05:00.000Z',
        '01K1A2B3C4D5E6F7G8H9J0K1M2',
      );
    const orphanId = '01K1A2B3C4D5E6F7G8H9J0K1MC';
    const orphanActivityId = '01K1A2B3C4D5E6F7G8H9J0K1MD';
    const orphanSnapshot = {
      entity: 'entry',
      id: orphanId,
      row: {
        id: orphanId,
        date: '2026-07-21',
        type: 'note',
        text: 'Legacy orphan content must not survive migration.',
        state: 'logged',
        time: null,
        tags: [],
        author: 'me',
        source: null,
        migrations: 0,
        collection: null,
        dateStated: true,
        createdAt: '2026-07-21T08:00:00.000Z',
        updatedAt: '2026-07-21T08:00:00.000Z',
        revision: 1,
        deletedAt: null,
      },
    };
    legacy
      .prepare(
        `INSERT INTO activity(
           id, at, kind, text, origin, refs, pre_images, post_images,
           reverted_at, reverted_by_activity_id
         ) VALUES (?, ?, 'agent-add', ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        orphanActivityId,
        '2026-07-21T08:00:00.000Z',
        'Added Legacy orphan content must not survive migration.',
        JSON.stringify({ actor: 'mcp', tokenId: '01K1A2B3C4D5E6F7G8H9J0K1ME' }),
        JSON.stringify({ entryIds: [orphanId] }),
        JSON.stringify([{ entity: 'entry', id: orphanId, row: null }]),
        JSON.stringify([orphanSnapshot]),
      );
    const reflectionMigration = migrations.find(({ version }) => version === 5);
    if (reflectionMigration === undefined) throw new Error('Expected migration 005');
    legacy.exec(reflectionMigration.sql);
    recordMigration.run(
      reflectionMigration.version,
      reflectionMigration.name,
      createHash('sha256')
        .update(
          `${reflectionMigration.version}\0${reflectionMigration.name}\0${reflectionMigration.sql}`,
        )
        .digest('hex'),
      '2026-08-03T08:10:00.000Z',
    );
    legacy
      .prepare(
        `INSERT INTO reflection_slots(
           id, week_start, week_end, status, request_id, requested_at,
           claimed_at, claimed_token_id, claimed_label, claimed_tool, failure,
           current_version_id, created_at, updated_at, revision
         ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 2)`,
      )
      .run(
        '01K1A2B3C4D5E6F7G8H9J0K1M9',
        '2026-07-20',
        '2026-07-26',
        '01K1A2B3C4D5E6F7G8H9J0K1MA',
        '2026-08-03T08:15:00.000Z',
        '2026-08-03T08:20:00.000Z',
        '01K1A2B3C4D5E6F7G8H9J0K1MB',
        'Legacy worker',
        'add_entry',
        '2026-08-03T08:15:00.000Z',
        '2026-08-03T08:20:00.000Z',
      );
    const bindingMigration = migrations.find(({ version }) => version === 6);
    if (bindingMigration === undefined) throw new Error('Expected migration 006');
    legacy.exec(bindingMigration.sql);
    recordMigration.run(
      bindingMigration.version,
      bindingMigration.name,
      createHash('sha256')
        .update(`${bindingMigration.version}\0${bindingMigration.name}\0${bindingMigration.sql}`)
        .digest('hex'),
      '2026-08-03T08:30:00.000Z',
    );
    legacy.close();
    chmodSync(path, 0o600);

    const migrated = new JournalDatabase({
      path,
      now: () => new Date('2026-08-03T09:00:00.000Z'),
    });
    expect(
      migrated.raw
        .prepare('SELECT status, saved_entry_id, revision FROM summaries WHERE id = ?')
        .get('01K1A2B3C4D5E6F7G8H9J0K1M5'),
    ).toEqual({ status: 'current', saved_entry_id: null, revision: 8 });
    expect(
      migrated.raw
        .prepare(
          `SELECT status, claimed_at, claimed_token_id, claimed_label,
                  claimed_tool, claimed_source_entries, revision
           FROM reflection_slots WHERE id = ?`,
        )
        .get('01K1A2B3C4D5E6F7G8H9J0K1M9'),
    ).toEqual({
      status: 'queued',
      claimed_at: null,
      claimed_token_id: null,
      claimed_label: null,
      claimed_tool: null,
      claimed_source_entries: null,
      revision: 3,
    });
    const repairedActivity = migrated.raw
      .prepare('SELECT text, pre_images, post_images FROM activity WHERE id = ?')
      .get(orphanActivityId) as {
      text: string;
      pre_images: string;
      post_images: string;
    };
    expect(repairedActivity.text).toBe('Added an entry (content expired)');
    expect(JSON.parse(repairedActivity.pre_images)).toEqual([
      { entity: 'entry', id: orphanId, row: null },
    ]);
    expect(JSON.parse(repairedActivity.post_images)).toEqual([
      { entity: 'entry', id: orphanId, row: null },
    ]);
    expect(JSON.stringify(repairedActivity)).not.toContain('Legacy orphan content');
    expect(migrated.raw.prepare('SELECT max(version) FROM schema_migrations').pluck().get()).toBe(
      migrationVersions.at(-1),
    );
    migrated.close();
  });

  it('restates a filing that named a day, exactly once, and leaves the ambiguous one alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-date-stated-restate-test-'));
    roots.push(root);
    const path = join(root, 'journal.db');
    const first = new JournalDatabase({ path });
    const insert = (into: JournalDatabase, id: string, date: string, createdDay: string) =>
      into.raw
        .prepare(
          `INSERT INTO entries(id,date,type,text,state,time,tags,author,source,migrations,
             collection,date_stated,created_at,updated_at,deleted_at,revision)
           VALUES (?,?,'task',?,'open',NULL,'[]','me',NULL,0,'month:2026-08',0,?,?,NULL,1)`,
        )
        .run(id, date, `Task ${id}`, `${createdDay}T09:00:00.000Z`, `${createdDay}T09:00:00.000Z`);

    // The correction already ran on this fresh database, so seed the pre-fix
    // shape directly and clear its marker to replay the upgrade.
    insert(first, '01K1H0000000000000000STATE', '2026-08-14', '2026-08-02');
    insert(first, '01K1H0000000000000000AMBIG', '2026-08-02', '2026-08-02');
    first.raw.exec('DELETE FROM date_stated_restate_state');
    first.close();

    const upgraded = new JournalDatabase({ path });
    const stated = (id: string) =>
      upgraded.raw.prepare('SELECT date_stated FROM entries WHERE id=?').pluck().get(id);

    // A date the creation day cannot explain was necessarily chosen.
    expect(stated('01K1H0000000000000000STATE')).toBe(1);
    // A date equal to the creation day is indistinguishable from the default.
    expect(stated('01K1H0000000000000000AMBIG')).toBe(0);
    expect(upgraded.raw.prepare('SELECT count(*) c FROM date_stated_restate_state').get()).toEqual({
      c: 1,
    });
    upgraded.close();

    // A deliberate inventory filing made after the correction must survive it.
    const later = new JournalDatabase({ path });
    insert(later, '01K1H0000000000000000AFTER', '2026-08-20', '2026-08-05');
    later.close();
    const reopened = new JournalDatabase({ path });
    expect(
      reopened.raw
        .prepare('SELECT date_stated FROM entries WHERE id=?')
        .pluck()
        .get('01K1H0000000000000000AFTER'),
    ).toBe(0);
    reopened.close();
  });

  it('keeps migrations 004-006 additive-only and moves data healing to writable startup', () => {
    for (const migration of migrations.filter(({ version }) => version >= 4)) {
      expect(migration.sql).toMatch(/^\s*--\s*journal:migration-mode\s+additive(?:\r?\n|$)/i);
      const statements = migration.sql
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\r\n]*/g, ' ')
        .split(';')
        .map((statement) => statement.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement).toMatch(
          /^(?:CREATE (?:UNIQUE )?(?:TABLE|INDEX) (?:IF NOT EXISTS )?|ALTER TABLE [^ ]+ ADD COLUMN )/i,
        );
        expect(statement).not.toMatch(
          /\b(?:DROP|DELETE|UPDATE|INSERT|REPLACE|RENAME|PRAGMA|VACUUM|ATTACH|DETACH)\b/i,
        );
      }
    }

    const root = mkdtempSync(join(tmpdir(), 'journal-startup-reconciliation-test-'));
    roots.push(root);
    const path = join(root, 'journal.db');
    const initial = new JournalDatabase({ path });
    initial.close();

    const raw = new Database(path);
    raw.exec(`
      INSERT INTO summaries(
        id, week_start, text, status, source, token_id, created_at, updated_at,
        saved_entry_id, revision
      ) VALUES (
        '01K1A2B3C4D5E6F7G8H9J0K1N1', '2026-07-13', 'Backfill me', 'current',
        'Legacy startup fixture.', '01K1A2B3C4D5E6F7G8H9J0K1N2',
        '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:00.000Z', NULL, 4
      );
      INSERT INTO reflection_slots(
        id, week_start, week_end, status, request_id, requested_at, claimed_at,
        claimed_token_id, claimed_label, claimed_tool, claimed_source_entries,
        failure, current_version_id, created_at, updated_at, revision
      ) VALUES (
        '01K1A2B3C4D5E6F7G8H9J0K1N3', '2026-07-20', '2026-07-26', 'running',
        '01K1A2B3C4D5E6F7G8H9J0K1N4', '2026-07-27T08:00:00.000Z',
        '2026-07-27T08:01:00.000Z', '01K1A2B3C4D5E6F7G8H9J0K1N5', 'Legacy worker',
        NULL, NULL, NULL, NULL, '2026-07-27T08:00:00.000Z',
        '2026-07-27T08:01:00.000Z', 2
      );
      CREATE TRIGGER fail_legacy_claim_repair
      BEFORE UPDATE OF status ON reflection_slots
      WHEN OLD.status = 'running'
      BEGIN
        SELECT RAISE(ABORT, 'fixture repair failed');
      END;
    `);
    raw.close();

    const readonly = new JournalDatabase({ path, applyMigrations: false, readonly: true });
    expect(
      readonly.raw
        .prepare('SELECT status FROM reflection_slots WHERE week_start = ?')
        .pluck()
        .get('2026-07-20'),
    ).toBe('running');
    readonly.close();

    expect(
      () => new JournalDatabase({ path, now: () => new Date('2026-07-28T09:00:00.000Z') }),
    ).toThrow(/fixture repair failed/i);
    const afterFailure = new Database(path, { readonly: true });
    expect(
      afterFailure
        .prepare('SELECT count(*) FROM reflection_slots WHERE week_start = ?')
        .pluck()
        .get('2026-07-13'),
    ).toBe(0);
    afterFailure.close();

    const removeFailure = new Database(path);
    removeFailure.exec('DROP TRIGGER fail_legacy_claim_repair');
    removeFailure.close();
    const repaired = new JournalDatabase({
      path,
      now: () => new Date('2026-07-28T09:00:00.000Z'),
    });
    expect(
      repaired.raw
        .prepare(
          'SELECT status, current_version_id, revision FROM reflection_slots WHERE week_start = ?',
        )
        .get('2026-07-13'),
    ).toEqual({
      status: 'current',
      current_version_id: '01K1A2B3C4D5E6F7G8H9J0K1N1',
      revision: 4,
    });
    expect(
      repaired.raw
        .prepare('SELECT status, claimed_at, revision FROM reflection_slots WHERE week_start = ?')
        .get('2026-07-20'),
    ).toEqual({ status: 'queued', claimed_at: null, revision: 3 });
    repaired.close();

    const idempotent = new JournalDatabase({
      path,
      now: () => new Date('2026-07-29T09:00:00.000Z'),
    });
    expect(
      idempotent.raw
        .prepare('SELECT revision FROM reflection_slots WHERE week_start = ?')
        .pluck()
        .get('2026-07-20'),
    ).toBe(3);
    idempotent.close();
  });

  it('reconciles rollback-runtime Summary updates, reverts, removals, and refiles without touching native history', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-summary-rollback-reconcile-test-'));
    roots.push(root);
    const path = join(root, 'journal.db');
    const initial = new JournalDatabase({ path });
    const insertSummary = initial.raw.prepare(
      `INSERT INTO summaries(
        id,week_start,text,status,source,token_id,created_at,updated_at,saved_entry_id,revision
       ) VALUES (?,?,?,?,?,?,?,?,NULL,?)`,
    );
    const tokenId = '01K1A2B3C4D5E6F7G8H9J0K2A1';
    insertSummary.run(
      '01K1A2B3C4D5E6F7G8H9J0K2A2',
      '2026-06-01',
      'Original update projection',
      'current',
      'Original update source.',
      tokenId,
      '2026-06-08T08:00:00.000Z',
      '2026-06-08T08:00:00.000Z',
      4,
    );
    insertSummary.run(
      '01K1A2B3C4D5E6F7G8H9J0K2A3',
      '2026-06-08',
      'Remove this projection',
      'current',
      'Removal source.',
      tokenId,
      '2026-06-15T08:00:00.000Z',
      '2026-06-15T08:00:00.000Z',
      2,
    );
    insertSummary.run(
      '01K1A2B3C4D5E6F7G8H9J0K2A4',
      '2026-06-15',
      'Replace this projection',
      'current',
      'Replacement source.',
      tokenId,
      '2026-06-22T08:00:00.000Z',
      '2026-06-22T08:00:00.000Z',
      3,
    );
    insertSummary.run(
      '01K1A2B3C4D5E6F7G8H9J0K2A5',
      '2026-06-22',
      'Native history base',
      'current',
      'Native base source.',
      tokenId,
      '2026-06-29T08:00:00.000Z',
      '2026-06-29T08:00:00.000Z',
      6,
    );
    initial.close();

    const backfilled = new JournalDatabase({
      path,
      now: () => new Date('2026-07-01T09:00:00.000Z'),
    });
    expect(
      backfilled.raw
        .prepare('SELECT count(*) FROM reflection_slots WHERE legacy_summary_id IS NOT NULL')
        .pluck()
        .get(),
    ).toBe(4);
    backfilled.raw
      .prepare(
        `INSERT INTO reflection_versions(
          id,reflection_id,version_number,text,source_from,source_to,generator_token_id,
          generator_label,generator_tool,source,generated_at,source_entries
         ) VALUES (?,?,2,?,?,?,?,?,?,?,?,'[]')`,
      )
      .run(
        '01K1A2B3C4D5E6F7G8H9J0K2A6',
        '01K1A2B3C4D5E6F7G8H9J0K2A5',
        'Native Reflection history',
        '2026-06-22',
        '2026-06-28',
        tokenId,
        'Native assistant',
        'file_summary',
        'Native Reflection source.',
        '2026-07-01T10:00:00.000Z',
      );
    backfilled.raw
      .prepare(
        `UPDATE reflection_slots SET current_version_id=?,status='current',
           updated_at='2026-07-01T10:00:00.000Z',revision=revision+1 WHERE week_start=?`,
      )
      .run('01K1A2B3C4D5E6F7G8H9J0K2A6', '2026-06-22');

    // These are the exact canonical writes the protocol-1 runtime can make
    // while the additive Reflection tables remain dormant.
    backfilled.raw
      .prepare(
        `UPDATE summaries SET text=?,status='stale',source=?,updated_at=?,revision=revision+1
         WHERE week_start='2026-06-01'`,
      )
      .run(
        'Compatibility runtime update',
        'Compatibility update source.',
        '2026-07-02T08:00:00.000Z',
      );
    backfilled.raw.prepare("DELETE FROM summaries WHERE week_start='2026-06-08'").run();
    backfilled.raw.prepare("DELETE FROM summaries WHERE week_start='2026-06-15'").run();
    backfilled.raw
      .prepare(
        `INSERT INTO summaries(
          id,week_start,text,status,source,token_id,created_at,updated_at,saved_entry_id,revision
         ) VALUES (?,?,?,?,?,?,?,?,NULL,?)`,
      )
      .run(
        '01K1A2B3C4D5E6F7G8H9J0K2A7',
        '2026-06-15',
        'Compatibility refile',
        'current',
        'Compatibility refile source.',
        tokenId,
        '2026-07-02T08:05:00.000Z',
        '2026-07-02T08:05:00.000Z',
        1,
      );
    backfilled.raw
      .prepare(
        `UPDATE summaries SET text=?,source=?,updated_at=?,revision=revision+1
         WHERE week_start='2026-06-22'`,
      )
      .run(
        'Compatibility must not replace native history',
        'Compatibility divergent source.',
        '2026-07-02T08:10:00.000Z',
      );
    backfilled.close();

    const upgraded = new JournalDatabase({
      path,
      now: () => new Date('2026-07-03T09:00:00.000Z'),
    });
    expect(
      upgraded.raw
        .prepare(
          `SELECT reflection.status,reflection.current_version_id,reflection.revision,
                  version.text,version.source,version.generated_at
           FROM reflection_slots AS reflection
           JOIN reflection_versions AS version ON version.id=reflection.current_version_id
           WHERE reflection.week_start='2026-06-01'`,
        )
        .get(),
    ).toEqual({
      status: 'stale',
      current_version_id: '01K1A2B3C4D5E6F7G8H9J0K2A2',
      revision: 5,
      text: 'Compatibility runtime update',
      source: 'Compatibility update source.',
      generated_at: '2026-07-02T08:00:00.000Z',
    });
    expect(
      upgraded.raw
        .prepare("SELECT count(*) FROM reflection_slots WHERE week_start='2026-06-08'")
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      upgraded.raw
        .prepare(
          `SELECT id,legacy_summary_id,current_version_id,revision
           FROM reflection_slots WHERE week_start='2026-06-15'`,
        )
        .get(),
    ).toEqual({
      id: '01K1A2B3C4D5E6F7G8H9J0K2A7',
      legacy_summary_id: '01K1A2B3C4D5E6F7G8H9J0K2A7',
      current_version_id: '01K1A2B3C4D5E6F7G8H9J0K2A7',
      revision: 1,
    });
    expect(
      upgraded.raw
        .prepare(
          `SELECT status,current_version_id,revision FROM reflection_slots
           WHERE week_start='2026-06-22'`,
        )
        .get(),
    ).toEqual({
      status: 'current',
      current_version_id: '01K1A2B3C4D5E6F7G8H9J0K2A6',
      revision: 7,
    });
    expect(
      upgraded.raw
        .prepare(
          `SELECT id,text,version_number FROM reflection_versions
           WHERE reflection_id='01K1A2B3C4D5E6F7G8H9J0K2A5' ORDER BY version_number`,
        )
        .all(),
    ).toEqual([
      {
        id: '01K1A2B3C4D5E6F7G8H9J0K2A5',
        text: 'Native history base',
        version_number: 1,
      },
      {
        id: '01K1A2B3C4D5E6F7G8H9J0K2A6',
        text: 'Native Reflection history',
        version_number: 2,
      },
    ]);
    upgraded.close();

    const compatibilityRevert = new Database(path);
    compatibilityRevert
      .prepare(
        `UPDATE summaries SET text=?,status='current',source=?,updated_at=?,revision=revision+1
         WHERE week_start='2026-06-01'`,
      )
      .run('Original update projection', 'Original update source.', '2026-07-01T07:00:00.000Z');
    compatibilityRevert.close();
    const reverted = new JournalDatabase({
      path,
      now: () => new Date('2026-07-05T09:00:00.000Z'),
    });
    expect(
      reverted.raw
        .prepare(
          `SELECT reflection.status,reflection.revision,version.text,version.source
           FROM reflection_slots AS reflection
           JOIN reflection_versions AS version ON version.id=reflection.current_version_id
           WHERE reflection.week_start='2026-06-01'`,
        )
        .get(),
    ).toEqual({
      status: 'current',
      revision: 6,
      text: 'Original update projection',
      source: 'Original update source.',
    });
    reverted.close();
    const beforeIdempotentOpen = readFileSync(path);
    const idempotent = new JournalDatabase({
      path,
      now: () => new Date('2026-07-06T09:00:00.000Z'),
    });
    idempotent.close();
    expect(readFileSync(path)).toEqual(beforeIdempotentOpen);
  });

  it('retro-identifies a v6 synthetic backfill after compatibility writes and the v7 upgrade', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-v6-summary-reconcile-test-'));
    roots.push(root);
    const path = join(root, 'journal.db');
    const v6 = new Database(path);
    v6.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const record = v6.prepare(
      'INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)',
    );
    for (const migration of migrations.filter(({ version }) => version <= 6)) {
      v6.exec(migration.sql);
      record.run(
        migration.version,
        migration.name,
        createHash('sha256')
          .update(`${migration.version}\0${migration.name}\0${migration.sql}`)
          .digest('hex'),
        `2026-07-${String(10 + migration.version).padStart(2, '0')}T08:00:00.000Z`,
      );
    }
    v6.exec(`
      INSERT INTO summaries(
        id,week_start,text,status,source,token_id,created_at,updated_at,saved_entry_id,revision
      ) VALUES
        ('01K1A2B3C4D5E6F7G8H9J0K2B1','2026-05-18','v6 update base','current',
         'v6 update source.','01K1A2B3C4D5E6F7G8H9J0K2B2',
         '2026-05-25T08:00:00.000Z','2026-05-25T08:00:00.000Z',NULL,2),
        ('01K1A2B3C4D5E6F7G8H9J0K2B3','2026-05-25','v6 delete base','current',
         'v6 delete source.','01K1A2B3C4D5E6F7G8H9J0K2B2',
         '2026-06-01T08:00:00.000Z','2026-06-01T08:00:00.000Z',NULL,3);

      INSERT INTO reflection_slots(
        id,week_start,week_end,status,request_id,requested_at,claimed_at,claimed_token_id,
        claimed_label,claimed_tool,claimed_source_entries,failure,current_version_id,
        created_at,updated_at,revision
      )
      SELECT id,week_start,date(week_start,'+6 days'),'current',NULL,NULL,NULL,NULL,NULL,NULL,
             NULL,NULL,id,created_at,updated_at,revision
      FROM summaries;

      INSERT INTO reflection_versions(
        id,reflection_id,version_number,text,source_from,source_to,generator_token_id,
        generator_label,generator_tool,source,generated_at,source_entries
      )
      SELECT id,id,1,text,week_start,date(week_start,'+6 days'),token_id,
             'Legacy assistant',NULL,source,updated_at,'[]'
      FROM summaries;

      UPDATE summaries SET text='compat updated v6 projection',source='compat v6 source.',
        updated_at='2026-07-20T08:00:00.000Z',revision=revision+1
      WHERE id='01K1A2B3C4D5E6F7G8H9J0K2B1';
      DELETE FROM summaries WHERE id='01K1A2B3C4D5E6F7G8H9J0K2B3';
    `);
    v6.close();
    chmodSync(path, 0o600);

    const upgraded = new JournalDatabase({
      path,
      now: () => new Date('2026-07-21T09:00:00.000Z'),
    });
    expect(upgraded.raw.prepare('SELECT max(version) FROM schema_migrations').pluck().get()).toBe(
      migrationVersions.at(-1),
    );
    expect(
      upgraded.raw
        .prepare(
          `SELECT reflection.legacy_summary_id,reflection.revision,version.text,version.source
           FROM reflection_slots AS reflection
           JOIN reflection_versions AS version ON version.id=reflection.current_version_id
           WHERE reflection.id='01K1A2B3C4D5E6F7G8H9J0K2B1'`,
        )
        .get(),
    ).toEqual({
      legacy_summary_id: '01K1A2B3C4D5E6F7G8H9J0K2B1',
      revision: 3,
      text: 'compat updated v6 projection',
      source: 'compat v6 source.',
    });
    expect(
      upgraded.raw
        .prepare("SELECT count(*) FROM reflection_slots WHERE id='01K1A2B3C4D5E6F7G8H9J0K2B3'")
        .pluck()
        .get(),
    ).toBe(0);
    upgraded.close();
  });

  it('verifies an existing named snapshot before reusing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-reused-backup-test-'));
    roots.push(root);
    const database = new JournalDatabase({ path: join(root, 'journal.db') });
    const manager = new BackupManager({
      database,
      backupDir: join(root, 'backups'),
      timezone: 'UTC',
    });
    const at = new Date('2026-08-03T04:00:00.000Z');
    const first = await manager.run(at);
    const reused = await manager.run(at);
    expect(reused.daily).toBe(first.daily);
    await manager.verify(reused.daily);
    database.close();
  });

  it('retains seven daily and four weekly verified snapshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-retention-test-'));
    roots.push(root);
    const database = new JournalDatabase({ path: join(root, 'journal.db') });
    const manager = new BackupManager({
      database,
      backupDir: join(root, 'backups'),
      timezone: 'UTC',
    });
    for (let day = 0; day < 40; day++) {
      await manager.run(new Date(Date.UTC(2026, 0, 1 + day, 4, 0, 0)));
    }
    database.close();
    const names = readdirSync(join(root, 'backups'));
    expect(names.filter((name) => /^journal-\d{4}-\d{2}-\d{2}\.db$/.test(name))).toHaveLength(7);
    expect(
      names.filter((name) => /^journal-weekly-\d{4}-\d{2}-\d{2}\.db$/.test(name)),
    ).toHaveLength(4);
  });

  it('quarantines a corrupt canonical snapshot and atomically replaces it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-corrupt-backup-test-'));
    roots.push(root);
    const database = new JournalDatabase({ path: join(root, 'journal.db') });
    const manager = new BackupManager({
      database,
      backupDir: join(root, 'backups'),
      timezone: 'UTC',
    });
    const at = new Date('2026-08-03T04:00:00.000Z');
    const first = await manager.run(at);
    writeFileSync(first.daily, 'not a sqlite database');
    const repaired = await manager.run(at);
    await manager.verify(repaired.daily);
    const names = readdirSync(join(root, 'backups'));
    expect(names.some((name) => /^journal-2026-08-03\.corrupt-.+\.db$/.test(name))).toBe(true);
    expect(names.some((name) => name.includes('.tmp-'))).toBe(false);
    database.close();
  });

  it('replaces a corrupt canonical symlink without touching its external target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-symlink-backup-test-'));
    roots.push(root);
    const external = join(root, 'unrelated.txt');
    writeFileSync(external, 'do not touch', { mode: 0o644 });
    chmodSync(external, 0o644);
    const database = new JournalDatabase({ path: join(root, 'data', 'journal.db') });
    const manager = new BackupManager({
      database,
      backupDir: join(root, 'data', 'backups'),
      timezone: 'UTC',
    });
    const at = new Date('2026-08-03T04:00:00.000Z');
    const first = await manager.run(at);
    unlinkSync(first.daily);
    symlinkSync(external, first.daily);

    const repaired = await manager.run(at);
    expect(readFileSync(external, 'utf8')).toBe('do not touch');
    expect(statSync(external).mode & 0o777).toBe(0o644);
    expect(lstatSync(repaired.daily).isFile()).toBe(true);
    expect(
      readdirSync(join(root, 'data', 'backups')).some((name) => {
        if (!name.includes('.corrupt-')) return false;
        return lstatSync(join(root, 'data', 'backups', name)).isSymbolicLink();
      }),
    ).toBe(true);
    await manager.verify(repaired.daily);
    database.close();
  });

  it('refuses retention after the configured backup directory is swapped for a symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-retention-symlink-test-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const backupDir = join(dataDir, 'backups');
    const database = new JournalDatabase({ path: join(dataDir, 'journal.db') });
    mkdirSync(backupDir, { mode: 0o700 });
    const manager = new BackupManager({ database, backupDir, timezone: 'UTC' });
    rmSync(backupDir, { recursive: true });
    const external = join(root, 'external');
    mkdirSync(external, { mode: 0o700 });
    for (let day = 1; day <= 8; day++) {
      writeFileSync(join(external, `journal-2026-01-${String(day).padStart(2, '0')}.db`), 'safe');
    }
    symlinkSync(external, backupDir, 'dir');

    await expect(manager.enforceRetention()).rejects.toThrow(/symbolic link/i);
    expect(readdirSync(external)).toHaveLength(8);
    database.close();
  });

  it('creates a fresh unique manual snapshot and proves it can be restored and opened', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-manual-backup-test-'));
    roots.push(root);
    const database = new JournalDatabase({ path: join(root, 'journal.db') });
    database.raw.exec(
      "CREATE TABLE restore_marker(value TEXT); INSERT INTO restore_marker VALUES ('one')",
    );
    const manager = new BackupManager({
      database,
      backupDir: join(root, 'backups'),
      timezone: 'UTC',
      now: () => new Date('2026-08-03T12:00:00.000Z'),
    });
    const first = await manager.createFresh();
    database.raw.prepare("INSERT INTO restore_marker VALUES ('two')").run();
    const second = await manager.createFresh();
    expect(second).not.toBe(first);
    expect(statSync(first).mode & 0o777).toBe(0o600);
    database.close();

    const restored = new JournalDatabase({ path: second });
    expect(
      restored.raw.prepare('SELECT value FROM restore_marker ORDER BY rowid').pluck().all(),
    ).toEqual(['one', 'two']);
    restored.quickCheck();
    restored.close();
  });

  it('catches up the latest due 03:30 schedule before the next 03:30', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-backup-catchup-test-'));
    roots.push(root);
    const database = new JournalDatabase({ path: join(root, 'journal.db') });
    const manager = new BackupManager({
      database,
      backupDir: join(root, 'backups'),
      timezone: 'UTC',
    });
    await manager.run(new Date('2026-07-30T04:00:00.000Z'));
    const restart = new Date('2026-08-01T02:00:00.000Z');
    expect(await manager.isDailyBackupDue(restart)).toBe(true);
    const caughtUp = await manager.run(restart);
    expect(caughtUp.daily).toMatch(/journal-2026-07-31\.db$/);
    expect(await manager.isDailyBackupDue(restart)).toBe(false);
    database.close();
  });

  it('does not let a future-dated snapshot suppress the current backup schedule', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-backup-clock-skew-test-'));
    roots.push(root);
    const database = new JournalDatabase({ path: join(root, 'journal.db') });
    const manager = new BackupManager({
      database,
      backupDir: join(root, 'backups'),
      timezone: 'UTC',
    });
    await manager.run(new Date('2030-01-06T04:00:00.000Z'));
    expect(await manager.isDailyBackupDue(new Date('2026-08-01T04:00:00.000Z'))).toBe(true);
    database.close();
  });

  it('cancels an active online backup so shutdown can drain promptly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-backup-cancel-test-'));
    roots.push(root);
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    const database = {
      backup: async (_target: string, options: { signal?: AbortSignal }) =>
        new Promise<never>((_resolveBackup, rejectBackup) => {
          markStarted?.();
          options.signal?.addEventListener('abort', () => rejectBackup(new BackupAbortedError()), {
            once: true,
          });
        }),
    } as unknown as JournalDatabase;
    const manager = new BackupManager({
      database,
      backupDir: join(root, 'backups'),
      timezone: 'UTC',
    });
    const running = manager.run(new Date('2026-08-03T04:00:00.000Z'));
    await started;
    manager.cancelActive();
    await expect(running).rejects.toBeInstanceOf(BackupAbortedError);
  });

  it('refuses broad existing directories and creates private data and SQLite files', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-private-db-test-'));
    roots.push(root);
    chmodSync(root, 0o755);
    const previousUmask = process.umask(0o022);
    expect(() => new JournalDatabase({ path: join(root, 'journal.db') })).toThrow(
      /must already be owner-private/i,
    );
    expect(statSync(root).mode & 0o777).toBe(0o755);
    const dataDir = join(root, 'journal-data');
    const path = join(dataDir, 'journal.db');
    const firstObservedModes = new Map<string, number>();
    const observeModes = (): void => {
      for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
        if (!firstObservedModes.has(candidate) && existsSync(candidate)) {
          firstObservedModes.set(candidate, statSync(candidate).mode & 0o777);
        }
      }
    };
    try {
      const database = new JournalDatabase({ path, onStatement: observeModes });
      observeModes();
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
        expect(firstObservedModes.get(candidate)).toBe(0o600);
        expect(statSync(candidate).mode & 0o777).toBe(0o600);
      }
      database.close();
    } finally {
      process.umask(previousUmask);
    }

    const raw = new Database(path);
    raw
      .prepare(
        "INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (999,'future','x',?)",
      )
      .run(new Date().toISOString());
    raw.close();
    expect(() => new JournalDatabase({ path })).toThrow(/not a contiguous prefix/i);
    expect(() => new JournalDatabase({ path, applyMigrations: false })).toThrow(
      /not a contiguous prefix/i,
    );
  });

  it('opens a contiguous suffix of future additive migrations but preserves known integrity', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-future-migration-test-'));
    roots.push(root);
    const path = join(root, 'journal.db');
    const initial = new JournalDatabase({ path });
    initial.close();

    const additive = new Database(path);
    additive.exec(
      'CREATE TABLE optional_future_projection (entry_id TEXT PRIMARY KEY, value TEXT)',
    );
    additive
      .prepare('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)')
      .run(
        futureMigrationVersion,
        'optional-future-projection',
        'a'.repeat(64),
        '2026-08-02T10:00:00.000Z',
      );
    additive.close();

    const rollbackRuntime = new JournalDatabase({ path });
    expect(
      rollbackRuntime.raw
        .prepare("SELECT type FROM sqlite_master WHERE name = 'optional_future_projection'")
        .pluck()
        .get(),
    ).toBe('table');
    rollbackRuntime.close();
    const readonlyRollback = new JournalDatabase({ path, applyMigrations: false, readonly: true });
    readonlyRollback.close();

    const tampered = new Database(path);
    tampered
      .prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 2')
      .run('b'.repeat(64));
    tampered.close();
    expect(() => new JournalDatabase({ path })).toThrow(/migration 2.*changed/i);
  });

  it('rejects malformed metadata in a future migration suffix', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-future-metadata-test-'));
    roots.push(root);
    const path = join(root, 'journal.db');
    const initial = new JournalDatabase({ path });
    initial.close();
    const raw = new Database(path);
    raw
      .prepare('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)')
      .run(futureMigrationVersion, 'future', 'not-a-checksum', '2026-08-02T10:00:00.000Z');
    raw.close();
    expect(() => new JournalDatabase({ path })).toThrow(/invalid integrity metadata/i);
  });

  it('survives compatibility to additive to rollback to upgrade with backup restore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-additive-rollback-test-'));
    roots.push(root);
    const path = join(root, 'journal.db');
    const compatibility = new JournalDatabase({ path });
    compatibility.raw.exec(
      "INSERT INTO entries(id,date,type,text,state,time,tags,author,source,migrations,collection,created_at,updated_at,deleted_at,revision) VALUES ('01K1A2B3C4D5E6F7G8H9J0K1M2','2026-08-02','note','Before additive release','logged',NULL,'[]','me',NULL,0,NULL,'2026-08-02T10:00:00.000Z','2026-08-02T10:00:00.000Z',NULL,1)",
    );
    compatibility.close();

    const additive = new Database(path);
    additive.exec(
      "CREATE TABLE optional_future_projection (entry_id TEXT PRIMARY KEY, value TEXT); INSERT INTO optional_future_projection VALUES ('01K1A2B3C4D5E6F7G8H9J0K1M2','derived')",
    );
    additive
      .prepare('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)')
      .run(
        futureMigrationVersion,
        'optional-future-projection',
        'c'.repeat(64),
        '2026-08-02T10:05:00.000Z',
      );
    additive.close();

    const rollback = new JournalDatabase({ path, backupDir: join(root, 'backups') });
    expect(rollback.raw.prepare('SELECT text FROM entries').pluck().get()).toBe(
      'Before additive release',
    );
    const manager = new BackupManager({
      database: rollback,
      backupDir: join(root, 'backups'),
      timezone: 'UTC',
    });
    const backup = await manager.createFresh();
    rollback.close();

    const restoredPath = join(root, 'restored.db');
    const backupBytes = readFileSync(backup);
    writeFileSync(restoredPath, backupBytes, { mode: 0o600 });
    const upgradedAgain = new JournalDatabase({ path: restoredPath });
    expect(
      upgradedAgain.raw.prepare('SELECT value FROM optional_future_projection').pluck().get(),
    ).toBe('derived');
    expect(
      upgradedAgain.raw
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .pluck()
        .all(),
    ).toEqual([...migrationVersions, futureMigrationVersion]);
    upgradedAgain.close();
  });

  it('starts the compiled CLI with only its copied migration assets', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-dist-migration-test-'));
    roots.push(root);
    const source = new JournalDatabase({ path: join(root, 'journal.db') });
    source.close();

    const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    execFileSync('npm', ['run', 'build', '--workspace', '@journal/server'], {
      cwd: repository,
      stdio: 'pipe',
    });
    const output = execFileSync(
      process.execPath,
      [join(repository, 'server/dist/cli.js'), 'check'],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'production',
          JOURNAL_CONFIG: join(root, 'config.json'),
          JOURNAL_DATA_DIR: root,
        },
      },
    );
    expect(output).toBe('ok\n');
    expect(readdirSync(join(repository, 'server/dist/db/migrations')).sort()).toEqual(
      migrations.map((migration) => migration.filename).sort(),
    );
  }, 20_000);
});
