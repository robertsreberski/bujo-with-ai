#!/usr/bin/env node
/* global AbortSignal, Headers, process */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { cpus, freemem, hostname, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { URL, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium } from '@playwright/test';
import { ulid } from 'ulid';

const DEFAULT_WARMUP = 3;
const DEFAULT_SAMPLES = 20;
const WRITE_BUDGET = 60;
const THRESHOLDS_MS = Object.freeze({
  browserOptimisticVisible: 16,
  ownerCaptureCommitted: 100,
  mcpRead: 300,
});
const MEASUREMENTS = Object.freeze({
  browserOptimisticVisible:
    'In-page performance.now from requestSubmit to MutationObserver seeing the exact entry text in the committed DOM; this is DOM-visible work within one frame, not physical raster paint.',
  ownerCaptureCommitted:
    'Node performance.now across POST /api/capture through response JSON validation.',
  mcpRead:
    'Node performance.now across one SDK list_day call through structured-result validation.',
});

function usage() {
  return `Journal release benchmark

Usage:
  node scripts/benchmark-release.mjs --spawn-isolated [options]
  node scripts/benchmark-release.mjs --base-url <url> [options] --allow-mutating-target
  node scripts/benchmark-release.mjs --self-test

Options:
  --spawn-isolated          Start the built production server with temporary data.
  --base-url <url>          App and committed-capture target (default: http://127.0.0.1:5178).
  --mcp-url <url>           MCP target; defaults to --base-url. Use loopback after Tailnet deploy.
  --samples <count>         Recorded samples per metric (default: ${DEFAULT_SAMPLES}).
  --warmup <count>          Unrecorded warmups per metric (default: ${DEFAULT_WARMUP}).
  --output <file>           Also write the JSON report to a mode-0600 file.
  --allow-mutating-target   Required unless --spawn-isolated. Captures are soft-deleted, but
                            the journal intentionally retains audited activity/tombstones.
  --help                    Show this help.

The harness pairs one ephemeral Chromium browser, creates and later revokes one agent token,
and performs no MCP writes. UI samples remain offline and are discarded with the browser.
Committed capture samples are deleted after measurement. The default run plans 49 server
mutations including pairing and cleanup, below the conservative ${WRITE_BUDGET}-mutation budget.
`;
}

function parsePositiveInteger(raw, name, { allowZero = false } = {}) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`);
  }
  return value;
}

function normalizeBaseUrl(raw, name) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must use http or https.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} cannot contain credentials, a query, or a fragment.`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`${name} must point to the server origin, without a path.`);
  }
  return url.origin;
}

