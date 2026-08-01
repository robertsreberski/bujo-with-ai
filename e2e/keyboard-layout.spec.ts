import { expect, test, type Page } from '@playwright/test';
import { openJournal, uniqueText } from './helpers';

declare global {
  interface Window {
    /** Pixels the fake soft keyboard steals from the visual viewport. */
    __journalKeyboardInset?: number;
    /** Pixels WebKit's caret reveal has scrolled the visual viewport down by. */
    __journalViewportOffset?: number;
  }
}

/**
 * Comfortably past the hook's 150px keyboard threshold and close to a real iOS
 * keyboard, while still leaving the shortest project (chromium-mid, 900px) a
 * usable visible viewport.
 */
const KEYBOARD_INSET = 336;

interface LayoutEvidence {
  appHeight: number;
  composer: { bottom: number; height: number; left: number; position: string; right: number };
  contentPaddingBottom: number;
  composerHeightVariable: number;
  innerHeight: number;
  pane: { bottom: number; left: number; right: number };
  visibleHeight: number;
}

/**
 * Shadows `visualViewport.height` with a subtractable inset — and `offsetTop`
 * with an addable scroll — so the real `use-viewport-layout` hook computes
 * `keyboard-open` and `--vv-offset` from its own inputs. Writing `--vv-*` and
 * the class straight onto `<html>` instead would be a test that only proves CSS
 * reads variables — and would be undone by the hook's next scheduled
 * measurement anyway. Shadowing the getters (rather than the CSS) keeps the
 * scheduled cascade and the offset-only path agreeing on one set of numbers.
 */
async function installKeyboardEmulation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const prototype = Object.getPrototypeOf(viewport) as object;
    const height = Object.getOwnPropertyDescriptor(prototype, 'height')?.get;
    const offsetTop = Object.getOwnPropertyDescriptor(prototype, 'offsetTop')?.get;
    if (!height || !offsetTop) return;
    window.__journalKeyboardInset = 0;
    window.__journalViewportOffset = 0;
    Object.defineProperty(viewport, 'height', {
      configurable: true,
      get(this: VisualViewport) {
        return Number(height.call(this)) - (window.__journalKeyboardInset ?? 0);
      },
    });
    Object.defineProperty(viewport, 'offsetTop', {
      configurable: true,
      get(this: VisualViewport) {
        return Number(offsetTop.call(this)) + (window.__journalViewportOffset ?? 0);
      },
    });
  });
}

async function setKeyboardInset(page: Page, inset: number): Promise<void> {
  await page.evaluate((value) => {
    window.__journalKeyboardInset = value;
    window.visualViewport?.dispatchEvent(new Event('resize'));
  }, inset);
}

/** A caret-reveal nudge: the visible box slides down, its size unchanged. */
async function setViewportScroll(page: Page, offset: number): Promise<void> {
  await page.evaluate((value) => {
    window.__journalViewportOffset = value;
    window.visualViewport?.dispatchEvent(new Event('scroll'));
  }, offset);
}

/**
 * One synchronous read: a split read could straddle a scheduled re-measure. The
 * two frames in front of it let the rAF-throttled geometry write land, so the
 * snapshot describes the settled layout rather than a frame mid-transition.
 */
async function readLayout(page: Page): Promise<LayoutEvidence> {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const composer = document.querySelector('.composer-shell');
    const pane = document.querySelector('.main-pane');
    const content = document.querySelector('#journal-content');
    if (!composer || !pane || !content) throw new Error('The journal chrome is not mounted.');
    const composerBox = composer.getBoundingClientRect();
    const paneBox = pane.getBoundingClientRect();
    return {
      appHeight: Number.parseFloat(style.getPropertyValue('--app-height')),
      composer: {
        bottom: composerBox.bottom,
        height: composerBox.height,
        left: composerBox.left,
        position: getComputedStyle(composer).position,
        right: composerBox.right,
      },
      contentPaddingBottom: Number.parseFloat(getComputedStyle(content).paddingBottom),
      composerHeightVariable: Number.parseFloat(style.getPropertyValue('--composer-height')),
      innerHeight: window.innerHeight,
      pane: { bottom: paneBox.bottom, left: paneBox.left, right: paneBox.right },
      visibleHeight: Number.parseFloat(style.getPropertyValue('--vv-height')),
    };
  });
}

