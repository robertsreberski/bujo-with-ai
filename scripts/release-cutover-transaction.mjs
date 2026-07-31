#!/usr/bin/env node
/* global Buffer, process */
import { createHash } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  ftruncateSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TERMINAL_SCHEMA_VERSION = 2;
const TRANSACTION_SCHEMA_VERSION = 1;
const TRANSACTION_PROTOCOL = 'cutover-baseline-restore-v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(document, expected, description) {
  assert(
    document !== null && typeof document === 'object' && !Array.isArray(document),
    `${description} is not an object.`,
  );
  const actual = Object.keys(document).sort();
  const wanted = expected.slice().sort();
  assert(JSON.stringify(actual) === JSON.stringify(wanted), `${description} fields are invalid.`);
}

function canonicalIso(value, description) {
  assert(
    typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    `${description} is not a canonical ISO timestamp.`,
  );
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

export function fsyncDirectory(path) {
  const descriptor = openSync(resolve(path), 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function assertStableGlobalLock({ path, fd }) {
  const resolvedPath = resolve(path);
  const descriptor = fstatSync(fd);
  const named = lstatSync(resolvedPath);
  const uid = process.getuid?.();
  assert(
    descriptor.isFile() &&
      named.isFile() &&
      !named.isSymbolicLink() &&
      descriptor.dev === named.dev &&
      descriptor.ino === named.ino &&
      descriptor.nlink === 1 &&
      named.nlink === 1 &&
      (uid === undefined || (descriptor.uid === uid && named.uid === uid)) &&
      (descriptor.mode & 0o7777) === 0o600 &&
      (named.mode & 0o7777) === 0o600,
    `Stable global release lock has unsafe ownership or identity: ${resolvedPath}`,
  );
  return {
    path: resolvedPath,
    dev: descriptor.dev.toString(),
    ino: descriptor.ino.toString(),
  };
}

export function recordStableGlobalLock({ path, fd, ownerPid, operation, now = () => new Date() }) {
  assertStableGlobalLock({ path, fd });
  assert(Number.isSafeInteger(ownerPid) && ownerPid > 0, 'Global release lock PID is invalid.');
  assert(
    operation === 'cutover-apply' || operation === 'cutover-rollback' || operation === 'promotion',
    'Global release lock operation is invalid.',
  );
  const document = {
    schemaVersion: 2,
    purpose: 'global-release',
    pid: ownerPid,
    createdAt: now().toISOString(),
    operation,
  };
  canonicalIso(document.createdAt, 'Global release lock creation time');
  const body = Buffer.from(`${JSON.stringify(document)}\n`);
  ftruncateSync(fd, 0);
  const written = writeSync(fd, body, 0, body.byteLength, 0);
  assert(written === body.byteLength, 'Global release lock metadata write was incomplete.');
  fchmodSync(fd, 0o600);
  fsyncSync(fd);
  assertStableGlobalLock({ path, fd });
  fsyncDirectory(dirname(resolve(path)));
  return document;
}

function sameIdentity(metadata, identity) {
  return metadata.dev.toString() === identity.dev && metadata.ino.toString() === identity.ino;
}

function privateRegularMetadata(path, description, { maximumLinks = 1 } = {}) {
  const resolvedPath = resolve(path);
  const metadata = lstatSync(resolvedPath);
  const uid = process.getuid?.();
  assert(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.nlink >= 1 &&
      metadata.nlink <= maximumLinks &&
      (uid === undefined || metadata.uid === uid) &&
      (metadata.mode & 0o7777) === 0o600,
    `${description} must be an owner-only regular file: ${resolvedPath}`,
  );
  return { resolvedPath, metadata };
}

function readStablePrivateFile(path, description, options) {
  const { resolvedPath, metadata: before } = privateRegularMetadata(path, description, options);
  const body = readFileSync(resolvedPath);
  const after = lstatSync(resolvedPath);
  assert(
    after.dev === before.dev &&
      after.ino === before.ino &&
      after.size === before.size &&
      after.mtimeMs === before.mtimeMs &&
      body.byteLength === before.size,
    `${description} changed while it was being read: ${resolvedPath}`,
  );
  return { resolvedPath, metadata: after, body };
}

function removeIdentity(path, identity, description) {
  const resolvedPath = resolve(path);
  const metadata = lstatSync(resolvedPath);
  assert(sameIdentity(metadata, identity), `${description} ownership changed: ${resolvedPath}`);
  unlinkSync(resolvedPath);
}

export function atomicWritePrivateFile(path, body, options = {}) {
  const resolvedPath = resolve(path);
  const nextPath = `${resolvedPath}.next`;
  assert(
    !lstatSync(resolvedPath, { throwIfNoEntry: false }),
    `Final file already exists: ${resolvedPath}`,
  );
  assert(
    !lstatSync(nextPath, { throwIfNoEntry: false }),
    `Prepared file already exists: ${nextPath}`,
  );
  const contents = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  let descriptor;
  let nextIdentity;
  let renamed = false;
  try {
    descriptor = openSync(nextPath, 'wx', 0o600);
    const openedMetadata = fstatSync(descriptor);
    nextIdentity = {
      dev: openedMetadata.dev.toString(),
      ino: openedMetadata.ino.toString(),
    };
    writeFileSync(descriptor, contents);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    options.phaseObserver?.('next-fsynced');
    assert(
      !lstatSync(resolvedPath, { throwIfNoEntry: false }),
      `Final file appeared before commit: ${resolvedPath}`,
    );
    options.beforeRename?.();
    renameSync(nextPath, resolvedPath);
    renamed = true;
    options.phaseObserver?.('renamed');
    fsyncDirectory(dirname(resolvedPath));
    options.phaseObserver?.('directory-fsynced');
    return resolvedPath;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!renamed && nextIdentity && lstatSync(nextPath, { throwIfNoEntry: false })) {
      removeIdentity(nextPath, nextIdentity, 'Prepared file');
      fsyncDirectory(dirname(nextPath));
    }
    throw error;
  }
}

export function atomicWritePrivateJson(path, document, options = {}) {
  return atomicWritePrivateFile(path, `${JSON.stringify(document, null, 2)}\n`, options);
}

export function atomicCopyPrivateFile(source, target) {
  const snapshot = readStablePrivateFile(source, 'Snapshot source');
  return atomicWritePrivateFile(target, snapshot.body);
}

function atomicReplacePrivateFile(target, body) {
  const resolvedTarget = resolve(target);
  const existing = lstatSync(resolvedTarget, { throwIfNoEntry: false });
  if (existing) privateRegularMetadata(resolvedTarget, 'Atomic replacement target');
  const nextPath = `${resolvedTarget}.next`;
  assert(
    !lstatSync(nextPath, { throwIfNoEntry: false }),
    `Prepared replacement already exists: ${nextPath}`,
  );
  const contents = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  let descriptor;
  let nextIdentity;
  let renamed = false;
  try {
    descriptor = openSync(nextPath, 'wx', 0o600);
    const openedMetadata = fstatSync(descriptor);
    nextIdentity = {
      dev: openedMetadata.dev.toString(),
      ino: openedMetadata.ino.toString(),
    };
    writeFileSync(descriptor, contents);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(nextPath, resolvedTarget);
    renamed = true;
    fsyncDirectory(dirname(resolvedTarget));
    return resolvedTarget;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!renamed && nextIdentity && lstatSync(nextPath, { throwIfNoEntry: false })) {
      removeIdentity(nextPath, nextIdentity, 'Prepared replacement');
      fsyncDirectory(dirname(nextPath));
    }
    throw error;
  }
}

export function atomicRestorePrivateFile(source, target) {
  const snapshot = readStablePrivateFile(source, 'Restore source');
  return atomicReplacePrivateFile(target, snapshot.body);
}

export function assertPrivateFilesEqual(expectedPath, actualPath) {
  const expected = readStablePrivateFile(expectedPath, 'Expected private file');
  const actual = readStablePrivateFile(actualPath, 'Actual private file');
  assert(expected.body.equals(actual.body), 'Private files do not have identical bytes.');
  return true;
}

export function migrationTreeInventory(root) {
  const resolvedRoot = resolve(root);
  const rootMetadata = lstatSync(resolvedRoot);
  const uid = process.getuid?.();
  assert(
    rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(),
    `Migration root is not a directory: ${resolvedRoot}`,
  );
  assert(
    (uid === undefined || rootMetadata.uid === uid) &&
      (rootMetadata.mode & 0o222) === 0 &&
      (rootMetadata.mode & 0o077) === 0,
    `Migration root is not owner-controlled and immutable: ${resolvedRoot}`,
  );
  const inventory = [];
  const visit = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = resolve(directory, name);
      const relativePath = prefix === '' ? name : `${prefix}/${name}`;
      const metadata = lstatSync(absolute);
      assert(!metadata.isSymbolicLink(), `Migration tree contains a symlink: ${absolute}`);
      assert(
        (uid === undefined || metadata.uid === uid) &&
          (metadata.mode & 0o222) === 0 &&
          (metadata.mode & 0o077) === 0,
        `Migration entry is not owner-controlled and immutable: ${absolute}`,
      );
      if (metadata.isDirectory()) {
        inventory.push({ path: relativePath, kind: 'directory' });
        visit(absolute, relativePath);
      } else {
        assert(metadata.isFile(), `Migration tree contains a non-file entry: ${absolute}`);
        const body = readFileSync(absolute);
        const after = lstatSync(absolute);
        assert(
          after.dev === metadata.dev &&
            after.ino === metadata.ino &&
            after.size === metadata.size &&
            after.mtimeMs === metadata.mtimeMs &&
            body.byteLength === metadata.size,
          `Migration changed while it was being read: ${absolute}`,
        );
        inventory.push({
          path: relativePath,
          kind: 'file',
          bytes: body.byteLength,
          sha256: sha256(body),
        });
      }
    }
  };
  visit(resolvedRoot, '');
  return inventory;
}

