import { expect, test } from '@playwright/test';
import { openJournal, uniqueText } from './helpers';

function addCalendarDays(date: string, amount: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

function instantForLocalTime(date: string, time: string, timezone: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second] = time.split(':').map(Number);
  const target = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    const observed = Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour!,
      parts.minute!,
      parts.second!,
    );
    instant += target - observed;
  }
  return instant;
}

test('manifest, install metadata, icons, and custom service worker ship from one origin', async ({
  context,
  page,
}) => {
  await openJournal(page);

  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'href',
    '/icons/apple-touch-icon.png',
  );

  const manifestResponse = await context.request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = (await manifestResponse.json()) as {
    name: string;
    short_name: string;
    display: string;
    start_url: string;
    scope: string;
    icons: Array<{ src: string; sizes: string; purpose?: string }>;
  };
  expect(manifest).toMatchObject({
    name: 'Journal',
    short_name: 'Journal',
    display: 'standalone',
    start_url: '/',
    scope: '/',
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ src: '/icons/icon-192.png', sizes: '192x192' }),
      expect.objectContaining({ src: '/icons/icon-512.png', sizes: '512x512' }),
      expect.objectContaining({
        src: '/icons/maskable-512.png',
        sizes: '512x512',
        purpose: 'maskable',
      }),
    ]),
  );

  for (const icon of manifest.icons) {
    const response = await context.request.get(icon.src);
    expect(response.ok(), icon.src).toBeTruthy();
    expect(response.headers()['content-type']).toContain('image/png');
    const [expectedWidth, expectedHeight] = icon.sizes.split('x').map(Number);
    const dimensions = await page.evaluate(
      (src) =>
        new Promise<{ width: number; height: number }>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
          image.onerror = () => reject(new Error(`Unable to decode ${src}`));
          image.src = src;
        }),
      icon.src,
    );
    expect(dimensions, icon.src).toEqual({ width: expectedWidth, height: expectedHeight });
  }

  const workerResponse = await context.request.get('/sw.js');
  expect(workerResponse.ok()).toBeTruthy();
  const worker = await workerResponse.text();
  expect(worker).not.toContain('__JOURNAL_PRECACHE_JSON__');
  expect(worker).toContain('/manifest.webmanifest');

  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
    }
  });
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))
    .toMatch(/\/sw\.js$/);
});

test('the cached shell launches offline and an offline capture replays after reconnect', async ({
  context,
  page,
}) => {
  await openJournal(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
    }
  });

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#journal-content')).toBeVisible();
  await expect(page.getByText('Offline — changes will sync')).toBeVisible();

  const text = uniqueText('Offline queued capture');
  await page.getByRole('textbox', { name: 'Add an entry' }).fill(`- ${text} #offline`);
  await page.getByRole('button', { name: 'Add entry' }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText('Offline — changes will sync')).toHaveCount(0);
  await expect
    .poll(
      () =>
        page.evaluate(async (entryText) => {
          const response = await fetch('/api/bootstrap');
          if (!response.ok) return false;
          const body = (await response.json()) as { entries?: Array<{ text?: string }> };
          return body.entries?.some((entry) => entry.text === entryText) ?? false;
        }, text),
      { timeout: 15_000 },
    )
    .toBe(true);
});

test('a draft and queued capture survive page loss through the IndexedDB journal record', async ({
  context,
  page,
}) => {
  await openJournal(page);
  const text = uniqueText('Process-safe draft');
  const draft = `- ${text} #draft`;
  await page.getByRole('textbox', { name: 'Add an entry' }).fill(draft);

  // Draft persistence is intentionally short-debounced off the input path.
  await page.waitForTimeout(250);
  await page.close();

  const restoredPage = await context.newPage();
  try {
    await openJournal(restoredPage);
    await expect(restoredPage.getByRole('textbox', { name: 'Add an entry' })).toHaveValue(draft);

    await context.setOffline(true);
    await expect(restoredPage.getByText('Offline — changes will sync')).toBeVisible();
    await restoredPage.getByRole('button', { name: 'Add entry' }).click();
    await expect(restoredPage.getByText(text, { exact: true })).toBeVisible();
    await restoredPage.waitForTimeout(250);
  } finally {
    await restoredPage.close();
  }

  const replayPage = await context.newPage();
  try {
    await openJournal(replayPage);
    await expect(replayPage.getByText(text, { exact: true })).toBeVisible();
    const replayed = replayPage.waitForResponse(
      (response) =>
        response.url().endsWith('/api/entries') &&
        response.request().method() === 'POST' &&
        response.status() === 201,
    );
    await context.setOffline(false);
    await replayed;
    await expect(replayPage.getByText('Offline — changes will sync')).toHaveCount(0);
    await expect
      .poll(async () => {
        const response = await context.request.get(`/api/entries?q=${encodeURIComponent(text)}`);
        if (!response.ok()) return false;
        const body = (await response.json()) as { items?: Array<{ text?: string }> };
        return body.items?.some((entry) => entry.text === text) ?? false;
      })
      .toBe(true);
  } finally {
    await context.setOffline(false);
    await replayPage.close();
  }
});

test('an offline tomorrow capture after browser midnight replays to its intended date', async ({
  baseURL,
  context,
  page,
}) => {
  const paired = await context.request.post('/api/pair', {
    data: {},
    headers: { Origin: baseURL! },
  });
  expect(paired.status()).toBe(201);
  const bootstrapResponse = await context.request.get('/api/bootstrap');
  expect(bootstrapResponse.ok()).toBeTruthy();
  const bootstrap = (await bootstrapResponse.json()) as { today: string; timezone: string };
  const browserTomorrow = addCalendarDays(bootstrap.today, 1);
  const intendedDate = addCalendarDays(bootstrap.today, 2);
  await page.clock.install({
    time: instantForLocalTime(bootstrap.today, '23:59:30', bootstrap.timezone),
  });
  const initialHistoryLoaded = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/entries' &&
      url.searchParams.get('limit') === '100' &&
      response.request().method() === 'GET' &&
      response.status() === 200
    );
  });
  await openJournal(page);
  await initialHistoryLoaded;

  await context.setOffline(true);
  await expect(page.getByText('Offline — changes will sync')).toBeVisible();
  await page.clock.fastForward(60_000);
  await expect(page.locator(`[data-day="${browserTomorrow}"]`)).toBeVisible();

  const text = uniqueText('Midnight offline tomorrow');
  await page.getByRole('textbox', { name: 'Add an entry' }).fill(`- ${text} >tomorrow`);
  await page.getByRole('button', { name: 'Add entry' }).click();
  await expect(page.locator(`[data-day="${intendedDate}"]`)).toContainText(text);

  const replayed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/entries') &&
      response.request().method() === 'POST' &&
      response.status() === 201,
  );
  await context.setOffline(false);
  await replayed;
  await expect(page.getByText('Offline — changes will sync')).toHaveCount(0);

  await expect
    .poll(async () => {
      const response = await context.request.get(
        `/api/entries?from=${intendedDate}&to=${intendedDate}&q=${encodeURIComponent(text)}`,
      );
      if (!response.ok()) return null;
      const body = (await response.json()) as {
        items?: Array<{ date?: string; text?: string }>;
      };
      return body.items?.find((entry) => entry.text === text)?.date ?? null;
    })
    .toBe(intendedDate);
  await expect(page.getByRole('button', { name: /changes? need attention/i })).toHaveCount(0);
});
