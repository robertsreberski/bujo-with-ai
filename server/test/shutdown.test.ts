import { describe, expect, it } from 'vitest';
import { shutdownJournal } from '../src/jobs/shutdown.js';

describe('journal shutdown lifecycle', () => {
  it('quiesces ingress before waiting for maintenance, then closes storage and releases the lease', async () => {
    const events: string[] = [];
    let releaseMaintenance: (() => void) | undefined;
    const blockedMaintenance = new Promise<void>((resolve) => {
      releaseMaintenance = resolve;
    });
    const shutdown = shutdownJournal(
      {
        quiesce: async () => {
          events.push('quiesce');
        },
        close: async () => {
          events.push('runtime-close');
        },
      },
      {
        close: async () => {
          events.push('maintenance-drain');
          await blockedMaintenance;
          events.push('maintenance-drained');
        },
      },
      {
        release: async () => {
          events.push('lease-release');
        },
      },
    );

    await Promise.resolve();
    expect(events).toEqual(['quiesce', 'maintenance-drain']);
    releaseMaintenance?.();
    await shutdown;
    expect(events).toEqual([
      'quiesce',
      'maintenance-drain',
      'maintenance-drained',
      'runtime-close',
      'lease-release',
    ]);
  });
});
