import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { DomainError } from '../domain/errors.js';
import { normalizeJournalSearchText } from '../domain/search-query.js';
import { ensurePrivateDirectory } from '../private-path.js';
import { migrations, type Migration } from './migrations.js';

export interface JournalDatabaseOptions {
  readonly path: string;
  readonly backupDir?: string;
  readonly now?: () => Date;
  readonly applyMigrations?: boolean;
  readonly readonly?: boolean;
  readonly onStatement?: (sql: string) => void;
}

export interface CheckpointResult {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

export interface DatabaseBackupOptions {
  readonly signal?: AbortSignal;
  readonly beforeReplace?: () => Promise<(() => Promise<void>) | undefined>;
}

export class BackupAbortedError extends Error {
  public constructor() {
    super('Journal backup was cancelled for shutdown');
    this.name = 'BackupAbortedError';
  }
}

interface MigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
}

interface SchemaObjectRow {
  readonly type: string;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export class JournalDatabase {
  public readonly raw: Database.Database;
  public readonly path: string;
  private readonly now: () => Date;
  private readonly backupDir?: string;
  private readonly readonlyMode: boolean;
  private closed = false;

  public constructor(options: JournalDatabaseOptions) {
    this.path = resolve(options.path);
    this.now = options.now ?? (() => new Date());
    this.readonlyMode = options.readonly === true;
    if (options.backupDir !== undefined) this.backupDir = resolve(options.backupDir);
    if (this.readonlyMode && options.applyMigrations !== false) {
      throw new Error('Readonly journal connections must disable migrations');
    }
    const expectedIdentity = this.readonlyMode
      ? (assertReadableDatabasePath(this.path), undefined)
      : preparePrivateDatabasePath(this.path);
    this.raw = new Database(this.path, {
      ...(this.readonlyMode ? { readonly: true, fileMustExist: true } : {}),
      ...(options.onStatement === undefined
        ? {}
        : { verbose: (message?: unknown) => options.onStatement?.(String(message ?? '')) }),
    });
    try {
      if (expectedIdentity !== undefined) assertSameFile(this.path, expectedIdentity);
      this.raw.function('unicode_lower', { deterministic: true }, unicodeLower);
      this.raw.function('journal_search_normalize', { deterministic: true }, (value: unknown) =>
        normalizeJournalSearchText(String(value ?? '')),
      );
      if (!this.readonlyMode) {
        this.raw.pragma('journal_mode = WAL');
        this.raw.pragma('synchronous = NORMAL');
      }
      this.raw.pragma('foreign_keys = ON');
      this.raw.pragma('busy_timeout = 5000');
      this.raw.pragma('trusted_schema = OFF');
      if (options.applyMigrations !== false) this.migrate();
      else this.validateMigrationHistory(this.readonlyMode);
      this.quickCheck();
      if (!this.readonlyMode) this.hardenDatabaseFiles();
    } catch (error) {
      try {
        this.raw.close();
      } finally {
        this.closed = true;
      }
      throw error;
    }
  }

  public migrate(): readonly number[] {
    this.assertOpen();
    if (this.readonlyMode) throw new Error('Cannot migrate a readonly journal database');
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const byVersion = this.validateMigrationHistory();
    const pending = migrations.filter((migration) => !byVersion.has(migration.version));
    if (pending.length === 0) return [];
    const userTableCount = (
      this.raw
        .prepare(
          `SELECT count(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'`,
        )
        .get() as { count: number }
    ).count;
    if (userTableCount > 0 && this.backupDir !== undefined) this.preMigrationBackup();

    const apply = this.raw.transaction((migration: Migration): void => {
      this.raw.exec(migration.sql);
      this.raw
        .prepare(
          'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          migration.version,
          migration.name,
          migrationChecksum(migration),
          this.now().toISOString(),
        );
    });
    for (const migration of pending) apply(migration);
    return pending.map((migration) => migration.version);
  }

  private validateMigrationHistory(requireJournalSchema = false): Map<number, string> {
    const tableExists = this.raw
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (tableExists === undefined) {
      if (requireJournalSchema) {
        throw new DomainError('INTEGRITY_ERROR', 'File is not a migrated Journal database');
      }
      return new Map();
    }
    validateMigrationDefinitions();
    const applied = this.raw
      .prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')
      .all() as MigrationRow[];
    const byVersion = new Map(applied.map((row) => [row.version, row.checksum]));
    if (applied.length === 0 && requireJournalSchema) {
      throw new DomainError(
        'INTEGRITY_ERROR',
        'Journal migration history is not a contiguous known prefix',
      );
    }
    if (applied.some((row, index) => row.version !== index + 1)) {
      throw new DomainError(
        'INTEGRITY_ERROR',
        'Journal migration history is not a contiguous prefix',
      );
    }

    for (const [index, migration] of migrations.entries()) {
      const row = applied[index];
      if (row === undefined) break;
      const checksum = migrationChecksum(migration);
      if (row.name !== migration.name) {
        throw new DomainError(
          'INTEGRITY_ERROR',
          `Migration ${migration.version} was renamed after it was applied`,
        );
      }
      if (row.checksum !== checksum) {
        throw new DomainError(
          'INTEGRITY_ERROR',
          `Migration ${migration.version} (${migration.name}) was changed after it was applied`,
        );
      }
    }

    for (const row of applied) validateMigrationRow(row);

    if (requireJournalSchema) this.validateAppliedSchema(byVersion);

    return byVersion;
  }

  private validateAppliedSchema(applied: ReadonlyMap<number, string>): void {
    const required = [
      ...[
        'entries',
        'collections',
        'summaries',
        'activity',
        'agent_tokens',
        'device_tokens',
        'settings',
        'processed_mutations',
      ].map((name) => ({ version: 1, type: 'table', name })),
      { version: 2, type: 'table', name: 'entries_fts' },
      { version: 2, type: 'trigger', name: 'entries_fts_insert' },
      { version: 2, type: 'trigger', name: 'entries_fts_delete' },
      { version: 2, type: 'trigger', name: 'entries_fts_update' },
      { version: 3, type: 'index', name: 'idx_entries_page' },
      { version: 5, type: 'table', name: 'reflection_slots' },
      { version: 5, type: 'table', name: 'reflection_versions' },
      { version: 5, type: 'index', name: 'idx_reflection_slots_week' },
      { version: 5, type: 'index', name: 'idx_reflection_versions_slot' },
    ] as const;
    const lookup = this.raw.prepare('SELECT type FROM sqlite_master WHERE name = ?');
    for (const object of required) {
      if (!applied.has(object.version)) continue;
      const row = lookup.get(object.name) as SchemaObjectRow | undefined;
      if (row?.type !== object.type) {
        throw new DomainError(
          'INTEGRITY_ERROR',
          `Journal schema is missing required ${object.type}: ${object.name}`,
        );
      }
    }
  }

  public quickCheck(): void {
    this.assertOpen();
    const rows = this.raw.pragma('quick_check') as { quick_check: string }[];
    const failures = rows.map((row) => row.quick_check).filter((result) => result !== 'ok');
    if (failures.length > 0) {
      throw new DomainError('INTEGRITY_ERROR', 'SQLite quick_check failed', {
        details: { failures },
      });
    }
  }

  public checkpoint(
    mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'TRUNCATE',
  ): CheckpointResult {
    this.assertOpen();
    if (this.readonlyMode) throw new Error('Cannot checkpoint a readonly journal database');
    return this.checkpointWithin(mode, 250, true);
  }

  public async backup(target: string, options: DatabaseBackupOptions = {}): Promise<string> {
    this.assertOpen();
    throwIfBackupAborted(options.signal);
    const resolved = resolve(target);
    mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(resolved), `.${basename(resolved)}.tmp-${randomUUID()}`);
    let rollbackReplacement: (() => Promise<void>) | undefined;
    try {
      createPrivateEmptyFile(temporary);
      await this.raw.backup(temporary, {
        progress: (info) => {
          throwIfBackupAborted(options.signal);
          return Math.max(1, Math.min(128, info.remainingPages));
        },
      });
      throwIfBackupAborted(options.signal);
      chmodPrivateFile(temporary);
      const check = new Database(temporary, { fileMustExist: true });
      try {
        check.pragma('journal_mode = DELETE');
        const rows = check.pragma('quick_check') as { quick_check: string }[];
        if (rows.some((row) => row.quick_check !== 'ok')) {
          throw new DomainError('INTEGRITY_ERROR', `Backup verification failed: ${resolved}`);
        }
      } finally {
        check.close();
      }
      await cleanupSidecars(temporary);
      throwIfBackupAborted(options.signal);
      rollbackReplacement = await options.beforeReplace?.();
      await cleanupSidecars(resolved);
      await rename(temporary, resolved);
      rollbackReplacement = undefined;
      chmodPrivateFile(resolved);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      await cleanupSidecars(temporary);
      await rollbackReplacement?.().catch(() => undefined);
      throw error;
    }
    return resolved;
  }

