import { expect, test, type Page } from '@playwright/test';
import { openJournal, uniqueText } from './helpers';

declare global {
  interface Window {
    /** Pixels the fake soft keyboard steals from the visual viewport. */
    __journalKeyboardInset?: number;
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
 * Shadows `visualViewport.height` with a subtractable inset so the real
 * `use-viewport-layout` hook computes `keyboard-open` from its own inputs.
 * Writing `--vv-*` and the class straight onto `<html>` instead would be a test
 * that only proves CSS reads variables — and would be undone by the hook's next
 * scheduled measurement anyway.
 */
async function installKeyboardEmulation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const prototype = Object.getPrototypeOf(viewport) as object;
    const height = Object.getOwnPropertyDescriptor(prototype, 'height')?.get;
    if (!height) return;
    window.__journalKeyboardInset = 0;
    Object.defineProperty(viewport, 'height', {
      configurable: true,
      get(this: VisualViewport) {
        return Number(height.call(this)) - (window.__journalKeyboardInset ?? 0);
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
