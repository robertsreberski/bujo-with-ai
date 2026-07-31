// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createViewportLayoutController } from './use-viewport-layout';

afterEach(() => {
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
});
