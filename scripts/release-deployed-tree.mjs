#!/usr/bin/env node
/* global Buffer, process */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const STAMP_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}-[0-9]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TEMP_PATTERN =
  /^\.deployed-tree-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}-[0-9]+\.next-[0-9]+-[a-f0-9-]+\.json$/;
const HASH_BUFFER = Buffer.allocUnsafe(1024 * 1024);

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function assertSafePathPart(name) {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    hasControlCharacter(name)
  ) {
    throw new Error('Deployed tree contains an unsafe path component.');
  }
}

function insideRoot(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
  );
}

function assertOwner(metadata, uid, description) {
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`${description} is not owned by the current user.`);
  }
}

function assertImmutableMode(metadata, description, options = {}) {
  const mode = metadata.mode & 0o7777;
  if (options.symlink !== true && (mode & 0o7277) !== 0) {
    throw new Error(`${description} is writable or accessible to group/other users.`);
  }
  return mode;
}

function hashRegularFile(path, expectedMetadata) {
  const descriptor = openSync(path, 'r');
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== BigInt(expectedMetadata.dev) ||
      opened.ino !== BigInt(expectedMetadata.ino) ||
      opened.nlink !== 1n ||
      !opened.isFile()
    ) {
      throw new Error('Deployed tree file identity changed during inspection.');
    }
    const hash = createHash('sha256');
    let bytes = 0;
    while (true) {
      const count = readSync(descriptor, HASH_BUFFER, 0, HASH_BUFFER.byteLength, null);
      if (count === 0) break;
      hash.update(HASH_BUFFER.subarray(0, count));
      bytes += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      BigInt(bytes) !== opened.size
    ) {
      throw new Error('Deployed tree file changed during inspection.');
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    closeSync(descriptor);
  }
}

function symlinkTarget(root, path, metadata) {
  if (metadata.nlink !== 1) throw new Error('Deployed tree symlink has multiple hard links.');
  const target = readlinkSync(path);
  if (!target || isAbsolute(target) || hasControlCharacter(target)) {
    throw new Error('Deployed tree contains an unsafe symlink target.');
  }
  const lexicalTarget = resolve(dirname(path), target);
  if (!insideRoot(root, lexicalTarget)) {
    throw new Error('Deployed tree symlink escapes the release root.');
  }
  let canonicalTarget;
  try {
    canonicalTarget = realpathSync(lexicalTarget);
  } catch (error) {
    throw new Error('Deployed tree contains a dangling symlink.', { cause: error });
  }
  if (!insideRoot(realpathSync(root), canonicalTarget)) {
    throw new Error('Deployed tree symlink resolves outside the release root.');
  }
  return target;
}

export function inventoryDeployedTree(root, options = {}) {
  const resolvedRoot = resolve(root);
  const uid = options.uid ?? process.getuid?.();
  const rootMetadata = lstatSync(resolvedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Deployed tree root is not a real directory.');
  }
  assertOwner(rootMetadata, uid, 'Deployed tree root');
  const rootMode = assertImmutableMode(rootMetadata, 'Deployed tree root');
  const records = [];
  const counts = { directories: 0, files: 0, symlinks: 0, bytes: 0 };

  const visit = (directory, prefix = '') => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      comparePath(left.name, right.name),
    );
    for (const entry of entries) {
      assertSafePathPart(entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = resolve(directory, entry.name);
      if (!insideRoot(resolvedRoot, absolutePath)) {
        throw new Error('Deployed tree path escapes the release root.');
      }
      const metadata = lstatSync(absolutePath);
      assertOwner(metadata, uid, 'Deployed tree path');
      if (metadata.isSymbolicLink()) {
        const target = symlinkTarget(resolvedRoot, absolutePath, metadata);
        records.push({
          path: relativePath,
          kind: 'symlink',
          mode: metadata.mode & 0o7777,
          target,
          sha256: sha256(Buffer.from(target)),
        });
        counts.symlinks += 1;
      } else if (metadata.isDirectory()) {
        const mode = assertImmutableMode(metadata, 'Deployed tree directory');
        records.push({ path: relativePath, kind: 'directory', mode });
        counts.directories += 1;
        visit(absolutePath, relativePath);
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1) throw new Error('Deployed tree file has multiple hard links.');
        const mode = assertImmutableMode(metadata, 'Deployed tree file');
        const hashed = hashRegularFile(absolutePath, metadata);
        records.push({ path: relativePath, kind: 'file', mode, ...hashed });
        counts.files += 1;
        counts.bytes += hashed.bytes;
      } else {
        throw new Error('Deployed tree contains an unsupported filesystem object.');
      }
    }
  };
  visit(resolvedRoot);
  records.sort((left, right) => comparePath(left.path, right.path));
  const digest = sha256(Buffer.from(stableJson({ rootMode, records })));
  return {
    algorithm: 'sha256',
    sha256: digest,
    rootMode,
    paths: records.length,
    ...counts,
    records,
  };
}

