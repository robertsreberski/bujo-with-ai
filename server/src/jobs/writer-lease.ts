import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, lstatSync, openSync, statSync } from 'node:fs';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ensurePrivateDirectory } from '../private-path.js';

interface LeaseRecord {
  readonly version: 1;
  readonly pid: number;
  readonly processStart: string;
  readonly token: string;
  readonly command: string;
  readonly acquiredAt: string;
}

export interface WriterLeaseOptions {
  readonly pid?: number;
  readonly now?: () => Date;
  readonly token?: () => string;
  readonly processStart?: (pid: number) => string | null;
}

/**
 * A kernel-backed, cross-process writer lease. SQLite owns the exclusion, so
 * process death releases it automatically; writer.lock is private diagnostics.
 */
export class WriterLease {
  public readonly path: string;
  public readonly record: LeaseRecord;
  private readonly guard: Database.Database;
  private released = false;

  private constructor(path: string, record: LeaseRecord, guard: Database.Database) {
    this.path = path;
    this.record = record;
    this.guard = guard;
  }

  public static async acquire(
    dataDir: string,
    command: string,
    options: WriterLeaseOptions = {},
  ): Promise<WriterLease> {
    const directory = ensurePrivateDirectory(resolve(dataDir), 'data');
    const path = join(directory, 'writer.lock');
    const guardPath = join(directory, '.writer-lease.sqlite');
    prepareGuardFile(guardPath);

    const guard = new Database(guardPath);
    try {
      guard.pragma('busy_timeout = 0');
      guard.pragma('journal_mode = DELETE');
      guard.exec('BEGIN EXCLUSIVE');
      chmodPrivateFile(guardPath);
    } catch (error) {
      guard.close();
      if (!isSqliteBusy(error)) throw error;
      const existing = await readLease(path);
      const detail =
        existing === null
          ? 'Journal writer is already active'
          : `Journal writer is already active (pid ${existing.pid}, command ${existing.command})`;
      throw new Error(detail, { cause: error });
    }

    try {
      // Reaching this point proves that no live process owns the lease. Any
      // metadata left behind is stale even if its PID has since been reused.
      const existing = await readLease(path);
      if (existing !== null) {
        const quarantine = `${path}.stale-${existing.token}-${randomUUID()}`;
        await rename(path, quarantine);
        await unlink(quarantine).catch(() => undefined);
      } else {
        await unlink(path).catch((error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error;
        });
      }

      const pid = options.pid ?? process.pid;
      const processStart = (options.processStart ?? readProcessStart)(pid);
      if (processStart === null) throw new Error(`Unable to identify writer process ${pid}`);
      const record: LeaseRecord = {
        version: 1,
        pid,
        processStart,
        token: (options.token ?? randomUUID)(),
        command,
        acquiredAt: (options.now ?? (() => new Date()))().toISOString(),
      };
      const temporary = `${path}.candidate-${record.token}-${randomUUID()}`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
        chmodPrivateFile(path);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      return new WriterLease(path, record, guard);
    } catch (error) {
      releaseGuard(guard);
      throw error;
    }
  }

  public async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      const current = await readLease(this.path);
      if (current?.token === this.record.token) {
        await unlink(this.path).catch((error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error;
        });
      }
    } finally {
      releaseGuard(this.guard);
    }
  }
}

async function readLease(path: string): Promise<LeaseRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<LeaseRecord>;
    if (
      parsed.version !== 1 ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.processStart !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.command !== 'string' ||
      typeof parsed.acquiredAt !== 'string'
    ) {
      return null;
    }
    return parsed as LeaseRecord;
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || error instanceof SyntaxError) return null;
    throw error;
  }
}

function prepareGuardFile(path: string): void {
  try {
    const descriptor = openSync(path, 'wx', 0o600);
    closeSync(descriptor);
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
  chmodPrivateFile(path);
}

function chmodPrivateFile(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`Lease path must be a private regular file: ${path}`);
  }
  chmodSync(path, 0o600);
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error(`Unable to restrict writer lease permissions: ${path}`);
  }
}

function releaseGuard(guard: Database.Database): void {
  try {
    if (guard.inTransaction) guard.exec('ROLLBACK');
  } finally {
    guard.close();
  }
}

function readProcessStart(pid: number): string | null {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const value = result.stdout.trim();
  return value === '' ? null : value;
}

function isSqliteBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
  );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
