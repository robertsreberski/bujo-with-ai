import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openJournal, uniqueText } from './helpers';

const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('the 375px touch entry sheet passes the WCAG 2.2 A/AA smoke', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openJournal(page);
  const text = uniqueText('Axe sheet entry');
  await page.getByRole('combobox', { name: 'Add an entry' }).fill(`- ${text}`);
  await page.getByRole('button', { name: 'Add entry' }).click();
  await page.locator('.entry-row__content').filter({ hasText: text }).click();
  const sheet = page.locator('.entry-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveCSS('opacity', '1');
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
  expect(
    results.violations.map((violation) => ({
      help: violation.help,
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    })),
    '375px entry sheet has WCAG A/AA violations',
  ).toEqual([]);
});
