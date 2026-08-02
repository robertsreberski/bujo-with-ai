import { initialEntryState } from '@journal/server/contracts/app';
import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';

import { ApiError, journalApi } from '../api/client';
import type {
  ActivityView,
  AgentToken,
  ChangeBatch,
  Collection,
  Entry,
  EntryPatch,
  EntryType,
  IndexResponse,
  DateIntent,
  Settings,
  Summary,
  Reflection,
} from '../api/types';
import {
  calendarDateInTimeZone,
  createMidnightScheduler,
  type MidnightScheduler,
} from '../hooks/midnight';
import {
  activateJournalUpdate,
  checkForJournalUpdate,
  registerJournalServiceWorker,
  subscribePwaRegistration,
} from '../pwa/registration';
import type {
  CreateEntryInput,
  DeadLetter,
  Destination,
  JournalNotice,
  JournalSearchPage,
  LogViewConfig,
  OutboxItem,
  QueueableCommand,
} from '../domain/contracts';
import { hydrateLogView } from '../domain/log-arrangement';
import {
  createActivityEnrichmentActions,
  deriveTagUsage,
  mergeTagUsage,
  selectActivity,
  selectHasUnseenActivity,
  selectLatestAgentTouches,
  selectUnseenActivityCount,
  selectUnseenActivityIds,
  selectUnseenReviewCount,
} from './activity-enrichment';
import {
  affectedCollectionIds,
  affectedEntryIds,
  applyServerRows,
  descriptorForCommand,
  rebaseCommand,
  selectJournalStatus,
  sendOutboxItem,
  type ServerRows,
} from './connection-outbox';
import { createUlid } from './ids';
import type { JournalClientRecord, MirrorData } from './models';
import {
  applyAgentTokenChanges,
  applyOptimisticCommand,
  applyPendingCommands,
  applyServerChangeBatch,
  buildEntryIndexes,
  countNotifiableChanges,
  recomputeActivityRevertEligibility,
  removeServerSummary,
  upsertActivity,
  upsertServerCollection,
  upsertServerEntry,
  upsertServerSettings,
  upsertServerSummary,
} from './optimistic';
import { SingleRecordPersistence } from './persistence';
import {
  clearRecoveryMutationIds,
  createRecoveryActions,
  localRecoveryRecords,
  recoveryRecord,
} from './recovery';
import { mirrorFromState } from './runtime';
import {
  bootstrapSnapshot,
  createSettingsPairingActions,
  DEFAULT_SETTINGS,
  PAIRING_EXPIRED_MESSAGE,
} from './settings-pairing';
import { JournalSseClient, SseReplayResetError } from './sse-client';
import type { JournalState, LoadEntriesQuery, RestoreResult } from './state';
import {
  createTimelineRetrievalActions,
  eligibleTimelineIds,
  mergeIds,
  parseJournalSearch,
  pendingTimelineIds,
  reconcileTimelineMembership,
  selectActiveCollections,
  selectCollections,
  selectEntries,
  selectOpenTodayCount,
  selectTimelineEntries,
  timelineIdsWithRestoredEntry,
} from './timeline-retrieval';

export type {
  ConnectionStatus,
  CreateEntryInput,
  DeadLetter,
  JournalNotice,
  JournalPersistenceState,
  JournalResourceStatus,
  JournalSearchPage,
  JournalStatus,
  OutboxItem,
} from '../domain/contracts';
export type {
  ActivityView,
  AgentToken,
  Collection,
  Entry,
  EntryPatch,
  EntryState,
  EntryType,
  McpStatus,
  Settings,
  Summary,
  TagUsage,
  RecentlyDeletedEntry,
  Reflection,
} from '../api/types';
export type { JournalSearchFilters, JournalState, LoadEntriesQuery, RestoreResult } from './state';

