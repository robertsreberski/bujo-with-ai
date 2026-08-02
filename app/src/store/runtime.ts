import type { MirrorData } from './models';

export type AuthenticatedRequest = <T>(
  operation: () => Promise<T>,
  expectedGeneration?: number,
) => Promise<T>;

/** Neutral ports used to compose feature actions without importing the facade. */
export interface JournalFeatureRuntime<S extends MirrorData> {
  get(): S;
  set(update: Partial<S> | ((state: S) => Partial<S>)): void;
  lifecycleGeneration(): number;
  sseGeneration(): number;
  pairingExpired(): boolean;
  authenticated: AuthenticatedRequest;
  requireOnline(): void;
  persistNow(): Promise<void>;
  persistSoon(delay?: number): void;
}

export function mirrorFromState(state: MirrorData): MirrorData {
  return {
    entriesById: state.entriesById,
    entryIdsByDate: state.entryIdsByDate,
    entryIdsByCollection: state.entryIdsByCollection,
    collectionsById: state.collectionsById,
    activityById: state.activityById,
    activityOrder: state.activityOrder,
    summariesByMonth: state.summariesByMonth,
    latestSummary: state.latestSummary,
    reflectionsByWeek: state.reflectionsByWeek ?? {},
    settings: state.settings,
    index: state.index ?? null,
    mcpStatus: state.mcpStatus,
    today: state.today,
    serverToday: state.serverToday,
    timezone: state.timezone,
    cursor: state.cursor,
    deviceId: state.deviceId,
  };
}
