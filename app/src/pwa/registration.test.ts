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

  it('shares concurrent registration and permits a retry after an observable failure', async () => {
    vi.stubEnv('PROD', true);
    const registration = {
      addEventListener: vi.fn(),
      installing: null,
      update: vi.fn().mockResolvedValue(undefined),
      waiting: null,
    } as unknown as ServiceWorkerRegistration;
    let rejectFirstAttempt: ((error: Error) => void) | undefined;
    const firstAttempt = new Promise<ServiceWorkerRegistration>((_resolve, reject) => {
      rejectFirstAttempt = reject;
    });
    const serviceWorker = {
      addEventListener: vi.fn(),
      controller: null,
      ready: Promise.resolve(registration),
      register: vi.fn().mockReturnValueOnce(firstAttempt).mockResolvedValueOnce(registration),
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: serviceWorker,
    });

    const pwa = await import('./registration');
    const first = pwa.registerJournalServiceWorker();
    const concurrent = pwa.registerJournalServiceWorker();
    expect(serviceWorker.register).toHaveBeenCalledTimes(1);

    const firstRejection = expect(first).rejects.toThrow('temporary registration failure');
    const concurrentRejection = expect(concurrent).rejects.toThrow(
      'temporary registration failure',
    );
    rejectFirstAttempt?.(new Error('temporary registration failure'));
    await firstRejection;
    await concurrentRejection;

    await expect(pwa.registerJournalServiceWorker()).resolves.toBeUndefined();
    expect(serviceWorker.register).toHaveBeenCalledTimes(2);
    expect(serviceWorker.addEventListener).toHaveBeenCalledTimes(1);
    expect(pwa.getPwaRegistrationState().offlineReady).toBe(true);
  });

  it('uses update checks as a later retry opportunity when registration is absent', async () => {
    vi.stubEnv('PROD', true);
    const registration = {
      addEventListener: vi.fn(),
      installing: null,
      update: vi.fn().mockResolvedValue(undefined),
      waiting: null,
    } as unknown as ServiceWorkerRegistration;
    const serviceWorker = {
      addEventListener: vi.fn(),
      controller: null,
      ready: Promise.resolve(registration),
      register: vi.fn().mockResolvedValue(registration),
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: serviceWorker,
    });

    const pwa = await import('./registration');
    await pwa.checkForJournalUpdate();

    expect(serviceWorker.register).toHaveBeenCalledTimes(1);
    expect(registration.update).toHaveBeenCalledTimes(1);
  });
});