function parseArgs(argv) {
  const options = {
    allowMutatingTarget: false,
    baseUrl: 'http://127.0.0.1:5178',
    mcpUrl: undefined,
    output: undefined,
    samples: DEFAULT_SAMPLES,
    selfTest: false,
    spawnIsolated: false,
    warmup: DEFAULT_WARMUP,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} requires a value.`);
      }
      index += 1;
      return value;
    };
    switch (argument) {
      case '--allow-mutating-target':
        options.allowMutatingTarget = true;
        break;
      case '--base-url':
        options.baseUrl = next();
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--mcp-url':
        options.mcpUrl = next();
        break;
      case '--output':
        options.output = next();
        break;
      case '--samples':
        options.samples = parsePositiveInteger(next(), '--samples');
        break;
      case '--self-test':
        options.selfTest = true;
        break;
      case '--spawn-isolated':
        options.spawnIsolated = true;
        break;
      case '--warmup':
        options.warmup = parsePositiveInteger(next(), '--warmup', { allowZero: true });
        break;
      default:
        throw new Error(`Unknown option: ${argument ?? ''}`);
    }
  }
  return options;
}

function plannedMutationCount(warmup, samples) {
  // One device pairing, token create/revoke, and capture/delete for each HTTP sample.
  return 3 + 2 * (warmup + samples);
}

function nearestRank(values, fraction) {
  if (values.length === 0) throw new Error('Cannot calculate a percentile without samples.');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function round(value) {
  return Number(value.toFixed(3));
}

function summarize(values, warmupCount, thresholdMs) {
  const samplesMs = values.map(round);
  const p95Ms = round(nearestRank(values, 0.95));
  return {
    clock: 'monotonic',
    unit: 'ms',
    sampleCount: values.length,
    warmupCount,
    minMs: round(Math.min(...values)),
    p50Ms: round(nearestRank(values, 0.5)),
    p95Ms,
    maxMs: round(Math.max(...values)),
    threshold: { comparison: 'lt', p95Ms: thresholdMs },
    pass: p95Ms < thresholdMs,
    samplesMs,
  };
}

function safeExec(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function hardwareEvidence() {
  const cpuList = cpus();
  return {
    hostname: hostname(),
    machineModel: platform() === 'darwin' ? safeExec('/usr/sbin/sysctl', ['-n', 'hw.model']) : null,
    platform: platform(),
    osRelease: release(),
    arch: process.arch,
    cpuModel:
      cpuList.find((candidate) => candidate.model.trim().length > 0)?.model.trim() ??
      (platform() === 'darwin'
        ? safeExec('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'])
        : null),
    logicalCpuCount: cpuList.length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem(),
  };
}

function sourceEvidence(root) {
  const status = safeExec('git', ['-C', root, 'status', '--porcelain']);
  return {
    baseCommit: safeExec('git', ['-C', root, 'rev-parse', 'HEAD']),
    dirty: Boolean(status),
    changedPathCount: status ? status.split('\n').length : 0,
  };
}

function errorMessage(error, secret) {
  const message = error instanceof Error ? error.message : String(error);
  return secret ? message.replaceAll(secret, '[redacted]') : message;
}

function rejectAfter(milliseconds, message) {
  return delay(milliseconds, undefined, { ref: false }).then(() => {
    throw new Error(message);
  });
}

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Unable to allocate an isolated benchmark port.');
  }
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

async function waitForHealth(baseUrl, child, stderrLines) {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Isolated server exited with code ${String(child.exitCode)} and signal ${String(child.signalCode)}: ${stderrLines.slice(-8).join(' ')}`,
      );
    }
    try {
      const response = await globalThis.fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Startup races are expected until the real HTTP server is listening.
    }
    await delay(100);
  }
  throw new Error(`Isolated server did not become healthy: ${stderrLines.slice(-8).join(' ')}`);
}

export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5_000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      exited,
      rejectAfter(5_000, 'Isolated benchmark server did not exit after SIGKILL.'),
    ]);
  }
}

async function spawnIsolatedServer(root) {
  for (const required of ['app/dist/index.html', 'server/dist/cli.js']) {
    if (!existsSync(resolve(root, required))) {
      throw new Error(
        `Built production artifact is missing: ${required}. Run npm run build first.`,
      );
    }
  }
  const port = await findAvailablePort();
  const stderrLines = [];
  const child = spawn(process.execPath, ['e2e/test-server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      JOURNAL_E2E_PORT: String(port),
      JOURNAL_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrLines.push(
      ...String(chunk)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    if (stderrLines.length > 40) stderrLines.splice(0, stderrLines.length - 40);
  });
  const baseUrl = `http://localhost:${port}`;
  try {
    await waitForHealth(baseUrl, child, stderrLines);
    return { baseUrl, child };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function responseJson(response, operation) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${operation} returned non-JSON status ${response.status}.`);
  }
  if (!response.ok) {
    const detail = body?.error?.message ?? body?.error?.code ?? `HTTP ${response.status}`;
    throw new Error(`${operation} failed (${response.status}): ${String(detail)}`);
  }
  return body;
}

function createOwnerRequest(baseUrl, cookieValue) {
  return async (path, options = {}) => {
    const headers = new Headers({
      Accept: 'application/json',
      Cookie: `journal_device=${cookieValue}`,
      Origin: baseUrl,
      ...(options.headers ?? {}),
    });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await globalThis.fetch(new URL(path, baseUrl), {
      method: options.method ?? 'GET',
      headers,
      signal: AbortSignal.timeout(10_000),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return responseJson(response, `${options.method ?? 'GET'} ${path}`);
  };
}

async function measureOptimisticVisibility(page, warmupCount, sampleCount, runId) {
  const values = [];
  const total = warmupCount + sampleCount;
  for (let index = 0; index < total; index += 1) {
    const text = `Release benchmark optimistic ${runId}-${index}`;
    const input = page.getByRole('textbox', { name: 'Add an entry' });
    await input.fill(`- ${text} #benchmark`);
    const duration = await page.evaluate(async (expectedText) => {
      const form = globalThis.document.querySelector('.composer__form');
      const content = globalThis.document.querySelector('#journal-content');
      if (!(form instanceof globalThis.HTMLFormElement) || !content) {
        throw new Error('Production composer is unavailable.');
      }
      const visible = () =>
        [...globalThis.document.querySelectorAll('.entry-row__text')].some(
          (node) => node.textContent?.trim() === expectedText,
        );
      return await new Promise((resolveVisible, rejectVisible) => {
        const startedAt = globalThis.performance.now();
        let settled = false;
        const finish = () => {
          if (settled || !visible()) return;
          settled = true;
          observer.disconnect();
          globalThis.clearTimeout(timeout);
          resolveVisible(globalThis.performance.now() - startedAt);
        };
        const observer = new globalThis.MutationObserver(finish);
        observer.observe(content, { childList: true, subtree: true, characterData: true });
        const timeout = globalThis.setTimeout(() => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          rejectVisible(new Error(`Optimistic entry did not become visible: ${expectedText}`));
        }, 2_000);
        form.requestSubmit();
        globalThis.queueMicrotask(finish);
      });
    }, text);
    if (index >= warmupCount) values.push(duration);
  }
  return values;
}