function dateInTimezone(timezone: string, date = new Date()): string {
  try {
    return calendarDateInTimeZone(date, timezone);
  } catch {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

export function recomputeJournalToday(date = new Date()): boolean {
  const state = useJournalStore.getState();
  const today = dateInTimezone(state.timezone, date);
  if (today === state.today) return false;
  useJournalStore.setState({ today });
  return true;
}

function addCalendarDays(date: string, amount: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

function initialMirror(): MirrorData & { reflectionsByWeek: Record<string, Reflection> } {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const today = dateInTimezone(timezone);
  return {
    entriesById: {},
    entryIdsByDate: {},
    entryIdsByCollection: {},
    collectionsById: {},
    activityById: {},
    activityOrder: [],
    summariesByMonth: {},
    latestSummary: null,
    reflectionsByWeek: {},
    settings: DEFAULT_SETTINGS,
    index: null,
    mcpStatus: null,
    today,
    serverToday: today,
    timezone,
    cursor: null,
    deviceId: null,
  };
}

const persistence = new SingleRecordPersistence<JournalClientRecord>();
let persistenceTimer: number | undefined;
let initialization: Promise<void> | null = null;
let reconnecting: Promise<void> | null = null;
let authenticatedConnecting: Promise<void> | null = null;
let pendingReconnect: { full: boolean; authoritative: boolean; expectedGeneration: number } | null =
  null;
let reconnectRetryTimer: number | undefined;
let reconnectRetryDelay = 1_000;
let cancelReconnectDeadline: (() => void) | null = null;
let flushing: Promise<void> | null = null;
let activeOutboxMutationId: string | null = null;
let retryTimer: number | undefined;
let retryDelay = 1_000;
let sse: JournalSseClient | null = null;
let midnightScheduler: MidnightScheduler | null = null;
let unsubscribePwa: (() => void) | null = null;
let removeLifecycleListeners: (() => void) | null = null;
let assistantBurstTimer: number | undefined;
let assistantBurstCount = 0;
let assistantBurstLabel = 'Assistant';
let pairingExpired = false;
let authenticationProbe: Promise<void> | null = null;
let replayAuthenticationGeneration: number | null = null;
let startupConnectionGeneration: number | null = null;
let deferredStartupReconnect = false;
let sseGeneration = 0;
let lifecycleGeneration = 0;
let canonicalHistoryHydrationGeneration: number | null = null;
let sseReplayReady = true;
let activeResetSequence: number | null = null;
let resetSequence = 0;
let timelineRequestSequence = 0;
let canonicalHistoryRollback: {
  generation: number;
  mirror: MirrorData;
  activityHasMore: boolean;
  activityNextCursor: string | null;
} | null = null;

function recordFromState(
  state: JournalState,
  mirror = mirrorFromState(state),
): JournalClientRecord {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    mirror,
    draft: state.draft,
    defaultType: state.defaultType,
    outbox: state.outbox,
    deadLetters: state.deadLetters,
    agentTokens: state.agentTokens,
    lastReviewSeenAt: state.lastReviewSeenAt,
    activitySeenThrough: state.activitySeenThrough,
    seenActivityIds: state.seenActivityIds,
    monthLogView: state.monthLogView,
    collectionLogView: state.collectionLogView,
    timeline: {
      loaded: state.timelineLoaded,
      entryIds: state.timelineEntryIds,
      nextCursor: state.timelineNextCursor,
      anchorDate: state.timelineAnchorDate,
      latestAgentTouch: state.timelineLatestAgentTouch,
      weeklyReflection: state.timelineWeeklyReflection,
    },
  };
}

async function saveClientRecord(record: JournalClientRecord): Promise<void> {
  try {
    await persistence.save(record);
    if (useJournalStore.getState().persistenceStatus !== 'available') {
      useJournalStore.setState({ persistenceStatus: 'available' });
    }
  } catch (error) {
    useJournalStore.setState({ persistenceStatus: 'unavailable' });
    throw error;
  }
}

function persistNow(): Promise<void> {
  if (persistenceTimer !== undefined) window.clearTimeout(persistenceTimer);
  persistenceTimer = undefined;
  const state = useJournalStore.getState();
  const stableMirror = canonicalHistoryRollback
    ? recomputeActivityRevertEligibility(
        applyPendingCommands(canonicalHistoryRollback.mirror, state.outbox),
      )
    : mirrorFromState(state);
  return saveClientRecord(recordFromState(state, stableMirror));
}

function persistCurrentMirror(): Promise<void> {
  if (persistenceTimer !== undefined) window.clearTimeout(persistenceTimer);
  persistenceTimer = undefined;
  const state = useJournalStore.getState();
  return saveClientRecord(recordFromState(state));
}

export function flushJournalPersistence(): Promise<void> {
  return persistNow();
}

function persistSoon(delay = 100): void {
  if (persistenceTimer !== undefined) window.clearTimeout(persistenceTimer);
  persistenceTimer = window.setTimeout(() => {
    persistenceTimer = undefined;
    void persistNow().catch((error: unknown) =>
      addErrorNotice('Local journal storage failed.', error),
    );
  }, delay);
}

function addNotice(notice: Omit<JournalNotice, 'id' | 'at'>): void {
  useJournalStore.setState((state) => ({
    notices: [
      ...state.notices,
      { ...notice, id: createUlid(), at: new Date().toISOString() },
    ].slice(-10),
  }));
}

function addErrorNotice(message: string, error?: unknown): void {
  const detail = error instanceof ApiError && error.message !== message ? ` ${error.message}` : '';
  addNotice({ kind: 'error', message: `${message}${detail}` });
}

function observePwaOperation(operation: () => Promise<void>): void {
  const expectedGeneration = lifecycleGeneration;
  void operation().catch((error: unknown) => {
    if (expectedGeneration === lifecycleGeneration) {
      addErrorNotice('Offline app setup failed.', error);
    }
  });
}

function ensureSse(): JournalSseClient {
  if (sse) return sse;
  const generation = lifecycleGeneration;
  sse = new JournalSseClient({
    getCursor: () => useJournalStore.getState().cursor,
    onChange: (batch, cursor) => applyChangeBatch(batch, cursor, generation),
    onReset: async () => {
      if (generation !== lifecycleGeneration) return;
      const client = sse;
      if (!client) return;
      const resetId = ++resetSequence;
      activeResetSequence = resetId;
      let retryAuthoritative = false;
      sseReplayReady = false;
      client.pause('connecting');
      try {
        if (flushing) await flushing;
        if (generation !== lifecycleGeneration) return;
        if (pairingExpired) {
          throw new ApiError(401, 'unauthenticated', 'Pairing expired before history refresh.');
        }
        await reconcileAfterReset({ expectedGeneration: generation });
        if (generation !== lifecycleGeneration || pairingExpired) return;
        if (
          !useJournalStore.getState().networkOnline ||
          (typeof document !== 'undefined' && document.visibilityState === 'hidden')
        ) {
          client.pause('offline');
          return;
        }
        const connection = client.start();
        const deadline = createReconnectDeadline();
        let opened = false;
        try {
          opened = await Promise.race([
            connection.then(() => true),
            deadline.promise.then(() => false),
          ]);
        } finally {
          deadline.cancel();
        }
        if (!opened) {
          client.pause('error');
          throw new Error('Replacement live connection did not open in time.');
        }
        const replayGeneration = await waitForSseReplayReady(client, generation);
        if (!liveReplayIsReady(client, replayGeneration, generation)) return;
        await flushOutbox();
        if (!liveReplayIsReady(client, replayGeneration, generation)) return;
        resetReconnectRetry();
      } catch (error) {
        if (generation !== lifecycleGeneration) return;
        if (error instanceof SseReplayResetError) return;
        if (error instanceof ApiError && error.status === 401) {
          pauseForExpiredPairing();
          throw error;
        }
        if (
          !useJournalStore.getState().networkOnline ||
          (typeof document !== 'undefined' && document.visibilityState === 'hidden')
        ) {
          client.pause('offline');
          return;
        }
        client.pause('error');
        useJournalStore.setState({ connectionStatus: 'error', online: false });
        addErrorNotice('Live journal replay was reset.', error);
        retryAuthoritative = true;
        throw error;
      } finally {
        if (activeResetSequence === resetId) {
          activeResetSequence = null;
          if (retryAuthoritative && generation === lifecycleGeneration && !pairingExpired) {
            scheduleReconnectRetry(true, true);
          }
        }
      }
    },
    onStatus: (status) => {
      if (generation !== lifecycleGeneration) return;
      if (status !== 'connected') sseReplayReady = false;
      if (pairingExpired) {
        useJournalStore.setState({ connectionStatus: 'error', online: false });
        return;
      }
      const state = useJournalStore.getState();
      useJournalStore.setState({
        connectionStatus: state.networkOnline
          ? status === 'connected' && !sseReplayReady
            ? 'connecting'
            : status
          : 'offline',
        online:
          state.networkOnline && status === 'connected' && sseReplayReady
            ? true
            : status === 'error' || status === 'offline' || status === 'connecting'
              ? false
              : state.online,
      });
      if (
        status === 'error' &&
        state.networkOnline &&
        !pairingExpired &&
        activeResetSequence === null
      ) {
        void probeAuthentication().then(() => {
          if (generation !== lifecycleGeneration || pairingExpired) return;
          scheduleReconnectRetry(!useJournalStore.getState().cursor);
        });
      }
    },
  });
  return sse;
}

async function waitForSseReplayReady(
  client: JournalSseClient,
  expectedGeneration: number,
): Promise<number> {
  const replayGeneration = await client.finishReplay();
  if (expectedGeneration !== lifecycleGeneration || pairingExpired) return replayGeneration;
  if (!client.isReady(replayGeneration)) {
    throw new Error('Live replay was replaced before Journal became ready.');
  }
  if (
    !useJournalStore.getState().networkOnline ||
    (typeof document !== 'undefined' && document.visibilityState === 'hidden')
  ) {
    client.pause('offline');
    return replayGeneration;
  }
  if (useJournalStore.getState().connectionStatus === 'error') {
    throw new Error('Live replay failed before Journal was ready.');
  }
  sseReplayReady = true;
  useJournalStore.setState({
    connectionStatus: 'connected',
    loading: false,
    resourceStatus: 'ready',
    online: true,
  });
  return replayGeneration;
}

function liveReplayIsReady(
  client: JournalSseClient,
  replayGeneration: number,
  expectedGeneration: number,
): boolean {
  const state = useJournalStore.getState();
  return (
    expectedGeneration === lifecycleGeneration &&
    !pairingExpired &&
    sseReplayReady &&
    client.isReady(replayGeneration) &&
    state.networkOnline &&
    state.connectionStatus === 'connected' &&
    (typeof document === 'undefined' || document.visibilityState !== 'hidden')
  );
}

export async function applyChangeBatch(
  batch: ChangeBatch,
  cursor: string,
  expectedGeneration = lifecycleGeneration,
): Promise<void> {
  if (expectedGeneration !== lifecycleGeneration || pairingExpired) return;
  sseGeneration += 1;
  const before = useJournalStore.getState();
  const invalidatesIndex = batch.changes.some(
    (change) =>
      change.kind.startsWith('entry.') ||
      change.kind === 'collection.changed' ||
      change.kind === 'settings.changed',
  );
  const removedLatestSummary = batch.changes.some(
    (change) =>
      change.kind === 'summary.changed' &&
      Object.keys(change.payload).length === 1 &&
      change.payload.id === before.latestSummary?.id,
  );
  const remaining = batch.mutationId
    ? before.outbox.filter((item) => item.mutationId !== batch.mutationId)
    : before.outbox;
  let mirror = applyServerChangeBatch({ ...mirrorFromState(before), cursor }, batch);
  const agentTokens = applyAgentTokenChanges(before.agentTokens, batch);
  mirror = recomputeActivityRevertEligibility(applyPendingCommands(mirror, remaining));
  const changedEntryIds = batch.changes.flatMap((change) => {
    switch (change.kind) {
      case 'entry.created':
      case 'entry.updated':
      case 'entry.deleted':
        return [change.payload.id];
      default:
        return [];
    }
  });
  const timelineEntryIds = reconcileTimelineMembership(
    before.timelineEntryIds,
    mirror,
    changedEntryIds,
    before.timelineAnchorDate,
  );
  const recentlyDeleted = new Map(
    before.recentlyDeleted.map((item) => [item.entry.id, item] as const),
  );
  for (const change of batch.changes) {
    if (!change.kind.startsWith('entry.')) continue;
    const entry = change.payload as Entry;
    if (entry.deletedAt === null) recentlyDeleted.delete(entry.id);
    else recentlyDeleted.set(entry.id, recoveryRecord(entry, mirror.collectionsById));
  }
  useJournalStore.setState({
    ...mirror,
    ...(invalidatesIndex
      ? { indexSource: mirror.index === null ? ('none' as const) : ('cached' as const) }
      : {}),
    timelineEntryIds,
    outbox: remaining,
    outboxCount: remaining.length,
    agentTokens,
    recentlyDeleted: [...recentlyDeleted.values()].filter(
      (item) => Date.parse(item.expiresAt) > Date.now(),
    ),
  });
  await persistNow();
  if (expectedGeneration !== lifecycleGeneration || pairingExpired) return;
  if (removedLatestSummary) void refreshCanonicalLatestSummary();

  if (batch.origin.deviceId === before.deviceId) return;
  if (batch.origin.kind === 'mcp') {
    const changeCount = countNotifiableChanges(batch);
    if (changeCount === 0) return;
    assistantBurstCount += changeCount;
    assistantBurstLabel = batch.origin.tokenLabel ?? 'Assistant';
    if (assistantBurstTimer !== undefined) window.clearTimeout(assistantBurstTimer);
    assistantBurstTimer = window.setTimeout(() => {
      const count = assistantBurstCount;
      assistantBurstCount = 0;
      assistantBurstTimer = undefined;
      addNotice({
        kind: 'assistant',
        message: `${assistantBurstLabel} updated ${count} journal ${count === 1 ? 'item' : 'items'}.`,
      });
    }, 350);
  } else if (batch.origin.kind === 'app') {
    addNotice({ kind: 'device', message: 'Journal updated on another device.' });
  }
}

function retainedCachedEntries(
  mirror: MirrorData,
  discardedIds: ReadonlySet<string> = new Set(),
): Record<string, Entry> {
  // Bootstrap is intentionally a bounded Timeline page, so absence from that
  // response says nothing about older cached entries. Only an authoritative
  // reset or an explicit discard may remove them from the local mirror.
  return Object.fromEntries(
    Object.entries(mirror.entriesById).filter(([id]) => !discardedIds.has(id)),
  );
}

interface ReconcileOptions {
  allowPair?: boolean;
  authoritative?: boolean;
  discardEntryIds?: ReadonlySet<string>;
  expectedGeneration?: number;
  excludeMutationIds?: ReadonlySet<string>;
  persist?: boolean;
  preserveLatestSummary?: boolean;
}

interface PreparedBootstrap {
  mirror: MirrorData;
  activityHasMore: boolean;
  activityNextCursor: string | null;
  timeline: Pick<
    JournalState,
    | 'timelineEntryIds'
    | 'timelineNextCursor'
    | 'timelineAnchorDate'
    | 'timelineLoaded'
    | 'timelineLoading'
    | 'timelineLoadingEarlier'
    | 'timelineLatestAgentTouch'
    | 'timelineWeeklyReflection'
  > | null;
}

async function prepareBootstrapReconciliation(
  options: ReconcileOptions,
): Promise<PreparedBootstrap | null> {
  const generation = options.expectedGeneration ?? lifecycleGeneration;
  const responseGeneration = ++sseGeneration;
  let response: Awaited<ReturnType<typeof journalApi.bootstrap>> | null;
  try {
    response = await bootstrapSnapshot(options.allowPair ?? false, generation, {
      get: useJournalStore.getState,
      set: useJournalStore.setState,
      lifecycleGeneration: () => lifecycleGeneration,
      sseGeneration: () => sseGeneration,
      pairingExpired: () => pairingExpired,
      authenticated,
      requireOnline,
      persistNow,
      persistSoon,
    });
  } catch (error) {
    if (generation === lifecycleGeneration && error instanceof ApiError && error.status === 401) {
      pauseForExpiredPairing();
    }
    throw error;
  }
  if (
    !response ||
    generation !== lifecycleGeneration ||
    responseGeneration !== sseGeneration ||
    pairingExpired
  ) {
    return null;
  }
  let assistant = useJournalStore.getState().mcpStatus;
  try {
    assistant = (await authenticated(() => journalApi.getSettings())).assistant;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw error;
    // Journal data remains usable when the status-only request fails.
  }
  if (
    generation !== lifecycleGeneration ||
    responseGeneration !== sseGeneration ||
    pairingExpired
  ) {
    return null;
  }

  const state = useJournalStore.getState();
  const entriesById = {
    ...(options.authoritative
      ? {}
      : retainedCachedEntries(mirrorFromState(state), options.discardEntryIds)),
    ...Object.fromEntries(
      [...response.entries, ...(response.timeline?.items ?? [])].map((entry) => [entry.id, entry]),
    ),
  };
  const activityById = {
    ...(options.authoritative ? {} : state.activityById),
    ...Object.fromEntries(response.activity.map((activity) => [activity.id, activity])),
  };
  let base: MirrorData = {
    entriesById,
    ...buildEntryIndexes(entriesById),
    collectionsById: {
      ...Object.fromEntries(
        (state.index?.collections ?? [])
          .filter((collection) => collection.archivedAt !== null)
          .map((collection) => [
            collection.id,
            {
              id: collection.id,
              name: collection.name,
              note: collection.note,
              createdAt: collection.createdAt,
              archivedAt: collection.archivedAt,
            },
          ]),
      ),
      ...Object.fromEntries(response.collections.map((collection) => [collection.id, collection])),
      ...Object.fromEntries(
        (response.timeline?.collections ?? []).map((collection) => [collection.id, collection]),
      ),
    },
    activityById,
    activityOrder: Object.values(activityById)
      .sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id))
      .map((activity) => activity.id),
    summariesByMonth: options.authoritative ? {} : state.summariesByMonth,
    latestSummary: options.preserveLatestSummary ? state.latestSummary : null,
    reflectionsByWeek: {
      ...(options.authoritative ? {} : state.reflectionsByWeek),
    },
    settings: response.settings,
    index: state.index,
    mcpStatus: assistant,
    today: response.today,
    serverToday: response.today,
    timezone: response.timezone,
    cursor: response.cursor,
    deviceId: response.deviceId,
  };
  if (response.latestSummary) base = upsertServerSummary(base, response.latestSummary);
  const projectedOutbox = options.excludeMutationIds
    ? state.outbox.filter((item) => !options.excludeMutationIds?.has(item.mutationId))
    : state.outbox;
  const mirror = recomputeActivityRevertEligibility(applyPendingCommands(base, projectedOutbox));
  const oldest = response.activity.at(-1);
  return {
    mirror,
    activityHasMore: response.activity.length >= 50,
    activityNextCursor: oldest?.at ?? null,
    timeline: response.timeline
      ? {
          timelineEntryIds: eligibleTimelineIds(
            mirror,
            mergeIds(
              response.timeline.items.map((entry) => entry.id),
              pendingTimelineIds(projectedOutbox, null),
            ),
            null,
          ),
          timelineNextCursor: response.timeline.nextCursor,
          timelineAnchorDate: null,
          timelineLoaded: true,
          timelineLoading: false,
          timelineLoadingEarlier: false,
          timelineLatestAgentTouch: response.timeline.latestAgentTouch ?? null,
          timelineWeeklyReflection: response.timeline.weeklyReflection ?? null,
        }
      : null,
  };
}