export function assertMigrationTreesEqual(candidateRoot, previousRoot) {
  const candidate = migrationTreeInventory(candidateRoot);
  const previous = migrationTreeInventory(previousRoot);
  assert(
    JSON.stringify(candidate) === JSON.stringify(previous),
    'Candidate and previous migration trees are not identical; schema-changing upgrades are unsupported.',
  );
  return candidate;
}

function immutableMigrationFile(path) {
  const resolvedPath = resolve(path);
  const metadata = lstatSync(resolvedPath);
  const uid = process.getuid?.();
  assert(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      (uid === undefined || metadata.uid === uid) &&
      (metadata.mode & 0o222) === 0 &&
      (metadata.mode & 0o077) === 0,
    `Migration definition is not an owner-controlled immutable file: ${resolvedPath}`,
  );
  const body = readFileSync(resolvedPath);
  const after = lstatSync(resolvedPath);
  assert(
    after.dev === metadata.dev &&
      after.ino === metadata.ino &&
      after.size === metadata.size &&
      after.mtimeMs === metadata.mtimeMs &&
      body.byteLength === metadata.size,
    `Migration definition changed while it was being read: ${resolvedPath}`,
  );
  return { bytes: body.byteLength, sha256: sha256(body) };
}

export function assertMigrationDefinitionFilesEqual(candidatePath, previousPath) {
  const candidate = immutableMigrationFile(candidatePath);
  const previous = immutableMigrationFile(previousPath);
  assert(
    JSON.stringify(candidate) === JSON.stringify(previous),
    'Candidate and previous runtime migration definitions are not identical; schema-changing upgrades are unsupported.',
  );
  return candidate;
}

