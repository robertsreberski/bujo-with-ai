// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { journalApi } from '../api/client';
import type { Collection, Entry, TagUsage } from '../api/types';
import {
  deriveTagUsage,
  journalActions,
  mergeTagUsage,
  selectActiveCollections,
  useJournalStore,
} from './journal-store';

function entry(id: string, tags: string[], patch: Partial<Entry> = {}): Entry {
  return {
    id,
    date: '2026-07-31',
    type: 'task',
    text: `Task ${id}`,
    state: 'open',
    time: null,
    tags,
    author: 'me',
    source: null,
    migrations: 0,
    collection: null,
    createdAt: '2026-07-31T08:00:00.000Z',
    updatedAt: '2026-07-31T08:00:00.000Z',
    revision: 1,
    deletedAt: null,
    ...patch,
  };
}

function collection(id: string, patch: Partial<Collection> = {}): Collection {
  return {
    id,
    name: id,
    note: null,
    createdAt: '2026-07-01T08:00:00.000Z',
    archivedAt: null,
    ...patch,
  };
}

function seedEntries(...entries: Entry[]): void {
  useJournalStore.setState({
    entriesById: Object.fromEntries(entries.map((row) => [row.id, row])),
    tagSuggestions: [],
    tagsFetchedAt: null,
  });
}

afterEach(() => {
  useJournalStore.setState({ entriesById: {}, tagSuggestions: [], tagsFetchedAt: null });
  vi.restoreAllMocks();
});

describe('deriveTagUsage', () => {
  it('counts live entries once per tag and ranks by use then name', () => {
    expect(
      deriveTagUsage({
        a: entry('a', ['work', 'work', 'home']),
        b: entry('b', ['work'], { updatedAt: '2026-07-31T12:00:00.000Z' }),
        c: entry('c', ['admin']),
        gone: entry('gone', ['ghost'], { deletedAt: '2026-07-30T08:00:00.000Z' }),
      }),
    ).toEqual([
      { tag: 'work', uses: 2, lastUsedAt: '2026-07-31T12:00:00.000Z' },
      { tag: 'admin', uses: 1, lastUsedAt: '2026-07-31T08:00:00.000Z' },
      { tag: 'home', uses: 1, lastUsedAt: '2026-07-31T08:00:00.000Z' },
    ]);
  });
});

describe('mergeTagUsage', () => {
  it('takes server counts for known tags and keeps mirror-only optimistic tags', () => {
    const mirror: TagUsage[] = [
      { tag: 'work', uses: 2, lastUsedAt: '2026-07-31T12:00:00.000Z' },
      { tag: 'brand-new', uses: 1, lastUsedAt: '2026-07-31T13:00:00.000Z' },
    ];
    const server: TagUsage[] = [
      { tag: 'work', uses: 40, lastUsedAt: '2026-07-30T08:00:00.000Z' },
      { tag: 'admin', uses: 9, lastUsedAt: '2026-07-29T08:00:00.000Z' },
    ];

    expect(mergeTagUsage(mirror, server)).toEqual([
      // The server owns the count; the fresher local timestamp survives.
      { tag: 'work', uses: 40, lastUsedAt: '2026-07-31T12:00:00.000Z' },
      { tag: 'admin', uses: 9, lastUsedAt: '2026-07-29T08:00:00.000Z' },
      { tag: 'brand-new', uses: 1, lastUsedAt: '2026-07-31T13:00:00.000Z' },
    ]);
  });
});