function readContext(contextPath) {
  const resolvedPath = resolve(contextPath);
  const metadata = lstatSync(resolvedPath);
  assertArtifactMetadata(resolvedPath, metadata);
  const context = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  if (
    !STAMP_PATTERN.test(context?.releaseStamp ?? '') ||
    typeof context?.baseCommit !== 'string' ||
    !SHA256_PATTERN.test(context?.manifestSha256 ?? '') ||
    !SHA256_PATTERN.test(context?.archiveSha256 ?? '') ||
    typeof context?.releaseRoot !== 'string' ||
    resolve(context.releaseRoot) !== context.releaseRoot
  ) {
    throw new Error('Release context cannot bind a deployed tree.');
  }
  return { path: resolvedPath, context };
}

function expectedArtifactPath(contextPath, stamp) {
  return resolve(dirname(resolve(contextPath)), `deployed-tree-${stamp}.json`);
}

function assertArtifactMetadata(path, metadata, uid = process.getuid?.()) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o7777) !== 0o600
  ) {
    throw new Error(
      `Deployed-tree attestation is not an owner-only single-link regular file: ${path}`,
    );
  }
}

function readPrivateArtifact(path) {
  const resolvedPath = resolve(path);
  const before = lstatSync(resolvedPath);
  assertArtifactMetadata(resolvedPath, before);
  if (before.size <= 0 || before.size > 128 * 1024 * 1024) {
    throw new Error('Deployed-tree attestation has an invalid size.');
  }
  const descriptor = openSync(resolvedPath, 'r');
  let bytes;
  try {
    const opened = fstatSync(descriptor);
    assertArtifactMetadata(resolvedPath, opened);
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error('Deployed-tree attestation identity changed while it was opened.');
    }
    bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    assertArtifactMetadata(resolvedPath, after);
    if (
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      bytes.byteLength !== after.size
    ) {
      throw new Error('Deployed-tree attestation changed while it was read.');
    }
  } finally {
    closeSync(descriptor);
  }
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('Deployed-tree attestation is invalid JSON.', { cause: error });
  }
  return { document, sha256: sha256(bytes), path: resolvedPath };
}