function terminalStateRecord(path, releaseStamp) {
  if (!lstatSync(resolve(path), { throwIfNoEntry: false })) return null;
  const marker = readStablePrivateFile(path, 'Terminal release marker');
  let document;
  try {
    document = JSON.parse(marker.body.toString('utf8'));
  } catch (error) {
    throw new Error('Terminal release marker is not valid JSON.', { cause: error });
  }
  exactKeys(
    document,
    ['schemaVersion', 'releaseStamp', 'state', 'operation', 'pid', 'recordedAt'],
    'Terminal release marker',
  );
  assert(document.schemaVersion === TERMINAL_SCHEMA_VERSION, 'Terminal marker schema is invalid.');
  assert(document.releaseStamp === releaseStamp, 'Terminal marker stamp is invalid.');
  assert(
    ['in-progress', 'cutover-complete', 'rollback-complete', 'promotion-complete'].includes(
      document.state,
    ),
    'Terminal marker state is invalid.',
  );
  assert(
    ['cutover-apply', 'cutover-rollback', 'promotion'].includes(document.operation),
    'Terminal marker operation is invalid.',
  );
  assert(Number.isSafeInteger(document.pid) && document.pid > 0, 'Terminal marker PID is invalid.');
  canonicalIso(document.recordedAt, 'Terminal marker recorded time');
  return { document, metadata: marker.metadata };
}

