// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('service-worker registration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('surfaces a waiting update and activates it only after the owner chooses reload', async () => {
    vi.stubEnv('PROD', true);
    const waitingWorker = {
      addEventListener: vi.fn(),
      postMessage: vi.fn(),
      state: 'installed',
    } as unknown as ServiceWorker;
    const registration = {
      addEventListener: vi.fn(),
      installing: null,
      update: vi.fn().mockResolvedValue(undefined),
      waiting: waitingWorker,
    } as unknown as ServiceWorkerRegistration;
    const serviceWorker = {
      addEventListener: vi.fn(),
      controller: {} as ServiceWorker,
      ready: Promise.resolve(registration),
      register: vi.fn().mockResolvedValue(registration),
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: serviceWorker,
    });

    const pwa = await import('./registration');
    const states: Array<{ updateReady: boolean; offlineReady: boolean }> = [];
    const unsubscribe = pwa.subscribePwaRegistration((state) => states.push(state));

    await pwa.registerJournalServiceWorker();
    expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js', {
      scope: '/',
      type: 'module',
    });
    expect(states.at(-1)).toEqual({ updateReady: true, offlineReady: true });

    await pwa.checkForJournalUpdate();
    expect(registration.update).toHaveBeenCalledTimes(1);
    pwa.activateJournalUpdate();
    expect(waitingWorker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    unsubscribe();
  });
});