export async function reconcileFromBootstrap(options: ReconcileOptions = {}): Promise<boolean> {
  const prepared = await prepareBootstrapReconciliation(options);
  if (!prepared) return false;
  useJournalStore.setState({
    ...prepared.mirror,
    ...(prepared.timeline ?? {}),
    loading: false,
    resourceStatus: 'ready',
    online:
      sseReplayReady &&
      canonicalHistoryHydrationGeneration === null &&
      useJournalStore.getState().connectionStatus === 'connected',
    activityHasMore: prepared.activityHasMore,
    activityNextCursor: prepared.activityNextCursor,
  });
  if (options.persist !== false) await persistNow();
  return true;
}

interface ResetHistoryScope {
  activityIds: ReadonlySet<string>;
  summaryMonths: readonly string[];
}

function resetHistoryScope(state: JournalState): ResetHistoryScope {
  const summaryMonths = new Set(Object.keys(state.summariesByMonth));
  if (state.latestSummary) summaryMonths.add(state.latestSummary.weekStart.slice(0, 7));
  return {
    activityIds: new Set(state.activityOrder),
    summaryMonths: [...summaryMonths].sort(),
  };
}

function restoreCanonicalHistoryRollback(expectedGeneration?: number): boolean {
  const rollback = canonicalHistoryRollback;
  if (
    !rollback ||
    (expectedGeneration !== undefined && rollback.generation !== expectedGeneration)
  ) {
    return false;
  }
  const current = useJournalStore.getState();
  const restored = recomputeActivityRevertEligibility(
    applyPendingCommands(rollback.mirror, current.outbox),
  );
  useJournalStore.setState({
    ...restored,
    activityHasMore: rollback.activityHasMore,
    activityNextCursor: rollback.activityNextCursor,
    loading: false,
    resourceStatus: 'ready',
  });
  if (canonicalHistoryHydrationGeneration === rollback.generation) {
    canonicalHistoryHydrationGeneration = null;
  }
  canonicalHistoryRollback = null;
  return true;
}

function resetHydrationIsCurrent(generation: number, responseGeneration: number): boolean {
  return (
    generation === lifecycleGeneration && responseGeneration === sseGeneration && !pairingExpired
  );
}

function clearSummaryMonth(mirror: MirrorData, month: string): MirrorData {
  const current = mirror.summariesByMonth[month];
  let withoutSummary = current ? removeServerSummary(mirror, current.id) : mirror;
  if (withoutSummary.latestSummary?.weekStart.slice(0, 7) === month) {
    withoutSummary = removeServerSummary(withoutSummary, withoutSummary.latestSummary.id);
  }
  return {
    ...withoutSummary,
    summariesByMonth: { ...withoutSummary.summariesByMonth, [month]: null },
  };
}

async function refetchCanonicalResetHistory(
  scope: ResetHistoryScope,
  generation: number,
): Promise<boolean> {
  const responseGeneration = sseGeneration;
  // The bounded bootstrap already supplied the canonical Timeline page. Other
  // screens reload their own scoped data after reconnect; a reset must never
  // turn into an implicit lifetime entry download.

  const remainingActivityIds = new Set(scope.activityIds);
  for (const id of useJournalStore.getState().activityOrder) remainingActivityIds.delete(id);
  const seenCursors = new Set<string>();
  const activityState = useJournalStore.getState();
  let before =
    activityState.activityNextCursor ??
    activityState.activityById[activityState.activityOrder.at(-1) ?? '']?.at ??
    null;
  let hasMore = activityState.activityHasMore && before !== null;
  while (remainingActivityIds.size > 0 && hasMore && before) {
    if (seenCursors.has(before)) {
      useJournalStore.setState({ activityHasMore: false, activityNextCursor: null });
      break;
    }
    seenCursors.add(before);
    const cursor = before;
    const response = await authenticated(() => journalApi.listActivity(cursor, 50), generation);
    if (!resetHydrationIsCurrent(generation, responseGeneration)) return false;
    let mirror = mirrorFromState(useJournalStore.getState());
    for (const activity of response.items) {
      mirror = upsertActivity(mirror, activity);
      remainingActivityIds.delete(activity.id);
    }
    before = response.nextCursor;
    hasMore = before !== null;
    useJournalStore.setState({
      ...recomputeActivityRevertEligibility(mirror),
      activityHasMore: hasMore,
      activityNextCursor: before,
    });
  }

  for (const month of scope.summaryMonths) {
    const response = await authenticated(() => journalApi.latestSummary(month), generation);
    if (!resetHydrationIsCurrent(generation, responseGeneration)) return false;
    const mirror = mirrorFromState(useJournalStore.getState());
    useJournalStore.setState(
      response.summary
        ? recomputeActivityRevertEligibility(upsertServerSummary(mirror, response.summary))
        : recomputeActivityRevertEligibility(clearSummaryMonth(mirror, month)),
    );
  }
  return resetHydrationIsCurrent(generation, responseGeneration);
}

/** Rebuilds reset-sensitive downloaded history from canonical paged endpoints before SSE resumes. */
export async function reconcileAfterReset(
  options: {
    allowPair?: boolean;
    expectedGeneration?: number;
  } = {},
): Promise<void> {
  const expectedGeneration = options.expectedGeneration ?? lifecycleGeneration;
  if (canonicalHistoryHydrationGeneration !== null) {
    throw new Error('Canonical history refresh is already in progress.');
  }
  const prior = useJournalStore.getState();
  const priorMirror = mirrorFromState(prior);
  const priorActivityHasMore = prior.activityHasMore;
  const priorActivityNextCursor = prior.activityNextCursor;
  const scope = resetHistoryScope(prior);
  canonicalHistoryHydrationGeneration = expectedGeneration;
  canonicalHistoryRollback = {
    generation: expectedGeneration,
    mirror: priorMirror,
    activityHasMore: priorActivityHasMore,
    activityNextCursor: priorActivityNextCursor,
  };
  const finishHydration = (): void => {
    if (canonicalHistoryHydrationGeneration === expectedGeneration) {
      canonicalHistoryHydrationGeneration = null;
    }
  };
  try {
    const applied = await reconcileFromBootstrap({
      ...(options.allowPair === undefined ? {} : { allowPair: options.allowPair }),
      authoritative: true,
      expectedGeneration,
      persist: false,
    });
    if (expectedGeneration !== lifecycleGeneration) return;
    if (pairingExpired) {
      throw new ApiError(401, 'unauthenticated', 'Pairing expired during history refresh.');
    }
    if (!applied) throw new Error('Canonical bootstrap was superseded before it completed.');
    const complete = await refetchCanonicalResetHistory(scope, expectedGeneration);
    if (!complete) {
      throw new Error('Canonical history refresh was superseded before it completed.');
    }
    const rollback = canonicalHistoryRollback;
    canonicalHistoryRollback = null;
    try {
      await persistCurrentMirror();
    } catch (error) {
      if (expectedGeneration === lifecycleGeneration) canonicalHistoryRollback = rollback;
      throw error;
    }
    finishHydration();
  } catch (error) {
    if (expectedGeneration === lifecycleGeneration) {
      restoreCanonicalHistoryRollback(expectedGeneration);
      await persistNow();
    }
    throw error;
  } finally {
    finishHydration();
  }
}