export function readTerminalState(path, releaseStamp) {
  return terminalStateRecord(path, releaseStamp)?.document ?? null;
}

export function writeTerminalState({
  path,
  releaseStamp,
  state,
  operation,
  ownerPid,
  now = () => new Date(),
}) {
  readTerminalState(path, releaseStamp);
  const document = {
    schemaVersion: TERMINAL_SCHEMA_VERSION,
    releaseStamp,
    state,
    operation,
    pid: ownerPid,
    recordedAt: now().toISOString(),
  };
  assert(Number.isSafeInteger(ownerPid) && ownerPid > 0, 'Terminal marker PID is invalid.');
  canonicalIso(document.recordedAt, 'Terminal marker recorded time');
  assert(
    ['in-progress', 'cutover-complete', 'rollback-complete', 'promotion-complete'].includes(state),
    'Terminal marker state is invalid.',
  );
  assert(
    ['cutover-apply', 'cutover-rollback', 'promotion'].includes(operation),
    'Terminal marker operation is invalid.',
  );
  atomicReplacePrivateFile(path, `${JSON.stringify(document, null, 2)}\n`);
  return document;
}

export function removeTerminalState({ path, releaseStamp, expectedOperation, expectedState }) {
  const record = terminalStateRecord(path, releaseStamp);
  assert(record, 'Terminal release marker is absent.');
  const marker = record.document;
  assert(
    marker.operation === expectedOperation,
    'Terminal marker operation changed before removal.',
  );
  assert(marker.state === expectedState, 'Terminal marker state changed before removal.');
  const identity = {
    dev: record.metadata.dev.toString(),
    ino: record.metadata.ino.toString(),
  };
  removeIdentity(path, identity, 'Terminal release marker');
  fsyncDirectory(dirname(resolve(path)));
  return true;
}

function snapshotRecord(path, description) {
  const snapshot = readStablePrivateFile(path, description);
  return {
    state: 'present',
    path: snapshot.resolvedPath,
    sha256: sha256(snapshot.body),
    bytes: snapshot.body.byteLength,
    mode: '0600',
    device: snapshot.metadata.dev.toString(),
    inode: snapshot.metadata.ino.toString(),
  };
}

function absentRecord(path, description) {
  const resolvedPath = resolve(path);
  assert(!lstatSync(resolvedPath, { throwIfNoEntry: false }), `${description} is not absent.`);
  return { state: 'absent', path: resolvedPath };
}

function assertSnapshotRecord(record, expectedPath, description) {
  exactKeys(record, ['state', 'path', 'sha256', 'bytes', 'mode', 'device', 'inode'], description);
  assert(record.state === 'present', `${description} state is invalid.`);
  assert(record.path === resolve(expectedPath), `${description} path is invalid.`);
  assert(
    typeof record.sha256 === 'string' && SHA256_PATTERN.test(record.sha256),
    `${description} hash is invalid.`,
  );
  assert(
    Number.isSafeInteger(record.bytes) && record.bytes >= 0,
    `${description} size is invalid.`,
  );
  assert(record.mode === '0600', `${description} mode is invalid.`);
  assert(
    /^\d+$/.test(record.device) && /^\d+$/.test(record.inode),
    `${description} identity is invalid.`,
  );
  const snapshot = readStablePrivateFile(expectedPath, description);
  assert(snapshot.body.byteLength === record.bytes, `${description} size changed.`);
  assert(sha256(snapshot.body) === record.sha256, `${description} hash changed.`);
  assert(snapshot.metadata.dev.toString() === record.device, `${description} device changed.`);
  assert(snapshot.metadata.ino.toString() === record.inode, `${description} inode changed.`);
}

function assertAbsentRecord(record, expectedPath, description) {
  exactKeys(record, ['state', 'path'], description);
  assert(record.state === 'absent', `${description} state is invalid.`);
  assert(record.path === resolve(expectedPath), `${description} path is invalid.`);
}

