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
  entry: { text: string; type: string; tags?: string[] },
): Promise<void> {
  const created = await request.post('/api/entries', {
    data: {
      id: ulid(),
      text: entry.text,
      type: entry.type,
      time: null,
      tags: entry.tags ?? [],
      collection: null,
      dateIntent: {
        kind: 'today',
        baseToday: server.today,
        capturedAt: new Date().toISOString(),
        timezone: server.timezone,
      },
    },
    headers: { 'Idempotency-Key': ulid(), Origin: baseURL! },
  });
  expect(created.status()).toBe(201);
}

/** `humanizeSlug`, restated: the name a create-then-file capture mints. */
function humanizeSlug(slug: string): string {
  const words = slug.replace(/-+/g, ' ').trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** LOG-53's Today-badge formula, computed from the server's own bootstrap. */
async function openTodayCount(request: APIRequestContext, server: ServerContext): Promise<number> {
  const bootstrap = await request.get('/api/bootstrap');
  expect(bootstrap.ok()).toBeTruthy();
  const body = (await bootstrap.json()) as {
    entries?: Array<{ state?: string; type?: string; collection?: string | null; date?: string }>;
  };
  return (
    body.entries?.filter(
      (entry) =>
        entry.state === 'open' &&
        (entry.type === 'task' || entry.type === 'habit') &&
        (entry.collection ?? null) === null &&
        (entry.date ?? '') <= server.today,
    ).length ?? 0
  );
}

/** The count a nav item announces, or 0 when it carries no badge at all. */
async function navCount(page: Page, label: 'Today' | 'Review'): Promise<number> {
  const name = await page
    .getByRole('button', { name: new RegExp(`^${label}`) })
    .first()
    .getAttribute('aria-label');
  const match = /— (\d+) /.exec(name ?? '');
  return match ? Number(match[1]) : 0;
}

/** Reads the persisted client record straight out of IndexedDB. */
async function persistedReviewMark(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
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
            const record = read.result as { lastReviewSeenAt?: string | null } | undefined;
            database.close();
            resolve(record?.lastReviewSeenAt ?? null);
          };
        };
      }),
  );
}

async function issueMcpSecret(page: Page, tokenLabel: string): Promise<string> {
  await page.getByRole('button', { name: 'Assistant access', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Assistant access' });
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
    { button: 'Review', path: '/review', landmark: 'Assistant activity' },
    { button: 'Today', path: '/', landmark: 'Daily log' },
  ] as const;

  for (const route of routes) {
    // Prefix match: nav names may carry a count badge suffix ("Today — 1 open task").
    await page.getByRole('button', { name: new RegExp(`^${route.button}`) }).click();
    await expect(page).toHaveURL(new RegExp(`${route.path.replace('/', '\\/')}(?:\\?|$)`));
    await expect(page.getByRole('region', { name: route.landmark })).toBeVisible();
  }

  await page.reload();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
});