async function reconnectJournal(
  full = false,
  authoritative = false,
  expectedGeneration = lifecycleGeneration,
): Promise<void> {
  if (reconnecting) {
    const current = pendingReconnect;
    pendingReconnect =
      current?.expectedGeneration === expectedGeneration
        ? {
            full: current.full || full,
            authoritative: current.authoritative || authoritative,
            expectedGeneration,
          }
        : { full, authoritative, expectedGeneration };
    return reconnecting;
  }
  const operation = (async () => {
    if (expectedGeneration !== lifecycleGeneration) return;
    if (activeResetSequence !== null || canonicalHistoryHydrationGeneration !== null) return;
    const state = useJournalStore.getState();
    if (
      !state.networkOnline ||
      pairingExpired ||
      (typeof document !== 'undefined' && document.visibilityState === 'hidden')
    ) {
      return;
    }
    useJournalStore.setState({ connectionStatus: 'connecting', online: false });

    try {
      sseReplayReady = false;
      if (full || !state.cursor) {
        if (authoritative) {
          await reconcileAfterReset({ allowPair: full, expectedGeneration });
        } else {
          const applied = await reconcileFromBootstrap({
            allowPair: full,
            authoritative: false,
            expectedGeneration,
          });
          if (!applied) return;
        }
      }
      if (expectedGeneration !== lifecycleGeneration || pairingExpired) return;
      const beforeStream = useJournalStore.getState();
      if (
        !beforeStream.networkOnline ||
        (typeof document !== 'undefined' && document.visibilityState === 'hidden')
      ) {
        useJournalStore.setState({
          connectionStatus: 'offline',
          loading: false,
          resourceStatus: 'ready',
          online: false,
        });
        return;
      }
      const sseClient = ensureSse();
      const connection = sseClient.reconnect();
      const deadline = createReconnectDeadline();
      let opened = false;
      try {
        opened = await Promise.race([
          connection.then(() => true),
          deadline.promise.then(() => false),
        ]);
      } finally {
        deadline.cancel();
      }
      if (!opened) {
        sseClient.pause('error');
        throw new Error('Live journal connection did not open in time.');
      }
      if (expectedGeneration !== lifecycleGeneration || pairingExpired) return;
      const replayGeneration = await waitForSseReplayReady(sseClient, expectedGeneration);
      if (!liveReplayIsReady(sseClient, replayGeneration, expectedGeneration)) return;
      await flushOutbox();
      if (!liveReplayIsReady(sseClient, replayGeneration, expectedGeneration)) return;

      if (!full && useJournalStore.getState().cursor) {
        const current = useJournalStore.getState();
        const responseGeneration = sseGeneration;
        const page = await authenticated(() =>
          journalApi.listEntries({
            from: current.today,
            to: current.today,
            limit: 100,
          }),
        );
        if (
          expectedGeneration !== lifecycleGeneration ||
          responseGeneration !== sseGeneration ||
          pairingExpired ||
          !liveReplayIsReady(sseClient, replayGeneration, expectedGeneration)
        ) {
          return;
        }
        let mirror = mirrorFromState(useJournalStore.getState());
        for (const entry of page.items) mirror = upsertServerEntry(mirror, entry);
        mirror = recomputeActivityRevertEligibility(
          applyPendingCommands(mirror, useJournalStore.getState().outbox),
        );
        useJournalStore.setState({
          ...mirror,
          today: page.today,
          serverToday: page.today,
          timezone: page.timezone,
          online: liveReplayIsReady(sseClient, replayGeneration, expectedGeneration),
        });
        await persistNow();
      }
      if (!liveReplayIsReady(sseClient, replayGeneration, expectedGeneration)) return;
      resetReconnectRetry();
    } catch (error) {
      if (expectedGeneration !== lifecycleGeneration) return;
      if (error instanceof SseReplayResetError) return;
      if (error instanceof ApiError && error.status === 401) {
        pauseForExpiredPairing();
        return;
      }
      if (
        !useJournalStore.getState().networkOnline ||
        (typeof document !== 'undefined' && document.visibilityState === 'hidden')
      ) {
        useJournalStore.setState({
          connectionStatus: 'offline',
          loading: false,
          resourceStatus: 'ready',
          online: false,
        });
        return;
      }
      useJournalStore.setState((current) => ({
        connectionStatus: 'error',
        loading: false,
        resourceStatus: current.resourceStatus === 'loading' ? 'error' : current.resourceStatus,
        online: false,
      }));
      addErrorNotice('Could not reconnect to Journal.', error);
      scheduleReconnectRetry(full || !useJournalStore.getState().cursor, authoritative);
    }
  })().finally(() => {
    if (reconnecting !== operation) return;
    reconnecting = null;
    const requested = pendingReconnect;
    pendingReconnect = null;
    if (requested && requested.expectedGeneration === lifecycleGeneration && !pairingExpired) {
      void reconnectJournal(requested.full, requested.authoritative, requested.expectedGeneration);
    }
  });
  reconnecting = operation;
  return operation;
}

function resetReconnectRetry(): void {
  if (reconnectRetryTimer !== undefined) window.clearTimeout(reconnectRetryTimer);
  reconnectRetryTimer = undefined;
  reconnectRetryDelay = 1_000;
}

function createReconnectDeadline(): { promise: Promise<void>; cancel: () => void } {
  let timer: number | undefined;
  let resolvePromise!: () => void;
  let settled = false;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
    timer = window.setTimeout(() => {
      settled = true;
      resolve();
    }, 1_500);
  });
  const cancel = (): void => {
    if (cancelReconnectDeadline === cancel) cancelReconnectDeadline = null;
    if (settled) return;
    settled = true;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    resolvePromise();
  };
  cancelReconnectDeadline = cancel;
  return { promise, cancel };
}

function pauseForExpiredPairing(): void {
  if (!pairingExpired) sseGeneration += 1;
  pairingExpired = true;
  resetReconnectRetry();
  if (retryTimer !== undefined) window.clearTimeout(retryTimer);
  retryTimer = undefined;
  sse?.pause('error');
  useJournalStore.setState((state) => ({
    connectionStatus: 'error',
    loading: false,
    resourceStatus: state.resourceStatus === 'loading' ? 'error' : state.resourceStatus,
    online: false,
    authenticationRequired: true,
  }));
  if (
    !useJournalStore.getState().notices.some((notice) => notice.message === PAIRING_EXPIRED_MESSAGE)
  ) {
    addNotice({ kind: 'error', message: PAIRING_EXPIRED_MESSAGE });
  }
}

async function authenticated<T>(
  operation: () => Promise<T>,
  expectedGeneration = lifecycleGeneration,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      expectedGeneration === lifecycleGeneration &&
      error instanceof ApiError &&
      error.status === 401
    ) {
      pauseForExpiredPairing();
    }
    throw error;
  }
}

async function authenticateCursorReplay(expectedGeneration: number): Promise<void> {
  let response: Awaited<ReturnType<typeof journalApi.getSettings>>;
  try {
    response = await journalApi.getSettings();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    if (expectedGeneration !== lifecycleGeneration) return;
    const paired = await journalApi.pair();
    const pairedState = useJournalStore.getState();
    useJournalStore.setState({ ...mirrorFromState(pairedState), deviceId: paired.deviceId });
    await persistNow();
    if (expectedGeneration !== lifecycleGeneration) return;
    try {
      response = await journalApi.getSettings();
    } catch (retryError) {
      if (retryError instanceof ApiError && retryError.status === 401) pauseForExpiredPairing();
      throw retryError;
    }
  }
  if (expectedGeneration !== lifecycleGeneration) return;
  const state = useJournalStore.getState();
  const mirror = upsertServerSettings(mirrorFromState(state), response.settings);
  useJournalStore.setState({ ...mirror, mcpStatus: response.assistant, online: false });
}

async function connectAuthenticatedJournal(expectedGeneration: number): Promise<void> {
  if (authenticatedConnecting) {
    // Authentication may already have completed while the active connection is
    // still refreshing REST state. Preserve a resume/retry request in the
    // reconnect latch instead of letting that intent disappear with the
    // in-flight wrapper.
    if (replayAuthenticationGeneration === expectedGeneration) {
      const state = useJournalStore.getState();
      void reconnectJournal(!state.cursor, false, expectedGeneration);
    }
    return authenticatedConnecting;
  }
  const operation = (async () => {
    if (expectedGeneration !== lifecycleGeneration || pairingExpired) return;
    if (
      (typeof navigator !== 'undefined' && !navigator.onLine) ||
      (typeof document !== 'undefined' && document.visibilityState === 'hidden')
    ) {
      useJournalStore.setState({
        networkOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
        online: false,
        connectionStatus: 'offline',
        loading: false,
        resourceStatus: 'ready',
      });
      return;
    }
    const beforeAuthentication = useJournalStore.getState();
    if (
      replayAuthenticationGeneration !== expectedGeneration ||
      !beforeAuthentication.networkOnline
    ) {
      await authenticateCursorReplay(expectedGeneration);
      if (expectedGeneration !== lifecycleGeneration || pairingExpired) return;
      replayAuthenticationGeneration = expectedGeneration;
    }
    if (
      (typeof navigator !== 'undefined' && !navigator.onLine) ||
      (typeof document !== 'undefined' && document.visibilityState === 'hidden')
    ) {
      useJournalStore.setState({
        networkOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
        online: false,
        connectionStatus: 'offline',
        loading: false,
        resourceStatus: 'ready',
      });
      return;
    }
    useJournalStore.setState({
      networkOnline: true,
      online: false,
      connectionStatus: 'connecting',
    });
    const state = useJournalStore.getState();
    await reconnectJournal(!state.cursor, false, expectedGeneration);
  })().finally(() => {
    if (authenticatedConnecting === operation) authenticatedConnecting = null;
  });
  authenticatedConnecting = operation;
  return operation;
}

