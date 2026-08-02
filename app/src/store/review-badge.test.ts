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
  selectHasUnseenActivity,
  selectOpenTodayCount,
  selectLatestAgentTouches,
  selectUnseenActivityCount,
  selectUnseenActivityIds,
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
    dateStated: true,
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
    activitySeenThrough: null,
    seenActivityIds: [],
    activityHasMore: false,
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
  useJournalStore.setState({
    lastReviewSeenAt: null,
    activitySeenThrough: null,
    seenActivityIds: [],
    activityHasMore: false,
  });
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

describe('Activity unseen state', () => {
  const recent = [
    activity(canonicalId('11'), '2026-07-31T09:00:00.000Z'),
    activity(canonicalId('12'), '2026-07-31T12:00:00.000Z'),
    activity(canonicalId('13'), '2026-07-31T15:00:00.000Z'),
  ];

  it('treats every recorded change as unseen until Activity rows are acknowledged', () => {
    seed([], recent, null);
    expect(selectUnseenActivityCount(useJournalStore.getState())).toBe(3);
  });

  it('counts only what arrived after the mark, and treats the mark itself as seen', () => {
    seed([], recent, '2026-07-31T12:00:00.000Z');
    expect(selectUnseenActivityCount(useJournalStore.getState())).toBe(1);

    seed([], recent, '2026-07-31T15:00:00.000Z');
    expect(selectUnseenActivityCount(useJournalStore.getState())).toBe(0);
  });

  it('ignores the owner’s own reverts', () => {
    seed(
      [],
      [...recent, activity(canonicalId('14'), '2026-07-31T16:00:00.000Z', { kind: 'revert' })],
      '2026-07-31T15:00:00.000Z',
    );
    expect(selectUnseenActivityCount(useJournalStore.getState())).toBe(0);
  });

  it('survives an order entry that has no activity behind it', () => {
    seed([], recent, null);
    useJournalStore.setState({
      activityOrder: [canonicalId('99'), ...recent.map((row) => row.id)],
    });
    expect(selectUnseenActivityCount(useJournalStore.getState())).toBe(3);
  });

  it('acknowledges only rows that actually became visible', async () => {
    seed([], recent, null);
    journalActions.markActivityVisible([recent[0]!.id, recent[2]!.id]);

    expect(selectUnseenActivityIds(useJournalStore.getState())).toEqual([recent[1]!.id]);
    await vi.advanceTimersByTimeAsync(100);
    expect(persistenceMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ seenActivityIds: [recent[0]!.id, recent[2]!.id] }),
    );
  });
});

describe('markAllActivitySeen', () => {
  it('clears the badge at the newest real event and persists the exact cursor', async () => {
    seed([], [activity(canonicalId('11'), '2026-07-31T09:00:00.000Z')], null);
    expect(selectUnseenActivityCount(useJournalStore.getState())).toBe(1);

    journalActions.markAllActivitySeen();
    expect(useJournalStore.getState().activitySeenThrough).toEqual({
      at: '2026-07-31T09:00:00.000Z',
      id: canonicalId('11'),
    });
    expect(selectUnseenActivityCount(useJournalStore.getState())).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(persistenceMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        activitySeenThrough: {
          at: '2026-07-31T09:00:00.000Z',
          id: canonicalId('11'),
        },
      }),
    );
  });

  it('does not hide a later event with the same server timestamp', () => {
    const at = '2026-07-31T09:00:00.000Z';
    const older = activity(canonicalId('11'), at);
    const marked = activity(canonicalId('12'), at);
    const later = activity(canonicalId('13'), at);
    seed([], [older, marked], null);
    journalActions.markAllActivitySeen();
    useJournalStore.setState({
      activityById: { ...useJournalStore.getState().activityById, [later.id]: later },
      activityOrder: [later.id, marked.id, older.id],
    });

    expect(selectUnseenActivityIds(useJournalStore.getState())).toEqual([later.id]);
  });
});