/**
 * Resolves once nothing has rewritten the root's `style`/`class` for a full
 * cascade window — i.e. the last scheduled measurement (0/120/360ms) has run.
 * Without it a scroll assertion proves nothing: a cascade still in flight from
 * the focus/resize before it would refresh `--vv-offset` on its own and hide a
 * scroll handler that ignores the event outright.
 */
async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(async (quietMs) => {
    await new Promise<void>((resolve) => {
      let timer = 0;
      const finish = (): void => {
        observer.disconnect();
        resolve();
      };
      const observer = new MutationObserver(() => {
        window.clearTimeout(timer);
        timer = window.setTimeout(finish, quietMs);
      });
      observer.observe(document.documentElement, { attributeFilter: ['class', 'style'] });
      timer = window.setTimeout(finish, quietMs);
    });
  }, 500);
}

interface PinEvidence {
  composer: { bottom: number; position: string };
  offsetVariable: number;
  visibleBottom: number;
  visibleHeight: number;
}

/** The fixed composer's geometry against the visible viewport it is pinned to. */
async function readPin(page: Page): Promise<PinEvidence> {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const composer = document.querySelector('.composer-shell');
    const viewport = window.visualViewport;
    if (!composer || !viewport) throw new Error('The pinned composer is not mounted.');
    return {
      composer: {
        bottom: composer.getBoundingClientRect().bottom,
        position: getComputedStyle(composer).position,
      },
      offsetVariable: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--vv-offset'),
      ),
      visibleBottom: viewport.offsetTop + viewport.height,
      visibleHeight: viewport.height,
    };
  });
}

/**
 * PWA-15/PWA-15a. The composer is `position: fixed` while the keyboard is up, so
 * it resolves against the *window* — everything that keeps it inside the pane
 * and above the keyboard is measured geometry, not layout. This is the contract
 * that regressed as a full-width composer running under the iPad sidebar.
 */
test('the keyboard-open composer pins to the pane box and the visible viewport bottom', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installKeyboardEmulation(page);
  await openJournal(page);

  const html = page.locator('html');
  const composer = page.locator('.composer-shell');
  const tabs = page.locator('.tab-list');

  const docked = await readLayout(page);
  expect(docked.composer.position).toBe('relative');
  expect(docked.composer.bottom).toBeCloseTo(docked.pane.bottom, 0);

  const input = page.getByRole('combobox', { name: 'Add an entry' });
  await input.focus();
  await setKeyboardInset(page, KEYBOARD_INSET);
  await expect(html).toHaveClass(/keyboard-open/);
  await expect(composer).toHaveCSS('position', 'fixed');
  await expect(tabs).toBeHidden();
  // The class lands from a timer and the composer measurement from a rAF, so
  // the derived padding is the last thing to settle.
  await expect.poll(async () => (await readLayout(page)).contentPaddingBottom).toBeGreaterThan(0);

  const open = await readLayout(page);
  expect(open.appHeight).toBeCloseTo(open.innerHeight, 0);
  expect(open.visibleHeight).toBeCloseTo(open.innerHeight - KEYBOARD_INSET, 0);
  // Horizontally the composer *is* the pane, so a sidebar can never sit under it.
  expect(open.composer.left).toBeCloseTo(open.pane.left, 1);
  expect(open.composer.right).toBeCloseTo(open.pane.right, 1);
  expect(open.composer.left).toBeGreaterThanOrEqual(0);
  // Flush with the visible viewport bottom: exactly the keyboard's top edge.
  expect(open.composer.bottom).toBeCloseTo(open.visibleHeight, 0);
  // PWA-15a: the day list's bottom padding is the measured composer, not a literal.
  expect(open.composerHeightVariable).toBeCloseTo(open.composer.height, 0);
  expect(open.contentPaddingBottom).toBeCloseTo(open.composerHeightVariable, 1);

  // The toast anchor derives from the same measurement, one 6px step above it.
  await input.fill(uniqueText('- Keyboard layout evidence'));
  await page.keyboard.press('Enter');
  const toastGap = await page.evaluate(async () => {
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      const toast = document.querySelector('.toast');
      const shell = document.querySelector('.composer-shell');
      if (toast && shell) {
        return shell.getBoundingClientRect().top - toast.getBoundingClientRect().bottom;
      }
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }
    return null;
  });
  expect(toastGap).not.toBeNull();
  expect(toastGap ?? 0).toBeCloseTo(6, 0);
  await expect(html).toHaveClass(/keyboard-open/);

  await setKeyboardInset(page, 0);
  await expect(html).not.toHaveClass(/keyboard-open/);
  await expect(composer).toHaveCSS('position', 'relative');

  const restored = await readLayout(page);
  expect(restored.visibleHeight).toBeCloseTo(restored.innerHeight, 0);
  expect(restored.composer.bottom).toBeCloseTo(restored.pane.bottom, 0);
  expect(restored.composer.left).toBeCloseTo(docked.composer.left, 1);
  expect(restored.contentPaddingBottom).toBe(0);
});

