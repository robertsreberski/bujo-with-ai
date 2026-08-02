export interface PwaRegistrationState {
  updateReady: boolean;
  offlineReady: boolean;
}

type Listener = (state: PwaRegistrationState) => void;

let registration: ServiceWorkerRegistration | null = null;
let registrationAttempt: Promise<void> | null = null;
let waitingWorker: ServiceWorker | null = null;
let activationRequested = false;
let observingControllerChanges = false;
let state: PwaRegistrationState = { updateReady: false, offlineReady: false };
const listeners = new Set<Listener>();

function emit(patch: Partial<PwaRegistrationState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

function observeInstallingWorker(worker: ServiceWorker): void {
  worker.addEventListener('statechange', () => {
    if (worker.state !== 'installed') return;
    if (navigator.serviceWorker.controller) {
      waitingWorker = registration?.waiting ?? worker;
      emit({ updateReady: true });
    } else {
      emit({ offlineReady: true });
    }
  });
}

function observeControllerChanges(): void {
  if (observingControllerChanges) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!activationRequested) return;
    activationRequested = false;
    window.location.reload();
  });
  observingControllerChanges = true;
}

async function performRegistration(): Promise<void> {
  observeControllerChanges();
  const nextRegistration = await navigator.serviceWorker.register('/sw.js', {
    scope: '/',
    type: 'module',
  });
  registration = nextRegistration;

  if (nextRegistration.waiting && navigator.serviceWorker.controller) {
    waitingWorker = nextRegistration.waiting;
    emit({ updateReady: true });
  }

  if (nextRegistration.installing) observeInstallingWorker(nextRegistration.installing);
  nextRegistration.addEventListener('updatefound', () => {
    if (registration?.installing) observeInstallingWorker(registration.installing);
  });

  await navigator.serviceWorker.ready;
  emit({ offlineReady: true });
}

/**
 * Registers the module worker once and leaves an update waiting for explicit
 * activation. Concurrent owners share one attempt; a rejected attempt remains
 * observable to its caller and can be retried later.
 */
export async function registerJournalServiceWorker(): Promise<void> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  if (registrationAttempt) return registrationAttempt;
  if (registration) return;

  registrationAttempt = performRegistration().catch((error: unknown) => {
    registration = null;
    waitingWorker = null;
    emit({ offlineReady: false });
    throw error;
  });
  try {
    await registrationAttempt;
  } finally {
    registrationAttempt = null;
  }
}

export function subscribePwaRegistration(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export async function checkForJournalUpdate(): Promise<void> {
  if (!registration) await registerJournalServiceWorker();
  await registration?.update();
}

export function activateJournalUpdate(): void {
  const worker = registration?.waiting ?? waitingWorker;
  if (!worker) return;
  activationRequested = true;
  worker.postMessage({ type: 'SKIP_WAITING' });
}

export function getPwaRegistrationState(): PwaRegistrationState {
  return state;
}