function transactionDocument(options) {
  const mode = options.mode;
  assert(mode === 'first-install' || mode === 'upgrade', `Invalid release mode: ${mode}`);
  const configBaseline =
    mode === 'upgrade'
      ? snapshotRecord(options.configBefore, 'Config baseline')
      : absentRecord(options.config, 'Config baseline');
  const plistBaseline =
    mode === 'upgrade'
      ? snapshotRecord(options.plistBefore, 'Plist baseline')
      : absentRecord(options.plist, 'Plist baseline');
  return {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    protocol: TRANSACTION_PROTOCOL,
    releaseStamp: options.releaseStamp,
    mode,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    context: {
      baseCommit: options.baseCommit,
      manifestSha256: options.manifestSha256,
      archiveSha256: options.archiveSha256,
      releaseRoot: resolve(options.releaseRoot),
      previousRelease: mode === 'upgrade' ? resolve(options.previousRelease) : null,
    },
    resources: {
      currentLink: resolve(options.currentLink),
      config: resolve(options.config),
      plist: resolve(options.plist),
      serviceTarget: options.serviceTarget,
    },
    baseline: {
      serve: snapshotRecord(options.serveBefore, 'Serve baseline'),
      config: configBaseline,
      plist: plistBaseline,
    },
    artifacts: {
      configBefore: resolve(options.configBefore),
      plistBefore: resolve(options.plistBefore),
      configNext: resolve(options.configNext),
      serveBefore: resolve(options.serveBefore),
      serveAfter: resolve(options.serveAfter),
      serveRecovery: resolve(options.serveRecovery),
      serveRollbackAfter: resolve(options.serveRollbackAfter),
      cutoverEvidence: resolve(options.cutoverEvidence),
      rollbackEvidence: resolve(options.rollbackEvidence),
    },
  };
}

function assertTransaction(document, options) {
  exactKeys(
    document,
    [
      'schemaVersion',
      'protocol',
      'releaseStamp',
      'mode',
      'createdAt',
      'context',
      'resources',
      'baseline',
      'artifacts',
    ],
    'Cutover transaction',
  );
  assert(
    document.schemaVersion === TRANSACTION_SCHEMA_VERSION,
    'Cutover transaction schema is invalid.',
  );
  assert(document.protocol === TRANSACTION_PROTOCOL, 'Cutover transaction protocol is invalid.');
  assert(document.releaseStamp === options.releaseStamp, 'Cutover transaction stamp is invalid.');
  assert(document.mode === options.mode, 'Cutover transaction mode is invalid.');
  canonicalIso(document.createdAt, 'Cutover transaction creation time');
  exactKeys(
    document.context,
    ['baseCommit', 'manifestSha256', 'archiveSha256', 'releaseRoot', 'previousRelease'],
    'Cutover transaction context',
  );
  assert(
    document.context.baseCommit === options.baseCommit,
    'Cutover transaction base commit is invalid.',
  );
  assert(
    document.context.manifestSha256 === options.manifestSha256,
    'Cutover transaction manifest hash is invalid.',
  );
  assert(
    document.context.archiveSha256 === options.archiveSha256,
    'Cutover transaction archive hash is invalid.',
  );
  assert(
    document.context.releaseRoot === resolve(options.releaseRoot),
    'Cutover transaction release root is invalid.',
  );
  const expectedPrevious = options.mode === 'upgrade' ? resolve(options.previousRelease) : null;
  assert(
    document.context.previousRelease === expectedPrevious,
    'Cutover transaction previous release is invalid.',
  );
  exactKeys(
    document.resources,
    ['currentLink', 'config', 'plist', 'serviceTarget'],
    'Cutover transaction resources',
  );
  assert(
    document.resources.currentLink === resolve(options.currentLink),
    'Cutover current-link path is invalid.',
  );
  assert(document.resources.config === resolve(options.config), 'Cutover config path is invalid.');
  assert(document.resources.plist === resolve(options.plist), 'Cutover plist path is invalid.');
  assert(
    document.resources.serviceTarget === options.serviceTarget,
    'Cutover service target is invalid.',
  );
  exactKeys(document.baseline, ['serve', 'config', 'plist'], 'Cutover transaction baseline');
  assertSnapshotRecord(document.baseline.serve, options.serveBefore, 'Serve baseline');
  if (options.mode === 'upgrade') {
    assertSnapshotRecord(document.baseline.config, options.configBefore, 'Config baseline');
    assertSnapshotRecord(document.baseline.plist, options.plistBefore, 'Plist baseline');
  } else {
    assertAbsentRecord(document.baseline.config, options.config, 'Config baseline');
    assertAbsentRecord(document.baseline.plist, options.plist, 'Plist baseline');
  }
  exactKeys(
    document.artifacts,
    [
      'configBefore',
      'plistBefore',
      'configNext',
      'serveBefore',
      'serveAfter',
      'serveRecovery',
      'serveRollbackAfter',
      'cutoverEvidence',
      'rollbackEvidence',
    ],
    'Cutover transaction artifacts',
  );
  for (const [name, optionName] of [
    ['configBefore', 'configBefore'],
    ['plistBefore', 'plistBefore'],
    ['configNext', 'configNext'],
    ['serveBefore', 'serveBefore'],
    ['serveAfter', 'serveAfter'],
    ['serveRecovery', 'serveRecovery'],
    ['serveRollbackAfter', 'serveRollbackAfter'],
    ['cutoverEvidence', 'cutoverEvidence'],
    ['rollbackEvidence', 'rollbackEvidence'],
  ]) {
    assert(
      document.artifacts[name] === resolve(options[optionName]),
      `Cutover ${name} path is invalid.`,
    );
  }
  return document;
}

