#!/usr/bin/env node
/* global process */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { writeOwnerPrivateAtomic } from './release-atomic-file.mjs';
import { sha256File } from './release-manifest.mjs';

function value(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value.`);
  return args[index + 1];
}

function assertStamp(stamp) {
  if (!/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}-[0-9]+$/.test(stamp)) {
    throw new Error(`Invalid release stamp: ${stamp}`);
  }
}

function quickCheck(database) {
  const rows = database.pragma('quick_check');
  if (!Array.isArray(rows) || rows.length === 0 || rows.some((row) => row.quick_check !== 'ok')) {
    throw new Error(`SQLite quick_check failed: ${JSON.stringify(rows)}`);
  }
  return 'ok';
}

function tableCounts(database) {
  const names = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  return Object.fromEntries(
    names.map((name) => {
      if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe SQLite table name: ${name}`);
      return [name, database.prepare(`SELECT count(*) AS count FROM "${name}"`).get().count];
    }),
  );
}

export async function runBackupDrill({
  databasePath,
  backupDirectory,
  evidencePath,
  stamp,
  releaseRoot,
  nodePath,
  baseCommit,
  manifestSha256,
  archiveSha256,
}) {
  assertStamp(stamp);
  const sourcePath = resolve(databasePath);
  const backupDir = resolve(backupDirectory);
  const outputPath = resolve(evidencePath);
  const stagedCli = resolve(releaseRoot, 'server/dist/cli.js');
  const stagedContracts = resolve(releaseRoot, 'server/dist/contracts/index.js');
  if (lstatSync(outputPath, { throwIfNoEntry: false })) {
    throw new Error(`Backup evidence already exists: ${outputPath}`);
  }
  if (!lstatSync(sourcePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Source database is unavailable: ${sourcePath}`);
  }
  if (!lstatSync(stagedCli, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Staged CLI is unavailable: ${stagedCli}`);
  }
  if (!lstatSync(stagedContracts, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Staged export contract is unavailable: ${stagedContracts}`);
  }
  if (!lstatSync(nodePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Staged Node runtime is unavailable: ${nodePath}`);
  }
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const suffix = randomBytes(6).toString('hex');
  const backupPath = resolve(backupDir, `journal-release-${stamp}-${suffix}.db`);
  if (lstatSync(backupPath, { throwIfNoEntry: false })) {
    throw new Error(`Backup destination already exists: ${backupPath}`);
  }
  try {
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      quickCheck(source);
      await source.backup(backupPath);
      chmodSync(backupPath, 0o600);
    } finally {
      source.close();
    }
  } catch (error) {
    rmSync(backupPath, { force: true });
    throw error;
  }

  let restoreRoot;
  try {
    restoreRoot = mkdtempSync(resolve(dirname(outputPath), `.restore-${stamp}-`));
    const restoredPath = resolve(restoreRoot, 'journal.db');
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    let expectedCounts;
    let schemaVersion;
    try {
      quickCheck(backup);
      expectedCounts = tableCounts(backup);
      schemaVersion = backup.pragma('user_version', { simple: true });
    } finally {
      backup.close();
    }

    copyFileSync(backupPath, restoredPath);
    chmodSync(restoredPath, 0o600);
    const restored = new Database(restoredPath, { readonly: true, fileMustExist: true });
    let restoredCounts;
    try {
      quickCheck(restored);
      restoredCounts = tableCounts(restored);
      if (restored.pragma('user_version', { simple: true }) !== schemaVersion) {
        throw new Error('Restored database schema version differs from the backup.');
      }
    } finally {
      restored.close();
    }
    if (JSON.stringify(restoredCounts) !== JSON.stringify(expectedCounts)) {
      throw new Error('Restored database table counts differ from the backup.');
    }

    const cliEnvironment = {
      ...process.env,
      JOURNAL_CONFIG: resolve(restoreRoot, 'config.json'),
      JOURNAL_DATA_DIR: restoreRoot,
      NODE_ENV: 'production',
    };
    const checkOutput = execFileSync(nodePath, [stagedCli, 'check'], {
      encoding: 'utf8',
      env: cliEnvironment,
    }).trim();
    if (checkOutput !== 'ok') throw new Error(`Staged CLI check returned: ${checkOutput}`);
    const exportDocument = JSON.parse(
      execFileSync(nodePath, [stagedCli, 'export', '-'], {
        encoding: 'utf8',
        env: cliEnvironment,
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
    const { JournalExportSchema } = await import(pathToFileURL(stagedContracts).href);
    JournalExportSchema.parse(exportDocument);

    const postCli = new Database(restoredPath, { readonly: true, fileMustExist: true });
    try {
      quickCheck(postCli);
    } finally {
      postCli.close();
    }
    rmSync(restoreRoot, { recursive: true });

    const evidence = {
      schemaVersion: 1,
      releaseStamp: stamp,
      recordedAt: new Date().toISOString(),
      ...(baseCommit === undefined ? {} : { baseCommit, manifestSha256, archiveSha256 }),
      source: sourcePath,
      backup: {
        path: backupPath,
        bytes: statSync(backupPath).size,
        mode: statSync(backupPath).mode & 0o7777,
        sha256: sha256File(backupPath),
        unique: true,
      },
      restore: {
        quickCheck: 'ok',
        schemaVersion,
        tableCounts: restoredCounts,
        temporaryCopyRemoved: true,
        stagedCli: {
          node: resolve(nodePath),
          cli: stagedCli,
          check: 'ok',
          exportSchemaValidated: true,
        },
      },
    };
    writeOwnerPrivateAtomic(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } catch (error) {
    rmSync(backupPath, { force: true });
    throw error;
  } finally {
    if (restoreRoot !== undefined) rmSync(restoreRoot, { recursive: true, force: true });
  }
}

async function runCli() {
  const args = process.argv.slice(2);
  const contextPath = value(args, '--context');
  const databasePath = value(args, '--database');
  const evidencePath = value(args, '--evidence');
  const backupDirectory = value(args, '--backup-dir');
  if (!contextPath || !databasePath || !evidencePath || !backupDirectory) {
    throw new Error(
      'Usage: release-backup-drill.mjs --context <json> --database <db> --backup-dir <dir> --evidence <json>',
    );
  }
  const context = JSON.parse(readFileSync(resolve(contextPath), 'utf8'));
  const manifest = JSON.parse(readFileSync(resolve(context.manifest), 'utf8'));
  const expectedDataDirectory = resolve(homedir(), '.journal');
  if (resolve(databasePath) !== resolve(expectedDataDirectory, 'journal.db')) {
    throw new Error('Backup drill source must be the live ~/.journal/journal.db database.');
  }
  if (resolve(backupDirectory) !== resolve(expectedDataDirectory, 'backups')) {
    throw new Error('Backup drill destination must be the live ~/.journal/backups directory.');
  }
  if (
    resolve(evidencePath) !==
    resolve(dirname(resolve(contextPath)), `backup-${context.releaseStamp}.json`)
  ) {
    throw new Error('Backup evidence path must match the release context and stamp.');
  }
  if (
    resolve(fileURLToPath(import.meta.url)) !==
    resolve(context.releaseRoot, 'scripts/release-backup-drill.mjs')
  ) {
    throw new Error('Backup drill must run from the attested staged release.');
  }
  if (
    process.version !== manifest.toolchain.node ||
    process.execPath !== manifest.toolchain.nodePath
  ) {
    throw new Error('Backup drill Node runtime does not match the release manifest.');
  }
  const evidence = await runBackupDrill({
    databasePath,
    backupDirectory,
    evidencePath,
    stamp: context.releaseStamp,
    releaseRoot: context.releaseRoot,
    nodePath: manifest.toolchain.nodePath,
    baseCommit: context.baseCommit,
    manifestSha256: context.manifestSha256,
    archiveSha256: context.archiveSha256,
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
