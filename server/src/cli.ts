#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmod, open, readFile, rename, unlink } from 'node:fs/promises';
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { loadConfig, type JournalConfig } from './config.js';
import { JournalExportSchema } from './contracts/index.js';
import { JournalDatabase } from './db/database.js';
import { JournalDomain } from './domain/journal.js';
import type { JournalRuntime } from './index.js';
import {
  BackupManager,
  installLaunchAgent,
  seedDemo,
  shutdownJournal,
  startMaintenanceScheduler,
  WriterLease,
} from './jobs/index.js';

async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? 'serve';
  const args = argv.slice(1);
  const config = loadConfig();
  switch (command) {
    case 'serve':
      await serve(config, args.includes('--dev'));
      return;
    case 'export':
      await exportCommand(config, args[0]);
      return;
    case 'import':
      await importCommand(config, requiredArgument(args[0], 'journald import <file>'));
      return;
    case 'backup':
      await backupCommand(config, args[0]);
      return;
    case 'check':
      checkCommand(config);
      return;
    case 'seed':
      if (!args.includes('--demo')) throw new Error('Demo seed is explicit: journald seed --demo');
      await seedCommand(config);
      return;
    case 'install-service':
      await installService(config);
      return;
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(helpText());
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${helpText()}`);
  }
}

async function serve(config: JournalConfig, dev: boolean): Promise<void> {
  const lease = await WriterLease.acquire(config.dataDir, 'serve');
  let runtime: JournalRuntime | undefined;
  let maintenance: ReturnType<typeof startMaintenanceScheduler> | undefined;
  try {
    const { createRuntime } = await import('./index.js');
    runtime = await createRuntime(config, { dev });
    const backups = new BackupManager({
      database: runtime.database,
      backupDir: config.backupDir,
      timezone: config.timezone,
    });
    maintenance = startMaintenanceScheduler({
      domain: runtime.domain,
      backups,
      timezone: config.timezone,
      onError: (error) => process.stderr.write(`Maintenance failed: ${formatError(error)}\n`),
    });
    await runtime.start();
  } catch (error) {
    await maintenance?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await lease.release();
    throw error;
  }

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopping !== null) return stopping;
    stopping = shutdownJournal(runtime, maintenance, lease);
    return stopping;
  };
  const onSignal = (): void => {
    void withDeadline(stop(), 4_800, 'Graceful shutdown exceeded 4.8 seconds').then(
      () => process.exit(0),
      failAndExit,
    );
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
}

async function exportCommand(
  config: JournalConfig,
  destination: string | undefined,
): Promise<void> {
  const target =
    destination === undefined || destination === '-' ? undefined : resolve(destination);
  if (target !== undefined) assertSafeOutputPath(config, target, true);
  const { domain } = openDomain(config, false, true);
  try {
    const json = `${JSON.stringify(domain.exportJournal(), null, 2)}\n`;
    if (target === undefined) process.stdout.write(json);
    else {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      await writePrivateFile(target, json);
      process.stdout.write(`${target}\n`);
    }
  } finally {
    domain.close();
  }
}

async function importCommand(config: JournalConfig, source: string): Promise<void> {
  const lease = await WriterLease.acquire(config.dataDir, 'import');
  try {
    const document = JournalExportSchema.parse(JSON.parse(await readFile(resolve(source), 'utf8')));
    const { domain } = openDomain(config);
    try {
      const report = domain.importJournal(document);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } finally {
      domain.close();
    }
  } finally {
    await lease.release();
  }
}

async function backupCommand(
  config: JournalConfig,
  destination: string | undefined,
): Promise<void> {
  if (destination !== undefined) assertSafeOutputPath(config, resolve(destination), false);
  const database = new JournalDatabase({
    path: config.databasePath,
    backupDir: config.backupDir,
    applyMigrations: false,
    readonly: true,
  });
  try {
    const backups = new BackupManager({
      database,
      backupDir: config.backupDir,
      timezone: config.timezone,
    });
    process.stdout.write(`${await backups.createFresh(destination)}\n`);
  } finally {
    database.close();
  }
}

function checkCommand(config: JournalConfig): void {
  const database = new JournalDatabase({
    path: config.databasePath,
    backupDir: config.backupDir,
    applyMigrations: false,
    readonly: true,
  });
  try {
    database.quickCheck();
    process.stdout.write('ok\n');
  } finally {
    database.close();
  }
}

async function seedCommand(config: JournalConfig): Promise<void> {
  const lease = await WriterLease.acquire(config.dataDir, 'seed');
  try {
    const { domain } = openDomain(config);
    try {
      process.stdout.write(`${JSON.stringify(seedDemo(domain), null, 2)}\n`);
    } finally {
      domain.close();
    }
  } finally {
    await lease.release();
  }
}

function openDomain(
  config: JournalConfig,
  applyMigrations = true,
  readonly = false,
): { domain: JournalDomain } {
  const database = new JournalDatabase({
    path: config.databasePath,
    backupDir: config.backupDir,
    applyMigrations,
    readonly,
  });
  return { domain: new JournalDomain({ database, config }) };
}

async function installService(config: JournalConfig): Promise<void> {
  const installation = await installLaunchAgent(config);
  process.stdout.write(`${installation.plistPath}\n`);
}

function requiredArgument(value: string | undefined, usage: string): string {
  if (value === undefined) throw new Error(`Missing argument. Usage: ${usage}`);
  return value;
}

async function writePrivateFile(target: string, contents: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function assertSafeOutputPath(
  config: JournalConfig,
  target: string,
  rejectBackupTree: boolean,
): void {
  const targetMetadata = lstatIfPresent(target);
  if (targetMetadata?.isSymbolicLink() === true) {
    throw new Error(`Refusing symbolic-link output path: ${target}`);
  }
  const protectedPaths = [
    config.databasePath,
    `${config.databasePath}-wal`,
    `${config.databasePath}-shm`,
    resolve(config.dataDir, 'writer.lock'),
    resolve(config.dataDir, '.writer-lease.sqlite'),
    resolve(config.dataDir, '.writer-lease.sqlite-journal'),
    ...(config.configPath === undefined ? [] : [config.configPath]),
  ].map((path) => resolve(path));
  const canonicalTarget = canonicalizePath(target);
  const canonicalProtectedPaths = protectedPaths.map(canonicalizePath);
  if (protectedPaths.includes(target) || canonicalProtectedPaths.includes(canonicalTarget)) {
    throw new Error(`Refusing to overwrite Journal control path: ${target}`);
  }
  if (
    rejectBackupTree &&
    (isWithin(target, config.backupDir) ||
      isWithin(canonicalTarget, canonicalizePath(config.backupDir)))
  ) {
    throw new Error(`Refusing to overwrite a Journal backup path: ${target}`);
  }
  if (
    isWithin(target, config.logDir) ||
    isWithin(canonicalTarget, canonicalizePath(config.logDir))
  ) {
    throw new Error(`Refusing to overwrite a Journal log path: ${target}`);
  }
  if (targetMetadata === null) return;
  const targetStat = statSync(target);
  for (const path of protectedPaths) {
    if (!existsSync(path)) continue;
    const protectedStat = statSync(path);
    if (targetStat.dev === protectedStat.dev && targetStat.ino === protectedStat.ino) {
      throw new Error(`Refusing hard-linked Journal control path: ${target}`);
    }
  }
}

function canonicalizePath(path: string): string {
  const unresolved: string[] = [];
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    unresolved.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...unresolved);
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function isWithin(path: string, directory: string): boolean {
  const child = relative(resolve(directory), resolve(path));
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function helpText(): string {
  return `journald — local-first bullet journal

Usage:
  journald serve [--dev]
  journald export [file|-]
  journald import <file>
  journald backup [destination]
  journald check
  journald seed --demo
  journald install-service
`;
}

function failAndExit(error: unknown): never {
  process.stderr.write(`${formatError(error)}\n`);
  process.exit(1);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

void main().catch(failAndExit);
