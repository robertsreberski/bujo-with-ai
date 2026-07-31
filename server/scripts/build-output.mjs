#!/usr/bin/env node
/* global URL, process */
import { chmod, cp, lstat, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultServerRoot = fileURLToPath(new URL('../', import.meta.url));

function exactDist(serverRoot, distDirectory) {
  const root = resolve(serverRoot);
  const expected = resolve(root, 'dist');
  const actual = resolve(distDirectory ?? expected);
  if (actual !== expected || actual === root) {
    throw new Error(`Build cleanup is not the exact server dist directory: ${actual}`);
  }
  return actual;
}

async function metadata(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function cleanServerDist({ serverRoot = defaultServerRoot, distDirectory } = {}) {
  const dist = exactDist(serverRoot, distDirectory);
  const existing = await metadata(dist);
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to clean a symlinked server dist directory: ${dist}`);
  }
  if (existing && !existing.isDirectory()) {
    throw new Error(`Refusing to clean a non-directory server dist path: ${dist}`);
  }
  await rm(dist, { recursive: true, force: true });
  return dist;
}

export async function finalizeServerDist({
  serverRoot = defaultServerRoot,
  distDirectory,
  migrationsDirectory,
} = {}) {
  const root = resolve(serverRoot);
  const dist = exactDist(root, distDirectory);
  const migrations = resolve(migrationsDirectory ?? resolve(root, 'src/db/migrations'));
  const distMetadata = await metadata(dist);
  const migrationsMetadata = await metadata(migrations);
  if (!distMetadata?.isDirectory() || distMetadata.isSymbolicLink()) {
    throw new Error(`Fresh TypeScript output directory is unavailable: ${dist}`);
  }
  if (!migrationsMetadata?.isDirectory() || migrationsMetadata.isSymbolicLink()) {
    throw new Error(`Migration source directory is unavailable: ${migrations}`);
  }

  const cli = resolve(dist, 'cli.js');
  const cliMetadata = await metadata(cli);
  if (!cliMetadata?.isFile() || cliMetadata.isSymbolicLink()) {
    throw new Error(`Fresh CLI artifact is unavailable: ${cli}`);
  }
  const migrationOutput = resolve(dist, 'db/migrations');
  await rm(migrationOutput, { recursive: true, force: true });
  await mkdir(migrationOutput, { recursive: true });
  await cp(migrations, migrationOutput, { recursive: true, force: true });
  await chmod(cli, 0o700);
  return { cli, dist, migrationOutput };
}

async function runCli() {
  const action = process.argv[2];
  if (action === 'clean') {
    process.stdout.write(`${await cleanServerDist()}\n`);
    return;
  }
  if (action === 'finalize') {
    process.stdout.write(`${JSON.stringify(await finalizeServerDist())}\n`);
    return;
  }
  throw new Error('Usage: build-output.mjs <clean|finalize>');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
