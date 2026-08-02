// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setNavigator = (values: Partial<Navigator>) => {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(navigator, key, { configurable: true, value });
  }
};

describe('contextual install guidance', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('retains the browser prompt until a capture claims it, then offers it only once', async () => {
    const pwa = await import('./install');
    const stop = pwa.observeJournalInstallGuidance();
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt: typeof prompt;
      userChoice: Promise<{ outcome: 'accepted'; platform: string }>;
    };
    event.prompt = prompt;
    event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });

    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(prompt).not.toHaveBeenCalled();

    const guidance = pwa.claimJournalInstallGuidance();
    expect(guidance?.kind).toBe('prompt');
    if (guidance?.kind === 'prompt') {
      await expect(guidance.install()).resolves.toBe('accepted');
    }
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(pwa.claimJournalInstallGuidance()).toBeNull();
    stop();
  });

  it('offers manual iOS Safari guidance but suppresses it in standalone mode', async () => {
    setNavigator({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
    });
    const pwa = await import('./install');
    expect(pwa.claimJournalInstallGuidance()).toEqual({ kind: 'ios' });

    window.localStorage.clear();
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
    expect(pwa.claimJournalInstallGuidance()).toBeNull();
  });

  it('stays silent when the platform exposes no trustworthy install path', async () => {
    setNavigator({ userAgent: 'Mozilla/5.0 Chrome/140 Safari/537.36', platform: 'Linux' });
    const pwa = await import('./install');
    expect(pwa.claimJournalInstallGuidance()).toBeNull();
  });
});