describe('selectHasUnseenActivity', () => {
  const page = [
    activity(canonicalId('11'), '2026-07-31T09:00:00.000Z'),
    activity(canonicalId('12'), '2026-07-31T12:00:00.000Z'),
  ];

  it('keeps a neutral unseen signal while pagination has not reached a seen cursor', () => {
    seed([], page, null);
    journalActions.markActivityVisible(page.map((item) => item.id));
    useJournalStore.setState({ activityHasMore: true });
    expect(selectUnseenActivityIds(useJournalStore.getState())).toEqual([]);
    expect(selectHasUnseenActivity(useJournalStore.getState())).toBe(true);
  });

  it('clears the conservative signal after explicit Mark all seen', () => {
    seed([], page, null);
    useJournalStore.setState({ activityHasMore: true });
    journalActions.markAllActivitySeen();
    expect(selectHasUnseenActivity(useJournalStore.getState())).toBe(false);
  });
});

describe('selectLatestAgentTouches', () => {
  it('exposes only the newest compact agent touch for each entry', () => {
    const entryId = canonicalId('21');
    const actor = { kind: 'agent' as const, label: 'Planning agent', tokenId: canonicalId('99') };
    const older = activity(canonicalId('11'), '2026-07-31T09:00:00.000Z', {
      presentation: {
        actor,
        action: 'added',
        objectLabel: '“Plan the launch”',
        primaryEntryId: entryId,
        reason: null,
        attribution: [],
        lineage: null,
        latestAgentTouch: {
          activityId: canonicalId('11'),
          entryId,
          at: '2026-07-31T09:00:00.000Z',
          actor,
          action: 'added',
          reason: null,
        },
      },
    });
    const newer = activity(canonicalId('12'), '2026-07-31T10:00:00.000Z', {
      presentation: {
        ...older.presentation!,
        action: 'updated',
        latestAgentTouch: {
          ...older.presentation!.latestAgentTouch!,
          activityId: canonicalId('12'),
          at: '2026-07-31T10:00:00.000Z',
          action: 'updated',
        },
      },
    });
    seed([], [older, newer], null);

    expect(selectLatestAgentTouches(useJournalStore.getState())[entryId]).toEqual(
      newer.presentation?.latestAgentTouch,
    );
  });
});

describe('Activity mark hydration', () => {
  it('reads a record written before the mark existed as never opened', async () => {
    await journalActions.initialize();
    expect(useJournalStore.getState().lastReviewSeenAt).toBeNull();
    expect(useJournalStore.getState().activitySeenThrough).toBeNull();
  });

  it('restores a stored mark', async () => {
    persistenceMocks.load.mockResolvedValue(
      savedRecord({ lastReviewSeenAt: '2026-07-30T22:00:00.000Z' }),
    );
    await journalActions.initialize();
    expect(useJournalStore.getState().lastReviewSeenAt).toBe('2026-07-30T22:00:00.000Z');
  });

  it('restores exact and individually visible Activity marks', async () => {
    persistenceMocks.load.mockResolvedValue(
      savedRecord({
        activitySeenThrough: { at: '2026-07-30T20:00:00.000Z', id: canonicalId('11') },
        seenActivityIds: [canonicalId('12')],
      }),
    );
    await journalActions.initialize();
    expect(useJournalStore.getState().activitySeenThrough).toEqual({
      at: '2026-07-30T20:00:00.000Z',
      id: canonicalId('11'),
    });
    expect(useJournalStore.getState().seenActivityIds).toEqual([canonicalId('12')]);
  });

  it('starts a first-run journal without a mark', async () => {
    persistenceMocks.load.mockResolvedValue(undefined);
    useJournalStore.setState({
      lastReviewSeenAt: '2026-07-30T22:00:00.000Z',
      activitySeenThrough: { at: '2026-07-30T22:00:00.000Z', id: canonicalId('11') },
      seenActivityIds: [canonicalId('12')],
    });
    await journalActions.initialize();
    expect(useJournalStore.getState().lastReviewSeenAt).toBeNull();
    expect(useJournalStore.getState().activitySeenThrough).toBeNull();
    expect(useJournalStore.getState().seenActivityIds).toEqual([]);
  });
});
