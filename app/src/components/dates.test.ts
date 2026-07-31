import { describe, expect, it } from 'vitest';
import { formatActivityDay, previousCalendarDate } from './dates';

describe('activity date labels', () => {
  it('uses journal-zone calendar subtraction across Amsterdam spring DST', () => {
    const now = new Date('2026-03-29T22:30:00.000Z'); // March 30, 00:30 in Amsterdam.
    expect(formatActivityDay('2026-03-29T21:00:00.000Z', 'Europe/Amsterdam', now)).toBe(
      'Yesterday',
    );
  });

  it('decrements calendar dates across month boundaries', () => {
    expect(previousCalendarDate('2026-03-01')).toBe('2026-02-28');
  });
});
