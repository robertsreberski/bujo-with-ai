import { describe, expect, it } from 'vitest';
import type { JournalEntry } from '../components/types';
import {
  DEFAULT_LOG_VIEW,
  arrangeLog,
  isClosedEntry,
  isDefaultLogView,
  logMetaLabel,
  normalizeLogView,
  type LogViewConfig,
} from './log-arrangement';

const entry = (overrides: Partial<JournalEntry> & { id: string }): JournalEntry => ({
  date: '2026-08-05',
  type: 'task',
  text: `Entry ${overrides.id}`,
  state: 'open',
  time: null,
  tags: [],
  author: 'me',
  source: null,
  migrations: 0,
  collection: 'month:2026-08',
  createdAt: '2026-08-05T10:00:00.000Z',
  updatedAt: '2026-08-05T10:00:00.000Z',
  revision: 1,
  deletedAt: null,
  ...overrides,
});

const view = (overrides: Partial<LogViewConfig> = {}): LogViewConfig => ({
  ...DEFAULT_LOG_VIEW,
  ...overrides,
});

const ids = (entries: JournalEntry[]) => entries.map((item) => item.id);

describe('isClosedEntry', () => {
  it('treats done, cancelled, migrated, and scheduled as closed shells', () => {
    expect(isClosedEntry({ state: 'done' })).toBe(true);
    expect(isClosedEntry({ state: 'cancelled' })).toBe(true);
    expect(isClosedEntry({ state: 'migrated' })).toBe(true);
    expect(isClosedEntry({ state: 'scheduled' })).toBe(true);
    expect(isClosedEntry({ state: 'open' })).toBe(false);
    expect(isClosedEntry({ state: 'logged' })).toBe(false);
  });
});

