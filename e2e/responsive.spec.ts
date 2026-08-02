import { expect, test } from '@playwright/test';
import { ulid } from 'ulid';
import { expectTouchTargets, openJournal, uniqueText } from './helpers';

function addCalendarDays(date: string, amount: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

test('the shell uses the approved narrow, mid, and wide layout at each breakpoint', async ({
  page,
}, testInfo) => {
  await openJournal(page);

  const frame = page.locator('.app-frame');
  const frameBox = await frame.boundingBox();
  expect(frameBox).not.toBeNull();
  const sidebar = page.locator('.sidebar');
  const tabs = page.locator('.tab-list');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

  if (testInfo.project.name === 'chromium-desktop') {
    expect(frameBox?.width).toBe(1_160);
    await expect(sidebar).toBeVisible();
    await expect(tabs).toBeHidden();
    await expect(page.locator('.app-header__desktop-title').first()).toBeVisible();
  } else if (testInfo.project.name === 'chromium-mid') {
    expect(frameBox?.width).toBe(680);
    await expect(sidebar).toBeHidden();
    await expect(tabs).toBeVisible();
  } else if (testInfo.project.name === 'chromium-tablet') {
    expect(frameBox?.width).toBe(834);
    await expect(sidebar).toBeHidden();
    await expect(tabs).toBeVisible();
  } else if (testInfo.project.name === 'chromium-landscape') {
    expect(frameBox?.width).toBe(812);
    await expect(sidebar).toBeHidden();
    await expect(tabs).toBeVisible();
  } else if (testInfo.project.name === 'webkit-iphone') {
    // Below 680px the frame is the viewport, so WebKit's 390px phone reports
    // 390 where Chromium's emulated 375px phone reports 375.
    expect(frameBox?.width).toBe(390);
    await expect(sidebar).toBeHidden();
    await expect(tabs).toBeVisible();
  } else {
    expect(frameBox?.width).toBe(375);
    await expect(sidebar).toBeHidden();
    await expect(tabs).toBeVisible();
  }

  /*
   * DS-14 control heights. Every touch project, including the tablet layout,
   * pays the 44px primary-target minimum. Pointer-precise layouts retain the
   * tighter desk metrics: 34px sidebar rows, 30px mid-layout tab segments, and
   * a 36px composer trio.
   */
  const isNarrow = testInfo.project.name === 'chromium-narrow';
  const isTouch = testInfo.project.use.hasTouch === true;
  const isPhone =
    isNarrow ||
    testInfo.project.name === 'chromium-short' ||
    testInfo.project.name === 'chromium-landscape' ||
    testInfo.project.name === 'webkit-iphone';
  const primaryMinimum = isTouch ? 44 : testInfo.project.name === 'chromium-desktop' ? 34 : 30;
  const composerMinimum = isTouch ? 44 : 36;

  // The untouched composer is one row. Focusing it restores the full capture
  // grammar without changing the owner's draft or filing path.
  const composerShell = page.locator('.composer-shell');
  await expect(composerShell).toHaveAttribute('data-expanded', 'false');
  await expect(page.getByRole('button', { name: /^Entry type:/ })).toHaveCount(0);

  // Scoped to the nav landmark, not the whole page: capture context has its own
  // control ramp once disclosed.
  const visiblePrimaryButtons = page
    .getByRole('navigation')
    .getByRole('button')
    .filter({ hasText: /^(Timeline|Month|Index|Activity)\s*(\d+\+?)?$/ });
  await expect(visiblePrimaryButtons).toHaveCount(4);
  for (const button of await visiblePrimaryButtons.all()) {
    const box = await button.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(primaryMinimum);
  }

  const input = page.getByRole('combobox', { name: 'Add an entry' });
  await input.focus();
  await expect(composerShell).toHaveAttribute('data-expanded', 'true');
  for (const name of [/Task$/, 'Add entry']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(composerMinimum);
  }

  const inputBox = await input.boundingBox();
  expect(inputBox?.height).toBeGreaterThanOrEqual(composerMinimum);
  if (isPhone) await expect(input).toHaveCSS('font-size', '16px');
  if (isNarrow) {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    const dayButtons = page.locator('.calendar-day');
    await expect(dayButtons.first()).toBeVisible();
    const dayCount = await dayButtons.count();
    expect(dayCount).toBeGreaterThanOrEqual(28);
    expect(dayCount).toBeLessThanOrEqual(31);
    for (const button of await dayButtons.all()) {
      const box = await button.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(40);
      expect(box?.height).toBeGreaterThanOrEqual(40);
    }
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(0);
  }

  if (
    testInfo.project.name === 'chromium-short' ||
    testInfo.project.name === 'chromium-landscape'
  ) {
    await expect(page.locator('.app-header__title')).toBeVisible();
    await expect(page.locator('.app-header__subtitle')).toBeHidden();
  }
});

test('entry previews clamp only real overflow and disclose it without nested actions', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-narrow');
  await openJournal(page);
  await page.setViewportSize({ width: 320, height: 700 });

  const capture = async (draft: string, text: string) => {
    await page.getByRole('combobox', { name: 'Add an entry' }).fill(draft);
    await page.getByRole('button', { name: 'Add entry' }).click();
    const row = page.locator('.entry-row').filter({ hasText: text });
    await expect(row).toBeVisible();
    return row;
  };

  const shortText = uniqueText('Short note');
  const shortRow = await capture(`- ${shortText}`, shortText);
  await expect(shortRow.getByRole('button', { name: /entry preview/i })).toHaveCount(0);

  const longText = uniqueText(
    'Reflect on the garden redesign with Łukasz and compare irrigation notes, planting constraints, and https://example.test/research/garden/native-plants/irrigation/soil/sunlight before making the final order 🌱',
  );
  const longRow = await capture(`- ${longText}`, longText);
  const disclosure = longRow.locator('.entry-row__expand');
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toHaveAccessibleName(/expand entry preview/i);
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');

  const collapsed = await longRow.locator('.entry-row__text').evaluate((element) => {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
    return {
      clientHeight: element.clientHeight,
      lineHeight,
      scrollHeight: element.scrollHeight,
    };
  });
  expect(collapsed.clientHeight).toBeLessThanOrEqual(collapsed.lineHeight * 2 + 1);
  expect(collapsed.scrollHeight).toBeGreaterThan(collapsed.clientHeight);
  expect(await longRow.locator('button button').count()).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);

  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(disclosure).toHaveAccessibleName(/collapse entry preview/i);
  await expect(longRow.locator('.entry-row__text')).toHaveText(longText);

  await page.keyboard.press('Space');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(disclosure).toHaveAccessibleName(/expand entry preview/i);
});

