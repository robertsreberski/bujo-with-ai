import { ApiError, journalApi } from '../api/client';
import type { Settings } from '../api/types';
import { mergeAgentToken, upsertServerSettings } from './optimistic';
import { mirrorFromState, type JournalFeatureRuntime } from './runtime';
import type { JournalState } from './state';

export const PAIRING_EXPIRED_MESSAGE = 'Pairing expired. Reload Journal to reconnect.';

export const DEFAULT_SETTINGS: Settings = {
  density: 'comfortable',
  showTypeBadges: true,
  highlightAiEntries: true,
  savedViews: [],
  updatedAt: '1970-01-01T00:00:00.000Z',
};

type SettingsPairingActions = Pick<
  JournalState,
  'updateSettings' | 'refreshTokens' | 'createToken' | 'revokeToken'
>;

/**
 * Loads the canonical startup snapshot and performs the one allowed pairing
 * transition. A sticky expired-pairing gate still prevents silent re-pairing.
 */
export async function bootstrapSnapshot(
  allowPair: boolean,
  expectedGeneration: number,
  runtime: JournalFeatureRuntime,
): Promise<Awaited<ReturnType<typeof journalApi.bootstrap>> | null> {
  try {
    return await journalApi.bootstrap();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || !allowPair) throw error;
    if (expectedGeneration !== runtime.lifecycleGeneration() || runtime.pairingExpired()) {
      return null;
    }
    const paired = await journalApi.pair();
    runtime.set({ ...mirrorFromState(runtime.get()), deviceId: paired.deviceId });
    await runtime.persistNow();
    if (expectedGeneration !== runtime.lifecycleGeneration() || runtime.pairingExpired()) {
      return null;
    }
    return journalApi.bootstrap();
  }
}

export function createSettingsPairingActions(
  runtime: JournalFeatureRuntime,
): SettingsPairingActions {
  return {
    updateSettings: async (patch) => {
      runtime.requireOnline();
      const lifecycle = runtime.lifecycleGeneration();
      const generation = runtime.sseGeneration();
      const response = await runtime.authenticated(() => journalApi.updateSettings(patch));
      if (
        lifecycle !== runtime.lifecycleGeneration() ||
        generation !== runtime.sseGeneration() ||
        runtime.pairingExpired()
      ) {
        return response.settings;
      }
      const mirror = upsertServerSettings(mirrorFromState(runtime.get()), response.settings);
      runtime.set({
        ...mirror,
        mcpStatus: response.assistant,
        ...(patch.savedViews === undefined
          ? {}
          : { indexSource: mirror.index === null ? ('none' as const) : ('cached' as const) }),
      });
      await runtime.persistNow();
      return response.settings;
    },

    refreshTokens: async () => {
      runtime.requireOnline();
      const lifecycle = runtime.lifecycleGeneration();
      const generation = runtime.sseGeneration();
      runtime.set({ tokensLoading: true });
      try {
        const [tokenResponse, settingsResponse] = await runtime.authenticated(() =>
          Promise.all([journalApi.listTokens(), journalApi.getSettings()]),
        );
        if (lifecycle !== runtime.lifecycleGeneration() || runtime.pairingExpired()) {
          return;
        }
        const tokensById = new Map(runtime.get().agentTokens.map((token) => [token.id, token]));
        for (const token of tokenResponse.tokens) {
          const current = tokensById.get(token.id);
          tokensById.set(token.id, current ? mergeAgentToken(current, token) : token);
        }
        const settingsAreCurrent = generation === runtime.sseGeneration();
        const mirror = settingsAreCurrent
          ? upsertServerSettings(mirrorFromState(runtime.get()), settingsResponse.settings)
          : null;
        runtime.set({
          ...(mirror ?? {}),
          agentTokens: [...tokensById.values()],
          ...(settingsAreCurrent ? { mcpStatus: settingsResponse.assistant } : {}),
        });
        await runtime.persistNow();
      } finally {
        if (lifecycle === runtime.lifecycleGeneration()) runtime.set({ tokensLoading: false });
      }
    },

    createToken: async (label) => {
      runtime.requireOnline();
      const lifecycle = runtime.lifecycleGeneration();
      const response = await runtime.authenticated(() => journalApi.createToken(label));
      if (lifecycle !== runtime.lifecycleGeneration() || runtime.pairingExpired()) {
        return response;
      }
      runtime.set((state) => {
        const current = state.agentTokens.find((token) => token.id === response.token.id);
        return {
          agentTokens: [
            ...state.agentTokens.filter((token) => token.id !== response.token.id),
            current ? mergeAgentToken(current, response.token) : response.token,
          ],
        };
      });
      await runtime.persistNow();
      return response;
    },

    revokeToken: async (id) => {
      runtime.requireOnline();
      const lifecycle = runtime.lifecycleGeneration();
      const generation = runtime.sseGeneration();
      await runtime.authenticated(() => journalApi.revokeToken(id));
      if (lifecycle !== runtime.lifecycleGeneration() || generation !== runtime.sseGeneration()) {
        return;
      }
      const revokedAt = new Date().toISOString();
      runtime.set((state) => ({
        agentTokens: state.agentTokens.map((token) =>
          token.id === id ? { ...token, revokedAt } : token,
        ),
      }));
      await runtime.persistNow();
    },
  };
}
