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
    await expectNoAxeViolations(page, `${viewport.label} Today`);

    for (const view of ['Month', 'Index', 'Review']) {
      await page.getByRole('button', { name: view, exact: true }).click();
      await expectNoAxeViolations(page, `${viewport.label} ${view}`);
    }

    await page.getByRole('button', { name: 'Assistant access', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Assistant access' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('opacity', '1');
    await expectNoAxeViolations(page, `${viewport.label} Assistant access dialog`);
    await page.keyboard.press('Escape');
  }
});

test('the capture suggestion panel and the entry sheet pass the same smoke', async ({
  baseURL,
  browser,
  page,
}) => {
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

  const touchContext = await browser.newContext({
    baseURL: baseURL!,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 375, height: 812 },
  });
  const phone = await touchContext.newPage();
  try {
    await phone.emulateMedia({ reducedMotion: 'reduce' });
    await openJournal(phone);
    const text = uniqueText('Axe sheet entry');
    await phone.getByRole('combobox', { name: 'Add an entry' }).fill(`- ${text}`);
    await phone.getByRole('button', { name: 'Add entry' }).click();
    await phone.locator('.entry-row__content').filter({ hasText: text }).click();
    const sheet = phone.locator('.entry-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveCSS('opacity', '1');
    await settle(phone, '.entry-sheet');
    await expectNoAxeViolations(phone, '375px entry sheet');
  } finally {
    await touchContext.close();
  }
});