function assertAttestation(document, context, artifactPath) {
  const exactKeys = [
    'archiveSha256',
    'baseCommit',
    'manifestSha256',
    'recordedAt',
    'releaseRoot',
    'releaseStamp',
    'schemaVersion',
    'tree',
  ];
  if (
    JSON.stringify(Object.keys(document ?? {}).sort()) !== JSON.stringify(exactKeys) ||
    document.schemaVersion !== SCHEMA_VERSION ||
    document.releaseStamp !== context.releaseStamp ||
    document.baseCommit !== context.baseCommit ||
    document.manifestSha256 !== context.manifestSha256 ||
    document.archiveSha256 !== context.archiveSha256 ||
    document.releaseRoot !== resolve(context.releaseRoot) ||
    !Number.isFinite(Date.parse(document.recordedAt)) ||
    new Date(document.recordedAt).toISOString() !== document.recordedAt
  ) {
    throw new Error(
      `Deployed-tree attestation does not match its release context: ${artifactPath}`,
    );
  }
  const tree = document.tree;
  if (
    tree?.algorithm !== 'sha256' ||
    !SHA256_PATTERN.test(tree.sha256 ?? '') ||
    !Array.isArray(tree.records) ||
    !Number.isSafeInteger(tree.rootMode) ||
    tree.rootMode < 0 ||
    tree.rootMode > 0o7777 ||
    (tree.rootMode & 0o7277) !== 0 ||
    !Number.isSafeInteger(tree.paths) ||
    !Number.isSafeInteger(tree.files) ||
    !Number.isSafeInteger(tree.directories) ||
    !Number.isSafeInteger(tree.symlinks) ||
    !Number.isSafeInteger(tree.bytes) ||
    tree.bytes < 0 ||
    tree.paths !== tree.records.length ||
    tree.paths !== tree.files + tree.directories + tree.symlinks ||
    tree.records.some((record, index) =>
      index > 0 ? comparePath(tree.records[index - 1].path, record.path) >= 0 : false,
    ) ||
    sha256(Buffer.from(stableJson({ rootMode: tree.rootMode, records: tree.records }))) !==
      tree.sha256
  ) {
    throw new Error('Deployed-tree attestation inventory is internally inconsistent.');
  }
  let bytes = 0;
  let files = 0;
  let directories = 0;
  let symlinks = 0;
  for (const record of tree.records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('Deployed-tree attestation contains an invalid record.');
    }
    const parts = typeof record.path === 'string' ? record.path.split('/') : [];
    if (parts.length === 0) throw new Error('Deployed-tree attestation contains an unsafe path.');
    parts.forEach(assertSafePathPart);
    if (!Number.isSafeInteger(record.mode) || record.mode < 0 || record.mode > 0o7777) {
      throw new Error('Deployed-tree attestation contains an invalid mode.');
    }
    if (record.kind === 'directory') {
      if (
        JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(['kind', 'mode', 'path']) ||
        (record.mode & 0o7277) !== 0
      ) {
        throw new Error('Deployed-tree attestation contains an invalid directory record.');
      }
      directories += 1;
    } else if (record.kind === 'file') {
      if (
        JSON.stringify(Object.keys(record).sort()) !==
          JSON.stringify(['bytes', 'kind', 'mode', 'path', 'sha256']) ||
        (record.mode & 0o7277) !== 0 ||
        !Number.isSafeInteger(record.bytes) ||
        record.bytes < 0 ||
        !SHA256_PATTERN.test(record.sha256 ?? '')
      ) {
        throw new Error('Deployed-tree attestation contains an invalid file record.');
      }
      files += 1;
      bytes += record.bytes;
      if (!Number.isSafeInteger(bytes)) {
        throw new Error('Deployed-tree attestation byte count is unsafe.');
      }
    } else if (record.kind === 'symlink') {
      if (
        JSON.stringify(Object.keys(record).sort()) !==
          JSON.stringify(['kind', 'mode', 'path', 'sha256', 'target']) ||
        typeof record.target !== 'string' ||
        !record.target ||
        isAbsolute(record.target) ||
        hasControlCharacter(record.target) ||
        sha256(Buffer.from(record.target)) !== record.sha256
      ) {
        throw new Error('Deployed-tree attestation contains an invalid symlink record.');
      }
      symlinks += 1;
    } else {
      throw new Error('Deployed-tree attestation contains an unsupported record kind.');
    }
  }
  if (
    files !== tree.files ||
    directories !== tree.directories ||
    symlinks !== tree.symlinks ||
    bytes !== tree.bytes
  ) {
    throw new Error('Deployed-tree attestation counts are inconsistent.');
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(resolve(path), 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function cleanupTemporaryArtifacts(destination) {
  const directory = dirname(resolve(destination));
  const stamp = resolve(destination).match(/deployed-tree-([^/]+)\.json$/)?.[1];
  if (!stamp || !STAMP_PATTERN.test(stamp)) {
    throw new Error('Cannot clean unbound deployed-tree temporary artifacts.');
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!TEMP_PATTERN.test(entry.name) || !entry.name.startsWith(`.deployed-tree-${stamp}.next-`)) {
      continue;
    }
    const path = resolve(directory, entry.name);
    const metadata = lstatSync(path);
    assertArtifactMetadata(path, metadata);
    const ownerPid = Number(entry.name.match(/\.next-([0-9]+)-/)?.[1]);
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
      throw new Error('Deployed-tree temporary artifact has invalid ownership metadata.');
    }
    try {
      process.kill(ownerPid, 0);
      throw new Error('Another staging process owns a deployed-tree temporary artifact.');
    } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ESRCH')) throw error;
    }
    unlinkSync(path);
  }
  fsyncDirectory(directory);
}

