import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openJournal, uniqueText } from './helpers';

const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoAxeViolations(page: Page, surface: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
  const violations = results.violations.map((violation) => ({
    help: violation.help,
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target),
  }));
  expect(violations, `${surface} has WCAG A/AA violations`).toEqual([]);
}

/**
 * axe reads composited colour, so a surface still fading in reports a contrast
 * failure the settled surface does not have. Reduced motion removes the
 * entrance outright; this drains anything left (vaul writes its own).
 */
async function settle(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

test('all primary surfaces and an open dialog pass the WCAG 2.2 A/AA smoke', async ({ page }) => {
  for (const viewport of [
    { label: 'desktop', width: 1_280, height: 900 },
    { label: '375px', width: 375, height: 812 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openJournal(page);
    await expectNoAxeViolations(page, `${viewport.label} Timeline`);

    for (const view of ['Month', 'Index', 'Activity']) {
      await page.getByRole('button', { name: view, exact: true }).click();
      await expectNoAxeViolations(page, `${viewport.label} ${view}`);
    }

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('opacity', '1');
    await expectNoAxeViolations(page, `${viewport.label} Settings dialog`);
    await dialog.getByRole('button', { name: 'Open recovery' }).click();
    const recovery = page.getByRole('dialog', { name: 'Recovery' });
    await expect(recovery).toBeVisible();
    await expect(recovery).toHaveCSS('opacity', '1');
    await expectNoAxeViolations(page, `${viewport.label} Recovery dialog`);
    await page.keyboard.press('Escape');
  }
});

test('the capture suggestion panel passes the same smoke', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openJournal(page);
  // Seed the mirror so the panel has something to complete. Re-entering `#`
  // mode re-derives the vocabulary from the mirror, so the tag this capture
  // introduces is offered on the very next token without a reload.
  const tag = `axe-${Math.random().toString(36).slice(2, 8)}`;
  const seeded = uniqueText('Axe seed');
  await page.getByRole('combobox', { name: 'Add an entry' }).fill(`- ${seeded} #${tag}`);
  await page.getByRole('button', { name: 'Add entry' }).click();
  await expect(page.getByText(seeded, { exact: true })).toBeVisible();
  await page.locator('.composer__input').fill(`- ${uniqueText('Axe suggestion')} #`);
  const panel = page.locator('.composer-shell [role="listbox"]');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveCSS('opacity', '1');
  await settle(page, '.composer-shell [role="listbox"]');
  await expectNoAxeViolations(page, 'desktop capture suggestions');

  // The `@` panel is the variant that also renders the grammar caption, which
  // is muted text on its own divided row — its own contrast question.
  await page.locator('.composer__input').fill(`- ${uniqueText('Axe time')} @`);
  await expect(page.locator('.composer-suggestions__hint')).toBeVisible();
  await expect(panel).toHaveCSS('opacity', '1');
  await settle(page, '.composer-suggestions');
  await expectNoAxeViolations(page, 'desktop capture suggestions with caption');
});

test('forced colors preserves selection, focus, and screen-reader names', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await openJournal(page);

  const timeline = page.locator('.sidebar').getByRole('button', { name: /^Timeline/ });
  await expect(timeline).toHaveAttribute('aria-current', 'page');
  await expect(timeline).toHaveCSS('outline-style', 'solid');

  const settings = page.locator('.sidebar').getByRole('button', { name: 'Settings', exact: true });
  await settings.focus();
  await expect(settings).toBeFocused();
  await expect(settings).toHaveCSS('outline-style', 'solid');
  await expect(timeline).toHaveAccessibleName(/^Timeline/);
  await expect(settings).toHaveAccessibleName('Settings');
});

test('200 percent zoom reflows to a 320px reading width without horizontal loss', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await openJournal(page);
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });

  await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Add an entry' })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  await expectNoAxeViolations(page, '200 percent zoom Timeline');
});
