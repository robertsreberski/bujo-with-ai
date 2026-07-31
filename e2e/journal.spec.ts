import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { expect, test, type Page } from '@playwright/test';
import { ulid } from 'ulid';
import { openJournal, uniqueText } from './helpers';

interface McpEntryWrite {
  activityId: string;
  entry: { id: string; revision: number; text: string };
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

  await page.getByRole('textbox', { name: 'Add an entry' }).fill(`. ${text} #release`);
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
    await page.getByRole('button', { name: route.button, exact: true }).click();
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
    await pageA.getByRole('textbox', { name: 'Add an entry' }).fill(`- ${text} #convergence`);
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
  await page.getByRole('textbox', { name: 'Add an entry' }).fill(`- ${text}`);
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

  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const activity = page.getByRole('article').filter({ hasText: text });
  await expect(activity).toBeVisible();
  await activity.getByRole('button', { name: 'Revert' }).click();

  const confirmation = page.getByRole('dialog', { name: 'Revert this change?' });
  await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Revert change' }).click();
  await expect(page.getByText('Change reverted')).toBeVisible();
  await expect(activity.getByText('Reverted', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.getByText(text, { exact: true })).toHaveCount(0);
});

test('owner capture and automatic add-update-revert stay live and conflict safe', async ({
  baseURL,
  page,
}) => {
  await openJournal(page);

  const ownerText = uniqueText('Owner anchor capture');
  await page.getByRole('textbox', { name: 'Add an entry' }).fill(`- ${ownerText} #owner`);
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

  await page.getByRole('button', { name: 'Review', exact: true }).click();
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

  await page.getByRole('button', { name: 'Today', exact: true }).click();
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
