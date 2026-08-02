import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { JournalDatabase } from '../src/db/database.js';
import { WriterLease } from '../src/jobs/writer-lease.js';

const roots: string[] = [];
const repository = resolve(import.meta.dirname, '../..');
const cli = join(repository, 'server/src/cli.ts');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(root: string, args: readonly string[]): string {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      JOURNAL_CONFIG: join(root, 'config.json'),
      JOURNAL_DATA_DIR: root,
    },
  };
  return execFileSync(process.execPath, ['--import', 'tsx', cli, ...args], options);
}

describe('journald CLI durability boundaries', () => {
  it('writes overwritten exports privately and creates a new manual backup per invocation', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-cli-private-'));
    roots.push(root);
    const database = new JournalDatabase({ path: join(root, 'journal.db') });
    database.close();
    const destination = join(root, 'journal-export.json');
    writeFileSync(destination, 'old', { mode: 0o644 });
    chmodSync(destination, 0o644);

    expect(run(root, ['export', destination]).trim()).toBe(destination);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    const first = run(root, ['backup']).trim();
    const second = run(root, ['backup']).trim();
    expect(second).not.toBe(first);
    expect(statSync(first).mode & 0o777).toBe(0o600);
    expect(statSync(second).mode & 0o777).toBe(0o600);
    expect(run(root, ['help'])).toContain('journald backup [destination]');
  });

  it('imports flat v1 and enveloped v2 files through the CLI', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'journal-cli-export-source-'));
    const v1Root = mkdtempSync(join(tmpdir(), 'journal-cli-import-v1-'));
    const v2Root = mkdtempSync(join(tmpdir(), 'journal-cli-import-v2-'));
    roots.push(sourceRoot, v1Root, v2Root);
    const database = new JournalDatabase({ path: join(sourceRoot, 'journal.db') });
    database.raw.exec(
      `INSERT INTO entries(
        id,date,type,text,state,time,tags,author,source,migrations,collection,
        created_at,updated_at,deleted_at,revision
      ) VALUES (
        '01K1A2B3C4D5E6F7G8H9J0K1M2','2026-08-02','note','Portable CLI row','logged',
        NULL,'[]','me',NULL,0,NULL,'2026-08-02T10:00:00.000Z',
        '2026-08-02T10:00:00.000Z',NULL,1
      )`,
    );
    database.close();

    const v2Path = join(sourceRoot, 'journal-v2.json');
    run(sourceRoot, ['export', v2Path]);
    const v2 = JSON.parse(readFileSync(v2Path, 'utf8')) as {
      version: 2;
      exportedAt: string;
      journal: Record<string, unknown> & { entries: unknown[] };
      derived: Record<string, unknown>;
    };
    v2.derived = { futureProjection: [{ ignored: true }] };
    writeFileSync(v2Path, `${JSON.stringify(v2)}\n`, { mode: 0o600 });
    const v2Report = JSON.parse(run(v2Root, ['import', v2Path])) as {
      inserted: { entries: number };
    };
    expect(v2Report.inserted.entries).toBe(1);

    const v1Path = join(sourceRoot, 'journal-v1.json');
    writeFileSync(
      v1Path,
      `${JSON.stringify({ version: 1, exportedAt: v2.exportedAt, ...v2.journal })}\n`,
      { mode: 0o600 },
    );
    const v1Report = JSON.parse(run(v1Root, ['import', v1Path])) as {
      inserted: { entries: number };
    };
    expect(v1Report.inserted.entries).toBe(1);
    expect(JSON.parse(run(v1Root, ['export', '-'])).journal.entries).toEqual(
      JSON.parse(run(v2Root, ['export', '-'])).journal.entries,
    );
  });

  it('refuses import and seed under a live writer but permits live-safe commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-cli-lease-'));
    roots.push(root);
    const database = new JournalDatabase({ path: join(root, 'journal.db') });
    database.raw.exec(
      'DROP INDEX idx_entries_page; DELETE FROM schema_migrations WHERE version >= 3',
    );
    database.close();
    const exportPath = join(root, 'export.json');
    run(root, ['export', exportPath]);
    const live = new Database(join(root, 'journal.db'));
    live.pragma('journal_mode = WAL');
    live.exec("CREATE TABLE live_marker(value TEXT); INSERT INTO live_marker VALUES ('present')");
    const databasePath = join(root, 'journal.db');
    const walPath = `${databasePath}-wal`;
    const databaseBefore = statSync(databasePath);
    const walBefore = readFileSync(walPath);
    const lease = await WriterLease.acquire(root, 'serve');
    try {
      for (const args of [
        ['import', exportPath],
        ['seed', '--demo'],
      ]) {
        expect(() => run(root, args)).toThrow(/writer is already active/i);
      }
      expect(run(root, ['export', '-'])).toContain('"version": 2');
      expect(run(root, ['check'])).toBe('ok\n');
      const target = join(root, 'live-safe.db');
      expect(run(root, ['backup', target]).trim()).toBe(target);
      expect(statSync(target).size).toBeGreaterThan(0);
      expect(readFileSync(walPath)).toEqual(walBefore);
      expect(statSync(databasePath)).toMatchObject({
        size: databaseBefore.size,
        mtimeMs: databaseBefore.mtimeMs,
      });
      expect(live.prepare('SELECT max(version) FROM schema_migrations').pluck().get()).toBe(2);
      expect(
        live
          .prepare(
            "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_entries_page'",
          )
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      await lease.release();
      live.close();
    }
    const inspected = new Database(join(root, 'journal.db'), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(inspected.prepare('SELECT max(version) FROM schema_migrations').pluck().get()).toBe(2);
      expect(
        inspected
          .prepare(
            "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_entries_page'",
          )
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      inspected.close();
    }
  });

  it('does not create or accept a missing or table-less journal for live-safe commands', () => {
    const missingRoot = mkdtempSync(join(tmpdir(), 'journal-cli-missing-'));
    roots.push(missingRoot);
    for (const args of [['check'], ['backup'], ['export', '-']]) {
      expect(() => run(missingRoot, args)).toThrow(/database does not exist/i);
      expect(readdirSync(missingRoot)).toEqual([]);
    }

    const emptyRoot = mkdtempSync(join(tmpdir(), 'journal-cli-empty-'));
    roots.push(emptyRoot);
    const emptyPath = join(emptyRoot, 'journal.db');
    new Database(emptyPath).close();
    const before = readFileSync(emptyPath);
    for (const args of [['check'], ['backup'], ['export', '-']]) {
      expect(() => run(emptyRoot, args)).toThrow(/not a migrated Journal database/i);
      expect(readFileSync(emptyPath)).toEqual(before);
      expect(existsSync(join(emptyRoot, 'backups'))).toBe(false);
    }

    const damagedRoot = mkdtempSync(join(tmpdir(), 'journal-cli-damaged-schema-'));
    roots.push(damagedRoot);
    const damaged = new JournalDatabase({ path: join(damagedRoot, 'journal.db') });
    damaged.raw.exec('DROP TABLE entries');
    damaged.close();
    for (const args of [['check'], ['backup'], ['export', '-']]) {
      expect(() => run(damagedRoot, args)).toThrow(/missing required table: entries/i);
    }
    expect(existsSync(join(damagedRoot, 'backups'))).toBe(false);
  });

  it('refuses export and backup destinations that alias Journal control files', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-cli-control-path-'));
    roots.push(root);
    const databasePath = join(root, 'journal.db');
    const database = new JournalDatabase({ path: databasePath });
    database.close();
    const before = readFileSync(databasePath);

    expect(() => run(root, ['export', databasePath])).toThrow(/control path/i);
    expect(() => run(root, ['backup', databasePath])).toThrow(/control path/i);
    expect(() => run(root, ['backup', `${databasePath}-wal`])).toThrow(/control path/i);
    expect(readFileSync(databasePath)).toEqual(before);

    const hardLink = join(root, 'journal-hard-link');
    linkSync(databasePath, hardLink);
    expect(() => run(root, ['export', hardLink])).toThrow(/hard-linked Journal control path/i);
    expect(readFileSync(databasePath)).toEqual(before);
    const inspected = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      expect(inspected.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      inspected.close();
    }
  });

  it('canonicalizes ancestor symlinks before protecting backup, log, and control paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-cli-ancestor-alias-'));
    roots.push(root);
    const databasePath = join(root, 'journal.db');
    const database = new JournalDatabase({ path: databasePath });
    database.close();
    const backup = run(root, ['backup']).trim();
    const backupBefore = readFileSync(backup);

    const backupAlias = join(root, 'backup-alias');
    symlinkSync(join(root, 'backups'), backupAlias, 'dir');
    expect(() => run(root, ['export', join(backupAlias, basename(backup))])).toThrow(
      /backup path/i,
    );
    expect(() => run(root, ['export', join(backupAlias, 'not-created-yet.json')])).toThrow(
      /backup path/i,
    );
    expect(readFileSync(backup)).toEqual(backupBefore);

    const logDir = join(root, 'logs');
    mkdirSync(logDir, { mode: 0o700 });
    const logAlias = join(root, 'log-alias');
    symlinkSync(logDir, logAlias, 'dir');
    expect(() => run(root, ['export', join(logAlias, 'nested.json')])).toThrow(/log path/i);

    const dataAlias = join(root, 'data-alias');
    symlinkSync(root, dataAlias, 'dir');
    expect(() => run(root, ['export', join(dataAlias, 'journal.db')])).toThrow(/control path/i);
    const finalAlias = join(root, 'final-alias.json');
    symlinkSync(databasePath, finalAlias);
    expect(() => run(root, ['export', finalAlias])).toThrow(/symbolic-link output path/i);

    const inspected = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      expect(inspected.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      inspected.close();
    }
  });
});
