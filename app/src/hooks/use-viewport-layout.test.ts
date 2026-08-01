// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createViewportLayoutController } from './use-viewport-layout';

type TestViewport = EventTarget & { height: number; offsetTop: number };

const frames = new Map<number, FrameRequestCallback>();
let lastFrameHandle = 0;

/** Hand-run frames, so a scheduled offset write is observable before it lands. */
function stubAnimationFrames(): void {
  frames.clear();
  lastFrameHandle = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    lastFrameHandle += 1;
    frames.set(lastFrameHandle, callback);
    return lastFrameHandle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    frames.delete(handle);
  });
}

const flushFrames = (): void => {
  for (const [handle, frame] of [...frames]) {
    frames.delete(handle);
    frame(0);
  }
};

/** An 800px layout viewport with a caller-chosen visible box on top of it. */
function installViewport(visibleHeight: number, offsetTop: number): TestViewport {
  const viewport = new EventTarget() as TestViewport;
  viewport.height = visibleHeight;
  viewport.offsetTop = offsetTop;
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 0 });
  return viewport;
}

function focusTextEntry(): void {
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
}

afterEach(() => {
  // Before `useRealTimers`, so a faked frame API is never restored over a stub.
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  document.body.replaceChildren();
});

describe('viewport layout controller', () => {
  it('only treats a visual viewport shortfall as a keyboard for text focus', () => {
    vi.useFakeTimers();
    const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number };
    viewport.height = 500;
    viewport.offsetTop = 12;
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();

    const controller = createViewportLayoutController();
    controller.measure();
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--vv-height')).toBe('500px');
    expect(document.documentElement.style.getPropertyValue('--vv-offset')).toBe('12px');

    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    controller.measure();
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);
    controller.stop();
  });

  it('re-baselines the pinned app height across portrait and landscape rotations', () => {
    vi.useFakeTimers();
    let innerHeight = 812;
    const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number };
    viewport.height = innerHeight;
    viewport.offsetTop = 0;
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      get: () => innerHeight,
    });
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      get: () =>
        Number.parseInt(document.documentElement.style.getPropertyValue('--app-height'), 10) ||
        innerHeight,
    });

    const controller = createViewportLayoutController();
    vi.runAllTimers();
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('812px');

    innerHeight = 375;
    viewport.height = innerHeight;
    window.dispatchEvent(new Event('orientationchange'));
    vi.runAllTimers();
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('375px');

    innerHeight = 812;
    viewport.height = innerHeight;
    window.dispatchEvent(new Event('orientationchange'));
    vi.runAllTimers();
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('812px');
    controller.stop();
  });

  it('keeps the last good height through zero-valued resume samples', () => {
    vi.useFakeTimers();
    let innerHeight = 812;
    const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number };
    viewport.height = innerHeight;
    viewport.offsetTop = 0;
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      get: () => innerHeight,
    });
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      get: () => 0,
    });

    const controller = createViewportLayoutController();
    vi.runAllTimers();
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('812px');

    innerHeight = 0;
    viewport.height = 0;
    window.dispatchEvent(new Event('pageshow'));
    vi.advanceTimersByTime(720);
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('812px');
    expect(document.documentElement.style.getPropertyValue('--vv-height')).toBe('812px');

    innerHeight = 390;
    viewport.height = 390;
    window.dispatchEvent(new Event('resize'));
    vi.runAllTimers();
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('390px');
    controller.stop();
  });

  it('tracks a keyboard-open viewport scroll with an offset-only frame write', () => {
    vi.useFakeTimers();
    stubAnimationFrames();
    const viewport = installViewport(500, 12);
    focusTextEntry();

    const controller = createViewportLayoutController();
    vi.runAllTimers();
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--vv-offset')).toBe('12px');

    // Two caret-reveal nudges in one frame; WebKit emits them per keystroke.
    viewport.offsetTop = 48;
    viewport.dispatchEvent(new Event('scroll'));
    viewport.dispatchEvent(new Event('scroll'));
    expect(frames.size).toBe(1);
    // The measure cascade — the thing that used to jitter the composer — is
    // never scheduled from this path.
    expect(vi.getTimerCount()).toBe(0);

    flushFrames();
    expect(document.documentElement.style.getPropertyValue('--vv-offset')).toBe('48px');
    expect(document.documentElement.style.getPropertyValue('--vv-height')).toBe('500px');
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it('still runs the full measure cascade for a scroll while the keyboard is shut', () => {
    vi.useFakeTimers();
    stubAnimationFrames();
    const viewport = installViewport(800, 0);

    const controller = createViewportLayoutController();
    vi.runAllTimers();
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);

    viewport.height = 640;
    viewport.offsetTop = 20;
    viewport.dispatchEvent(new Event('scroll'));
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(3);

    vi.runAllTimers();
    expect(document.documentElement.style.getPropertyValue('--vv-height')).toBe('640px');
    expect(document.documentElement.style.getPropertyValue('--vv-offset')).toBe('20px');
    controller.stop();
  });

  it('cancels a pending offset frame when the controller stops', () => {
    vi.useFakeTimers();
    stubAnimationFrames();
    const viewport = installViewport(500, 12);
    focusTextEntry();

    const controller = createViewportLayoutController();
    vi.runAllTimers();

    viewport.offsetTop = 48;
    viewport.dispatchEvent(new Event('scroll'));
    expect(frames.size).toBe(1);

    controller.stop();
    expect(frames.size).toBe(0);
    flushFrames();
    expect(document.documentElement.style.getPropertyValue('--vv-offset')).toBe('12px');
  });
});
