import { describe, expect, it } from 'vitest';
import { startMaintenanceScheduler } from '../src/jobs/maintenance.js';

describe('maintenance scheduler', () => {
  it('drains an active backup before close resolves', async () => {
    let markStarted: (() => void) | undefined;
    let releaseBackup: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseBackup = resolve;
    });
    const scheduler = startMaintenanceScheduler({
      domain: { purgeExpired: () => ({ entries: 0, mutations: 0, devices: 0 }) },
      backups: {
        isDailyBackupDue: async () => true,
        cancelActive: () => releaseBackup?.(),
        run: async () => {
          markStarted?.();
          await released;
          return { daily: '/tmp/daily.db', weekly: null, removed: [] };
        },
      },
      timezone: 'UTC',
      now: () => new Date('2026-07-31T04:00:00.000Z'),
    });

    await started;
    let closed = false;
    const close = scheduler.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await close;
    expect(closed).toBe(true);
  });

  it('catches up the previous due schedule before 03:30 after restart', async () => {
    const calls: string[] = [];
    let instant = new Date('2026-08-01T02:00:00.000Z');
    const scheduler = startMaintenanceScheduler({
      domain: { purgeExpired: () => ({ entries: 0, mutations: 0, devices: 0 }) },
      backups: {
        cancelActive: () => undefined,
        isDailyBackupDue: async (at) => {
          calls.push(`due:${at.toISOString()}`);
          return true;
        },
        run: async (at) => {
          calls.push(`run:${at.toISOString()}`);
          return { daily: '/tmp/daily.db', weekly: null, removed: [] };
        },
      },
      timezone: 'UTC',
      now: () => instant,
    });
    await scheduler.check();
    const catchup = instant.toISOString();
    instant = new Date('2026-08-01T04:00:00.000Z');
    await scheduler.check();
    await scheduler.close();
    expect(calls).toEqual([
      `due:${catchup}`,
      `run:${catchup}`,
      `due:${instant.toISOString()}`,
      `run:${instant.toISOString()}`,
    ]);
  });
});
