import { useEffect } from 'react';

const TEXT_INPUT_TYPES = new Set([
  '',
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
]);

export function isTextEntryTarget(target: Element | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  return target.isContentEditable;
}

export interface ViewportLayoutController {
  measure(): void;
  schedule(resume?: boolean): void;
  stop(): void;
}

export function createViewportLayoutController(): ViewportLayoutController {
  const root = document.documentElement;
  const visualViewport = window.visualViewport;
  const timers = new Set<number>();
  let stopped = false;
  let offsetFrame = 0;
  let lastLayoutHeight = Math.max(window.innerHeight, root.clientHeight, 1);
  // Shared by both writers so neither skips a write the other already made —
  // and cleared whenever the property is removed.
  let lastOffset = '';

  const writeOffset = (offset: number): void => {
    const value = `${offset}px`;
    if (value === lastOffset) return;
    lastOffset = value;
    root.style.setProperty('--vv-offset', value);
  };

  const measure = (): void => {
    if (stopped) return;
    const measuredLayoutHeight = Math.max(window.innerHeight, root.clientHeight);
    if (measuredLayoutHeight > 0) lastLayoutHeight = measuredLayoutHeight;

    const measuredVisibleHeight = visualViewport?.height ?? lastLayoutHeight;
    const visibleHeight =
      measuredVisibleHeight > 0 ? measuredVisibleHeight : Math.max(lastLayoutHeight, 1);
    const visibleOffset = Math.max(visualViewport?.offsetTop ?? 0, 0);
    const keyboardOpen =
      lastLayoutHeight - visibleHeight > 150 && isTextEntryTarget(document.activeElement);
    const wasKeyboardOpen = root.classList.contains('keyboard-open');

    root.style.setProperty('--app-height', `${lastLayoutHeight}px`);
    root.style.setProperty('--vv-height', `${visibleHeight}px`);
    writeOffset(visibleOffset);
    root.classList.toggle('keyboard-open', keyboardOpen);

    if (wasKeyboardOpen && !keyboardOpen) {
      // Reading layout forces WebKit to release the stale keyboard-sized flex frame.
      void root.offsetHeight;
    }
  };

  const clearTimers = (): void => {
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
  };

  const schedule = (resume = false): void => {
    if (stopped) return;
    clearTimers();
    const delays = resume ? [0, 120, 200, 360, 720] : [0, 120, 360];
    for (const delay of delays) {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        measure();
      }, delay);
      timers.add(timer);
    }
  };

  /**
   * The offset-only half of `measure`: it reads `visualViewport.offsetTop` and
   * nothing else — no `innerHeight`, no `clientHeight`, no class toggle — so it
   * cannot force layout and cannot change what "keyboard open" means.
   */
  const measureOffset = (): void => {
    if (stopped) return;
    writeOffset(Math.max(visualViewport?.offsetTop ?? 0, 0));
  };

  // WebKit emits a burst of caret-reveal scrolls per keystroke; one write a frame.
  const scheduleOffset = (): void => {
    if (stopped || offsetFrame !== 0) return;
    offsetFrame = window.requestAnimationFrame(() => {
      offsetFrame = 0;
      measureOffset();
    });
  };

  const resetForResume = (): void => {
    root.classList.remove('keyboard-open');
    root.style.removeProperty('--app-height');
    root.style.removeProperty('--vv-height');
    root.style.removeProperty('--vv-offset');
    lastOffset = '';
    // Do not let the old CSS-pinned root height win after a rotation/resume.
    if (window.innerHeight > 0) lastLayoutHeight = window.innerHeight;
    schedule(true);
  };

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') resetForResume();
  };
  const onPageShow = (): void => resetForResume();
  /**
   * While the keyboard is up, a `visualViewport` scroll is a WebKit caret-reveal
   * nudge: only the offset moved, so only `--vv-offset` can be stale — and left
   * stale it displaces the `position: fixed` composer from where taps land. The
   * old code ignored the event outright because the full `measure` cascade
   * (three timers, each forcing a `clientHeight` read and a `keyboard-open`
   * toggle) fed its own relayout back in as more scrolls, which is what made the
   * composer jitter. Writing only the offset reads no layout and toggles no
   * class: it slides an already-composited box, so there is no loop to enter.
   */
  const onViewportScroll = (): void => {
    if (root.classList.contains('keyboard-open')) scheduleOffset();
    else schedule();
  };
  const onWindowChange = (): void => schedule();
  const onOrientationChange = (): void => resetForResume();

  window.addEventListener('resize', onWindowChange);
  window.addEventListener('orientationchange', onOrientationChange);
  window.addEventListener('focusin', onWindowChange);
  window.addEventListener('focusout', onWindowChange);
  window.addEventListener('pageshow', onPageShow);
  document.addEventListener('visibilitychange', onVisibility);
  visualViewport?.addEventListener('resize', onWindowChange);
  visualViewport?.addEventListener('scroll', onViewportScroll);
  schedule();

  return {
    measure,
    schedule,
    stop: () => {
      stopped = true;
      clearTimers();
      if (offsetFrame !== 0) window.cancelAnimationFrame(offsetFrame);
      offsetFrame = 0;
      window.removeEventListener('resize', onWindowChange);
      window.removeEventListener('orientationchange', onOrientationChange);
      window.removeEventListener('focusin', onWindowChange);
      window.removeEventListener('focusout', onWindowChange);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisibility);
      visualViewport?.removeEventListener('resize', onWindowChange);
      visualViewport?.removeEventListener('scroll', onViewportScroll);
    },
  };
}

export function useViewportLayout(): void {
  useEffect(() => {
    const controller = createViewportLayoutController();
    return () => controller.stop();
  }, []);
}
