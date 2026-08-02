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
  public readonly readonlyMode: boolean;
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
      if (!this.readonlyMode) this.reconcileLegacyData();
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
      { version: 7, type: 'table', name: 'summary_reflection_reverts' },
      { version: 7, type: 'table', name: 'legacy_summary_reconciliation_state' },
      { version: 8, type: 'index', name: 'idx_entries_stated_day' },
      { version: 8, type: 'table', name: 'date_stated_backfill_state' },
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

  /**
   * Data healing is deliberately separate from append-only schema migrations.
   * It runs on every writable open so a failed attempt is retried even after
   * the migration rows were committed, and one transaction keeps every repair
   * rollback-compatible and all-or-nothing.
   */
  private reconcileLegacyData(): void {
    const migrationTable = this.raw
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    if (migrationTable === undefined) return;
    const appliedVersion = this.raw
      .prepare('SELECT max(version) FROM schema_migrations')
      .pluck()
      .get() as number | null;
    if ((appliedVersion ?? 0) < 6) return;
    const hasLegacySummaryProvenance = (appliedVersion ?? 0) >= 7;
    const legacyProjectionReconciliationPending =
      hasLegacySummaryProvenance &&
      this.raw.prepare('SELECT 1 FROM legacy_summary_reconciliation_state WHERE id=1').get() ===
        undefined;
    const dateStatedBackfillPending =
      (appliedVersion ?? 0) >= 8 &&
      this.raw.prepare('SELECT 1 FROM date_stated_backfill_state WHERE id=1').get() === undefined;
    const now = this.now().toISOString();
    const reconcile = this.raw.transaction(() => {
      if (hasLegacySummaryProvenance)
        this.reconcileLegacySummaryProjections(now, legacyProjectionReconciliationPending);
      else this.backfillLegacySummaryProjections(false);

      this.raw
        .prepare(
          `UPDATE reflection_slots SET
             status='queued', claimed_at=NULL, claimed_token_id=NULL, claimed_label=NULL,
             claimed_tool=NULL, claimed_source_entries=NULL,
             updated_at=CASE WHEN updated_at > ? THEN updated_at ELSE ? END,
             revision=revision+1
           WHERE status='running' AND claimed_source_entries IS NULL`,
        )
        .run(now, now);

      this.raw
        .prepare(
          `UPDATE summaries SET
             status=CASE
               WHEN EXISTS (
                 SELECT 1 FROM reflection_slots AS reflection
                 WHERE reflection.week_start=summaries.week_start
                   AND reflection.status='current'
               ) THEN 'current'
               ELSE 'stale'
             END,
             saved_entry_id=NULL,
             updated_at=CASE WHEN updated_at > ? THEN updated_at ELSE ? END,
             revision=revision+1
           WHERE status='saved'
             AND NOT EXISTS (
               SELECT 1 FROM entries
               WHERE entries.id=summaries.saved_entry_id
                 AND entries.deleted_at IS NULL
                 AND entries.author='ai'
                 AND entries.type='note'
                 AND EXISTS (SELECT 1 FROM json_each(entries.tags) WHERE value='summary')
             )`,
        )
        .run(now, now);

      this.raw.exec(`
        UPDATE activity
        SET
          text = CASE kind
            WHEN 'agent-add' THEN 'Added an entry (content expired)'
            WHEN 'agent-update' THEN 'Updated an entry (content expired)'
            WHEN 'agent-delete' THEN 'Deleted an entry (content expired)'
            WHEN 'agent-migration' THEN 'Migrated entries (content expired)'
            WHEN 'summary-filed' THEN 'Filed a reflection (content expired)'
            WHEN 'summary-saved' THEN 'Saved a reflection (content expired)'
            WHEN 'revert' THEN 'Reverted a change (content expired)'
          END,
          pre_images = (
            SELECT coalesce(json_group_array(json(
              CASE
                WHEN json_extract(snapshot.value, '$.entity') = 'entry'
                  AND NOT EXISTS (
                    SELECT 1 FROM entries
                    WHERE entries.id = json_extract(snapshot.value, '$.id')
                  )
                THEN json_set(snapshot.value, '$.row', NULL)
                ELSE snapshot.value
              END
            )), '[]')
            FROM json_each(activity.pre_images) AS snapshot
          ),
          post_images = (
            SELECT coalesce(json_group_array(json(
              CASE
                WHEN json_extract(snapshot.value, '$.entity') = 'entry'
                  AND NOT EXISTS (
                    SELECT 1 FROM entries
                    WHERE entries.id = json_extract(snapshot.value, '$.id')
                  )
                THEN json_set(snapshot.value, '$.row', NULL)
                ELSE snapshot.value
              END
            )), '[]')
            FROM json_each(activity.post_images) AS snapshot
          )
        WHERE EXISTS (
            SELECT 1 FROM json_each(activity.refs, '$.entryIds') AS ref
            WHERE NOT EXISTS (SELECT 1 FROM entries WHERE entries.id = ref.value)
          )
          OR EXISTS (
            SELECT 1 FROM json_each(activity.pre_images) AS snapshot
            WHERE json_extract(snapshot.value, '$.entity') = 'entry'
              AND NOT EXISTS (
                SELECT 1 FROM entries WHERE entries.id = json_extract(snapshot.value, '$.id')
              )
          )
          OR EXISTS (
            SELECT 1 FROM json_each(activity.post_images) AS snapshot
            WHERE json_extract(snapshot.value, '$.entity') = 'entry'
              AND NOT EXISTS (
                SELECT 1 FROM entries WHERE entries.id = json_extract(snapshot.value, '$.id')
              )
          );
      `);
      if (legacyProjectionReconciliationPending) {
        this.raw
          .prepare(
            'INSERT OR IGNORE INTO legacy_summary_reconciliation_state(id,completed_at) VALUES (1,?)',
          )
          .run(now);
      }

      if (dateStatedBackfillPending) {
        // Migration 008 defaults every row to "states its day", which is right
        // for the daily log and wrong for filings written before the column
        // existed: none of them named a day. Stand those back down exactly
        // once, so a filing dated deliberately after the upgrade survives the
        // next open.
        this.raw.exec('UPDATE entries SET date_stated = 0 WHERE collection IS NOT NULL');
        this.raw
          .prepare('INSERT OR IGNORE INTO date_stated_backfill_state(id,completed_at) VALUES (1,?)')
          .run(now);
      }
    });
    reconcile();
  }

  /**
   * A v1-compatible runtime can keep writing the canonical summaries table
   * while the additive Reflection tables are dormant. Only the deliberately
   * synthetic one-version mirror may be rewritten or removed on re-upgrade;
   * workflow state or any native version makes the Reflection authoritative.
   */
  private reconcileLegacySummaryProjections(now: string, retroIdentify: boolean): void {
    if (retroIdentify)
      this.raw.exec(`
      UPDATE reflection_slots AS reflection
      SET legacy_summary_id = reflection.id
      WHERE reflection.legacy_summary_id IS NULL
        AND reflection.current_version_id = reflection.id
        AND reflection.status IN ('current', 'stale')
        AND reflection.request_id IS NULL
        AND reflection.requested_at IS NULL
        AND reflection.claimed_at IS NULL
        AND reflection.claimed_token_id IS NULL
        AND reflection.claimed_label IS NULL
        AND reflection.claimed_tool IS NULL
        AND reflection.claimed_source_entries IS NULL
        AND reflection.failure IS NULL
        AND (SELECT count(*) FROM reflection_versions AS candidate
             WHERE candidate.reflection_id = reflection.id) = 1
        AND EXISTS (
          SELECT 1 FROM reflection_versions AS version
          WHERE version.reflection_id = reflection.id
            AND version.id = reflection.id
            AND version.version_number = 1
            AND version.source_from = reflection.week_start
            AND version.source_to = reflection.week_end
            AND version.generator_label = 'Legacy assistant'
            AND version.generator_tool IS NULL
            AND json_array_length(version.source_entries) = 0
        );
      `);
    this.raw.exec(`
      DELETE FROM reflection_versions
      WHERE id IN (
        SELECT version.id
        FROM reflection_slots AS reflection
        JOIN reflection_versions AS version ON version.reflection_id = reflection.id
        WHERE reflection.legacy_summary_id = reflection.id
          AND reflection.current_version_id = reflection.id
          AND reflection.status IN ('current', 'stale')
          AND reflection.request_id IS NULL
          AND reflection.requested_at IS NULL
          AND reflection.claimed_at IS NULL
          AND reflection.claimed_token_id IS NULL
          AND reflection.claimed_label IS NULL
          AND reflection.claimed_tool IS NULL
          AND reflection.claimed_source_entries IS NULL
          AND reflection.failure IS NULL
          AND version.id = reflection.id
          AND version.version_number = 1
          AND version.source_from = reflection.week_start
          AND version.source_to = reflection.week_end
          AND version.generator_label = 'Legacy assistant'
          AND version.generator_tool IS NULL
          AND json_array_length(version.source_entries) = 0
          AND (SELECT count(*) FROM reflection_versions AS candidate
               WHERE candidate.reflection_id = reflection.id) = 1
          AND NOT EXISTS (
            SELECT 1 FROM summaries AS summary
            WHERE summary.id = reflection.legacy_summary_id
              AND summary.week_start = reflection.week_start
          )
      );

      DELETE FROM reflection_slots AS reflection
      WHERE reflection.legacy_summary_id = reflection.id
        AND NOT EXISTS (
          SELECT 1 FROM summaries AS summary
          WHERE summary.id = reflection.legacy_summary_id
            AND summary.week_start = reflection.week_start
        )
        AND NOT EXISTS (
          SELECT 1 FROM reflection_versions AS version
          WHERE version.reflection_id = reflection.id
        );
    `);

    this.raw
      .prepare(
        `UPDATE reflection_slots AS reflection
         SET
           status = CASE summary.status WHEN 'stale' THEN 'stale' ELSE 'current' END,
           updated_at = max(reflection.updated_at, summary.updated_at, ?),
           revision = max(reflection.revision + 1, summary.revision)
         FROM summaries AS summary
         JOIN reflection_versions AS version ON version.id = summary.id
         WHERE reflection.id = summary.id
           AND reflection.legacy_summary_id = summary.id
           AND reflection.week_start = summary.week_start
           AND reflection.current_version_id = reflection.id
           AND reflection.status IN ('current', 'stale')
           AND reflection.request_id IS NULL
           AND reflection.requested_at IS NULL
           AND reflection.claimed_at IS NULL
           AND reflection.claimed_token_id IS NULL
           AND reflection.claimed_label IS NULL
           AND reflection.claimed_tool IS NULL
           AND reflection.claimed_source_entries IS NULL
           AND reflection.failure IS NULL
           AND version.reflection_id = reflection.id
           AND version.version_number = 1
           AND version.source_from = reflection.week_start
           AND version.source_to = reflection.week_end
           AND version.generator_label = 'Legacy assistant'
           AND version.generator_tool IS NULL
           AND json_array_length(version.source_entries) = 0
           AND (SELECT count(*) FROM reflection_versions AS candidate
                WHERE candidate.reflection_id = reflection.id) = 1
           AND (
             reflection.status != CASE summary.status WHEN 'stale' THEN 'stale' ELSE 'current' END
             OR reflection.revision < summary.revision
             OR version.text != summary.text
             OR version.generator_token_id != summary.token_id
             OR version.source != summary.source
             OR version.generated_at != summary.updated_at
           )`,
      )
      .run(now);

    this.raw.exec(`
      UPDATE reflection_versions AS version
      SET
        text = summary.text,
        generator_token_id = summary.token_id,
        source = summary.source,
        generated_at = summary.updated_at
      FROM reflection_slots AS reflection
      JOIN summaries AS summary
        ON summary.id = reflection.legacy_summary_id
       AND summary.week_start = reflection.week_start
      WHERE version.reflection_id = reflection.id
        AND reflection.legacy_summary_id = reflection.id
        AND reflection.current_version_id = reflection.id
        AND reflection.status IN ('current', 'stale')
        AND reflection.request_id IS NULL
        AND reflection.requested_at IS NULL
        AND reflection.claimed_at IS NULL
        AND reflection.claimed_token_id IS NULL
        AND reflection.claimed_label IS NULL
        AND reflection.claimed_tool IS NULL
        AND reflection.claimed_source_entries IS NULL
        AND reflection.failure IS NULL
        AND version.id = reflection.id
        AND version.version_number = 1
        AND version.source_from = reflection.week_start
        AND version.source_to = reflection.week_end
        AND version.generator_label = 'Legacy assistant'
        AND version.generator_tool IS NULL
        AND json_array_length(version.source_entries) = 0
        AND (SELECT count(*) FROM reflection_versions AS candidate
             WHERE candidate.reflection_id = reflection.id) = 1;
    `);

    this.backfillLegacySummaryProjections(true);
  }

  private backfillLegacySummaryProjections(withProvenance: boolean): void {
    const provenanceColumn = withProvenance ? ', legacy_summary_id' : '';
    const provenanceValue = withProvenance ? ', summary.id' : '';
    this.raw.exec(`
      INSERT INTO reflection_slots(
        id, week_start, week_end, status, request_id, requested_at, claimed_at,
        claimed_token_id, claimed_label, claimed_tool, claimed_source_entries,
        failure, current_version_id, created_at, updated_at, revision${provenanceColumn}
      )
      SELECT
        summary.id,
        summary.week_start,
        date(summary.week_start, '+6 days'),
        CASE summary.status WHEN 'stale' THEN 'stale' ELSE 'current' END,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, summary.id,
        summary.created_at, summary.updated_at, summary.revision${provenanceValue}
      FROM summaries AS summary
      WHERE NOT EXISTS (
        SELECT 1 FROM reflection_slots AS reflection
        WHERE reflection.week_start = summary.week_start
      );

      INSERT INTO reflection_versions(
        id, reflection_id, version_number, text, source_from, source_to,
        generator_token_id, generator_label, generator_tool, source, generated_at,
        source_entries
      )
      SELECT
        summary.id, summary.id, 1, summary.text, summary.week_start,
        date(summary.week_start, '+6 days'), summary.token_id, 'Legacy assistant',
        NULL, summary.source, summary.updated_at, '[]'
      FROM summaries AS summary
      JOIN reflection_slots AS reflection ON reflection.id = summary.id
      WHERE reflection.current_version_id = summary.id
        AND NOT EXISTS (
          SELECT 1 FROM reflection_versions AS version WHERE version.id = summary.id
        );
    `);
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
