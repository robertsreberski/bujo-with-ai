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
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute(
    'content',
    'Journal',
  );
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
    'content',
    'yes',
  );
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute(
    'content',
    'black-translucent',
  );

  const manifestResponse = await context.request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = (await manifestResponse.json()) as {
    id: string;
    lang: string;
    name: string;
    short_name: string;
    display: string;
    orientation: string;
    start_url: string;
    scope: string;
    icons: Array<{ src: string; sizes: string; purpose?: string }>;
    shortcuts: Array<{ name: string; short_name: string; url: string }>;
  };
  expect(manifest).toMatchObject({
    id: '/',
    lang: 'en',
    name: 'Journal',
    short_name: 'Journal',
    display: 'standalone',
    orientation: 'any',
    start_url: '/',
    scope: '/',
  });
  expect(manifest.shortcuts).toEqual([
    { name: 'Timeline', short_name: 'Timeline', url: '/' },
    { name: 'This month', short_name: 'Month', url: '/month' },
    { name: 'Activity', short_name: 'Activity', url: '/activity' },
  ]);
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
  // Launch images ship, but iOS reads them from the bookmark — never precache.
  expect(worker).not.toContain('/splash/');

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

test('every iOS launch image is media-gated, served, and sized for the device it claims', async ({
  context,
  page,
}) => {
  await openJournal(page);

  const links = await page.locator('link[rel="apple-touch-startup-image"]').all();
  expect(links.length).toBeGreaterThanOrEqual(14);

  for (const link of links) {
    const href = await link.getAttribute('href');
    const media = await link.getAttribute('media');
    expect(href, 'launch image href').toMatch(/^\/splash\/\d+x\d+\.png$/);
    // Without an exact four-part match iOS silently falls back to a white screen.
    expect(media, href!).toMatch(
      /^screen and \(device-width: \d+px\) and \(device-height: \d+px\) and \(-webkit-device-pixel-ratio: [23]\) and \(orientation: portrait\)$/,
    );

    const [width, height] = href!.slice('/splash/'.length, -'.png'.length).split('x').map(Number);
    const scale = Number(/-webkit-device-pixel-ratio: (\d+)/.exec(media!)![1]);
    expect(Number(/device-width: (\d+)px/.exec(media!)![1]), href!).toBe(width! / scale);
    expect(Number(/device-height: (\d+)px/.exec(media!)![1]), href!).toBe(height! / scale);

    const response = await context.request.get(href!);
    expect(response.status(), href!).toBe(200);
    expect(response.headers()['content-type'], href!).toContain('image/png');
    const dimensions = await page.evaluate(
      (src) =>
        new Promise<{ width: number; height: number }>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
          image.onerror = () => reject(new Error(`Unable to decode ${src}`));
          image.src = src;
        }),
      href!,
    );
    expect(dimensions, href!).toEqual({ width, height });
  }
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
  await expect(page.locator('.status-strip')).toContainText(
    /Offline — showing what is available on this device|Journal server unavailable/,
  );

  const text = uniqueText('Offline queued capture');
  await page.getByRole('combobox', { name: 'Add an entry' }).fill(`- ${text} #offline`);
  await page.getByRole('button', { name: 'Add entry' }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.locator('.status-strip')).toContainText(/\d+ changes? saved on this device/);

  await context.setOffline(false);
  await expect(
    page.locator('.status-strip').filter({ hasText: /Offline|Journal server unavailable/ }),
  ).toHaveCount(0);
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
  await page.getByRole('combobox', { name: 'Add an entry' }).fill(draft);

  // Draft persistence is intentionally short-debounced off the input path.
  await page.waitForTimeout(250);
  await page.close();

  const restoredPage = await context.newPage();
  try {
    await openJournal(restoredPage);
    await expect(restoredPage.getByRole('combobox', { name: 'Add an entry' })).toHaveValue(draft);

    await context.setOffline(true);
    await expect(restoredPage.locator('.status-strip')).toContainText(
      'Offline — showing what is available on this device',
    );
    await restoredPage.getByRole('button', { name: 'Add entry' }).click();
    await expect(restoredPage.getByText(text, { exact: true })).toBeVisible();
    await expect(restoredPage.locator('.status-strip')).toContainText(
      /\d+ changes? saved on this device/,
    );
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
    await expect(
      replayPage.locator('.status-strip').filter({ hasText: /Offline|Journal server unavailable/ }),
    ).toHaveCount(0);
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
  const initialTimelineLoaded = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/api/bootstrap' &&
      response.request().method() === 'GET' &&
      response.status() === 200
    );
  });
  await openJournal(page);
  await initialTimelineLoaded;

  await context.setOffline(true);
  await expect(page.locator('.status-strip')).toContainText(
    'Offline — showing what is available on this device',
  );
  await page.clock.fastForward(60_000);
  await expect(page.locator(`[data-day="${browserTomorrow}"]`)).toBeVisible();

  const text = uniqueText('Midnight offline tomorrow');
  await page.getByRole('combobox', { name: 'Add an entry' }).fill(`- ${text} >tomorrow`);
  await page.getByRole('button', { name: 'Add entry' }).click();
  await expect(page.locator(`[data-day="${intendedDate}"]`)).toContainText(text);
  await expect(page.locator('.status-strip')).toContainText(/\d+ changes? saved on this device/);

  const replayed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/entries') &&
      response.request().method() === 'POST' &&
      response.status() === 201,
  );
  await context.setOffline(false);
  await replayed;
  await expect(
    page.locator('.status-strip').filter({ hasText: /Offline|Journal server unavailable/ }),
  ).toHaveCount(0);

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
