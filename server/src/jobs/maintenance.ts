import type { JournalDomain } from '../domain/journal.js';
import { BackupAbortedError } from '../db/database.js';
import type { BackupManager, BackupResult } from './backups.js';

export interface MaintenanceSchedulerOptions {
  readonly domain: Pick<JournalDomain, 'purgeExpired'>;
  readonly backups: Pick<BackupManager, 'run' | 'isDailyBackupDue' | 'cancelActive'>;
  readonly timezone: string;
  readonly now?: () => Date;
  readonly onBackup?: (result: BackupResult) => void;
  readonly onError?: (error: unknown) => void;
}

export interface MaintenanceScheduler {
  check(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A minute-level in-process scheduler. The first check also catches up a missed
 * schedule before 03:30 the next day.
 */
export function startMaintenanceScheduler(
  options: MaintenanceSchedulerOptions,
): MaintenanceScheduler {
  const now = options.now ?? (() => new Date());
  let running: Promise<void> | null = null;
  let closing = false;
  let lastBackupSchedule: string | null = null;
  let lastPurgeDate: string | null = null;

  const check = async (): Promise<void> => {
    if (closing) return;
    if (running !== null) return running;
    running = (async () => {
      const instant = now();
      const parts = localParts(instant, options.timezone);
      const backupSchedule =
        parts.minutesSinceMidnight >= 210 ? parts.date : previousDate(parts.date);
      if (lastBackupSchedule !== backupSchedule) {
        if (await options.backups.isDailyBackupDue(instant)) {
          if (closing) return;
          const result = await options.backups.run(instant);
          options.onBackup?.(result);
        }
        lastBackupSchedule = backupSchedule;
      }
      if (lastPurgeDate !== parts.date) {
        options.domain.purgeExpired();
        lastPurgeDate = parts.date;
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const reportError = (error: unknown): void => {
    if (closing && error instanceof BackupAbortedError) return;
    options.onError?.(error);
  };
  const timer = setInterval(() => void check().catch(reportError), 60_000);
  timer.unref();
  void check().catch(reportError);
  return {
    check,
    close: async () => {
      closing = true;
      clearInterval(timer);
      options.backups.cancelActive();
      try {
        await running;
      } catch (error) {
        if (!(error instanceof BackupAbortedError)) throw error;
      }
    },
  };
}

function previousDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
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