function requestAuthenticatedReconnect(expectedGeneration = lifecycleGeneration): void {
  if (startupConnectionGeneration === expectedGeneration) {
    // Lifecycle input can arrive before authentication or while the initial
    // reconnect is blocked in its post-replay REST refresh. In either case the
    // startup operation must hand off one final, coalesced reconnect attempt.
    deferredStartupReconnect = true;
    return;
  }
  void connectAuthenticatedJournal(expectedGeneration).catch((error: unknown) => {
    if (expectedGeneration !== lifecycleGeneration || pairingExpired) return;
    if (error instanceof ApiError && error.status === 401) {
      pauseForExpiredPairing();
      return;
    }
    sseReplayReady = false;
    useJournalStore.setState((state) => ({
      connectionStatus: 'error',
      loading: false,
      resourceStatus: state.resourceStatus === 'loading' ? 'error' : state.resourceStatus,
      online: false,
    }));
    addErrorNotice('Could not authenticate Journal.', error);
    scheduleReconnectRetry(!useJournalStore.getState().cursor);
    if (useJournalStore.getState().outbox.length > 0) scheduleOutboxRetry();
  });
}

export function probeAuthentication(): Promise<void> {
  if (authenticationProbe) return authenticationProbe;
  const generation = lifecycleGeneration;
  const operation = journalApi
    .getSettings()
    .then(() => undefined)
    .catch((error: unknown) => {
      if (generation === lifecycleGeneration && error instanceof ApiError && error.status === 401) {
        pauseForExpiredPairing();
      }
    })
    .finally(() => {
      if (authenticationProbe === operation) authenticationProbe = null;
    });
  authenticationProbe = operation;
  return operation;
}

function scheduleReconnectRetry(full: boolean, authoritative = false): void {
  if (
    reconnectRetryTimer !== undefined ||
    !useJournalStore.getState().networkOnline ||
    pairingExpired ||
    canonicalHistoryHydrationGeneration !== null ||
    activeResetSequence !== null ||
    (typeof document !== 'undefined' && document.visibilityState === 'hidden')
  ) {
    return;
  }
  const generation = lifecycleGeneration;
  reconnectRetryTimer = window.setTimeout(() => {
    reconnectRetryTimer = undefined;
    if (
      !pairingExpired &&
      canonicalHistoryHydrationGeneration === null &&
      activeResetSequence === null
    ) {
      if (replayAuthenticationGeneration !== generation) {
        requestAuthenticatedReconnect(generation);
      } else {
        void reconnectJournal(full, authoritative, generation);
      }
    }
  }, reconnectRetryDelay);
  reconnectRetryDelay = Math.min(reconnectRetryDelay * 2, 60_000);
}

async function enqueueCommand(command: QueueableCommand): Promise<void> {
  const lifecycle = lifecycleGeneration;
  const item = descriptorForCommand(command);
  useJournalStore.setState((state) => {
    const outbox = [...state.outbox, item];
    const mirror = recomputeActivityRevertEligibility(
      applyOptimisticCommand(mirrorFromState(state), command),
    );
    const timelineEntryIds = reconcileTimelineMembership(
      state.timelineEntryIds,
      mirror,
      affectedEntryIds(command),
      state.timelineAnchorDate,
    );
    return {
      ...mirror,
      indexSource: mirror.index === null ? 'none' : 'cached',
      timelineEntryIds,
      outbox,
      outboxCount: outbox.length,
    };
  });
  await persistNow();
  if (lifecycle === lifecycleGeneration) {
    const state = useJournalStore.getState();
    if (!state.networkOnline || !sseReplayReady || state.connectionStatus !== 'connected') {
      scheduleOutboxRetry();
    }
    void flushOutbox();
  }
}

async function settleOutboxItem(item: OutboxItem, rows: ServerRows): Promise<void> {
  // Its SSE transaction may have acknowledged the mutation while HTTP was delayed.
  // In that case the live mirror is at least as new, so the response must not overwrite it.
  if (
    !useJournalStore.getState().outbox.some((candidate) => candidate.mutationId === item.mutationId)
  ) {
    retryDelay = 1_000;
    return;
  }
  useJournalStore.setState((state) => {
    const outbox = state.outbox.filter((candidate) => candidate.mutationId !== item.mutationId);
    let mirror = applyServerRows(mirrorFromState(state), rows);
    mirror = recomputeActivityRevertEligibility(applyPendingCommands(mirror, outbox));
    return {
      ...mirror,
      timelineEntryIds: reconcileTimelineMembership(
        state.timelineEntryIds,
        mirror,
        affectedEntryIds(item.command),
        state.timelineAnchorDate,
      ),
      outbox,
      outboxCount: outbox.length,
      online: sseReplayReady && state.connectionStatus === 'connected',
    };
  });
  retryDelay = 1_000;
  await persistNow();
}

function scheduleOutboxRetry(): void {
  if (retryTimer !== undefined) return;
  const generation = lifecycleGeneration;
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined;
    if (generation !== lifecycleGeneration || pairingExpired) return;
    const state = useJournalStore.getState();
    if (!state.networkOnline || !sseReplayReady || state.connectionStatus !== 'connected') {
      requestAuthenticatedReconnect(generation);
    } else {
      void flushOutbox();
    }
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60_000);
}

async function deadLetterItem(
  item: OutboxItem,
  error: ApiError,
  expectedGeneration: number,
): Promise<boolean> {
  if (expectedGeneration !== lifecycleGeneration) return false;
  const deadLetter: DeadLetter = {
    id: createUlid(),
    mutationId: item.mutationId,
    message: error.message,
    code: error.code,
    failedAt: new Date().toISOString(),
    operation: item.command.kind,
    item,
  };
  let prepared: PreparedBootstrap | null;
  try {
    prepared = await prepareBootstrapReconciliation({
      discardEntryIds: affectedEntryIds(item.command),
      excludeMutationIds: new Set([item.mutationId]),
      expectedGeneration,
      preserveLatestSummary: true,
    });
  } catch (reconcileError) {
    if (expectedGeneration !== lifecycleGeneration || pairingExpired) return false;
    addErrorNotice('Could not reconcile a failed Journal change.', reconcileError);
    scheduleReconnectRetry(true);
    return false;
  }
  if (!prepared || expectedGeneration !== lifecycleGeneration || pairingExpired) {
    if (expectedGeneration === lifecycleGeneration && !pairingExpired) {
      scheduleReconnectRetry(true);
    }
    return false;
  }
  const beforeCommit = useJournalStore.getState();
  const rollbackMirror = mirrorFromState(beforeCommit);
  const originalOutboxIndex = beforeCommit.outbox.findIndex(
    (candidate) => candidate.mutationId === item.mutationId,
  );
  const affectedIds = affectedEntryIds(item.command);
  let committed = false;
  useJournalStore.setState((state) => {
    if (!state.outbox.some((candidate) => candidate.mutationId === item.mutationId)) return {};
    committed = true;
    const outbox = state.outbox.filter((candidate) => candidate.mutationId !== item.mutationId);
    return {
      ...prepared.mirror,
      timelineEntryIds: reconcileTimelineMembership(
        state.timelineEntryIds,
        prepared.mirror,
        affectedIds,
        state.timelineAnchorDate,
      ),
      recentlyDeleted: localRecoveryRecords(
        prepared.mirror.entriesById,
        prepared.mirror.collectionsById,
      ),
      outbox,
      outboxCount: outbox.length,
      deadLetters: [...state.deadLetters, deadLetter],
      activityHasMore: prepared.activityHasMore,
      activityNextCursor: prepared.activityNextCursor,
    };
  });
  if (!committed) return true;
  try {
    await persistNow();
  } catch (persistError) {
    if (expectedGeneration === lifecycleGeneration && !pairingExpired) {
      useJournalStore.setState((state) => {
        if (state.outbox.some((candidate) => candidate.mutationId === item.mutationId)) return {};
        const outbox = [...state.outbox];
        outbox.splice(Math.max(0, Math.min(originalOutboxIndex, outbox.length)), 0, item);
        let base = mirrorFromState(state);
        for (const id of affectedEntryIds(item.command)) {
          const rollbackEntry = rollbackMirror.entriesById[id];
          if (!base.entriesById[id] && rollbackEntry) {
            base = upsertServerEntry(base, rollbackEntry);
          }
        }
        for (const id of affectedCollectionIds(item.command)) {
          const rollbackCollection = rollbackMirror.collectionsById[id];
          if (!base.collectionsById[id] && rollbackCollection) {
            base = upsertServerCollection(base, rollbackCollection);
          }
        }
        const mirror = recomputeActivityRevertEligibility(
          applyOptimisticCommand(base, item.command),
        );
        return {
          ...mirror,
          timelineEntryIds: reconcileTimelineMembership(
            state.timelineEntryIds,
            mirror,
            affectedIds,
            state.timelineAnchorDate,
          ),
          recentlyDeleted: localRecoveryRecords(mirror.entriesById, mirror.collectionsById),
          outbox,
          outboxCount: outbox.length,
          deadLetters: state.deadLetters.filter((letter) => letter.id !== deadLetter.id),
        };
      });
      scheduleOutboxRetry();
    }
    throw persistError;
  }
  if (expectedGeneration !== lifecycleGeneration || pairingExpired) return false;
  addErrorNotice(`Couldn't sync ${item.command.kind.replace('.', ' ')}.`, error);
  return true;
}

