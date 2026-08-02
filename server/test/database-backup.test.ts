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
import { BackupManager } from '../src/jobs/backups.js';

const roots: string[] = [];

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
    ).toEqual([1, 2, 3]);
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

  it('reopens a database after a valid contiguous 004-006 additive suffix', () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-future-migration-test-'));
    roots.push(root);
    const path = join(root, 'journal.db');
    const initial = new JournalDatabase({ path });
    initial.close();

    const future = [
      {
        version: 4,
        name: 'optional-future-projection',
        sql: 'CREATE TABLE optional_future_projection (entry_id TEXT PRIMARY KEY, value TEXT)',
      },
      {
        version: 5,
        name: 'optional-future-index',
        sql: 'CREATE INDEX optional_future_projection_value ON optional_future_projection(value)',
      },
      {
        version: 6,
        name: 'optional-future-note',
        sql: 'ALTER TABLE optional_future_projection ADD COLUMN note TEXT',
      },
    ] as const;
    const additive = new Database(path);
    const record = additive.prepare(
      'INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)',
    );
    for (const migration of future) {
      additive.exec(migration.sql);
      const checksum = createHash('sha256')
        .update(`${migration.version}\0${migration.name}\0${migration.sql}`)
        .digest('hex');
      record.run(migration.version, migration.name, checksum, '2026-08-02T10:00:00.000Z');
    }
    additive.close();

    const rollbackRuntime = new JournalDatabase({ path });
    expect(
      rollbackRuntime.raw
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .pluck()
        .all(),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      rollbackRuntime.raw
        .prepare("SELECT type FROM sqlite_master WHERE name = 'optional_future_projection_value'")
        .pluck()
        .get(),
    ).toBe('index');
    rollbackRuntime.close();

    const readonlyRollback = new JournalDatabase({ path, applyMigrations: false, readonly: true });
    readonlyRollback.close();
  });

  it('rejects gapped or malformed future migration history', () => {
    const createDatabase = (prefix: string): string => {
      const root = mkdtempSync(join(tmpdir(), prefix));
      roots.push(root);
      const path = join(root, 'journal.db');
      const initial = new JournalDatabase({ path });
      initial.close();
      return path;
    };

    const gappedPath = createDatabase('journal-gapped-migration-test-');
    const gapped = new Database(gappedPath);
    gapped
      .prepare('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (5,?,?,?)')
      .run('future-gap', 'a'.repeat(64), '2026-08-02T10:00:00.000Z');
    gapped.close();
    expect(() => new JournalDatabase({ path: gappedPath })).toThrow(/not a contiguous prefix/i);

    const malformedPath = createDatabase('journal-malformed-migration-test-');
    const malformed = new Database(malformedPath);
    malformed
      .prepare('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (4,?,?,?)')
      .run('future-metadata', 'not-a-checksum', '2026-08-02T10:00:00.000Z');
    malformed.close();
    expect(() => new JournalDatabase({ path: malformedPath })).toThrow(
      /invalid integrity metadata/i,
    );
  });

  it('still rejects renamed or changed known migration history', () => {
    const createDatabase = (prefix: string): string => {
      const root = mkdtempSync(join(tmpdir(), prefix));
      roots.push(root);
      const path = join(root, 'journal.db');
      const initial = new JournalDatabase({ path });
      initial.close();
      return path;
    };

    const renamedPath = createDatabase('journal-renamed-migration-test-');
    const renamed = new Database(renamedPath);
    renamed.prepare('UPDATE schema_migrations SET name = ? WHERE version = 1').run('renamed-core');
    renamed.close();
    expect(() => new JournalDatabase({ path: renamedPath })).toThrow(/migration 1.*renamed/i);

    const changedPath = createDatabase('journal-changed-migration-test-');
    const changed = new Database(changedPath);
    changed
      .prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 2')
      .run('b'.repeat(64));
    changed.close();
    expect(() => new JournalDatabase({ path: changedPath })).toThrow(/migration 2.*changed/i);
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
    expect(readdirSync(join(repository, 'server/dist/db/migrations')).sort()).toEqual([
      '001_core.sql',
      '002_fts.sql',
      '003_entry_page.sql',
    ]);
  });
});
