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

interface FieldEvidence {
  composerHeightVariable: number;
  /** The four-line ceiling, derived from the field's own type — not a literal. */
  fieldCap: number;
  fieldClientWidth: number;
  fieldHeight: number;
  fieldScrollWidth: number;
  panelBottom: number | null;
  shellBottom: number;
  shellHeight: number;
  shellTop: number;
  visibleBottom: number;
}

async function readField(page: Page): Promise<FieldEvidence> {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const field = document.querySelector('.composer__input');
    const shell = document.querySelector('.composer-shell');
    const panel = document.querySelector('.composer-suggestions');
    const viewport = window.visualViewport;
    if (!field || !shell || !viewport) throw new Error('The composer field is not mounted.');
    const styles = getComputedStyle(field);
    const parse = (value: string): number => {
      const parsed = Number.parseFloat(value);
      if (!Number.isFinite(parsed)) throw new Error(`The field reports no metric: "${value}".`);
      return parsed;
    };
    const shellBox = shell.getBoundingClientRect();
    return {
      composerHeightVariable: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--composer-height'),
      ),
      fieldCap:
        parse(styles.lineHeight) * 4 +
        parse(styles.paddingTop) +
        parse(styles.paddingBottom) +
        parse(styles.borderTopWidth) +
        parse(styles.borderBottomWidth),
      fieldClientWidth: field.clientWidth,
      fieldHeight: field.getBoundingClientRect().height,
      fieldScrollWidth: field.scrollWidth,
      panelBottom:
        panel === null || (panel as HTMLElement).hidden
          ? null
          : panel.getBoundingClientRect().bottom,
      shellBottom: shellBox.bottom,
      shellHeight: shellBox.height,
      shellTop: shellBox.top,
      visibleBottom: viewport.offsetTop + viewport.height,
    };
  });
}

/**
 * LOG-56. A long capture is ordinary, so the field wraps and grows with it —
 * and everything the docked composer promises has to survive the growth: it
 * stops at four lines rather than eating the screen, the measured
 * `--composer-height` follows it (PWA-15a), the shell stays flush with the
 * keyboard's top edge (PWA-15), and the suggestion panel keeps riding the
 * shell's top edge (PWA-17a) instead of being left behind over the draft.
 */
test('a long draft grows the composer without unpinning it or its suggestion panel', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installKeyboardEmulation(page);
  await openJournal(page);

  const html = page.locator('html');
  const input = page.getByRole('combobox', { name: 'Add an entry' });
  const panel = page.locator('.composer-shell [role="listbox"]');
  // ~200 characters of plain words: no sigil, so only the wrap is under test.
  const long = 'the quiet capture that just keeps going and going '.repeat(4).trim();

  await input.focus();
  await setKeyboardInset(page, KEYBOARD_INSET);
  await expect(html).toHaveClass(/keyboard-open/);
  await expect(page.locator('.composer-shell')).toHaveCSS('position', 'fixed');

  // The one-line baseline, and the gap the panel keeps above the shell.
  await input.fill('>');
  await expect(panel).toBeVisible();
  const short = await readField(page);
  expect(short.panelBottom).not.toBeNull();
  const panelGap = short.shellTop - (short.panelBottom ?? 0);
  expect(panelGap).toBeGreaterThan(0);
  expect(short.fieldHeight).toBeLessThanOrEqual(short.fieldCap);

  await input.fill(long);
  await expect(panel).toBeHidden();
  // The measurement lands on a frame behind the resize observation.
  await expect
    .poll(async () => (await readField(page)).composerHeightVariable)
    .toBeGreaterThan(short.composerHeightVariable);

  const grown = await readField(page);
  expect(grown.fieldHeight).toBeGreaterThan(short.fieldHeight);
  expect(grown.shellHeight).toBeGreaterThan(short.shellHeight);
  // Four lines is the ceiling; past it the field takes the scroll itself.
  expect(grown.fieldHeight).toBeLessThanOrEqual(grown.fieldCap + 1);
  expect(grown.composerHeightVariable).toBeCloseTo(grown.shellHeight, 0);
  // The whole point of the pin: a taller composer still ends where the keyboard
  // begins, growing upward into the day list rather than under the keyboard.
  expect(grown.shellBottom).toBeCloseTo(grown.visibleBottom, 0);
  await expect(html).toHaveClass(/keyboard-open/);

  await input.fill(`${long} >`);
  await expect(panel).toBeVisible();
  const anchored = await readField(page);
  expect(anchored.panelBottom).not.toBeNull();
  // Still glued to the shell's top edge, by the same gap, over a field three
  // lines taller than the one it was measured against.
  expect(anchored.shellTop - (anchored.panelBottom ?? 0)).toBeCloseTo(panelGap, 0);
  expect(anchored.shellBottom).toBeCloseTo(anchored.visibleBottom, 0);

  // A 200-character token with nothing to break on — a pasted URL — wraps too.
  // Sideways scrolling is what the growth exists to replace, so there must be
  // none of it left anywhere in the field.
  await input.fill('x'.repeat(200));
  const unbroken = await readField(page);
  expect(unbroken.fieldHeight).toBeGreaterThan(short.fieldHeight);
  expect(unbroken.fieldScrollWidth).toBeLessThanOrEqual(unbroken.fieldClientWidth);
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
