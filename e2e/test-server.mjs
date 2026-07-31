/* global process */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../server/dist/config.js';
import { createRuntime } from '../server/dist/index.js';
import { BackupManager, startMaintenanceScheduler } from '../server/dist/jobs/index.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.JOURNAL_E2E_PORT ?? 41_778);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('JOURNAL_E2E_PORT must be an integer between 1 and 65535.');
}

const dataDir = mkdtempSync(join(tmpdir(), 'journal-playwright-'));
const config = loadConfig({
  configPath: join(dataDir, 'config.json'),
  cwd: repositoryRoot,
  env: {
    ...process.env,
    JOURNAL_BIND_HOST: '127.0.0.1',
    JOURNAL_DATA_DIR: dataDir,
    JOURNAL_HOSTS: `localhost:${port},127.0.0.1:${port}`,
    JOURNAL_PORT: String(port),
    JOURNAL_TZ: 'Europe/Amsterdam',
    NODE_ENV: 'production',
  },
});
const runtime = await createRuntime(config);
const backups = new BackupManager({
  database: runtime.database,
  backupDir: config.backupDir,
  timezone: config.timezone,
});
const maintenance = startMaintenanceScheduler({
  domain: runtime.domain,
  backups,
  timezone: config.timezone,
  onError: (error) => process.stderr.write(`Maintenance failed: ${String(error)}\n`),
});

const cleanup = () => rmSync(dataDir, { force: true, recursive: true });
let stopping;
const stop = (exitCode) => {
  if (stopping) return stopping;
  stopping = (async () => {
    maintenance.close();
    await runtime.close();
    cleanup();
    process.exit(exitCode);
  })();
  return stopping;
};

process.once('exit', cleanup);
process.once('SIGINT', () => void stop(0));
process.once('SIGTERM', () => void stop(0));

try {
  await runtime.start();
} catch (error) {
  maintenance.close();
  await runtime.close().catch(() => undefined);
  cleanup();
  throw error;
}
