// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, journalApi } from '../api/client';
import type { ActivityView, ChangeBatch, Collection, Entry, Settings, Summary } from '../api/types';
import {
  applyChangeBatch,
  journalActions,
  probeAuthentication,
  reconcileAfterReset,
  reconcileFromBootstrap,
  useJournalStore,
} from './journal-store';

const settings: Settings = {
  density: 'comfortable',
  showTypeBadges: true,
  highlightAiEntries: true,
  updatedAt: '2026-07-31T08:00:00.000Z',
};

function entry(index: number, patch: Partial<Entry> = {}): Entry {
  return {
    id: `entry-${index}`,
    date: '2026-07-31',
    type: 'task',
    text: `Task ${index}`,
    state: 'open',
    time: null,
    tags: [],
    author: 'me',
    source: null,
    migrations: 0,
    collection: null,
    createdAt: new Date(Date.UTC(2026, 6, 31, 8, 0, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 6, 31, 8, 0, 0, index)).toISOString(),
    revision: 1,
    deletedAt: null,
    ...patch,
  };
}

const canonicalId = (suffix: string): string => `01K1H0000000000000000000${suffix}`;

function summary(patch: Partial<Summary> = {}): Summary {
  return {
    id: canonicalId('31'),
    weekStart: '2026-06-29',
    text: 'A downloaded historical summary.',
    status: 'current',
    source: 'Weekly assistant review',
    tokenId: canonicalId('32'),
    savedEntryId: null,
    createdAt: '2026-07-05T08:00:00.000Z',
    updatedAt: '2026-07-05T08:00:00.000Z',
    revision: 1,
    ...patch,
  };
}

function activity(row: Entry, patch: Partial<ActivityView> = {}): ActivityView {
  return {
    id: canonicalId('33'),
    at: '2026-07-05T08:00:00.000Z',
    text: 'Updated an old entry',
    kind: 'agent-update',
    origin: { actor: 'mcp', tokenId: canonicalId('32'), tool: 'update_entry' },
    refs: { entryIds: [row.id] },
    preImages: [{ entity: 'entry', id: row.id, row }],
    postImages: [{ entity: 'entry', id: row.id, row }],
    revertedAt: null,
    revertedByActivityId: null,
    revert: { eligible: true, reason: null },
    ...patch,
  };
}

function collection(patch: Partial<Collection> = {}): Collection {
  return {
    id: 'projects',
    name: 'Projects',
    note: null,
    createdAt: '2026-07-01T08:00:00.000Z',
    archivedAt: null,
    ...patch,
  };
}

function mockBootstrap(
  patch: Partial<Awaited<ReturnType<typeof journalApi.bootstrap>>> = {},
): void {
  vi.spyOn(journalApi, 'bootstrap').mockResolvedValue({
    today: '2026-07-31',
    timezone: 'Europe/Amsterdam',
    deviceId: canonicalId('34'),
    cursor: 'epoch:20',
    entries: [],
    collections: [],
    latestSummary: null,
    activity: [],
    settings,
    ...patch,
  });
  vi.spyOn(journalApi, 'getSettings').mockResolvedValue({
    settings,
    assistant: {
      endpoint: 'https://journal.test/mcp',
      status: 'ready',
      activeSessions: 0,
    },
  });
}