export function createCutoverTransaction(options) {
  const document = transactionDocument(options);
  atomicWritePrivateJson(options.transactionPath, document, options.writeOptions);
  return document;
}

export function validateCutoverTransaction(options) {
  const transaction = readStablePrivateFile(options.transactionPath, 'Cutover transaction');
  let document;
  try {
    document = JSON.parse(transaction.body.toString('utf8'));
  } catch (error) {
    throw new Error('Cutover transaction is not valid JSON.', { cause: error });
  }
  return assertTransaction(document, options);
}

function assertWithinRoot(path, root) {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  const difference = relative(resolvedRoot, resolvedPath);
  assert(
    difference !== '' &&
      difference !== '..' &&
      !difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`),
    `Provisional path escapes its evidence root: ${resolvedPath}`,
  );
  return resolvedPath;
}

export function removeOwnedProvisionalFiles(paths, { root }) {
  const directories = new Set();
  for (const path of paths) {
    const resolvedPath = assertWithinRoot(path, root);
    const metadata = lstatSync(resolvedPath, { throwIfNoEntry: false });
    if (!metadata) continue;
    privateRegularMetadata(resolvedPath, 'Provisional artifact');
    const identity = { dev: metadata.dev.toString(), ino: metadata.ino.toString() };
    removeIdentity(resolvedPath, identity, 'Provisional artifact');
    directories.add(dirname(resolvedPath));
  }
  for (const directory of directories) fsyncDirectory(directory);
  return true;
}

export function classifyCutoverRecoveryState({
  transactionExists,
  cutoverExists,
  rollbackExists,
  provisionalExists,
}) {
  if (rollbackExists) return transactionExists ? 'finalize-rollback' : 'rolled-back';
  if (cutoverExists) return transactionExists ? 'finalize-cutover' : 'cutover-committed';
  if (transactionExists) return 'restore-transaction';
  if (provisionalExists) return 'clean-provisional';
  return 'clean';
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (index + 1 >= args.length) throw new Error(`${name} requires a value.`);
  return args[index + 1];
}

function requiredOption(args, name) {
  const result = option(args, name);
  if (result === undefined) throw new Error(`${name} is required.`);
  return result;
}

function repeatedOption(args, name) {
  const results = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      if (index + 1 >= args.length) throw new Error(`${name} requires a value.`);
      results.push(args[index + 1]);
      index += 1;
    }
  }
  return results;
}

function transactionOptions(args) {
  return {
    transactionPath: requiredOption(args, '--transaction'),
    releaseStamp: requiredOption(args, '--release-stamp'),
    mode: requiredOption(args, '--mode'),
    baseCommit: requiredOption(args, '--base-commit'),
    manifestSha256: requiredOption(args, '--manifest-sha256'),
    archiveSha256: requiredOption(args, '--archive-sha256'),
    releaseRoot: requiredOption(args, '--release-root'),
    previousRelease: requiredOption(args, '--previous-release'),
    currentLink: requiredOption(args, '--current-link'),
    config: requiredOption(args, '--config'),
    plist: requiredOption(args, '--plist'),
    serviceTarget: requiredOption(args, '--service-target'),
    serveBefore: requiredOption(args, '--serve-before'),
    configBefore: requiredOption(args, '--config-before'),
    plistBefore: requiredOption(args, '--plist-before'),
    configNext: requiredOption(args, '--config-next'),
    serveAfter: requiredOption(args, '--serve-after'),
    serveRecovery: requiredOption(args, '--serve-recovery'),
    serveRollbackAfter: requiredOption(args, '--serve-rollback-after'),
    cutoverEvidence: requiredOption(args, '--cutover-evidence'),
    rollbackEvidence: requiredOption(args, '--rollback-evidence'),
  };
}

function runCli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'global-lock-record') {
    recordStableGlobalLock({
      path: requiredOption(args, '--path'),
      fd: Number(requiredOption(args, '--fd')),
      ownerPid: Number(requiredOption(args, '--owner-pid')),
      operation: requiredOption(args, '--operation'),
    });
    return;
  }
  if (command === 'global-lock-verify') {
    assertStableGlobalLock({
      path: requiredOption(args, '--path'),
      fd: Number(requiredOption(args, '--fd')),
    });
    return;
  }
  if (command === 'terminal-read') {
    const marker = readTerminalState(
      requiredOption(args, '--path'),
      requiredOption(args, '--release-stamp'),
    );
    process.stdout.write(`${JSON.stringify(marker ?? { state: 'absent' })}\n`);
    return;
  }
  if (command === 'terminal-write') {
    writeTerminalState({
      path: requiredOption(args, '--path'),
      releaseStamp: requiredOption(args, '--release-stamp'),
      state: requiredOption(args, '--state'),
      operation: requiredOption(args, '--operation'),
      ownerPid: Number(requiredOption(args, '--owner-pid')),
    });
    return;
  }
  if (command === 'terminal-remove') {
    removeTerminalState({
      path: requiredOption(args, '--path'),
      releaseStamp: requiredOption(args, '--release-stamp'),
      expectedState: requiredOption(args, '--expected-state'),
      expectedOperation: requiredOption(args, '--expected-operation'),
    });
    return;
  }
  if (command === 'write-json') {
    const body = readFileSync(0, 'utf8');
    atomicWritePrivateJson(requiredOption(args, '--path'), JSON.parse(body));
    return;
  }
  if (command === 'copy-private') {
    atomicCopyPrivateFile(requiredOption(args, '--source'), requiredOption(args, '--target'));
    return;
  }
  if (command === 'restore-private') {
    atomicRestorePrivateFile(requiredOption(args, '--source'), requiredOption(args, '--target'));
    return;
  }
  if (command === 'compare-private') {
    assertPrivateFilesEqual(requiredOption(args, '--expected'), requiredOption(args, '--actual'));
    return;
  }
  if (command === 'compare-migrations') {
    assertMigrationTreesEqual(
      requiredOption(args, '--candidate'),
      requiredOption(args, '--previous'),
    );
    return;
  }
  if (command === 'compare-migration-definitions') {
    assertMigrationDefinitionFilesEqual(
      requiredOption(args, '--candidate'),
      requiredOption(args, '--previous'),
    );
    return;
  }
  if (command === 'transaction-create') {
    createCutoverTransaction(transactionOptions(args));
    return;
  }
  if (command === 'transaction-validate') {
    validateCutoverTransaction(transactionOptions(args));
    return;
  }
  if (command === 'remove-files') {
    removeOwnedProvisionalFiles(repeatedOption(args, '--path'), {
      root: requiredOption(args, '--root'),
    });
    return;
  }
  throw new Error(
    'Usage: release-cutover-transaction.mjs <global-lock-record|global-lock-verify|terminal-read|terminal-write|terminal-remove|write-json|copy-private|restore-private|compare-private|compare-migrations|compare-migration-definitions|transaction-create|transaction-validate|remove-files> ...',
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
