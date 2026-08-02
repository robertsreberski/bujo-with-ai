import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
} from '@playwright/test';
import { ulid } from 'ulid';

import { openJournal, uniqueText } from './helpers';

interface ServerContext {
  today: string;
  timezone: string;
}

interface ReflectionState {
  id: string;
  revision: number;
  weekStart: string;
  weekEnd: string;
  status: 'notRequested' | 'queued' | 'running' | 'current' | 'stale' | 'failed';
  requestId: string | null;
}

function addCalendarDays(date: string, amount: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

/** Monday of the latest week whose Sunday is unambiguously in the past. */
function latestCompletedWeekStart(today: string): string {
  const parsed = new Date(`${today}T12:00:00Z`);
  const isoWeekday = parsed.getUTCDay() === 0 ? 7 : parsed.getUTCDay();
  return addCalendarDays(today, -(isoWeekday - 1) - 7);
}

async function pairAndBootstrap(context: BrowserContext, origin: string): Promise<ServerContext> {
  const paired = await context.request.post('/api/pair', {
    data: {},
    headers: { Origin: origin },
  });
  expect(paired.status(), await paired.text()).toBe(201);
  const bootstrap = await context.request.get('/api/bootstrap');
  expect(bootstrap.ok(), await bootstrap.text()).toBeTruthy();
  return (await bootstrap.json()) as ServerContext;
}

async function seedOwnerEntry(
  request: APIRequestContext,
  origin: string,
  server: ServerContext,
  date: string,
  text: string,
): Promise<void> {
  const response = await request.post('/api/entries', {
    data: {
      id: ulid(),
      text,
      type: 'note',
      time: null,
      tags: ['reflection-e2e'],
      collection: null,
      dateIntent: {
        kind: 'absolute',
        date,
        baseToday: server.today,
        capturedAt: new Date().toISOString(),
        timezone: server.timezone,
      },
    },
    headers: { 'Idempotency-Key': ulid(), Origin: origin },
  });
  expect(response.status(), await response.text()).toBe(201);
}

async function materializeReflection(
  request: APIRequestContext,
  weekStart: string,
  weekEnd: string,
): Promise<ReflectionState> {
  const response = await request.get(
    `/api/reflections?from=${encodeURIComponent(weekStart)}&to=${encodeURIComponent(weekEnd)}`,
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as { items: ReflectionState[] };
  const reflection = body.items.find((item) => item.weekStart === weekStart);
  expect(reflection).toMatchObject({ weekStart, weekEnd, revision: expect.any(Number) });
  if (!reflection) throw new Error('The completed week did not materialize a Reflection slot.');
  expect(['notRequested', 'current', 'stale']).toContain(reflection.status);
  expect(reflection.revision).toBeGreaterThan(0);
  return reflection;
}

async function issueAgentSecret(
  request: APIRequestContext,
  origin: string,
  label: string,
): Promise<string> {
  const response = await request.post('/api/tokens', {
    data: { label },
    headers: { Origin: origin },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { secret?: unknown };
  expect(body.secret).toEqual(expect.any(String));
  if (typeof body.secret !== 'string') throw new Error('Agent token creation returned no secret.');
  return body.secret;
}

function reflectionResult(result: unknown, status: ReflectionState['status']): ReflectionState {
  const record =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
  expect(record.isError).not.toBe(true);
  const structured = record.structuredContent as
    | { kind?: unknown; reflection?: ReflectionState }
    | undefined;
  expect(structured).toMatchObject({
    kind: 'reflection',
    reflection: { id: expect.any(String), status },
  });
  if (!structured?.reflection) throw new Error('MCP returned no Reflection state.');
  return structured.reflection;
}

async function expectReflectionControlsAreTouchSafe(card: Locator): Promise<void> {
  const controls = card.locator('button, summary');
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (const control of await controls.all()) {
    if (!(await control.isVisible())) continue;
    const label = (await control.getAttribute('aria-label')) ?? (await control.textContent()) ?? '';
    const box = await control.boundingBox();
    expect(box?.height, `Reflection control "${label.trim()}" height`).toBeGreaterThanOrEqual(40);
    expect(box?.width, `Reflection control "${label.trim()}" width`).toBeGreaterThanOrEqual(40);
  }
}

test('Timeline carries a weekly Reflection from request through completion to its source', async ({
  baseURL,
  context,
  page,
}) => {
  if (!baseURL) throw new Error('Playwright did not provide the journal origin.');
  const server = await pairAndBootstrap(context, baseURL);
  const weekStart = latestCompletedWeekStart(server.today);
  const weekEnd = addCalendarDays(weekStart, 6);
  const firstSource = uniqueText('Monday source');
  const lastSource = uniqueText('Sunday source');

  // Both boundaries are intentional: Timeline derives the Reflection query range
  // from loaded entry dates, while Journal only materializes a fully covered week.
  await seedOwnerEntry(context.request, baseURL, server, weekStart, firstSource);
  await seedOwnerEntry(context.request, baseURL, server, weekEnd, lastSource);
  const slot = await materializeReflection(context.request, weekStart, weekEnd);

  await openJournal(page);
  const card = page.locator(`[aria-labelledby="reflection-${slot.id}"]`);
  await expect(card.getByRole('heading', { name: 'Weekly Reflection' })).toBeVisible();
  await expect(
    card.getByText(slot.status === 'notRequested' ? 'not requested' : slot.status, { exact: true }),
  ).toBeVisible();
  await expectReflectionControlsAreTouchSafe(card);

  const requestedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/reflections/${slot.id}/request`) &&
      response.request().method() === 'POST',
  );
  await card
    .getByRole('button', { name: slot.status === 'notRequested' ? 'Request assistant' : 'Rewrite' })
    .click();
  const requested = await requestedResponse;
  expect(requested.ok(), await requested.text()).toBeTruthy();
  const queued = ((await requested.json()) as { reflection: ReflectionState }).reflection;
  expect(queued).toMatchObject({ id: slot.id, status: 'queued', requestId: expect.any(String) });
  if (!queued.requestId) throw new Error('The queued Reflection has no durable request id.');
  await expect(card.getByText('queued', { exact: true })).toBeVisible();
  await expect(card).toContainText('Requested · waiting for an assistant to claim it.');

  const agentLabel = uniqueText('Timeline reflection agent');
  const secret = await issueAgentSecret(context.request, baseURL, agentLabel);
  const client = new Client({ name: 'journal-reflection-e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  const reflectionText = uniqueText('A bounded week connected its opening and close');
  const generatorSource = 'Playwright bounded weekly Reflection synthesis.';
  try {
    await client.connect(transport as unknown as Transport);
    reflectionResult(
      await client.callTool({
        name: 'add_entry',
        arguments: {
          idempotencyKey: ulid(),
          source: generatorSource,
          summaryWeekStart: weekStart,
          reflectionAction: 'claim',
          reflectionRequestId: queued.requestId,
          tags: ['summary'],
          text: 'Claim the bounded Timeline Reflection request',
          type: 'note',
        },
      }),
      'running',
    );
    await expect(card.getByText('running', { exact: true })).toBeVisible();
    await expect(card).toContainText(`${agentLabel} is working on this week.`);

    const completed = reflectionResult(
      await client.callTool({
        name: 'add_entry',
        arguments: {
          idempotencyKey: ulid(),
          source: generatorSource,
          summaryWeekStart: weekStart,
          reflectionAction: 'complete',
          reflectionRequestId: queued.requestId,
          tags: ['summary'],
          text: reflectionText,
          type: 'note',
        },
      }),
      'current',
    );
    expect(completed.id).toBe(slot.id);
  } finally {
    await client.close();
  }

  await expect(card.getByText('current', { exact: true })).toBeVisible();
  await expect(card.getByText(reflectionText, { exact: true }).first()).toBeVisible();
  await expect(card).toContainText(`by ${agentLabel}`);
  await expect(card).toContainText(`Generator source: ${generatorSource}`);
  await expectReflectionControlsAreTouchSafe(card);

  await card.getByRole('button', { name: firstSource, exact: true }).click();
  const sourceDialog = page.getByRole('dialog', { name: firstSource });
  await expect(sourceDialog).toBeVisible();
  await expect(sourceDialog).toContainText('Added by');
  await expect(sourceDialog).toContainText('You');
});