describe('arrangeLog', () => {
  it('keeps open tasks and logged notes on top and buckets every closed state', () => {
    const entries = [
      entry({ id: 'a', state: 'open', createdAt: '2026-08-06T10:00:00.000Z' }),
      entry({ id: 'b', type: 'note', state: 'logged', createdAt: '2026-08-05T10:00:00.000Z' }),
      entry({ id: 'c', state: 'done', createdAt: '2026-08-04T10:00:00.000Z' }),
      entry({ id: 'd', state: 'cancelled', createdAt: '2026-08-03T10:00:00.000Z' }),
      entry({ id: 'e', state: 'migrated', createdAt: '2026-08-02T10:00:00.000Z' }),
      entry({ id: 'f', state: 'scheduled', createdAt: '2026-08-01T10:00:00.000Z' }),
    ];
    const arrangement = arrangeLog(entries, DEFAULT_LOG_VIEW);
    expect(arrangement.sections).toHaveLength(1);
    expect(arrangement.sections[0]?.label).toBeNull();
    expect(ids(arrangement.sections[0]?.entries ?? [])).toEqual(['a', 'b']);
    expect(ids(arrangement.closed)).toEqual(['c', 'd', 'e', 'f']);
    expect(arrangement.closedCount).toBe(4);
    expect(arrangement.activeCount).toBe(2);
    expect(arrangement.visibleCount).toBe(6);
    expect(arrangement.totalCount).toBe(6);
  });

  it('sorts newest-first by createdAt with id tie-break, and oldest-first when asked', () => {
    const entries = [
      entry({ id: 'a', createdAt: '2026-08-01T10:00:00.000Z' }),
      entry({ id: 'b', createdAt: '2026-08-02T10:00:00.000Z' }),
      entry({ id: 'c', createdAt: '2026-08-02T10:00:00.000Z' }),
    ];
    const newest = arrangeLog(entries, DEFAULT_LOG_VIEW);
    expect(ids(newest.sections[0]?.entries ?? [])).toEqual(['c', 'b', 'a']);
    const oldest = arrangeLog(entries, view({ sort: 'oldest' }));
    expect(ids(oldest.sections[0]?.entries ?? [])).toEqual(['a', 'b', 'c']);
  });

  it('interleaves everything with stateFilter "all" and empties the bucket', () => {
    const entries = [
      entry({ id: 'a', state: 'done', createdAt: '2026-08-02T10:00:00.000Z' }),
      entry({ id: 'b', state: 'open', createdAt: '2026-08-01T10:00:00.000Z' }),
    ];
    const arrangement = arrangeLog(entries, view({ stateFilter: 'all' }));
    expect(ids(arrangement.sections[0]?.entries ?? [])).toEqual(['a', 'b']);
    expect(arrangement.closed).toEqual([]);
    expect(arrangement.closedCount).toBe(0);
    expect(arrangement.visibleCount).toBe(2);
  });

  it('shows only the closed shells with stateFilter "closed"', () => {
    const entries = [
      entry({ id: 'a', state: 'open', createdAt: '2026-08-03T10:00:00.000Z' }),
      entry({ id: 'b', state: 'done', createdAt: '2026-08-02T10:00:00.000Z' }),
      entry({ id: 'c', state: 'migrated', createdAt: '2026-08-01T10:00:00.000Z' }),
    ];
    const arrangement = arrangeLog(entries, view({ stateFilter: 'closed' }));
    expect(ids(arrangement.sections[0]?.entries ?? [])).toEqual(['b', 'c']);
    expect(arrangement.closed).toEqual([]);
    expect(arrangement.visibleCount).toBe(2);
    expect(arrangement.totalCount).toBe(3);
  });

  it('narrows both the sections and the closed bucket by type', () => {
    const entries = [
      entry({ id: 'a', type: 'task', state: 'open' }),
      entry({ id: 'b', type: 'note', state: 'logged' }),
      entry({ id: 'c', type: 'task', state: 'done' }),
      entry({ id: 'd', type: 'event', state: 'logged' }),
    ];
    const arrangement = arrangeLog(entries, view({ types: ['task'] }));
    expect(ids(arrangement.sections[0]?.entries ?? [])).toEqual(['a']);
    expect(ids(arrangement.closed)).toEqual(['c']);
    expect(arrangement.visibleCount).toBe(2);
    expect(arrangement.totalCount).toBe(4);
  });

  it('labels groups with pluralized counts in signifier order and omits empty groups', () => {
    const entries = [
      entry({ id: 'a', type: 'note', state: 'logged', createdAt: '2026-08-03T10:00:00.000Z' }),
      entry({ id: 'b', type: 'task', createdAt: '2026-08-01T10:00:00.000Z' }),
      entry({ id: 'c', type: 'task', createdAt: '2026-08-02T10:00:00.000Z' }),
      entry({ id: 'd', type: 'idea', state: 'logged', createdAt: '2026-08-04T10:00:00.000Z' }),
    ];
    const arrangement = arrangeLog(entries, view({ group: 'type' }));
    expect(arrangement.sections.map((section) => section.key)).toEqual(['task', 'note', 'idea']);
    expect(arrangement.sections.map((section) => section.label)).toEqual([
      'Tasks (2)',
      'Notes (1)',
      'Ideas (1)',
    ]);
    expect(ids(arrangement.sections[0]?.entries ?? [])).toEqual(['c', 'b']);
  });

  it('keeps the closed bucket flat even when the active portion is grouped', () => {
    const entries = [
      entry({ id: 'a', type: 'task', state: 'open' }),
      entry({ id: 'b', type: 'task', state: 'done' }),
      entry({ id: 'c', type: 'note', state: 'logged' }),
    ];
    const arrangement = arrangeLog(entries, view({ group: 'type' }));
    expect(arrangement.sections.map((section) => section.key)).toEqual(['task', 'note']);
    expect(ids(arrangement.closed)).toEqual(['b']);
  });

  it('reports counts so the meta can read "V of T items"', () => {
    const entries = [
      entry({ id: 'a', type: 'task', state: 'open' }),
      entry({ id: 'b', type: 'note', state: 'logged' }),
      entry({ id: 'c', type: 'note', state: 'logged' }),
    ];
    const narrowed = arrangeLog(entries, view({ types: ['task'] }));
    expect(logMetaLabel(narrowed)).toBe('1 of 3 items');
    const untouched = arrangeLog(entries, DEFAULT_LOG_VIEW);
    expect(logMetaLabel(untouched)).toBe('3 items');
  });
});

describe('normalizeLogView', () => {
  it('falls back to the defaults for unknown persisted values', () => {
    expect(normalizeLogView(null)).toEqual(DEFAULT_LOG_VIEW);
    expect(normalizeLogView(undefined)).toEqual(DEFAULT_LOG_VIEW);
    expect(normalizeLogView({ sort: 'wat', group: 7, stateFilter: 'nope', types: 'task' })).toEqual(
      DEFAULT_LOG_VIEW,
    );
  });

  it('drops unknown types and normalizes the full type set back to no narrowing', () => {
    expect(normalizeLogView(view({ types: ['task', 'bogus' as never] })).types).toEqual(['task']);
    expect(
      normalizeLogView(
        view({ types: ['task', 'event', 'note', 'idea', 'question', 'habit', 'mood'] }),
      ).types,
    ).toEqual([]);
  });
});

describe('isDefaultLogView', () => {
  it('recognizes the default and its full-type-set equivalent', () => {
    expect(isDefaultLogView(DEFAULT_LOG_VIEW)).toBe(true);
    expect(
      isDefaultLogView(
        view({ types: ['task', 'event', 'note', 'idea', 'question', 'habit', 'mood'] }),
      ),
    ).toBe(true);
    expect(isDefaultLogView(view({ sort: 'oldest' }))).toBe(false);
    expect(isDefaultLogView(view({ types: ['task'] }))).toBe(false);
  });
});