describe('loadTagSuggestions', () => {
  it('publishes the mirror-derived list before the request resolves', async () => {
    seedEntries(entry('a', ['work']), entry('b', ['work']), entry('c', ['home']));
    let release = (): void => undefined;
    const listTags = vi.spyOn(journalApi, 'listTags').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ items: [{ tag: 'admin', uses: 9, lastUsedAt: '2026-07-29T08:00:00.000Z' }] });
        }),
    );

    const pending = journalActions.loadTagSuggestions();
    expect(useJournalStore.getState().tagSuggestions).toEqual([
      { tag: 'work', uses: 2, lastUsedAt: '2026-07-31T08:00:00.000Z' },
      { tag: 'home', uses: 1, lastUsedAt: '2026-07-31T08:00:00.000Z' },
    ]);
    expect(useJournalStore.getState().tagsFetchedAt).toBeNull();

    release();
    await pending;

    expect(listTags).toHaveBeenCalledTimes(1);
    expect(useJournalStore.getState().tagSuggestions).toEqual([
      { tag: 'admin', uses: 9, lastUsedAt: '2026-07-29T08:00:00.000Z' },
      { tag: 'work', uses: 2, lastUsedAt: '2026-07-31T08:00:00.000Z' },
      { tag: 'home', uses: 1, lastUsedAt: '2026-07-31T08:00:00.000Z' },
    ]);
    expect(useJournalStore.getState().tagsFetchedAt).not.toBeNull();
  });

  it('counts a capture made while the request was in flight', async () => {
    seedEntries(entry('a', ['work']));
    vi.spyOn(journalApi, 'listTags').mockImplementation(async () => {
      useJournalStore.setState((state) => ({
        entriesById: { ...state.entriesById, b: entry('b', ['work', 'errands']) },
      }));
      return { items: [{ tag: 'work', uses: 5, lastUsedAt: '2026-07-30T08:00:00.000Z' }] };
    });

    await journalActions.loadTagSuggestions();

    // `errands` only exists in the mirror, so the merge had to re-derive it.
    expect(useJournalStore.getState().tagSuggestions).toEqual([
      { tag: 'work', uses: 5, lastUsedAt: '2026-07-31T08:00:00.000Z' },
      { tag: 'errands', uses: 1, lastUsedAt: '2026-07-31T08:00:00.000Z' },
    ]);
  });

  it('skips the network while the last fetch is still fresh', async () => {
    seedEntries(entry('a', ['work']));
    const listTags = vi.spyOn(journalApi, 'listTags');
    useJournalStore.setState({ tagsFetchedAt: new Date().toISOString() });

    await journalActions.loadTagSuggestions();

    expect(listTags).not.toHaveBeenCalled();
    expect(useJournalStore.getState().tagSuggestions).toHaveLength(1);
  });

  it('refetches once the five-minute window lapses', async () => {
    seedEntries(entry('a', ['work']));
    const listTags = vi.spyOn(journalApi, 'listTags').mockResolvedValue({ items: [] });
    useJournalStore.setState({ tagsFetchedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString() });

    await journalActions.loadTagSuggestions();

    expect(listTags).toHaveBeenCalledTimes(1);
  });

  it('stays on the mirror-derived list, and silent, when the request fails', async () => {
    seedEntries(entry('a', ['work']));
    useJournalStore.setState({ notices: [] });
    vi.spyOn(journalApi, 'listTags').mockRejectedValue(new Error('offline'));

    await expect(journalActions.loadTagSuggestions()).resolves.toBeUndefined();

    expect(useJournalStore.getState().tagSuggestions).toEqual([
      { tag: 'work', uses: 1, lastUsedAt: '2026-07-31T08:00:00.000Z' },
    ]);
    expect(useJournalStore.getState().tagsFetchedAt).toBeNull();
    expect(useJournalStore.getState().notices).toEqual([]);
  });

  it('never touches the network when the browser reports itself offline', async () => {
    seedEntries(entry('a', ['work']));
    const listTags = vi.spyOn(journalApi, 'listTags');
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);

    await journalActions.loadTagSuggestions();

    expect(listTags).not.toHaveBeenCalled();
    expect(useJournalStore.getState().tagSuggestions).toHaveLength(1);
  });
});

describe('selectActiveCollections', () => {
  it('drops archives and monthly logs, sorted by name', () => {
    useJournalStore.setState({
      collectionsById: {
        'month:2026-07': collection('month:2026-07', { name: 'July 2026' }),
        zeta: collection('zeta', { name: 'Zeta' }),
        alpha: collection('alpha', { name: 'Alpha' }),
        stale: collection('stale', { name: 'Stale', archivedAt: '2026-06-01T08:00:00.000Z' }),
      },
    });

    expect(selectActiveCollections(useJournalStore.getState()).map((item) => item.id)).toEqual([
      'alpha',
      'zeta',
    ]);
  });
});
