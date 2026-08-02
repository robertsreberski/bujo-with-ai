import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { ulid } from 'ulid';
import { openJournal, uniqueText } from './helpers';

interface McpEntryWrite {
  activityId: string;
  entry: { id: string; revision: number; text: string };
}

interface ServerContext {
  today: string;
  timezone: string;
}

interface PersistedActivityAcknowledgement {
  cursor: { at: string; id: string } | null;
  seenIds: string[];
}

/**
 * The Playwright server is shared by every spec, so its database carries the
 * other tests' rows. Seeds therefore establish *relative* facts (one more open
 * task than a moment ago) rather than absolute ones.
 */
async function pairAndBootstrap(
  context: BrowserContext,
  baseURL: string | undefined,
): Promise<ServerContext> {
  const paired = await context.request.post('/api/pair', {
    data: {},
    headers: { Origin: baseURL! },
  });
  expect(paired.status()).toBe(201);
  const bootstrap = await context.request.get('/api/bootstrap');
  expect(bootstrap.ok()).toBeTruthy();
  return (await bootstrap.json()) as ServerContext;
}

async function seedOwnerEntry(
  request: APIRequestContext,
  baseURL: string | undefined,
  server: ServerContext,
  entry: {
    text: string;
    type: string;
    tags?: string[];
    collection?: string | null;
    date?: string;
    /**
     * Files without naming a day — the month's inventory rather than something
     * that happens on a date. Only meaningful alongside a collection.
     */
    undated?: boolean;
  },
): Promise<string> {
  const id = ulid();
  const context = {
    baseToday: server.today,
    capturedAt: new Date().toISOString(),
    timezone: server.timezone,
  };
  const created = await request.post('/api/entries', {
    data: {
      id,
      text: entry.text,
      type: entry.type,
      time: null,
      tags: entry.tags ?? [],
      collection: entry.collection ?? null,
      dateIntent: entry.undated
        ? { kind: 'unstated', ...context }
        : entry.date
          ? { kind: 'absolute', date: entry.date, ...context }
          : { kind: 'today', ...context },
    },
    headers: { 'Idempotency-Key': ulid(), Origin: baseURL! },
  });
  expect(created.status()).toBe(201);
  return id;
}

/** `humanizeSlug`, restated: the name a create-then-file capture mints. */
function humanizeSlug(slug: string): string {
  const words = slug.replace(/-+/g, ' ').trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** Reads the exact persisted acknowledgement straight out of IndexedDB. */
async function persistedActivityAcknowledgement(
  page: Page,
): Promise<PersistedActivityAcknowledgement | null> {
  return page.evaluate(
    () =>
      new Promise<PersistedActivityAcknowledgement | null>((resolve) => {
        const request = indexedDB.open('journal-pwa');
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('client-state')) {
            database.close();
            resolve(null);
            return;
          }
          const read = database
            .transaction('client-state', 'readonly')
            .objectStore('client-state')
            .get('journal-client-state-v1');
          read.onerror = () => {
            database.close();
            resolve(null);
          };
          read.onsuccess = () => {
            const record = read.result as
              | {
                  activitySeenThrough?: { at: string; id: string } | null;
                  seenActivityIds?: string[];
                }
              | undefined;
            database.close();
            resolve(
              record
                ? {
                    cursor: record.activitySeenThrough ?? null,
                    seenIds: [...(record.seenActivityIds ?? [])].sort(),
                  }
                : null,
            );
          };
        };
      }),
  );
}

async function issueMcpSecret(page: Page, tokenLabel: string): Promise<string> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('textbox', { name: 'New agent token label' }).fill(tokenLabel);
  await dialog.getByRole('button', { name: 'Create token' }).click();
  const secretPanel = dialog.locator('aside').filter({ hasText: 'Token created — copy it now' });
  await expect(secretPanel).toBeVisible();
  const secret = (await secretPanel.locator('code').textContent())?.trim();
  expect(secret).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  return secret ?? '';
}

function mcpEntryWrite(result: unknown, expectedText: string): McpEntryWrite {
  const record =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
  expect(record.isError).not.toBe(true);
  const payload = record.structuredContent as
    | {
        activityId?: unknown;
        entry?: { id?: unknown; revision?: unknown; text?: unknown };
      }
    | undefined;
  expect(payload).toMatchObject({
    activityId: expect.any(String),
    entry: { id: expect.any(String), revision: expect.any(Number), text: expectedText },
  });
  if (
    typeof payload?.activityId !== 'string' ||
    typeof payload.entry?.id !== 'string' ||
    typeof payload.entry.revision !== 'number' ||
    typeof payload.entry.text !== 'string'
  ) {
    throw new Error('MCP write did not return a structured entry and activity id.');
  }
  return {
    activityId: payload.activityId,
    entry: {
      id: payload.entry.id,
      revision: payload.entry.revision,
      text: payload.entry.text,
    },
  };
}