async function flushOutbox(): Promise<void> {
  if (flushing) return flushing;
  const generation = lifecycleGeneration;
  const operation = (async () => {
    if (
      !useJournalStore.getState().networkOnline ||
      pairingExpired ||
      canonicalHistoryHydrationGeneration !== null ||
      !sseReplayReady
    ) {
      return;
    }
    useJournalStore.setState({ syncing: true });
    while (
      generation === lifecycleGeneration &&
      useJournalStore.getState().networkOnline &&
      !pairingExpired &&
      canonicalHistoryHydrationGeneration === null &&
      sseReplayReady
    ) {
      const item = useJournalStore.getState().outbox[0];
      if (!item) break;
      activeOutboxMutationId = item.mutationId;
      try {
        const responseGeneration = sseGeneration;
        const rows = await sendOutboxItem(item);
        if (generation !== lifecycleGeneration) return;
        if (pairingExpired) break;
        if (responseGeneration !== sseGeneration) {
          // A reset/newer live batch is the canonical boundary. Acknowledge the
          // successful mutation without applying its now-stale response, then
          // reveal the canonical row beneath the optimistic projection.
          await settleOutboxItem(item, {});
          if (canonicalHistoryHydrationGeneration !== null || !sseReplayReady) break;
          try {
            await reconcileFromBootstrap({ expectedGeneration: generation });
          } catch (error) {
            if (generation !== lifecycleGeneration) return;
            if (!(error instanceof ApiError) || error.status !== 401) {
              addErrorNotice('Could not refresh Journal after a delayed sync.', error);
              scheduleReconnectRetry(true);
            }
            break;
          }
          continue;
        }
        await settleOutboxItem(item, rows);
      } catch (error) {
        if (generation !== lifecycleGeneration) return;
        if (!(error instanceof ApiError)) throw error;
        if (
          !useJournalStore
            .getState()
            .outbox.some((candidate) => candidate.mutationId === item.mutationId)
        ) {
          continue;
        }
        if (error.status === 401) {
          pauseForExpiredPairing();
          break;
        }
        if (error.retryable || error.status === 0) {
          if (error.status === 0) {
            sseReplayReady = false;
            useJournalStore.setState({ online: false, connectionStatus: 'error' });
          }
          scheduleOutboxRetry();
          break;
        }
        if (error.permanent) {
          if (!(await deadLetterItem(item, error, generation))) break;
          continue;
        }
        break;
      } finally {
        if (activeOutboxMutationId === item.mutationId) activeOutboxMutationId = null;
      }
    }
  })()
    .catch((error: unknown) => {
      if (generation === lifecycleGeneration) addErrorNotice('Outbox sync failed.', error);
    })
    .finally(() => {
      if (flushing === operation) flushing = null;
      if (generation === lifecycleGeneration) useJournalStore.setState({ syncing: false });
    });
  flushing = operation;
  return operation;
}

export function createCaptureContext(
  state: Pick<JournalState, 'today' | 'serverToday' | 'timezone'>,
  input: CreateEntryInput,
  at: string,
): {
  dateIntent: DateIntent;
  targetDate: string;
} {
  const targetDate =
    input.dateShift === 'tomorrow' ? addCalendarDays(state.today, 1) : (input.date ?? state.today);
  const kind =
    targetDate === state.serverToday
      ? 'today'
      : targetDate === addCalendarDays(state.serverToday, 1)
        ? 'tomorrow'
        : 'absolute';
  const context = { capturedAt: at, baseToday: state.serverToday, timezone: state.timezone };
  if (kind === 'absolute') {
    return { targetDate, dateIntent: { kind, date: targetDate, ...context } };
  }
  return { targetDate, dateIntent: { kind, ...context } };
}

function normalizePatch(entry: Entry, patch: EntryPatch): EntryPatch {
  if (!patch.type || patch.state) return patch;
  const actionable = patch.type === 'task' || patch.type === 'habit';
  const wasActionable = entry.type === 'task' || entry.type === 'habit';
  if (actionable === wasActionable) return patch;
  return { ...patch, state: actionable ? 'open' : 'logged' };
}

function requireEntry(id: string): Entry {
  const entry = useJournalStore.getState().entriesById[id];
  if (!entry || entry.deletedAt !== null) throw new Error('Entry no longer exists.');
  return entry;
}

function requireOnline(): void {
  if (!useJournalStore.getState().online || pairingExpired) {
    throw new ApiError(0, 'offline', 'This action requires a connection.');
  }
}

async function refreshCanonicalLatestSummary(): Promise<Summary | null> {
  const lifecycle = lifecycleGeneration;
  const generation = sseGeneration;
  const response = await authenticated(() => journalApi.latestSummary());
  if (lifecycle !== lifecycleGeneration || pairingExpired) return response.summary;
  let mirror = mirrorFromState(useJournalStore.getState());
  if (generation === sseGeneration) {
    mirror = response.summary
      ? upsertServerSummary({ ...mirror, latestSummary: null }, response.summary)
      : { ...mirror, latestSummary: null };
  } else if (response.summary) {
    mirror = upsertServerSummary(mirror, response.summary);
  }
  useJournalStore.setState(recomputeActivityRevertEligibility(mirror));
  await persistNow();
  return response.summary;
}

async function loadCanonicalMonthSummary(
  month: string,
  expectedLifecycle: number,
  attempt = 0,
): Promise<void> {
  const generation = sseGeneration;
  const response = await authenticated(() => journalApi.latestSummary(month), expectedLifecycle);
  if (expectedLifecycle !== lifecycleGeneration || pairingExpired) return;
  if (generation !== sseGeneration) {
    if (attempt < 3 && canonicalHistoryHydrationGeneration === null && sseReplayReady) {
      return loadCanonicalMonthSummary(month, expectedLifecycle, attempt + 1);
    }
    throw new Error('Journal changed while the monthly summary was loading. Please retry.');
  }
  const current = mirrorFromState(useJournalStore.getState());
  useJournalStore.setState(
    response.summary
      ? upsertServerSummary(current, response.summary)
      : recomputeActivityRevertEligibility(clearSummaryMonth(current, month)),
  );
  await persistNow();
}

async function initializeJournal(): Promise<void> {
  if (initialization) return initialization;
  const generation = ++lifecycleGeneration;
  useJournalStore.setState({
    hydrated: false,
    loading: true,
    resourceStatus: 'loading',
    authenticationRequired: false,
  });
  sseReplayReady = false;
  replayAuthenticationGeneration = null;
  startupConnectionGeneration = generation;
  deferredStartupReconnect = false;
  const operation = (async () => {
    let saved: JournalClientRecord | undefined;
    try {
      saved = await persistence.load();
    } catch (error) {
      if (generation === lifecycleGeneration) {
        useJournalStore.setState({ persistenceStatus: 'unavailable' });
      }
      throw error;
    }
    if (generation !== lifecycleGeneration) return;
    const networkAvailable = typeof navigator === 'undefined' ? true : navigator.onLine;
    if (saved?.version === 1) {
      const mirror = recomputeActivityRevertEligibility({
        ...saved.mirror,
        index: saved.mirror.index ?? null,
        summariesByMonth: saved.mirror.summariesByMonth ?? {},
        reflectionsByWeek: saved.mirror.reflectionsByWeek ?? {},
        serverToday: saved.mirror.serverToday ?? saved.mirror.today,
        ...buildEntryIndexes(saved.mirror.entriesById),
      });
      useJournalStore.setState({
        ...mirror,
        indexStatus: mirror.index === null ? 'idle' : 'ready',
        indexSource: mirror.index === null ? 'none' : 'cached',
        indexError: null,
        today: dateInTimezone(mirror.timezone),
        draft: saved.draft,
        defaultType: saved.defaultType,
        outbox: saved.outbox,
        outboxCount: saved.outbox.length,
        deadLetters: saved.deadLetters,
        recentlyDeleted: localRecoveryRecords(mirror.entriesById, mirror.collectionsById),
        recoveryLoading: false,
        agentTokens: saved.agentTokens ?? [],
        lastReviewSeenAt: saved.lastReviewSeenAt ?? null,
        activitySeenThrough: saved.activitySeenThrough ?? null,
        seenActivityIds: saved.seenActivityIds ?? [],
        monthLogView: hydrateLogView(saved.monthLogView),
        collectionLogView: hydrateLogView(saved.collectionLogView),
        activityHasMore: saved.mirror.activityOrder.length >= 50,
        activityNextCursor:
          saved.mirror.activityById[saved.mirror.activityOrder.at(-1) ?? '']?.at ?? null,
        timelineEntryIds: eligibleTimelineIds(
          mirror,
          saved.timeline?.entryIds ?? [],
          saved.timeline?.anchorDate ?? null,
        ),
        timelineNextCursor: saved.timeline?.nextCursor ?? null,
        timelineAnchorDate: saved.timeline?.anchorDate ?? null,
        timelineLoaded: saved.timeline?.loaded ?? false,
        timelineLoading: false,
        timelineLoadingEarlier: false,
        timelineLatestAgentTouch: saved.timeline?.latestAgentTouch ?? null,
        timelineWeeklyReflection: saved.timeline?.weeklyReflection ?? null,
        hydrated: true,
        loading: networkAvailable,
        resourceStatus: 'ready',
        networkOnline: networkAvailable,
        online: false,
        connectionStatus: networkAvailable ? 'connecting' : 'offline',
        authenticationRequired: false,
        persistenceStatus: 'available',
      });
    } else {
      useJournalStore.setState({
        ...initialMirror(),
        indexStatus: 'idle',
        indexSource: 'none',
        indexError: null,
        draft: '',
        defaultType: 'task',
        outbox: [],
        outboxCount: 0,
        deadLetters: [],
        recentlyDeleted: [],
        recoveryLoading: false,
        agentTokens: [],
        lastReviewSeenAt: null,
        activitySeenThrough: null,
        seenActivityIds: [],
        monthLogView: null,
        collectionLogView: null,
        activityHasMore: false,
        activityNextCursor: null,
        timelineEntryIds: [],
        timelineNextCursor: null,
        timelineAnchorDate: null,
        timelineLoaded: false,
        timelineLoading: false,
        timelineLoadingEarlier: false,
        timelineLatestAgentTouch: null,
        timelineWeeklyReflection: null,
        hydrated: true,
        loading: networkAvailable,
        resourceStatus: networkAvailable ? 'loading' : 'ready',
        networkOnline: networkAvailable,
        online: false,
        connectionStatus: networkAvailable ? 'connecting' : 'offline',
        authenticationRequired: false,
        persistenceStatus: 'available',
      });
    }

    unsubscribePwa = subscribePwaRegistration((pwaState) => {
      if (generation === lifecycleGeneration) useJournalStore.setState(pwaState);
    });
    observePwaOperation(registerJournalServiceWorker);

    attachLifecycle();
    if (networkAvailable) {
      await connectAuthenticatedJournal(generation);
    } else {
      sseReplayReady = false;
      useJournalStore.setState({
        loading: false,
        resourceStatus: 'ready',
        connectionStatus: 'offline',
      });
      if (useJournalStore.getState().outbox.length > 0) scheduleOutboxRetry();
    }
  })()
    .catch((error: unknown) => {
      if (generation !== lifecycleGeneration) return;
      if (initialization === operation) initialization = null;
      sseReplayReady = false;
      useJournalStore.setState((state) => ({
        hydrated: true,
        loading: false,
        resourceStatus: state.resourceStatus === 'loading' ? 'error' : state.resourceStatus,
        online: false,
        connectionStatus: 'error',
      }));
      addErrorNotice('Journal could not start.', error);
      if (!pairingExpired) scheduleReconnectRetry(!useJournalStore.getState().cursor);
      if (useJournalStore.getState().outbox.length > 0) scheduleOutboxRetry();
    })
    .finally(() => {
      if (startupConnectionGeneration === generation) {
        startupConnectionGeneration = null;
        const shouldReconnect = deferredStartupReconnect;
        deferredStartupReconnect = false;
        if (shouldReconnect && generation === lifecycleGeneration && !pairingExpired) {
          requestAuthenticatedReconnect(generation);
        }
      }
      if (initialization === operation && generation !== lifecycleGeneration) {
        initialization = null;
      }
    });
  initialization = operation;
  return operation;
}

