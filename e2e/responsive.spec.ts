import { expect, test, type Page } from '@playwright/test';
import { ulid } from 'ulid';
import { openJournal, uniqueText } from './helpers';

function addCalendarDays(date: string, amount: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

async function expectTouchTargets(page: Page, surface: string): Promise<void> {
  const targets = page.locator(
    'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, a[href]',
  );
  for (const target of await targets.all()) {
    if (!(await target.isVisible())) continue;
    const box = await target.boundingBox();
    const label = await target.evaluate(
      (element) =>
        element.getAttribute('aria-label') ??
        element.getAttribute('placeholder') ??
        element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) ??
        element.tagName.toLowerCase(),
    );
    expect(box?.width, `${surface}: ${label} width`).toBeGreaterThanOrEqual(40);
    expect(box?.height, `${surface}: ${label} height`).toBeGreaterThanOrEqual(40);
  }
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
    expect(frameBox?.width).toBe(560);
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
   * DS-14 control heights. The phone projects are the coarse-pointer ones, so
   * they are the only place the 40px touch minimum applies; the pointer-precise
   * layouts use the tighter desk metrics — 34px sidebar nav rows on the wide
   * layout, 30px tab segments on the mid layout, and a 36px composer trio.
   */
  const isNarrow = testInfo.project.name === 'chromium-narrow';
  const isPhone = isNarrow || testInfo.project.name === 'webkit-iphone';
  const primaryMinimum = isPhone ? 40 : testInfo.project.name === 'chromium-desktop' ? 34 : 30;
  const composerMinimum = isPhone ? 40 : 36;

  const visiblePrimaryButtons = page
    .getByRole('button')
    .filter({ hasText: /^(Today|Month|Index|Review)\s*(\d+\+?)?$/ });
  await expect(visiblePrimaryButtons).toHaveCount(4);
  for (const button of await visiblePrimaryButtons.all()) {
    const box = await button.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(primaryMinimum);
  }

  for (const name of [/Task$/, 'Add entry']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(composerMinimum);
  }

  const input = page.getByRole('textbox', { name: 'Add an entry' });
  const inputBox = await input.boundingBox();
  expect(inputBox?.height).toBeGreaterThanOrEqual(composerMinimum);
  if (isPhone) await expect(input).toHaveCSS('font-size', '16px');
  if (isNarrow) {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.getByRole('button', { name: 'Month', exact: true }).click();
    const dayButtons = page.locator('.calendar-day');
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
});

test('reduced-motion preference collapses animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openJournal(page);
  await page.getByRole('button', { name: 'Assistant access', exact: true }).click();
  const duration = await page
    .getByRole('dialog', { name: 'Assistant access' })
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).animationDuration) || 0);
  expect(duration).toBeLessThanOrEqual(0.000_01);
});

test('all mobile form and dialog controls keep 40px touch targets', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-narrow');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openJournal(page);

  await page.getByRole('button', { name: 'Assistant access', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Assistant access' })).toBeVisible();
  await expectTouchTargets(page, 'Assistant access');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Index', exact: true }).click();
  await page.getByRole('button', { name: /New/ }).click();
  await expect(page.getByRole('dialog', { name: 'New collection' })).toBeVisible();
  await expectTouchTargets(page, 'New collection');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /^Today/ }).click();
  const entryText = uniqueText('Touch target entry');
  await page.getByRole('textbox', { name: 'Add an entry' }).fill(entryText);
  await page.getByRole('button', { name: 'Add entry' }).click();
  await page.getByRole('button', { name: entryText, exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expectTouchTargets(page, 'Edit entry');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Search entries', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Search journal' })).toBeVisible();
  const searchInput = page.getByRole('searchbox', { name: 'Search entries and tags' });
  await searchInput.fill('#work');
  await expect(page.getByRole('button', { name: 'Clear search', exact: true })).toHaveCount(1);
  await expectTouchTargets(page, 'Search journal');
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

test('a delayed older-day deep link settles on its final section geometry', async ({
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

  await page.route('**/api/entries?**', async (route) => {
    const url = new URL(route.request().url());
    if (
      url.searchParams.get('from') === selectedDate &&
      url.searchParams.get('to') === selectedDate
    ) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await route.continue();
  });

  await page.goto(`/?date=${selectedDate}`);
  await expect(page.locator('#journal-content')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Add an entry' })).toBeVisible();
  await expect(page.getByText(selectedText, { exact: true })).toBeVisible();

  const selectedSection = page.locator(`[data-day="${selectedDate}"]`);
  await expect(selectedSection).toBeFocused();
  await expect
    .poll(() => page.locator('#journal-content').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.waitForTimeout(100);
  await expect(selectedSection).toBeFocused();
  expect(
    await page.locator('#journal-content').evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);
});