function writePrivateAtomic(destination, document) {
  const resolvedDestination = resolve(destination);
  mkdirSync(dirname(resolvedDestination), { recursive: true, mode: 0o700 });
  if (lstatSync(resolvedDestination, { throwIfNoEntry: false })) {
    throw new Error('Deployed-tree attestation already exists.');
  }
  cleanupTemporaryArtifacts(resolvedDestination);
  const temporary = resolve(
    dirname(resolvedDestination),
    `.deployed-tree-${document.releaseStamp}.next-${process.pid}-${randomUUID()}.json`,
  );
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeBuffer(descriptor, bytes, offset);
    }
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(descriptor);
  try {
    linkSync(temporary, resolvedDestination);
    unlinkSync(temporary);
    fsyncDirectory(dirname(resolvedDestination));
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if (!(cleanupError && typeof cleanupError === 'object' && cleanupError.code === 'ENOENT')) {
        throw cleanupError;
      }
    }
    throw error;
  }
  return resolvedDestination;
}

function writeBuffer(descriptor, bytes, offset) {
  return writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
}

export function createDeployedTreeAttestation({ contextPath, root, outputPath, now = new Date() }) {
  const { context } = readContext(contextPath);
  const expectedOutput = expectedArtifactPath(contextPath, context.releaseStamp);
  if (resolve(outputPath) !== expectedOutput) {
    throw new Error('Deployed-tree attestation path is not release-bound.');
  }
  const tree = inventoryDeployedTree(root);
  const document = {
    schemaVersion: SCHEMA_VERSION,
    releaseStamp: context.releaseStamp,
    recordedAt: now.toISOString(),
    baseCommit: context.baseCommit,
    manifestSha256: context.manifestSha256,
    archiveSha256: context.archiveSha256,
    releaseRoot: resolve(context.releaseRoot),
    tree,
  };
  writePrivateAtomic(expectedOutput, document);
  return { path: expectedOutput, document };
}