afterEach(() => {
  journalActions.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('journal store reconciliation', () => {
  it('undoes an offline delete exactly without sending a restore request', async () => {
    const original = entry(90, { text: 'Undo this offline delete' });
    const restore = vi.spyOn(journalApi, 'restoreEntry');
    useJournalStore.setState({
      entriesById: { [original.id]: original },
      entryIdsByDate: { [original.date]: [original.id] },
      entryIdsByCollection: {},
      collectionsById: {},
      outbox: [],
      outboxCount: 0,
      deadLetters: [],
      recentlyDeleted: [],
      networkOnline: false,
      online: false,
      connectionStatus: 'offline',
    });

    await journalActions.deleteEntry(original.id);
    expect(useJournalStore.getState().entriesById[original.id]?.deletedAt).not.toBeNull();
    expect(useJournalStore.getState().recentlyDeleted).toHaveLength(1);

    const result = await journalActions.restoreEntry(original.id);
    expect(result).toEqual({
      entry: original,
      outcome: 'cancelled_offline_delete',
      originalCollectionId: null,
    });
    expect(useJournalStore.getState().entriesById[original.id]).toEqual(original);
    expect(useJournalStore.getState().outbox).toHaveLength(0);
    expect(useJournalStore.getState().recentlyDeleted).toHaveLength(0);
    expect(restore).not.toHaveBeenCalled();
  });

  it('loads canonical recovery rows and explains a server-side daily-log fallback', async () => {
    const tombstone = entry(91, {
      collection: 'missing-project',
      revision: 2,
      deletedAt: '2026-07-31T10:00:00.000Z',
    });
    const recovered = { ...tombstone, collection: null, revision: 3, deletedAt: null };
    vi.spyOn(journalApi, 'listRecentlyDeleted').mockResolvedValue({
      items: [
        {
          entry: tombstone,
          expiresAt: '2026-08-30T10:00:00.000Z',
          destination: {
            collectionId: 'missing-project',
            collectionName: null,
            status: 'missing',
          },
        },
      ],
    });
    const restore = vi.spyOn(journalApi, 'restoreEntry').mockResolvedValue({
      entry: recovered,
      destination: {
        outcome: 'daily_fallback',
        originalCollectionId: 'missing-project',
      },
    });
    useJournalStore.setState({
      entriesById: { [tombstone.id]: tombstone },
      entryIdsByDate: {},
      entryIdsByCollection: {},
      collectionsById: {},
      outbox: [],
      outboxCount: 0,
      recentlyDeleted: [],
      networkOnline: true,
      online: true,
      connectionStatus: 'connected',
    });

    await journalActions.loadRecovery();
    expect(useJournalStore.getState().recentlyDeleted[0]?.destination.status).toBe('missing');
    const result = await journalActions.restoreEntry(tombstone.id);

    expect(restore).toHaveBeenCalledWith(tombstone.id, tombstone.revision);
    expect(result).toMatchObject({
      entry: { collection: null, deletedAt: null },
      outcome: 'daily_fallback',
      originalCollectionId: 'missing-project',
    });
    expect(useJournalStore.getState().entriesById[tombstone.id]).toEqual(recovered);
    expect(useJournalStore.getState().recentlyDeleted).toHaveLength(0);
  });

  it('follows an in-flight online delete with a canonical restore', async () => {
    const original = entry(92, { text: 'Undo while the delete request is in flight' });
    const tombstone = {
      ...original,
      updatedAt: '2026-07-31T10:01:00.000Z',
      deletedAt: '2026-07-31T10:01:00.000Z',
      revision: 2,
    };
    const recovered = {
      ...tombstone,
      updatedAt: '2026-07-31T10:02:00.000Z',
      deletedAt: null,
      revision: 3,
    };
    let resolveDelete!: (value: { entry: Entry }) => void;
    const remove = vi.spyOn(journalApi, 'deleteEntry').mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve;
      }),
    );
    const restore = vi.spyOn(journalApi, 'restoreEntry').mockResolvedValue({
      entry: recovered,
      destination: { outcome: 'original', originalCollectionId: null },
    });
    useJournalStore.setState({
      entriesById: { [original.id]: original },
      entryIdsByDate: { [original.date]: [original.id] },
      entryIdsByCollection: {},
      collectionsById: {},
      outbox: [],
      outboxCount: 0,
      deadLetters: [],
      recentlyDeleted: [],
      networkOnline: true,
      online: true,
      connectionStatus: 'connected',
    });

    await journalActions.deleteEntry(original.id);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    const undo = journalActions.restoreEntry(original.id);
    resolveDelete({ entry: tombstone });
    const result = await undo;

    expect(restore).toHaveBeenCalledWith(original.id, tombstone.revision);
    expect(result.entry).toEqual(recovered);
    expect(useJournalStore.getState().entriesById[original.id]).toEqual(recovered);
    expect(useJournalStore.getState().outbox).toHaveLength(0);
  });

  it('preserves the daily migration count when scheduling a monthly copy', async () => {
    const original = entry(1, { migrations: 3 });
    useJournalStore.setState({
      entriesById: { [original.id]: original },
      entryIdsByDate: { [original.date]: [original.id] },
      entryIdsByCollection: {},
      collectionsById: {},
      outbox: [],
      outboxCount: 0,
      networkOnline: false,
      online: false,
      today: '2026-07-31',
      serverToday: '2026-07-31',
    });

    const copy = await journalActions.scheduleEntry(original.id, '2026-08');

    expect(copy.migrations).toBe(3);
    expect(useJournalStore.getState().outbox[0]?.command.kind).toBe('entry.schedule');
  });

  it('detaches an offline migration copy from its source collection', async () => {
    const original = entry(11, { collection: 'project-atlas', migrations: 2 });
    useJournalStore.setState({
      entriesById: { [original.id]: original },
      entryIdsByDate: { [original.date]: [original.id] },
      entryIdsByCollection: { 'project-atlas': [original.id] },
      outbox: [],
      outboxCount: 0,
      networkOnline: false,
      online: false,
      today: '2026-08-01',
      serverToday: '2026-07-31',
    });

    const copy = await journalActions.migrateEntry(original.id);
    const command = useJournalStore.getState().outbox[0]?.command;

    expect(copy).toMatchObject({ date: '2026-08-01', collection: null, migrations: 3 });
    expect(useJournalStore.getState().entryIdsByCollection['project-atlas']).toEqual([original.id]);
    expect(command).toMatchObject({
      kind: 'entry.migrate',
      id: original.id,
      target: '2026-08-01',
      copy: { collection: null },
    });
  });

  it('replays an after-midnight offline tomorrow capture with its canonical absolute date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T22:06:00.000Z'));
    useJournalStore.setState({
      entriesById: {},
      entryIdsByDate: {},
      entryIdsByCollection: {},
      outbox: [],
      outboxCount: 0,
      deadLetters: [],
      networkOnline: false,
      online: false,
      today: '2026-08-01',
      serverToday: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });
    const createEntry = vi.spyOn(journalApi, 'createEntry').mockImplementation(async (input) => {
      const optimistic = Object.values(useJournalStore.getState().entriesById)[0]!;
      const date = input.dateIntent.kind === 'absolute' ? input.dateIntent.date : optimistic.date;
      return { entry: { ...optimistic, date } };
    });

    const captured = await journalActions.createEntry({
      text: 'Prepare tomorrow after midnight',
      type: 'task',
      dateShift: 'tomorrow',
    });
    expect(captured.date).toBe('2026-08-02');
    expect(createEntry).not.toHaveBeenCalled();

    useJournalStore.setState({ networkOnline: true, online: true });
    await journalActions.flush();

    expect(createEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        dateIntent: expect.objectContaining({
          kind: 'absolute',
          date: '2026-08-02',
          baseToday: '2026-07-31',
          timezone: 'Europe/Amsterdam',
        }),
      }),
      expect.any(String),
    );
    expect(useJournalStore.getState()).toMatchObject({
      outboxCount: 0,
      deadLetters: [],
    });
    expect(useJournalStore.getState().entriesById[captured.id]?.date).toBe('2026-08-02');
  });

  it('pages beyond 1,000 rows and stops on a repeated cursor', async () => {
    useJournalStore.setState({
      entriesById: {},
      entryIdsByDate: {},
      entryIdsByCollection: {},
      outbox: [],
      outboxCount: 0,
      networkOnline: true,
      online: true,
      today: '2026-07-31',
      serverToday: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });
    let page = 0;
    const listEntries = vi.spyOn(journalApi, 'listEntries').mockImplementation(async () => {
      const pageIndex = page++;
      return {
        items: Array.from({ length: 100 }, (_, offset) => entry(pageIndex * 100 + offset)),
        nextCursor: pageIndex < 10 ? `cursor-${pageIndex + 1}` : 'cursor-10',
        today: '2026-07-31',
        timezone: 'Europe/Amsterdam',
      };
    });

    const loaded = await journalActions.loadEntries({});

    expect(loaded).toHaveLength(1_100);
    expect(listEntries).toHaveBeenCalledTimes(11);
  });

  it('refreshes MCP connectivity together with token metadata', async () => {
    useJournalStore.setState({ online: true, networkOnline: true, agentTokens: [], settings });
    vi.spyOn(journalApi, 'listTokens').mockResolvedValue({ tokens: [] });
    vi.spyOn(journalApi, 'getSettings').mockResolvedValue({
      settings: { ...settings, density: 'compact' },
      assistant: {
        endpoint: 'https://journal.test/mcp',
        status: 'connected',
        activeSessions: 2,
      },
    });

    await journalActions.refreshTokens();

    expect(useJournalStore.getState().settings.density).toBe('compact');
    expect(useJournalStore.getState().mcpStatus).toMatchObject({
      status: 'connected',
      activeSessions: 2,
    });
  });

  it('does not let an equal-timestamp settings response overwrite an intervening SSE change', async () => {
    const liveSettings: Settings = {
      ...settings,
      density: 'compact',
      showTypeBadges: false,
    };
    const originalAssistant = {
      endpoint: 'https://journal.test/mcp',
      status: 'connected' as const,
      activeSessions: 2,
    };
    let resolveUpdate!: (value: Awaited<ReturnType<typeof journalApi.updateSettings>>) => void;
    vi.spyOn(journalApi, 'updateSettings').mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    useJournalStore.setState({
      online: true,
      networkOnline: true,
      settings,
      mcpStatus: originalAssistant,
    });

    const update = journalActions.updateSettings({ highlightAiEntries: false });
    await vi.waitFor(() => expect(journalApi.updateSettings).toHaveBeenCalledTimes(1));
    await applyChangeBatch(
      {
        transactionId: canonicalId('35'),
        mutationId: null,
        origin: { kind: 'system' },
        changes: [{ kind: 'settings.changed', payload: liveSettings }],
      } as unknown as ChangeBatch,
      'epoch:settings-live',
    );
    resolveUpdate({
      settings: { ...settings, highlightAiEntries: false },
      assistant: {
        endpoint: 'https://journal.test/mcp',
        status: 'ready',
        activeSessions: 0,
      },
    });
    await update;

    expect(useJournalStore.getState().settings).toEqual(liveSettings);
    expect(useJournalStore.getState().mcpStatus).toEqual(originalAssistant);
  });

  it('does not let token-page settings metadata overwrite an intervening SSE change', async () => {
    const liveSettings: Settings = {
      ...settings,
      density: 'compact',
      highlightAiEntries: false,
    };
    const originalAssistant = {
      endpoint: 'https://journal.test/mcp',
      status: 'connected' as const,
      activeSessions: 3,
    };
    let resolveSettings!: (value: Awaited<ReturnType<typeof journalApi.getSettings>>) => void;
    vi.spyOn(journalApi, 'listTokens').mockResolvedValue({ tokens: [] });
    vi.spyOn(journalApi, 'getSettings').mockReturnValue(
      new Promise((resolve) => {
        resolveSettings = resolve;
      }),
    );
    useJournalStore.setState({
      online: true,
      networkOnline: true,
      settings,
      mcpStatus: originalAssistant,
      agentTokens: [],
    });

    const refresh = journalActions.refreshTokens();
    await vi.waitFor(() => expect(journalApi.getSettings).toHaveBeenCalledTimes(1));
    await applyChangeBatch(
      {
        transactionId: canonicalId('36'),
        mutationId: null,
        origin: { kind: 'system' },
        changes: [{ kind: 'settings.changed', payload: liveSettings }],
      } as unknown as ChangeBatch,
      'epoch:settings-newer',
    );
    resolveSettings({
      settings: { ...settings, showTypeBadges: false },
      assistant: {
        endpoint: 'https://journal.test/mcp',
        status: 'ready',
        activeSessions: 0,
      },
    });
    await refresh;

    expect(useJournalStore.getState().settings).toEqual(liveSettings);
    expect(useJournalStore.getState().mcpStatus).toEqual(originalAssistant);
  });

  it('ignores a delayed mutation response after its SSE acknowledgement and a newer commit', async () => {
    const original = entry(1, {
      id: canonicalId('01'),
      text: 'Original',
    });
    let resolveResponse!: (value: { entry: Entry }) => void;
    const delayedResponse = new Promise<{ entry: Entry }>((resolve) => {
      resolveResponse = resolve;
    });
    vi.spyOn(journalApi, 'updateEntry').mockReturnValue(delayedResponse);
    useJournalStore.setState({
      entriesById: { [original.id]: original },
      entryIdsByDate: { [original.date]: [original.id] },
      entryIdsByCollection: {},
      outbox: [],
      outboxCount: 0,
      networkOnline: true,
      online: true,
      cursor: 'epoch:1',
      deviceId: canonicalId('02'),
    });

    await journalActions.updateEntry(original.id, { text: 'Owner edit' });
    const mutationId = useJournalStore.getState().outbox[0]?.mutationId;
    expect(mutationId).toBeTruthy();
    const acknowledged = {
      ...original,
      text: 'Owner edit',
      revision: 2,
      updatedAt: '2026-07-31T08:01:00.000Z',
    };
    await applyChangeBatch(
      {
        transactionId: canonicalId('03'),
        mutationId: mutationId!,
        origin: { kind: 'app', deviceId: canonicalId('02') },
        changes: [{ kind: 'entry.updated', payload: acknowledged }],
      } as ChangeBatch,
      'epoch:2',
    );
    const newer = {
      ...acknowledged,
      text: 'Newer assistant edit',
      revision: 3,
      updatedAt: '2026-07-31T08:02:00.000Z',
    };
    await applyChangeBatch(
      {
        transactionId: canonicalId('04'),
        mutationId: null,
        origin: { kind: 'system' },
        changes: [{ kind: 'entry.updated', payload: newer }],
      } as ChangeBatch,
      'epoch:3',
    );

    resolveResponse({ entry: acknowledged });
    await journalActions.flush();

    expect(useJournalStore.getState().entriesById[original.id]).toMatchObject({
      text: 'Newer assistant edit',
      revision: 3,
    });
  });

  it('does not let a pre-reset month response erase the authoritative summary', async () => {
    const canonical = summary({
      id: canonicalId('18'),
      weekStart: '2026-07-27',
      text: 'Canonical summary after reset',
    });
    mockBootstrap({ latestSummary: canonical });
    vi.spyOn(journalApi, 'listEntries').mockResolvedValue({
      items: [],
      nextCursor: null,
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });
    let resolveSummary!: (value: { summary: Summary | null }) => void;
    vi.spyOn(journalApi, 'latestSummary')
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSummary = resolve;
        }),
      )
      .mockResolvedValueOnce({ summary: canonical });
    useJournalStore.setState({
      online: true,
      networkOnline: true,
      today: '2026-07-31',
      serverToday: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });

    const loading = journalActions.loadMonth('2026-07');
    await vi.waitFor(() => expect(journalApi.latestSummary).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await reconcileFromBootstrap({ authoritative: true });
    resolveSummary({ summary: null });
    await loading;

    expect(journalApi.latestSummary).toHaveBeenCalledTimes(2);
    expect(useJournalStore.getState().summariesByMonth['2026-07']).toEqual(canonical);
    expect(useJournalStore.getState().latestSummary).toEqual(canonical);
  });

  it('clears a missing month summary and falls back to the latest loaded prior month', async () => {
    const priorMonth = summary({
      id: canonicalId('38'),
      weekStart: '2026-06-29',
      text: 'The latest retained summary.',
    });
    const missingMonth = summary({
      id: canonicalId('39'),
      weekStart: '2026-07-27',
      text: 'A stale July summary.',
    });
    vi.spyOn(journalApi, 'listEntries').mockResolvedValue({
      items: [],
      nextCursor: null,
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });
    vi.spyOn(journalApi, 'latestSummary').mockResolvedValue({ summary: null });
    useJournalStore.setState({
      summariesByMonth: { '2026-06': priorMonth, '2026-07': missingMonth },
      latestSummary: missingMonth,
      online: true,
      networkOnline: true,
      today: '2026-07-31',
      serverToday: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });

    await journalActions.loadMonth('2026-07');

    expect(journalApi.latestSummary).toHaveBeenCalledWith('2026-07');
    expect(useJournalStore.getState().summariesByMonth).toMatchObject({
      '2026-06': priorMonth,
      '2026-07': null,
    });
    expect(useJournalStore.getState().latestSummary).toEqual(priorMonth);
  });

  it('reconciles instead of applying an outbox response delayed across reset', async () => {
    const original = collection();
    const optimistic = { ...original, name: 'Owner rename' };
    const canonical = { ...original, name: 'Newer assistant rename' };
    mockBootstrap({ collections: [canonical] });
    let resolveResponse!: (value: { collection: Collection }) => void;
    vi.spyOn(journalApi, 'updateCollection').mockReturnValue(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
    );
    useJournalStore.setState({
      collectionsById: { [original.id]: original },
      outbox: [],
      outboxCount: 0,
      online: true,
      networkOnline: true,
    });

    await journalActions.updateCollection(original.id, { name: optimistic.name });
    await vi.waitFor(() => expect(journalApi.updateCollection).toHaveBeenCalledTimes(1));
    await reconcileFromBootstrap({ authoritative: true });
    resolveResponse({ collection: optimistic });
    await journalActions.flush();

    expect(journalApi.bootstrap).toHaveBeenCalledTimes(2);
    expect(useJournalStore.getState().collectionsById[original.id]).toEqual(canonical);
    expect(useJournalStore.getState().outbox).toHaveLength(0);
  });

  it('ignores a mutation response that finishes after shutdown', async () => {
    const original = entry(8, { id: canonicalId('09'), text: 'Original' });
    let resolveResponse!: (value: { entry: Entry }) => void;
    const delayedResponse = new Promise<{ entry: Entry }>((resolve) => {
      resolveResponse = resolve;
    });
    vi.spyOn(journalApi, 'updateEntry').mockReturnValue(delayedResponse);
    useJournalStore.setState({
      entriesById: { [original.id]: original },
      entryIdsByDate: { [original.date]: [original.id] },
      entryIdsByCollection: {},
      outbox: [],
      outboxCount: 0,
      networkOnline: true,
      online: true,
    });

    await journalActions.updateEntry(original.id, { text: 'Pending edit' });
    journalActions.shutdown();
    resolveResponse({
      entry: {
        ...original,
        text: 'Late response',
        revision: 2,
        updatedAt: '2026-07-31T08:05:00.000Z',
      },
    });
    await delayedResponse;
    await Promise.resolve();
    await Promise.resolve();

    expect(useJournalStore.getState().entriesById[original.id]?.text).toBe('Pending edit');
    expect(useJournalStore.getState().outbox).toHaveLength(1);
  });

  it('clears outbox retry and assistant burst timers on shutdown', async () => {
    vi.useFakeTimers();
    const original = entry(9, { id: canonicalId('10') });
    const updateEntry = vi
      .spyOn(journalApi, 'updateEntry')
      .mockRejectedValue(new ApiError(503, 'unavailable', 'Try again.'));
    useJournalStore.setState({
      entriesById: { [original.id]: original },
      entryIdsByDate: { [original.date]: [original.id] },
      entryIdsByCollection: {},
      outbox: [],
      outboxCount: 0,
      notices: [],
      networkOnline: true,
      online: true,
      deviceId: canonicalId('11'),
    });

    await journalActions.updateEntry(original.id, { text: 'Retry later' });
    await Promise.resolve();
    expect(updateEntry).toHaveBeenCalledTimes(1);
    await applyChangeBatch(
      {
        transactionId: canonicalId('12'),
        mutationId: null,
        origin: { kind: 'mcp', tokenLabel: 'Assistant' },
        changes: [
          {
            kind: 'entry.updated',
            payload: {
              ...original,
              text: 'Assistant edit',
              revision: 2,
              updatedAt: '2026-07-31T08:06:00.000Z',
            },
          },
        ],
      } as ChangeBatch,
      'epoch:5',
    );

    journalActions.shutdown();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(updateEntry).toHaveBeenCalledTimes(1);
    expect(useJournalStore.getState().notices.some((notice) => notice.kind === 'assistant')).toBe(
      false,
    );
  });

  it('rebuilds old entries canonically after an SSE reset without retaining deleted rows', async () => {
    mockBootstrap();
    const changed = entry(2, {
      id: canonicalId('05'),
      date: '2026-01-10',
      state: 'done',
      text: 'Stale downloaded text',
    });
    const deleted = entry(3, {
      id: canonicalId('24'),
      date: '2026-01-11',
      state: 'done',
      text: 'Deleted on the server',
    });
    const canonical = {
      ...changed,
      text: 'Canonical changed text',
      revision: 2,
      updatedAt: '2026-07-31T08:20:00.000Z',
    };
    vi.spyOn(journalApi, 'listEntries').mockResolvedValue({
      items: [canonical],
      nextCursor: null,
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });
    useJournalStore.setState({
      entriesById: { [changed.id]: changed, [deleted.id]: deleted },
      entryIdsByDate: { [changed.date]: [changed.id], [deleted.date]: [deleted.id] },
      activityById: {},
      activityOrder: [],
      summariesByMonth: {},
      latestSummary: null,
      outbox: [],
      outboxCount: 0,
      online: true,
      networkOnline: true,
    });

    await reconcileAfterReset();

    expect(useJournalStore.getState().entriesById).toEqual({ [canonical.id]: canonical });
    expect(useJournalStore.getState().entriesById[deleted.id]).toBeUndefined();
  });

  it('canonically refetches retained activity depth and summary months after an SSE reset', async () => {
    const historical = entry(12, {
      id: canonicalId('25'),
      date: '2026-02-01',
      state: 'done',
    });
    const retainedActivity = activity(historical, {
      id: canonicalId('26'),
      at: '2026-02-01T08:00:00.000Z',
      text: 'Stale retained activity',
    });
    const missingActivity = activity(historical, {
      id: canonicalId('27'),
      at: '2026-01-31T08:00:00.000Z',
      text: 'Deleted retained activity',
    });
    const bootstrapActivity = Array.from({ length: 50 }, (_, index) =>
      activity(historical, {
        id: `bootstrap-activity-${String(index).padStart(2, '0')}`,
        at: new Date(Date.UTC(2026, 6, 31, 7, 59, index)).toISOString(),
        text: `Recent activity ${index}`,
      }),
    );
    const canonicalActivity = {
      ...retainedActivity,
      text: 'Canonical retained activity',
    };
    const retainedSummary = summary({
      id: canonicalId('28'),
      weekStart: '2026-05-25',
      text: 'Stale May summary',
    });
    const missingSummary = summary({
      id: canonicalId('29'),
      weekStart: '2026-06-29',
      text: 'Deleted June summary',
    });
    const canonicalSummary = {
      ...retainedSummary,
      text: 'Canonical May summary',
      revision: 2,
      updatedAt: '2026-07-31T08:30:00.000Z',
    };
    mockBootstrap({ activity: bootstrapActivity });
    vi.spyOn(journalApi, 'listEntries').mockResolvedValue({
      items: [historical],
      nextCursor: null,
      today: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });
    const listActivity = vi.spyOn(journalApi, 'listActivity').mockResolvedValue({
      items: [canonicalActivity],
      nextCursor: null,
    });
    vi.spyOn(journalApi, 'latestSummary').mockImplementation(async (month) => ({
      summary: month === '2026-05' ? canonicalSummary : null,
    }));
    useJournalStore.setState({
      entriesById: { [historical.id]: historical },
      entryIdsByDate: { [historical.date]: [historical.id] },
      activityById: {
        [retainedActivity.id]: retainedActivity,
        [missingActivity.id]: missingActivity,
      },
      activityOrder: [retainedActivity.id, missingActivity.id],
      summariesByMonth: { '2026-05': retainedSummary, '2026-06': missingSummary },
      latestSummary: missingSummary,
      outbox: [],
      outboxCount: 0,
      online: true,
      networkOnline: true,
    });

    await reconcileAfterReset();

    const state = useJournalStore.getState();
    expect(listActivity).toHaveBeenCalledTimes(1);
    expect(state.activityById[retainedActivity.id]).toMatchObject({
      text: 'Canonical retained activity',
    });
    expect(state.activityById[missingActivity.id]).toBeUndefined();
    expect(state.summariesByMonth['2026-05']).toEqual(canonicalSummary);
    expect(state.summariesByMonth['2026-06']).toBeNull();
    expect(state.latestSummary).toEqual(canonicalSummary);
  });

  it('uses the greatest loaded summary after a tombstone, then refreshes the canonical latest', async () => {
    const older = summary({ id: canonicalId('13'), weekStart: '2026-07-27' });
    const removed = summary({
      id: canonicalId('14'),
      weekStart: '2026-08-03',
      updatedAt: '2026-08-02T08:00:00.000Z',
    });
    const canonical = summary({
      id: canonicalId('15'),
      weekStart: '2026-08-10',
      updatedAt: '2026-08-09T08:00:00.000Z',
    });
    let releaseLatest!: (value: { summary: Summary | null }) => void;
    const latestResponse = new Promise<{ summary: Summary | null }>((resolve) => {
      releaseLatest = resolve;
    });
    vi.spyOn(journalApi, 'latestSummary').mockReturnValue(latestResponse);
    useJournalStore.setState({
      summariesByMonth: { '2026-07': older, '2026-08': removed },
      latestSummary: removed,
      outbox: [],
      outboxCount: 0,
      networkOnline: true,
      online: true,
    });

    await applyChangeBatch(
      {
        transactionId: canonicalId('16'),
        mutationId: null,
        origin: { kind: 'system' },
        changes: [{ kind: 'summary.changed', payload: { id: removed.id } }],
      } as ChangeBatch,
      'epoch:6',
    );

    expect(useJournalStore.getState().latestSummary).toEqual(older);
    releaseLatest({ summary: canonical });
    await latestResponse;
    await Promise.resolve();
    expect(useJournalStore.getState().latestSummary).toEqual(canonical);
  });

  it('evicts only the failed historical projection and reapplies remaining offline work', async () => {
    mockBootstrap();
    const failed = entry(3, {
      id: canonicalId('06'),
      date: '2026-01-10',
      state: 'done',
      text: 'Canonical old text',
    });
    const pending = entry(4, {
      id: canonicalId('19'),
      date: '2026-01-11',
      state: 'done',
      text: 'Pending canonical text',
    });
    const untouched = entry(5, {
      id: canonicalId('20'),
      date: '2026-01-12',
      state: 'done',
      text: 'Untouched downloaded history',
    });
    const downloadedSummary = summary();
    const downloadedActivity = activity(untouched);
    useJournalStore.setState({
      entriesById: {
        [failed.id]: failed,
        [pending.id]: pending,
        [untouched.id]: untouched,
      },
      entryIdsByDate: {
        [failed.date]: [failed.id],
        [pending.date]: [pending.id],
        [untouched.date]: [untouched.id],
      },
      activityById: { [downloadedActivity.id]: downloadedActivity },
      activityOrder: [downloadedActivity.id],
      summariesByMonth: { '2026-06': downloadedSummary },
      latestSummary: downloadedSummary,
      outbox: [],
      outboxCount: 0,
      deadLetters: [],
      online: true,
      networkOnline: true,
    });
    let rejectConflict!: (reason: unknown) => void;
    vi.spyOn(journalApi, 'updateEntry').mockImplementation((id) => {
      if (id === failed.id) {
        return new Promise((_resolve, reject) => {
          rejectConflict = reject;
        });
      }
      return Promise.reject(new ApiError(503, 'unavailable', 'Retry the remaining edit.'));
    });

    await journalActions.updateEntry(failed.id, { text: 'Rejected optimistic text' });
    await journalActions.updateEntry(pending.id, { text: 'Still pending offline' });
    rejectConflict(new ApiError(409, 'revision_conflict', 'The entry changed first.'));
    await journalActions.flush();

    const state = useJournalStore.getState();
    expect(state.entriesById[failed.id]).toBeUndefined();
    expect(state.entriesById[untouched.id]).toEqual(untouched);
    expect(state.entriesById[pending.id]).toMatchObject({ text: 'Still pending offline' });
    expect(state.activityById[downloadedActivity.id]).toBeDefined();
    expect(state.summariesByMonth['2026-06']).toEqual(downloadedSummary);
    expect(state.latestSummary).toEqual(downloadedSummary);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]?.command).toMatchObject({ kind: 'entry.update', id: pending.id });
    expect(state.deadLetters).toHaveLength(1);
    expect(state.deadLetters[0]?.code).toBe('revision_conflict');
  });

  it('retries an absent conflicted row without repeating its stale revision precondition', async () => {
    const original = entry(14, {
      id: canonicalId('40'),
      date: '2026-01-13',
      text: 'The row removed by canonical reconciliation.',
    });
    const retried = {
      ...original,
      text: 'Retried without a stale precondition.',
      revision: 2,
      updatedAt: '2026-07-31T09:00:00.000Z',
    };
    mockBootstrap();
    const updateEntry = vi
      .spyOn(journalApi, 'updateEntry')
      .mockRejectedValueOnce(new ApiError(409, 'revision_conflict', 'The entry changed first.'))
      .mockResolvedValueOnce({ entry: retried });
    useJournalStore.setState({
      entriesById: { [original.id]: original },
      entryIdsByDate: { [original.date]: [original.id] },
      entryIdsByCollection: {},
      outbox: [],
      outboxCount: 0,
      deadLetters: [],
      online: true,
      networkOnline: true,
    });

    await journalActions.updateEntry(original.id, { text: retried.text });
    await journalActions.flush();

    const deadLetter = useJournalStore.getState().deadLetters[0];
    expect(deadLetter).toBeDefined();
    expect(useJournalStore.getState().entriesById[original.id]).toBeUndefined();

    await journalActions.retryDeadLetter(deadLetter!.id);
    await journalActions.flush();

    expect(updateEntry).toHaveBeenCalledTimes(2);
    expect(updateEntry).toHaveBeenLastCalledWith(
      original.id,
      { text: retried.text },
      expect.any(String),
      undefined,
    );
    expect(useJournalStore.getState()).toMatchObject({
      deadLetters: [],
      outbox: [],
      outboxCount: 0,
    });
    expect(useJournalStore.getState().entriesById[original.id]).toEqual(retried);
  });

  it('replaces a failed working-set projection with its bootstrap canonical row', async () => {
    const original = entry(8, { id: canonicalId('23'), text: 'Observed text' });
    const canonical = {
      ...original,
      text: 'Canonical server text',
      revision: 2,
      updatedAt: '2026-07-31T08:15:00.000Z',
    };
    mockBootstrap({ entries: [canonical] });
    vi.spyOn(journalApi, 'updateEntry').mockRejectedValue(
      new ApiError(409, 'revision_conflict', 'The entry changed first.'),
    );
    useJournalStore.setState({
      entriesById: { [original.id]: original },
      entryIdsByDate: { [original.date]: [original.id] },
      entryIdsByCollection: {},
      outbox: [],
      outboxCount: 0,
      deadLetters: [],
      online: true,
      networkOnline: true,
    });

    await journalActions.updateEntry(original.id, { text: 'Rejected owner text' });
    await journalActions.flush();

    expect(useJournalStore.getState().entriesById[original.id]).toEqual(canonical);
    expect(useJournalStore.getState().deadLetters).toHaveLength(1);
  });

  it('pauses an existing-cursor reconnect on 401 instead of retrying or silently pairing', async () => {
    class OpeningEventSource extends EventTarget {
      close = vi.fn();

      constructor() {
        super();
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'));
          this.dispatchEvent(
            new MessageEvent('replay-ready', {
              lastEventId: 'epoch:4',
              data: JSON.stringify({ cursor: 'epoch:4' }),
            }),
          );
        });
      }
    }
    vi.stubGlobal('EventSource', OpeningEventSource);
    useJournalStore.setState({
      cursor: 'epoch:4',
      entriesById: {},
      entryIdsByDate: {},
      entryIdsByCollection: {},
      outbox: [],
      outboxCount: 0,
      notices: [],
      networkOnline: true,
      online: true,
      today: '2026-07-31',
      serverToday: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });
    const listEntries = vi
      .spyOn(journalApi, 'listEntries')
      .mockRejectedValue(new ApiError(401, 'unauthenticated', 'Pairing expired.'));
    const pair = vi.spyOn(journalApi, 'pair');

    await journalActions.reconnect();
    await journalActions.reconnect();

    expect(listEntries).toHaveBeenCalledTimes(1);
    expect(pair).not.toHaveBeenCalled();
    expect(useJournalStore.getState()).toMatchObject({
      online: false,
      connectionStatus: 'error',
    });
    expect(useJournalStore.getState().notices.at(-1)?.message).toContain(
      'Reload Journal to reconnect',
    );
  });

  it('keeps the 401 pause sticky when an earlier outbox request succeeds late', async () => {
    const original = entry(6, { id: canonicalId('21'), text: 'Original' });
    let resolveUpdate!: (value: { entry: Entry }) => void;
    const updateEntry = vi.spyOn(journalApi, 'updateEntry').mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    vi.spyOn(journalApi, 'updateSettings').mockRejectedValue(
      new ApiError(401, 'unauthenticated', 'Pairing expired.'),
    );
    useJournalStore.setState({
      entriesById: { [original.id]: original },
      entryIdsByDate: { [original.date]: [original.id] },
      entryIdsByCollection: {},
      outbox: [],
      outboxCount: 0,
      notices: [],
      online: true,
      networkOnline: true,
    });

    await journalActions.updateEntry(original.id, { text: 'Queued owner edit' });
    await vi.waitFor(() => expect(updateEntry).toHaveBeenCalledTimes(1));
    await expect(journalActions.updateSettings({ density: 'compact' })).rejects.toMatchObject({
      status: 401,
    });
    resolveUpdate({
      entry: {
        ...original,
        text: 'Queued owner edit',
        revision: 2,
        updatedAt: '2026-07-31T08:10:00.000Z',
      },
    });
    await journalActions.flush();

    expect(useJournalStore.getState()).toMatchObject({
      online: false,
      connectionStatus: 'error',
      outboxCount: 1,
    });
    expect(
      useJournalStore
        .getState()
        .notices.filter((notice) => notice.message.includes('Reload Journal to reconnect')),
    ).toHaveLength(1);
  });

  it('re-establishes replay readiness before retrying after a status-zero outbox failure', async () => {
    vi.useFakeTimers();
    mockBootstrap();
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
              lastEventId: 'epoch:20',
              data: JSON.stringify({ cursor: 'epoch:20' }),
            }),
          );
        });
      }
    }
    vi.stubGlobal('EventSource', ReadyEventSource);
    let attempts = 0;
    const createEntry = vi.spyOn(journalApi, 'createEntry').mockImplementation(async (input) => {
      attempts += 1;
      if (attempts === 1) throw new ApiError(0, 'network_error', 'Journal is unreachable.');
      const current = useJournalStore.getState().entriesById[input.id];
      if (!current) throw new Error('Optimistic entry was not retained for retry.');
      return {
        entry: {
          ...current,
          revision: 2,
          updatedAt: '2026-07-31T08:10:00.000Z',
        },
      };
    });
    useJournalStore.setState({
      entriesById: {},
      entryIdsByDate: {},
      entryIdsByCollection: {},
      outbox: [],
      outboxCount: 0,
      notices: [],
      cursor: null,
      networkOnline: true,
      online: true,
      connectionStatus: 'connected',
      today: '2026-07-31',
      serverToday: '2026-07-31',
      timezone: 'Europe/Amsterdam',
    });

    await journalActions.createEntry({
      id: canonicalId('24'),
      text: 'Retry after network recovery',
      type: 'note',
      date: '2026-07-31',
    });
    await vi.waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    expect(useJournalStore.getState().connectionStatus).toBe('error');

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    await vi.waitFor(() => expect(createEntry).toHaveBeenCalledTimes(2));
    expect(useJournalStore.getState()).toMatchObject({
      connectionStatus: 'connected',
      online: true,
      outboxCount: 0,
    });
  });

  it('pauses pairing and retains the command when permanent-conflict reconciliation gets a 401', async () => {
    const original = entry(7, { id: canonicalId('22') });
    vi.spyOn(journalApi, 'updateEntry').mockRejectedValue(
      new ApiError(409, 'revision_conflict', 'The entry changed first.'),
    );
    vi.spyOn(journalApi, 'bootstrap').mockRejectedValue(
      new ApiError(401, 'unauthenticated', 'Pairing expired.'),
    );
    useJournalStore.setState({
      entriesById: { [original.id]: original },
      entryIdsByDate: { [original.date]: [original.id] },
      entryIdsByCollection: {},
      outbox: [],
      outboxCount: 0,
      deadLetters: [],
      notices: [],
      online: true,
      networkOnline: true,
    });

    await journalActions.updateEntry(original.id, { text: 'Rejected edit' });
    await journalActions.flush();

    expect(useJournalStore.getState()).toMatchObject({
      online: false,
      connectionStatus: 'error',
      outboxCount: 1,
    });
    expect(useJournalStore.getState().deadLetters).toHaveLength(0);
    expect(
      useJournalStore
        .getState()
        .notices.filter((notice) => notice.message.includes('Reload Journal to reconnect')),
    ).toHaveLength(1);
  });

  it('retains the optimistic command when permanent-conflict reconciliation is unavailable', async () => {
    const original = entry(13, { id: canonicalId('37'), text: 'Canonical text' });
    vi.spyOn(journalApi, 'updateEntry').mockRejectedValue(
      new ApiError(409, 'revision_conflict', 'The entry changed first.'),
    );
    vi.spyOn(journalApi, 'bootstrap').mockRejectedValue(
      new ApiError(503, 'unavailable', 'Canonical reconciliation is unavailable.'),
    );
    useJournalStore.setState({
      entriesById: { [original.id]: original },
      entryIdsByDate: { [original.date]: [original.id] },
      entryIdsByCollection: {},
      outbox: [],
      outboxCount: 0,
      deadLetters: [],
      notices: [],
      online: true,
      networkOnline: true,
    });

    await journalActions.updateEntry(original.id, { text: 'Retain this optimistic edit' });
    await journalActions.flush();

    expect(useJournalStore.getState()).toMatchObject({
      outboxCount: 1,
      deadLetters: [],
    });
    expect(useJournalStore.getState().entriesById[original.id]?.text).toBe(
      'Retain this optimistic edit',
    );
  });

  it('routes online-only and SSE-probe 401s into one pairing-paused notice', async () => {
    const unauthorized = new ApiError(401, 'unauthenticated', 'Pairing expired.');
    vi.spyOn(journalApi, 'updateSettings').mockRejectedValue(unauthorized);
    vi.spyOn(journalApi, 'saveLatestSummary').mockRejectedValue(unauthorized);
    vi.spyOn(journalApi, 'rewriteLatestSummary').mockRejectedValue(unauthorized);
    vi.spyOn(journalApi, 'revertActivity').mockRejectedValue(unauthorized);
    vi.spyOn(journalApi, 'listTokens').mockRejectedValue(unauthorized);
    vi.spyOn(journalApi, 'getSettings').mockRejectedValue(unauthorized);
    vi.spyOn(journalApi, 'createToken').mockRejectedValue(unauthorized);
    vi.spyOn(journalApi, 'revokeToken').mockRejectedValue(unauthorized);
    vi.spyOn(journalApi, 'listEntries').mockRejectedValue(unauthorized);
    vi.spyOn(journalApi, 'latestSummary').mockRejectedValue(unauthorized);
    vi.spyOn(journalApi, 'listActivity').mockRejectedValue(unauthorized);
    const activityRow = activity(entry(10, { id: canonicalId('17') }));
    useJournalStore.setState({
      notices: [],
      online: true,
      networkOnline: true,
      activityById: { [activityRow.id]: activityRow },
      activityOrder: [activityRow.id],
      activityHasMore: true,
      activityNextCursor: activityRow.at,
    });

    const operations = [
      () => journalActions.updateSettings({ density: 'compact' }),
      () => journalActions.saveSummary(),
      () => journalActions.rewriteSummary(),
      () => journalActions.revertActivity(canonicalId('07')),
      () => journalActions.refreshTokens(),
      () => journalActions.createToken('Assistant'),
      () => journalActions.revokeToken(canonicalId('08')),
      () => journalActions.loadEntries({}),
      () => journalActions.loadMonth('2026-07'),
      () => journalActions.loadMoreActivity(),
      () => journalActions.searchEntries('needle'),
    ];
    for (const operation of operations) {
      journalActions.shutdown();
      useJournalStore.setState({ online: true });
      await expect(operation()).rejects.toMatchObject({ status: 401 });
    }
    await probeAuthentication();

    expect(
      useJournalStore
        .getState()
        .notices.filter((notice) => notice.message.includes('Reload Journal to reconnect')),
    ).toHaveLength(1);
    expect(useJournalStore.getState()).toMatchObject({
      online: false,
      connectionStatus: 'error',
    });
  });
});