test('reduced-motion preference collapses animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openJournal(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const duration = await page
    .getByRole('dialog', { name: 'Settings' })
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).animationDuration) || 0);
  expect(duration).toBeLessThanOrEqual(0.000_01);
});

test('mobile chrome names the route instead of repeating the app name', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-narrow');
  await openJournal(page);

  const title = page.locator('.app-header__title');
  await expect(title).toHaveText('Timeline');
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expect(title).toHaveText(/^[A-Z][a-z]+ \d{4}$/);
  await page.getByRole('button', { name: 'Index', exact: true }).click();
  await expect(title).toHaveText('Index');
  await page.getByRole('button', { name: /^Activity/ }).click();
  await expect(title).toHaveText('Activity');
});

test('mobile controls keep named touch targets and primary actions reach 44px', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-narrow');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openJournal(page);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expectTouchTargets(settings, 'Settings');
  for (const primary of [
    page.getByRole('button', { name: 'Close dialog' }),
    page.getByRole('button', { name: 'Create token' }),
    page.getByRole('button', { name: 'Open recovery' }),
  ]) {
    const box = await primary.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Index', exact: true }).click();
  await page.getByRole('button', { name: /New/ }).click();
  const newCollection = page.getByRole('dialog', { name: 'New collection' });
  await expect(newCollection).toBeVisible();
  await expectTouchTargets(newCollection, 'New collection');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  const entryText = uniqueText('Touch target entry');
  await page.getByRole('combobox', { name: 'Add an entry' }).fill(entryText);
  await page.getByRole('button', { name: 'Add entry' }).click();
  await page.getByRole('button', { name: entryText, exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expectTouchTargets(page.locator('.entry-sheet'), 'Edit entry');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Search entries', exact: true }).click();
  const searchDialog = page.getByRole('dialog', { name: 'Search journal' });
  await expect(searchDialog).toBeVisible();
  const searchInput = page.getByRole('searchbox', { name: 'Search entries and tags' });
  await searchInput.fill('#work');
  await expect(page.getByRole('button', { name: 'Clear search', exact: true })).toHaveCount(1);
  await expectTouchTargets(searchDialog, 'Search journal');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Search journal' })).toBeHidden();

  /*
   * Last, because it leaves a draft standing: the composer's chips only exist
   * with one in flight. Their ink is the 24px parse-chip pill whatever the
   * pointer, so the 40px minimum is paid by the transparent button around it —
   * which is exactly what this sweep measures. The trailing word parks the caret
   * outside every sigil token, so no completion panel opens over the row.
   */
  await page
    .getByRole('combobox', { name: 'Add an entry' })
    .fill('Standup @9:15 #work >tomorrow done');
  await expect(page.getByRole('button', { name: 'Destination: Tomorrow' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear destination' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove time at 09:15' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove tag #work' })).toBeVisible();
  await expect(page.locator('.composer-shell [role="listbox"]')).toBeHidden();
  await expectTouchTargets(page.locator('.composer-shell'), 'Composer with draft');
});

test('route navigation restores the content scroller to the top', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-narrow');
  await openJournal(page);
  await page.setViewportSize({ width: 320, height: 700 });
  const content = page.locator('#journal-content');
  await content.evaluate((element) => {
    element.style.paddingBottom = '1000px';
    element.scrollTo(0, element.scrollHeight);
  });
  expect(await content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Index', exact: true }).click();

  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.getByRole('heading', { name: 'Collections', exact: true })).toBeVisible();
});

test('a delayed older-day deep link settles on its anchored Timeline section', async ({
  baseURL,
  context,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-narrow');
  const paired = await context.request.post('/api/pair', {
    data: {},
    headers: { Origin: baseURL! },
  });
  expect(paired.status()).toBe(201);
  const bootstrapResponse = await context.request.get('/api/bootstrap');
  expect(bootstrapResponse.ok()).toBeTruthy();
  const bootstrap = (await bootstrapResponse.json()) as { today: string; timezone: string };
  const selectedDate = addCalendarDays(bootstrap.today, -21);
  const selectedText = uniqueText('Delayed deep-link entry');
  const capturedAt = new Date().toISOString();
  const createEntry = (date: string, text: string) =>
    context.request.post('/api/entries', {
      data: {
        id: ulid(),
        text,
        type: 'note',
        time: null,
        tags: ['deep-link'],
        collection: null,
        dateIntent: {
          kind: 'absolute',
          date,
          baseToday: bootstrap.today,
          capturedAt,
          timezone: bootstrap.timezone,
        },
      },
      headers: { 'Idempotency-Key': ulid(), Origin: baseURL! },
    });
  const seeded = await Promise.all([
    ...Array.from({ length: 12 }, (_, index) =>
      createEntry(
        bootstrap.today,
        `Newer geometry row ${index + 1} with enough text to occupy visible space`,
      ),
    ),
    createEntry(selectedDate, selectedText),
  ]);
  expect(seeded.every((response) => response.status() === 201)).toBeTruthy();

  await page.route('**/api/timeline?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('to') === selectedDate) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await route.continue();
  });

  await page.goto(`/?date=${selectedDate}`);
  await expect(page.locator('#journal-content')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Add an entry' })).toBeVisible();
  await expect(page.getByText(selectedText, { exact: true })).toBeVisible();

  const selectedSection = page.locator(`[data-day="${selectedDate}"]`);
  await expect(selectedSection).toBeFocused();
  await expect(
    page.getByText('Newer geometry row 1 with enough text to occupy visible space'),
  ).toHaveCount(0);
  await page.waitForTimeout(100);
  await expect(selectedSection).toBeFocused();
  expect(await page.locator('#journal-content').evaluate((element) => element.scrollTop)).toBe(0);
});
