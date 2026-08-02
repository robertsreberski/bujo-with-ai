import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createServer,
  request as createUpstreamRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { uniqueText } from './helpers';

type WorkerVersion = 'v1' | 'v2';

interface ControlledWorkerProxy {
  readonly origin: string;
  readonly sources: Readonly<Record<WorkerVersion, string>>;
  serve(version: WorkerVersion): void;
  close(): Promise<void>;
}

const upstreamOrigin = new URL(`http://localhost:${process.env.JOURNAL_E2E_PORT ?? '41778'}`);
const observationCache = 'journal-e2e-update-observation';
const observationPath = '/__e2e/activation-observation';

function workerInstrumentation(version: WorkerVersion): string {
  return `
;(() => {
  const version = ${JSON.stringify(version)};
  const observationCache = ${JSON.stringify(observationCache)};
  const observationPath = ${JSON.stringify(observationPath)};

  const readPersistedDraft = async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('journal-pwa');
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('client-state', 'readonly');
        const request = transaction.objectStore('client-state').get('journal-client-state-v1');
        request.addEventListener('success', () => resolve(request.result?.draft ?? null), {
          once: true,
        });
        request.addEventListener('error', () => reject(request.error), { once: true });
      });
    } finally {
      database.close();
    }
  };

  self.addEventListener('message', (event) => {
    if (event.data?.type === 'JOURNAL_E2E_WORKER_VERSION') {
      event.ports[0]?.postMessage(version);
      return;
    }
    if (event.data?.type !== 'SKIP_WAITING') return;
    event.waitUntil(
      readPersistedDraft().then(async (draft) => {
        const cache = await caches.open(observationCache);
        await cache.put(
          observationPath,
          new Response(JSON.stringify({ version, draft }), {
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }),
    );
  });
})();
/* journal-e2e-worker-version:${version} */
`;
}

function headersForUpstream(
  headers: IncomingHttpHeaders,
  proxyOrigin: string,
): IncomingHttpHeaders {
  const forwarded = { ...headers, host: upstreamOrigin.host };
  delete forwarded.connection;
  if (forwarded.origin === proxyOrigin) forwarded.origin = upstreamOrigin.origin;
  if (forwarded.referer?.startsWith(proxyOrigin)) {
    forwarded.referer = `${upstreamOrigin.origin}${forwarded.referer.slice(proxyOrigin.length)}`;
  }
  return forwarded;
}

async function startControlledWorkerProxy(): Promise<ControlledWorkerProxy> {
  const productionWorker = await readFile(resolve('app/dist/sw.js'), 'utf8');
  const sources = {
    v1: `${productionWorker}${workerInstrumentation('v1')}`,
    v2: `${productionWorker}${workerInstrumentation('v2')}`,
  } as const;
  let servedVersion: WorkerVersion = 'v1';
  const upstreamRequests = new Set<ClientRequest>();
  let proxyOrigin = '';

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://journal-e2e.invalid');
    if (requestUrl.pathname === '/sw.js') {
      const source = sources[servedVersion];
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(source),
        'Content-Type': 'text/javascript; charset=utf-8',
        ETag: `"${createHash('sha256').update(source).digest('hex')}"`,
        'Service-Worker-Allowed': '/',
      });
      response.end(source);
      return;
    }

    const upstreamRequest = createUpstreamRequest(
      {
        hostname: upstreamOrigin.hostname,
        port: upstreamOrigin.port,
        method: request.method,
        path: request.url,
        headers: headersForUpstream(request.headers, proxyOrigin),
      },
      (upstreamResponse) => {
        const responseHeaders = { ...upstreamResponse.headers };
        delete responseHeaders.connection;
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(response);
      },
    );
    upstreamRequests.add(upstreamRequest);
    upstreamRequest.once('close', () => upstreamRequests.delete(upstreamRequest));
    upstreamRequest.once('error', (error) => {
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain' });
      response.end(`Journal E2E proxy failed: ${error.message}`);
    });
    request.once('aborted', () => upstreamRequest.destroy());
    request.pipe(upstreamRequest);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server, upstreamRequests);
    throw new Error('Controlled service-worker proxy did not bind a TCP port.');
  }
  proxyOrigin = `http://127.0.0.1:${address.port}`;

  return {
    origin: proxyOrigin,
    sources,
    serve(version) {
      servedVersion = version;
    },
    close: () => closeServer(server, upstreamRequests),
  };
}

async function closeServer(server: Server, upstreamRequests: Set<ClientRequest>): Promise<void> {
  for (const request of upstreamRequests) request.destroy();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
    server.closeAllConnections();
  });
}

