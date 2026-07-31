import { randomUUID } from 'node:crypto';
import { link, lstat, readlink, readdir, symlink, unlink } from 'node:fs/promises';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { JournalDatabase } from '../db/database.js';
import { assertNarrowPrivateDirectory, ensurePrivateDirectory } from '../private-path.js';

const DAILY_PATTERN = /^journal-(\d{4}-\d{2}-\d{2})\.db$/;
const WEEKLY_PATTERN = /^journal-weekly-(\d{4}-\d{2}-\d{2})\.db$/;

export interface BackupResult {
  readonly daily: string;
  readonly weekly: string | null;
  readonly removed: readonly string[];
}

export interface BackupManagerOptions {
  readonly database: JournalDatabase;
  readonly backupDir: string;
  readonly timezone: string;
  readonly now?: () => Date;
}

export class BackupManager {
  private readonly database: JournalDatabase;
  private readonly backupDir: string;
  private readonly timezone: string;
  private readonly now: () => Date;
  private activeBackup: AbortController | null = null;

  public constructor(options: BackupManagerOptions) {
    this.database = options.database;
    this.backupDir = resolve(options.backupDir);
    this.timezone = options.timezone;
    this.now = options.now ?? (() => new Date());
    assertNarrowPrivateDirectory(this.backupDir);
    if (existsSync(this.backupDir) && lstatSync(this.backupDir).isSymbolicLink()) {
      throw new Error(`Backup directory cannot be a symbolic link: ${this.backupDir}`);
    }
    if (existsSync(this.backupDir) && !lstatSync(this.backupDir).isDirectory()) {
      throw new Error(`Backup path is not a directory: ${this.backupDir}`);
    }
  }

  public async run(at = this.now()): Promise<BackupResult> {
    return this.withActiveBackup(async (signal) => {
      ensurePrivateDirectory(this.backupDir, 'backup');
      const date = latestDueDate(at, this.timezone);
      const daily = join(this.backupDir, `journal-${date}.db`);
      await this.ensureCanonical(daily, signal);

      let weekly: string | null = null;
      if (isSundayDate(date) || (await this.weeklyBackupDue(date))) {
        weekly = join(this.backupDir, `journal-weekly-${date}.db`);
        await this.ensureCanonical(weekly, signal);
      }
      const removed = await this.enforceRetention();
      return { daily, weekly, removed };
    });
  }

  public cancelActive(): void {
    this.activeBackup?.abort();
  }

