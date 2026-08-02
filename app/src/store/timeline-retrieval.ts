import {
  entryMatchesJournalSearch,
  parseJournalSearch as parseSharedJournalSearch,
} from '@journal/server/contracts/app';

import { ApiError, journalApi } from '../api/client';
import type { Collection, Entry, IndexResponse } from '../api/types';
import type { JournalSearchPage, OutboxItem, QueueableCommand } from '../domain/contracts';
import type { MirrorData } from './models';
import {
  applyPendingCommands,
  recomputeActivityRevertEligibility,
  upsertServerCollection,
  upsertServerEntry,
} from './optimistic';
import { mirrorFromState, type JournalFeatureRuntime } from './runtime';
import type { JournalActions, JournalDataState, LoadEntriesQuery } from './state';

type TimelineRetrievalState = MirrorData &
  Pick<
    JournalDataState,
    | 'outbox'
    | 'online'
    | 'networkOnline'
    | 'connectionStatus'
    | 'timelineEntryIds'
    | 'timelineNextCursor'
    | 'timelineAnchorDate'
    | 'timelineLoaded'
    | 'timelineLoading'
    | 'timelineLoadingEarlier'
    | 'timelineLatestAgentTouch'
    | 'timelineWeeklyReflection'
    | 'indexStatus'
    | 'indexSource'
    | 'indexError'
  >;

export interface TimelineRetrievalDependencies {
  runtime: JournalFeatureRuntime<TimelineRetrievalState>;
  sseReplayReady(): boolean;
  canonicalHistoryHydrating(): boolean;
  nextTimelineRequest(): number;
  timelineRequestIsCurrent(request: number): boolean;
  loadCanonicalMonthSummary(month: string, expectedLifecycle: number): Promise<void>;
}

type TimelineRetrievalActions = Pick<
  JournalActions,
  | 'searchEntries'
  | 'loadEntry'
  | 'loadEntries'
  | 'loadTimeline'
  | 'loadEarlierTimeline'
  | 'loadIndex'
  | 'loadDate'
  | 'loadMonth'
  | 'loadCollection'
>;

export const parseJournalSearch = parseSharedJournalSearch;

const SEARCH_PAGE_SIZE = 50;
const DOWNLOADED_CURSOR_PREFIX = 'downloaded:';
const TIMELINE_PAGE_SIZE = 100;

function downloadedCursor(offset: number): string {
  return `${DOWNLOADED_CURSOR_PREFIX}${offset}`;
}

function downloadedOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!cursor.startsWith(DOWNLOADED_CURSOR_PREFIX)) return 0;
  const offset = Number(cursor.slice(DOWNLOADED_CURSOR_PREFIX.length));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Invalid downloaded search cursor.');
  }
  return offset;
}

export function downloadedSearchPage(
  entriesById: Record<string, Entry>,
  query: string,
  cursor: string | undefined,
  reason: JournalSearchPage['reason'],
): JournalSearchPage {
  const filters = parseJournalSearch(query);
  const offset = downloadedOffset(cursor);
  const matching = Object.values(entriesById)
    .filter((entry) => entryMatchesJournalSearch(entry, filters))
    .sort(
      (left, right) =>
        right.date.localeCompare(left.date) ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    );
  const items = matching.slice(offset, offset + SEARCH_PAGE_SIZE);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < matching.length;
  return {
    items,
    nextCursor: hasMore ? downloadedCursor(nextOffset) : null,
    hasMore,
    source: 'downloaded',
    reason,
  };
}

export function mergeIds(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flatMap((group) => [...group]))];
}

/** Single membership rule for the bounded Timeline projection. */
export function isTimelineEligible(entry: Entry, anchorDate: string | null): boolean {
  return (
    entry.deletedAt === null &&
    !entry.collection?.startsWith('month:') &&
    (anchorDate === null || entry.date <= anchorDate)
  );
}

export function eligibleTimelineIds(
  mirror: Pick<MirrorData, 'entriesById'>,
  candidates: readonly string[],
  anchorDate: string | null,
): string[] {
  return mergeIds(candidates).filter((id) => {
    const entry = mirror.entriesById[id];
    return entry !== undefined && isTimelineEligible(entry, anchorDate);
  });
}

export function reconcileTimelineMembership(
  currentIds: readonly string[],
  mirror: Pick<MirrorData, 'entriesById'>,
  affectedIds: Iterable<string>,
  anchorDate: string | null,
): string[] {
  const ids = new Set(currentIds);
  for (const id of affectedIds) {
    const entry = mirror.entriesById[id];
    if (entry !== undefined && isTimelineEligible(entry, anchorDate)) ids.add(id);
    else ids.delete(id);
  }
  return eligibleTimelineIds(mirror, [...ids], anchorDate);
}

