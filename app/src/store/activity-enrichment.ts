import { ActivitySnapshotSchema } from '@journal/server/contracts/app';

import { journalApi } from '../api/client';
import { activityPresentation } from '../activity/presentation';
import type { ActivityView, AgentTouch, Entry, Reflection, Summary, TagUsage } from '../api/types';
import type { ActivitySeenCursor, MirrorData } from './models';
import {
  recomputeActivityRevertEligibility,
  removeServerCollection,
  removeServerEntry,
  removeServerSummary,
  upsertActivity,
  upsertServerCollection,
  upsertServerEntry,
  upsertServerSummary,
} from './optimistic';
import { mirrorFromState, type JournalFeatureRuntime } from './runtime';
import type { JournalState } from './state';

const TAG_SUGGESTION_TTL_MS = 5 * 60 * 1000;

export interface ActivityEnrichmentDependencies {
  runtime: JournalFeatureRuntime;
  reconcileTimelineMembership(
    currentIds: readonly string[],
    mirror: Pick<MirrorData, 'entriesById'>,
    affectedIds: Iterable<string>,
    anchorDate: string | null,
  ): string[];
  refreshCanonicalLatestSummary(): Promise<Summary | null>;
}

type ActivityEnrichmentActions = Pick<
  JournalState,
  | 'markActivityVisible'
  | 'markAllActivitySeen'
  | 'markReviewSeen'
  | 'saveSummary'
  | 'rewriteSummary'
  | 'loadReflections'
  | 'requestReflection'
  | 'retryReflection'
  | 'restoreReflectionVersion'
  | 'revertActivity'
  | 'loadMoreActivity'
  | 'loadTagSuggestions'
>;