  /** True when the most recent verified daily snapshot predates the latest 03:30 run due. */
  public async isDailyBackupDue(at = this.now()): Promise<boolean> {
    const dueDate = latestDueDate(at, this.timezone);
    const names = await readdir(this.backupDir).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    });
    const newest = names
      .map((name) => DAILY_PATTERN.exec(name)?.[1])
      .filter(
        (value): value is string => value !== undefined && isValidDate(value) && value <= dueDate,
      )
      .sort()
      .at(-1);
    if (newest === undefined) return true;
    const newestPath = join(this.backupDir, `journal-${newest}.db`);
    try {
      await this.verify(newestPath);
    } catch {
      return true;
    }
    return newest < dueDate;
  }

  /** Creates a new online snapshot on every call; it never reuses a rotation file. */
  public async createFresh(destination?: string, at = this.now()): Promise<string> {
    return this.withActiveBackup(async (signal) => {
      let target: string;
      if (destination === undefined) {
        ensurePrivateDirectory(this.backupDir, 'backup');
        target = join(this.backupDir, uniqueSnapshotName(at));
      } else {
        const resolved = resolve(destination);
        const metadata = await lstat(resolved).catch((error: unknown) => {
          if (isNodeError(error, 'ENOENT')) return null;
          throw error;
        });
        if (metadata?.isSymbolicLink() === true) {
          throw new Error(`Refusing symbolic-link backup destination: ${resolved}`);
        } else if (metadata?.isDirectory() === true) {
          target = join(resolved, uniqueSnapshotName(at));
        } else {
          if (metadata !== null) {
            throw new Error(`Refusing to overwrite an existing backup: ${resolved}`);
          }
          target = resolved;
        }
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      await this.database.backup(target, { signal });
      return target;
    });
  }

  public async verify(path: string): Promise<void> {
    const target = resolve(path);
    if (!(await isNonEmptyFile(target))) throw new Error(`Backup is missing or empty: ${path}`);
    const database = new Database(target, { readonly: true, fileMustExist: true });
    try {
      const rows = database.pragma('quick_check') as { quick_check: string }[];
      if (rows.some((row) => row.quick_check !== 'ok'))
        throw new Error(`Backup quick_check failed: ${path}`);
    } finally {
      database.close();
    }
  }

  public async enforceRetention(): Promise<readonly string[]> {
    ensurePrivateDirectory(this.backupDir, 'backup');
    const names = await readdir(this.backupDir).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    });
    const daily = names
      .filter((name) => DAILY_PATTERN.test(name))
      .sort()
      .reverse();
    const weekly = names
      .filter((name) => WEEKLY_PATTERN.test(name))
      .sort()
      .reverse();
    const expired = [...daily.slice(7), ...weekly.slice(4)];
    const removed: string[] = [];
    for (const name of expired) {
      const target = join(this.backupDir, name);
      const metadata = await lstat(target);
      if (metadata.isDirectory()) continue;
      await unlink(target);
      removed.push(target);
    }
    return removed;
  }

  private async weeklyBackupDue(today: string): Promise<boolean> {
    const names = await readdir(this.backupDir).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    });
    const newest = names
      .map((name) => WEEKLY_PATTERN.exec(name)?.[1])
      .filter(
        (value): value is string => value !== undefined && isValidDate(value) && value <= today,
      )
      .sort()
      .at(-1);
    if (newest === undefined) return true;
    const newestPath = join(this.backupDir, `journal-weekly-${newest}.db`);
    try {
      await this.verify(newestPath);
    } catch {
      return true;
    }
    return calendarDaysBetween(newest, today) >= 7;
  }

  private async ensureCanonical(path: string, signal: AbortSignal): Promise<void> {
    const metadata = await lstat(path)
      .then((value) => value)
      .catch((error: unknown) => {
        if (isNodeError(error, 'ENOENT')) return null;
        throw error;
      });
    if (metadata !== null) {
      if (metadata.isDirectory()) throw new Error(`Backup path is a directory: ${path}`);
      try {
        await this.verify(path);
        return;
      } catch {
        await this.database.backup(path, {
          signal,
          beforeReplace: () => this.preserveCorrupt(path, metadata),
        });
        return;
      }
    }
    await this.database.backup(path, { signal });
  }

  private async preserveCorrupt(
    path: string,
    expected: Awaited<ReturnType<typeof lstat>>,
  ): Promise<() => Promise<void>> {
    const quarantine = join(
      dirname(path),
      `${basename(path, extname(path))}.corrupt-${Date.now()}-${randomUUID()}${extname(path)}`,
    );
    const metadata = await lstat(path);
    if (metadata.dev !== expected.dev || metadata.ino !== expected.ino) {
      throw new Error(`Backup changed while replacement was being prepared: ${path}`);
    }
    if (metadata.isSymbolicLink()) {
      await symlink(await readlink(path), quarantine);
      return async () => {
        await unlink(quarantine).catch((error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error;
        });
      };
    }
    if (!metadata.isFile()) throw new Error(`Corrupt backup is not a regular file: ${path}`);
    await link(path, quarantine);
    return async () => {
      await unlink(quarantine).catch((error: unknown) => {
        if (!isNodeError(error, 'ENOENT')) throw error;
      });
    };
  }

  private async withActiveBackup<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.activeBackup !== null) throw new Error('A Journal backup is already active');
    const controller = new AbortController();
    this.activeBackup = controller;
    try {
      return await operation(controller.signal);
    } finally {
      if (this.activeBackup === controller) this.activeBackup = null;
    }
  }
}

function latestDueDate(date: Date, timezone: string): string {
  const parts = localParts(date, timezone);
  return parts.minutesSinceMidnight >= 210 ? parts.date : previousDate(parts.date);
}

function localParts(date: Date, timezone: string): { date: string; minutesSinceMidnight: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    minutesSinceMidnight: Number(read('hour')) * 60 + Number(read('minute')),
  };
}

function previousDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function isSundayDate(date: string): boolean {
  return new Date(`${date}T12:00:00Z`).getUTCDay() === 0;
}

function uniqueSnapshotName(at: Date): string {
  const stamp = at.toISOString().replaceAll(':', '').replaceAll('.', '');
  return `journal-manual-${stamp}-${randomUUID()}.db`;
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return !metadata.isSymbolicLink() && metadata.isFile() && metadata.size > 0;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

function calendarDaysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function isValidDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
