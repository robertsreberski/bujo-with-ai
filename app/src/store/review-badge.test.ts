// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActivityView, Entry, Settings } from '../api/types';
import type { JournalClientRecord } from './models';

const persistenceMocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
}));

const pwaMocks = vi.hoisted(() => ({
  activate: vi.fn(),
  check: vi.fn(),
  register: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('./persistence', () => ({
  SingleRecordPersistence: class<T> {
    load(): Promise<T | undefined> {
      return persistenceMocks.load() as Promise<T | undefined>;
    }

    save(value: T): Promise<void> {
      return persistenceMocks.save(value) as Promise<void>;
    }

    clear(): Promise<void> {
      return persistenceMocks.clear() as Promise<void>;
    }
  },
}));

vi.mock('../pwa/registration', () => ({
  activateJournalUpdate: pwaMocks.activate,
  checkForJournalUpdate: pwaMocks.check,
  registerJournalServiceWorker: pwaMocks.register,
  subscribePwaRegistration: pwaMocks.subscribe,
}));

import {
  journalActions,
  selectOpenTodayCount,
  selectUnseenReviewCount,
  useJournalStore,
} from './journal-store';

const settings: Settings = {
  density: 'comfortable',
  showTypeBadges: true,
  highlightAiEntries: true,
  updatedAt: '2026-07-31T08:00:00.000Z',
};

const canonicalId = (suffix: string): string => `01K1H00000000000000000${suffix}`;

function entry(id: string, patch: Partial<Entry> = {}): Entry {
  return {
    id,
    date: '2026-07-31',
    type: 'task',
    text: `Entry ${id}`,
    state: 'open',
    time: null,
    tags: [],
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

function activity(id: string, at: string, patch: Partial<ActivityView> = {}): ActivityView {
  return {
    id,
    at,
    text: 'Updated an entry',
    kind: 'agent-update',
    origin: { actor: 'mcp', tokenId: canonicalId('99'), tool: 'update_entry' },
    refs: { entryIds: [] },
    preImages: [],
    postImages: [],
    revertedAt: null,
    revertedByActivityId: null,
    revert: { eligible: true, reason: null },
    ...patch,
  };
}

/** Seeds only the fields the two badge selectors read. */
function seed(entries: Entry[], activities: ActivityView[], lastReviewSeenAt: string | null): void {
  useJournalStore.setState({
    entriesById: Object.fromEntries(entries.map((row) => [row.id, row])),
    activityById: Object.fromEntries(activities.map((row) => [row.id, row])),
    activityOrder: [...activities]
      .sort((left, right) => right.at.localeCompare(left.at))
      .map((row) => row.id),
    today: '2026-07-31',
    lastReviewSeenAt,
  });
}

function savedRecord(patch: Partial<JournalClientRecord> = {}): JournalClientRecord {
  return {
    version: 1,
    savedAt: '2026-07-31T08:00:00.000Z',
    mirror: {
      entriesById: {},
      entryIdsByDate: {},
      entryIdsByCollection: {},
      collectionsById: {},
      activityById: {},
      activityOrder: [],
      summariesByMonth: {},
      latestSummary: null,
      settings,
      mcpStatus: null,
      today: '2026-07-31',
      serverToday: '2026-07-31',
      timezone: 'America/Los_Angeles',
      cursor: 'epoch:1',
      deviceId: canonicalId('01'),
    },
    draft: '',
    defaultType: 'task',
    outbox: [],
    deadLetters: [],
    agentTokens: [],
    ...patch,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-31T18:00:00.000Z'));
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
  persistenceMocks.load.mockResolvedValue(savedRecord());
  persistenceMocks.save.mockResolvedValue(undefined);
  persistenceMocks.clear.mockResolvedValue(undefined);
  pwaMocks.register.mockResolvedValue(undefined);
  pwaMocks.check.mockResolvedValue(undefined);
  pwaMocks.subscribe.mockImplementation(
    (listener: (state: { updateReady: boolean; offlineReady: boolean }) => void) => {
      listener({ updateReady: false, offlineReady: false });
      return pwaMocks.unsubscribe;
    },
  );
  useJournalStore.setState({ lastReviewSeenAt: null });
});

afterEach(() => {
  journalActions.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('selectOpenTodayCount', () => {
  it('counts open daily-log work due today or earlier', () => {
    seed(
      [
        entry('a'),
        entry('b', { type: 'habit', date: '2026-07-20' }),
        entry('c', { date: '2026-08-01' }),
        entry('d', { state: 'done' }),
        entry('e', { state: 'cancelled' }),
        entry('f', { type: 'note', state: 'logged' }),
        entry('g', { collection: 'project-atlas' }),
        entry('h', { collection: 'month:2026-07' }),
        entry('i', { deletedAt: '2026-07-31T09:00:00.000Z' }),
      ],
      [],
      null,
    );
    expect(selectOpenTodayCount(useJournalStore.getState())).toBe(2);
  });

  it('is zero on an empty journal', () => {
    seed([], [], null);
    expect(selectOpenTodayCount(useJournalStore.getState())).toBe(0);
  });
});

describe('selectUnseenReviewCount', () => {
  const recent = [
    activity(canonicalId('11'), '2026-07-31T09:00:00.000Z'),
    activity(canonicalId('12'), '2026-07-31T12:00:00.000Z'),
    activity(canonicalId('13'), '2026-07-31T15:00:00.000Z'),
  ];

  it('treats every recorded change as unseen until Review is first opened', () => {
    seed([], recent, null);
    expect(selectUnseenReviewCount(useJournalStore.getState())).toBe(3);
  });

  it('counts only what arrived after the mark, and treats the mark itself as seen', () => {
    seed([], recent, '2026-07-31T12:00:00.000Z');
    expect(selectUnseenReviewCount(useJournalStore.getState())).toBe(1);

    seed([], recent, '2026-07-31T15:00:00.000Z');
    expect(selectUnseenReviewCount(useJournalStore.getState())).toBe(0);
  });

  it('ignores the owner’s own reverts', () => {
    seed(
      [],
      [...recent, activity(canonicalId('14'), '2026-07-31T16:00:00.000Z', { kind: 'revert' })],
      '2026-07-31T15:00:00.000Z',
    );
    expect(selectUnseenReviewCount(useJournalStore.getState())).toBe(0);
  });

  it('survives an order entry that has no activity behind it', () => {
    seed([], recent, null);
    useJournalStore.setState({
      activityOrder: [canonicalId('99'), ...recent.map((row) => row.id)],
    });
    expect(selectUnseenReviewCount(useJournalStore.getState())).toBe(3);
  });
});

describe('markReviewSeen', () => {
  it('clears the badge and persists the mark in the client record', async () => {
    seed([], [activity(canonicalId('11'), '2026-07-31T09:00:00.000Z')], null);
    expect(selectUnseenReviewCount(useJournalStore.getState())).toBe(1);

    journalActions.markReviewSeen();
    expect(useJournalStore.getState().lastReviewSeenAt).toBe('2026-07-31T18:00:00.000Z');
    expect(selectUnseenReviewCount(useJournalStore.getState())).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(persistenceMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ lastReviewSeenAt: '2026-07-31T18:00:00.000Z' }),
    );
  });
});

describe('review mark hydration', () => {
  it('reads a record written before the mark existed as never opened', async () => {
    await journalActions.initialize();
    expect(useJournalStore.getState().lastReviewSeenAt).toBeNull();
  });

  it('restores a stored mark', async () => {
    persistenceMocks.load.mockResolvedValue(
      savedRecord({ lastReviewSeenAt: '2026-07-30T22:00:00.000Z' }),
    );
    await journalActions.initialize();
    expect(useJournalStore.getState().lastReviewSeenAt).toBe('2026-07-30T22:00:00.000Z');
  });

  it('starts a first-run journal without a mark', async () => {
    persistenceMocks.load.mockResolvedValue(undefined);
    useJournalStore.setState({ lastReviewSeenAt: '2026-07-30T22:00:00.000Z' });
    await journalActions.initialize();
    expect(useJournalStore.getState().lastReviewSeenAt).toBeNull();
  });
});
