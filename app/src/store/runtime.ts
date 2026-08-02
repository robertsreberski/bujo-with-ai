import type { StoreApi } from 'zustand';

import type { MirrorData } from './models';
import type { JournalState } from './state';

export type AuthenticatedRequest = <T>(
  operation: () => Promise<T>,
  expectedGeneration?: number,
) => Promise<T>;

/** Neutral ports used to compose feature actions without importing the facade. */
export interface JournalFeatureRuntime {
  get: StoreApi<JournalState>['getState'];
  set: StoreApi<JournalState>['setState'];
  lifecycleGeneration(): number;
  sseGeneration(): number;
  pairingExpired(): boolean;
  authenticated: AuthenticatedRequest;
  requireOnline(): void;
  persistNow(): Promise<void>;
  persistSoon(delay?: number): void;
}

export function mirrorFromState(state: JournalState): MirrorData {
  return {
    entriesById: state.entriesById,
    entryIdsByDate: state.entryIdsByDate,
    entryIdsByCollection: state.entryIdsByCollection,
    collectionsById: state.collectionsById,
    activityById: state.activityById,
    activityOrder: state.activityOrder,
    summariesByMonth: state.summariesByMonth,
    latestSummary: state.latestSummary,
    reflectionsByWeek: state.reflectionsByWeek,
    settings: state.settings,
    index: state.index,
    mcpStatus: state.mcpStatus,
    today: state.today,
    serverToday: state.serverToday,
    timezone: state.timezone,
    cursor: state.cursor,
    deviceId: state.deviceId,
  };
}
