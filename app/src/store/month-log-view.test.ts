// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '../api/types';
import { DEFAULT_LOG_VIEW, type LogViewConfig } from '../views/log-arrangement';
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

import { journalActions, useJournalStore } from './journal-store';

const settings: Settings = {
  density: 'comfortable',
  showTypeBadges: true,
  highlightAiEntries: true,
  updatedAt: '2026-07-31T08:00:00.000Z',
};

const canonicalId = (suffix: string): string => `01K1H00000000000000000${suffix}`;

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

const narrowedView: LogViewConfig = {
  ...DEFAULT_LOG_VIEW,
  sort: 'oldest',
  types: ['task'],
};

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
  useJournalStore.setState({ monthLogView: null });
});

afterEach(() => {
  journalActions.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('setMonthLogView', () => {
  it('stores the arrangement and persists it in the client record', async () => {
    journalActions.setMonthLogView(narrowedView);
    expect(useJournalStore.getState().monthLogView).toEqual(narrowedView);

    await vi.advanceTimersByTimeAsync(100);
    expect(persistenceMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ monthLogView: narrowedView }),
    );
  });

  it('clears back to the default with null', async () => {
    useJournalStore.setState({ monthLogView: narrowedView });
    journalActions.setMonthLogView(null);
    expect(useJournalStore.getState().monthLogView).toBeNull();

    await vi.advanceTimersByTimeAsync(100);
    expect(persistenceMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ monthLogView: null }),
    );
  });
});

describe('setCollectionLogView', () => {
  it('stores the collection arrangement and persists it in the client record', async () => {
    journalActions.setCollectionLogView(narrowedView);
    expect(useJournalStore.getState().collectionLogView).toEqual(narrowedView);

    await vi.advanceTimersByTimeAsync(100);
    expect(persistenceMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ collectionLogView: narrowedView }),
    );
  });
});

describe('collection log view hydration', () => {
  it('reads older records as unset', async () => {
    await journalActions.initialize();
    expect(useJournalStore.getState().collectionLogView).toBeNull();
  });

  it('restores a stored arrangement', async () => {
    persistenceMocks.load.mockResolvedValue(savedRecord({ collectionLogView: narrowedView }));
    await journalActions.initialize();
    expect(useJournalStore.getState().collectionLogView).toEqual(narrowedView);
  });
});

describe('month log view hydration', () => {
  it('reads a record written before the preference existed as unset', async () => {
    await journalActions.initialize();
    expect(useJournalStore.getState().monthLogView).toBeNull();
  });

  it('restores a stored arrangement', async () => {
    persistenceMocks.load.mockResolvedValue(savedRecord({ monthLogView: narrowedView }));
    await journalActions.initialize();
    expect(useJournalStore.getState().monthLogView).toEqual(narrowedView);
  });

  it('starts a first-run journal without an arrangement', async () => {
    persistenceMocks.load.mockResolvedValue(undefined);
    useJournalStore.setState({ monthLogView: narrowedView });
    await journalActions.initialize();
    expect(useJournalStore.getState().monthLogView).toBeNull();
  });

  it('lets a saved copy of the superseded default yield to the current one', async () => {
    // A device that ever tapped "Reset to defaults" has the old default
    // written out; it must not pin newest-first forever.
    const legacyDefault: LogViewConfig = {
      sort: 'newest',
      group: 'none',
      stateFilter: 'open',
      types: [],
    };
    persistenceMocks.load.mockResolvedValue(
      savedRecord({ monthLogView: legacyDefault, collectionLogView: legacyDefault }),
    );
    await journalActions.initialize();
    expect(useJournalStore.getState().monthLogView).toBeNull();
    expect(useJournalStore.getState().collectionLogView).toBeNull();
  });
});
