import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WriterLease } from '../src/jobs/writer-lease.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('exclusive writer lease', () => {
  it('refuses a second live writer and keeps owner-only metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-lease-live-'));
    roots.push(root);
    const options = {
      pid: 101,
      token: () => 'first',
      processStart: () => 'start-a',
    } as const;
    const first = await WriterLease.acquire(root, 'serve', options);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    await expect(
      WriterLease.acquire(root, 'import', { ...options, pid: 202, token: () => 'second' }),
    ).rejects.toThrow('writer is already active');
    await first.release();
  });

  it('recovers dead and PID-reused locks without letting an old token release the new owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-lease-stale-'));
    roots.push(root);
    const old = await WriterLease.acquire(root, 'serve', {
      pid: 101,
      token: () => 'old-token',
      processStart: () => 'old-start',
    });
    const oldRecord = `${JSON.stringify(old.record)}\n`;
    await old.release();
    writeFileSync(join(root, 'writer.lock'), oldRecord, { mode: 0o600 });
    const replacement = await WriterLease.acquire(root, 'import', {
      pid: 202,
      token: () => 'new-token',
      processStart: (pid) => (pid === 101 ? 'reused-pid-start' : 'new-process-start'),
    });
    expect(JSON.parse(readFileSync(replacement.path, 'utf8'))).toMatchObject({
      pid: 202,
      token: 'new-token',
      command: 'import',
    });
    writeFileSync(
      replacement.path,
      `${JSON.stringify({ ...replacement.record, token: 'other-owner-token' })}\n`,
      { mode: 0o600 },
    );
    await replacement.release();
    expect(JSON.parse(readFileSync(replacement.path, 'utf8'))).toMatchObject({
      token: 'other-owner-token',
    });

    writeFileSync(
      join(root, 'writer.lock'),
      `${JSON.stringify({
        version: 1,
        pid: 303,
        processStart: 'gone',
        token: 'dead-token',
        command: 'seed',
        acquiredAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    const afterDeath = await WriterLease.acquire(root, 'seed', {
      pid: 404,
      token: () => 'after-death',
      processStart: () => 'live',
    });
    expect(afterDeath.record.token).toBe('after-death');
    await afterDeath.release();
  });

  it('recovers automatically after a separate writer process is killed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'journal-lease-crash-'));
    roots.push(root);
    const moduleUrl = pathToFileURL(
      resolve(import.meta.dirname, '../src/jobs/writer-lease.ts'),
    ).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { WriterLease } from ${JSON.stringify(moduleUrl)};
         await WriterLease.acquire(process.argv[1], 'serve');
         process.stdout.write('ready\\n');
         setInterval(() => undefined, 1_000);`,
        root,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await once(child.stdout!, 'data');
    expect(JSON.parse(readFileSync(join(root, 'writer.lock'), 'utf8'))).toMatchObject({
      command: 'serve',
    });
    child.kill('SIGKILL');
    await once(child, 'exit');

    const recovered = await WriterLease.acquire(root, 'import');
    expect(recovered.record.command).toBe('import');
    await recovered.release();
  });
});
