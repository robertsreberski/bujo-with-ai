// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  calendarDateInTimeZone,
  createMidnightScheduler,
  millisecondsUntilNextJournalDay,
} from './midnight';

afterEach(() => {
  vi.useRealTimers();
});

describe('journal timezone rollover', () => {
  it('computes the day and next boundary in the journal timezone, not the device timezone', () => {
    const now = new Date('2026-08-01T01:00:00.000Z');

    expect(calendarDateInTimeZone(now, 'America/Los_Angeles')).toBe('2026-07-31');
    expect(millisecondsUntilNextJournalDay(now, 'America/Los_Angeles')).toBeGreaterThan(
      5 * 60 * 60 * 1_000,
    );
  });

  it('fires at the next journal-zone midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T06:59:58.000Z'));
    const onMidnight = vi.fn();
    const scheduler = createMidnightScheduler(onMidnight, () => 'America/Los_Angeles');

    vi.advanceTimersByTime(1_000);
    expect(onMidnight).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4_000);
    expect(onMidnight).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});
