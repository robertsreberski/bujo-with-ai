import { useSyncExternalStore } from 'react';

export type InteractionMode = 'coarse' | 'fine';

const COARSE_POINTER = '(pointer: coarse)';

const coarseQuery = (): MediaQueryList | null =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(COARSE_POINTER);

/**
 * Whether the primary pointer is a finger (`coarse`) or a mouse/trackpad
 * (`fine`). Read once, outside React — the hook below keeps a component in
 * sync instead.
 */
export function getInteractionMode(): InteractionMode {
  return coarseQuery()?.matches ? 'coarse' : 'fine';
}

const subscribe = (onChange: () => void): (() => void) => {
  const query = coarseQuery();
  if (!query) return () => undefined;
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/**
 * The live interaction mode. It is a media query rather than a width
 * breakpoint on purpose: an iPad in a wide layout still wants touch-sized
 * targets, and a narrow desktop window does not. The pointer can change under
 * a mounted tree (an iPad gaining a trackpad), so it is read as an external
 * store rather than captured once.
 */
export function useInteractionMode(): InteractionMode {
  return useSyncExternalStore(subscribe, getInteractionMode, () => 'fine');
}
