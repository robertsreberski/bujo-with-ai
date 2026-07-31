#!/usr/bin/env node
/* global Buffer, process */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST_SCHEMA_VERSION = 2;
const REQUIRED_DIST_FILES = ['app/dist/index.html', 'server/dist/cli.js'];

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: root, encoding });
}

function normalizeReleasePath(path) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || path.includes('\0')) {
    throw new Error(`Invalid release path: ${String(path)}`);
  }
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Invalid release path: ${path}`);
  }
  return parts.join('/');
}

function absoluteReleasePath(base, path) {
  const normalized = normalizeReleasePath(path);
  const absolute = resolve(base, normalized);
  if (!absolute.startsWith(`${resolve(base)}${sep}`)) {
    throw new Error(`Release path escapes its root: ${path}`);
  }
  return { absolute, normalized };
}

export function fileRecord(base, path) {
  const { absolute, normalized } = absoluteReleasePath(base, path);
  const metadata = lstatSync(absolute);
  const mode = metadata.mode & 0o7777;
  if (metadata.isSymbolicLink()) {
    const target = readlinkSync(absolute);
    return {
      path: normalized,
      kind: 'symlink',
      mode,
      target,
      sha256: sha256(Buffer.from(target)),
    };
  }
  if (!metadata.isFile()) throw new Error(`Unsupported release path: ${normalized}`);
  const body = readFileSync(absolute);
  return {
    path: normalized,
    kind: 'file',
    mode,
    bytes: body.byteLength,
    sha256: sha256(body),
  };
}

export function directoryRecord(base, path) {
  const { absolute, normalized } = absoluteReleasePath(base, path);
  const metadata = lstatSync(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Expected a release directory: ${normalized}`);
  }
  return { path: normalized, kind: 'directory', mode: metadata.mode & 0o7777 };
}

function walkReleaseTree(base, path) {
  const { absolute, normalized } = absoluteReleasePath(base, path);
  const metadata = lstatSync(absolute, { throwIfNoEntry: false });
  if (!metadata) return [];
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return [normalized];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    walkReleaseTree(base, `${normalized}/${entry.name}`),
  );
}

function parentDirectories(paths) {
  const directories = new Set();
  for (const path of paths) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length > 0) {
      directories.add(parts.join('/'));
      parts.pop();
    }
  }
  return [...directories].sort(
    (left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right),
  );
}

function listedSourcePaths(root) {
  const listed = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], null)
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(normalizeReleasePath)
    .filter((path) => lstatSync(resolve(root, path), { throwIfNoEntry: false }) !== undefined);
  const dist = REQUIRED_DIST_FILES.flatMap((path) => {
    const directory = path.split('/').slice(0, -1).join('/');
    return walkReleaseTree(root, directory);
  });
  return [...new Set([...listed, ...dist])].sort();
}