export function timelineIdsWithRestoredEntry(
  state: Pick<JournalDataState, 'timelineEntryIds' | 'timelineAnchorDate'>,
  entry: Entry,
): string[] {
  return isTimelineEligible(entry, state.timelineAnchorDate)
    ? mergeIds(state.timelineEntryIds, [entry.id])
    : state.timelineEntryIds.filter((id) => id !== entry.id);
}

function commandCreatedEntries(command: QueueableCommand): Entry[] {
  switch (command.kind) {
    case 'entry.create':
      return [command.entry];
    case 'entry.migrate':
    case 'entry.schedule':
      return [command.copy];
    case 'entry.update':
    case 'entry.delete':
    case 'collection.create':
    case 'collection.update':
      return [];
  }
}

export function pendingTimelineIds(
  outbox: readonly OutboxItem[],
  anchorDate: string | null,
): string[] {
  return outbox.flatMap((item) =>
    commandCreatedEntries(item.command)
      .filter((entry) => isTimelineEligible(entry, anchorDate))
      .map((entry) => entry.id),
  );
}

export function createTimelineRetrievalActions(
  dependencies: TimelineRetrievalDependencies,
): TimelineRetrievalActions {
  const { runtime } = dependencies;

  async function loadEntriesIntoMirror(
    query: LoadEntriesQuery,
    options: { persist?: boolean; retryOnChange?: boolean; requireConnection?: boolean } = {},
    attempt = 0,
  ): Promise<Entry[]> {
    if (options.requireConnection !== false) runtime.requireOnline();
    const lifecycle = runtime.lifecycleGeneration();
    const responseGeneration = runtime.sseGeneration();
    const loaded: Entry[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await runtime.authenticated(() =>
        journalApi.listEntries({
          ...query,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      if (lifecycle !== runtime.lifecycleGeneration()) return loaded;
      if (runtime.pairingExpired()) {
        throw new ApiError(401, 'unauthenticated', 'Pairing expired. Reload Journal to reconnect.');
      }
      if (responseGeneration !== runtime.sseGeneration()) {
        if (options.retryOnChange !== false && attempt < 3) {
          return loadEntriesIntoMirror(query, options, attempt + 1);
        }
        throw new Error('Journal changed while entries were loading. Please retry.');
      }
      loaded.push(...response.items);
      const nextCursor = response.nextCursor ?? undefined;
      cursor = nextCursor === undefined || seenCursors.has(nextCursor) ? undefined : nextCursor;
      if (cursor !== undefined) seenCursors.add(cursor);
      let mirror = mirrorFromState(runtime.get());
      for (const entry of response.items) mirror = upsertServerEntry(mirror, entry);
      mirror = recomputeActivityRevertEligibility(
        applyPendingCommands(mirror, runtime.get().outbox),
      );
      runtime.set({
        ...mirror,
        today: response.today,
        serverToday: response.today,
        timezone: response.timezone,
        online:
          dependencies.sseReplayReady() &&
          !dependencies.canonicalHistoryHydrating() &&
          runtime.get().connectionStatus === 'connected',
      });
    } while (cursor !== undefined);
    if (lifecycle !== runtime.lifecycleGeneration()) return loaded;
    if (options.persist !== false) await runtime.persistNow();
    return loaded;
  }

  async function loadTimelinePage(anchorDate: string | null): Promise<Entry[]> {
    runtime.requireOnline();
    const request = dependencies.nextTimelineRequest();
    const lifecycle = runtime.lifecycleGeneration();
    const startingState = runtime.get();
    const startingIds = new Set(startingState.timelineEntryIds);
    const startingEntries = startingState.entriesById;
    runtime.set({ timelineLoading: true, timelineLoadingEarlier: false });
    try {
      const response = await runtime.authenticated(() =>
        journalApi.timeline({
          ...(anchorDate === null ? {} : { to: anchorDate }),
          limit: TIMELINE_PAGE_SIZE,
        }),
      );
      if (
        !dependencies.timelineRequestIsCurrent(request) ||
        lifecycle !== runtime.lifecycleGeneration()
      ) {
        return response.items;
      }
      const current = runtime.get();
      let mirror = mirrorFromState(current);
      for (const entry of response.items) {
        // Live/optimistic object identity changed during this request: it wins.
        if (current.entriesById[entry.id] !== startingEntries[entry.id]) continue;
        mirror = upsertServerEntry(mirror, entry);
      }
      for (const collection of response.collections) {
        mirror = upsertServerCollection(mirror, collection);
      }
      mirror = recomputeActivityRevertEligibility(applyPendingCommands(mirror, current.outbox));
      const arrivedDuringRequest = current.timelineEntryIds.filter((id) => {
        const entry = current.entriesById[id];
        return !startingIds.has(id) && entry !== undefined && isTimelineEligible(entry, anchorDate);
      });
      const timelineEntryIds = eligibleTimelineIds(
        mirror,
        mergeIds(
          response.items.map((entry) => entry.id),
          arrivedDuringRequest,
          pendingTimelineIds(current.outbox, anchorDate),
        ),
        anchorDate,
      );
      runtime.set({
        ...mirror,
        timelineEntryIds,
        timelineNextCursor: response.nextCursor,
        timelineAnchorDate: anchorDate,
        timelineLoaded: true,
        timelineLoading: false,
        timelineLoadingEarlier: false,
        timelineLatestAgentTouch: response.latestAgentTouch ?? null,
        timelineWeeklyReflection: response.weeklyReflection ?? null,
        today: response.today,
        serverToday: response.today,
        timezone: response.timezone,
      });
      await runtime.persistNow();
      return response.items;
    } finally {
      if (
        dependencies.timelineRequestIsCurrent(request) &&
        lifecycle === runtime.lifecycleGeneration()
      ) {
        runtime.set({ timelineLoading: false });
      }
    }
  }

  async function loadEarlierTimelinePage(): Promise<Entry[]> {
    runtime.requireOnline();
    const state = runtime.get();
    const cursor = state.timelineNextCursor;
    if (!state.timelineLoaded || cursor === null || state.timelineLoadingEarlier) return [];
    const request = dependencies.nextTimelineRequest();
    const lifecycle = runtime.lifecycleGeneration();
    const startingEntries = state.entriesById;
    runtime.set({ timelineLoadingEarlier: true });
    try {
      const response = await runtime.authenticated(() =>
        journalApi.timeline({
          ...(state.timelineAnchorDate === null ? {} : { to: state.timelineAnchorDate }),
          limit: TIMELINE_PAGE_SIZE,
          cursor,
        }),
      );
      if (
        !dependencies.timelineRequestIsCurrent(request) ||
        lifecycle !== runtime.lifecycleGeneration()
      ) {
        return response.items;
      }
      const current = runtime.get();
      let mirror = mirrorFromState(current);
      for (const entry of response.items) {
        if (current.entriesById[entry.id] !== startingEntries[entry.id]) continue;
        mirror = upsertServerEntry(mirror, entry);
      }
      for (const collection of response.collections) {
        mirror = upsertServerCollection(mirror, collection);
      }
      mirror = recomputeActivityRevertEligibility(applyPendingCommands(mirror, current.outbox));
      runtime.set({
        ...mirror,
        timelineEntryIds: eligibleTimelineIds(
          mirror,
          mergeIds(
            current.timelineEntryIds,
            response.items.map((entry) => entry.id),
            pendingTimelineIds(current.outbox, state.timelineAnchorDate),
          ),
          state.timelineAnchorDate,
        ),
        timelineNextCursor: response.nextCursor === cursor ? null : response.nextCursor,
        timelineLoadingEarlier: false,
        today: response.today,
        serverToday: response.today,
        timezone: response.timezone,
      });
      await runtime.persistNow();
      return response.items;
    } finally {
      if (
        dependencies.timelineRequestIsCurrent(request) &&
        lifecycle === runtime.lifecycleGeneration()
      ) {
        runtime.set({ timelineLoadingEarlier: false });
      }
    }
  }

  async function loadIndexIntoMirror(attempt = 0): Promise<IndexResponse> {
    const lifecycle = runtime.lifecycleGeneration();
    if (attempt === 0) runtime.set({ indexStatus: 'loading', indexError: null });
    try {
      runtime.requireOnline();
      const responseGeneration = runtime.sseGeneration();
      const response = await runtime.authenticated(() => journalApi.getIndex());
      if (lifecycle !== runtime.lifecycleGeneration()) return response;
      if (runtime.pairingExpired()) {
        throw new ApiError(401, 'unauthenticated', 'Pairing expired. Reload Journal to reconnect.');
      }
      if (responseGeneration !== runtime.sseGeneration()) {
        if (attempt < 3) return loadIndexIntoMirror(attempt + 1);
        throw new Error('Journal changed while the index was loading. Please retry.');
      }

      const state = runtime.get();
      let mirror: MirrorData = {
        ...mirrorFromState(state),
        index: response,
        collectionsById: {
          ...state.collectionsById,
          ...Object.fromEntries(
            response.collections.map((collection) => [
              collection.id,
              {
                id: collection.id,
                name: collection.name,
                note: collection.note,
                createdAt: collection.createdAt,
                archivedAt: collection.archivedAt,
              } satisfies Collection,
            ]),
          ),
        },
      };
      mirror = recomputeActivityRevertEligibility(applyPendingCommands(mirror, state.outbox));
      runtime.set({ ...mirror, indexStatus: 'ready', indexSource: 'journal', indexError: null });
      await runtime.persistNow();
      return response;
    } catch (error) {
      if (attempt === 0 && lifecycle === runtime.lifecycleGeneration()) {
        runtime.set({
          indexStatus: 'error',
          indexError: error instanceof Error ? error.message : 'Journal index could not refresh.',
        });
      }
      throw error;
    }
  }

  async function loadEntryIntoMirror(id: string): Promise<Entry> {
    runtime.requireOnline();
    const lifecycle = runtime.lifecycleGeneration();
    const response = await runtime.authenticated(() => journalApi.getEntry(id));
    if (lifecycle !== runtime.lifecycleGeneration() || runtime.pairingExpired()) {
      return response.entry;
    }
    let mirror = upsertServerEntry(mirrorFromState(runtime.get()), response.entry);
    mirror = recomputeActivityRevertEligibility(applyPendingCommands(mirror, runtime.get().outbox));
    runtime.set({ ...mirror });
    await runtime.persistNow();
    return runtime.get().entriesById[id] ?? response.entry;
  }

  return {
    searchEntries: async (query, cursor) => {
      parseJournalSearch(query);
      const localReason = (): JournalSearchPage['reason'] =>
        runtime.get().networkOnline ? 'unavailable' : 'offline';
      if (cursor?.startsWith(DOWNLOADED_CURSOR_PREFIX) || !runtime.get().online) {
        return downloadedSearchPage(runtime.get().entriesById, query, cursor, localReason());
      }

      const lifecycle = runtime.lifecycleGeneration();
      let response: Awaited<ReturnType<typeof journalApi.listEntries>>;
      try {
        response = await runtime.authenticated(() =>
          journalApi.listEntries({
            q: query.trim(),
            limit: SEARCH_PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
      } catch (error) {
        if (error instanceof ApiError && (error.status === 0 || error.retryable)) {
          return downloadedSearchPage(runtime.get().entriesById, query, cursor, localReason());
        }
        throw error;
      }

      if (lifecycle === runtime.lifecycleGeneration() && !runtime.pairingExpired()) {
        let mirror = mirrorFromState(runtime.get());
        for (const entry of response.items) mirror = upsertServerEntry(mirror, entry);
        mirror = recomputeActivityRevertEligibility(
          applyPendingCommands(mirror, runtime.get().outbox),
        );
        runtime.set({
          ...mirror,
          today: response.today,
          serverToday: response.today,
          timezone: response.timezone,
        });
        runtime.persistSoon();
      }
      return {
        items: response.items,
        nextCursor: response.nextCursor,
        hasMore: response.nextCursor !== null,
        source: 'journal',
        reason: null,
      };
    },
    loadEntries: loadEntriesIntoMirror,
    loadTimeline: (anchorDate = null) => loadTimelinePage(anchorDate),
    loadEarlierTimeline: loadEarlierTimelinePage,
    loadIndex: loadIndexIntoMirror,
    loadEntry: loadEntryIntoMirror,
    loadDate: (date) => loadEntriesIntoMirror({ from: date, to: date }),
    loadMonth: async (month) => {
      const lifecycle = runtime.lifecycleGeneration();
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
      if (lifecycle !== runtime.lifecycleGeneration()) return loaded;
      if (runtime.pairingExpired()) {
        throw new ApiError(401, 'unauthenticated', 'Pairing expired. Reload Journal to reconnect.');
      }
      await dependencies.loadCanonicalMonthSummary(month, lifecycle);
      return loaded;
    },
    loadCollection: (id) => loadEntriesIntoMirror({ collection: id }),
  };
}

export const selectEntries = (state: Pick<MirrorData, 'entriesById'>): Entry[] =>
  Object.values(state.entriesById).filter((entry) => entry.deletedAt === null);

export const selectTimelineEntries = (
  state: Pick<JournalDataState, 'timelineEntryIds' | 'entriesById' | 'timelineAnchorDate'>,
): Entry[] =>
  state.timelineEntryIds.flatMap((id) => {
    const entry = state.entriesById[id];
    return entry && isTimelineEligible(entry, state.timelineAnchorDate) ? [entry] : [];
  });

export const selectCollections = (state: Pick<MirrorData, 'collectionsById'>): Collection[] =>
  Object.values(state.collectionsById);

/** Collections a capture can file into: no archives, no server-owned monthly logs. */
export const selectActiveCollections = (state: Pick<MirrorData, 'collectionsById'>): Collection[] =>
  Object.values(state.collectionsById)
    .filter((collection) => !collection.archivedAt && !collection.id.startsWith('month:'))
    .sort((left, right) => left.name.localeCompare(right.name));

export const selectOpenTodayCount = (state: Pick<MirrorData, 'entriesById' | 'today'>): number =>
  Object.values(state.entriesById).filter(
    (entry) =>
      entry.deletedAt === null &&
      entry.state === 'open' &&
      (entry.type === 'task' || entry.type === 'habit') &&
      entry.collection === null &&
      entry.date <= state.today,
  ).length;
