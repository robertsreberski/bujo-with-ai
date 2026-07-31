import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openJournal } from './helpers';

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
