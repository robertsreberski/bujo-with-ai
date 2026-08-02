const INSTALL_GUIDANCE_KEY = 'journal-install-guidance-v1';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export type InstallGuidance =
  | { kind: 'prompt'; install: () => Promise<'accepted' | 'dismissed' | 'unavailable'> }
  | { kind: 'ios' };

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let listenerCount = 0;
let offeredWithoutStorage = false;

const isStandalone = (): boolean =>
  (typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches) ||
  Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

const isIosSafari = (): boolean => {
  const userAgent = navigator.userAgent;
  const iosDevice = /iPad|iPhone|iPod/.test(userAgent);
  const iPadOs = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const alternateBrowser = /CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent);
  return (iosDevice || iPadOs) && /Safari/.test(userAgent) && !alternateBrowser;
};

const wasOffered = (): boolean => {
  try {
    return window.localStorage.getItem(INSTALL_GUIDANCE_KEY) === 'offered';
  } catch {
    return offeredWithoutStorage;
  }
};

const markOffered = (): void => {
  offeredWithoutStorage = true;
  try {
    window.localStorage.setItem(INSTALL_GUIDANCE_KEY, 'offered');
  } catch {
    // Private browsing and locked-down webviews can deny storage. The in-memory
    // marker still prevents a repeated prompt during this visit.
  }
};

const onBeforeInstallPrompt = (event: Event): void => {
  if (isStandalone() || wasOffered()) return;
  event.preventDefault();
  deferredPrompt = event as BeforeInstallPromptEvent;
};

const onAppInstalled = (): void => {
  deferredPrompt = null;
  markOffered();
};

/**
 * Retains the browser's one-shot install event until a successful capture gives
 * the suggestion context. Multiple React mounts share one pair of listeners.
 */
export function observeJournalInstallGuidance(): () => void {
  listenerCount += 1;
  if (listenerCount === 1) {
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
  }
  return () => {
    listenerCount = Math.max(0, listenerCount - 1);
    if (listenerCount !== 0) return;
    window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.removeEventListener('appinstalled', onAppInstalled);
  };
}

/**
 * Claims guidance once. Callers deliberately invoke this only after a journal
 * entry has been accepted, never on page load or before the owner has found
 * value in the app.
 */
export function claimJournalInstallGuidance(): InstallGuidance | null {
  if (isStandalone() || wasOffered()) return null;

  if (deferredPrompt) {
    const prompt = deferredPrompt;
    deferredPrompt = null;
    markOffered();
    return {
      kind: 'prompt',
      install: async () => {
        try {
          await prompt.prompt();
          return (await prompt.userChoice).outcome;
        } catch {
          return 'unavailable';
        }
      },
    };
  }

  if (isIosSafari()) {
    markOffered();
    return { kind: 'ios' };
  }
  return null;
}
