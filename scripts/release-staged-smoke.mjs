#!/usr/bin/env node
/* global Buffer, process */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const releaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = mkdtempSync(join(tmpdir(), 'journal-staged-smoke-'));

function fetchLoopback(port, path, accept) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request_ = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { Host: '127.0.0.1:0', Accept: accept },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('end', () =>
          resolveRequest({ status: response.statusCode, body: Buffer.concat(chunks) }),
        );
      },
    );
    request_.setTimeout(2_000, () =>
      request_.destroy(new Error('Staged smoke request timed out.')),
    );
    request_.once('error', rejectRequest);
    request_.end();
  });
}

let lease;
let runtime;
let failure;
try {
  const [{ loadConfig }, { createRuntime }, { WriterLease }] = await Promise.all([
    import(pathToFileURL(join(releaseRoot, 'server/dist/config.js')).href),
    import(pathToFileURL(join(releaseRoot, 'server/dist/index.js')).href),
    import(pathToFileURL(join(releaseRoot, 'server/dist/jobs/writer-lease.js')).href),
  ]);
  const loaded = loadConfig({
    configPath: join(dataDirectory, 'config.json'),
    env: {
      NODE_ENV: 'production',
      JOURNAL_VERSION: 'staged-smoke',
      JOURNAL_CONFIG: join(dataDirectory, 'config.json'),
      JOURNAL_DATA_DIR: dataDirectory,
      JOURNAL_BIND_HOST: '127.0.0.1',
      JOURNAL_PORT: '1',
      JOURNAL_HOSTS: '127.0.0.1:0',
      JOURNAL_TZ: 'Europe/Amsterdam',
      JOURNAL_DAY_BOUNDARY_OFFSET_MIN: '0',
    },
  });
  const config = { ...loaded, port: 0, hostAllowlist: ['127.0.0.1:0'] };
  lease = await WriterLease.acquire(dataDirectory, 'release-staged-smoke');
  runtime = await createRuntime(config);
  const server = await runtime.start();
  const address = server.address();
  assert.ok(address && typeof address === 'object' && address.address === '127.0.0.1');

  const healthResponse = await fetchLoopback(address.port, '/healthz', 'application/json');
  assert.equal(healthResponse.status, 200);
  const health = JSON.parse(healthResponse.body.toString('utf8'));
  assert.deepEqual(
    { status: health.status, db: health.db, version: health.version },
    { status: 'ok', db: 'ok', version: 'staged-smoke' },
  );

  const shellResponse = await fetchLoopback(address.port, '/', 'text/html');
  assert.equal(shellResponse.status, 200);
  const assetPath = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i.exec(
    shellResponse.body.toString('utf8'),
  )?.[1];
  assert.match(assetPath ?? '', /^\/assets\/[^/]+\.js$/);
  const assetResponse = await fetchLoopback(address.port, assetPath, '*/*');
  assert.equal(assetResponse.status, 200);
  assert.ok(assetResponse.body.byteLength > 0);

  process.stdout.write(
    `${JSON.stringify({ status: 'pass', listener: '127.0.0.1:ephemeral', assetBytes: assetResponse.body.byteLength })}\n`,
  );
} catch (error) {
  failure = error;
}

try {
  await runtime?.close();
} catch (error) {
  failure ??= error;
}
try {
  await lease?.release();
} catch (error) {
  failure ??= error;
}
try {
  rmSync(dataDirectory, { recursive: true, force: true });
} catch (error) {
  failure ??= error;
}

if (failure !== undefined) throw failure;