/**
 * LOG-49/PWA-19. A suggestion row is the one surface in the app that cannot wait
 * for a click: the panel suppresses `pointerdown` to keep the caret in the
 * input, and iOS answers a suppressed pointerdown by synthesizing the click
 * unreliably — the tap closed the panel and inserted nothing. The row accepts on
 * `pointerup` instead, and only a real touch tap can prove it, so this runs on
 * the WebKit touch projects and skips the mouse one.
 */
test('a tap on a suggestion row completes the capture and keeps the keyboard up', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, 'A synthesized click would prove nothing.');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installKeyboardEmulation(page);
  await openJournal(page);

  const html = page.locator('html');
  const input = page.getByRole('combobox', { name: 'Add an entry' });
  const panel = page.locator('.composer-shell [role="listbox"]');

  // `fill` leaves the caret at the end of the `>` token, and the rows resolve
  // against the server-synced `today` — no wall clock enters this test.
  await input.fill('- Pay rent >');
  await setKeyboardInset(page, KEYBOARD_INSET);
  await expect(html).toHaveClass(/keyboard-open/);
  await expect(panel).toBeVisible();

  await page.getByRole('option', { name: /^Tomorrow/ }).tap();

  await expect(input).toHaveValue('- Pay rent >tomorrow ');
  await expect(panel).toBeHidden();
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  // The tap resolved against the composer without ever taking focus off the
  // field, which is the difference between a keyboard that stays and a sheet
  // that collapses mid-capture.
  await expect(input).toBeFocused();
  await expect(html).toHaveClass(/keyboard-open/);
});

/**
 * PWA-14. WebKit scrolls the *visual* viewport to reveal the caret while the
 * keyboard is up. The composer's keyboard-open `bottom` is
 * `calc(100% - --vv-offset - --vv-height)`, so a stale offset paints it away
 * from where it is hit-tested — the on-device symptom was a composer that
 * jumped when the suggestion panel opened and then swallowed taps. The offset
 * has to follow the scroll, without the class toggle or layout read that made
 * the old code ignore these events.
 */
test('a caret-reveal scroll keeps the pinned composer on the visible viewport bottom', async ({
  page,
}) => {
  const CARET_SCROLL = 48;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installKeyboardEmulation(page);
  await openJournal(page);

  const html = page.locator('html');
  const composer = page.locator('.composer-shell');
  const input = page.getByRole('combobox', { name: 'Add an entry' });

  await input.focus();
  await setKeyboardInset(page, KEYBOARD_INSET);
  await expect(html).toHaveClass(/keyboard-open/);
  await expect(composer).toHaveCSS('position', 'fixed');
  // Every later assertion has to be the scroll's doing and nothing else.
  await settleLayout(page);
  expect((await readPin(page)).offsetVariable).toBe(0);

  await setViewportScroll(page, CARET_SCROLL);
  // The write lands on a frame, so poll the variable before reading geometry.
  await expect.poll(async () => (await readPin(page)).offsetVariable).toBe(CARET_SCROLL);

  const scrolled = await readPin(page);
  expect(scrolled.composer.bottom).toBeCloseTo(scrolled.visibleBottom, 0);
  // Tracking the offset is not allowed to cost the keyboard-open contract.
  expect(scrolled.composer.position).toBe('fixed');
  await expect(html).toHaveClass(/keyboard-open/);

  await setViewportScroll(page, 0);
  await expect.poll(async () => (await readPin(page)).offsetVariable).toBe(0);

  const settled = await readPin(page);
  expect(settled.composer.bottom).toBeCloseTo(settled.visibleHeight, 0);
  expect(settled.composer.position).toBe('fixed');
  await expect(html).toHaveClass(/keyboard-open/);
});