async function measureCommittedCaptures(
  ownerRequest,
  bootstrap,
  warmupCount,
  sampleCount,
  runId,
  createdEntries,
) {
  const values = [];
  const total = warmupCount + sampleCount;
  for (let index = 0; index < total; index += 1) {
    const mutationId = ulid();
    const startedAt = performance.now();
    const body = await ownerRequest('/api/capture', {
      method: 'POST',
      headers: { 'Idempotency-Key': mutationId, 'X-Mutation-ID': mutationId },
      body: {
        draft: `- Release benchmark committed ${runId}-${index} #benchmark`,
        defaultType: 'note',
        dateIntent: {
          kind: 'today',
          capturedAt: new Date().toISOString(),
          baseToday: bootstrap.today,
          timezone: bootstrap.timezone,
        },
      },
    });
    const duration = performance.now() - startedAt;
    if (typeof body?.entry?.id !== 'string' || typeof body?.entry?.revision !== 'number') {
      throw new Error('Committed capture returned an invalid entry contract.');
    }
    createdEntries.push({ id: body.entry.id, revision: body.entry.revision });
    if (index >= warmupCount) values.push(duration);
  }
  return values;
}

async function measureMcpReads(mcpUrl, secret, date, warmupCount, sampleCount) {
  const values = [];
  const client = new Client({ name: 'journal-release-benchmark', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  try {
    await Promise.race([
      client.connect(transport),
      rejectAfter(10_000, 'MCP initialization timed out.'),
    ]);
    const total = warmupCount + sampleCount;
    for (let index = 0; index < total; index += 1) {
      const startedAt = performance.now();
      const result = await Promise.race([
        client.callTool({ name: 'list_day', arguments: { date } }),
        rejectAfter(10_000, 'MCP list_day timed out.'),
      ]);
      const duration = performance.now() - startedAt;
      if (result.isError === true || !Array.isArray(result.structuredContent?.entries)) {
        throw new Error('MCP list_day returned an invalid or error result.');
      }
      if (index >= warmupCount) values.push(duration);
    }
  } finally {
    await client.close().catch(() => undefined);
  }
  return values;
}

async function inspectProductionTarget(baseUrl) {
  const healthResponse = await globalThis.fetch(`${baseUrl}/healthz`, {
    signal: AbortSignal.timeout(10_000),
  });
  const health = await responseJson(healthResponse, 'GET /healthz');
  if (health?.status !== 'ok' || health?.db !== 'ok') {
    throw new Error('Target health contract is not ready.');
  }
  return health;
}

async function runBenchmark({ baseUrl, mcpUrl, samples, warmup }) {
  const errors = [];
  const cleanup = {
    capturedEntries: 0,
    deletedEntries: 0,
    tokenCreated: false,
    tokenRevoked: false,
    offlineOptimisticEntriesCommitted: 0,
  };
  const metrics = {};
  const createdEntries = [];
  const runId = `${Date.now().toString(36)}-${ulid().slice(-6).toLowerCase()}`;
  let browser;
  let context;
  let ownerRequest;
  let token;
  let browserVersion = null;
  let health = null;
  let productionBundleVerified = false;

  try {
    health = await inspectProductionTarget(baseUrl);
    browser = await chromium.launch({ headless: true });
    browserVersion = browser.version();
    context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    const paired = page.waitForResponse(
      (response) => response.url().endsWith('/api/pair') && response.status() === 201,
      { timeout: 15_000 },
    );
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByRole('textbox', { name: 'Add an entry' }).waitFor({ timeout: 15_000 });
    await paired;

    const moduleSources = await page
      .locator('script[type="module"][src]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src') ?? ''));
    if (
      moduleSources.length === 0 ||
      !moduleSources.every((source) => source.startsWith('/assets/')) ||
      moduleSources.some((source) => source.includes('@vite/client'))
    ) {
      throw new Error('Target is not serving the built production application.');
    }
    productionBundleVerified = true;

    const deviceCookie = (await context.cookies(baseUrl)).find(
      (cookie) => cookie.name === 'journal_device',
    );
    if (!deviceCookie?.value) throw new Error('Browser pairing did not issue a device cookie.');
    ownerRequest = createOwnerRequest(baseUrl, deviceCookie.value);
    const bootstrap = await ownerRequest('/api/bootstrap');
    if (typeof bootstrap?.today !== 'string' || typeof bootstrap?.timezone !== 'string') {
      throw new Error('Bootstrap response is missing today or timezone.');
    }

    token = await ownerRequest('/api/tokens', {
      method: 'POST',
      body: { label: `Release benchmark ${runId}` },
    });
    if (typeof token?.token?.id !== 'string' || typeof token?.secret !== 'string') {
      throw new Error('Token creation returned an invalid contract.');
    }
    cleanup.tokenCreated = true;

    await context.setOffline(true);
    await page.waitForFunction(() => globalThis.navigator.onLine === false);
    const optimisticValues = await measureOptimisticVisibility(page, warmup, samples, runId);
    metrics.browserOptimisticVisible = summarize(
      optimisticValues,
      warmup,
      THRESHOLDS_MS.browserOptimisticVisible,
    );

    const captureValues = await measureCommittedCaptures(
      ownerRequest,
      bootstrap,
      warmup,
      samples,
      runId,
      createdEntries,
    );
    metrics.ownerCaptureCommitted = summarize(
      captureValues,
      warmup,
      THRESHOLDS_MS.ownerCaptureCommitted,
    );

    const mcpValues = await measureMcpReads(mcpUrl, token.secret, bootstrap.today, warmup, samples);
    metrics.mcpRead = summarize(mcpValues, warmup, THRESHOLDS_MS.mcpRead);
  } catch (error) {
    errors.push(errorMessage(error, token?.secret));
  } finally {
    cleanup.capturedEntries = createdEntries.length;
    if (ownerRequest) {
      for (const entry of [...createdEntries].reverse()) {
        try {
          const mutationId = ulid();
          await ownerRequest(`/api/entries/${encodeURIComponent(entry.id)}`, {
            method: 'DELETE',
            headers: {
              'Idempotency-Key': mutationId,
              'X-Mutation-ID': mutationId,
              'If-Match': `"${entry.revision}"`,
            },
          });
          cleanup.deletedEntries += 1;
        } catch (error) {
          errors.push(`Cleanup: ${errorMessage(error, token?.secret)}`);
        }
      }
      if (token?.token?.id) {
        try {
          await ownerRequest(`/api/tokens/${encodeURIComponent(token.token.id)}`, {
            method: 'DELETE',
          });
          cleanup.tokenRevoked = true;
        } catch (error) {
          errors.push(`Cleanup: ${errorMessage(error, token.secret)}`);
        }
      }
    }
    await context?.close().catch((error) => {
      errors.push(`Cleanup: ${errorMessage(error, token?.secret)}`);
    });
    await browser?.close().catch((error) => {
      errors.push(`Cleanup: ${errorMessage(error, token?.secret)}`);
    });
  }

  return { browserVersion, cleanup, errors, health, metrics, productionBundleVerified };
}