test('default Today downloads closed daily history beyond the bootstrap window', async ({
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
  const text = uniqueText('Downloaded closed history');
  const created = await context.request.post('/api/entries', {
    data: {
      id: ulid(),
      text,
      type: 'note',
      time: null,
      tags: ['history'],
      collection: null,
      dateIntent: {
        kind: 'absolute',
        date: historicalDate,
        baseToday: bootstrap.today,
        capturedAt: new Date().toISOString(),
        timezone: bootstrap.timezone,
      },
    },
    headers: { 'Idempotency-Key': ulid(), Origin: baseURL! },
  });
  expect(created.status()).toBe(201);

  await openJournal(page);

  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.locator(`[data-day="${historicalDate}"]`)).toContainText(text);
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

test('Assistant access exposes exactly seven tools with the approved write modes', async ({
  page,
}) => {
  await openJournal(page);
  await page.getByRole('button', { name: 'Assistant access', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Assistant access' });
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

test('Assistant access reports a live session and persists display preferences', async ({
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
    await page.getByRole('button', { name: 'Assistant access', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Assistant access' });
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

    await page.getByRole('button', { name: 'Assistant access', exact: true }).click();
    const reopened = page.getByRole('dialog', { name: 'Assistant access' });
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

  await page.getByRole('button', { name: /^Review/ }).click();
  const activity = page.getByRole('article').filter({ hasText: text });
  await expect(activity).toBeVisible();
  await activity.getByRole('button', { name: 'Revert' }).click();

  const confirmation = page.getByRole('dialog', { name: 'Revert this change?' });
  await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Revert change' }).click();
  await expect(page.getByText('Change reverted')).toBeVisible();
  await expect(activity.getByText('Reverted', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /^Today/ }).click();
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

  await page.getByRole('button', { name: /^Review/ }).click();
  const updateActivity = page.getByRole('article').filter({ hasText: updateReason });
  const addActivity = page
    .getByRole('article')
    .filter({ hasText: 'agent add' })
    .filter({ hasText: originalText });
  await expect(updateActivity).toContainText(updatedText);
  await expect(addActivity).toContainText('agent add');
  await updateActivity.getByRole('button', { name: 'Revert' }).click();

  const confirmation = page.getByRole('dialog', { name: 'Revert this change?' });
  await confirmation.getByRole('button', { name: 'Revert change' }).click();
  await expect(page.getByText('Change reverted')).toBeVisible();
  await expect(updateActivity.getByText('Reverted', { exact: true })).toBeVisible();
  await expect(addActivity.getByText('Changed since — newer work preserved')).toBeVisible();
  await expect(addActivity.getByRole('button', { name: 'Revert' })).toHaveCount(0);

  await page.getByRole('button', { name: /^Today/ }).click();
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
  await page.getByRole('button', { name: /^Month/ }).click();
  await expect(page).toHaveURL(/\/month(?:\?|$)/);

  // The screen's own default: the month being browsed, named as the chip says.
  const chip = page.getByRole('button', { name: /^Destination: / });
  const chipLabel = ((await chip.getAttribute('aria-label')) ?? '').replace('Destination: ', '');
  expect(chipLabel).toMatch(/^[A-Z][a-z]+ \d{4}$/);

  const text = uniqueText('Month spread capture');
  await page.getByRole('combobox', { name: 'Add an entry' }).fill(`- ${text}`);
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
  await expect(page.getByText(text, { exact: true })).toHaveCount(0);

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
  // the same keyboard-open pinning the composer does (SPEC-05 §4).
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
  await expect(panel).toHaveCount(0);
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

  // `>` completes the one date shift the parser understands, and captions why.
  await input.fill(`- ${uniqueText('Sigil sweep')} >`);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('option')).toHaveCount(1);
  await expect(panel.getByRole('option', { name: /Tomorrow/ })).toBeVisible();
  await expect(caption).toBeVisible();
  await expect(caption).not.toBeEmpty();
  // The caption teaches; it is not a completion, so it must sit outside the listbox.
  await expect(panel.locator('.composer-suggestions__hint')).toHaveCount(0);

  // `@` offers the next three round hours, each glossed in 12-hour form.
  await input.fill(`- ${uniqueText('Sigil sweep')} @`);
  await expect(panel).toBeVisible();
  const hours = panel.getByRole('option');
  await expect(hours).toHaveCount(3);
  for (const option of await hours.all()) {
    await expect(option).toHaveText(/^@\d{2}:00\d{1,2} (?:am|pm)$/);
  }
  await expect(caption).toContainText('@4pm');

  // Accepting a time writes the parsed clock, which the preview then echoes.
  const clock = ((await hours.first().textContent()) ?? '').slice(1, 6);
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.parse-chip').filter({ hasText: `at ${clock}` })).toHaveCount(1);

  // A sigil that opens no run is inert: `@mira` is a handle, not a half-typed time.
  await input.fill(`- ${uniqueText('Sigil sweep')} @mira`);
  await expect(panel).toHaveCount(0);
});

test('the Today and Review tabs announce their counts and Review stays cleared', async ({
  baseURL,
  context,
  page,
}) => {
  const server = await pairAndBootstrap(context, baseURL);
  await openJournal(page);

  // Anchor the baseline to server truth, not to whatever the badge shows
  // mid-hydration — the shared database already carries earlier specs' rows.
  const openBefore = await openTodayCount(context.request, server);
  await expect.poll(() => navCount(page, 'Today')).toBe(openBefore);
  await seedOwnerEntry(context.request, baseURL, server, {
    text: uniqueText('Badge open task'),
    type: 'task',
  });
  // The count rides the same SSE batch as the row, so it needs no reload.
  await expect.poll(() => navCount(page, 'Today')).toBe(openBefore + 1);
  await expect(page.getByRole('button', { name: /^Today — \d+ open tasks?$/ })).toBeVisible();

  const unseenBefore = await navCount(page, 'Review');
  const secret = await issueMcpSecret(page, uniqueText('Badge agent'));
  const client = new Client({ name: 'journal-badge-evidence', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  const agentText = uniqueText('Badge agent addition');
  try {
    await client.connect(transport as unknown as Transport);
    mcpEntryWrite(
      await client.callTool({
        name: 'add_entry',
        arguments: {
          idempotencyKey: ulid(),
          source: 'Playwright review-badge coverage',
          text: agentText,
          type: 'note',
        },
      }),
      agentText,
    );
  } finally {
    await client.close();
  }

  await expect.poll(() => navCount(page, 'Review')).toBe(unseenBefore + 1);
  await expect(page.getByRole('button', { name: /^Review — \d+ unseen changes?$/ })).toBeVisible();

  await page.getByRole('button', { name: /^Review/ }).click();
  await expect(page.getByRole('region', { name: 'Assistant activity' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
  // The mark is local and debounced; reload only proves anything once it landed.
  await expect.poll(() => persistedReviewMark(page)).not.toBeNull();

  await page.reload();
  await expect(page.locator('#journal-content')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Review — / })).toHaveCount(0);
});