function addCalendarDays(date: string, amount: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

test('first load pairs the browser and bootstraps an empty production journal', async ({
  context,
  page,
}) => {
  const paired = page.waitForResponse(
    (response) => response.url().endsWith('/api/pair') && response.status() === 201,
  );
  const bootstrapped = page.waitForResponse(
    (response) => response.url().endsWith('/api/bootstrap') && response.status() === 200,
  );

  await openJournal(page);
  await Promise.all([paired, bootstrapped]);

  const deviceCookie = (await context.cookies()).find((cookie) => cookie.name === 'journal_device');
  expect(deviceCookie).toMatchObject({
    httpOnly: true,
    sameSite: 'Strict',
    secure: true,
  });

  const health = await context.request.get('/healthz');
  expect(health.ok()).toBeTruthy();
  await expect(health.json()).resolves.toMatchObject({ status: 'ok', db: 'ok' });
});

test('owner capture persists and the four primary views navigate by semantic controls', async ({
  page,
}) => {
  await openJournal(page);
  const text = uniqueText('Owner E2E capture');

  await page.getByRole('combobox', { name: 'Add an entry' }).fill(`. ${text} #release`);
  await page.getByRole('button', { name: 'Add entry' }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();

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

  const routes = [
    { button: 'Month', path: '/month', landmark: /^[A-Z][a-z]+ \d{4} monthly log$/ },
    { button: 'Index', path: '/index', landmark: 'Journal index' },
    { button: 'Activity', path: '/activity', landmark: 'Activity history' },
    { button: 'Timeline', path: '/', landmark: 'Timeline' },
  ] as const;

  for (const route of routes) {
    // Prefix match: nav names may carry a count badge suffix ("Timeline — 1 open item").
    await page.getByRole('button', { name: new RegExp(`^${route.button}`) }).click();
    await expect(page).toHaveURL(new RegExp(`${route.path.replace('/', '\\/')}(?:\\?|$)`));
    await expect(page.getByRole('region', { name: route.landmark })).toBeVisible();
  }

  await page.reload();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
});

test('owner deletion supports immediate undo and later recovery from Settings', async ({
  page,
}) => {
  await openJournal(page);
  const text = uniqueText('Recoverable owner entry');

  await page.getByRole('combobox', { name: 'Add an entry' }).fill(`- ${text}`);
  await page.getByRole('button', { name: 'Add entry' }).click();
  let row = page.locator('[data-entry-id]').filter({ hasText: text });
  await expect(row).toBeVisible();

  const remove = async () => {
    await row.locator('.entry-row__content').click();
    await page
      .getByRole('dialog', { name: text })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Delete this entry?' })
      .getByRole('button', { name: 'Delete entry' })
      .click();
    await expect(page.getByRole('status').filter({ hasText: 'Entry deleted' })).toBeVisible();
    await expect(row).toHaveCount(0);
  };

  await remove();
  await page
    .getByRole('status')
    .filter({ hasText: 'Entry deleted' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(page.getByRole('status').filter({ hasText: 'Entry restored' })).toBeVisible();
  row = page.locator('[data-entry-id]').filter({ hasText: text });
  await expect(row).toBeVisible();

  await remove();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: 'Open recovery' })
    .click();
  const recovery = page.getByRole('dialog', { name: 'Recovery' });
  const deleted = recovery.locator('article').filter({ hasText: text });
  await expect(deleted).toBeVisible();
  await deleted.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Entry restored' })).toBeVisible();
  await recovery.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.locator('[data-entry-id]').filter({ hasText: text })).toBeVisible();
});

test('Timeline stays bounded and reveals older daily and collection entries explicitly', async ({
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
  const historicalDate = addCalendarDays(bootstrap.today, -21);
  const collectionId = `timeline-${ulid().toLowerCase()}`;
  const collectionName = uniqueText('Timeline archive');
  const collection = await context.request.post('/api/collections', {
    data: { id: collectionId, name: collectionName, note: null },
    headers: { 'Idempotency-Key': ulid(), Origin: baseURL! },
  });
  expect(collection.status()).toBe(201);

  const filedText = uniqueText('Filed history boundary');
  const dailyText = uniqueText('Daily history boundary');
  await seedOwnerEntry(context.request, baseURL, bootstrap, {
    text: filedText,
    type: 'note',
    collection: collectionId,
    date: historicalDate,
  });
  await seedOwnerEntry(context.request, baseURL, bootstrap, {
    text: dailyText,
    type: 'note',
    date: historicalDate,
  });
  for (let start = 0; start < 100; start += 20) {
    await Promise.all(
      Array.from({ length: 20 }, (_, offset) =>
        seedOwnerEntry(context.request, baseURL, bootstrap, {
          text: uniqueText(`Timeline boundary ${start + offset}`),
          type: 'note',
          date: historicalDate,
        }),
      ),
    );
  }

  const entryRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/entries') entryRequests.push(url.search);
  });
  await page.goto(`/?date=${historicalDate}`);
  await expect(page.locator('#journal-content')).toBeVisible();

  await expect(page.locator('.entry-row')).toHaveCount(100);
  const filedRow = page.locator('.entry-row').filter({ hasText: filedText });
  const dailyRow = page.locator('.entry-row').filter({ hasText: dailyText });
  await expect(filedRow).toHaveCount(0);
  await expect(dailyRow).toHaveCount(0);
  await page.getByRole('button', { name: 'Earlier' }).click();
  await expect(filedRow).toHaveCount(1);
  await expect(dailyRow).toHaveCount(1);
  await expect(filedRow.getByText(collectionName)).toBeVisible();
  expect(entryRequests).not.toContain('');
});