function runSelfTest() {
  assert.equal(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
  assert.equal(
    nearestRank(
      [...Array(20)].map((_, index) => index + 1),
      0.95,
    ),
    19,
  );
  assert.equal(plannedMutationCount(DEFAULT_WARMUP, DEFAULT_SAMPLES), 49);
  assert.equal(summarize([1, 2, 3], 1, 4).pass, true);
  assert.equal(summarize([1, 4, 5], 1, 4).pass, false);
  assert.equal(
    normalizeBaseUrl('https://journal.example:5178/', '--base-url'),
    'https://journal.example:5178',
  );
  assert.throws(() => normalizeBaseUrl('file:///tmp/journal', '--base-url'));
  assert.throws(() => parsePositiveInteger('0', '--samples'));
  return {
    schemaVersion: 1,
    status: 'pass',
    checks: 8,
    message: 'Argument, budget, URL, percentile, and threshold helpers passed.',
  };
}

async function writeReport(report, destination) {
  const body = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(body);
  if (destination && destination !== '-') {
    const target = resolve(destination);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, body, { mode: 0o600 });
    await chmod(target, 0o600);
  }
}

async function main() {
  const root = resolve(import.meta.dirname, '..');
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.selfTest) {
    await writeReport(runSelfTest(), options.output);
    return;
  }

  const plannedMutations = plannedMutationCount(options.warmup, options.samples);
  if (plannedMutations > WRITE_BUDGET) {
    process.stderr.write(
      `Planned server mutations (${plannedMutations}) exceed the ${WRITE_BUDGET}-mutation budget. ` +
        'Reduce --samples or --warmup.\n',
    );
    process.exitCode = 2;
    return;
  }
  if (options.spawnIsolated && process.argv.includes('--base-url')) {
    process.stderr.write('--spawn-isolated and --base-url are mutually exclusive.\n');
    process.exitCode = 2;
    return;
  }
  if (!options.spawnIsolated && !options.allowMutatingTarget) {
    process.stderr.write(
      'A configured target retains benchmark audit records. Pass --allow-mutating-target to acknowledge this, or use --spawn-isolated.\n',
    );
    process.exitCode = 2;
    return;
  }

  let isolated;
  const startedAt = performance.now();
  const recordedAt = new Date().toISOString();
  let baseUrl;
  let mcpUrl;
  let execution;
  try {
    isolated = options.spawnIsolated ? await spawnIsolatedServer(root) : undefined;
    baseUrl = normalizeBaseUrl(isolated?.baseUrl ?? options.baseUrl, '--base-url');
    mcpUrl = normalizeBaseUrl(options.mcpUrl ?? baseUrl, '--mcp-url');
    execution = await runBenchmark({
      baseUrl,
      mcpUrl,
      samples: options.samples,
      warmup: options.warmup,
    });
  } catch (error) {
    execution = {
      browserVersion: null,
      cleanup: null,
      errors: [errorMessage(error)],
      health: null,
      metrics: {},
      productionBundleVerified: false,
    };
  } finally {
    if (isolated) await stopChild(isolated.child);
  }

  const requiredMetricNames = Object.keys(THRESHOLDS_MS);
  const complete = requiredMetricNames.every((name) => execution.metrics[name] !== undefined);
  const thresholdsPass =
    complete && requiredMetricNames.every((name) => execution.metrics[name]?.pass === true);
  const cleanupPass =
    execution.cleanup !== null &&
    execution.cleanup.capturedEntries === execution.cleanup.deletedEntries &&
    execution.cleanup.tokenCreated === true &&
    execution.cleanup.tokenRevoked === true;
  const status = execution.errors.length === 0 && thresholdsPass && cleanupPass ? 'pass' : 'fail';
  const report = {
    schemaVersion: 1,
    status,
    recordedAt,
    durationMs: round(performance.now() - startedAt),
    source: sourceEvidence(root),
    hardware: hardwareEvidence(),
    runtime: {
      node: process.version,
      browser: 'chromium',
      browserVersion: execution.browserVersion,
    },
    target: {
      baseUrl: baseUrl ?? options.baseUrl,
      mcpUrl: mcpUrl ?? options.mcpUrl ?? options.baseUrl,
      isolated: options.spawnIsolated,
      health: execution.health,
      productionBundleVerified: execution.productionBundleVerified,
    },
    configuration: {
      samples: options.samples,
      warmup: options.warmup,
      thresholdsMs: THRESHOLDS_MS,
      measurements: MEASUREMENTS,
      writeBudget: {
        limit: WRITE_BUDGET,
        plannedServerMutations: plannedMutations,
        plannedMcpWrites: 0,
        note: 'MCP measurements use read-only list_day. UI optimistics stay offline.',
      },
    },
    metrics: execution.metrics,
    cleanup: execution.cleanup,
    errors: execution.errors,
  };
  await writeReport(report, options.output);
  if (status !== 'pass') process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) await main();
