import { expect, test, type Locator, type Page } from '@playwright/test';
import { openJournal, uniqueText } from './helpers';

/** The pointer decides the entry surface, so the test asks the page, not the project. */
async function isCoarsePointer(page: Page): Promise<boolean> {
  return page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
}

/** The row's own content button — its accessible name also carries any badges. */
function entryRow(page: Page, text: string): Locator {
  return page.locator('.entry-row__content').filter({ hasText: text });
}

async function captureEntry(page: Page, draft: string, text: string): Promise<Locator> {
  await page.getByRole('combobox', { name: 'Add an entry' }).fill(draft);
  await page.getByRole('button', { name: 'Add entry' }).click();
  const row = entryRow(page, text);
  await expect(row).toBeVisible();
  return row;
}

/** DS-14/PWA-18: every row the sheet offers is a thumb target, not a mouse one. */
async function expectSheetRowsAreThumbSized(page: Page): Promise<void> {
  const rows = page.locator('.entry-sheet button:not([disabled]), .entry-sheet summary');
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (const row of await rows.all()) {
    if (!(await row.isVisible())) continue;
    const label = await row.evaluate(
      (element) =>
        element.getAttribute('aria-label') ??
        element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 40) ??
        'row',
    );
    const box = await row.boundingBox();
    expect(box?.height, `sheet row "${label}" height`).toBeGreaterThanOrEqual(40);
    expect(box?.width, `sheet row "${label}" width`).toBeGreaterThanOrEqual(40);
  }
}

test('a coarse pointer opens the entry as a bottom sheet with thumb-sized rows', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openJournal(page);
  test.skip(!(await isCoarsePointer(page)), 'The sheet is the coarse-pointer surface.');

  const taskText = uniqueText('Sheet task');
  const row = await captureEntry(page, `. ${taskText}`, taskText);
  await row.click();

  const sheet = page.getByRole('dialog', { name: taskText });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveClass(/entry-sheet/);
  await expect(page.getByRole('dialog')).toHaveCount(1);

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const frameBox = await page.locator('.app-frame').boundingBox();
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox).not.toBeNull();
  // Anchored to the viewport bottom and as wide as the frame it belongs to.
  expect((sheetBox?.y ?? 0) + (sheetBox?.height ?? 0)).toBeCloseTo(viewport?.height ?? 0, 0);
  expect(sheetBox?.x).toBeCloseTo(frameBox?.x ?? 0, 0);
  expect(sheetBox?.width).toBeCloseTo(frameBox?.width ?? 0, 0);

  await expectSheetRowsAreThumbSized(page);
  // Filing is a property of the entry, so an open task is offered it too.
  await expect(sheet.getByRole('button', { name: 'File in collection' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Mark done' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'To monthly log' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('delete and edit swap the sheet face instead of stacking another dialog', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openJournal(page);
  test.skip(!(await isCoarsePointer(page)), 'The sheet is the coarse-pointer surface.');

  // A note rather than a task: only non-actionable types offer Delete.
  const noteText = uniqueText('Sheet note');
  const row = await captureEntry(page, `- ${noteText}`, noteText);
  await row.click();
  const sheet = page.locator('.entry-sheet');
  await expect(sheet).toBeVisible();

  await sheet.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete this entry?' })).toBeVisible();
  // The confirmation is the same surface, repainted: still exactly one dialog.
  await expect(page.getByRole('dialog')).toHaveCount(1);
  const confirmBox = await sheet.boundingBox();
  expect((confirmBox?.y ?? 0) + (confirmBox?.height ?? 0)).toBeCloseTo(
    page.viewportSize()?.height ?? 0,
    0,
  );
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog', { name: noteText })).toBeVisible();

  await sheet.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit entry' })).toBeVisible();
  const text = sheet.getByRole('textbox').first();
  await expect(text).toHaveValue(noteText);
  await expect(sheet.getByRole('button', { name: 'Save changes' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);

  // The scrim is the other way out, and it dismisses the whole sheet.
  await page.locator('.entry-sheet__scrim').click({ position: { x: 8, y: 8 } });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row).toBeVisible();
});

test('the sheet names the month it would file into on the month spread', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openJournal(page);
  test.skip(!(await isCoarsePointer(page)), 'The sheet is the coarse-pointer surface.');

  /*
   * Off the current month the schedule action names its target rather than
   * saying "monthly log", which would file somewhere the owner is not looking.
   * The expected name is computed from the two spread headings — both read
   * before the modal sheet takes the background out of the accessibility tree —
   * rather than pattern-matched, because the label mirrors `monthName`: bare
   * inside the current year, year-qualified across a boundary. Every January,
   * where "Previous month" lands in the year before, fails a `/^To \S+ log$/`.
   * The years come from the app's own headings, never the runner's clock.
   */
  const monthYear = (name: string): [string, string] => {
    const parsed = /^(\S+) (\d{4}) monthly log$/.exec(name);
    expect(parsed, `the month spread names its month and year: "${name}"`).not.toBeNull();
    return [parsed?.[1] ?? '', parsed?.[2] ?? ''];
  };

  await page.getByRole('button', { name: /^Month/ }).click();
  const spread = page.getByRole('region', { name: /monthly log$/ });
  await expect(spread).toBeVisible();
  const currentName = (await spread.getAttribute('aria-label')) ?? '';
  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(spread).not.toHaveAttribute('aria-label', currentName);

  const [browsedMonth, browsedYear] = monthYear((await spread.getAttribute('aria-label')) ?? '');
  const [, currentYear] = monthYear(currentName);
  const scheduleName =
    browsedYear === currentYear
      ? `To ${browsedMonth} log`
      : `To ${browsedMonth} ${browsedYear} log`;

  // The composer's screen default on this spread is the browsed month's log.
  const text = uniqueText('Previous month item');
  await expect(page.getByRole('button', { name: /^Destination:/ })).toBeVisible();
  const row = await captureEntry(page, `. ${text}`, text);

  await row.click();
  const sheet = page.locator('.entry-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: scheduleName })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'To monthly log' })).toHaveCount(0);
});

test('a fine pointer opens the same entry as the centred dialog', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openJournal(page);
  test.skip(await isCoarsePointer(page), 'The dialog is the fine-pointer surface.');

  const text = uniqueText('Dialog entry');
  const row = await captureEntry(page, `. ${text}`, text);
  await row.click();

  const dialog = page.getByRole('dialog', { name: text });
  await expect(dialog).toBeVisible();
  await expect(page.locator('.entry-sheet')).toHaveCount(0);
  await expect(dialog).toHaveClass(/dialog-panel/);

  const overlayBox = await page.locator('.dialog-overlay').boundingBox();
  const dialogBox = await dialog.boundingBox();
  const overlayCentre = (overlayBox?.y ?? 0) + (overlayBox?.height ?? 0) / 2;
  const dialogCentre = (dialogBox?.y ?? 0) + (dialogBox?.height ?? 0) / 2;
  expect(Math.abs(dialogCentre - overlayCentre)).toBeLessThanOrEqual(1);
  expect((dialogBox?.y ?? 0) + (dialogBox?.height ?? 0)).toBeLessThan(
    (page.viewportSize()?.height ?? 0) - 8,
  );
});
