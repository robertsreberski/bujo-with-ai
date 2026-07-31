import { ActivitySnapshotSchema, initialEntryState } from '@journal/server/contracts/app';
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
  EntryState,
  EntryType,
  DateIntent,
  Settings,
  Summary,
  TagUsage,
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
import { createUlid } from './ids';
import type {
  ConnectionStatus,
  CreateEntryInput,
  DeadLetter,
  JournalClientRecord,
  JournalNotice,
  MirrorData,
  OutboxItem,
  QueueableCommand,
} from './models';
import {
  applyAgentTokenChanges,
  applyOptimisticCommand,
  applyPendingCommands,
  applyServerChangeBatch,
  buildEntryIndexes,
  countNotifiableChanges,
  mergeAgentToken,
  recomputeActivityRevertEligibility,
  removeServerCollection,
  removeServerEntry,
  removeServerSummary,
  upsertActivity,
  upsertServerCollection,
  upsertServerEntry,
  upsertServerSettings,
  upsertServerSummary,
} from './optimistic';
import { SingleRecordPersistence } from './persistence';
import { JournalSseClient, SseReplayResetError } from './sse-client';

export type {
  ConnectionStatus,
  CreateEntryInput,
  DeadLetter,
  JournalNotice,
  OutboxItem,
} from './models';
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
} from '../api/types';

const EPOCH = '1970-01-01T00:00:00.000Z';
const PAIRING_EXPIRED_MESSAGE =
  'Pairing expired. Reload Journal to reconnect; queued changes are safe.';
const DEFAULT_SETTINGS: Settings = {
  density: 'comfortable',
  showTypeBadges: true,
  highlightAiEntries: true,
  updatedAt: EPOCH,
};

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

function initialMirror(): MirrorData {
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
    settings: DEFAULT_SETTINGS,
    mcpStatus: null,
    today,
    serverToday: today,
    timezone,
    cursor: null,
    deviceId: null,
  };
}

export interface JournalState extends MirrorData {
  hydrated: boolean;
  loading: boolean;
  /** Journal endpoint reachability, used by the UI's offline affordance. */
  online: boolean;
  /** Browser network signal, used only to decide whether retries can run. */
  networkOnline: boolean;
  connectionStatus: ConnectionStatus;
  syncing: boolean;
  draft: string;
  defaultType: EntryType;
  outbox: OutboxItem[];
  outboxCount: number;
  deadLetters: DeadLetter[];
  notices: JournalNotice[];
  updateReady: boolean;
  offlineReady: boolean;
  agentTokens: AgentToken[];
  tokensLoading: boolean;
  activityLoading: boolean;
  activityHasMore: boolean;
  activityNextCursor: string | null;
  /** Capture tag vocabulary; in-memory only, never part of the persisted record. */
  tagSuggestions: TagUsage[];
  tagsFetchedAt: string | null;
  initialize(): Promise<void>;
  shutdown(): void;
  setDraft(draft: string): void;
  setDefaultType(type: EntryType): void;
  createEntry(input: CreateEntryInput): Promise<Entry>;
  updateEntry(id: string, patch: EntryPatch): Promise<Entry>;
  deleteEntry(id: string): Promise<void>;
  toggleEntry(id: string): Promise<Entry>;
  migrateEntry(id: string, target?: string): Promise<Entry>;
  scheduleEntry(id: string, month?: string): Promise<Entry>;
  createCollection(input: { id: string; name: string; note?: string | null }): Promise<Collection>;
  updateCollection(
    id: string,
    patch: { name?: string; note?: string | null; archived?: boolean },
  ): Promise<Collection>;
  saveSummary(id?: string): Promise<Summary>;
  rewriteSummary(id?: string): Promise<Summary>;
  revertActivity(id: string): Promise<ActivityView>;
  updateSettings(
    patch: Partial<Pick<Settings, 'density' | 'showTypeBadges' | 'highlightAiEntries'>>,
  ): Promise<Settings>;
  searchEntries(query: string): Promise<Entry[]>;
  loadEntries(query: LoadEntriesQuery): Promise<Entry[]>;
  loadDate(date: string): Promise<Entry[]>;
  loadMonth(month: string): Promise<Entry[]>;
  loadCollection(id: string): Promise<Entry[]>;
  loadMoreActivity(): Promise<void>;
  loadTagSuggestions(): Promise<void>;
  retryDeadLetter(id: string): Promise<void>;
  discardDeadLetter(id: string): Promise<void>;
  dismissNotice(id: string): void;
  refreshTokens(): Promise<void>;
  createToken(label: string): Promise<{ token: AgentToken; secret: string }>;
  revokeToken(id: string): Promise<void>;
  activateUpdate(): Promise<void>;
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
let canonicalHistoryRollback: {
  generation: number;
  mirror: MirrorData;
  activityHasMore: boolean;
  activityNextCursor: string | null;
} | null = null;

function mirrorFromState(state: JournalState): MirrorData {
  return {
    entriesById: state.entriesById,
    entryIdsByDate: state.entryIdsByDate,
    entryIdsByCollection: state.entryIdsByCollection,
    collectionsById: state.collectionsById,
    activityById: state.activityById,
    activityOrder: state.activityOrder,
    summariesByMonth: state.summariesByMonth,
    latestSummary: state.latestSummary,
    settings: state.settings,
    mcpStatus: state.mcpStatus,
    today: state.today,
    serverToday: state.serverToday,
    timezone: state.timezone,
    cursor: state.cursor,
    deviceId: state.deviceId,
  };
}

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
  };
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
  return persistence.save(recordFromState(state, stableMirror));
}