function attachLifecycle(): void {
  if (removeLifecycleListeners) return;
  const onOnline = (): void => {
    resetReconnectRetry();
    useJournalStore.setState({
      networkOnline: true,
      online: false,
      connectionStatus: pairingExpired ? 'error' : 'connecting',
    });
    if (!pairingExpired) requestAuthenticatedReconnect();
    observePwaOperation(checkForJournalUpdate);
  };
  const onOffline = (): void => {
    sseReplayReady = false;
    useJournalStore.setState({
      networkOnline: false,
      online: false,
      connectionStatus: 'offline',
      loading: false,
      resourceStatus: 'ready',
    });
    sse?.pause('offline');
    if (useJournalStore.getState().outbox.length > 0) scheduleOutboxRetry();
  };
  const onResume = (): void => {
    if (document.visibilityState !== 'visible') return;
    const changedDay = recomputeJournalToday();
    useJournalStore.setState({
      networkOnline: navigator.onLine,
      ...(navigator.onLine ? {} : { online: false }),
    });
    midnightScheduler?.reschedule();
    if (changedDay) void persistNow();
    if (navigator.onLine) {
      requestAuthenticatedReconnect();
      observePwaOperation(checkForJournalUpdate);
    } else if (useJournalStore.getState().outbox.length > 0) {
      scheduleOutboxRetry();
    }
  };
  const onHidden = (): void => {
    if (document.visibilityState === 'hidden') {
      sseReplayReady = false;
      void flushJournalPersistence().catch((error: unknown) =>
        addErrorNotice('Local journal storage failed.', error),
      );
      sse?.pause('offline');
    } else onResume();
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  window.addEventListener('pageshow', onResume);
  document.addEventListener('visibilitychange', onHidden);
  midnightScheduler = createMidnightScheduler(
    () => {
      const state = useJournalStore.getState();
      const today = dateInTimezone(state.timezone);
      if (today !== state.today) {
        useJournalStore.setState({ today });
        void persistNow();
      }
      if (state.networkOnline) requestAuthenticatedReconnect();
    },
    () => useJournalStore.getState().timezone,
  );
  removeLifecycleListeners = () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('pageshow', onResume);
    document.removeEventListener('visibilitychange', onHidden);
    midnightScheduler?.stop();
    midnightScheduler = null;
    removeLifecycleListeners = null;
  };
}

function shutdownJournal(): void {
  const restoredCanonicalHistory = restoreCanonicalHistoryRollback();
  lifecycleGeneration += 1;
  timelineRequestSequence += 1;
  pairingExpired = false;
  replayAuthenticationGeneration = null;
  startupConnectionGeneration = null;
  deferredStartupReconnect = false;
  canonicalHistoryHydrationGeneration = null;
  activeResetSequence = null;
  sseReplayReady = true;
  if (persistenceTimer !== undefined || restoredCanonicalHistory) {
    void flushJournalPersistence().catch(() => undefined);
  }
  if (retryTimer !== undefined) window.clearTimeout(retryTimer);
  retryTimer = undefined;
  retryDelay = 1_000;
  if (assistantBurstTimer !== undefined) window.clearTimeout(assistantBurstTimer);
  assistantBurstTimer = undefined;
  assistantBurstCount = 0;
  resetReconnectRetry();
  cancelReconnectDeadline?.();
  sse?.stop();
  sse = null;
  removeLifecycleListeners?.();
  unsubscribePwa?.();
  unsubscribePwa = null;
  initialization = null;
  reconnecting = null;
  authenticatedConnecting = null;
  pendingReconnect = null;
  flushing = null;
  activeOutboxMutationId = null;
  clearRecoveryMutationIds();
  authenticationProbe = null;
  useJournalStore.setState({
    syncing: false,
    activityLoading: false,
    tokensLoading: false,
    authenticationRequired: false,
    recoveryLoading: false,
    timelineLoading: false,
    timelineLoadingEarlier: false,
  });
}

export const useJournalStore: UseBoundStore<StoreApi<JournalState>> = create<JournalState>()(
  (set, get) => ({
    ...initialMirror(),
    index: null,
    indexStatus: 'idle',
    indexSource: 'none',
    indexError: null,
    hydrated: false,
    loading: true,
    resourceStatus: 'loading',
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    networkOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
    connectionStatus:
      typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'connecting',
    authenticationRequired: false,
    persistenceStatus: 'available',
    syncing: false,
    draft: '',
    defaultType: 'task',
    outbox: [],
    outboxCount: 0,
    deadLetters: [],
    recentlyDeleted: [],
    recoveryLoading: false,
    notices: [],
    updateReady: false,
    offlineReady: false,
    agentTokens: [],
    tokensLoading: false,
    activityLoading: false,
    activityHasMore: false,
    activityNextCursor: null,
    timelineEntryIds: [],
    timelineNextCursor: null,
    timelineAnchorDate: null,
    timelineLoaded: false,
    timelineLoading: false,
    timelineLoadingEarlier: false,
    timelineLatestAgentTouch: null,
    timelineWeeklyReflection: null,
    tagSuggestions: [],
    tagsFetchedAt: null,
    lastReviewSeenAt: null,
    activitySeenThrough: null,
    seenActivityIds: [],
    monthLogView: null,
    collectionLogView: null,
    initialize: initializeJournal,
    shutdown: shutdownJournal,
    ...createActivityEnrichmentActions({
      runtime: {
        get,
        set,
        lifecycleGeneration: () => lifecycleGeneration,
        sseGeneration: () => sseGeneration,
        pairingExpired: () => pairingExpired,
        authenticated,
        requireOnline,
        persistNow,
        persistSoon,
      },
      reconcileTimelineMembership,
      refreshCanonicalLatestSummary,
    }),
    setMonthLogView: (config) => {
      set({ monthLogView: config });
      persistSoon();
    },
    setCollectionLogView: (config) => {
      set({ collectionLogView: config });
      persistSoon();
    },
    setDraft: (draft) => {
      set({ draft });
      persistSoon();
    },
    setDefaultType: (defaultType) => {
      set({ defaultType });
      persistSoon();
    },
    createEntry: async (input) => {
      const state = get();
      const at = new Date().toISOString();
      const context = createCaptureContext(state, input, at);
      const id = input.id ?? createUlid();
      const entry: Entry = {
        id,
        date: context.targetDate,
        type: input.type,
        text: input.text.trim(),
        state: initialEntryState(input.type),
        time: input.time ?? null,
        tags: [...new Set(input.tags ?? [])],
        author: 'me',
        source: null,
        migrations: 0,
        collection: input.collection ?? null,
        createdAt: at,
        updatedAt: at,
        revision: 1,
        deletedAt: null,
      };
      await enqueueCommand({
        kind: 'entry.create',
        at,
        entry,
        input: {
          id,
          text: entry.text,
          type: entry.type,
          time: entry.time,
          tags: entry.tags,
          collection: entry.collection,
          dateIntent: context.dateIntent,
        },
      });
      return entry;
    },
    updateEntry: async (id, inputPatch) => {
      const entry = requireEntry(id);
      const patch = normalizePatch(entry, inputPatch);
      const at = new Date().toISOString();
      const command: QueueableCommand = {
        kind: 'entry.update',
        id,
        patch,
        expectedRevision: entry.revision,
        at,
      };
      await enqueueCommand(command);
      return useJournalStore.getState().entriesById[id] ?? entry;
    },
    ...createRecoveryActions({
      runtime: {
        get,
        set,
        lifecycleGeneration: () => lifecycleGeneration,
        sseGeneration: () => sseGeneration,
        pairingExpired: () => pairingExpired,
        authenticated,
        requireOnline,
        persistNow,
        persistSoon,
      },
      enqueueCommand,
      activeOutboxMutationId: () => activeOutboxMutationId,
      flushing: () => flushing,
      timelineIdsWithRestoredEntry,
    }),
    toggleEntry: async (id) => {
      const entry = requireEntry(id);
      if (entry.type !== 'task' && entry.type !== 'habit')
        throw new Error('Only tasks and habits can be toggled.');
      if (entry.state !== 'open' && entry.state !== 'done')
        throw new Error('This entry is no longer toggleable.');
      return get().updateEntry(id, { state: entry.state === 'open' ? 'done' : 'open' });
    },
    migrateEntry: async (id, target) => {
      const entry = requireEntry(id);
      if ((entry.type !== 'task' && entry.type !== 'habit') || entry.state !== 'open') {
        throw new Error('Only open tasks and habits can be moved forward.');
      }
      const at = new Date().toISOString();
      const copy: Entry = {
        ...entry,
        id: createUlid(),
        date: target ?? get().today,
        state: 'open',
        collection: null,
        migrations: entry.migrations + 1,
        createdAt: at,
        updatedAt: at,
        revision: 1,
        deletedAt: null,
      };
      await enqueueCommand({
        kind: 'entry.migrate',
        id,
        target: copy.date,
        expectedRevision: entry.revision,
        copy,
        at,
      });
      return copy;
    },
    scheduleEntry: async (id, requestedMonth) => {
      const entry = requireEntry(id);
      if ((entry.type !== 'task' && entry.type !== 'habit') || entry.state !== 'open') {
        throw new Error('Only open tasks and habits can be scheduled.');
      }
      const month = requestedMonth ?? get().today.slice(0, 7);
      const at = new Date().toISOString();
      const collectionId = `month:${month}`;
      const copy: Entry = {
        ...entry,
        id: createUlid(),
        date: get().today,
        state: 'open',
        collection: collectionId,
        migrations: entry.migrations,
        createdAt: at,
        updatedAt: at,
        revision: 1,
        deletedAt: null,
      };
      const collection: Collection = get().collectionsById[collectionId] ?? {
        id: collectionId,
        name: new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
          new Date(`${month}-01T12:00:00`),
        ),
        note: 'Monthly log',
        createdAt: at,
        archivedAt: null,
      };
      await enqueueCommand({
        kind: 'entry.schedule',
        id,
        month,
        expectedRevision: entry.revision,
        copy,
        collection,
        at,
      });
      return copy;
    },
    createCollection: async (input) => {
      const at = new Date().toISOString();
      const collection: Collection = {
        id: input.id,
        name: input.name.trim(),
        note: input.note?.trim() || null,
        createdAt: at,
        archivedAt: null,
      };
      await enqueueCommand({ kind: 'collection.create', collection, at });
      return collection;
    },
    updateCollection: async (id, patch) => {
      const current = get().collectionsById[id];
      if (!current) throw new Error('Collection no longer exists.');
      await enqueueCommand({
        kind: 'collection.update',
        id,
        patch,
        at: new Date().toISOString(),
      });
      return useJournalStore.getState().collectionsById[id] ?? current;
    },
    ...createSettingsPairingActions({
      get,
      set,
      lifecycleGeneration: () => lifecycleGeneration,
      sseGeneration: () => sseGeneration,
      pairingExpired: () => pairingExpired,
      authenticated,
      requireOnline,
      persistNow,
      persistSoon,
    }),
    ...createTimelineRetrievalActions({
      runtime: {
        get,
        set,
        lifecycleGeneration: () => lifecycleGeneration,
        sseGeneration: () => sseGeneration,
        pairingExpired: () => pairingExpired,
        authenticated,
        requireOnline,
        persistNow,
        persistSoon,
      },
      sseReplayReady: () => sseReplayReady,
      canonicalHistoryHydrating: () => canonicalHistoryHydrationGeneration !== null,
      nextTimelineRequest: () => ++timelineRequestSequence,
      timelineRequestIsCurrent: (request) => request === timelineRequestSequence,
      loadCanonicalMonthSummary,
    }),
    retryDeadLetter: async (id) => {
      const lifecycle = lifecycleGeneration;
      const deadLetter = get().deadLetters.find((item) => item.id === id);
      if (!deadLetter) return;
      const command = rebaseCommand(deadLetter.item.command, get());
      const item = descriptorForCommand(command);
      set((state) => {
        const outbox = [...state.outbox, item];
        const mirror = recomputeActivityRevertEligibility(
          applyOptimisticCommand(mirrorFromState(state), command),
        );
        return {
          ...mirror,
          deadLetters: state.deadLetters.filter((letter) => letter.id !== id),
          outbox,
          outboxCount: outbox.length,
        };
      });
      await persistNow();
      if (lifecycle === lifecycleGeneration) void flushOutbox();
    },
    discardDeadLetter: async (id) => {
      set((state) => ({ deadLetters: state.deadLetters.filter((letter) => letter.id !== id) }));
      await persistNow();
    },
    dismissNotice: (id) =>
      set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) })),
    activateUpdate: async () => {
      const lifecycle = lifecycleGeneration;
      await flushJournalPersistence();
      if (lifecycle === lifecycleGeneration) activateJournalUpdate();
    },
    composerPreset: null,
    // Never persisted: a preset is a gesture from the screen the owner is
    // looking at now, not a preference that should survive a reload.
    focusComposer: (destination) => {
      set((state) => ({
        composerPreset: {
          destination: destination ?? null,
          nonce: (state.composerPreset?.nonce ?? 0) + 1,
        },
      }));
    },
  }),
);

