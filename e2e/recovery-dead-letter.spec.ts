import { expect, test, type Locator, type Page } from '@playwright/test';

import { openJournal, uniqueText } from './helpers';

async function waitForCanonicalEntry(page: Page, text: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async (entryText) => {
        const response = await fetch('/api/bootstrap');
        if (!response.ok) return false;
        const body = (await response.json()) as { entries?: Array<{ text?: string }> };
        return body.entries?.some((entry) => entry.text === entryText) ?? false;
      }, text),
    )
    .toBe(true);
}

async function editEntry(page: Page, currentText: string, nextText: string): Promise<void> {
  const row = page.locator('[data-entry-id]').filter({ hasText: currentText });
  await expect(row).toBeVisible();
  await row.locator('.entry-row__content').click();

  const detail = page.getByRole('dialog', { name: currentText });
  await detail.getByRole('button', { name: 'Edit', exact: true }).click();

  const editor = page.getByRole('dialog', { name: 'Edit entry' });
  await editor.getByRole('textbox', { name: 'Text', exact: true }).fill(nextText);
  await editor.getByRole('button', { name: 'Save changes' }).click();
}

function attentionButton(page: Page): Locator {
  return page.getByRole('button', {
    name: /1 change need attention.*Open recovery/i,
  });
}

async function openRecovery(page: Page): Promise<Locator> {
  await attentionButton(page).click();
  const recovery = page.getByRole('dialog', { name: 'Recovery' });
  await expect(recovery).toBeVisible();
  return recovery;
}

async function reloadJournal(page: Page): Promise<void> {
  await page.reload();
  await expect(page.locator('#journal-content')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Add an entry' })).toBeVisible();
}

test('Recovery persists permanent update failures and resolves them by retry or discard', async ({
  page,
}) => {
  await openJournal(page);

  const originalText = uniqueText('Recovery canonical entry');
  const retriedText = uniqueText('Recovery retried change');
  const discardedText = uniqueText('Recovery discarded change');

  await page.getByRole('combobox', { name: 'Add an entry' }).fill(`. ${originalText}`);
  await page.getByRole('button', { name: 'Add entry' }).click();

  const originalRow = page.locator('[data-entry-id]').filter({ hasText: originalText });
  await expect(originalRow).toBeVisible();
  await waitForCanonicalEntry(page, originalText);

  const entryId = await originalRow.getAttribute('data-entry-id');
  expect(entryId).toBeTruthy();

  let failuresRemaining = 0;
  let interceptedFailures = 0;
  await page.route(`**/api/entries/${entryId}`, async (route) => {
    if (route.request().method() !== 'PATCH' || failuresRemaining === 0) {
      await route.continue();
      return;
    }

    failuresRemaining -= 1;
    interceptedFailures += 1;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'revision_conflict',
          message: 'The entry changed first.',
        },
      }),
    });
  });

  failuresRemaining = 1;
  await editEntry(page, originalText, retriedText);
  await expect.poll(() => interceptedFailures).toBe(1);
  await expect(attentionButton(page)).toBeVisible();
  await expect(page.locator(`[data-entry-id="${entryId}"]`)).toContainText(originalText);

  // The failed mutation survives a full app reload before the owner resolves it.
  await reloadJournal(page);
  await expect(attentionButton(page)).toBeVisible();

  let recovery = await openRecovery(page);
  let failedChange = recovery.locator('article').filter({ hasText: retriedText });
  await expect(failedChange).toContainText('Update entry');
  await expect(failedChange).toContainText('The entry changed first.');
  await expect(failedChange).toContainText('revision_conflict');

  await failedChange.getByRole('button', { name: 'Open entry' }).click();
  const canonicalDetail = page.getByRole('dialog', { name: originalText });
  await expect(canonicalDetail).toBeVisible();
  await canonicalDetail.getByRole('button', { name: 'Close dialog' }).click();

  recovery = await openRecovery(page);
  failedChange = recovery.locator('article').filter({ hasText: retriedText });
  await failedChange.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Retry queued' })).toBeVisible();
  await expect(recovery.getByText('Every local change is accounted for.')).toBeVisible();
  await waitForCanonicalEntry(page, retriedText);
  await recovery.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.locator(`[data-entry-id="${entryId}"]`)).toContainText(retriedText);
  await expect(attentionButton(page)).toHaveCount(0);

  failuresRemaining = 1;
  await editEntry(page, retriedText, discardedText);
  await expect.poll(() => interceptedFailures).toBe(2);
  await expect(attentionButton(page)).toBeVisible();

  recovery = await openRecovery(page);
  failedChange = recovery.locator('article').filter({ hasText: discardedText });
  await failedChange.getByRole('button', { name: 'Discard…' }).click();

  const confirmation = page.getByRole('dialog', { name: 'Discard this failed change?' });
  await expect(confirmation).toContainText(
    'The attempted content will be removed from this device.',
  );
  await confirmation.getByRole('button', { name: 'Discard failed change' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Failed change discarded' }),
  ).toBeVisible();
  await expect(recovery.getByText('Every local change is accounted for.')).toBeVisible();
  await recovery.getByRole('button', { name: 'Close dialog' }).click();

  // Discard is durable too: only the last canonical text returns after hydration.
  await reloadJournal(page);
  await expect(attentionButton(page)).toHaveCount(0);
  await expect(page.locator(`[data-entry-id="${entryId}"]`)).toContainText(retriedText);
  await expect(page.getByText(discardedText, { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: 'Open recovery' })
    .click();
  recovery = page.getByRole('dialog', { name: 'Recovery' });
  await expect(recovery.getByText('Every local change is accounted for.')).toBeVisible();
});