function persistCurrentMirror(): Promise<void> {
  if (persistenceTimer !== undefined) window.clearTimeout(persistenceTimer);
  persistenceTimer = undefined;
  const state = useJournalStore.getState();
  return persistence.save(recordFromState(state));
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
  useJournalStore.setState({ connectionStatus: 'connected', loading: false, online: true });
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

function applyServerRows(
  mirror: MirrorData,
  rows: {
    entries?: Entry[];
    collections?: Collection[];
    summary?: Summary;
    activity?: ActivityView;
  },
): MirrorData {
  let next = mirror;
  for (const entry of rows.entries ?? []) next = upsertServerEntry(next, entry);
  for (const collection of rows.collections ?? []) next = upsertServerCollection(next, collection);
  if (rows.summary) next = upsertServerSummary(next, rows.summary);
  if (rows.activity) next = upsertActivity(next, rows.activity);
  return next;
}

export async function applyChangeBatch(
  batch: ChangeBatch,
  cursor: string,
  expectedGeneration = lifecycleGeneration,
): Promise<void> {
  if (expectedGeneration !== lifecycleGeneration || pairingExpired) return;
  sseGeneration += 1;
  const before = useJournalStore.getState();
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
  useJournalStore.setState({
    ...mirror,
    outbox: remaining,
    outboxCount: remaining.length,
    agentTokens,
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

function retainedHistoricalEntries(
  mirror: MirrorData,
  today: string,
  discardedIds: ReadonlySet<string> = new Set(),
): Record<string, Entry> {
  const cutoff = addCalendarDays(today, -13);
  const currentMonth = `month:${today.slice(0, 7)}`;
  return Object.fromEntries(
    Object.entries(mirror.entriesById).filter(([id, entry]) => {
      if (discardedIds.has(id)) return false;
      const inBootstrapWindow =
        entry.date >= cutoff || entry.state === 'open' || entry.collection === currentMonth;
      return !inBootstrapWindow;
    }),
  );
}

async function bootstrapSnapshot(
  allowPair: boolean,
  expectedGeneration: number,
): Promise<Awaited<ReturnType<typeof journalApi.bootstrap>> | null> {
  try {
    return await journalApi.bootstrap();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || !allowPair) throw error;
    if (expectedGeneration !== lifecycleGeneration || pairingExpired) return null;
    const paired = await journalApi.pair();
    const state = useJournalStore.getState();
    useJournalStore.setState({ ...mirrorFromState(state), deviceId: paired.deviceId });
    await persistNow();
    if (expectedGeneration !== lifecycleGeneration || pairingExpired) return null;
    return journalApi.bootstrap();
  }
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
}

async function prepareBootstrapReconciliation(
  options: ReconcileOptions,
): Promise<PreparedBootstrap | null> {
  const generation = options.expectedGeneration ?? lifecycleGeneration;
  const responseGeneration = ++sseGeneration;
  let response: Awaited<ReturnType<typeof journalApi.bootstrap>> | null;
  try {
    response = await bootstrapSnapshot(options.allowPair ?? false, generation);
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
      : retainedHistoricalEntries(mirrorFromState(state), response.today, options.discardEntryIds)),
    ...Object.fromEntries(response.entries.map((entry) => [entry.id, entry])),
  };
  const activityById = {
    ...(options.authoritative ? {} : state.activityById),
    ...Object.fromEntries(response.activity.map((activity) => [activity.id, activity])),
  };
  let base: MirrorData = {
    entriesById,
    ...buildEntryIndexes(entriesById),
    collectionsById: Object.fromEntries(
      response.collections.map((collection) => [collection.id, collection]),
    ),
    activityById,
    activityOrder: Object.values(activityById)
      .sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id))
      .map((activity) => activity.id),
    summariesByMonth: options.authoritative ? {} : state.summariesByMonth,
    latestSummary: options.preserveLatestSummary ? state.latestSummary : null,
    settings: response.settings,
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
  };
}