describe('journal search paging', () => {
  it('pages every matching downloaded row in groups of 50 without a silent cap', async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => {
        const row = entry(index, { text: `Needle ${index}`, type: 'note', state: 'logged' });
        return [row.id, row];
      }),
    );
    useJournalStore.setState({
      entriesById: entries,
      online: false,
      networkOnline: false,
    });

    const first = await journalActions.searchEntries('needle');
    const second = await journalActions.searchEntries('needle', first.nextCursor ?? undefined);
    const third = await journalActions.searchEntries('needle', second.nextCursor ?? undefined);

    expect(first).toMatchObject({ source: 'downloaded', reason: 'offline', hasMore: true });
    expect(first.items).toHaveLength(50);
    expect(second.items).toHaveLength(50);
    expect(third.items).toHaveLength(20);
    expect(third.nextCursor).toBeNull();
    expect(third.hasMore).toBe(false);
    expect(
      new Set([...first.items, ...second.items, ...third.items].map((row) => row.id)).size,
    ).toBe(120);
  });

  it('falls back truthfully on a retryable failure and retries the same raw grammar online', async () => {
    const downloaded = entry(1, {
      text: 'CAFÉ launch plan',
      type: 'note',
      state: 'logged',
      tags: ['work'],
    });
    useJournalStore.setState({
      entriesById: { [downloaded.id]: downloaded },
      online: true,
      networkOnline: true,
    });
    const listEntries = vi
      .spyOn(journalApi, 'listEntries')
      .mockRejectedValueOnce(new ApiError(503, 'unavailable', 'Journal is unavailable.'))
      .mockResolvedValueOnce({
        items: [downloaded],
        nextCursor: 'server-page-two',
        today: '2026-07-31',
        timezone: 'Europe/Amsterdam',
      });

    const fallback = await journalActions.searchEntries('type:note #work cafe');
    const retry = await journalActions.searchEntries('type:note #work cafe');

    expect(fallback).toMatchObject({
      items: [downloaded],
      source: 'downloaded',
      reason: 'unavailable',
      nextCursor: null,
      hasMore: false,
    });
    expect(retry).toMatchObject({
      items: [downloaded],
      source: 'journal',
      reason: null,
      nextCursor: 'server-page-two',
      hasMore: true,
    });
    expect(listEntries).toHaveBeenNthCalledWith(1, {
      q: 'type:note #work cafe',
      limit: 50,
    });
    expect(listEntries).toHaveBeenNthCalledWith(2, {
      q: 'type:note #work cafe',
      limit: 50,
    });
  });
});
