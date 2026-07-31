#!/usr/bin/env node
/* global Buffer, process */
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createManifest, readManifest, sha256File, verifyManifest } from './release-manifest.mjs';

function value(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`${name} is required.`);
  return args[index + 1];
}

function assertStamp(stamp) {
  if (!/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}-[0-9]+$/.test(stamp)) {
    throw new Error(`Invalid release stamp: ${stamp}`);
  }
}

function tar(args, cwd) {
  execFileSync('tar', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
}

export function createReleaseArchive({
  root = process.cwd(),
  manifestPath,
  archivePath,
  attestationPath,
  stamp,
}) {
  assertStamp(stamp);
  const resolvedRoot = resolve(root);
  const resolvedManifest = resolve(manifestPath);
  const resolvedArchive = resolve(archivePath);
  const resolvedAttestation = resolve(attestationPath);
  const manifest = readManifest(resolvedManifest);

  const currentManifest = createManifest({ root: resolvedRoot });
  currentManifest.recordedAt = manifest.recordedAt;
  if (JSON.stringify(currentManifest) !== JSON.stringify(manifest)) {
    throw new Error('Release source changed after the manifest was recorded.');
  }
  verifyManifest(manifest, resolvedRoot, { checkExtras: false });
  if (lstatSync(resolvedArchive, { throwIfNoEntry: false })) {
    throw new Error(`Release archive already exists: ${resolvedArchive}`);
  }
  if (lstatSync(resolvedAttestation, { throwIfNoEntry: false })) {
    throw new Error(`Release attestation already exists: ${resolvedAttestation}`);
  }
  mkdirSync(dirname(resolvedArchive), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(resolvedAttestation), { recursive: true, mode: 0o700 });

  const scratch = mkdtempSync(resolve(tmpdir(), 'journal-release-archive-'));
  try {
    const listPath = resolve(scratch, 'paths.list');
    const orderedPaths = [
      ...manifest.directories.map((record) => record.path),
      ...manifest.files.map((record) => record.path),
    ];
    writeFileSync(listPath, Buffer.from(`${orderedPaths.join('\0')}\0`), { mode: 0o600 });
    tar(['-czf', resolvedArchive, '--no-recursion', '--null', '-T', listPath], resolvedRoot);
    chmodSync(resolvedArchive, 0o600);

    const extracted = resolve(scratch, 'extracted');
    mkdirSync(extracted, { mode: 0o700 });
    tar(['-xzpf', resolvedArchive, '-C', extracted], resolvedRoot);
    verifyManifest(manifest, extracted);

    const attestation = {
      schemaVersion: 1,
      releaseStamp: stamp,
      recordedAt: new Date().toISOString(),
      baseCommit: manifest.git.baseCommit,
      releaseVersion: manifest.release.version,
      treeSha256: manifest.treeSha256,
      dirtyStatusSha256: manifest.git.statusSha256,
      manifest: { path: resolvedManifest, sha256: sha256File(resolvedManifest) },
      archive: { path: resolvedArchive, sha256: sha256File(resolvedArchive) },
      extractedTreeVerified: true,
    };
    writeFileSync(resolvedAttestation, `${JSON.stringify(attestation, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    chmodSync(resolvedAttestation, 0o600);
    return attestation;
  } catch (error) {
    rmSync(resolvedArchive, { force: true });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runCli() {
  const args = process.argv.slice(2);
  const manifestPath = value(args, '--manifest');
  const archivePath = value(args, '--archive');
  const attestationPath = value(args, '--attestation');
  const stamp = value(args, '--stamp');
  const attestation = createReleaseArchive({
    manifestPath,
    archivePath,
    attestationPath,
    stamp,
  });
  process.stdout.write(`${JSON.stringify(attestation)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