function addCalendarDays(date: string, amount: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

function summaryForAction(state: JournalState, id?: string): Summary | null {
  if (id === undefined || state.latestSummary?.id === id) return state.latestSummary;
  return Object.values(state.summariesByMonth).find((summary) => summary?.id === id) ?? null;
}

function upsertReflection(mirror: MirrorData, reflection: Reflection): MirrorData {
  const current = mirror.reflectionsByWeek?.[reflection.weekStart];
  if (current && current.revision > reflection.revision) return mirror;
  return {
    ...mirror,
    reflectionsByWeek: {
      ...(mirror.reflectionsByWeek ?? {}),
      [reflection.weekStart]: reflection,
    },
  };
}

const sortTagUsage = (usage: TagUsage[]): TagUsage[] =>
  usage.sort((left, right) => right.uses - left.uses || left.tag.localeCompare(right.tag));

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

export function createActivityEnrichmentActions(
  dependencies: ActivityEnrichmentDependencies,
): ActivityEnrichmentActions {
  const { runtime } = dependencies;

  const markAllActivitySeen = (): void => {
    const { activityOrder, activityById } = runtime.get();
    const newest = activityOrder
      .map((id) => activityById[id])
      .filter((activity): activity is ActivityView => activity !== undefined)
      .sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id))[0];
    if (newest === undefined) return;
    runtime.set({
      activitySeenThrough: { at: newest.at, id: newest.id },
      lastReviewSeenAt: newest.at,
      seenActivityIds: [],
    });
    runtime.persistSoon();
  };

  return {
    markActivityVisible: (ids) => {
      if (ids.length === 0) return;
      const { activityById, seenActivityIds } = runtime.get();
      const seen = new Set(seenActivityIds);
      let changed = false;
      for (const id of ids) {
        const activity = activityById[id];
        if (!activity || activity.kind === 'revert' || seen.has(id)) continue;
        seen.add(id);
        changed = true;
      }
      if (!changed) return;
      runtime.set({ seenActivityIds: [...seen] });
      runtime.persistSoon();
    },
    markAllActivitySeen,
    markReviewSeen: markAllActivitySeen,

    saveSummary: async (id) => {
      runtime.requireOnline();
      const lifecycle = runtime.lifecycleGeneration();
      const target = summaryForAction(runtime.get(), id);
      if (id !== undefined && target === null) throw new Error('Summary no longer exists.');
      const generation = runtime.sseGeneration();
      const response = await runtime.authenticated(() =>
        journalApi.saveLatestSummary({
          ...(id === undefined ? {} : { summaryId: id }),
          ...(target === null ? {} : { expectedRevision: target.revision }),
        }),
      );
      if (lifecycle === runtime.lifecycleGeneration() && generation === runtime.sseGeneration()) {
        const current = runtime.get();
        let mirror = mirrorFromState(current);
        mirror = upsertServerEntry(mirror, response.entry);
        mirror = upsertServerSummary(mirror, response.summary);
        runtime.set({
          ...recomputeActivityRevertEligibility(mirror),
          timelineEntryIds: dependencies.reconcileTimelineMembership(
            current.timelineEntryIds,
            mirror,
            [response.entry.id],
            current.timelineAnchorDate,
          ),
        });
        await runtime.persistNow();
      }
      return response.summary;
    },

    rewriteSummary: async (id) => {
      runtime.requireOnline();
      const lifecycle = runtime.lifecycleGeneration();
      const target = summaryForAction(runtime.get(), id);
      if (id !== undefined && target === null) throw new Error('Summary no longer exists.');
      const generation = runtime.sseGeneration();
      const response = await runtime.authenticated(() =>
        journalApi.rewriteLatestSummary({
          ...(id === undefined ? {} : { summaryId: id }),
          ...(target === null ? {} : { expectedRevision: target.revision }),
        }),
      );
      if (lifecycle === runtime.lifecycleGeneration() && generation === runtime.sseGeneration()) {
        runtime.set(upsertServerSummary(mirrorFromState(runtime.get()), response.summary));
        await runtime.persistNow();
      }
      return response.summary;
    },

    loadReflections: async () => {
      const state = runtime.get();
      const cached = Object.values(state.reflectionsByWeek).sort((left, right) =>
        right.weekStart.localeCompare(left.weekStart),
      );
      if (!state.online) return cached;
      const liveDates = state.timelineEntryIds
        .flatMap((id) => {
          const entry = state.entriesById[id];
          return entry && entry.deletedAt === null ? [entry.date] : [];
        })
        .sort();
      const from = liveDates[0];
      if (!from) return cached;
      const newest = liveDates.at(-1)!;
      const to = newest < state.today ? newest : addCalendarDays(state.today, -1);
      if (from > to) return cached;
      const lifecycle = runtime.lifecycleGeneration();
      const generation = runtime.sseGeneration();
      const response = await runtime.authenticated(() => journalApi.listReflections(from, to));
      if (lifecycle === runtime.lifecycleGeneration() && generation === runtime.sseGeneration()) {
        let mirror = mirrorFromState(runtime.get());
        for (const reflection of response.items) mirror = upsertReflection(mirror, reflection);
        runtime.set(mirror);
        await runtime.persistNow();
      }
      return response.items;
    },

    requestReflection: async (id) => {
      runtime.requireOnline();
      const target = Object.values(runtime.get().reflectionsByWeek).find((item) => item.id === id);
      if (!target) throw new Error('Reflection no longer exists.');
      const lifecycle = runtime.lifecycleGeneration();
      const generation = runtime.sseGeneration();
      const response = await runtime.authenticated(() =>
        journalApi.requestReflection(id, target.revision),
      );
      if (lifecycle === runtime.lifecycleGeneration() && generation === runtime.sseGeneration()) {
        runtime.set(upsertReflection(mirrorFromState(runtime.get()), response.reflection));
        await runtime.persistNow();
      }
      return response.reflection;
    },

    retryReflection: async (id) => {
      runtime.requireOnline();
      const target = Object.values(runtime.get().reflectionsByWeek).find((item) => item.id === id);
      if (!target) throw new Error('Reflection no longer exists.');
      const lifecycle = runtime.lifecycleGeneration();
      const generation = runtime.sseGeneration();
      const response = await runtime.authenticated(() =>
        journalApi.retryReflection(id, target.revision),
      );
      if (lifecycle === runtime.lifecycleGeneration() && generation === runtime.sseGeneration()) {
        runtime.set(upsertReflection(mirrorFromState(runtime.get()), response.reflection));
        await runtime.persistNow();
      }
      return response.reflection;
    },

    restoreReflectionVersion: async (id, versionId) => {
      runtime.requireOnline();
      const target = Object.values(runtime.get().reflectionsByWeek).find((item) => item.id === id);
      if (!target) throw new Error('Reflection no longer exists.');
      const lifecycle = runtime.lifecycleGeneration();
      const generation = runtime.sseGeneration();
      const response = await runtime.authenticated(() =>
        journalApi.restoreReflectionVersion(id, versionId, target.revision),
      );
      if (lifecycle === runtime.lifecycleGeneration() && generation === runtime.sseGeneration()) {
        runtime.set(upsertReflection(mirrorFromState(runtime.get()), response.reflection));
        await runtime.persistNow();
      }
      return response.reflection;
    },

    revertActivity: async (id) => {
      runtime.requireOnline();
      const lifecycle = runtime.lifecycleGeneration();
      const generation = runtime.sseGeneration();
      const response = await runtime.authenticated(() => journalApi.revertActivity(id));
      if (lifecycle !== runtime.lifecycleGeneration() || generation !== runtime.sseGeneration()) {
        return response.activity;
      }
      let mirror = mirrorFromState(runtime.get());
      let removedLatestSummary = false;
      for (const rawSnapshot of response.rows) {
        const parsed = ActivitySnapshotSchema.safeParse(rawSnapshot);
        if (!parsed.success) continue;
        const snapshot = parsed.data;
        if (snapshot.entity === 'entry') {
          mirror = snapshot.row
            ? upsertServerEntry(mirror, snapshot.row)
            : removeServerEntry(mirror, snapshot.id);
        } else if (snapshot.entity === 'collection') {
          mirror = snapshot.row
            ? upsertServerCollection(mirror, snapshot.row)
            : removeServerCollection(mirror, snapshot.id);
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
      runtime.set({
        ...recomputeActivityRevertEligibility(mirror),
        indexSource: mirror.index === null ? 'none' : 'cached',
      });
      await runtime.persistNow();
      if (removedLatestSummary) void dependencies.refreshCanonicalLatestSummary();
      return response.activity;
    },

    loadMoreActivity: async () => {
      const lifecycle = runtime.lifecycleGeneration();
      const state = runtime.get();
      if (!state.online || state.activityLoading || !state.activityHasMore) return;
      const before =
        state.activityNextCursor ?? state.activityById[state.activityOrder.at(-1) ?? '']?.at;
      if (!before) {
        runtime.set({ activityHasMore: false });
        return;
      }
      runtime.set({ activityLoading: true });
      try {
        const generation = runtime.sseGeneration();
        const response = await runtime.authenticated(() => journalApi.listActivity(before, 50));
        if (lifecycle !== runtime.lifecycleGeneration() || generation !== runtime.sseGeneration()) {
          return;
        }
        let mirror = mirrorFromState(runtime.get());
        for (const activity of response.items) mirror = upsertActivity(mirror, activity);
        mirror = recomputeActivityRevertEligibility(mirror);
        runtime.set({
          ...mirror,
          activityHasMore: response.nextCursor !== null,
          activityNextCursor: response.nextCursor,
        });
        await runtime.persistNow();
      } finally {
        if (lifecycle === runtime.lifecycleGeneration()) runtime.set({ activityLoading: false });
      }
    },

    loadTagSuggestions: async () => {
      const state = runtime.get();
      runtime.set({ tagSuggestions: deriveTagUsage(state.entriesById) });
      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      const fresh =
        state.tagsFetchedAt !== null &&
        Date.now() - Date.parse(state.tagsFetchedAt) < TAG_SUGGESTION_TTL_MS;
      if (!online || fresh) return;
      const lifecycle = runtime.lifecycleGeneration();
      try {
        const response = await journalApi.listTags();
        if (lifecycle !== runtime.lifecycleGeneration()) return;
        runtime.set((current) => ({
          tagSuggestions: mergeTagUsage(deriveTagUsage(current.entriesById), response.items),
          tagsFetchedAt: new Date().toISOString(),
        }));
      } catch {
        // Best effort: mirror-derived suggestions are already available.
      }
    },
  };
}

const activityAtOrBefore = (activity: ActivityView, cursor: ActivitySeenCursor): boolean =>
  activity.at < cursor.at || (activity.at === cursor.at && activity.id <= cursor.id);

export const selectUnseenActivityIds = (state: JournalState): string[] => {
  const individuallySeen = new Set(state.seenActivityIds);
  return state.activityOrder.filter((id) => {
    const activity = state.activityById[id];
    if (!activity || activity.kind === 'revert' || individuallySeen.has(id)) return false;
    if (
      state.activitySeenThrough !== null &&
      activityAtOrBefore(activity, state.activitySeenThrough)
    ) {
      return false;
    }
    if (state.activitySeenThrough === null && state.lastReviewSeenAt !== null) {
      return activity.at > state.lastReviewSeenAt;
    }
    return true;
  });
};

export const selectUnseenActivityCount = (state: JournalState): number =>
  selectUnseenActivityIds(state).length;

export const selectHasUnseenActivity = (state: JournalState): boolean => {
  if (selectUnseenActivityIds(state).length > 0) return true;
  if (!state.activityHasMore) return false;
  const oldest = [...state.activityOrder]
    .reverse()
    .map((id) => state.activityById[id])
    .find((activity): activity is ActivityView => activity !== undefined);
  if (oldest === undefined) return true;
  if (state.activitySeenThrough !== null) {
    return !activityAtOrBefore(oldest, state.activitySeenThrough);
  }
  if (state.lastReviewSeenAt !== null) return oldest.at > state.lastReviewSeenAt;
  return true;
};

/** @deprecated Use selectUnseenActivityCount. */
export const selectUnseenReviewCount = selectUnseenActivityCount;

export const selectLatestAgentTouches = (state: JournalState): Record<string, AgentTouch> => {
  const touches: Record<string, AgentTouch> = {};
  const tokenLabels = Object.fromEntries(state.agentTokens.map((token) => [token.id, token.label]));
  for (const id of state.activityOrder) {
    const activity = state.activityById[id];
    const touch =
      activity === undefined ? null : activityPresentation(activity, tokenLabels).latestAgentTouch;
    if (touch !== null && touch !== undefined && touches[touch.entryId] === undefined) {
      touches[touch.entryId] = touch;
    }
  }
  return touches;
};

export const selectActivity = (state: JournalState): ActivityView[] =>
  state.activityOrder.flatMap((id) => {
    const activity = state.activityById[id];
    return activity ? [activity] : [];
  });
