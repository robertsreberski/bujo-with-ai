import { useEffect, type RefObject } from 'react';

const GEOMETRY_VARIABLES = ['--composer-height', '--pane-left', '--pane-width'] as const;

export interface ChromeElements {
  pane: HTMLElement | null;
  composer: HTMLElement | null;
}

export interface ChromeGeometryController {
  measure(): void;
  schedule(): void;
  stop(): void;
}

const cssPixels = (value: number): string => `${Math.round(value * 100) / 100}px`;

/**
 * Publishes the chrome geometry CSS cannot derive on its own:
 * `--composer-height` (the docked composer's rendered height) and
 * `--pane-left`/`--pane-width` (the main pane's horizontal box).
 *
 * Both exist because the keyboard-open composer is `position: fixed`. Fixed
 * boxes resolve against the viewport, so without the pane box the composer
 * spans the full window on the wide (sidebar) layout — visible as a composer
 * running under the sidebar on iPad — and the day list has to guess how much
 * bottom padding the composer needs.
 */
export function createChromeGeometryController(
  read: () => ChromeElements,
): ChromeGeometryController {
  const root = document.documentElement;
  let stopped = false;
  let frame = 0;

  const measure = (): void => {
    if (stopped) return;
    const { pane, composer } = read();
    if (composer) root.style.setProperty('--composer-height', cssPixels(composer.offsetHeight));
    if (pane) {
      const box = pane.getBoundingClientRect();
      root.style.setProperty('--pane-left', cssPixels(box.left));
      root.style.setProperty('--pane-width', cssPixels(box.width));
    }
  };

  // Resize observations and window events arrive in bursts (one per animated
  // frame of a rotation or keyboard slide); collapse each burst into one write.
  const schedule = (): void => {
    if (stopped || frame !== 0) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      measure();
    });
  };

  // border-box: the keyboard transition only changes the composer's bottom
  // padding (`--sab` → 0), which a content-box observation never sees.
  const observer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
  const observed = read();
  if (observed.pane) observer?.observe(observed.pane, { box: 'border-box' });
  if (observed.composer) observer?.observe(observed.composer, { box: 'border-box' });
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  // iOS keyboard slides resize only the visual viewport, not the window.
  window.visualViewport?.addEventListener('resize', schedule);
  measure();

  return {
    measure,
    schedule,
    stop: () => {
      stopped = true;
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      for (const name of GEOMETRY_VARIABLES) root.style.removeProperty(name);
    },
  };
}

export function useChromeGeometry(
  paneRef: RefObject<HTMLElement | null>,
  composerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const controller = createChromeGeometryController(() => ({
      pane: paneRef.current,
      composer: composerRef.current,
    }));
    return () => controller.stop();
  }, [composerRef, paneRef]);
}
