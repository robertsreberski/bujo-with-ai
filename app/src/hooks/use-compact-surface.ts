import { useSyncExternalStore } from 'react';

const COMPACT = '(max-width: 679px)';

const compactQuery = (): MediaQueryList | null =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(COMPACT);

const subscribe = (onChange: () => void): (() => void) => {
  const query = compactQuery();
  if (query === null) return () => undefined;
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/**
 * True below the 680px shell breakpoint, where an anchored popover has no room
 * and a bottom sheet reads better. Deliberately phrased as `max-width` so the
 * server-and-jsdom fallback (`false`) is the anchored popover: the sheet needs a
 * real layout engine, the popover does not.
 */
export function useCompactSurface(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => compactQuery()?.matches ?? false,
    () => false,
  );
}