function assertRequiredDist(root) {
  for (const path of REQUIRED_DIST_FILES) {
    const metadata = lstatSync(resolve(root, path), { throwIfNoEntry: false });
    if (!metadata?.isFile()) throw new Error(`Required production artifact is missing: ${path}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function treeDigest(files, directories) {
  return sha256(Buffer.from(JSON.stringify({ directories, files })));
}

export function createManifest({ root = process.cwd(), destination }) {
  const resolvedRoot = resolve(root);
  assertRequiredDist(resolvedRoot);
  const paths = listedSourcePaths(resolvedRoot);
  const files = paths.map((path) => fileRecord(resolvedRoot, path));
  const directories = parentDirectories(paths).map((path) => directoryRecord(resolvedRoot, path));
  const status = git(
    resolvedRoot,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    null,
  );
  const worktreeDiff = git(resolvedRoot, ['diff', '--binary', '--no-ext-diff', '--no-color'], null);
  const indexDiff = git(
    resolvedRoot,
    ['diff', '--cached', '--binary', '--no-ext-diff', '--no-color'],
    null,
  );
  const packageDocument = readJson(resolve(resolvedRoot, 'package.json'));
  const nvmrc = readFileSync(resolve(resolvedRoot, '.nvmrc'), 'utf8').trim();
  const packageLockPath = resolve(resolvedRoot, 'package-lock.json');
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    rootName: basename(resolvedRoot),
    release: { version: String(packageDocument.version) },
    git: {
      baseCommit: git(resolvedRoot, ['rev-parse', 'HEAD']).trim(),
      statusEntries:
        status.length === 0 ? 0 : status.toString('utf8').split('\0').filter(Boolean).length,
      statusPorcelainV1ZBase64: status.toString('base64'),
      statusSha256: sha256(status),
      worktreeDiffSha256: sha256(worktreeDiff),
      indexDiffSha256: sha256(indexDiff),
      dirty: status.length > 0,
    },
    toolchain: {
      node: process.version,
      nodePath: process.execPath,
      npm: execFileSync('npm', ['--version'], {
        cwd: resolvedRoot,
        encoding: 'utf8',
      }).trim(),
      nvmrc,
      platform: process.platform,
      arch: process.arch,
      packageLockSha256: sha256File(packageLockPath),
    },
    treeSha256: treeDigest(files, directories),
    directories,
    files,
  };

  if (destination) {
    const resolvedDestination = resolve(destination);
    mkdirSync(dirname(resolvedDestination), { recursive: true, mode: 0o700 });
    writeFileSync(resolvedDestination, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    chmodSync(resolvedDestination, 0o600);
  }
  return manifest;
}

export function readManifest(path) {
  const manifest = readJson(resolve(path));
  if (
    manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.directories) ||
    typeof manifest.treeSha256 !== 'string'
  ) {
    throw new Error('Unsupported release manifest.');
  }
  const allPaths = [...manifest.directories, ...manifest.files].map((record) =>
    normalizeReleasePath(record.path),
  );
  if (new Set(allPaths).size !== allPaths.length) throw new Error('Manifest paths are duplicated.');
  if (treeDigest(manifest.files, manifest.directories) !== manifest.treeSha256) {
    throw new Error('Manifest tree digest is invalid.');
  }
  return manifest;
}

export function verifyToolchain(manifestOrPath) {
  const manifest =
    typeof manifestOrPath === 'string' ? readManifest(manifestOrPath) : manifestOrPath;
  const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  const actual = { node: process.version, nodePath: process.execPath, npm: npmVersion };
  const expected = {
    node: manifest.toolchain.node,
    nodePath: manifest.toolchain.nodePath,
    npm: manifest.toolchain.npm,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Release toolchain mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
  return actual;
}

function recordMatches(actual, expected, ignoreMode = false) {
  if (!ignoreMode) return JSON.stringify(actual) === JSON.stringify(expected);
  const actualWithoutMode = { ...actual };
  const expectedWithoutMode = { ...expected };
  delete actualWithoutMode.mode;
  delete expectedWithoutMode.mode;
  return JSON.stringify(actualWithoutMode) === JSON.stringify(expectedWithoutMode);
}

function allowedExtra(path, prefixes) {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function actualTreePaths(root) {
  const paths = [];
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      paths.push(path);
      if (entry.isDirectory() && !entry.isSymbolicLink())
        visit(resolve(directory, entry.name), path);
    }
  };
  visit(root);
  return paths.sort();
}

export function verifyManifest(manifestOrPath, targetRoot, options = {}) {
  const manifest =
    typeof manifestOrPath === 'string' ? readManifest(manifestOrPath) : manifestOrPath;
  const root = resolve(targetRoot);
  const allowExtra = (options.allowExtra ?? []).map(normalizeReleasePath);
  const ignoreMode = options.ignoreMode === true;

  for (const expected of manifest.directories) {
    const actual = directoryRecord(root, expected.path);
    if (!recordMatches(actual, expected, ignoreMode)) {
      throw new Error(
        `Release verification failed: ${expected.path}; expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      );
    }
  }
  for (const expected of manifest.files) {
    const actual = fileRecord(root, expected.path);
    if (!recordMatches(actual, expected, ignoreMode)) {
      throw new Error(
        `Release verification failed: ${expected.path}; expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      );
    }
  }

  if (options.checkExtras !== false) {
    const expected = new Set([
      ...manifest.directories.map((record) => record.path),
      ...manifest.files.map((record) => record.path),
    ]);
    const extras = actualTreePaths(root).filter(
      (path) => !expected.has(path) && !allowedExtra(path, allowExtra),
    );
    if (extras.length > 0) {
      throw new Error(
        `Release verification found unexpected paths: ${extras.slice(0, 5).join(', ')}`,
      );
    }
  }
  return { verified: manifest.files.length, directories: manifest.directories.length, root };
}

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (!value) throw new Error(`${name} requires a value.`);
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function optionValue(args, name) {
  return optionValues(args, name).at(-1);
}

function runCli() {
  const args = process.argv.slice(2);
  if (args[0] === '--verify-toolchain') {
    if (!args[1]) throw new Error('Usage: release-manifest.mjs --verify-toolchain <manifest>');
    process.stdout.write(`${JSON.stringify(verifyToolchain(args[1]))}\n`);
    return;
  }
  if (args[0] === '--verify') {
    const manifestPath = args[1];
    const targetRoot = args[2];
    if (!manifestPath || !targetRoot) {
      throw new Error(
        'Usage: release-manifest.mjs --verify <manifest> <root> [--allow-extra path]',
      );
    }
    const result = verifyManifest(manifestPath, targetRoot, {
      allowExtra: optionValues(args.slice(3), '--allow-extra'),
      ignoreMode: args.slice(3).includes('--ignore-mode'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const destination = optionValue(args, '--output') ?? args[0] ?? 'release-manifest.json';
  const manifest = createManifest({ destination });
  process.stdout.write(
    `${JSON.stringify({ path: relative(process.cwd(), resolve(destination)), files: manifest.files.length, treeSha256: manifest.treeSha256 })}\n`,
  );
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
