import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { ulid } from 'ulid';
import { openJournal, uniqueText } from './helpers';

interface BootstrapEvidence {
  today: string;
  timezone: string;
}

interface EntryEvidence {
  id: string;
  text: string;
  date: string;
  state: string;
  type: string;
  time: string | null;
  tags: string[];
  author: string;
  collection: string | null;
  migrations: number;
  revision: number;
  deletedAt: string | null;
}

interface CollectionEvidence {
  id: string;
  name: string;
  note: string | null;
  archivedAt: string | null;
}

interface SummaryEvidence {
  id: string;
  weekStart: string;
  text: string;
  status: 'current' | 'saved' | 'stale';
  savedEntryId: string | null;
  revision: number;
}

interface MotionEvidence {
  animationDuration: string;
  animationName: string;
  animationTimingFunction: string;
  transitionDuration: string;
  transitionProperty: string;
  transitionTimingFunction: string;
}

const SPARKLE_PATH = 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z';

const DESIGN_TOKENS = {
  '--bg-page': '#16130f',
  '--bg': '#1e1a17',
  '--bg-hover': '#241f1b',
  '--bg-line': '#2b2521',
  '--bg-raised': '#3a322c',
  '--border': '#352e28',
  '--border-strong': '#574d45',
  '--border-check': '#5c5148',
  '--border-control': '#7b6d63',
  '--fg': '#f5efea',
  '--fg-body': '#d6ccc4',
  '--fg-mid': '#b3a79e',
  '--fg-mute': '#9c8f85',
  '--fg-faint': '#968a81',
  '--primary': '#e4652e',
  '--primary-hover': '#f0773d',
  '--primary-fg': '#1b1310',
  '--ai-bg': 'rgb(228 101 46 / 15%)',
  '--ai-fg': '#f09a70',
  '--ai-border': 'rgb(228 101 46 / 42%)',
  '--danger': '#f3978b',
  '--danger-bg-hover': '#3a211c',
  '--danger-border': '#704238',
  '--ok': '#4ade80',
  '--warning': '#f2b56d',
  '--overlay': 'rgb(0 0 0 / 70%)',
  '--shadow-menu': '0 10px 30px -10px rgb(0 0 0 / 55%)',
  '--shadow-dialog': '0 24px 60px -20px rgb(0 0 0 / 70%)',
  '--shadow-toast': '0 12px 30px -12px rgb(0 0 0 / 70%)',
} as const;

function requireBaseUrl(baseURL: string | undefined): string {
  expect(baseURL).toBeTruthy();
  return baseURL ?? '';
}

function addCalendarDays(date: string, amount: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

function shiftMonth(month: string, amount: number): string {
  const [year = 0, monthNumber = 1] = month.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + amount, 1, 12));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(month: string): number {
  const [year = 0, monthNumber = 1] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0, 12)).getUTCDate();
}

function firstMondayOfMonth(month: string): string {
  const first = new Date(`${month}-01T12:00:00Z`);
  const offset = (8 - first.getUTCDay()) % 7;
  first.setUTCDate(first.getUTCDate() + offset);
  return first.toISOString().slice(0, 10);
}

function collectionSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);
}

async function pairAndBootstrap(
  context: BrowserContext,
  baseURL: string,
): Promise<BootstrapEvidence> {
  const paired = await context.request.post('/api/pair', {
    data: {},
    headers: { Origin: baseURL },
  });
  expect(paired.status()).toBe(201);
  const response = await context.request.get('/api/bootstrap');
  expect(response.ok()).toBeTruthy();
  const document = (await response.json()) as Partial<BootstrapEvidence>;
  expect(document).toMatchObject({ today: expect.any(String), timezone: expect.any(String) });
  return { today: document.today ?? '', timezone: document.timezone ?? '' };
}

async function createOwnerEntry(
  context: BrowserContext,
  baseURL: string,
  bootstrap: BootstrapEvidence,
  input: {
    text: string;
    date: string;
    type?: 'task' | 'note' | 'habit';
    collection?: string | null;
    tags?: string[];
  },
): Promise<EntryEvidence> {
  const response = await context.request.post('/api/entries', {
    data: {
      id: ulid(),
      text: input.text,
      type: input.type ?? 'task',
      time: null,
      tags: input.tags ?? ['release-evidence'],
      collection: input.collection ?? null,
      dateIntent: {
        kind: 'absolute',
        date: input.date,
        baseToday: bootstrap.today,
        capturedAt: new Date().toISOString(),
        timezone: bootstrap.timezone,
      },
    },
    headers: { 'Idempotency-Key': ulid(), Origin: baseURL },
  });
  expect(response.status(), await response.text()).toBe(201);
  const document = (await response.json()) as { entry?: EntryEvidence };
  expect(document.entry).toMatchObject({
    id: expect.any(String),
    text: input.text,
    date: input.date,
    revision: expect.any(Number),
  });
  if (!document.entry) throw new Error('Entry creation did not return an entry.');
  return document.entry;
}

async function createOwnerCollection(
  context: BrowserContext,
  baseURL: string,
  input: { id: string; name: string; note?: string | null },
): Promise<CollectionEvidence> {
  const response = await context.request.post('/api/collections', {
    data: { id: input.id, name: input.name, note: input.note ?? null },
    headers: { 'Idempotency-Key': ulid(), Origin: baseURL },
  });
  expect(response.status(), await response.text()).toBe(201);
  const document = (await response.json()) as { collection?: CollectionEvidence };
  expect(document.collection).toMatchObject({ id: input.id, name: input.name });
  if (!document.collection) throw new Error('Collection creation did not return a collection.');
  return document.collection;
}