export const journalActions = {
  initialize: (): Promise<void> => useJournalStore.getState().initialize(),
  shutdown: (): void => useJournalStore.getState().shutdown(),
  createEntry: (input: CreateEntryInput): Promise<Entry> =>
    useJournalStore.getState().createEntry(input),
  updateEntry: (id: string, patch: EntryPatch): Promise<Entry> =>
    useJournalStore.getState().updateEntry(id, patch),
  deleteEntry: (id: string): Promise<void> => useJournalStore.getState().deleteEntry(id),
  restoreEntry: (id: string): Promise<RestoreResult> => useJournalStore.getState().restoreEntry(id),
  loadRecovery: (): Promise<void> => useJournalStore.getState().loadRecovery(),
  toggleEntry: (id: string): Promise<Entry> => useJournalStore.getState().toggleEntry(id),
  migrateEntry: (id: string, target?: string): Promise<Entry> =>
    useJournalStore.getState().migrateEntry(id, target),
  scheduleEntry: (id: string, month?: string): Promise<Entry> =>
    useJournalStore.getState().scheduleEntry(id, month),
  createCollection: (input: {
    id: string;
    name: string;
    note?: string | null;
  }): Promise<Collection> => useJournalStore.getState().createCollection(input),
  updateCollection: (
    id: string,
    patch: { name?: string; note?: string | null; archived?: boolean },
  ): Promise<Collection> => useJournalStore.getState().updateCollection(id, patch),
  saveSummary: (id?: string): Promise<Summary> => useJournalStore.getState().saveSummary(id),
  rewriteSummary: (id?: string): Promise<Summary> => useJournalStore.getState().rewriteSummary(id),
  loadReflections: (): Promise<Reflection[]> => useJournalStore.getState().loadReflections(),
  requestReflection: (id: string): Promise<Reflection> =>
    useJournalStore.getState().requestReflection(id),
  retryReflection: (id: string): Promise<Reflection> =>
    useJournalStore.getState().retryReflection(id),
  restoreReflectionVersion: (id: string, versionId: string): Promise<Reflection> =>
    useJournalStore.getState().restoreReflectionVersion(id, versionId),
  revertActivity: (id: string): Promise<ActivityView> =>
    useJournalStore.getState().revertActivity(id),
  updateSettings: (
    patch: Partial<
      Pick<Settings, 'density' | 'showTypeBadges' | 'highlightAiEntries' | 'savedViews'>
    >,
  ): Promise<Settings> => useJournalStore.getState().updateSettings(patch),
  setDraft: (draft: string): void => useJournalStore.getState().setDraft(draft),
  markActivityVisible: (ids: readonly string[]): void =>
    useJournalStore.getState().markActivityVisible(ids),
  markAllActivitySeen: (): void => useJournalStore.getState().markAllActivitySeen(),
  markReviewSeen: (): void => useJournalStore.getState().markReviewSeen(),
  setMonthLogView: (config: LogViewConfig | null): void =>
    useJournalStore.getState().setMonthLogView(config),
  setCollectionLogView: (config: LogViewConfig | null): void =>
    useJournalStore.getState().setCollectionLogView(config),
  setDefaultType: (type: EntryType): void => useJournalStore.getState().setDefaultType(type),
  searchEntries: (query: string, cursor?: string): Promise<JournalSearchPage> =>
    useJournalStore.getState().searchEntries(query, cursor),
  loadEntry: (id: string): Promise<Entry> => useJournalStore.getState().loadEntry(id),
  loadEntries: (query: LoadEntriesQuery): Promise<Entry[]> =>
    useJournalStore.getState().loadEntries(query),
  loadTimeline: (anchorDate?: string | null): Promise<Entry[]> =>
    useJournalStore.getState().loadTimeline(anchorDate),
  loadEarlierTimeline: (): Promise<Entry[]> => useJournalStore.getState().loadEarlierTimeline(),
  loadIndex: (): Promise<IndexResponse> => useJournalStore.getState().loadIndex(),
  loadDate: (date: string): Promise<Entry[]> => useJournalStore.getState().loadDate(date),
  loadMonth: (month: string): Promise<Entry[]> => useJournalStore.getState().loadMonth(month),
  loadCollection: (id: string): Promise<Entry[]> => useJournalStore.getState().loadCollection(id),
  loadMoreActivity: (): Promise<void> => useJournalStore.getState().loadMoreActivity(),
  loadTagSuggestions: (): Promise<void> => useJournalStore.getState().loadTagSuggestions(),
  retryDeadLetter: (id: string): Promise<void> => useJournalStore.getState().retryDeadLetter(id),
  discardDeadLetter: (id: string): Promise<void> =>
    useJournalStore.getState().discardDeadLetter(id),
  refreshTokens: (): Promise<void> => useJournalStore.getState().refreshTokens(),
  createToken: (label: string): Promise<{ token: AgentToken; secret: string }> =>
    useJournalStore.getState().createToken(label),
  revokeToken: (id: string): Promise<void> => useJournalStore.getState().revokeToken(id),
  activateUpdate: (): Promise<void> => useJournalStore.getState().activateUpdate(),
  focusComposer: (destination?: Destination): void =>
    useJournalStore.getState().focusComposer(destination),
  flush: flushOutbox,
  reconnect: (): Promise<void> => reconnectJournal(),
  retryLocalSave: async (): Promise<void> => {
    await persistNow();
    await flushOutbox();
  },
};

export { selectJournalStatus };

export {
  parseJournalSearch,
  selectActiveCollections,
  selectCollections,
  selectEntries,
  selectOpenTodayCount,
  selectTimelineEntries,
};
export {
  deriveTagUsage,
  mergeTagUsage,
  selectActivity,
  selectHasUnseenActivity,
  selectLatestAgentTouches,
  selectUnseenActivityCount,
  selectUnseenActivityIds,
  selectUnseenReviewCount,
};
export const selectEntriesForDate =
  (date: string) =>
  (state: JournalState): Entry[] =>
    (state.entryIdsByDate[date] ?? []).flatMap((id) => {
      const entry = state.entriesById[id];
      return entry ? [entry] : [];
    });
export const selectCollectionEntries =
  (collectionId: string) =>
  (state: JournalState): Entry[] =>
    (state.entryIdsByCollection[collectionId] ?? []).flatMap((id) => {
      const entry = state.entriesById[id];
      return entry ? [entry] : [];
    });
