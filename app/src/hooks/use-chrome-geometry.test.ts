// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChromeGeometryController } from './use-chrome-geometry';

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly targets = new Set<Element>();
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    TestResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  emit(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const frames: FrameRequestCallback[] = [];

const flushFrames = (): void => {
  for (const frame of frames.splice(0, frames.length)) frame(0);
};

function stubPane(left: number, width: number): HTMLElement {
  const pane = document.createElement('div');
  vi.spyOn(pane, 'getBoundingClientRect').mockImplementation(
    () => ({ left, width, right: left + width, top: 0, bottom: 0, height: 0 }) as DOMRect,
  );
  document.body.append(pane);
  return pane;
}

function stubComposer(height: number): HTMLElement {
  const composer = document.createElement('div');
  Object.defineProperty(composer, 'offsetHeight', { configurable: true, value: height });
  document.body.append(composer);
  return composer;
}

beforeEach(() => {
  TestResizeObserver.instances.length = 0;
  frames.length = 0;
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('style');
  document.body.replaceChildren();
});

describe('chrome geometry controller', () => {
  it('publishes the composer height and the pane box on mount', () => {
    const controller = createChromeGeometryController(() => ({
      pane: stubPane(236, 924),
      composer: stubComposer(85),
    }));

    const style = document.documentElement.style;
    expect(style.getPropertyValue('--composer-height')).toBe('85px');
    expect(style.getPropertyValue('--pane-left')).toBe('236px');
    expect(style.getPropertyValue('--pane-width')).toBe('924px');
    expect(TestResizeObserver.instances[0]?.targets.size).toBe(2);
    controller.stop();
  });

  it('coalesces observer and window bursts into a single frame write', () => {
    const pane = stubPane(0, 375);
    let composer = stubComposer(85);
    const controller = createChromeGeometryController(() => ({ pane, composer }));

    composer = stubComposer(61);
    TestResizeObserver.instances[0]?.emit();
    TestResizeObserver.instances[0]?.emit();
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('orientationchange'));

    expect(frames).toHaveLength(1);
    expect(document.documentElement.style.getPropertyValue('--composer-height')).toBe('85px');
    flushFrames();
    expect(document.documentElement.style.getPropertyValue('--composer-height')).toBe('61px');

    window.dispatchEvent(new Event('resize'));
    expect(frames).toHaveLength(1);
    controller.stop();
  });

  it('keeps measuring when only one of the two elements is mounted', () => {
    const controller = createChromeGeometryController(() => ({
      pane: null,
      composer: stubComposer(88.4),
    }));

    expect(document.documentElement.style.getPropertyValue('--composer-height')).toBe('88.4px');
    expect(document.documentElement.style.getPropertyValue('--pane-left')).toBe('');
    expect(TestResizeObserver.instances[0]?.targets.size).toBe(1);
    controller.stop();
  });

  it('drops the variables and its listeners on stop', () => {
    const pane = stubPane(0, 375);
    const composer = stubComposer(85);
    const controller = createChromeGeometryController(() => ({ pane, composer }));

    controller.stop();

    const style = document.documentElement.style;
    expect(style.getPropertyValue('--composer-height')).toBe('');
    expect(style.getPropertyValue('--pane-left')).toBe('');
    expect(style.getPropertyValue('--pane-width')).toBe('');
    expect(TestResizeObserver.instances[0]?.targets.size).toBe(0);

    window.dispatchEvent(new Event('resize'));
    TestResizeObserver.instances[0]?.emit();
    expect(frames).toHaveLength(0);
    flushFrames();
    expect(style.getPropertyValue('--composer-height')).toBe('');
  });
});
