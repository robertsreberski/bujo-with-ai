export interface PwaRegistrationState {
  updateReady: boolean;
  offlineReady: boolean;
}

type Listener = (state: PwaRegistrationState) => void;

let registration: ServiceWorkerRegistration | null = null;
let waitingWorker: ServiceWorker | null = null;
let activationRequested = false;
let started = false;
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

/** Registers the module worker once and leaves an update waiting for explicit activation. */
export async function registerJournalServiceWorker(): Promise<void> {
  if (started || !import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  started = true;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!activationRequested) return;
    activationRequested = false;
    window.location.reload();
  });

  registration = await navigator.serviceWorker.register('/sw.js', {
    scope: '/',
    type: 'module',
  });

  if (registration.waiting && navigator.serviceWorker.controller) {
    waitingWorker = registration.waiting;
    emit({ updateReady: true });
  }

  if (registration.installing) observeInstallingWorker(registration.installing);
  registration.addEventListener('updatefound', () => {
    if (registration?.installing) observeInstallingWorker(registration.installing);
  });

  await navigator.serviceWorker.ready;
  emit({ offlineReady: true });
}

export function subscribePwaRegistration(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export async function checkForJournalUpdate(): Promise<void> {
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
