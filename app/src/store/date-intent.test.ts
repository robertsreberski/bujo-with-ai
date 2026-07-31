// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { createCaptureContext } from './journal-store';

describe('offline capture date intent', () => {
  it('keeps the last server today when the UI rolls over at midnight offline', () => {
    const state = {
      today: '2026-08-01',
      serverToday: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    };
    const today = createCaptureContext(
      state,
      { text: 'Offline after midnight', type: 'note' },
      '2026-08-01T00:05:00.000+02:00',
    );
    const tomorrow = createCaptureContext(
      state,
      { text: 'Tomorrow while offline', type: 'task', dateShift: 'tomorrow' },
      '2026-08-01T00:06:00.000+02:00',
    );

    expect(today).toMatchObject({
      targetDate: '2026-08-01',
      dateIntent: { kind: 'tomorrow', baseToday: '2026-07-31' },
    });
    expect(tomorrow).toMatchObject({
      targetDate: '2026-08-02',
      dateIntent: { kind: 'absolute', date: '2026-08-02', baseToday: '2026-07-31' },
    });
  });
});
