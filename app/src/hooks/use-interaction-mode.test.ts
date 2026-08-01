// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getInteractionMode, useInteractionMode } from './use-interaction-mode';

type Handler = (event: MediaQueryListEvent) => void;

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

/** A `(pointer: coarse)` query the test can flip, plus its listener count. */
const installMatchMedia = (initial: boolean) => {
  const handlers = new Set<Handler>();
  let matches = initial;
  const query = {
    get matches() {
      return matches;
    },
    media: '(pointer: coarse)',
    onchange: null,
    addEventListener: (_type: string, handler: Handler) => void handlers.add(handler),
    removeEventListener: (_type: string, handler: Handler) => void handlers.delete(handler),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => query as unknown as MediaQueryList),
  });
  return {
    get listeners() {
      return handlers.size;
    },
    emit(next: boolean) {
      matches = next;
      for (const handler of handlers) handler({ matches: next } as MediaQueryListEvent);
    },
  };
};

afterEach(() => {
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
});

describe('useInteractionMode', () => {
  it('reports the pointer the query matches', () => {
    installMatchMedia(true);
    expect(renderHook(() => useInteractionMode()).result.current).toBe('coarse');
  });

  it('follows a pointer change and unsubscribes on unmount', () => {
    const query = installMatchMedia(false);
    const { result, unmount } = renderHook(() => useInteractionMode());
    expect(result.current).toBe('fine');
    expect(query.listeners).toBe(1);

    act(() => query.emit(true));
    expect(result.current).toBe('coarse');

    act(() => query.emit(false));
    expect(result.current).toBe('fine');

    unmount();
    expect(query.listeners).toBe(0);
  });

  it('falls back to fine where the environment has no matchMedia', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    expect(getInteractionMode()).toBe('fine');
    expect(renderHook(() => useInteractionMode()).result.current).toBe('fine');
  });
});

describe('getInteractionMode', () => {
  it('reads the pointer once, outside React', () => {
    installMatchMedia(true);
    expect(getInteractionMode()).toBe('coarse');
    installMatchMedia(false);
    expect(getInteractionMode()).toBe('fine');
  });
});