  public close(): void {
    if (this.closed) return;
    if (this.readonlyMode) {
      this.raw.close();
      this.closed = true;
      return;
    }
    try {
      // A reader may legitimately pin the WAL. Keep shutdown bounded and let
      // SQLite retain the recoverable WAL when TRUNCATE cannot complete.
      this.checkpointWithin('TRUNCATE', 250, false);
    } finally {
      try {
        this.raw.close();
      } finally {
        this.closed = true;
        this.hardenDatabaseFiles();
      }
    }
  }

  private preMigrationBackup(): void {
    if (this.backupDir === undefined || !existsSync(this.path)) return;
    ensurePrivateDirectory(this.backupDir, 'backup');
    const stamp = this.now().toISOString().replaceAll(':', '').replaceAll('.', '');
    const target = join(
      this.backupDir,
      `pre-migration-${stamp}-${randomUUID()}-${basename(this.path)}`,
    );
    const temporary = join(this.backupDir, `.${basename(target)}.tmp-${randomUUID()}`);
    createPrivateEmptyFile(temporary);
    const modulePath = createRequire(import.meta.url).resolve('better-sqlite3');
    const helper = `
      const Database = require(process.argv[1]);
      (async () => {
        const source = new Database(process.argv[2], { readonly: true, fileMustExist: true });
        try { await source.backup(process.argv[3]); } finally { source.close(); }
        const copy = new Database(process.argv[3], { fileMustExist: true });
        try {
          copy.pragma('journal_mode = DELETE');
          const rows = copy.pragma('quick_check');
          if (rows.some((row) => row.quick_check !== 'ok')) throw new Error('quick_check failed');
        } finally { copy.close(); }
      })().catch((error) => { console.error(error.message); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ['-e', helper, modulePath, this.path, temporary], {
      encoding: 'utf8',
      maxBuffer: 1_000_000,
    });
    if (result.error !== undefined || result.status !== 0) {
      tryUnlink(temporary);
      throw new DomainError('INTEGRITY_ERROR', 'Pre-migration online backup failed', {
        details: {
          stderr: result.stderr.trim(),
          status: result.status,
          error: result.error?.message,
        },
      });
    }
    try {
      chmodPrivateFile(temporary);
      renameSync(temporary, target);
      chmodPrivateFile(target);
    } catch (error) {
      tryUnlink(temporary);
      throw error;
    }
  }

  private hardenDatabaseFiles(): void {
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(path)) chmodPrivateFile(path);
    }
  }

  private checkpointWithin(
    mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE',
    timeoutMs: number,
    restoreTimeout: boolean,
  ): CheckpointResult {
    const previousTimeout = Number(this.raw.pragma('busy_timeout', { simple: true }));
    this.raw.pragma(`busy_timeout = ${timeoutMs}`);
    try {
      const rows = this.raw.pragma(`wal_checkpoint(${mode})`) as CheckpointResult[];
      const result = rows[0];
      if (
        result === undefined ||
        !Number.isInteger(result.busy) ||
        !Number.isInteger(result.log) ||
        !Number.isInteger(result.checkpointed)
      ) {
        throw new DomainError('INTEGRITY_ERROR', 'SQLite returned an invalid checkpoint result');
      }
      this.hardenDatabaseFiles();
      return result;
    } finally {
      if (restoreTimeout) this.raw.pragma(`busy_timeout = ${previousTimeout}`);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Journal database is closed');
  }
}

function throwIfBackupAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new BackupAbortedError();
}

function unicodeLower(value: unknown): string {
  return String(value ?? '')
    .normalize('NFC')
    .toLocaleLowerCase('und');
}

function preparePrivateDatabasePath(path: string): FileIdentity {
  ensurePrivateDirectory(dirname(path), 'data');
  try {
    const descriptor = openSync(path, 'wx', 0o600);
    closeSync(descriptor);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`Journal database path must be a private regular file: ${path}`);
  }
  chmodPrivateFile(path);
  return { dev: metadata.dev, ino: metadata.ino };
}

function assertReadableDatabasePath(path: string): void {
  if (!existsSync(path)) throw new Error(`Journal database does not exist: ${path}`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`Journal database must be a real file: ${path}`);
  }
}

function chmodPrivateFile(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`Refusing non-private file: ${path}`);
  }
  chmodSync(path, 0o600);
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error(`Unable to restrict file permissions: ${path}`);
  }
}

function createPrivateEmptyFile(path: string): void {
  const descriptor = openSync(path, 'wx', 0o600);
  closeSync(descriptor);
  chmodPrivateFile(path);
}

function assertSameFile(path: string, expected: FileIdentity): void {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.dev !== expected.dev ||
    metadata.ino !== expected.ino
  ) {
    throw new Error(`Journal database changed while it was being opened: ${path}`);
  }
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

async function cleanupSidecars(path: string): Promise<void> {
  await Promise.all(
    [`${path}-wal`, `${path}-shm`].map(async (sidecar) => {
      await unlink(sidecar).catch((error: unknown) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      });
    }),
  );
}

export function openJournalDatabase(options: JournalDatabaseOptions): JournalDatabase {
  return new JournalDatabase(options);
}

const MIGRATION_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIGRATION_CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

function validateMigrationDefinitions(): void {
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    const expectedFilename = `${String(expectedVersion).padStart(3, '0')}_${migration.name.replaceAll('-', '_')}.sql`;
    if (
      migration.version !== expectedVersion ||
      !MIGRATION_NAME_PATTERN.test(migration.name) ||
      migration.filename !== expectedFilename ||
      migration.sql.trim().length === 0
    ) {
      throw new DomainError(
        'INTEGRITY_ERROR',
        `Runtime migration ${migration.version} has an invalid append-only definition`,
      );
    }
  }
}

function validateMigrationRow(row: MigrationRow): void {
  const appliedAt = new Date(row.applied_at);
  if (
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    !MIGRATION_NAME_PATTERN.test(row.name) ||
    !MIGRATION_CHECKSUM_PATTERN.test(row.checksum) ||
    !Number.isFinite(appliedAt.getTime()) ||
    appliedAt.toISOString() !== row.applied_at
  ) {
    throw new DomainError(
      'INTEGRITY_ERROR',
      `Migration ${row.version} has invalid integrity metadata`,
    );
  }
}

function migrationChecksum(migration: Migration): string {
  return createHash('sha256')
    .update(`${migration.version}\0${migration.name}\0${migration.sql}`)
    .digest('hex');
}
