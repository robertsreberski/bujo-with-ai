import { describe, expect, it } from 'vitest';
import { parseJournalUrl } from './useJournalRoute';

describe('journal URL parsing', () => {
  it('accepts only real calendar dates and canonical months', () => {
    expect(parseJournalUrl('/?date=2026-02-28')).toEqual({
      route: { name: 'today', date: '2026-02-28' },
      href: '/?date=2026-02-28',
    });
    expect(parseJournalUrl('/?date=2026-02-30')).toEqual({
      route: { name: 'today', date: null },
      href: '/',
    });
    expect(parseJournalUrl('/month?month=2026-13')).toEqual({
      route: { name: 'month', month: null },
      href: '/month',
    });
  });

  it('validates decoded collection IDs without throwing on malformed escapes', () => {
    expect(parseJournalUrl('/c/month%3A2026-08')).toEqual({
      route: { name: 'collection', collectionId: 'month:2026-08' },
      href: '/c/month%3A2026-08',
    });
    expect(parseJournalUrl('/c/Bad%20ID')).toEqual({
      route: { name: 'today', date: null },
      href: '/',
    });
    expect(parseJournalUrl('/c/%E0%A4%A')).toEqual({
      route: { name: 'today', date: null },
      href: '/',
    });
  });

  it('returns unknown paths and irrelevant query strings to the canonical timeline', () => {
    expect(parseJournalUrl('/does-not-exist?date=2026-08-02')).toEqual({
      route: { name: 'today', date: null },
      href: '/',
    });
    expect(parseJournalUrl('/review?unexpected=true')).toEqual({
      route: { name: 'activity' },
      href: '/activity',
    });
  });

  it('preserves valid entry deep links and drops malformed identifiers', () => {
    expect(parseJournalUrl('/review?entry=01K1H000000000000000000011')).toEqual({
      route: { name: 'activity' },
      href: '/activity?entry=01K1H000000000000000000011',
    });
    expect(parseJournalUrl('/activity?entry=not-an-entry')).toEqual({
      route: { name: 'activity' },
      href: '/activity',
    });
  });
});