export async function reconcileFromBootstrap(options: ReconcileOptions = {}): Promise<boolean> {
  const prepared = await prepareBootstrapReconciliation(options);
  if (!prepared) return false;
  useJournalStore.setState({
    ...prepared.mirror,
    loading: false,
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
  await loadEntriesIntoMirror(
    {},
    { persist: false, retryOnChange: false, requireConnection: false },
  );
  if (!resetHydrationIsCurrent(generation, responseGeneration)) return false;

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
        useJournalStore.setState({ connectionStatus: 'offline', loading: false, online: false });
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
        useJournalStore.setState({ connectionStatus: 'offline', loading: false, online: false });
        return;
      }
      useJournalStore.setState({ connectionStatus: 'error', loading: false, online: false });
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
  useJournalStore.setState({ connectionStatus: 'error', loading: false, online: false });
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
    useJournalStore.setState({ connectionStatus: 'error', loading: false, online: false });
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

function descriptorForCommand(command: QueueableCommand, mutationId = createUlid()): OutboxItem {
  switch (command.kind) {
    case 'entry.create':
      return {
        mutationId,
        method: 'POST',
        path: '/api/entries',
        body: command.input,
        enqueuedAt: command.at,
        command,
      };
    case 'entry.update':
      return {
        mutationId,
        method: 'PATCH',
        path: `/api/entries/${command.id}`,
        body: {
          patch: command.patch,
          ...(command.expectedRevision === undefined
            ? {}
            : { expectedRevision: command.expectedRevision }),
        },
        enqueuedAt: command.at,
        command,
      };
    case 'entry.delete':
      return {
        mutationId,
        method: 'DELETE',
        path: `/api/entries/${command.id}`,
        enqueuedAt: command.at,
        command,
      };
    case 'entry.migrate':
      return {
        mutationId,
        method: 'POST',
        path: `/api/entries/${command.id}/migrate`,
        body: {
          newEntryId: command.copy.id,
          target: command.target,
          ...(command.expectedRevision === undefined
            ? {}
            : { expectedRevision: command.expectedRevision }),
        },
        enqueuedAt: command.at,
        command,
      };
    case 'entry.schedule':
      return {
        mutationId,
        method: 'POST',
        path: `/api/entries/${command.id}/schedule`,
        body: {
          copyId: command.copy.id,
          month: command.month,
          ...(command.expectedRevision === undefined
            ? {}
            : { expectedRevision: command.expectedRevision }),
        },
        enqueuedAt: command.at,
        command,
      };
    case 'collection.create':
      return {
        mutationId,
        method: 'POST',
        path: '/api/collections',
        body: {
          id: command.collection.id,
          name: command.collection.name,
          note: command.collection.note,
        },
        enqueuedAt: command.at,
        command,
      };
    case 'collection.update':
      return {
        mutationId,
        method: 'PATCH',
        path: `/api/collections/${command.id}`,
        body: command.patch,
        enqueuedAt: command.at,
        command,
      };
  }
}

function affectedEntryIds(command: QueueableCommand): ReadonlySet<string> {
  switch (command.kind) {
    case 'entry.create':
      return new Set([command.entry.id]);
    case 'entry.update':
    case 'entry.delete':
      return new Set([command.id]);
    case 'entry.migrate':
    case 'entry.schedule':
      return new Set([command.id, command.copy.id]);
    case 'collection.create':
    case 'collection.update':
      return new Set();
  }
}

function affectedCollectionIds(command: QueueableCommand): ReadonlySet<string> {
  switch (command.kind) {
    case 'collection.create':
      return new Set([command.collection.id]);
    case 'collection.update':
      return new Set([command.id]);
    case 'entry.create':
    case 'entry.update':
    case 'entry.delete':
    case 'entry.migrate':
    case 'entry.schedule':
      return new Set();
  }
}

async function enqueueCommand(command: QueueableCommand): Promise<void> {
  const lifecycle = lifecycleGeneration;
  const item = descriptorForCommand(command);
  useJournalStore.setState((state) => {
    const outbox = [...state.outbox, item];
    const mirror = recomputeActivityRevertEligibility(
      applyOptimisticCommand(mirrorFromState(state), command),
    );
    return { ...mirror, outbox, outboxCount: outbox.length };
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

interface ServerRows {
  entries?: Entry[];
  collections?: Collection[];
}

async function sendOutboxItem(item: OutboxItem): Promise<ServerRows> {
  const command = item.command;
  switch (command.kind) {
    case 'entry.create': {
      const response = await journalApi.createEntry(command.input, item.mutationId);
      return { entries: [response.entry] };
    }
    case 'entry.update': {
      const response = await journalApi.updateEntry(
        command.id,
        command.patch,
        item.mutationId,
        command.expectedRevision,
      );
      return { entries: [response.entry] };
    }
    case 'entry.delete': {
      const response = await journalApi.deleteEntry(
        command.id,
        item.mutationId,
        command.expectedRevision,
      );
      return { entries: [response.entry] };
    }
    case 'entry.migrate': {
      const response = await journalApi.migrateEntry(
        command.id,
        {
          newEntryId: command.copy.id,
          target: command.target,
          ...(command.expectedRevision === undefined
            ? {}
            : { expectedRevision: command.expectedRevision }),
        },
        item.mutationId,
      );
      return { entries: [response.original, response.copy] };
    }
    case 'entry.schedule': {
      const response = await journalApi.scheduleEntry(
        command.id,
        {
          copyId: command.copy.id,
          month: command.month,
          ...(command.expectedRevision === undefined
            ? {}
            : { expectedRevision: command.expectedRevision }),
        },
        item.mutationId,
      );
      return {
        entries: [response.original, response.copy],
        ...(response.collection ? { collections: [response.collection] } : {}),
      };
    }
    case 'collection.create': {
      const response = await journalApi.createCollection(
        {
          id: command.collection.id,
          name: command.collection.name,
          note: command.collection.note,
        },
        item.mutationId,
      );
      return { collections: [response.collection] };
    }
    case 'collection.update': {
      const response = await journalApi.updateCollection(
        command.id,
        command.patch,
        item.mutationId,
      );
      return { collections: [response.collection] };
    }
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
  let committed = false;
  useJournalStore.setState((state) => {
    if (!state.outbox.some((candidate) => candidate.mutationId === item.mutationId)) return {};
    committed = true;
    const outbox = state.outbox.filter((candidate) => candidate.mutationId !== item.mutationId);
    return {
      ...prepared.mirror,
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

export interface JournalSearchFilters {
  q?: string;
  type?: EntryType;
  state?: EntryState;
  author?: 'me' | 'ai';
  tag?: string;
}

export interface LoadEntriesQuery extends JournalSearchFilters {
  from?: string;
  to?: string;
  collection?: string;
}

/** Converts the three shipped saved-view aliases into structured API filters. */
export function parseJournalSearch(query: string): JournalSearchFilters {
  const trimmed = query.trim();
  const lowered = trimmed.toLowerCase();
  if (lowered === 'open') return { type: 'task', state: 'open' };
  if (lowered === 'claude') return { author: 'ai' };
  if (/^#[a-z0-9-]+$/i.test(trimmed)) return { tag: trimmed.slice(1).toLowerCase() };

  const filters: JournalSearchFilters = {};
  const remaining: string[] = [];
  for (const token of trimmed.split(/\s+/).filter(Boolean)) {
    const normalized = token.toLowerCase();
    if (normalized === 'is:open') {
      filters.type = 'task';
      filters.state = 'open';
    } else if (normalized === 'by:assistant') {
      filters.author = 'ai';
    } else {
      remaining.push(token);
    }
  }
  if (remaining.length > 0) filters.q = remaining.join(' ');
  return filters;
}

async function loadEntriesIntoMirror(
  query: LoadEntriesQuery,
  options: { persist?: boolean; retryOnChange?: boolean; requireConnection?: boolean } = {},
  attempt = 0,
): Promise<Entry[]> {
  if (options.requireConnection !== false) requireOnline();
  const lifecycle = lifecycleGeneration;
  const responseGeneration = sseGeneration;
  const loaded: Entry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await authenticated(() =>
      journalApi.listEntries({
        ...query,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    if (lifecycle !== lifecycleGeneration) return loaded;
    if (pairingExpired) {
      throw new ApiError(401, 'unauthenticated', 'Pairing expired. Reload Journal to reconnect.');
    }
    if (responseGeneration !== sseGeneration) {
      if (options.retryOnChange !== false && attempt < 3) {
        return loadEntriesIntoMirror(query, options, attempt + 1);
      }
      throw new Error('Journal changed while entries were loading. Please retry.');
    }
    loaded.push(...response.items);
    const nextCursor = response.nextCursor ?? undefined;
    cursor = nextCursor === undefined || seenCursors.has(nextCursor) ? undefined : nextCursor;
    if (cursor !== undefined) seenCursors.add(cursor);
    let mirror = mirrorFromState(useJournalStore.getState());
    for (const entry of response.items) mirror = upsertServerEntry(mirror, entry);
    mirror = recomputeActivityRevertEligibility(
      applyPendingCommands(mirror, useJournalStore.getState().outbox),
    );
    useJournalStore.setState({
      ...mirror,
      today: response.today,
      serverToday: response.today,
      timezone: response.timezone,
      online:
        sseReplayReady &&
        canonicalHistoryHydrationGeneration === null &&
        useJournalStore.getState().connectionStatus === 'connected',
    });
  } while (cursor !== undefined);
  if (lifecycle !== lifecycleGeneration) return loaded;
  if (options.persist !== false) await persistNow();
  return loaded;
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

function summaryForAction(state: JournalState, id?: string): Summary | null {
  if (id === undefined || state.latestSummary?.id === id) return state.latestSummary;
  return Object.values(state.summariesByMonth).find((summary) => summary?.id === id) ?? null;
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

function rebaseCommand(command: QueueableCommand): QueueableCommand {
  const state = useJournalStore.getState();
  const at = new Date().toISOString();
  if (
    command.kind === 'entry.update' ||
    command.kind === 'entry.delete' ||
    command.kind === 'entry.migrate' ||
    command.kind === 'entry.schedule'
  ) {
    const current = state.entriesById[command.id];
    if (current) return { ...command, at, expectedRevision: current.revision };
    const rebased = { ...command, at };
    delete rebased.expectedRevision;
    return rebased;
  }
  return { ...command, at };
}

async function initializeJournal(): Promise<void> {
  if (initialization) return initialization;
  const generation = ++lifecycleGeneration;
  sseReplayReady = false;
  replayAuthenticationGeneration = null;
  startupConnectionGeneration = generation;
  deferredStartupReconnect = false;
  const operation = (async () => {
    const saved = await persistence.load();
    if (generation !== lifecycleGeneration) return;
    const networkAvailable = typeof navigator === 'undefined' ? true : navigator.onLine;
    if (saved?.version === 1) {
      const mirror = recomputeActivityRevertEligibility({
        ...saved.mirror,
        summariesByMonth: saved.mirror.summariesByMonth ?? {},
        serverToday: saved.mirror.serverToday ?? saved.mirror.today,
        ...buildEntryIndexes(saved.mirror.entriesById),
      });
      useJournalStore.setState({
        ...mirror,
        today: dateInTimezone(mirror.timezone),
        draft: saved.draft,
        defaultType: saved.defaultType,
        outbox: saved.outbox,
        outboxCount: saved.outbox.length,
        deadLetters: saved.deadLetters,
        agentTokens: saved.agentTokens ?? [],
        activityHasMore: saved.mirror.activityOrder.length >= 50,
        activityNextCursor:
          saved.mirror.activityById[saved.mirror.activityOrder.at(-1) ?? '']?.at ?? null,
        hydrated: true,
        loading: networkAvailable,
        networkOnline: networkAvailable,
        online: false,
        connectionStatus: networkAvailable ? 'connecting' : 'offline',
      });
    } else {
      useJournalStore.setState({
        ...initialMirror(),
        draft: '',
        defaultType: 'task',
        outbox: [],
        outboxCount: 0,
        deadLetters: [],
        agentTokens: [],
        activityHasMore: false,
        activityNextCursor: null,
        hydrated: true,
        loading: networkAvailable,
        networkOnline: networkAvailable,
        online: false,
        connectionStatus: networkAvailable ? 'connecting' : 'offline',
      });
    }

    unsubscribePwa = subscribePwaRegistration((pwaState) => {
      if (generation === lifecycleGeneration) useJournalStore.setState(pwaState);
    });
    void registerJournalServiceWorker().catch((error: unknown) => {
      if (generation === lifecycleGeneration) addErrorNotice('Offline app setup failed.', error);
    });

    attachLifecycle();
    if (networkAvailable) {
      await connectAuthenticatedJournal(generation);
    } else {
      sseReplayReady = false;
      useJournalStore.setState({ loading: false, connectionStatus: 'offline' });
      if (useJournalStore.getState().outbox.length > 0) scheduleOutboxRetry();
    }
  })()
    .catch((error: unknown) => {
      if (generation !== lifecycleGeneration) return;
      if (initialization === operation) initialization = null;
      sseReplayReady = false;
      useJournalStore.setState({
        hydrated: true,
        loading: false,
        online: false,
        connectionStatus: 'error',
      });
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
    void checkForJournalUpdate();
  };
  const onOffline = (): void => {
    sseReplayReady = false;
    useJournalStore.setState({ networkOnline: false, online: false, connectionStatus: 'offline' });
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
  authenticationProbe = null;
  useJournalStore.setState({ syncing: false, activityLoading: false, tokensLoading: false });
}

/** Tag suggestions refresh at most this often; the mirror covers the gap. */
const TAG_SUGGESTION_TTL_MS = 5 * 60 * 1000;

const sortTagUsage = (usage: TagUsage[]): TagUsage[] =>
  usage.sort((left, right) => right.uses - left.uses || left.tag.localeCompare(right.tag));

/**
 * Counts the tag vocabulary already in the mirror. `lastUsedAt` approximates the
 * server's MAX(created_at) with the newest touching entry's updatedAt, which is
 * close enough to rank suggestions while offline.
 */
export function deriveTagUsage(entriesById: Record<string, Entry>): TagUsage[] {
  const counts = new Map<string, { uses: number; lastUsedAt: string }>();
  for (const entry of Object.values(entriesById)) {
    if (entry.deletedAt !== null) continue;
    for (const tag of new Set(entry.tags)) {
      const current = counts.get(tag);
      if (current === undefined) {
        counts.set(tag, { uses: 1, lastUsedAt: entry.updatedAt });
        continue;
      }
      current.uses += 1;
      if (entry.updatedAt > current.lastUsedAt) current.lastUsedAt = entry.updatedAt;
    }
  }
  return sortTagUsage(
    [...counts].map(([tag, usage]) => ({ tag, uses: usage.uses, lastUsedAt: usage.lastUsedAt })),
  );
}

/**
 * Unions both vocabularies by tag. The server owns `uses` for tags it knows —
 * the mirror only holds downloaded slices — while tags it has never seen (an
 * optimistic capture still in the outbox) keep their local counts.
 */
export function mergeTagUsage(
  mirrorUsage: readonly TagUsage[],
  serverUsage: readonly TagUsage[],
): TagUsage[] {
  const merged = new Map<string, TagUsage>(mirrorUsage.map((usage) => [usage.tag, usage]));
  for (const row of serverUsage) {
    const local = merged.get(row.tag);
    merged.set(
      row.tag,
      local === undefined
        ? row
        : {
            tag: row.tag,
            uses: row.uses,
            lastUsedAt: local.lastUsedAt > row.lastUsedAt ? local.lastUsedAt : row.lastUsedAt,
          },
    );
  }
  return sortTagUsage([...merged.values()]);
}

export const useJournalStore: UseBoundStore<StoreApi<JournalState>> = create<JournalState>()(
  (set, get) => ({
    ...initialMirror(),
    hydrated: false,
    loading: true,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    networkOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
    connectionStatus:
      typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'connecting',
    syncing: false,
    draft: '',
    defaultType: 'task',
    outbox: [],
    outboxCount: 0,
    deadLetters: [],
    notices: [],
    updateReady: false,
    offlineReady: false,
    agentTokens: [],
    tokensLoading: false,
    activityLoading: false,
    activityHasMore: false,
    activityNextCursor: null,
    tagSuggestions: [],
    tagsFetchedAt: null,
    initialize: initializeJournal,
    shutdown: shutdownJournal,
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
    deleteEntry: async (id) => {
      const entry = requireEntry(id);
      await enqueueCommand({
        kind: 'entry.delete',
        id,
        expectedRevision: entry.revision,
        at: new Date().toISOString(),
      });
    },
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
    saveSummary: async (id) => {
      requireOnline();
      const lifecycle = lifecycleGeneration;
      const target = summaryForAction(get(), id);
      if (id !== undefined && target === null) throw new Error('Summary no longer exists.');
      const generation = sseGeneration;
      const response = await authenticated(() =>
        journalApi.saveLatestSummary({
          ...(id === undefined ? {} : { summaryId: id }),
          ...(target === null ? {} : { expectedRevision: target.revision }),
        }),
      );
      if (lifecycle === lifecycleGeneration && generation === sseGeneration) {
        let mirror = mirrorFromState(get());
        mirror = upsertServerEntry(mirror, response.entry);
        mirror = upsertServerSummary(mirror, response.summary);
        set(recomputeActivityRevertEligibility(mirror));
        await persistNow();
      }
      return response.summary;
    },
    rewriteSummary: async (id) => {
      requireOnline();
      const lifecycle = lifecycleGeneration;
      const target = summaryForAction(get(), id);
      if (id !== undefined && target === null) throw new Error('Summary no longer exists.');
      const generation = sseGeneration;
      const response = await authenticated(() =>
        journalApi.rewriteLatestSummary({
          ...(id === undefined ? {} : { summaryId: id }),
          ...(target === null ? {} : { expectedRevision: target.revision }),
        }),
      );
      if (lifecycle === lifecycleGeneration && generation === sseGeneration) {
        set(upsertServerSummary(mirrorFromState(get()), response.summary));
        await persistNow();
      }
      return response.summary;
    },
    revertActivity: async (id) => {
      requireOnline();
      const lifecycle = lifecycleGeneration;
      const generation = sseGeneration;
      const response = await authenticated(() => journalApi.revertActivity(id));
      if (lifecycle !== lifecycleGeneration || generation !== sseGeneration) {
        return response.activity;
      }
      let mirror = mirrorFromState(get());
      let removedLatestSummary = false;
      for (const rawSnapshot of response.rows) {
        const parsed = ActivitySnapshotSchema.safeParse(rawSnapshot);
        if (!parsed.success) continue;
        const snapshot = parsed.data;
        if (snapshot.entity === 'entry') {
          if (snapshot.row) {
            mirror = upsertServerEntry(mirror, snapshot.row);
          } else {
            mirror = removeServerEntry(mirror, snapshot.id);
          }
        } else if (snapshot.entity === 'collection') {
          if (snapshot.row) {
            mirror = upsertServerCollection(mirror, snapshot.row);
          } else {
            mirror = removeServerCollection(mirror, snapshot.id);
          }
        } else if (snapshot.row) {
          mirror = upsertServerSummary(mirror, snapshot.row);
        } else {
          removedLatestSummary ||= mirror.latestSummary?.id === snapshot.id;
          mirror = removeServerSummary(mirror, snapshot.id);
        }
      }
      const original = mirror.activityById[id];
      if (original) {
        mirror = {
          ...mirror,
          activityById: {
            ...mirror.activityById,
            [id]: { ...original, revert: { eligible: false, reason: 'already_reverted' } },
          },
        };
      }
      mirror = upsertActivity(mirror, response.activity);
      set(recomputeActivityRevertEligibility(mirror));
      await persistNow();
      if (removedLatestSummary) void refreshCanonicalLatestSummary();
      return response.activity;
    },
    updateSettings: async (patch) => {
      requireOnline();
      const lifecycle = lifecycleGeneration;
      const generation = sseGeneration;
      const response = await authenticated(() => journalApi.updateSettings(patch));
      if (lifecycle !== lifecycleGeneration || generation !== sseGeneration || pairingExpired) {
        return response.settings;
      }
      const mirror = upsertServerSettings(mirrorFromState(get()), response.settings);
      set({ ...mirror, mcpStatus: response.assistant });
      await persistNow();
      return response.settings;
    },
    searchEntries: async (query) => {
      const filters = parseJournalSearch(query);
      const normalized = filters.q?.toLowerCase() ?? '';
      const local = Object.values(get().entriesById)
        .filter(
          (entry) =>
            entry.deletedAt === null &&
            (filters.type === undefined || entry.type === filters.type) &&
            (filters.state === undefined || entry.state === filters.state) &&
            (filters.author === undefined || entry.author === filters.author) &&
            (filters.tag === undefined || entry.tags.includes(filters.tag)) &&
            (!normalized ||
              entry.text.toLowerCase().includes(normalized) ||
              entry.tags.some((tag) => tag.includes(normalized.replace(/^#/, '')))),
        )
        .sort(
          (left, right) =>
            right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt),
        );
      if (query.trim() === '') return local;
      if (!get().online)
        throw new ApiError(0, 'offline', 'Search is limited to downloaded entries.');
      return loadEntriesIntoMirror(filters);
    },
    loadEntries: loadEntriesIntoMirror,
    loadDate: (date) => loadEntriesIntoMirror({ from: date, to: date }),
    loadMonth: async (month) => {
      const lifecycle = lifecycleGeneration;
      const [year, monthNumber] = month.split('-').map(Number);
      if (!year || !monthNumber || monthNumber < 1 || monthNumber > 12) {
        throw new Error('Invalid calendar month.');
      }
      const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
      const [daily, monthlyLog] = await Promise.all([
        loadEntriesIntoMirror({
          from: `${month}-01`,
          to: `${month}-${String(lastDay).padStart(2, '0')}`,
        }),
        loadEntriesIntoMirror({ collection: `month:${month}` }),
      ]);
      const loaded = [
        ...new Map([...daily, ...monthlyLog].map((entry) => [entry.id, entry])).values(),
      ];
      if (lifecycle !== lifecycleGeneration) return loaded;
      if (pairingExpired) {
        throw new ApiError(401, 'unauthenticated', 'Pairing expired. Reload Journal to reconnect.');
      }
      await loadCanonicalMonthSummary(month, lifecycle);
      return loaded;
    },
    loadCollection: (id) => loadEntriesIntoMirror({ collection: id }),
    loadMoreActivity: async () => {
      const lifecycle = lifecycleGeneration;
      const state = get();
      if (!state.online || state.activityLoading || !state.activityHasMore) return;
      const before =
        state.activityNextCursor ?? state.activityById[state.activityOrder.at(-1) ?? '']?.at;
      if (!before) {
        set({ activityHasMore: false });
        return;
      }
      set({ activityLoading: true });
      try {
        const generation = sseGeneration;
        const response = await authenticated(() => journalApi.listActivity(before, 50));
        if (lifecycle !== lifecycleGeneration || generation !== sseGeneration) return;
        let mirror = mirrorFromState(get());
        for (const activity of response.items) mirror = upsertActivity(mirror, activity);
        mirror = recomputeActivityRevertEligibility(mirror);
        set({
          ...mirror,
          activityHasMore: response.nextCursor !== null,
          activityNextCursor: response.nextCursor,
        });
        await persistNow();
      } finally {
        if (lifecycle === lifecycleGeneration) set({ activityLoading: false });
      }
    },
    loadTagSuggestions: async () => {
      const state = get();
      // The mirror answers instantly and offline; the server refresh is a bonus.
      set({ tagSuggestions: deriveTagUsage(state.entriesById) });
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      const fresh =
        state.tagsFetchedAt !== null &&
        Date.parse(new Date().toISOString()) - Date.parse(state.tagsFetchedAt) <
          TAG_SUGGESTION_TTL_MS;
      if (!online || fresh) return;
      const lifecycle = lifecycleGeneration;
      try {
        const response = await journalApi.listTags();
        if (lifecycle !== lifecycleGeneration) return;
        set((current) => ({
          // Re-derive: captures may have landed while the request was in flight.
          tagSuggestions: mergeTagUsage(deriveTagUsage(current.entriesById), response.items),
          tagsFetchedAt: new Date().toISOString(),
        }));
      } catch {
        // Suggestions are best-effort; the mirror-derived list already shipped.
      }
    },
    retryDeadLetter: async (id) => {
      const lifecycle = lifecycleGeneration;
      const deadLetter = get().deadLetters.find((item) => item.id === id);
      if (!deadLetter) return;
      const command = rebaseCommand(deadLetter.item.command);
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
    refreshTokens: async () => {
      requireOnline();
      const lifecycle = lifecycleGeneration;
      const generation = sseGeneration;
      set({ tokensLoading: true });
      try {
        const [tokenResponse, settingsResponse] = await authenticated(() =>
          Promise.all([journalApi.listTokens(), journalApi.getSettings()]),
        );
        if (lifecycle !== lifecycleGeneration || pairingExpired) return;
        const tokensById = new Map(get().agentTokens.map((token) => [token.id, token]));
        for (const token of tokenResponse.tokens) {
          const current = tokensById.get(token.id);
          tokensById.set(token.id, current ? mergeAgentToken(current, token) : token);
        }
        const settingsAreCurrent = generation === sseGeneration;
        const mirror = settingsAreCurrent
          ? upsertServerSettings(mirrorFromState(get()), settingsResponse.settings)
          : null;
        set({
          ...(mirror ?? {}),
          agentTokens: [...tokensById.values()],
          ...(settingsAreCurrent ? { mcpStatus: settingsResponse.assistant } : {}),
        });
        await persistNow();
      } finally {
        if (lifecycle === lifecycleGeneration) set({ tokensLoading: false });
      }
    },
    createToken: async (label) => {
      requireOnline();
      const lifecycle = lifecycleGeneration;
      const response = await authenticated(() => journalApi.createToken(label));
      if (lifecycle !== lifecycleGeneration || pairingExpired) return response;
      set((state) => {
        const current = state.agentTokens.find((token) => token.id === response.token.id);
        return {
          agentTokens: [
            ...state.agentTokens.filter((token) => token.id !== response.token.id),
            current ? mergeAgentToken(current, response.token) : response.token,
          ],
        };
      });
      await persistNow();
      return response;
    },
    revokeToken: async (id) => {
      requireOnline();
      const lifecycle = lifecycleGeneration;
      const generation = sseGeneration;
      await authenticated(() => journalApi.revokeToken(id));
      if (lifecycle !== lifecycleGeneration || generation !== sseGeneration) return;
      const revokedAt = new Date().toISOString();
      set((state) => ({
        agentTokens: state.agentTokens.map((token) =>
          token.id === id ? { ...token, revokedAt } : token,
        ),
      }));
      await persistNow();
    },
    activateUpdate: async () => {
      const lifecycle = lifecycleGeneration;
      await flushJournalPersistence();
      if (lifecycle === lifecycleGeneration) activateJournalUpdate();
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
  revertActivity: (id: string): Promise<ActivityView> =>
    useJournalStore.getState().revertActivity(id),
  updateSettings: (
    patch: Partial<Pick<Settings, 'density' | 'showTypeBadges' | 'highlightAiEntries'>>,
  ): Promise<Settings> => useJournalStore.getState().updateSettings(patch),
  setDraft: (draft: string): void => useJournalStore.getState().setDraft(draft),
  setDefaultType: (type: EntryType): void => useJournalStore.getState().setDefaultType(type),
  searchEntries: (query: string): Promise<Entry[]> =>
    useJournalStore.getState().searchEntries(query),
  loadEntries: (query: LoadEntriesQuery): Promise<Entry[]> =>
    useJournalStore.getState().loadEntries(query),
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
  flush: flushOutbox,
  reconnect: (): Promise<void> => reconnectJournal(),
};

export const selectEntries = (state: JournalState): Entry[] =>
  Object.values(state.entriesById).filter((entry) => entry.deletedAt === null);
export const selectCollections = (state: JournalState): Collection[] =>
  Object.values(state.collectionsById);
/** Collections a capture can file into: no archives, no server-owned monthly logs. */
export const selectActiveCollections = (state: JournalState): Collection[] =>
  Object.values(state.collectionsById)
    .filter((collection) => !collection.archivedAt && !collection.id.startsWith('month:'))
    .sort((left, right) => left.name.localeCompare(right.name));
export const selectTagSuggestions = (state: JournalState): TagUsage[] => state.tagSuggestions;
export const selectActivity = (state: JournalState): ActivityView[] =>
  state.activityOrder.flatMap((id) => {
    const activity = state.activityById[id];
    return activity ? [activity] : [];
  });
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
