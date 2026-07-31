import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import type { JournalConfig } from '../../src/config.js';
import { JournalDatabase } from '../../src/db/database.js';
import { createRuntime, type JournalRuntime } from '../../src/index.js';

const roots: string[] = [];
const runtimes: JournalRuntime[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configFixture(): JournalConfig {
  const root = mkdtempSync(join(tmpdir(), 'journal-runtime-test-'));
  roots.push(root);
  return {
    port: 0,
    bindHost: '127.0.0.1',
    dataDir: root,
    databasePath: join(root, 'journal.db'),
    backupDir: join(root, 'backups'),
    logDir: join(root, 'logs'),
    hostAllowlist: ['localhost'],
    timezone: 'UTC',
    dayBoundaryOffsetMin: 0,
    deviceCookieName: 'journal_device',
    deviceCredentialTtlDays: 365,
    isDevelopment: true,
    version: 'test',
  };
}

describe('runtime shutdown', () => {
  it('closes an active SSE stream and drains well inside the five-second deadline', async () => {
    const runtime = await createRuntime(configFixture());
    runtimes.push(runtime);
    const server = await runtime.start();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing runtime server address.');

    const paired = await request(runtime.application.app)
      .post('/api/pair')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost')
      .send({})
      .expect(201);
    const cookie = paired.headers['set-cookie']?.[0]?.split(';', 1)[0];
    if (!cookie) throw new Error('Pairing did not produce a device cookie.');

    let streamEnded = Promise.resolve();
    const streamOpened = new Promise<void>((resolveOpened, reject) => {
      const client = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/api/events',
          headers: { Host: 'localhost', Cookie: cookie, Accept: 'text/event-stream' },
        },
        (response) => {
          streamEnded = once(response, 'end').then(() => undefined);
          response.resume();
          resolveOpened();
        },
      );
      client.once('error', reject);
      client.end();
    });
    await streamOpened;

    const startedAt = performance.now();
    await runtime.close();
    const durationMs = performance.now() - startedAt;
    await streamEnded;

    expect(durationMs).toBeLessThan(2_000);
    expect(server.listening).toBe(false);
  });

  it('exits cleanly within five seconds when another process pins the WAL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-sigterm-test-'));
    roots.push(root);
    const port = await reservePort();
    const repository = resolve(import.meta.dirname, '../../..');
    const cli = join(repository, 'server/src/cli.ts');
    let stderr = '';
    const child = spawn(process.execPath, ['--import', 'tsx', cli, 'serve'], {
      cwd: repository,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        JOURNAL_CONFIG: join(root, 'config.json'),
        JOURNAL_DATA_DIR: root,
        JOURNAL_PORT: String(port),
        JOURNAL_HOSTS: `localhost:${port},127.0.0.1:${port}`,
        JOURNAL_TZ: 'UTC',
      },
    });
    children.push(child);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    await waitForHealth(port, child, () => stderr);

    const databasePath = join(root, 'journal.db');
    const reader = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT count(*) FROM schema_migrations').get();
      const writer = new Database(databasePath, { fileMustExist: true });
      try {
        writer.pragma('journal_mode = WAL');
        writer.exec(
          "CREATE TABLE shutdown_marker(value TEXT NOT NULL); INSERT INTO shutdown_marker VALUES ('recoverable')",
        );
      } finally {
        writer.close();
      }

      const startedAt = performance.now();
      expect(child.kill('SIGTERM')).toBe(true);
      const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
      const durationMs = performance.now() - startedAt;
      expect(signal, stderr).toBeNull();
      expect(code, stderr).toBe(0);
      expect(durationMs, stderr).toBeLessThan(5_000);
    } finally {
      reader.close();
    }

    const recovered = new JournalDatabase({ path: databasePath });
    try {
      expect(recovered.raw.pragma('quick_check', { simple: true })).toBe('ok');
      expect(recovered.raw.prepare('SELECT value FROM shutdown_marker').pluck().get()).toBe(
        'recoverable',
      );
    } finally {
      recovered.close();
    }
  });
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Unable to reserve port');
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

async function waitForHealth(
  port: number,
  child: ChildProcess,
  readStderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`journald exited before health check: ${readStderr()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        headers: { Host: `localhost:${port}` },
      });
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`journald did not become healthy: ${readStderr()}`);
}