export function verifyDeployedTreeAttestation({ contextPath, root, attestationPath }) {
  const { context } = readContext(contextPath);
  const expectedPath = expectedArtifactPath(contextPath, context.releaseStamp);
  if (resolve(attestationPath) !== expectedPath) {
    throw new Error('Deployed-tree attestation path is not release-bound.');
  }
  if (resolve(root) !== resolve(context.releaseRoot)) {
    throw new Error('Deployed-tree verification must target the context release root.');
  }
  const source = readPrivateArtifact(expectedPath);
  assertAttestation(source.document, context, source.path);
  const actual = inventoryDeployedTree(root);
  if (stableJson(actual) !== stableJson(source.document.tree)) {
    throw new Error('Deployed release tree no longer matches its attestation.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    releaseStamp: context.releaseStamp,
    releaseRoot: resolve(root),
    attestationPath: source.path,
    attestationSha256: source.sha256,
    treeSha256: actual.sha256,
    paths: actual.paths,
  };
}

export function discardIncompleteAttestation({ contextPath, attestationPath }) {
  const { context } = readContext(contextPath);
  const expectedPath = expectedArtifactPath(contextPath, context.releaseStamp);
  if (resolve(attestationPath) !== expectedPath) {
    throw new Error('Deployed-tree attestation path is not release-bound.');
  }
  const metadata = lstatSync(expectedPath, { throwIfNoEntry: false });
  if (!metadata) {
    cleanupTemporaryArtifacts(expectedPath);
    return false;
  }
  if (lstatSync(resolve(context.releaseRoot), { throwIfNoEntry: false })) {
    throw new Error('Cannot discard deployed-tree attestation while its release root exists.');
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (process.getuid?.() !== undefined && metadata.uid !== process.getuid()) ||
    (metadata.mode & 0o7777) !== 0o600 ||
    (metadata.nlink !== 1 && metadata.nlink !== 2)
  ) {
    throw new Error('Incomplete deployed-tree attestation is not safely owned.');
  }
  if (metadata.nlink === 1) {
    const source = readPrivateArtifact(expectedPath);
    assertAttestation(source.document, context, expectedPath);
    unlinkSync(expectedPath);
  } else {
    const directory = dirname(expectedPath);
    const prefix = `.deployed-tree-${context.releaseStamp}.next-`;
    const matching = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name.startsWith(prefix) && TEMP_PATTERN.test(entry.name))
      .map((entry) => resolve(directory, entry.name))
      .filter((path) => {
        const candidate = lstatSync(path);
        return candidate.dev === metadata.dev && candidate.ino === metadata.ino;
      });
    if (matching.length !== 1) {
      throw new Error('Incomplete deployed-tree hardlink commit cannot be recovered safely.');
    }
    const ownerPid = Number(matching[0].match(/\.next-([0-9]+)-/)?.[1]);
    try {
      process.kill(ownerPid, 0);
      throw new Error('Another staging process still owns the deployed-tree commit.');
    } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ESRCH')) throw error;
    }
    let document;
    try {
      document = JSON.parse(readFileSync(expectedPath, 'utf8'));
    } catch (error) {
      throw new Error('Incomplete deployed-tree attestation is invalid JSON.', { cause: error });
    }
    const afterRead = lstatSync(expectedPath);
    if (afterRead.dev !== metadata.dev || afterRead.ino !== metadata.ino || afterRead.nlink !== 2) {
      throw new Error('Incomplete deployed-tree attestation changed during recovery.');
    }
    assertAttestation(document, context, expectedPath);
    unlinkSync(expectedPath);
    unlinkSync(matching[0]);
  }
  cleanupTemporaryArtifacts(expectedPath);
  fsyncDirectory(dirname(expectedPath));
  return true;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`${name} requires a value.`);
  return args[index + 1];
}

function runCli() {
  const args = process.argv.slice(2);
  const action = args[0];
  const contextPath = option(args, '--context');
  const attestationPath = option(args, '--attestation');
  if (action === '--create') {
    const result = createDeployedTreeAttestation({
      contextPath,
      root: option(args, '--root'),
      outputPath: attestationPath,
    });
    process.stdout.write(
      `${JSON.stringify({ path: result.path, treeSha256: result.document.tree.sha256 })}\n`,
    );
    return;
  }
  if (action === '--verify') {
    process.stdout.write(
      `${JSON.stringify(
        verifyDeployedTreeAttestation({
          contextPath,
          root: option(args, '--root'),
          attestationPath,
        }),
      )}\n`,
    );
    return;
  }
  if (action === '--discard-incomplete') {
    process.stdout.write(
      `${JSON.stringify({ discarded: discardIncompleteAttestation({ contextPath, attestationPath }) })}\n`,
    );
    return;
  }
  throw new Error(
    'Usage: release-deployed-tree.mjs <--create|--verify|--discard-incomplete> --context <json> --attestation <json> [--root <dir>]',
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