async function listCollections(context: BrowserContext): Promise<CollectionEvidence[]> {
  const response = await context.request.get('/api/collections');
  expect(response.ok(), await response.text()).toBeTruthy();
  const document = (await response.json()) as { items?: CollectionEvidence[] };
  expect(document.items).toEqual(expect.any(Array));
  return document.items ?? [];
}

async function updateEntryState(
  context: BrowserContext,
  baseURL: string,
  entry: EntryEvidence,
  state: 'done' | 'cancelled',
): Promise<EntryEvidence> {
  const response = await context.request.patch(`/api/entries/${entry.id}`, {
    data: { patch: { state }, expectedRevision: entry.revision },
    headers: { 'Idempotency-Key': ulid(), Origin: baseURL },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const document = (await response.json()) as { entry?: EntryEvidence };
  if (!document.entry) throw new Error('Entry update did not return an entry.');
  return document.entry;
}

async function listEntries(
  context: BrowserContext,
  query: Record<string, string | number>,
): Promise<EntryEvidence[]> {
  const parameters = new URLSearchParams(
    Object.entries(query).map(([name, value]) => [name, String(value)]),
  );
  const response = await context.request.get(`/api/entries?${parameters}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const document = (await response.json()) as { items?: EntryEvidence[] };
  expect(document.items).toEqual(expect.any(Array));
  return document.items ?? [];
}

async function closeHistoricalOpenTasks(
  context: BrowserContext,
  baseURL: string,
  today: string,
): Promise<void> {
  const historical = await listEntries(context, {
    to: addCalendarDays(today, -1),
    state: 'open',
    type: 'task',
    limit: 100,
  });
  for (const entry of historical) await updateEntryState(context, baseURL, entry, 'cancelled');
}

async function captureEvidenceScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
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
    expect(box, `${surface}: ${label} has a box`).not.toBeNull();
    expect(box?.width, `${surface}: ${label} width`).toBeGreaterThanOrEqual(40);
    expect(box?.height, `${surface}: ${label} height`).toBeGreaterThanOrEqual(40);
  }
}

async function waitForFiniteAnimations(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

function cssTimeMilliseconds(value: string): number {
  const durations = value.split(',').map((part) => {
    const duration = part.trim();
    if (duration.endsWith('ms')) return Number.parseFloat(duration);
    if (duration.endsWith('s')) return Number.parseFloat(duration) * 1_000;
    throw new Error(`Unsupported CSS duration: ${duration}`);
  });
  return Math.max(...durations);
}

async function motionStyle(locator: Locator): Promise<MotionEvidence> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      animationDuration: style.animationDuration,
      animationName: style.animationName,
      animationTimingFunction: style.animationTimingFunction,
      transitionDuration: style.transitionDuration,
      transitionProperty: style.transitionProperty,
      transitionTimingFunction: style.transitionTimingFunction,
    };
  });
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

async function createAssistantEntry(page: Page, baseURL: string, text: string): Promise<string> {
  const secret = await issueMcpSecret(page, uniqueText('Release evidence agent'));
  const client = new Client({ name: 'journal-release-evidence', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  try {
    await client.connect(transport as unknown as Transport);
    const result = await client.callTool({
      name: 'add_entry',
      arguments: {
        idempotencyKey: ulid(),
        source: 'Release evidence design-system journey',
        tags: ['release-evidence'],
        text,
        type: 'note',
      },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { entry?: { id?: unknown; text?: unknown } };
    expect(structured.entry).toMatchObject({ id: expect.any(String), text });
    if (typeof structured.entry?.id !== 'string') {
      throw new Error('MCP add_entry did not return an entry id.');
    }
    return structured.entry.id;
  } finally {
    await client.close();
  }
}

async function createAssistantSummary(
  page: Page,
  baseURL: string,
  weekStart: string,
  summaryText: string,
): Promise<SummaryEvidence> {
  const secret = await issueMcpSecret(page, uniqueText('Release summary agent'));
  const client = new Client({ name: 'journal-release-summary-evidence', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  try {
    await client.connect(transport as unknown as Transport);
    const result = await client.callTool({
      name: 'add_entry',
      arguments: {
        idempotencyKey: ulid(),
        source: 'Release evidence weekly synthesis',
        summaryWeekStart: weekStart,
        tags: ['summary'],
        text: summaryText,
        type: 'note',
      },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      kind?: unknown;
      summary?: SummaryEvidence;
    };
    expect(structured).toMatchObject({
      kind: 'summary',
      summary: {
        id: expect.any(String),
        weekStart,
        text: summaryText,
        status: 'current',
        revision: expect.any(Number),
      },
    });
    if (!structured.summary) throw new Error('MCP add_entry did not return a summary.');
    return structured.summary;
  } finally {
    await client.close();
  }
}

async function getLatestSummary(
  context: BrowserContext,
  month: string,
): Promise<SummaryEvidence | null> {
  const response = await context.request.get(`/api/summary/latest?month=${month}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const document = (await response.json()) as { summary?: SummaryEvidence | null };
  return document.summary ?? null;
}

test('the migration ritual completes move, done, monthly, and drop outcomes in order', async ({
  baseURL,
  context,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'The evidence spec controls its viewport.',
  );
  const origin = requireBaseUrl(baseURL);
  const bootstrap = await pairAndBootstrap(context, origin);
  await closeHistoricalOpenTasks(context, origin, bootstrap.today);
  const labels = {
    move: uniqueText('Migration move'),
    done: uniqueText('Migration done'),
    monthly: uniqueText('Migration monthly'),
    drop: uniqueText('Migration drop'),
  };
  const created = {
    move: await createOwnerEntry(context, origin, bootstrap, {
      text: labels.move,
      date: addCalendarDays(bootstrap.today, -4),
    }),
    done: await createOwnerEntry(context, origin, bootstrap, {
      text: labels.done,
      date: addCalendarDays(bootstrap.today, -3),
    }),
    monthly: await createOwnerEntry(context, origin, bootstrap, {
      text: labels.monthly,
      date: addCalendarDays(bootstrap.today, -2),
    }),
    drop: await createOwnerEntry(context, origin, bootstrap, {
      text: labels.drop,
      date: addCalendarDays(bootstrap.today, -1),
    }),
  };

  await page.setViewportSize({ width: 375, height: 812 });
  await openJournal(page);
  await page.getByRole('button', { name: 'Review them' }).click();
  const dialog = page.getByRole('dialog', { name: 'Migration' });
  await expect(dialog).toContainText('1 of 4');
  await expect(dialog.getByRole('heading', { name: labels.move, exact: true })).toBeVisible();
  await waitForFiniteAnimations(dialog);
  await expectTouchTargets(page, 'Migration ritual');
  await captureEvidenceScreenshot(page, testInfo, 'migration-ritual-375.png');

  await dialog.getByRole('button', { name: 'Move to today' }).click();
  await expect(dialog.getByRole('heading', { name: labels.done, exact: true })).toBeFocused();
  await expect(dialog).toContainText('2 of 4');
  await dialog.getByRole('button', { name: 'Mark done' }).click();
  await expect(dialog.getByRole('heading', { name: labels.monthly, exact: true })).toBeFocused();
  await expect(dialog).toContainText('3 of 4');
  await dialog.getByRole('button', { name: 'To monthly log' }).click();
  await expect(dialog.getByRole('heading', { name: labels.drop, exact: true })).toBeFocused();
  await expect(dialog).toContainText('4 of 4');
  await dialog.getByRole('button', { name: 'Drop it' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'All caught up' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review them' })).toHaveCount(0);

  const entries = await listEntries(context, {
    from: addCalendarDays(bootstrap.today, -4),
    to: bootstrap.today,
    limit: 100,
  });
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  expect(byId.get(created.move.id)?.state).toBe('migrated');
  expect(byId.get(created.done.id)?.state).toBe('done');
  expect(byId.get(created.monthly.id)?.state).toBe('scheduled');
  expect(byId.get(created.drop.id)?.state).toBe('cancelled');
  expect(entries).toContainEqual(
    expect.objectContaining({
      text: labels.move,
      date: bootstrap.today,
      state: 'open',
      collection: null,
      migrations: created.move.migrations + 1,
    }),
  );
  expect(entries).toContainEqual(
    expect.objectContaining({
      text: labels.monthly,
      state: 'open',
      collection: `month:${bootstrap.today.slice(0, 7)}`,
    }),
  );
});

test('a collection can be created, renamed, filled, opened, and archived without losing its entry', async ({
  baseURL,
  context,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'The release evidence runs once on the desktop project.',
  );
  const origin = requireBaseUrl(baseURL);
  const bootstrap = await pairAndBootstrap(context, origin);
  const entryText = uniqueText('Collection filing evidence');
  const entry = await createOwnerEntry(context, origin, bootstrap, {
    text: entryText,
    date: bootstrap.today,
    type: 'note',
  });
  const collectionName = uniqueText('Release collection');
  const renamedCollection = `${collectionName} renamed`;
  const collectionNote = 'Created and archived through the release browser journey.';
  const collectionId = collectionSlug(collectionName);

  await openJournal(page);
  await page.getByRole('button', { name: 'Index', exact: true }).click();
  const collectionsSection = page.locator('.index-group').filter({
    has: page.getByRole('heading', { name: 'Collections', exact: true }),
  });
  await collectionsSection.getByRole('button', { name: 'New', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: 'New collection' });
  await createDialog.getByRole('textbox', { name: 'Name', exact: true }).fill(collectionName);
  await createDialog.getByRole('textbox', { name: /Short description/ }).fill(collectionNote);
  await createDialog.getByRole('button', { name: 'Create collection' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Collection created' })).toBeVisible();
  await expect(collectionsSection.getByText(collectionName, { exact: true })).toBeVisible();

  await collectionsSection
    .getByRole('button', { name: `Edit ${collectionName}`, exact: true })
    .click();
  const editCollection = page.getByRole('dialog', { name: 'Edit collection' });
  await editCollection.getByRole('textbox', { name: 'Name', exact: true }).fill(renamedCollection);
  await editCollection.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Collection updated' })).toBeVisible();
  await expect(collectionsSection.getByText(renamedCollection, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /^Timeline/ }).click();
  const entryRow = page.locator(`[data-entry-id="${entry.id}"]`);
  await entryRow.locator('.entry-row__content').click();
  const entryDialog = page.getByRole('dialog', { name: entryText });
  await entryDialog
    .getByRole('combobox', { name: 'File in collection' })
    .selectOption({ label: renamedCollection });
  await expect(page.getByRole('status').filter({ hasText: 'Entry filed' })).toBeVisible();
  await expect(entryDialog).toHaveCount(0);

  await page.getByRole('button', { name: 'Index', exact: true }).click();
  const collectionRow = collectionsSection.locator('.index-row').filter({
    hasText: renamedCollection,
  });
  await expect(collectionRow).toContainText('1 items');
  await collectionRow.locator('.index-row__main').click();
  await expect(page).toHaveURL(new RegExp(`/c/${collectionId}$`));
  await expect(
    page
      .locator('.collection-screen')
      .getByRole('heading', { name: renamedCollection, exact: true }),
  ).toBeVisible();
  await expect(page.getByText('1 items · 0 done', { exact: true })).toBeVisible();
  await expect(page.locator(`[data-entry-id="${entry.id}"]`)).toContainText(entryText);

  await page
    .locator('.collection-screen')
    .getByRole('button', { name: 'Index', exact: true })
    .click();
  await collectionsSection
    .getByRole('button', { name: `Edit ${renamedCollection}`, exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Edit collection' })
    .getByRole('button', {
      name: 'Archive',
      exact: true,
    })
    .click();
  const archiveDialog = page.getByRole('dialog', { name: `Archive ${renamedCollection}?` });
  await archiveDialog.getByRole('button', { name: 'Archive collection' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Collection archived' })).toBeVisible();
  await expect(collectionsSection.getByText(renamedCollection, { exact: true })).toHaveCount(0);
  await expect
    .poll(async () => (await listCollections(context)).some((item) => item.id === collectionId))
    .toBe(false);
  const filedEntries = await listEntries(context, { collection: collectionId, limit: 100 });
  expect(filedEntries).toContainEqual(
    expect.objectContaining({ id: entry.id, text: entryText, collection: collectionId }),
  );
});

test('entry detail supports a full edit followed by legal move, file, and delete actions', async ({
  baseURL,
  context,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'The release evidence runs once on the desktop project.',
  );
  const origin = requireBaseUrl(baseURL);
  const bootstrap = await pairAndBootstrap(context, origin);
  const collectionId = `release-actions-${ulid().toLowerCase()}`;
  const collectionName = uniqueText('Action destination');
  await createOwnerCollection(context, origin, {
    id: collectionId,
    name: collectionName,
    note: 'Receives the edited entry before deletion.',
  });
  const originalText = uniqueText('Editable release entry');
  const updatedText = uniqueText('Edited release entry');
  const entry = await createOwnerEntry(context, origin, bootstrap, {
    text: originalText,
    date: addCalendarDays(bootstrap.today, -5),
    type: 'note',
    tags: ['release-evidence', 'draft'],
  });
  const editedDate = addCalendarDays(bootstrap.today, -4);

  await openJournal(page);
  let row = page.locator(`[data-entry-id="${entry.id}"]`);
  await row.locator('.entry-row__content').click();
  await page
    .getByRole('dialog', { name: originalText })
    .getByRole('button', {
      name: 'Edit',
      exact: true,
    })
    .click();
  const editDialog = page.getByRole('dialog', { name: 'Edit entry' });
  await editDialog.getByRole('textbox', { name: 'Text', exact: true }).fill(updatedText);
  await editDialog.getByRole('combobox', { name: 'Type', exact: true }).selectOption('idea');
  await editDialog.getByLabel('Date', { exact: true }).fill(editedDate);
  await editDialog.getByLabel('Time', { exact: false }).fill('09:30');
  await editDialog.getByLabel(/^Tags/).fill('release-evidence, edited');
  await editDialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Entry updated' })).toBeVisible();

  row = page.locator(`[data-entry-id="${entry.id}"]`);
  await expect(row).toContainText(updatedText);
  await row.locator('.entry-row__content').click();
  const detail = page.getByRole('dialog', { name: updatedText });
  await expect(detail).toContainText('Idea');
  await expect(detail).toContainText('#release-evidence #edited');
  await detail.getByRole('button', { name: 'Move to today' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Moved to today' })).toBeVisible();

  row = page.locator(`[data-entry-id="${entry.id}"]`);
  await row.locator('.entry-row__content').click();
  await page
    .getByRole('dialog', { name: updatedText })
    .getByRole('combobox', { name: 'File in collection' })
    .selectOption(collectionId);
  await expect(page.getByRole('status').filter({ hasText: 'Entry filed' })).toBeVisible();
  await expect(page.locator(`[data-entry-id="${entry.id}"]`)).toHaveCount(0);

  await page.getByRole('button', { name: 'Index', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^${collectionName}`) }).click();
  row = page.locator(`[data-entry-id="${entry.id}"]`);
  await expect(row).toContainText(updatedText);
  await row.locator('.entry-row__content').click();
  await page
    .getByRole('dialog', { name: updatedText })
    .getByRole('button', {
      name: 'Delete',
      exact: true,
    })
    .click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete this entry?' });
  await deleteDialog.getByRole('button', { name: 'Delete entry' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Entry deleted' })).toBeVisible();
  await expect(page.locator(`[data-entry-id="${entry.id}"]`)).toHaveCount(0);

  const liveMatches = await listEntries(context, { q: updatedText, limit: 100 });
  expect(liveMatches.some((item) => item.id === entry.id)).toBe(false);
});

test('authoritative text, exact tags, and all three saved views return the intended entries', async ({
  baseURL,
  context,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'The release evidence runs once on the desktop project.',
  );
  test.slow();
  const origin = requireBaseUrl(baseURL);
  const bootstrap = await pairAndBootstrap(context, origin);
  const textQuery = uniqueText('Authoritative search needle');
  const authoritative = await createOwnerEntry(context, origin, bootstrap, {
    text: textQuery,
    date: addCalendarDays(bootstrap.today, -30),
    type: 'note',
    tags: ['release-evidence', 'work'],
  });
  const distractor = await createOwnerEntry(context, origin, bootstrap, {
    text: uniqueText('Exact tag distractor'),
    date: bootstrap.today,
    type: 'note',
    tags: ['release-evidence', 'workbench'],
  });
  const openTask = await createOwnerEntry(context, origin, bootstrap, {
    text: uniqueText('Saved open task'),
    date: bootstrap.today,
    type: 'task',
  });

  await openJournal(page);
  const assistantText = uniqueText('Saved assistant entry');
  const assistantId = await createAssistantEntry(page, origin, assistantText);

  await page
    .getByRole('complementary', { name: 'Primary navigation' })
    .getByRole('button', { name: /^Search/ })
    .click();
  let searchDialog = page.getByRole('dialog', { name: 'Search journal' });
  let searchInput = searchDialog.getByRole('searchbox', { name: 'Search entries and tags' });
  let results = searchDialog.getByLabel('Search results');
  const authoritativeResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/entries' && url.searchParams.get('q') === textQuery;
  });
  await searchInput.fill(textQuery);
  const authoritativeDocument = (await (await authoritativeResponse).json()) as {
    items?: EntryEvidence[];
  };
  expect(authoritativeDocument.items).toContainEqual(
    expect.objectContaining({ id: authoritative.id, text: textQuery }),
  );
  await expect(results.locator(`[data-entry-id="${authoritative.id}"]`)).toBeVisible();
  await expect(results).toHaveAttribute('aria-busy', 'false');
  await expect(results.locator(`[data-entry-id="${distractor.id}"]`)).toHaveCount(0);

  const exactTagResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/entries' && url.searchParams.get('tag') === 'work';
  });
  await searchInput.fill('#work');
  const exactTagDocument = (await (await exactTagResponse).json()) as {
    items?: EntryEvidence[];
  };
  expect(exactTagDocument.items).toContainEqual(expect.objectContaining({ id: authoritative.id }));
  expect(exactTagDocument.items?.some((entry) => entry.id === distractor.id)).toBe(false);
  await expect(results.locator(`[data-entry-id="${authoritative.id}"]`)).toBeVisible();
  await expect(results).toHaveAttribute('aria-busy', 'false');
  await expect(results.locator(`[data-entry-id="${distractor.id}"]`)).toHaveCount(0);
  await searchDialog.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('button', { name: 'Index', exact: true }).click();
  const savedViews = page.locator('.index-group').filter({
    has: page.getByRole('heading', { name: 'Saved views', exact: true }),
  });

  await savedViews.getByRole('button', { name: /^Open tasks/ }).click();
  searchDialog = page.getByRole('dialog', { name: 'Search journal' });
  searchInput = searchDialog.getByRole('searchbox', { name: 'Search entries and tags' });
  results = searchDialog.getByLabel('Search results');
  await expect(searchInput).toHaveValue('is:open');
  await expect(results.locator(`[data-entry-id="${openTask.id}"]`)).toBeVisible();
  await expect(results.locator(`[data-entry-id="${authoritative.id}"]`)).toHaveCount(0);
  await searchDialog.getByRole('button', { name: 'Close dialog' }).click();

  await savedViews.getByRole('button', { name: /^Added by assistant/ }).click();
  searchDialog = page.getByRole('dialog', { name: 'Search journal' });
  results = searchDialog.getByLabel('Search results');
  await expect(searchDialog.getByRole('searchbox')).toHaveValue('by:assistant');
  await expect(results.locator(`[data-entry-id="${assistantId}"]`)).toBeVisible();
  await expect(results.locator(`[data-entry-id="${openTask.id}"]`)).toHaveCount(0);
  await searchDialog.getByRole('button', { name: 'Close dialog' }).click();

  await savedViews.getByRole('button', { name: /^Tagged #work/ }).click();
  searchDialog = page.getByRole('dialog', { name: 'Search journal' });
  results = searchDialog.getByLabel('Search results');
  await expect(searchDialog.getByRole('searchbox')).toHaveValue('#work');
  await expect(results.locator(`[data-entry-id="${authoritative.id}"]`)).toBeVisible();
  await expect(results.locator(`[data-entry-id="${distractor.id}"]`)).toHaveCount(0);
});

test('the month flow exposes calendar navigation and the complete habit grid at four widths', async ({
  baseURL,
  browser,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'The evidence spec controls its viewport.',
  );
  const origin = requireBaseUrl(baseURL);
  const bootstrap = await pairAndBootstrap(context, origin);
  const month = bootstrap.today.slice(0, 7);
  const habitText = uniqueText('Release habit');
  const monthlyText = uniqueText('Release monthly note');
  const doneHabit = await createOwnerEntry(context, origin, bootstrap, {
    text: habitText,
    date: `${month}-01`,
    type: 'habit',
  });
  await updateEntryState(context, origin, doneHabit, 'done');
  await createOwnerEntry(context, origin, bootstrap, {
    text: habitText,
    date: `${month}-02`,
    type: 'habit',
  });
  await createOwnerEntry(context, origin, bootstrap, {
    text: monthlyText,
    date: bootstrap.today,
    type: 'note',
    collection: `month:${month}`,
  });

  for (const viewport of [
    { width: 320, height: 700, mobile: true },
    { width: 375, height: 812, mobile: true },
    { width: 680, height: 900, mobile: false },
    { width: 1_280, height: 900, mobile: false },
  ]) {
    const screenshotContext = await browser.newContext({
      baseURL: origin,
      hasTouch: viewport.mobile,
      isMobile: viewport.mobile,
      viewport: { width: viewport.width, height: viewport.height },
    });
    const screenshotPage = await screenshotContext.newPage();
    try {
      await openJournal(screenshotPage);
      await screenshotPage.getByRole('button', { name: 'Month', exact: true }).click();
      await expect(screenshotPage.getByText(monthlyText, { exact: true })).toBeVisible();
      const grid = screenshotPage.getByRole('list', {
        name: new RegExp(`^${habitText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`),
      });
      await expect(grid).toBeVisible();
      await expect(grid.getByRole('listitem')).toHaveCount(daysInMonth(month));
      await expect(grid.locator('.habit-cell--done')).toHaveCount(1);
      await expect(grid.locator('[tabindex]')).toHaveCount(0);
      await expect(grid.locator('.habit-cell--done')).toHaveCSS(
        'background-color',
        'rgb(228, 101, 46)',
      );

      const frameWidth = await screenshotPage
        .locator('.app-frame')
        .evaluate((element) => Math.round(element.getBoundingClientRect().width));
      expect(frameWidth).toBe(viewport.width >= 1_024 ? 1_160 : Math.min(viewport.width, 860));
      const horizontalOverflow = await screenshotPage.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(horizontalOverflow).toBeLessThanOrEqual(0);
      await grid.scrollIntoViewIfNeeded();
      await captureEvidenceScreenshot(
        screenshotPage,
        testInfo,
        `month-habit-${viewport.width}.png`,
      );

      if (viewport.width === 375) {
        await screenshotPage.getByRole('button', { name: 'Previous month' }).click();
        await expect(screenshotPage).toHaveURL(new RegExp(`month=${shiftMonth(month, -1)}`));
        await screenshotPage.getByRole('button', { name: 'Next month' }).click();
        await expect(screenshotPage).toHaveURL(new RegExp(`month=${month}`));
        await screenshotPage.locator('.calendar-day[aria-current="date"]').click();
        await expect(screenshotPage).toHaveURL(
          new RegExp(`\\?date=${bootstrap.today.replaceAll('-', '\\-')}$`),
        );
        await expect(screenshotPage.locator(`[data-day="${bootstrap.today}"]`)).toBeFocused();
      }
    } finally {
      await screenshotContext.close();
    }
  }
});

test('the weekly Summary card saves an assistant note before requesting a rewrite', async ({
  baseURL,
  context,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'The release evidence runs once on the desktop project.',
  );
  const origin = requireBaseUrl(baseURL);
  const bootstrap = await pairAndBootstrap(context, origin);
  const month = bootstrap.today.slice(0, 7);
  const weekStart = firstMondayOfMonth(month);
  const summaryText = uniqueText('Weekly release reflection');

  await openJournal(page);
  const created = await createAssistantSummary(page, origin, weekStart, summaryText);
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  const summaryCard = page.locator('.summary-card');
  await expect(summaryCard.getByRole('heading', { name: 'Weekly summary' })).toBeVisible();
  await expect(summaryCard).toContainText(summaryText);
  await expect(summaryCard).toContainText('generated automatically');

  await summaryCard.getByRole('button', { name: 'Save to today' }).click();
  await expect(summaryCard.getByRole('button', { name: 'Saved to today' })).toBeDisabled();
  await expect(
    page.getByRole('status').filter({ hasText: 'Weekly summary saved to today' }),
  ).toBeVisible();
  await expect.poll(async () => (await getLatestSummary(context, month))?.status).toBe('saved');
  const saved = await getLatestSummary(context, month);
  expect(saved).toMatchObject({
    id: created.id,
    status: 'saved',
    savedEntryId: expect.any(String),
  });
  if (!saved?.savedEntryId) throw new Error('Saved summary did not reference its entry.');
  const savedEntryId = saved.savedEntryId;
  const summaryEntries = await listEntries(context, { tag: 'summary', limit: 100 });
  expect(summaryEntries).toContainEqual(
    expect.objectContaining({
      id: savedEntryId,
      author: 'ai',
      date: bootstrap.today,
      text: summaryText,
      tags: expect.arrayContaining(['summary']),
    }),
  );

  await summaryCard.getByRole('button', { name: 'Rewrite', exact: true }).click();
  await expect(summaryCard.getByRole('button', { name: 'Rewrite requested' })).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'Rewrite requested' })).toBeVisible();
  await expect.poll(async () => (await getLatestSummary(context, month))?.status).toBe('stale');
  expect(await getLatestSummary(context, month)).toMatchObject({
    id: created.id,
    status: 'stale',
    savedEntryId: null,
  });
  const preservedEntries = await listEntries(context, { tag: 'summary', limit: 100 });
  expect(preservedEntries.some((entry) => entry.id === savedEntryId)).toBe(true);
});

test('computed tokens, focus, touch geometry, self-hosted icons, and the AI mark match the design contract', async ({
  baseURL,
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'The evidence spec controls its viewport.',
  );
  const origin = requireBaseUrl(baseURL);
  const touchContext = await browser.newContext({
    baseURL: origin,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 375, height: 812 },
  });
  const page = await touchContext.newPage();
  try {
    await openJournal(page);
    const tokens = await page.evaluate((names) => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
    }, Object.keys(DESIGN_TOKENS));
    expect(tokens).toEqual(DESIGN_TOKENS);

    const composer = page.getByRole('combobox', { name: 'Add an entry' });
    await composer.focus();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveCSS('border-color', 'rgb(228, 101, 46)');
    await expect(composer).toHaveCSS('outline-color', 'rgb(240, 119, 61)');
    await expect(composer).toHaveCSS('outline-style', 'solid');
    await expect(composer).toHaveCSS('outline-width', '2px');
    await expect(composer).toHaveCSS('outline-offset', '2px');
    await expect(composer).toHaveCSS('font-size', '16px');
    await expectTouchTargets(page, '375px Timeline');

    const aiText = uniqueText('Assistant design evidence');
    const aiEntryId = await createAssistantEntry(page, origin, aiText);
    const aiRow = page.locator(`[data-entry-id="${aiEntryId}"]`);
    await expect(aiRow.getByText(aiText, { exact: true })).toBeVisible();
    await expect(aiRow).toHaveClass(/entry-row--ai/);
    const aiBadge = aiRow.getByLabel('Added by assistant');
    await expect(aiBadge).toHaveCSS('color', 'rgb(240, 154, 112)');
    await expect(aiBadge.locator('path')).toHaveAttribute('d', SPARKLE_PATH);

    await page.getByRole('button', { name: /^Activity/ }).click();
    const activity = page.getByRole('article').filter({ hasText: aiText });
    await expect(activity).toBeVisible();
    await expect(page.locator('.review-intro__icon path')).toHaveAttribute('d', SPARKLE_PATH);
    await expect(activity.locator('.activity-row__kind path')).toHaveAttribute('d', SPARKLE_PATH);

    const visibleIcons = page.locator('svg:visible');
    expect(await visibleIcons.count()).toBeGreaterThan(0);
    for (const icon of await visibleIcons.all()) {
      await expect(icon).toHaveAttribute('aria-hidden', 'true');
      await expect(icon).toHaveAttribute('focusable', 'false');
      await expect(icon).toHaveAttribute('viewBox', '0 0 24 24');
      await expect(icon).toHaveAttribute('fill', 'none');
      await expect(icon).toHaveAttribute('stroke', 'currentColor');
      await expect(icon).toHaveAttribute('stroke-width', '2');
      await expect(icon).toHaveAttribute('stroke-linecap', 'round');
      await expect(icon).toHaveAttribute('stroke-linejoin', 'round');
      const iconBox = await icon.boundingBox();
      expect(iconBox?.width).toBeGreaterThanOrEqual(10);
      expect(iconBox?.width).toBeLessThanOrEqual(16);
      expect(iconBox?.height).toBeGreaterThanOrEqual(10);
      expect(iconBox?.height).toBeLessThanOrEqual(16);
    }

    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const fontEvidence = await page.evaluate(() => {
      const resources = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.endsWith('.woff2'));
      return {
        geistAvailable: document.fonts.check('13.5px Geist'),
        resources,
        origins: [...new Set(resources.map((name) => new URL(name).origin))],
      };
    });
    expect(fontEvidence.geistAvailable).toBe(true);
    expect(fontEvidence.resources.length).toBeGreaterThan(0);
    expect(fontEvidence.origins).toEqual([new URL(origin).origin]);

    // The coarse-pointer entry surface is the sheet, so the sweep has to reach
    // its rows too — they are the densest stack of controls the phone renders.
    await page.getByRole('button', { name: /^Timeline/ }).click();
    await page.locator('.entry-row__content').filter({ hasText: aiText }).click();
    const entrySheet = page.locator('.entry-sheet');
    await expect(entrySheet).toBeVisible();
    await waitForFiniteAnimations(entrySheet);
    await expectTouchTargets(page, '375px entry sheet');
    await captureEvidenceScreenshot(page, testInfo, 'design-entry-sheet-375.png');
    await page.keyboard.press('Escape');
    await expect(entrySheet).toHaveCount(0);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const accessDialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(accessDialog).toBeVisible();
    await waitForFiniteAnimations(accessDialog);
    await expectTouchTargets(page, '375px Settings');
    await captureEvidenceScreenshot(page, testInfo, 'design-ai-touch-375.png');
  } finally {
    await touchContext.close();
  }
});

test('normal motion stays within the approved bounds and reduced motion removes it', async ({
  baseURL,
  browser,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'The evidence spec controls its viewport.',
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openJournal(page);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const overlayMotion = await motionStyle(page.locator('.dialog-overlay'));
  const panelMotion = await motionStyle(page.locator('.dialog-panel'));
  expect(overlayMotion.animationName).toBe('overlay-in');
  expect(overlayMotion.animationTimingFunction).toBe('ease-out');
  expect(cssTimeMilliseconds(overlayMotion.animationDuration)).toBeGreaterThan(0);
  expect(cssTimeMilliseconds(overlayMotion.animationDuration)).toBeLessThanOrEqual(130);
  expect(panelMotion.animationName).toBe('dialog-in');
  expect(panelMotion.animationTimingFunction).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
  expect(cssTimeMilliseconds(panelMotion.animationDuration)).toBeGreaterThan(0);
  expect(cssTimeMilliseconds(panelMotion.animationDuration)).toBeLessThanOrEqual(160);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /^Entry type:/ }).click();
  const menuMotion = await motionStyle(page.locator('.type-menu'));
  expect(menuMotion.animationName).toBe('dialog-in');
  expect(menuMotion.animationTimingFunction).toBe('ease-out');
  expect(cssTimeMilliseconds(menuMotion.animationDuration)).toBeGreaterThan(0);
  expect(cssTimeMilliseconds(menuMotion.animationDuration)).toBeLessThanOrEqual(120);
  await page.keyboard.press('Escape');

  const text = uniqueText('Motion evidence');
  await page.getByRole('combobox', { name: 'Add an entry' }).fill(`- ${text}`);
  await page.getByRole('button', { name: 'Add entry' }).click();
  const toastMotion = await motionStyle(page.locator('.toast'));
  const row = page.locator('.entry-row').filter({ hasText: text });
  await expect(row).toHaveCount(1);
  const rowMotion = await motionStyle(row);
  expect(toastMotion.animationName).toBe('toast-in');
  expect(toastMotion.animationTimingFunction).toBe('ease-out');
  expect(cssTimeMilliseconds(toastMotion.animationDuration)).toBeGreaterThan(0);
  expect(cssTimeMilliseconds(toastMotion.animationDuration)).toBeLessThanOrEqual(160);
  const transitionedProperties = rowMotion.transitionProperty
    .split(',')
    .map((value) => value.trim());
  expect(
    transitionedProperties.some(
      (property) => property === 'background' || property === 'background-color',
    ),
  ).toBe(true);
  expect(rowMotion.transitionTimingFunction).toBe('ease');
  expect(cssTimeMilliseconds(rowMotion.transitionDuration)).toBeLessThanOrEqual(100);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(cssTimeMilliseconds((await motionStyle(row)).transitionDuration)).toBeLessThanOrEqual(
    0.01,
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  expect((await motionStyle(page.locator('.dialog-overlay'))).animationName).toBe('none');
  expect((await motionStyle(page.locator('.dialog-panel'))).animationName).toBe('none');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Entry type:/ }).click();
  expect((await motionStyle(page.locator('.type-menu'))).animationName).toBe('none');

  /*
   * The entry sheet is a coarse-pointer surface, so it needs its own context.
   * Vaul ships a 500ms slide; DS-24 caps the dialog family at 160ms, which the
   * app reaches by overriding both the animation and vaul's inline release
   * transition. Under reduced motion the panel is re-pointed at the app's
   * opacity-only keyframes instead of simply keeping a shortened slide.
   */
  const touchContext = await browser.newContext({
    baseURL: requireBaseUrl(baseURL),
    hasTouch: true,
    isMobile: true,
    viewport: { width: 375, height: 812 },
  });
  const phone = await touchContext.newPage();
  try {
    await phone.emulateMedia({ reducedMotion: 'no-preference' });
    await openJournal(phone);
    const sheetText = uniqueText('Sheet motion evidence');
    await phone.getByRole('combobox', { name: 'Add an entry' }).fill(`- ${sheetText}`);
    await phone.getByRole('button', { name: 'Add entry' }).click();
    await phone.locator('.entry-row__content').filter({ hasText: sheetText }).click();

    const sheet = phone.locator('.entry-sheet');
    const scrim = phone.locator('.entry-sheet__scrim');
    await expect(sheet).toBeVisible();
    const sheetMotion = await motionStyle(sheet);
    const scrimMotion = await motionStyle(scrim);
    expect(cssTimeMilliseconds(sheetMotion.animationDuration)).toBeGreaterThan(0);
    expect(cssTimeMilliseconds(sheetMotion.animationDuration)).toBeLessThanOrEqual(160);
    expect(sheetMotion.animationTimingFunction).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(cssTimeMilliseconds(sheetMotion.transitionDuration)).toBeLessThanOrEqual(160);
    expect(sheetMotion.transitionTimingFunction).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(cssTimeMilliseconds(scrimMotion.animationDuration)).toBeGreaterThan(0);
    expect(cssTimeMilliseconds(scrimMotion.animationDuration)).toBeLessThanOrEqual(160);
    await waitForFiniteAnimations(sheet);

    await phone.emulateMedia({ reducedMotion: 'reduce' });
    const reducedSheet = await motionStyle(sheet);
    expect(['overlay-in', 'none']).toContain(reducedSheet.animationName);
    expect(cssTimeMilliseconds(reducedSheet.animationDuration)).toBeLessThanOrEqual(0.01);
    expect(cssTimeMilliseconds(reducedSheet.transitionDuration)).toBeLessThanOrEqual(0.01);
    expect(['overlay-in', 'none']).toContain((await motionStyle(scrim)).animationName);
  } finally {
    await touchContext.close();
  }
});
