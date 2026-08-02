// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, journalApi } from '../api/client';
import type { Entry, Settings, Summary } from '../api/types';
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
  reconcileAfterReset,
  selectJournalStatus,
  useJournalStore,
} from './journal-store';

const settings: Settings = {
  density: 'comfortable',
  showTypeBadges: true,
  highlightAiEntries: true,
  updatedAt: '2026-07-31T08:00:00.000Z',
};

function savedRecord(): JournalClientRecord {
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
      today: '2026-07-30',
      serverToday: '2026-07-31',
      timezone: 'America/Los_Angeles',
      cursor: 'epoch:1',
      deviceId: '01K1H000000000000000000001',
    },
    draft: 'downloaded draft',
    defaultType: 'task',
    outbox: [],
    deadLetters: [],
    agentTokens: [],
  };
}

let visibility: DocumentVisibilityState;
let networkOnline: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-01T01:00:00.000Z'));
  visibility = 'visible';
  networkOnline = false;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => networkOnline);
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
    hydrated: false,
    loading: true,
    resourceStatus: 'loading',
    online: false,
    networkOnline: false,
    connectionStatus: 'offline',
    authenticationRequired: false,
    persistenceStatus: 'available',
    syncing: false,
    draft: '',
    notices: [],
  });
});

afterEach(() => {
  journalActions.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('journal lifecycle persistence', () => {
  const staleEntry: Entry = {
    id: '01K1H000000000000000000041',
    date: '2026-01-10',
    type: 'note',
    text: 'Stale saved history',
    state: 'logged',
    time: null,
    tags: [],
    author: 'me',
    source: null,
    migrations: 0,
    collection: null,
    createdAt: '2026-01-10T08:00:00.000Z',
    updatedAt: '2026-01-10T08:00:00.000Z',
    revision: 1,
    deletedAt: null,
  };
  const staleSummary: Summary = {
    id: '01K1H000000000000000000042',
    weekStart: '2026-06-29',
    text: 'Stale saved summary',
    status: 'current',
    source: 'Saved assistant summary',
    tokenId: '01K1H000000000000000000043',
    savedEntryId: null,
    createdAt: '2026-07-05T08:00:00.000Z',
    updatedAt: '2026-07-05T08:00:00.000Z',
    revision: 1,
  };

  const savedWithHistory = (): JournalClientRecord => {
    const record = savedRecord();
    return {
      ...record,
      mirror: {
        ...record.mirror,
        entriesById: { [staleEntry.id]: staleEntry },
        entryIdsByDate: { [staleEntry.date]: [staleEntry.id] },
        summariesByMonth: { '2026-06': staleSummary },
        latestSummary: staleSummary,
        cursor: 'old-epoch:7',
      },
    };
  };

  const mockCanonicalBootstrap = (): void => {
    vi.spyOn(journalApi, 'bootstrap').mockResolvedValue({
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
      deviceId: '01K1H000000000000000000044',
      cursor: 'new-epoch:20',
      entries: [],
      collections: [],
      latestSummary: null,
      activity: [],
      settings,
    });
    vi.spyOn(journalApi, 'getSettings').mockResolvedValue({
      settings,
      assistant: {
        endpoint: 'https://journal.test/mcp',
        status: 'ready',
        activeSessions: 0,
      },
    });
    vi.spyOn(journalApi, 'listEntries').mockResolvedValue({
      items: [],
      nextCursor: null,
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });
  };

  const openEventSource = (replay?: 'change' | 'reset'): void => {
    let sourceCount = 0;
    class OpeningEventSource extends EventTarget {
      close = vi.fn();

      constructor() {
        super();
        sourceCount += 1;
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'));
          if (sourceCount !== 1 || !replay) return;
          if (replay === 'reset') {
            this.dispatchEvent(
              new MessageEvent('reset', {
                lastEventId: 'new-epoch:20',
                data: JSON.stringify({
                  reason: 'server_restarted',
                  currentCursor: 'new-epoch:20',
                }),
              }),
            );
            this.dispatchEvent(
              new MessageEvent('replay-ready', {
                lastEventId: 'new-epoch:20',
                data: JSON.stringify({ cursor: 'new-epoch:20' }),
              }),
            );
            return;
          }
          this.dispatchEvent(
            new MessageEvent('change', {
              lastEventId: 'old-epoch:8',
              data: JSON.stringify({
                transactionId: '01K1H000000000000000000045',
                mutationId: null,
                origin: { kind: 'system' },
                changes: [
                  {
                    kind: 'entry.updated',
                    payload: {
                      ...staleEntry,
                      text: 'Canonical replayed history',
                      revision: 2,
                      updatedAt: '2026-07-31T08:30:00.000Z',
                    },
                  },
                ],
              }),
            }),
          );
          this.dispatchEvent(
            new MessageEvent('replay-ready', {
              lastEventId: 'old-epoch:8',
              data: JSON.stringify({ cursor: 'old-epoch:8' }),
            }),
          );
        });
      }
    }
    vi.stubGlobal('EventSource', OpeningEventSource);
  };

  it('surfaces a store-owned service-worker registration failure', async () => {
    pwaMocks.register.mockRejectedValueOnce(new Error('temporary registration failure'));

    await journalActions.initialize();
    await vi.waitFor(() =>
      expect(useJournalStore.getState().notices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Offline app setup failed.',
          }),
        ]),
      ),
    );

    expect(pwaMocks.register).toHaveBeenCalledTimes(1);
  });

  const autoReadyEventSources = (cursor: string): EventTarget[] => {
    const sources: EventTarget[] = [];
    class ReadyEventSource extends EventTarget {
      close = vi.fn();

      constructor() {
        super();
        sources.push(this);
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'));
          this.dispatchEvent(
            new MessageEvent('replay-ready', {
              lastEventId: cursor,
              data: JSON.stringify({ cursor }),
            }),
          );
        });
      }
    }
    vi.stubGlobal('EventSource', ReadyEventSource);
    return sources;
  };

  it('restores and resumes today in the persisted journal timezone while offline', async () => {
    await journalActions.initialize();

    expect(useJournalStore.getState()).toMatchObject({
      hydrated: true,
      resourceStatus: 'ready',
      today: '2026-07-31',
      serverToday: '2026-07-31',
      timezone: 'America/Los_Angeles',
      connectionStatus: 'offline',
    });

    vi.setSystemTime(new Date('2026-08-01T08:00:01.000Z'));
    window.dispatchEvent(new Event('pageshow'));

    expect(useJournalStore.getState().today).toBe('2026-08-01');
    expect(persistenceMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          today: '2026-08-01',
          serverToday: '2026-07-31',
          timezone: 'America/Los_Angeles',
        }),
      }),
    );
  });

  it('marks an uncached startup unavailable instead of rendering it as an empty journal', async () => {
    networkOnline = true;
    persistenceMocks.load.mockResolvedValue(undefined);
    vi.spyOn(journalApi, 'getSettings').mockResolvedValue({
      settings,
      assistant: {
        endpoint: 'https://journal.test/mcp',
        status: 'ready',
        activeSessions: 0,
      },
    });
    vi.spyOn(journalApi, 'bootstrap').mockRejectedValue(
      new ApiError(503, 'unavailable', 'Journal server stopped.'),
    );

    await journalActions.initialize();

    expect(useJournalStore.getState()).toMatchObject({
      resourceStatus: 'error',
      connectionStatus: 'error',
      authenticationRequired: false,
      online: false,
    });
    expect(selectJournalStatus(useJournalStore.getState())).toMatchObject({
      resource: 'error',
      connection: 'serverUnavailable',
    });
  });

  it('marks a failed outbox write as tab-only until a durable retry succeeds', async () => {
    await journalActions.initialize();
    persistenceMocks.save.mockRejectedValueOnce(new Error('IndexedDB transaction aborted.'));

    await expect(
      journalActions.createEntry({
        text: 'Keep this tab open',
        type: 'note',
        date: '2026-07-31',
      }),
    ).rejects.toThrow('IndexedDB transaction aborted.');

    expect(useJournalStore.getState()).toMatchObject({
      persistenceStatus: 'unavailable',
      outboxCount: 1,
    });
    expect(selectJournalStatus(useJournalStore.getState())).toMatchObject({
      synchronization: 'attention',
      persistence: 'unavailable',
      pendingChanges: 1,
    });

    await journalActions.retryLocalSave();

    expect(useJournalStore.getState()).toMatchObject({
      persistenceStatus: 'available',
      outboxCount: 1,
    });
  });

  it('flushes a pending draft immediately when the document becomes hidden', async () => {
    await journalActions.initialize();
    persistenceMocks.save.mockClear();

    journalActions.setDraft('safe before suspension');
    expect(persistenceMocks.save).not.toHaveBeenCalled();

    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));

    expect(persistenceMocks.save).toHaveBeenCalledTimes(1);
    expect(persistenceMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ draft: 'safe before suspension' }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(persistenceMocks.save).toHaveBeenCalledTimes(1);
  });

  it('flushes and clears the draft timer during shutdown', async () => {
    await journalActions.initialize();
    persistenceMocks.save.mockClear();

    journalActions.setDraft('safe before unmount');
    journalActions.shutdown();

    expect(persistenceMocks.save).toHaveBeenCalledTimes(1);
    expect(persistenceMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ draft: 'safe before unmount' }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(persistenceMocks.save).toHaveBeenCalledTimes(1);
  });

  it('waits for the pending journal snapshot before activating an update', async () => {
    await journalActions.initialize();
    let releaseSave!: () => void;
    persistenceMocks.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        }),
    );

    journalActions.setDraft('safe before reload');
    const activation = journalActions.activateUpdate();

    expect(persistenceMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ draft: 'safe before reload' }),
    );
    expect(pwaMocks.activate).not.toHaveBeenCalled();

    releaseSave();
    await activation;
    expect(pwaMocks.activate).toHaveBeenCalledTimes(1);
  });

  it('ignores a persistence load that finishes after shutdown', async () => {
    let releaseLoad!: (record: JournalClientRecord) => void;
    persistenceMocks.load.mockReturnValueOnce(
      new Promise<JournalClientRecord>((resolve) => {
        releaseLoad = resolve;
      }),
    );
    useJournalStore.setState({ hydrated: false, draft: 'current lifecycle' });

    const initialization = journalActions.initialize();
    journalActions.shutdown();
    releaseLoad(savedRecord());
    await initialization;

    expect(useJournalStore.getState()).toMatchObject({
      hydrated: false,
      draft: 'current lifecycle',
    });
    expect(pwaMocks.subscribe).not.toHaveBeenCalled();
  });

  it('replays a saved cursor before flushing or refreshing today without bootstrapping', async () => {
    networkOnline = true;
    persistenceMocks.load.mockResolvedValue(savedWithHistory());
    mockCanonicalBootstrap();
    openEventSource('change');

    const initialization = journalActions.initialize();
    await vi.advanceTimersByTimeAsync(100);
    await initialization;

    const state = useJournalStore.getState();
    expect(journalApi.bootstrap).not.toHaveBeenCalled();
    expect(journalApi.listEntries).toHaveBeenCalledWith({
      from: '2026-07-31',
      to: '2026-07-31',
      limit: 100,
    });
    expect(state.entriesById[staleEntry.id]).toMatchObject({
      text: 'Canonical replayed history',
      revision: 2,
    });
    expect(state.summariesByMonth['2026-06']).toEqual(staleSummary);
    expect(state.cursor).toBe('old-epoch:8');
    expect(persistenceMocks.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          entriesById: {
            [staleEntry.id]: expect.objectContaining({ text: 'Canonical replayed history' }),
          },
          summariesByMonth: { '2026-06': staleSummary },
          cursor: 'old-epoch:8',
        }),
      }),
    );
  });

  it('persists a newly paired device identity before waiting for saved-cursor replay', async () => {
    networkOnline = true;
    const pairedDeviceId = '01K1H000000000000000000046';
    vi.spyOn(journalApi, 'getSettings')
      .mockRejectedValueOnce(new ApiError(401, 'unauthenticated', 'Pair first.'))
      .mockResolvedValue({
        settings,
        assistant: {
          endpoint: 'https://journal.test/mcp',
          status: 'ready',
          activeSessions: 0,
        },
      });
    vi.spyOn(journalApi, 'pair').mockResolvedValue({
      deviceId: pairedDeviceId,
      expiresAt: '2026-08-30T08:00:00.000Z',
    });

    const initialization = journalActions.initialize();
    await vi.waitFor(() =>
      expect(persistenceMocks.save).toHaveBeenCalledWith(
        expect.objectContaining({
          mirror: expect.objectContaining({ deviceId: pairedDeviceId }),
        }),
      ),
    );

    journalActions.shutdown();
    await initialization;
  });

  it('persists a newly paired identity even when the authenticated retry then loses the network', async () => {
    networkOnline = true;
    const pairedDeviceId = '01K1H000000000000000000048';
    let rejectAuthenticatedRetry!: (reason: unknown) => void;
    const getSettings = vi
      .spyOn(journalApi, 'getSettings')
      .mockRejectedValueOnce(new ApiError(401, 'unauthenticated', 'Pair first.'))
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectAuthenticatedRetry = reject;
        }),
      );
    vi.spyOn(journalApi, 'pair').mockResolvedValue({
      deviceId: pairedDeviceId,
      expiresAt: '2026-08-30T08:00:00.000Z',
    });

    const initialization = journalActions.initialize();
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    expect(persistenceMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({ deviceId: pairedDeviceId }),
      }),
    );

    rejectAuthenticatedRetry(new ApiError(0, 'network_error', 'Network disappeared.'));
    await initialization;

    expect(useJournalStore.getState()).toMatchObject({
      deviceId: pairedDeviceId,
      connectionStatus: 'error',
      online: false,
    });
  });

  it('coalesces a pageshow received during initial authentication into a post-startup replay', async () => {
    networkOnline = true;
    persistenceMocks.load.mockResolvedValue(savedWithHistory());
    let rejectInitialAuthentication!: (reason: unknown) => void;
    const getSettings = vi
      .spyOn(journalApi, 'getSettings')
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectInitialAuthentication = reject;
        }),
      )
      .mockResolvedValue({
        settings,
        assistant: {
          endpoint: 'https://journal.test/mcp',
          status: 'ready',
          activeSessions: 0,
        },
      });
    const pair = vi.spyOn(journalApi, 'pair').mockResolvedValue({
      deviceId: '01K1H000000000000000000049',
      expiresAt: '2026-08-30T08:00:00.000Z',
    });
    vi.spyOn(journalApi, 'listEntries').mockResolvedValue({
      items: [],
      nextCursor: null,
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });
    const sources = autoReadyEventSources('old-epoch:7');

    const initialization = journalActions.initialize();
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event('pageshow'));
    await Promise.resolve();
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(0);

    rejectInitialAuthentication(new ApiError(401, 'unauthenticated', 'Pair first.'));
    await initialization;
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    await vi.waitFor(() => expect(useJournalStore.getState().connectionStatus).toBe('connected'));

    expect(getSettings).toHaveBeenCalledTimes(2);
    expect(pair).toHaveBeenCalledTimes(1);
    expect(useJournalStore.getState().online).toBe(true);
    expect(
      useJournalStore
        .getState()
        .notices.some((notice) => notice.message.includes('Reload Journal to reconnect')),
    ).toBe(false);
  });

  it('keeps a capture queued while saved-cursor authentication is still pending', async () => {
    networkOnline = true;
    persistenceMocks.load.mockResolvedValue(savedWithHistory());
    let releaseSettings!: (value: Awaited<ReturnType<typeof journalApi.getSettings>>) => void;
    vi.spyOn(journalApi, 'getSettings').mockReturnValue(
      new Promise((resolve) => {
        releaseSettings = resolve;
      }),
    );
    vi.spyOn(journalApi, 'listEntries').mockResolvedValue({
      items: [],
      nextCursor: null,
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });
    const createEntry = vi.spyOn(journalApi, 'createEntry').mockImplementation(async (input) => {
      const optimistic = useJournalStore.getState().entriesById[input.id];
      if (!optimistic) throw new Error('Optimistic entry was not retained through replay.');
      return {
        entry: {
          ...optimistic,
          revision: 2,
          updatedAt: '2026-07-31T08:10:00.000Z',
        },
      };
    });
    class ReadyEventSource extends EventTarget {
      close = vi.fn();

      constructor() {
        super();
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'));
          this.dispatchEvent(
            new MessageEvent('replay-ready', {
              lastEventId: 'old-epoch:7',
              data: JSON.stringify({ cursor: 'old-epoch:7' }),
            }),
          );
        });
      }
    }
    vi.stubGlobal('EventSource', ReadyEventSource);

    const initialization = journalActions.initialize();
    await vi.waitFor(() => expect(useJournalStore.getState().hydrated).toBe(true));
    await journalActions.createEntry({
      text: 'Captured while authentication is pending',
      type: 'note',
      date: '2026-07-31',
    });

    expect(createEntry).not.toHaveBeenCalled();
    expect(useJournalStore.getState().outboxCount).toBe(1);

    releaseSettings({
      settings,
      assistant: {
        endpoint: 'https://journal.test/mcp',
        status: 'ready',
        activeSessions: 0,
      },
    });
    await initialization;

    expect(createEntry).toHaveBeenCalledTimes(1);
    expect(useJournalStore.getState()).toMatchObject({
      connectionStatus: 'connected',
      online: true,
      outboxCount: 0,
    });
  });

  it('probes and reconnects queued offline work when the browser omits its online event', async () => {
    networkOnline = false;
    persistenceMocks.load.mockResolvedValue(savedWithHistory());
    vi.spyOn(journalApi, 'getSettings').mockResolvedValue({
      settings,
      assistant: {
        endpoint: 'https://journal.test/mcp',
        status: 'ready',
        activeSessions: 0,
      },
    });
    vi.spyOn(journalApi, 'listEntries').mockResolvedValue({
      items: [],
      nextCursor: null,
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });
    const createEntry = vi.spyOn(journalApi, 'createEntry').mockImplementation(async (input) => {
      const optimistic = useJournalStore.getState().entriesById[input.id];
      if (!optimistic) throw new Error('Offline capture was not retained for recovery.');
      return {
        entry: {
          ...optimistic,
          revision: 2,
          updatedAt: '2026-07-31T08:10:00.000Z',
        },
      };
    });
    class ReadyEventSource extends EventTarget {
      close = vi.fn();

      constructor() {
        super();
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'));
          this.dispatchEvent(
            new MessageEvent('replay-ready', {
              lastEventId: 'old-epoch:7',
              data: JSON.stringify({ cursor: 'old-epoch:7' }),
            }),
          );
        });
      }
    }
    vi.stubGlobal('EventSource', ReadyEventSource);
    await journalActions.initialize();

    await journalActions.createEntry({
      text: 'Offline capture awaiting a connectivity probe',
      type: 'note',
      date: '2026-07-31',
    });
    expect(createEntry).not.toHaveBeenCalled();

    networkOnline = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    expect(useJournalStore.getState()).toMatchObject({
      networkOnline: true,
      connectionStatus: 'connected',
      online: true,
      outboxCount: 0,
    });
  });

  it('keeps pairing paused when authentication still returns 401 after pairing', async () => {
    networkOnline = true;
    const getSettings = vi
      .spyOn(journalApi, 'getSettings')
      .mockRejectedValue(new ApiError(401, 'unauthenticated', 'Pairing rejected.'));
    const pair = vi.spyOn(journalApi, 'pair').mockResolvedValue({
      deviceId: '01K1H000000000000000000047',
      expiresAt: '2026-08-30T08:00:00.000Z',
    });

    await journalActions.initialize();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(getSettings).toHaveBeenCalledTimes(2);
    expect(pair).toHaveBeenCalledTimes(1);
    expect(useJournalStore.getState()).toMatchObject({
      connectionStatus: 'error',
      online: false,
      authenticationRequired: true,
      resourceStatus: 'ready',
    });
    expect(
      useJournalStore
        .getState()
        .notices.filter((notice) => notice.message.includes('Reload Journal to reconnect')),
    ).toHaveLength(1);
  });

  it('does not enter the online state until the bootstrapped stream is replay-ready', async () => {
    networkOnline = true;
    persistenceMocks.load.mockResolvedValue(undefined);
    mockCanonicalBootstrap();
    const sources: EventTarget[] = [];
    class ManualEventSource extends EventTarget {
      close = vi.fn();

      constructor() {
        super();
        sources.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
    }
    vi.stubGlobal('EventSource', ManualEventSource);

    const initialization = journalActions.initialize();
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    expect(useJournalStore.getState()).toMatchObject({
      connectionStatus: 'connecting',
      online: false,
    });

    sources[0]?.dispatchEvent(
      new MessageEvent('replay-ready', {
        lastEventId: 'new-epoch:20',
        data: JSON.stringify({ cursor: 'new-epoch:20' }),
      }),
    );
    await initialization;
    expect(useJournalStore.getState()).toMatchObject({
      connectionStatus: 'connected',
      online: true,
    });
  });

  it('does not open a stream when a first bootstrap finishes after the page becomes hidden', async () => {
    networkOnline = true;
    persistenceMocks.load.mockResolvedValue(undefined);
    let resolveBootstrap!: (value: Awaited<ReturnType<typeof journalApi.bootstrap>>) => void;
    vi.spyOn(journalApi, 'bootstrap').mockReturnValue(
      new Promise((resolve) => {
        resolveBootstrap = resolve;
      }),
    );
    vi.spyOn(journalApi, 'getSettings').mockResolvedValue({
      settings,
      assistant: {
        endpoint: 'https://journal.test/mcp',
        status: 'ready',
        activeSessions: 0,
      },
    });
    vi.spyOn(journalApi, 'listEntries').mockResolvedValue({
      items: [],
      nextCursor: null,
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });
    const sources = autoReadyEventSources('new-epoch:20');

    const initialization = journalActions.initialize();
    await vi.waitFor(() => expect(journalApi.bootstrap).toHaveBeenCalledTimes(1));
    expect(useJournalStore.getState()).toMatchObject({
      hydrated: true,
      loading: true,
      resourceStatus: 'loading',
    });
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    resolveBootstrap({
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
      deviceId: '01K1H000000000000000000044',
      cursor: 'new-epoch:20',
      entries: [],
      collections: [],
      latestSummary: null,
      activity: [],
      settings,
    });
    await initialization;

    expect(sources).toHaveLength(0);
    expect(useJournalStore.getState()).toMatchObject({
      connectionStatus: 'offline',
      online: false,
      resourceStatus: 'ready',
    });

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    await vi.waitFor(() => expect(useJournalStore.getState().connectionStatus).toBe('connected'));
  });

  it('replays again when hide and resume happen during the initial Today refresh', async () => {
    networkOnline = true;
    persistenceMocks.load.mockResolvedValue(savedWithHistory());
    mockCanonicalBootstrap();
    let resolveInitialToday!: (value: Awaited<ReturnType<typeof journalApi.listEntries>>) => void;
    vi.mocked(journalApi.listEntries)
      .mockReset()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveInitialToday = resolve;
        }),
      )
      .mockResolvedValue({
        items: [],
        nextCursor: null,
        today: '2026-07-31',
        timezone: 'Europe/Amsterdam',
      });
    const sources = autoReadyEventSources('old-epoch:7');

    const initialization = journalActions.initialize();
    await vi.waitFor(() => expect(journalApi.listEntries).toHaveBeenCalledTimes(1));
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    resolveInitialToday({
      items: [],
      nextCursor: null,
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });

    await initialization;
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    await vi.waitFor(() => expect(journalApi.listEntries).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(useJournalStore.getState().connectionStatus).toBe('connected'));
    expect(useJournalStore.getState().online).toBe(true);
  });

  it('recovers initial status-zero authentication without relying on an online event', async () => {
    networkOnline = true;
    persistenceMocks.load.mockResolvedValue(savedWithHistory());
    mockCanonicalBootstrap();
    const getSettings = vi
      .mocked(journalApi.getSettings)
      .mockReset()
      .mockRejectedValueOnce(new ApiError(0, 'network_error', 'Journal is unreachable.'))
      .mockResolvedValue({
        settings,
        assistant: {
          endpoint: 'https://journal.test/mcp',
          status: 'ready',
          activeSessions: 0,
        },
      });
    const sources = autoReadyEventSources('old-epoch:7');

    await journalActions.initialize();
    expect(useJournalStore.getState()).toMatchObject({
      networkOnline: true,
      connectionStatus: 'error',
      online: false,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    await vi.waitFor(() => expect(useJournalStore.getState().connectionStatus).toBe('connected'));
    expect(getSettings).toHaveBeenCalledTimes(2);
    expect(useJournalStore.getState().online).toBe(true);
  });

  it('preserves an outbox retry requested while a resumed Today refresh is still active', async () => {
    networkOnline = true;
    persistenceMocks.load.mockResolvedValue(savedWithHistory());
    mockCanonicalBootstrap();
    const sources = autoReadyEventSources('old-epoch:7');

    await journalActions.initialize();
    expect(sources).toHaveLength(1);

    let resolveResumedToday!: (value: Awaited<ReturnType<typeof journalApi.listEntries>>) => void;
    vi.mocked(journalApi.listEntries).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResumedToday = resolve;
        }),
    );
    window.dispatchEvent(new Event('pageshow'));
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    await vi.waitFor(() => expect(journalApi.listEntries).toHaveBeenCalledTimes(2));

    let createAttempts = 0;
    const createEntry = vi.spyOn(journalApi, 'createEntry').mockImplementation(async (input) => {
      createAttempts += 1;
      if (createAttempts === 1) {
        throw new ApiError(0, 'network_error', 'Journal is unreachable.');
      }
      const optimistic = useJournalStore.getState().entriesById[input.id];
      if (!optimistic) throw new Error('Optimistic entry was not retained for replay.');
      return {
        entry: {
          ...optimistic,
          revision: 2,
          updatedAt: '2026-07-31T08:10:00.000Z',
        },
      };
    });
    await journalActions.createEntry({
      id: '01K1H000000000000000000050',
      text: 'Keep this retry through the active refresh',
      type: 'note',
      date: '2026-07-31',
    });
    await vi.waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1_000);
    resolveResumedToday({
      items: [],
      nextCursor: null,
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });

    await vi.waitFor(() => expect(sources).toHaveLength(3));
    await vi.waitFor(() => expect(createEntry).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(useJournalStore.getState().outboxCount).toBe(0));
    expect(useJournalStore.getState()).toMatchObject({
      connectionStatus: 'connected',
      online: true,
    });
  });

  it('restores the optimistic command when committing a dead letter cannot be persisted', async () => {
    networkOnline = true;
    persistenceMocks.load.mockResolvedValue(savedWithHistory());
    mockCanonicalBootstrap();
    const sources = autoReadyEventSources('old-epoch:7');
    await journalActions.initialize();
    expect(sources).toHaveLength(1);

    vi.spyOn(journalApi, 'updateEntry').mockRejectedValue(
      new ApiError(409, 'revision_conflict', 'The entry changed first.'),
    );
    vi.mocked(journalApi.bootstrap).mockResolvedValue({
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
      deviceId: '01K1H000000000000000000044',
      cursor: 'new-epoch:20',
      entries: [staleEntry],
      collections: [],
      latestSummary: null,
      activity: [],
      settings,
    });
    persistenceMocks.save.mockClear();
    persistenceMocks.save
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('IndexedDB transaction aborted.'))
      .mockResolvedValue(undefined);

    await journalActions.updateEntry(staleEntry.id, { text: 'Keep this optimistic edit' });
    await journalActions.flush();

    expect(persistenceMocks.save).toHaveBeenCalledTimes(2);
    expect(useJournalStore.getState()).toMatchObject({
      outboxCount: 1,
      deadLetters: [],
    });
    expect(useJournalStore.getState().entriesById[staleEntry.id]?.text).toBe(
      'Keep this optimistic edit',
    );
  });

  it('preserves the scheduled reconnect when a ready stream disconnects before REST continues', async () => {
    networkOnline = true;
    persistenceMocks.load.mockResolvedValue(savedWithHistory());
    mockCanonicalBootstrap();
    const sources: EventTarget[] = [];
    class RacingEventSource extends EventTarget {
      close = vi.fn();

      constructor() {
        super();
        const sourceIndex = sources.push(this) - 1;
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'));
          this.dispatchEvent(
            new MessageEvent('replay-ready', {
              lastEventId: 'old-epoch:7',
              data: JSON.stringify({ cursor: 'old-epoch:7' }),
            }),
          );
          if (sourceIndex === 0) queueMicrotask(() => this.dispatchEvent(new Event('error')));
        });
      }
    }
    vi.stubGlobal('EventSource', RacingEventSource);

    await journalActions.initialize();
    expect(journalApi.listEntries).not.toHaveBeenCalled();
    expect(useJournalStore.getState().connectionStatus).toBe('error');

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    await vi.waitFor(() => expect(journalApi.listEntries).toHaveBeenCalledTimes(1));
    expect(useJournalStore.getState()).toMatchObject({
      connectionStatus: 'connected',
      online: true,
    });
  });

  it('reconnects after a post-ready live change handler fails asynchronously', async () => {
    networkOnline = true;
    persistenceMocks.load.mockResolvedValue(savedWithHistory());
    mockCanonicalBootstrap();
    const sources: EventTarget[] = [];
    class RecoveringEventSource extends EventTarget {
      close = vi.fn();

      constructor() {
        super();
        const sourceIndex = sources.push(this) - 1;
        queueMicrotask(() => {
          const cursor = sourceIndex === 0 ? 'old-epoch:7' : 'old-epoch:8';
          this.dispatchEvent(new Event('open'));
          this.dispatchEvent(
            new MessageEvent('replay-ready', {
              lastEventId: cursor,
              data: JSON.stringify({ cursor }),
            }),
          );
        });
      }
    }
    vi.stubGlobal('EventSource', RecoveringEventSource);

    await journalActions.initialize();
    expect(sources).toHaveLength(1);
    expect(useJournalStore.getState().connectionStatus).toBe('connected');

    persistenceMocks.save.mockRejectedValueOnce(new Error('IndexedDB transaction aborted.'));
    sources[0]?.dispatchEvent(
      new MessageEvent('change', {
        lastEventId: 'old-epoch:8',
        data: JSON.stringify({
          transactionId: '01K1H000000000000000000051',
          mutationId: null,
          origin: { kind: 'system' },
          changes: [
            {
              kind: 'entry.updated',
              payload: {
                ...staleEntry,
                text: 'Applied before the failed persistence commit',
                revision: 2,
                updatedAt: '2026-07-31T09:00:00.000Z',
              },
            },
          ],
        }),
      }),
    );

    await vi.waitFor(() =>
      expect((sources[0] as RecoveringEventSource).close).toHaveBeenCalledTimes(1),
    );
    expect(useJournalStore.getState()).toMatchObject({
      cursor: 'old-epoch:8',
      connectionStatus: 'error',
      online: false,
    });
    await vi.waitFor(() => expect(journalApi.getSettings).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    await vi.waitFor(() => expect(useJournalStore.getState().connectionStatus).toBe('connected'));
    expect(useJournalStore.getState().online).toBe(true);
  });

  it('persists only the prior mirror when reset hydration fails mid-refetch', async () => {
    networkOnline = true;
    const saved = savedWithHistory();
    persistenceMocks.load.mockResolvedValue(saved);
    mockCanonicalBootstrap();
    const partialCanonicalEntry = {
      ...staleEntry,
      text: 'Partial canonical row',
      revision: 2,
    };
    vi.mocked(journalApi.bootstrap).mockResolvedValue({
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
      deviceId: '01K1H000000000000000000044',
      cursor: 'new-epoch:20',
      entries: [partialCanonicalEntry],
      collections: [],
      latestSummary: null,
      activity: [],
      settings,
      timeline: {
        today: '2026-07-31',
        timezone: 'Europe/Amsterdam',
        items: [partialCanonicalEntry],
        collections: [],
        nextCursor: null,
      },
    });
    vi.spyOn(journalApi, 'latestSummary').mockRejectedValue(
      new Error('Injected summary refetch failure'),
    );
    openEventSource('reset');

    const initialization = journalActions.initialize();
    await vi.advanceTimersByTimeAsync(100);
    await initialization;

    const state = useJournalStore.getState();
    expect(journalApi.bootstrap).toHaveBeenCalledTimes(1);
    expect(journalApi.listEntries).not.toHaveBeenCalled();
    expect(journalApi.latestSummary).toHaveBeenCalledWith('2026-06');
    expect(state.entriesById[staleEntry.id]).toEqual(staleEntry);
    expect(state.summariesByMonth['2026-06']).toEqual(staleSummary);
    expect(state.cursor).toBe('old-epoch:7');
    expect(state.connectionStatus).toBe('error');
    expect(persistenceMocks.save).not.toHaveBeenCalledWith(
      expect.objectContaining({
        mirror: expect.objectContaining({
          entriesById: {
            [staleEntry.id]: expect.objectContaining({ text: 'Partial canonical row' }),
          },
        }),
      }),
    );
    for (const [record] of persistenceMocks.save.mock.calls) {
      expect(record).toEqual(
        expect.objectContaining({
          mirror: expect.objectContaining({
            entriesById: { [staleEntry.id]: staleEntry },
            summariesByMonth: { '2026-06': staleSummary },
            cursor: 'old-epoch:7',
          }),
        }),
      );
    }

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(journalApi.bootstrap).toHaveBeenCalledTimes(2));
  });

  it('switches concurrent persistence to the canonical mirror before its final save settles', async () => {
    const saved = savedWithHistory();
    useJournalStore.setState({
      ...saved.mirror,
      hydrated: true,
      loading: false,
      online: true,
      networkOnline: true,
      draft: saved.draft,
      outbox: [],
      outboxCount: 0,
      deadLetters: [],
      activityHasMore: false,
      activityNextCursor: null,
    });
    mockCanonicalBootstrap();
    vi.spyOn(journalApi, 'latestSummary').mockResolvedValue({ summary: null });
    let releaseCanonicalSave!: () => void;
    persistenceMocks.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCanonicalSave = resolve;
        }),
    );

    const hydration = reconcileAfterReset();
    await vi.waitFor(() => expect(persistenceMocks.save).toHaveBeenCalledTimes(1));
    journalActions.setDraft('Draft captured during canonical commit');
    const captured = await journalActions.createEntry({
      text: 'Capture queued during canonical commit',
      type: 'note',
      date: '2026-07-31',
    });

    const latestRecord = persistenceMocks.save.mock.calls.at(-1)?.[0];
    expect(latestRecord).toEqual(
      expect.objectContaining({
        draft: 'Draft captured during canonical commit',
        outbox: [
          expect.objectContaining({ command: expect.objectContaining({ kind: 'entry.create' }) }),
        ],
        mirror: expect.objectContaining({
          entriesById: expect.objectContaining({
            [captured.id]: expect.objectContaining({
              text: 'Capture queued during canonical commit',
            }),
          }),
        }),
      }),
    );
    expect(latestRecord?.mirror.entriesById[staleEntry.id]).toBeUndefined();

    releaseCanonicalSave();
    await hydration;
  });

  it('does not reopen the replacement stream when the app is hidden during reset hydration', async () => {
    networkOnline = true;
    persistenceMocks.load.mockResolvedValue(savedWithHistory());
    mockCanonicalBootstrap();
    vi.spyOn(journalApi, 'latestSummary').mockResolvedValue({ summary: null });
    const sources: EventTarget[] = [];
    class ControllableEventSource extends EventTarget {
      close = vi.fn();

      constructor() {
        super();
        sources.push(this);
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'));
          this.dispatchEvent(
            new MessageEvent('replay-ready', {
              lastEventId: 'old-epoch:7',
              data: JSON.stringify({ cursor: 'old-epoch:7' }),
            }),
          );
        });
      }
    }
    vi.stubGlobal('EventSource', ControllableEventSource);
    await journalActions.initialize();

    let releaseSummary!: (value: Awaited<ReturnType<typeof journalApi.latestSummary>>) => void;
    vi.spyOn(journalApi, 'latestSummary').mockReturnValueOnce(
      new Promise((resolve) => {
        releaseSummary = resolve;
      }),
    );
    sources[0]?.dispatchEvent(
      new MessageEvent('reset', {
        lastEventId: 'new-epoch:20',
        data: JSON.stringify({
          reason: 'server_restarted',
          currentCursor: 'new-epoch:20',
        }),
      }),
    );
    await vi.waitFor(() => expect(journalApi.bootstrap).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(journalApi.latestSummary).toHaveBeenCalledTimes(1));
    expect(journalApi.listEntries).toHaveBeenCalledTimes(1);

    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    releaseSummary({ summary: null });
    await vi.waitFor(() => expect(useJournalStore.getState().connectionStatus).toBe('offline'));

    expect(sources).toHaveLength(1);
  });

  it('restores the durable mirror before shutdown flushes a draft queued mid-reset', async () => {
    const saved = savedWithHistory();
    let releaseSummary!: (value: Awaited<ReturnType<typeof journalApi.latestSummary>>) => void;
    useJournalStore.setState({
      ...saved.mirror,
      hydrated: true,
      loading: false,
      online: true,
      networkOnline: true,
      draft: saved.draft,
      outbox: [],
      outboxCount: 0,
      deadLetters: [],
      activityHasMore: false,
      activityNextCursor: null,
    });
    mockCanonicalBootstrap();
    vi.spyOn(journalApi, 'latestSummary').mockReturnValue(
      new Promise((resolve) => {
        releaseSummary = resolve;
      }),
    );

    const hydration = reconcileAfterReset();
    await vi.waitFor(() => expect(journalApi.latestSummary).toHaveBeenCalledTimes(1));
    expect(journalApi.listEntries).not.toHaveBeenCalled();
    expect(useJournalStore.getState().entriesById).toEqual({});

    journalActions.setDraft('Draft typed during reset');
    journalActions.shutdown();

    expect(persistenceMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: 'Draft typed during reset',
        mirror: expect.objectContaining({
          entriesById: { [staleEntry.id]: staleEntry },
          summariesByMonth: { '2026-06': staleSummary },
          cursor: 'old-epoch:7',
        }),
      }),
    );

    releaseSummary({ summary: null });
    await expect(hydration).rejects.toThrow('superseded');
  });
});