test('two paired browsers converge through SSE and notify the other device once', async ({
  browser,
}) => {
  const [contextA, contextB] = await Promise.all([browser.newContext(), browser.newContext()]);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  try {
    const deviceBEvents = pageB.waitForResponse(
      (response) => response.url().includes('/api/events?') && response.status() === 200,
    );
    await Promise.all([openJournal(pageA), openJournal(pageB), deviceBEvents]);

    const text = uniqueText('Two-device owner capture');
    await pageA.getByRole('combobox', { name: 'Add an entry' }).fill(`- ${text} #convergence`);
    await pageA.getByRole('button', { name: 'Add entry' }).click();

    await expect(pageB.getByText(text, { exact: true })).toBeVisible();
    const notice = pageB
      .getByRole('status')
      .filter({ hasText: 'Journal updated on another device.' });
    await expect(notice).toHaveCount(1);
    await expect(notice).toBeVisible();
  } finally {
    await Promise.all([contextA.close(), contextB.close()]);
  }
});

test('Settings exposes exactly seven assistant tools with the approved write modes', async ({
  page,
}) => {
  await openJournal(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  const permissions = dialog.locator('[aria-label="MCP tool permissions"]');
  await expect(permissions.locator('code')).toHaveText([
    'add_entry',
    'add_to_collection',
    'list_day',
    'search',
    'update_entry',
    'delete_entry',
    'propose_migration',
  ]);
  await expect(permissions.locator('.mode-badge')).toHaveText([
    'automatic',
    'automatic',
    'read only',
    'read only',
    'automatic',
    'automatic',
    'automatic',
  ]);
});

test('Settings reports a live assistant session and persists display preferences', async ({
  baseURL,
  page,
}) => {
  await openJournal(page);
  const text = uniqueText('Preference evidence note');
  await page.getByRole('combobox', { name: 'Add an entry' }).fill(`- ${text}`);
  await page.getByRole('button', { name: 'Add entry' }).click();
  const row = page.locator('.entry-row').filter({ hasText: text });

  const secret = await issueMcpSecret(page, uniqueText('Connected status agent'));
  const client = new Client({ name: 'journal-settings-evidence', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  try {
    await client.connect(transport as unknown as Transport);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog.locator('.connection-pill')).toContainText('Connected');

    const density = dialog.getByRole('combobox');
    const typeBadges = dialog.getByRole('switch', { name: /Type badges/ });
    const initialDensity = await density.inputValue();
    const targetDensity = initialDensity === 'compact' ? 'comfortable' : 'compact';
    const targetBadges = !(await typeBadges.isChecked());
    await expect(row).toHaveClass(new RegExp(`entry-row--${initialDensity}`));
    await expect(row.locator('.badge--type')).toHaveCount(targetBadges ? 0 : 1);

    const densityUpdated = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/settings') &&
        response.request().method() === 'PATCH' &&
        response.status() === 200,
    );
    await density.selectOption(targetDensity);
    await densityUpdated;
    await expect(dialog.getByRole('combobox')).toHaveValue(targetDensity);

    const badgesUpdated = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/settings') &&
        response.request().method() === 'PATCH' &&
        response.status() === 200,
    );
    await dialog.getByRole('switch', { name: /Type badges/ }).click();
    await badgesUpdated;
    await expect(dialog.getByRole('switch', { name: /Type badges/ })).toBeChecked({
      checked: targetBadges,
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await expect(row).toHaveClass(new RegExp(`entry-row--${targetDensity}`));
    await expect(row.locator('.badge--type')).toHaveCount(targetBadges ? 1 : 0);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const reopened = page.getByRole('dialog', { name: 'Settings' });
    await expect(reopened.getByRole('combobox')).toHaveValue(targetDensity);
    await expect(reopened.getByRole('switch', { name: /Type badges/ })).toBeChecked({
      checked: targetBadges,
    });
  } finally {
    await client.close();
  }
});

test('an automatic MCP write appears in Activity and can be reverted by the owner', async ({
  baseURL,
  page,
}) => {
  await openJournal(page);
  const tokenLabel = uniqueText('Playwright agent');
  const secret = await issueMcpSecret(page, tokenLabel);

  const client = new Client({ name: 'journal-playwright', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  const text = uniqueText('Agent E2E addition');
  try {
    // SDK 1.30's transport declarations are not exactOptionalPropertyTypes-clean.
    await client.connect(transport as unknown as Transport);
    const result = await client.callTool({
      name: 'add_entry',
      arguments: {
        idempotencyKey: ulid(),
        source: 'Playwright Activity and Revert coverage',
        tags: ['release'],
        text,
        type: 'note',
      },
    });
    mcpEntryWrite(result, text);
  } finally {
    await client.close();
  }

  await page.getByRole('button', { name: /^Activity/ }).click();
  const activity = page.getByRole('article').filter({ hasText: text });
  await expect(activity).toBeVisible();
  await activity.getByRole('button', { name: 'Revert' }).click();

  const confirmation = page.getByRole('dialog', { name: 'Revert this change?' });
  await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Revert change' }).click();
  await expect(page.getByText('Change reverted')).toBeVisible();
  await expect(activity.getByText('Reverted', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await expect(page.getByText(text, { exact: true })).toHaveCount(0);
});

test('owner capture and automatic add-update-revert stay live and conflict safe', async ({
  baseURL,
  page,
}) => {
  await openJournal(page);

  const ownerText = uniqueText('Owner anchor capture');
  await page.getByRole('combobox', { name: 'Add an entry' }).fill(`- ${ownerText} #owner`);
  await page.getByRole('button', { name: 'Add entry' }).click();
  await expect(page.getByText(ownerText, { exact: true })).toBeVisible();

  const tokenLabel = uniqueText('Live update agent');
  const secret = await issueMcpSecret(page, tokenLabel);
  const client = new Client({ name: 'journal-playwright', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  const originalText = uniqueText('Live assistant original');
  const updatedText = uniqueText('Live assistant updated');
  const updateReason = 'Refined during the API-16 browser journey.';
  let added: McpEntryWrite;
  let updated: McpEntryWrite;
  try {
    await client.connect(transport as unknown as Transport);
    added = mcpEntryWrite(
      await client.callTool({
        name: 'add_entry',
        arguments: {
          idempotencyKey: ulid(),
          source: 'API-16 end-to-end browser journey',
          tags: ['release'],
          text: originalText,
          type: 'note',
        },
      }),
      originalText,
    );

    const row = page.locator(`[data-entry-id="${added.entry.id}"]`);
    await expect(row.getByText(originalText, { exact: true })).toBeVisible();

    updated = mcpEntryWrite(
      await client.callTool({
        name: 'update_entry',
        arguments: {
          expectedRevision: added.entry.revision,
          id: added.entry.id,
          idempotencyKey: ulid(),
          patch: { text: updatedText },
          reason: updateReason,
        },
      }),
      updatedText,
    );
    expect(updated.entry.revision).toBe(added.entry.revision + 1);
    await expect(row.getByText(updatedText, { exact: true })).toBeVisible();
    await expect(row.getByText(originalText, { exact: true })).toHaveCount(0);
  } finally {
    await client.close();
  }

  await page.getByRole('button', { name: /^Activity/ }).click();
  const updateActivity = page.locator(`[data-activity-id="${updated.activityId}"]`);
  const addActivity = page.locator(`[data-activity-id="${added.activityId}"]`);
  await expect(updateActivity).toContainText(updatedText);
  await expect(addActivity).toContainText('added');
  await updateActivity.getByRole('button', { name: 'Revert' }).click();

  const confirmation = page.getByRole('dialog', { name: 'Revert this change?' });
  await confirmation.getByRole('button', { name: 'Revert change' }).click();
  await expect(page.getByText('Change reverted')).toBeVisible();
  await expect(updateActivity.getByText('Reverted', { exact: true })).toBeVisible();
  await expect(addActivity.getByText('Changed since — newer work preserved')).toBeVisible();
  await expect(addActivity.getByRole('button', { name: 'Revert' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  const restoredRow = page.locator(`[data-entry-id="${added.entry.id}"]`);
  await expect(restoredRow.getByText(originalText, { exact: true })).toBeVisible();
  await expect(restoredRow.getByText(updatedText, { exact: true })).toHaveCount(0);
  await expect(page.getByText(ownerText, { exact: true })).toBeVisible();
});

test('keyboard search opens a labelled modal, traps focus, and restores the opener', async ({
  page,
}) => {
  await openJournal(page);
  const content = page.locator('#journal-content');
  await expect(content).toBeFocused();

  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Search journal' });
  const search = dialog.getByRole('searchbox', { name: 'Search entries and tags' });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(search).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await dialog.focus();
  await page.keyboard.press('Shift+Tab');
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await content.focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(search).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(content).toBeFocused();
});

test('a capture on the month spread lands in the monthly log without leaving it', async ({
  page,
}) => {
  await openJournal(page);
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expect(page).toHaveURL(/\/month(?:\?|$)/);

  // The screen's own default: the month being browsed, named as the chip says.
  const input = page.getByRole('combobox', { name: 'Add an entry' });
  await input.focus();
  const chip = page.getByRole('button', { name: /^Destination: / });
  const chipLabel = ((await chip.getAttribute('aria-label')) ?? '').replace('Destination: ', '');
  expect(chipLabel).toMatch(/^[A-Z][a-z]+ \d{4}$/);

  const text = uniqueText('Month spread capture');
  await input.fill(`- ${text}`);
  await page.getByRole('button', { name: 'Add entry' }).click();

  const monthlyLog = page.getByRole('region', { name: 'Monthly log' });
  await expect(monthlyLog.getByText(text, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/month(?:\?|$)/);

  // The entry is already on screen, so the toast has nothing to offer a "View" for.
  const toast = page.locator('.toast');
  await expect(toast).toContainText(`Added to ${chipLabel}`);
  await expect(toast.locator('.toast__action')).toHaveCount(0);
  await expect(chip).toHaveAttribute('aria-label', `Destination: ${chipLabel}`);
});

test('the monthly log collapses done work and the arrange menu narrows it', async ({
  baseURL,
  context,
  page,
}) => {
  const server = await pairAndBootstrap(context, baseURL);
  const collection = `month:${server.today.slice(0, 7)}`;
  const keep = uniqueText('Renew passport');
  const finish = uniqueText('Call plumber');
  await seedOwnerEntry(context.request, baseURL, server, {
    text: keep,
    type: 'task',
    collection,
    undated: true,
  });
  const finishId = await seedOwnerEntry(context.request, baseURL, server, {
    text: finish,
    type: 'task',
    collection,
    undated: true,
  });

  await openJournal(page);
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  const monthlyLog = page.getByRole('region', { name: 'Monthly log' });
  await expect(monthlyLog.getByText(keep, { exact: true })).toBeVisible();
  await expect(monthlyLog.getByText(finish, { exact: true })).toBeVisible();

  // Finishing a task folds it into the disclosure instead of leaving a
  // dimmed row behind. The count is a pattern: the shared server means other
  // tests' entries may sit in the same bucket.
  const toggled = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/api/entries/${finishId}` &&
      response.request().method() === 'PATCH' &&
      response.status() === 200
    );
  });
  await monthlyLog.getByRole('button', { name: `Mark as done: ${finish}` }).click();
  await toggled;
  await expect(monthlyLog.getByText(finish, { exact: true })).toBeHidden();
  await expect(monthlyLog.getByText(keep, { exact: true })).toBeVisible();
  const disclosure = monthlyLog.getByText(/^Done & moved \(\d+\)$/);
  await expect(disclosure).toBeVisible();
  await disclosure.click();
  await expect(monthlyLog.getByText(finish, { exact: true })).toBeVisible();

  // The arrange menu narrows to the closed shells and the header meta counts
  // the narrowing; the trigger keeps announcing that filters are active.
  await monthlyLog.getByRole('button', { name: 'Arrange monthly log' }).click();
  const menu = page.locator('.arrange-menu');
  await menu.getByRole('menuitemradio', { name: 'Done & moved' }).click();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(monthlyLog.getByText(keep, { exact: true })).toBeHidden();
  await expect(monthlyLog.getByText(finish, { exact: true })).toBeVisible();
  await expect(monthlyLog.getByText(/^\d+ of \d+ items$/)).toBeVisible();

  // Reset restores the default arrangement: open work up top, done collapsed.
  await monthlyLog.getByRole('button', { name: 'Arrange monthly log — filters active' }).click();
  await page.locator('.arrange-menu').getByRole('menuitem', { name: 'Reset to defaults' }).click();
  await page.keyboard.press('Escape');
  await expect(monthlyLog.getByText(keep, { exact: true })).toBeVisible();
  await expect(monthlyLog.getByText(finish, { exact: true })).toBeHidden();
});

test('a monthly-log task that names a day meets that day, and can be pulled into it', async ({
  baseURL,
  context,
  page,
}) => {
  const server = await pairAndBootstrap(context, baseURL);
  const month = server.today.slice(0, 7);
  const collection = `month:${month}`;
  const inventory = uniqueText('Book flights');
  const dueToday = uniqueText('File the tax extension');
  await seedOwnerEntry(context.request, baseURL, server, {
    text: inventory,
    type: 'task',
    collection,
    undated: true,
  });
  await seedOwnerEntry(context.request, baseURL, server, {
    text: dueToday,
    type: 'task',
    collection,
    date: server.today,
  });

  // The dated one belongs to today, so it shows in the timeline beside the
  // daily log, named by the month it came from. The inventory item does not.
  await openJournal(page);
  const timeline = page.getByRole('region', { name: 'Timeline' });
  const datedRow = timeline.locator('.entry-row', { hasText: dueToday });
  await expect(datedRow).toBeVisible();
  await expect(datedRow.locator('.entry-row__destination')).toHaveText(/\w/);
  await expect(timeline.getByText(inventory, { exact: true })).toHaveCount(0);

  // The month spread keeps both, split into the two pages it has always been.
  // Exact naming matters here: the whole screen is labelled "<Month> monthly
  // log", which substring-matches the section inside it.
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  const monthlyLog = page.getByRole('region', { name: 'Monthly log', exact: true });
  await expect(
    monthlyLog.getByRole('heading', { level: 3, name: /^On a day \(\d+\)$/ }),
  ).toBeVisible();
  await expect(
    monthlyLog.getByRole('heading', { level: 3, name: /^This month \(\d+\)$/ }),
  ).toBeVisible();
  await expect(monthlyLog.getByText(dueToday, { exact: true })).toBeVisible();
  await expect(monthlyLog.getByText(inventory, { exact: true })).toBeVisible();

  // The same dated row is also the month's own timeline, which claims to show
  // every dated entry; the inventory item is correctly absent from it.
  const monthTimeline = page.getByRole('region', { name: 'Month timeline', exact: true });
  await expect(monthTimeline.getByText(dueToday, { exact: true })).toBeVisible();
  await expect(monthTimeline.getByText(inventory, { exact: true })).toHaveCount(0);

  // Pulling it into today is the paper `>`: a daily copy, and a tombstone
  // left behind in the month log pointing at it.
  await monthlyLog.getByRole('button', { name: dueToday, exact: true }).click();
  await page.getByRole('button', { name: 'Move to today' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(monthlyLog.getByText(/^Done & moved \(\d+\)$/)).toBeVisible();

  // Today then holds both halves of that move, the way the crossed-out line and
  // its rewrite sit on facing pages: a live daily copy carrying no destination,
  // and the monthly-log shell beside it, still dated today and marked moved.
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  const copy = timeline.locator('.entry-row', { hasText: dueToday }).filter({
    has: page.getByRole('button', { name: `Mark as done: ${dueToday}` }),
  });
  await expect(copy).toHaveCount(1);
  await expect(copy.locator('.entry-row__destination')).toHaveCount(0);

  const tombstone = timeline.locator('.entry-row', { hasText: dueToday }).filter({
    has: page.getByRole('button', { name: `Open task: ${dueToday}` }),
  });
  await expect(tombstone.locator('.entry-row__destination')).toHaveText(/August|\w+ \d{4}/);
  await expect(tombstone).toContainText('Moved forward');
});

test('an unknown /slug mints its collection, files the capture, and the toast opens it', async ({
  page,
}) => {
  await openJournal(page);
  // Unique so a retry — or a second run against the same server — still meets a
  // collection the mirror has never seen, which is what the create row needs.
  const slug = `garden-${Math.random().toString(36).slice(2, 8)}`;
  const name = humanizeSlug(slug);
  const text = uniqueText('Buy seeds');

  const input = page.getByRole('combobox', { name: 'Add an entry' });
  await input.fill(`${text} /${slug}`);
  const panel = page.locator('.composer-shell [role="listbox"]');
  await expect(panel).toBeVisible();
  await panel.getByRole('option', { name: /^Create collection/ }).click();

  const chip = page.getByRole('button', { name: `Destination: ${name}` });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('New');

  await page.getByRole('button', { name: 'Add entry' }).click();
  const toast = page.locator('.toast');
  await expect(toast).toContainText(`Added to ${name}`);
  const timelineRow = page.locator('.entry-row').filter({ hasText: text });
  await expect(timelineRow.getByText(text, { exact: true })).toHaveCount(1);
  await expect(timelineRow.getByText(name, { exact: true })).toBeVisible();

  await toast.getByRole('button', { name: 'View' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${slug}$`));
  await expect(page.getByText(text, { exact: true })).toBeVisible();

  // Scoped to the nav: the open collection carries its own "Index" back button.
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^Index/ })
    .click();
  await expect(page.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
});

test('tag autocomplete completes from the mirror and the accepted tag survives search', async ({
  baseURL,
  context,
  page,
}) => {
  const server = await pairAndBootstrap(context, baseURL);
  const tag = `harvest-${Math.random().toString(36).slice(2, 8)}`;
  const seeded = uniqueText('Seeded tagged entry');
  await seedOwnerEntry(context.request, baseURL, server, {
    text: seeded,
    type: 'note',
    tags: [tag],
  });

  await openJournal(page);
  // Located by class, not by role: the input is a combobox in both states —
  // only `aria-expanded` moves, which is exactly what the assertions below
  // check.
  const input = page.locator('.composer__input');
  const text = uniqueText('Completed tag capture');
  await input.fill(`- ${text} #`);

  // The panel lives inside the composer shell rather than a portal, so it rides
  // the same keyboard-open pinning the composer does.
  const panel = page.locator('.composer-shell [role="listbox"]');
  await expect(panel).toBeVisible();
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('combobox', { name: 'Add an entry' })).toHaveCount(1);

  // The full tag, not a prefix: a CI retry's leftover rows could share a
  // shorter prefix and outrank the seeded tag at row 0.
  await page.keyboard.type(tag);
  const option = panel.getByRole('option').filter({ hasText: `#${tag}` });
  await expect(option).toHaveCount(1);
  await page.keyboard.press('Enter');

  // Enter accepted the completion; it must not also have filed the entry.
  // The listbox stays in the DOM and goes hidden, so `aria-controls` never dangles.
  await expect(panel).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Add an entry' })).toHaveCount(1);
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  // The chip wears a `#` icon rather than the character, so its text is the bare
  // tag; the `#` survives in the removal control's accessible name.
  await expect(page.locator('.parse-chip').filter({ hasText: tag })).toHaveCount(1);
  await expect(page.getByRole('button', { name: `Remove tag #${tag}` })).toBeVisible();
  await expect(page.getByText(text, { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Add entry' }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();

  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: 'Search journal' });
  await search.getByRole('searchbox', { name: 'Search entries and tags' }).fill(`#${tag}`);
  await expect(search.getByText(text, { exact: true })).toBeVisible();
  await expect(search.getByText(seeded, { exact: true })).toBeVisible();
});

test('every capture sigil opens its own completion panel', async ({ page }) => {
  await openJournal(page);
  const input = page.locator('.composer__input');
  const panel = page.locator('.composer-shell [role="listbox"]');
  const caption = page.locator('.composer-suggestions__hint');

  // `>` opens on tomorrow and offers the shift grammar behind it, captioning
  // the shapes no row can show (`>2026-08-12`).
  await input.fill(`- ${uniqueText('Sigil sweep')} >`);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('option')).toHaveCount(6);
  await expect(panel.getByRole('option').first()).toHaveText(/^Tomorrow/);
  await expect(panel.getByRole('option').filter({ hasText: 'Next week' })).toHaveCount(1);
  await expect(caption).toBeVisible();
  await expect(caption).not.toBeEmpty();
  // The caption teaches; it is not a completion, so it must sit outside the listbox.
  await expect(panel.locator('.composer-suggestions__hint')).toHaveCount(0);

  // `@` names the four times of day, then fills with upcoming round hours.
  await input.fill(`- ${uniqueText('Sigil sweep')} @`);
  await expect(panel).toBeVisible();
  const times = panel.getByRole('option');
  await expect(times).toHaveCount(6);
  await expect(times.first()).toHaveText(/^Morning@09:00$/);
  for (const option of (await times.all()).slice(4)) {
    await expect(option).toHaveText(/^@\d{2}:00\d{1,2} (?:am|pm)$/);
  }
  await expect(caption).toContainText('@4pm');

  // Accepting a time writes the parsed clock, which the preview then echoes.
  // `@16` reaches exactly one hour and offers both its halves, so the `16:00`
  // row is there whatever the wall clock reads when this runs.
  await input.fill(`- ${uniqueText('Sigil sweep')} @16`);
  await expect(panel).toBeVisible();
  await expect(times).toHaveCount(2);
  await panel.getByRole('option').filter({ hasText: '@16:00' }).click();
  await expect(panel).toBeHidden();
  await expect(page.locator('.parse-chip').filter({ hasText: 'at 16:00' })).toHaveCount(1);

  // A sigil that opens no run is inert: `@mira` is a handle, not a half-typed time.
  await input.fill(`- ${uniqueText('Sigil sweep')} @mira`);
  await expect(panel).toBeHidden();
});

test('Timeline avoids a partial count while visible Activity rows persist their acknowledgement', async ({
  baseURL,
  context,
  page,
}) => {
  await pairAndBootstrap(context, baseURL);
  await openJournal(page);

  // Timeline is cursor-bounded, so it must not imply a complete task total.
  await expect(page.getByRole('button', { name: 'Timeline', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Timeline — / })).toHaveCount(0);

  const secret = await issueMcpSecret(page, uniqueText('Badge agent'));
  const client = new Client({ name: 'journal-badge-evidence', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  const agentText = uniqueText('Badge agent addition');
  let agentWrite: McpEntryWrite;
  try {
    await client.connect(transport as unknown as Transport);
    agentWrite = mcpEntryWrite(
      await client.callTool({
        name: 'add_entry',
        arguments: {
          idempotencyKey: ulid(),
          source: 'Playwright Activity indicator coverage',
          text: agentText,
          type: 'note',
        },
      }),
      agentText,
    );
  } finally {
    await client.close();
  }

  await expect(page.getByRole('button', { name: 'Activity — unseen changes' })).toBeVisible();

  await page.getByRole('button', { name: /^Activity/ }).click();
  await expect(page.getByRole('region', { name: 'Activity history' })).toBeVisible();
  await expect(page.getByRole('article').filter({ hasText: agentText })).toBeVisible();
  await expect
    .poll(async () => (await persistedActivityAcknowledgement(page))?.seenIds ?? [])
    .toContain(agentWrite.activityId);

  await page.reload();
  await expect(page.locator('#journal-content')).toBeVisible();
  await expect(page.getByRole('article').filter({ hasText: agentText })).toBeVisible();
  await expect
    .poll(async () => (await persistedActivityAcknowledgement(page))?.seenIds ?? [])
    .toContain(agentWrite.activityId);
});

test('Mark all seen persists an Activity high-water mark independently of row visibility', async ({
  baseURL,
  context,
  page,
}) => {
  await pairAndBootstrap(context, baseURL);
  await openJournal(page);
  const secret = await issueMcpSecret(page, uniqueText('Mark all agent'));
  const client = new Client({ name: 'journal-mark-all-evidence', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  const writes: McpEntryWrite[] = [];
  try {
    await client.connect(transport as unknown as Transport);
    for (let index = 0; index < 12; index += 1) {
      const text = uniqueText(`Mark all unseen ${index}`);
      writes.push(
        mcpEntryWrite(
          await client.callTool({
            name: 'add_entry',
            arguments: {
              idempotencyKey: ulid(),
              source: 'Playwright explicit Mark all coverage',
              text,
              type: 'note',
            },
          }),
          text,
        ),
      );
    }
  } finally {
    await client.close();
  }

  await expect(page.getByRole('button', { name: 'Activity — unseen changes' })).toBeVisible();
  await page.getByRole('button', { name: /^Activity/ }).click();
  const activity = page.getByRole('region', { name: 'Activity history' });
  await expect(activity).toBeVisible();
  await expect(activity.locator(`[data-activity-id="${writes.at(-1)?.activityId}"]`)).toBeVisible();
  const markAllSeen = page.getByRole('button', { name: 'Mark all seen' });
  await expect(markAllSeen).toBeVisible();
  await markAllSeen.click();
  await expect(page.getByRole('button', { name: 'Activity', exact: true })).toBeVisible();
  await expect
    .poll(async () => persistedActivityAcknowledgement(page))
    .toMatchObject({ cursor: { at: expect.any(String), id: expect.any(String) }, seenIds: [] });
  const markedThrough = (await persistedActivityAcknowledgement(page))?.cursor;
  expect(markedThrough).not.toBeNull();

  await page.reload();
  await expect(page.locator('#journal-content')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activity', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activity — unseen changes' })).toHaveCount(0);
  await expect
    .poll(async () => (await persistedActivityAcknowledgement(page))?.cursor)
    .toEqual(markedThrough);
});