async function workerVersion(page: Page, target: 'controller' | 'waiting'): Promise<string | null> {
  return page.evaluate(async (requestedTarget) => {
    const registration = await navigator.serviceWorker.getRegistration();
    const worker =
      requestedTarget === 'controller' ? navigator.serviceWorker.controller : registration?.waiting;
    if (!worker) return null;
    return await new Promise<string>((resolveVersion, rejectVersion) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(
        () => rejectVersion(new Error(`Timed out querying ${requestedTarget} worker version.`)),
        5_000,
      );
      channel.port1.addEventListener(
        'message',
        (event: MessageEvent<unknown>) => {
          window.clearTimeout(timeout);
          channel.port1.close();
          if (typeof event.data !== 'string') {
            rejectVersion(new Error(`${requestedTarget} worker returned an invalid version.`));
            return;
          }
          resolveVersion(event.data);
        },
        { once: true },
      );
      channel.port1.start();
      worker.postMessage({ type: 'JOURNAL_E2E_WORKER_VERSION' }, [channel.port2]);
    });
  }, target);
}

test('activates one real waiting worker only after persistence-safe owner consent', async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  const proxy = await startControlledWorkerProxy();
  try {
    expect(proxy.sources.v1).not.toBe(proxy.sources.v2);
    expect(createHash('sha256').update(proxy.sources.v1).digest('hex')).not.toBe(
      createHash('sha256').update(proxy.sources.v2).digest('hex'),
    );

    await page.addInitScript(() => {
      const loadKey = 'journal-e2e-update-loads';
      const controllerKey = 'journal-e2e-controller-changes';
      sessionStorage.setItem(loadKey, String(Number(sessionStorage.getItem(loadKey) ?? '0') + 1));
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        sessionStorage.setItem(
          controllerKey,
          String(Number(sessionStorage.getItem(controllerKey) ?? '0') + 1),
        );
      });
    });

    const v1Response = await context.request.get(`${proxy.origin}/sw.js`);
    expect(v1Response.ok()).toBeTruthy();
    const v1Bytes = await v1Response.body();
    expect(v1Bytes.equals(Buffer.from(proxy.sources.v1))).toBe(true);

    await page.goto(proxy.origin);
    await expect(page.locator('#journal-content')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Add an entry' })).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller) return;
      await new Promise<void>((resolveController) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolveController(), {
          once: true,
        }),
      );
    });
    await expect.poll(() => workerVersion(page, 'controller')).toBe('v1');

    await page.evaluate(
      async ({ cacheName, cachePath }) => {
        const cache = await caches.open(cacheName);
        await cache.put(cachePath, new Response('private legacy journal payload'));
        sessionStorage.setItem('journal-e2e-update-loads', '0');
        sessionStorage.setItem('journal-e2e-controller-changes', '0');
      },
      { cacheName: 'journal-api-v1', cachePath: '/api/__e2e-private-journal' },
    );
    await expect.poll(() => page.evaluate(() => caches.has('journal-api-v1'))).toBe(true);

    proxy.serve('v2');
    const v2Response = await context.request.get(`${proxy.origin}/sw.js`);
    expect(v2Response.ok()).toBeTruthy();
    const v2Bytes = await v2Response.body();
    expect(v2Bytes.equals(Buffer.from(proxy.sources.v2))).toBe(true);
    expect(v2Bytes.equals(v1Bytes)).toBe(false);

    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error('Journal service-worker registration is missing.');
      await registration.update();
    });

    const reloadSafely = page.getByRole('button', {
      name: /Update ready\s+Reload safely/,
    });
    await expect(reloadSafely).toBeVisible();
    await expect.poll(() => workerVersion(page, 'waiting')).toBe('v2');
    await expect.poll(() => workerVersion(page, 'controller')).toBe('v1');
    await expect.poll(() => page.evaluate(() => caches.has('journal-api-v1'))).toBe(true);

    const draft = `- ${uniqueText('Update-safe draft')} #pwa-update`;
    await page.getByRole('combobox', { name: 'Add an entry' }).fill(draft);
    await Promise.all([
      page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame()),
      reloadSafely.click(),
    ]);

    await expect(page.locator('#journal-content')).toBeVisible();
    await expect.poll(() => workerVersion(page, 'controller')).toBe('v2');
    await expect(page.getByRole('combobox', { name: 'Add an entry' })).toHaveValue(draft);

    const lifecycle = await page.evaluate(() => ({
      controllerChanges: Number(sessionStorage.getItem('journal-e2e-controller-changes') ?? '-1'),
      reloads: Number(sessionStorage.getItem('journal-e2e-update-loads') ?? '-1'),
    }));
    expect(lifecycle).toEqual({ controllerChanges: 1, reloads: 1 });
    await expect.poll(() => page.evaluate(() => caches.has('journal-api-v1'))).toBe(false);

    const activationObservation = await page.evaluate(
      async ({ cacheName, path }) => {
        const response = await (await caches.open(cacheName)).match(path);
        return response ? ((await response.json()) as unknown) : null;
      },
      { cacheName: observationCache, path: observationPath },
    );
    expect(activationObservation).toEqual({ version: 'v2', draft });

    await page.evaluate(async (cacheName) => {
      await caches.delete(cacheName);
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.unregister();
    }, observationCache);
  } finally {
    await page.close().catch(() => undefined);
    await proxy.close();
  }
});
