#!/usr/bin/env node
/* global Buffer, process */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateLedger } from './release-ledger.mjs';
import { inspectOperationalLogs } from './release-live-evidence.mjs';
import { verifyDeployedTreeAttestation } from './release-deployed-tree.mjs';
import { readManifest, sha256File, verifyManifest } from './release-manifest.mjs';
import { verifyServeChange } from './release-serve-config.mjs';
import {
  recheckRuntimeBinding,
  verifyApplicationOrigin,
  verifyRuntime,
} from './release-verify-runtime.mjs';

const JOURNAL_LABEL = 'com.rsreberski.journald';
const JOURNAL_ORIGIN = 'https://mickey-home.tail8a9beb.ts.net:5178';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const EXPECTED_MCP_TOOLS = [
  'add_entry',
  'add_to_collection',
  'list_day',
  'search',
  'update_entry',
  'delete_entry',
  'propose_migration',
];
const EXPECTED_LOG_OPERATIONS = [
  'server_started',
  'server_stopped',
  'http_request',
  'mcp_tool_call',
];
const EXPECTED_RUNTIME_ENVIRONMENT_KEYS = [
  'JOURNAL_BIND_HOST',
  'JOURNAL_CONFIG',
  'JOURNAL_DATA_DIR',
  'JOURNAL_DAY_BOUNDARY_OFFSET_MIN',
  'JOURNAL_HOSTS',
  'JOURNAL_PORT',
  'JOURNAL_TAILNET_HOST',
  'JOURNAL_TZ',
  'JOURNAL_VERSION',
  'NODE_ENV',
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
export const MAX_LIVE_CONTEXT_AGE_MS = 2 * 60 * 60 * 1000;
const GLOBAL_LOCK_SCHEMA_VERSION = 2;
const TERMINAL_MARKER_SCHEMA_VERSION = 2;
const PROMOTION_TRANSACTION_PROTOCOL = 'prepared-evidence-cas-v1';
const LIVE_CONTEXT_LOG_VALIDATION_PHASE = 'after-mcp-smoke-before-final-runtime-recheck';
const PROMOTION_LOG_VALIDATION_PHASE = 'after-promotion-http-probes-before-prepared-evidence';

function value(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value.`);
  return args[index + 1];
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function assertEqual(actual, expected, description) {
  if (actual !== expected) {
    throw new Error(
      `${description} mismatch: expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

function normalizedJson(value) {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizedJson(value[key])]),
    );
  }
  return value;
}

function assertExactJson(actual, expected, description) {
  if (JSON.stringify(normalizedJson(actual)) !== JSON.stringify(normalizedJson(expected))) {
    throw new Error(`${description} is not the exact required value.`);
  }
}

function assertExactKeys(record, expected, description) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`${description} is not an object.`);
  }
  assertExactJson(Object.keys(record).sort(), expected.slice().sort(), `${description} fields`);
}

function assertSha256(valueToCheck, description) {
  if (typeof valueToCheck !== 'string' || !SHA256_PATTERN.test(valueToCheck)) {
    throw new Error(`${description} is not a SHA-256 digest.`);
  }
}

function assertNonnegativeInteger(valueToCheck, description) {
  if (!Number.isSafeInteger(valueToCheck) || valueToCheck < 0) {
    throw new Error(`${description} must be a nonnegative integer.`);
  }
}

function assertRuntimeEnvironment(environment, name) {
  assertExactKeys(
    environment,
    [
      'keys',
      'unexpectedKeys',
      'credentialKeys',
      'isolatedBy',
      'providerOrSchedulerConfigurationAbsent',
    ],
    `${name} environment proof`,
  );
  assertExactJson(environment.keys, EXPECTED_RUNTIME_ENVIRONMENT_KEYS, `${name} environment keys`);
  assertExactJson(environment.unexpectedKeys, [], `${name} unexpected environment keys`);
  assertExactJson(environment.credentialKeys, [], `${name} credential environment keys`);
  assertEqual(environment.isolatedBy, '/usr/bin/env -i', `${name} environment isolation`);
  assertEqual(
    environment.providerOrSchedulerConfigurationAbsent,
    true,
    `${name} provider or scheduler configuration absence`,
  );
}

function assertImmutableTree(root) {
  let checked = 0;
  const visit = (path) => {
    const metadata = lstatSync(path);
    if (!metadata.isSymbolicLink()) {
      const mode = metadata.mode & 0o7777;
      if ((mode & 0o222) !== 0 || (mode & 0o077) !== 0) {
        throw new Error(`Release path is writable or accessible to group/other: ${path}`);
      }
      checked += 1;
    }
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      for (const entry of readdirSync(path)) visit(resolve(path, entry));
    }
  };
  visit(root);
  return checked;
}

function assertContextEvidence(document, context, name) {
  assertEqual(document.releaseStamp, context.releaseStamp, `${name} release stamp`);
  assertEqual(document.baseCommit, context.baseCommit, `${name} base commit`);
  assertEqual(document.manifestSha256, context.manifestSha256, `${name} manifest hash`);
  assertEqual(document.archiveSha256, context.archiveSha256, `${name} archive hash`);
}

function assertRuntimeEvidence(runtime, context, manifest, name) {
  assertEqual(runtime.releaseRoot, resolve(context.releaseRoot), `${name} release root`);
  assertEqual(runtime.version, manifest.release.version, `${name} version`);
  assertEqual(runtime.listener, '127.0.0.1:5178', `${name} listener`);
  assertEqual(runtime.node, resolve(manifest.toolchain.nodePath), `${name} Node path`);
  assertEqual(runtime.cli, resolve(context.releaseRoot, 'server/dist/cli.js'), `${name} CLI path`);
  assertEqual(runtime.workingDirectory, resolve(context.releaseRoot), `${name} working directory`);
  assertRuntimeEnvironment(runtime.environment, name);
  if (
    !runtime.workingDirectoryIdentity ||
    !/^[0-9]+$/.test(runtime.workingDirectoryIdentity.device ?? '') ||
    !/^[0-9]+$/.test(runtime.workingDirectoryIdentity.inode ?? '')
  ) {
    throw new Error(`${name} has no valid working-directory filesystem identity.`);
  }
  const releaseIdentity = statSync(resolve(context.releaseRoot), { bigint: true });
  assertEqual(
    runtime.workingDirectoryIdentity.device,
    releaseIdentity.dev.toString(),
    `${name} working-directory device`,
  );
  assertEqual(
    runtime.workingDirectoryIdentity.inode,
    releaseIdentity.ino.toString(),
    `${name} working-directory inode`,
  );
  assertEqual(runtime.health?.status, 'ok', `${name} health status`);
  assertEqual(runtime.health?.db, 'ok', `${name} database status`);
  assertEqual(runtime.health?.version, manifest.release.version, `${name} health version`);
  const asset = manifest.files.find((record) => record.path === runtime.asset?.path);
  if (
    !asset ||
    asset.kind !== 'file' ||
    asset.sha256 !== runtime.asset.sha256 ||
    asset.bytes !== runtime.asset.bytes
  ) {
    throw new Error(`${name} served asset does not match the release manifest.`);
  }
  if (!Number.isSafeInteger(runtime.pid) || runtime.pid <= 0) {
    throw new Error(`${name} has no valid launchd PID.`);
  }
}

function assertApplicationEvidence(application, manifest, name, expectedOrigin) {
  assertEqual(application.origin, expectedOrigin, `${name} origin`);
  assertEqual(application.health?.status, 'ok', `${name} health status`);
  assertEqual(application.health?.db, 'ok', `${name} database status`);
  assertEqual(application.health?.version, manifest.release.version, `${name} health version`);
  const asset = manifest.files.find((record) => record.path === application.asset?.path);
  if (
    !asset ||
    asset.kind !== 'file' ||
    asset.sha256 !== application.asset.sha256 ||
    asset.bytes !== application.asset.bytes
  ) {
    throw new Error(`${name} served asset does not match the release manifest.`);
  }
}

function sha256Buffer(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function expectedProductionEnvironment(home, manifest) {
  const dataDirectory = resolve(home, '.journal');
  return {
    NODE_ENV: 'production',
    JOURNAL_CONFIG: resolve(dataDirectory, 'config.json'),
    JOURNAL_DATA_DIR: dataDirectory,
    JOURNAL_PORT: '5178',
    JOURNAL_BIND_HOST: '127.0.0.1',
    JOURNAL_HOSTS: 'localhost:5178,127.0.0.1:5178,mickey-home.tail8a9beb.ts.net:5178',
    JOURNAL_TZ: 'Europe/Amsterdam',
    JOURNAL_DAY_BOUNDARY_OFFSET_MIN: '0',
    JOURNAL_VERSION: manifest.release.version,
    JOURNAL_TAILNET_HOST: 'mickey-home.tail8a9beb.ts.net:5178',
  };
}

function assertIsoTimestamp(valueToCheck, description) {
  if (
    typeof valueToCheck !== 'string' ||
    !Number.isFinite(Date.parse(valueToCheck)) ||
    new Date(valueToCheck).toISOString() !== valueToCheck
  ) {
    throw new Error(`${description} is not a canonical ISO timestamp.`);
  }
}

function releaseTimestamp(valueToCheck, description) {
  if (
    typeof valueToCheck !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(valueToCheck)
  ) {
    throw new Error(`${description} is not a canonical UTC timestamp.`);
  }
  const milliseconds = Date.parse(valueToCheck);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${description} is not a valid UTC timestamp.`);
  }
  const canonical = valueToCheck.includes('.') ? valueToCheck : valueToCheck.replace(/Z$/, '.000Z');
  if (new Date(milliseconds).toISOString() !== canonical) {
    throw new Error(`${description} is not a canonical UTC timestamp.`);
  }
  return milliseconds;
}

export function assertLiveContextFreshness({
  liveContext,
  cutover,
  lifecycle,
  now = new Date(),
  maximumAgeMs = MAX_LIVE_CONTEXT_AGE_MS,
}) {
  if (!Number.isFinite(maximumAgeMs) || maximumAgeMs <= 0) {
    throw new Error('Live-context maximum age must be a positive finite number.');
  }
  const nowMilliseconds = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error('Promotion time is invalid.');
  }
  const cutoverMilliseconds = releaseTimestamp(cutover.recordedAt, 'Cutover recorded time');
  const liveMilliseconds = releaseTimestamp(liveContext.recordedAt, 'Live-context recorded time');
  const lifecycleMilliseconds = releaseTimestamp(lifecycle.recordedAt, 'Lifecycle recorded time');
  if (lifecycleMilliseconds < cutoverMilliseconds) {
    throw new Error('Lifecycle evidence predates successful cutover.');
  }
  if (liveMilliseconds < lifecycleMilliseconds) {
    throw new Error('Live-context evidence predates lifecycle completion.');
  }
  if (liveMilliseconds > nowMilliseconds) {
    throw new Error('Live-context evidence is dated in the future.');
  }
  const ageMs = nowMilliseconds - liveMilliseconds;
  if (ageMs > maximumAgeMs) {
    throw new Error(
      `Live-context evidence is older than the ${maximumAgeMs}ms promotion freshness bound.`,
    );
  }
  return {
    recordedAt: liveContext.recordedAt,
    cutoverRecordedAt: cutover.recordedAt,
    lifecycleRecordedAt: lifecycle.recordedAt,
    checkedAt: new Date(nowMilliseconds).toISOString(),
    ageMs,
    maximumAgeMs,
    recordedAfterLifecycle: true,
    pidContinuityRequiredAcrossLifecycle: false,
  };
}

function readOwnerOnlyJson(path, description) {
  const resolvedPath = resolve(path);
  let before;
  try {
    before = lstatSync(resolvedPath);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`${description} is missing at its exact release-specific path.`, {
        cause: error,
      });
    }
    throw error;
  }
  const uid = process.getuid?.();
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (uid !== undefined && before.uid !== uid) ||
    (before.mode & 0o7777) !== 0o600
  ) {
    throw new Error(`${description} must be an owner-only regular file.`);
  }
  const descriptor = openSync(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let body;
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (uid !== undefined && opened.uid !== uid) ||
      (opened.mode & 0o7777) !== 0o600 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error(`${description} identity changed while it was opened.`);
    }
    body = readFileSync(descriptor);
    const afterOpened = fstatSync(descriptor);
    const afterNamed = lstatSync(resolvedPath);
    if (
      afterOpened.dev !== opened.dev ||
      afterOpened.ino !== opened.ino ||
      afterOpened.size !== opened.size ||
      afterOpened.mtimeMs !== opened.mtimeMs ||
      afterNamed.dev !== opened.dev ||
      afterNamed.ino !== opened.ino ||
      afterNamed.nlink !== 1 ||
      body.byteLength !== opened.size
    ) {
      throw new Error(`${description} changed while it was being read.`);
    }
  } finally {
    closeSync(descriptor);
  }
  let document;
  try {
    document = JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw new Error(`${description} is not valid JSON.`, { cause: error });
  }
  return { document, source: { path: resolvedPath, sha256: sha256Buffer(body) } };
}

function isLoopbackAddress(address) {
  return address === '::1' || address === 'localhost' || /^127(?:\.[0-9]{1,3}){3}$/.test(address);
}

function assertEndpoint(endpoint, description) {
  assertExactKeys(endpoint, ['address', 'port'], description);
  if (
    typeof endpoint.address !== 'string' ||
    !isLoopbackAddress(endpoint.address) ||
    typeof endpoint.port !== 'string' ||
    !/^(?:\*|[0-9]{1,5})$/.test(endpoint.port)
  ) {
    throw new Error(`${description} is not loopback-only TCP metadata.`);
  }
}

function assertSocket(socket, description) {
  const hasRemote = socket && Object.hasOwn(socket, 'remote');
  assertExactKeys(
    socket,
    ['state', 'direction', 'local', ...(hasRemote ? ['remote'] : [])],
    description,
  );
  if (typeof socket.state !== 'string' || !/^[A-Z_]+$/.test(socket.state)) {
    throw new Error(`${description} has an invalid TCP state.`);
  }
  assertEndpoint(socket.local, `${description} local endpoint`);
  if (hasRemote) assertEndpoint(socket.remote, `${description} remote endpoint`);
  const expectedDirection = hasRemote
    ? socket.local.port === '5178'
      ? 'inbound'
      : 'outbound'
    : 'listener';
  assertEqual(socket.direction, expectedDirection, `${description} direction`);
}

function assertTcpEvidence(tcp) {
  assertExactKeys(
    tcp,
    ['metadataOnly', 'snapshots', 'unexpectedNonLoopbackSockets'],
    'Live-context TCP evidence',
  );
  assertEqual(tcp.metadataOnly, true, 'Live-context TCP metadata-only policy');
  assertExactJson(
    tcp.unexpectedNonLoopbackSockets,
    [],
    'Live-context unexpected non-loopback sockets',
  );
  if (!Array.isArray(tcp.snapshots) || tcp.snapshots.length !== 2) {
    throw new Error('Live-context TCP evidence must contain both bounded snapshots.');
  }
  const phases = ['before-mcp-smoke', 'after-final-log-inspection'];
  for (const [snapshotIndex, snapshot] of tcp.snapshots.entries()) {
    assertExactKeys(snapshot, ['phase', 'sockets'], `Live-context TCP snapshot ${snapshotIndex}`);
    assertEqual(
      snapshot.phase,
      phases[snapshotIndex],
      `Live-context TCP snapshot ${snapshotIndex}`,
    );
    if (!Array.isArray(snapshot.sockets) || snapshot.sockets.length === 0) {
      throw new Error(`Live-context TCP snapshot ${snapshotIndex} contains no sockets.`);
    }
    snapshot.sockets.forEach((socket, socketIndex) =>
      assertSocket(socket, `Live-context TCP snapshot ${snapshotIndex} socket ${socketIndex}`),
    );
    const listeners = snapshot.sockets.filter((socket) => socket.direction === 'listener');
    if (
      listeners.length !== 1 ||
      listeners[0].state !== 'LISTEN' ||
      listeners[0].local.address !== '127.0.0.1' ||
      listeners[0].local.port !== '5178'
    ) {
      throw new Error(
        `Live-context TCP snapshot ${snapshotIndex} does not prove exactly one journald loopback listener.`,
      );
    }
  }
}

function assertLogOperations(operations, lines, description) {
  if (!operations || typeof operations !== 'object' || Array.isArray(operations)) {
    throw new Error(`${description} operation counts are invalid.`);
  }
  let total = 0;
  for (const [operation, count] of Object.entries(operations)) {
    if (
      !EXPECTED_LOG_OPERATIONS.includes(operation) ||
      !Number.isSafeInteger(count) ||
      count <= 0
    ) {
      throw new Error(`${description} contains a non-allowlisted operation count.`);
    }
    total += count;
  }
  assertEqual(total, lines, `${description} line and operation counts`);
}

function assertStructuredLogSummary(stream, description) {
  const archive = stream?.kind === 'rotating-archive';
  assertExactKeys(
    stream,
    [
      'path',
      'kind',
      'exists',
      'bytes',
      'sha256',
      'lines',
      'operations',
      ...(archive ? ['uncompressedBytes'] : []),
    ],
    description,
  );
  if (typeof stream.path !== 'string' || typeof stream.exists !== 'boolean') {
    throw new Error(`${description} path or existence flag is invalid.`);
  }
  assertNonnegativeInteger(stream.bytes, `${description} byte count`);
  assertNonnegativeInteger(stream.lines, `${description} line count`);
  assertSha256(stream.sha256, `${description} hash`);
  assertLogOperations(stream.operations, stream.lines, description);
  if (!stream.exists) {
    assertEqual(stream.bytes, 0, `${description} absent byte count`);
    assertEqual(stream.lines, 0, `${description} absent line count`);
    assertEqual(stream.sha256, EMPTY_SHA256, `${description} absent hash`);
  }
  if (archive) assertNonnegativeInteger(stream.uncompressedBytes, `${description} expanded bytes`);
}

function assertLogEvidence(
  logs,
  home,
  expectedValidationPhase = LIVE_CONTEXT_LOG_VALIDATION_PHASE,
) {
  assertExactKeys(
    logs,
    [
      'policy',
      'launchdStdout',
      'streams',
      'history',
      'allowedOperations',
      'contentBearingFieldsAccepted',
      'secretPatternsFound',
      'journalContentRecorded',
      'validationPhase',
    ],
    'Live-context log evidence',
  );
  assertEqual(logs.policy, 'strict-jsonl-allowlist', 'Live-context log policy');
  assertEqual(logs.validationPhase, expectedValidationPhase, 'Live-context log validation phase');
  assertExactJson(logs.allowedOperations, EXPECTED_LOG_OPERATIONS, 'Live-context log operations');
  assertEqual(logs.contentBearingFieldsAccepted, false, 'Live-context content-bearing log fields');
  assertEqual(logs.secretPatternsFound, false, 'Live-context log secret scan');
  assertEqual(logs.journalContentRecorded, false, 'Live-context logged journal content');

  const logDirectory = resolve(home, '.journal', 'logs');
  assertExactKeys(
    logs.launchdStdout,
    ['path', 'exists', 'bytes', 'sha256', 'policy'],
    'Live-context launchd stdout',
  );
  assertEqual(
    logs.launchdStdout.path,
    resolve(logDirectory, 'launchd.out.log'),
    'Live-context launchd stdout path',
  );
  if (typeof logs.launchdStdout.exists !== 'boolean') {
    throw new Error('Live-context launchd stdout existence flag is invalid.');
  }
  assertEqual(logs.launchdStdout.bytes, 0, 'Live-context launchd stdout bytes');
  assertEqual(logs.launchdStdout.sha256, EMPTY_SHA256, 'Live-context launchd stdout hash');
  assertEqual(logs.launchdStdout.policy, 'zero-content', 'Live-context launchd stdout policy');

  if (!Array.isArray(logs.streams) || logs.streams.length < 2) {
    throw new Error('Live-context log evidence is missing required structured streams.');
  }
  logs.streams.forEach((stream, index) =>
    assertStructuredLogSummary(stream, `Live-context structured log stream ${index}`),
  );
  const [stderr, current, ...archives] = logs.streams;
  assertEqual(stderr.kind, 'launchd-stderr', 'Live-context launchd stderr kind');
  assertEqual(stderr.path, resolve(logDirectory, 'launchd.err.log'), 'Live-context stderr path');
  assertEqual(current.kind, 'rotating-current', 'Live-context current log kind');
  assertEqual(current.path, resolve(logDirectory, 'journald.log'), 'Live-context current log path');
  assertEqual(current.exists, true, 'Live-context current log existence');
  const archiveNames = archives.map((stream, index) => {
    assertEqual(stream.kind, 'rotating-archive', `Live-context archive ${index} kind`);
    assertEqual(dirname(stream.path), logDirectory, `Live-context archive ${index} directory`);
    const name = basename(stream.path);
    if (!/^[0-9]{8}-[0-9]{4}-[0-9]{2}-journald\.log\.gz$/.test(name)) {
      throw new Error(`Live-context archive ${index} has an unsafe name.`);
    }
    assertEqual(stream.exists, true, `Live-context archive ${index} existence`);
    return name;
  });
  assertExactJson(archiveNames, archiveNames.slice().sort(), 'Live-context archive ordering');
  if (new Set(logs.streams.map((stream) => stream.path)).size !== logs.streams.length) {
    throw new Error('Live-context structured log paths are not unique.');
  }

  const historyKeys = ['path', 'exists', 'bytes', 'entries'];
  if (logs.history?.exists === true) historyKeys.push('sha256');
  assertExactKeys(logs.history, historyKeys, 'Live-context rotation history');
  assertEqual(
    logs.history.path,
    resolve(logDirectory, 'journald.log.txt'),
    'Live-context rotation history path',
  );
  if (typeof logs.history.exists !== 'boolean') {
    throw new Error('Live-context rotation-history existence flag is invalid.');
  }
  assertNonnegativeInteger(logs.history.bytes, 'Live-context rotation-history bytes');
  assertNonnegativeInteger(logs.history.entries, 'Live-context rotation-history entries');
  assertEqual(logs.history.entries, archives.length, 'Live-context rotation-history inventory');
  if (logs.history.exists) assertSha256(logs.history.sha256, 'Live-context rotation-history hash');
  else assertEqual(logs.history.bytes, 0, 'Live-context absent rotation-history bytes');
}

function assertMcpEvidence(mcp) {
  assertExactKeys(
    mcp,
    [
      'origin',
      'transport',
      'token',
      'initialize',
      'toolsList',
      'read',
      'sessionClosed',
      'secretsRecorded',
    ],
    'Live-context MCP evidence',
  );
  assertEqual(mcp.origin, JOURNAL_ORIGIN, 'Live-context MCP origin');
  assertEqual(mcp.transport, 'streamable-http', 'Live-context MCP transport');
  assertEqual(mcp.sessionClosed, true, 'Live-context MCP session cleanup');
  assertEqual(mcp.secretsRecorded, false, 'Live-context MCP recorded secrets');

  assertExactKeys(
    mcp.token,
    ['createdLocally', 'tokenIdSha256', 'secretRecorded', 'revoked', 'revokedProbeStatus'],
    'Live-context MCP token evidence',
  );
  assertEqual(mcp.token.createdLocally, true, 'Live-context local token creation');
  assertSha256(mcp.token.tokenIdSha256, 'Live-context token id hash');
  assertEqual(mcp.token.secretRecorded, false, 'Live-context recorded token secret');
  assertEqual(mcp.token.revoked, true, 'Live-context token revocation');
  assertEqual(mcp.token.revokedProbeStatus, 401, 'Live-context revoked-token probe');

  assertExactKeys(
    mcp.initialize,
    ['httpStatus', 'protocolVersion', 'sessionIdSha256'],
    'Live-context MCP initialization',
  );
  assertEqual(mcp.initialize.httpStatus, 200, 'Live-context MCP initialize status');
  assertEqual(
    mcp.initialize.protocolVersion,
    MCP_PROTOCOL_VERSION,
    'Live-context MCP protocol version',
  );
  assertSha256(mcp.initialize.sessionIdSha256, 'Live-context MCP session id hash');

  assertExactKeys(mcp.toolsList, ['httpStatus', 'names'], 'Live-context MCP tool inventory');
  assertEqual(mcp.toolsList.httpStatus, 200, 'Live-context MCP tools-list status');
  assertExactJson(mcp.toolsList.names, EXPECTED_MCP_TOOLS, 'Live-context MCP tool inventory');

  assertExactKeys(
    mcp.read,
    ['httpStatus', 'tool', 'structuredResultValidated', 'journalContentRecorded'],
    'Live-context MCP read smoke',
  );
  assertEqual(mcp.read.httpStatus, 200, 'Live-context MCP read status');
  assertEqual(mcp.read.tool, 'search', 'Live-context MCP read tool');
  assertEqual(mcp.read.structuredResultValidated, true, 'Live-context MCP structured read result');
  assertEqual(mcp.read.journalContentRecorded, false, 'Live-context MCP recorded journal content');
}

export function validateLiveContextEvidence({
  contextPath,
  context,
  manifest,
  home = homedir(),
  deployedTree,
}) {
  const path = resolve(dirname(resolve(contextPath)), `live-context-${context.releaseStamp}.json`);
  const { document: evidence, source } = readOwnerOnlyJson(path, 'Live-context evidence');
  assertExactKeys(
    evidence,
    [
      'schemaVersion',
      'releaseStamp',
      'recordedAt',
      'baseCommit',
      'manifestSha256',
      'archiveSha256',
      'releaseRoot',
      'deployedTree',
      'service',
      'mcp',
    ],
    'Live-context evidence',
  );
  assertEqual(evidence.schemaVersion, 1, 'Live-context evidence schema');
  assertContextEvidence(evidence, context, 'Live-context evidence');
  assertIsoTimestamp(evidence.recordedAt, 'Live-context recorded time');
  assertEqual(evidence.releaseRoot, resolve(context.releaseRoot), 'Live-context release root');
  assertDeployedTreeResult(
    evidence.deployedTree,
    context,
    'Live-context deployed tree',
    'stableDuringCollection',
  );
  if (deployedTree) {
    for (const field of ['attestationPath', 'attestationSha256', 'treeSha256', 'paths']) {
      assertEqual(
        evidence.deployedTree[field],
        deployedTree[field],
        `Live-context and promotion deployed-tree ${field}`,
      );
    }
  }

  const service = evidence.service;
  assertExactKeys(
    service,
    [
      'label',
      'serviceTarget',
      'pid',
      'plist',
      'process',
      'tcp',
      'logs',
      'pidStableDuringCollection',
      'workingDirectoryStableDuringCollection',
      'environmentKeysAndValuesStableDuringCollection',
    ],
    'Live-context service evidence',
  );
  assertEqual(service.label, JOURNAL_LABEL, 'Live-context launchd label');
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('Promotion cannot determine the current owner uid.');
  }
  assertEqual(
    service.serviceTarget,
    `gui/${uid}/${JOURNAL_LABEL}`,
    'Live-context launchd service target',
  );
  if (!Number.isSafeInteger(service.pid) || service.pid <= 0) {
    throw new Error('Live-context evidence has no valid launchd PID.');
  }
  assertEqual(service.pidStableDuringCollection, true, 'Live-context PID stability');
  assertEqual(
    service.workingDirectoryStableDuringCollection,
    true,
    'Live-context working-directory stability',
  );
  assertEqual(
    service.environmentKeysAndValuesStableDuringCollection,
    true,
    'Live-context environment stability',
  );

  const environment = expectedProductionEnvironment(home, manifest);
  const expectedNode = resolve(manifest.toolchain.nodePath);
  const expectedCli = resolve(context.releaseRoot, 'server/dist/cli.js');
  const expectedProgramArguments = [
    '/usr/bin/env',
    '-i',
    ...Object.entries(environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, valueToAssign]) => `${key}=${valueToAssign}`),
    expectedNode,
    expectedCli,
    'serve',
  ];
  assertExactKeys(
    service.plist,
    [
      'path',
      'sha256',
      'mode',
      'programArguments',
      'workingDirectory',
      'environmentKeys',
      'environmentSha256',
    ],
    'Live-context plist evidence',
  );
  assertEqual(
    service.plist.path,
    resolve(home, 'Library', 'LaunchAgents', `${JOURNAL_LABEL}.plist`),
    'Live-context plist path',
  );
  assertSha256(service.plist.sha256, 'Live-context plist hash');
  assertEqual(service.plist.mode, '0600', 'Live-context plist mode');
  assertExactJson(
    service.plist.programArguments,
    expectedProgramArguments,
    'Live-context plist program arguments',
  );
  assertEqual(
    service.plist.workingDirectory,
    resolve(context.releaseRoot),
    'Live-context plist working directory',
  );
  assertExactJson(
    service.plist.environmentKeys,
    EXPECTED_RUNTIME_ENVIRONMENT_KEYS,
    'Live-context plist environment keys',
  );
  assertEqual(
    service.plist.environmentSha256,
    sha256Buffer(Buffer.from(JSON.stringify(normalizedJson(environment)))),
    'Live-context plist environment hash',
  );

  assertExactKeys(
    service.process,
    [
      'commandSha256',
      'workingDirectory',
      'workingDirectoryIdentity',
      'environment',
      'descendants',
      'extraJournalLaunchdJobs',
    ],
    'Live-context process evidence',
  );
  assertEqual(
    service.process.commandSha256,
    sha256Buffer(Buffer.from([expectedNode, expectedCli, 'serve'].join(' '))),
    'Live-context process command hash',
  );
  assertEqual(
    service.process.workingDirectory,
    resolve(context.releaseRoot),
    'Live-context process working directory',
  );
  assertExactKeys(
    service.process.workingDirectoryIdentity,
    ['device', 'inode'],
    'Live-context process working-directory identity',
  );
  const releaseIdentity = statSync(resolve(context.releaseRoot), { bigint: true });
  assertEqual(
    service.process.workingDirectoryIdentity.device,
    releaseIdentity.dev.toString(),
    'Live-context process working-directory device',
  );
  assertEqual(
    service.process.workingDirectoryIdentity.inode,
    releaseIdentity.ino.toString(),
    'Live-context process working-directory inode',
  );
  assertRuntimeEnvironment(service.process.environment, 'Live-context process');
  assertExactJson(service.process.descendants, [], 'Live-context process descendants');
  assertExactJson(
    service.process.extraJournalLaunchdJobs,
    [],
    'Live-context extra Journal launchd jobs',
  );

  assertTcpEvidence(service.tcp);
  assertLogEvidence(service.logs, home);
  assertMcpEvidence(evidence.mcp);
  return { evidence, source };
}

function assertFiniteNonnegative(value, description) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${description} must be a finite nonnegative number.`);
  }
}

export function assertLifecycleEvidence(lifecycle, context, manifest, deployedTree) {
  assertExactKeys(
    lifecycle,
    [
      'schemaVersion',
      'releaseStamp',
      'recordedAt',
      'baseCommit',
      'manifestSha256',
      'archiveSha256',
      'deployedTree',
      'initialRuntime',
      'sigterm',
      'sigkill',
    ],
    'Lifecycle evidence',
  );
  assertContextEvidence(lifecycle, context, 'Lifecycle');
  assertEqual(lifecycle.schemaVersion, 1, 'Lifecycle evidence schema');
  releaseTimestamp(lifecycle.recordedAt, 'Lifecycle recorded time');
  assertDeployedTreeResult(
    lifecycle.deployedTree,
    context,
    'Lifecycle deployed tree',
    'stableDuringLifecycle',
  );
  if (deployedTree) {
    for (const field of ['attestationPath', 'attestationSha256', 'treeSha256', 'paths']) {
      assertEqual(
        lifecycle.deployedTree[field],
        deployedTree[field],
        `Lifecycle and promotion deployed-tree ${field}`,
      );
    }
  }
  assertRuntimeEvidence(lifecycle.initialRuntime, context, manifest, 'Initial lifecycle runtime');
  assertEqual(lifecycle.sigterm?.signal, 'SIGTERM', 'SIGTERM signal identity');
  assertEqual(lifecycle.sigkill?.signal, 'SIGKILL', 'SIGKILL signal identity');
  assertFiniteNonnegative(lifecycle.sigterm?.exitElapsedMs, 'SIGTERM exit duration');
  assertFiniteNonnegative(lifecycle.sigkill?.exitElapsedMs, 'SIGKILL exit duration');
  assertEqual(lifecycle.sigterm?.withinFiveSeconds, true, 'SIGTERM five-second bound');
  if (lifecycle.sigterm.exitElapsedMs > 5000) throw new Error('SIGTERM exceeded five seconds.');
  assertEqual(
    lifecycle.initialRuntime.pid,
    lifecycle.sigterm?.exactPid,
    'Initial runtime and SIGTERM target PID',
  );
  assertEqual(
    lifecycle.sigterm?.runtime?.pid,
    lifecycle.sigterm?.recoveredPid,
    'SIGTERM recovered runtime PID',
  );
  assertEqual(
    lifecycle.sigterm?.recoveredPid,
    lifecycle.sigkill?.exactPid,
    'SIGKILL target and SIGTERM recovered PID',
  );
  assertEqual(
    lifecycle.sigkill?.runtime?.pid,
    lifecycle.sigkill?.recoveredPid,
    'SIGKILL recovered runtime PID',
  );
  assertEqual(lifecycle.sigterm?.distinctRecovery, true, 'SIGTERM distinct recovery');
  assertEqual(lifecycle.sigkill?.distinctRecovery, true, 'SIGKILL distinct recovery');
  if (lifecycle.sigterm.exactPid === lifecycle.sigterm.recoveredPid)
    throw new Error('SIGTERM PID was reused.');
  if (lifecycle.sigkill.exactPid === lifecycle.sigkill.recoveredPid)
    throw new Error('SIGKILL PID was reused.');
  if (lifecycle.sigkill.recoveredPid === lifecycle.sigterm.exactPid)
    throw new Error('SIGKILL recovery reused the initial SIGTERM PID.');
  assertRuntimeEvidence(lifecycle.sigterm.runtime, context, manifest, 'Post-SIGTERM runtime');
  assertRuntimeEvidence(lifecycle.sigkill.runtime, context, manifest, 'Post-SIGKILL runtime');
  return true;
}

function assertCurrentPointer(context, currentLink) {
  const currentMetadata = lstatSync(currentLink, { throwIfNoEntry: false });
  if (context.mode === 'first-install') {
    if (currentMetadata)
      throw new Error('First-install current-release pointer is no longer absent.');
  } else if (context.mode === 'upgrade') {
    if (!currentMetadata?.isSymbolicLink()) {
      throw new Error('Upgrade current-release pointer is not a symlink.');
    }
    assertEqual(
      resolve(dirname(currentLink), readlinkSync(currentLink)),
      resolve(context.previousRelease),
      'Previous release pointer',
    );
  } else {
    throw new Error(`Invalid release mode: ${context.mode}`);
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

function writePrivateFile(path, body) {
  const resolvedPath = resolve(path);
  let descriptor;
  let owned = false;
  try {
    descriptor = openSync(resolvedPath, 'wx', 0o600);
    owned = true;
    writeFileSync(descriptor, body);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (owned) rmSync(resolvedPath, { force: true });
    throw error;
  }
  closeSync(descriptor);
  return resolvedPath;
}

function assertStableGlobalLock(path, descriptor) {
  const resolvedPath = resolve(path);
  const opened = fstatSync(descriptor);
  const named = lstatSync(resolvedPath);
  const uid = process.getuid?.();
  if (
    !opened.isFile() ||
    !named.isFile() ||
    named.isSymbolicLink() ||
    opened.nlink !== 1 ||
    named.nlink !== 1 ||
    (uid !== undefined && (opened.uid !== uid || named.uid !== uid)) ||
    (opened.mode & 0o7777) !== 0o600 ||
    (named.mode & 0o7777) !== 0o600 ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino
  ) {
    throw new Error(`Global release lock is not one stable owner-only inode: ${resolvedPath}`);
  }
  return { path: resolvedPath, descriptor, dev: opened.dev, ino: opened.ino };
}

function acquireGlobalReleaseLock(path, operationName, dependencies = {}) {
  const resolvedPath = resolve(path);
  if (!['promotion', 'cutover-apply', 'cutover-rollback'].includes(operationName)) {
    throw new Error(`Unknown global release operation: ${operationName}`);
  }
  const descriptor = openSync(
    resolvedPath,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    assertStableGlobalLock(resolvedPath, descriptor);
    const runLockf =
      dependencies.runLockf ??
      ((lockDescriptor) =>
        execFileSync('/usr/bin/lockf', ['-s', '-t', '0', '3'], {
          stdio: ['ignore', 'pipe', 'pipe', lockDescriptor],
          timeout: 2_000,
        }));
    try {
      runLockf(descriptor, resolvedPath);
    } catch (error) {
      throw new Error(`Another global release operation is active: ${resolvedPath}`, {
        cause: error,
      });
    }
    const lock = assertStableGlobalLock(resolvedPath, descriptor);
    const owner = {
      schemaVersion: GLOBAL_LOCK_SCHEMA_VERSION,
      purpose: 'global-release',
      pid: process.pid,
      createdAt: new Date().toISOString(),
      operation: operationName,
    };
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    assertStableGlobalLock(resolvedPath, descriptor);
    fsyncDirectory(dirname(resolvedPath));
    return lock;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export async function withGlobalReleaseLock(lockPath, operationName, operation, dependencies = {}) {
  if (typeof operation !== 'function') {
    throw new Error('Global release lock requires an operation callback.');
  }
  const lock = acquireGlobalReleaseLock(lockPath, operationName, dependencies);
  try {
    return await operation();
  } finally {
    try {
      assertStableGlobalLock(lock.path, lock.descriptor);
    } finally {
      closeSync(lock.descriptor);
    }
  }
}

function assertTerminalMarker(document, releaseStamp) {
  assertExactKeys(
    document,
    ['schemaVersion', 'releaseStamp', 'state', 'operation', 'pid', 'recordedAt'],
    'Release terminal marker',
  );
  assertEqual(document.schemaVersion, TERMINAL_MARKER_SCHEMA_VERSION, 'Terminal marker schema');
  assertEqual(document.releaseStamp, releaseStamp, 'Terminal marker release stamp');
  if (
    !['in-progress', 'cutover-complete', 'rollback-complete', 'promotion-complete'].includes(
      document.state,
    )
  ) {
    throw new Error('Terminal marker state is invalid.');
  }
  if (!['cutover-apply', 'cutover-rollback', 'promotion'].includes(document.operation)) {
    throw new Error('Terminal marker operation is invalid.');
  }
  const terminalOperation = {
    'cutover-complete': 'cutover-apply',
    'rollback-complete': 'cutover-rollback',
    'promotion-complete': 'promotion',
  }[document.state];
  if (terminalOperation !== undefined && document.operation !== terminalOperation) {
    throw new Error('Terminal marker state and operation are inconsistent.');
  }
  if (!Number.isSafeInteger(document.pid) || document.pid <= 0) {
    throw new Error('Terminal marker PID is invalid.');
  }
  assertIsoTimestamp(document.recordedAt, 'Terminal marker recorded time');
  return document;
}

function readTerminalMarker(path, releaseStamp) {
  const metadata = lstatSync(resolve(path), { throwIfNoEntry: false });
  if (!metadata) return null;
  return assertTerminalMarker(
    readOwnerOnlyJson(path, 'Release terminal marker').document,
    releaseStamp,
  );
}

function writeTerminalMarker(path, releaseStamp, state, operation) {
  const resolvedPath = resolve(path);
  const candidatePath = `${resolvedPath}.next`;
  const candidate = lstatSync(candidatePath, { throwIfNoEntry: false });
  if (candidate) {
    const uid = process.getuid?.();
    if (
      !candidate.isFile() ||
      candidate.isSymbolicLink() ||
      candidate.nlink !== 1 ||
      (uid !== undefined && candidate.uid !== uid) ||
      (candidate.mode & 0o7777) !== 0o600
    ) {
      throw new Error('Terminal marker candidate is not safely owned.');
    }
    unlinkSync(candidatePath);
    fsyncDirectory(dirname(candidatePath));
  }
  const document = {
    schemaVersion: TERMINAL_MARKER_SCHEMA_VERSION,
    releaseStamp,
    state,
    operation,
    pid: process.pid,
    recordedAt: new Date().toISOString(),
  };
  writePrivateFile(candidatePath, `${JSON.stringify(document)}\n`);
  renameSync(candidatePath, resolvedPath);
  fsyncDirectory(dirname(resolvedPath));
  return document;
}

export async function withPromotionTerminalMarker(path, releaseStamp, operation) {
  const existing = readTerminalMarker(path, releaseStamp);
  if (
    existing?.state !== 'cutover-complete' &&
    !(existing?.state === 'in-progress' && existing.operation === 'promotion')
  ) {
    throw new Error('Promotion requires a cutover-complete terminal marker.');
  }
  writeTerminalMarker(path, releaseStamp, 'in-progress', 'promotion');
  try {
    const result = await operation();
    writeTerminalMarker(path, releaseStamp, 'promotion-complete', 'promotion');
    return result;
  } catch (error) {
    writeTerminalMarker(path, releaseStamp, 'cutover-complete', 'cutover-apply');
    throw error;
  }
}

export function assertDeviceLedgerConsistency(ledger, device) {
  assertEqual(
    ledger.gateResults?.['Physical iPhone standalone'],
    device.status,
    'Physical iPhone ledger and device evidence status',
  );
}

function assertDeployedTreeResult(result, context, description, stabilityField) {
  assertExactKeys(
    result,
    [
      'schemaVersion',
      'releaseStamp',
      'releaseRoot',
      'attestationPath',
      'attestationSha256',
      'treeSha256',
      'paths',
      ...(stabilityField ? [stabilityField] : []),
    ],
    description,
  );
  assertEqual(result.schemaVersion, 1, `${description} schema`);
  assertEqual(result.releaseStamp, context.releaseStamp, `${description} release stamp`);
  assertEqual(result.releaseRoot, resolve(context.releaseRoot), `${description} release root`);
  assertEqual(
    basename(result.attestationPath),
    `deployed-tree-${context.releaseStamp}.json`,
    `${description} attestation name`,
  );
  assertSha256(result.attestationSha256, `${description} attestation hash`);
  assertSha256(result.treeSha256, `${description} tree hash`);
  if (!Number.isSafeInteger(result.paths) || result.paths <= 0) {
    throw new Error(`${description} path count is invalid.`);
  }
  if (stabilityField) {
    assertEqual(result[stabilityField], true, `${description} stability`);
  }
  return result;
}

export function verifyPromotionDeployedTree({ contextPath, context }) {
  const attestationPath = resolve(
    dirname(resolve(contextPath)),
    `deployed-tree-${context.releaseStamp}.json`,
  );
  const result = verifyDeployedTreeAttestation({
    contextPath,
    root: context.releaseRoot,
    attestationPath,
  });
  assertDeployedTreeResult(result, context, 'Promotion deployed tree');
  assertEqual(result.attestationPath, attestationPath, 'Promotion deployed-tree attestation path');
  return result;
}

export function assertBackupOwnership(backup, home, releaseStamp) {
  const dataDirectory = resolve(home, '.journal');
  assertEqual(backup.source, resolve(dataDirectory, 'journal.db'), 'Backup source database');
  assertEqual(
    dirname(resolve(backup.backup?.path)),
    resolve(dataDirectory, 'backups'),
    'Backup directory',
  );
  const escapedStamp = releaseStamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (
    !new RegExp(`^journal-release-${escapedStamp}-[a-f0-9]{12}\\.db$`).test(
      basename(backup.backup?.path ?? ''),
    )
  ) {
    throw new Error('Backup filename is not a unique release backup.');
  }
}

function currentPointerTarget(currentLink) {
  const resolvedLink = resolve(currentLink);
  const metadata = lstatSync(resolvedLink, { throwIfNoEntry: false });
  if (!metadata) return null;
  if (!metadata.isSymbolicLink()) {
    throw new Error('current-release is not a symbolic link.');
  }
  return resolve(dirname(resolvedLink), readlinkSync(resolvedLink));
}

function assertPointerCompareAndSwap(currentLink, expectedCurrentRelease) {
  const actual = currentPointerTarget(currentLink);
  const expected =
    expectedCurrentRelease === null ? null : resolve(String(expectedCurrentRelease ?? ''));
  if (actual !== expected) {
    throw new Error('current-release changed before the promotion compare-and-swap.');
  }
}

function preparedEvidenceCandidatePath(preparedPath) {
  return `${resolve(preparedPath)}.next`;
}

function removeOwnedPreparedCandidate(path) {
  const resolvedPath = resolve(path);
  const metadata = lstatSync(resolvedPath, { throwIfNoEntry: false });
  if (!metadata) return false;
  const uid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o7777) !== 0o600
  ) {
    throw new Error('Prepared promotion candidate is not safely transaction-owned.');
  }
  unlinkSync(resolvedPath);
  return true;
}

function removeOwnedTemporaryPointer(path, target) {
  const resolvedPath = resolve(path);
  const metadata = lstatSync(resolvedPath, { throwIfNoEntry: false });
  if (!metadata) return false;
  if (
    !metadata.isSymbolicLink() ||
    resolve(dirname(resolvedPath), readlinkSync(resolvedPath)) !== resolve(target)
  ) {
    throw new Error('Prepared promotion pointer is not owned by this transaction.');
  }
  unlinkSync(resolvedPath);
  return true;
}

function assertPromotionTransactionDocument(document, options) {
  assertEqual(document.schemaVersion, 1, 'Promotion evidence schema');
  assertEqual(document.releaseStamp, options.releaseStamp, 'Promotion transaction release stamp');
  if (options.baseCommit !== undefined) {
    assertEqual(document.baseCommit, options.baseCommit, 'Promotion transaction base commit');
    assertEqual(
      document.manifestSha256,
      options.manifestSha256,
      'Promotion transaction manifest hash',
    );
    assertEqual(
      document.archiveSha256,
      options.archiveSha256,
      'Promotion transaction archive hash',
    );
  }
  assertEqual(
    document.currentRelease,
    resolve(options.releaseRoot),
    'Promotion transaction target release',
  );
  assertEqual(
    document.previousRelease,
    options.expectedCurrentRelease ?? '',
    'Promotion transaction previous release',
  );
  assertEqual(document.atomicPointerPromotion, true, 'Promotion transaction atomic-pointer claim');
  assertExactKeys(
    document.pointerTransaction,
    [
      'protocol',
      'expectedCurrentRelease',
      'targetCurrentRelease',
      'preparedEvidencePath',
      'preparedEvidenceCandidatePath',
    ],
    'Promotion pointer transaction',
  );
  assertEqual(
    document.pointerTransaction.protocol,
    PROMOTION_TRANSACTION_PROTOCOL,
    'Promotion transaction protocol',
  );
  assertEqual(
    document.pointerTransaction.expectedCurrentRelease,
    options.expectedCurrentRelease,
    'Promotion transaction expected pointer',
  );
  assertEqual(
    document.pointerTransaction.targetCurrentRelease,
    resolve(options.releaseRoot),
    'Promotion transaction target pointer',
  );
  assertEqual(
    document.pointerTransaction.preparedEvidencePath,
    resolve(options.preparedPath),
    'Promotion prepared-evidence path',
  );
  assertEqual(
    document.pointerTransaction.preparedEvidenceCandidatePath,
    preparedEvidenceCandidatePath(options.preparedPath),
    'Promotion prepared-evidence candidate path',
  );
  assertExactKeys(document.liveContextSource, ['path', 'sha256'], 'Promotion live-context source');
  assertEqual(
    document.liveContextSource.path,
    resolve(dirname(options.promotionPath), `live-context-${options.releaseStamp}.json`),
    'Promotion live-context source path',
  );
  assertSha256(document.liveContextSource.sha256, 'Promotion live-context source hash');
  const liveContext = readOwnerOnlyJson(document.liveContextSource.path, 'Live-context evidence');
  assertEqual(
    liveContext.source.sha256,
    document.liveContextSource.sha256,
    'Promotion live-context bound bytes',
  );
  assertEqual(
    document.promotionLogs?.policy,
    'strict-jsonl-allowlist',
    'Promotion final log policy',
  );
  assertEqual(
    document.promotionLogs?.validationPhase,
    PROMOTION_LOG_VALIDATION_PHASE,
    'Promotion final log validation phase',
  );
  assertEqual(
    document.promotionLogs?.contentBearingFieldsAccepted,
    false,
    'Promotion final content-bearing log fields',
  );
  assertEqual(
    document.promotionLogs?.secretPatternsFound,
    false,
    'Promotion final log secret scan',
  );
  assertEqual(
    document.promotionLogs?.journalContentRecorded,
    false,
    'Promotion final logged journal content',
  );
  assertDeployedTreeResult(document.deployedTree, options, 'Promotion deployed tree');
  assertEqual(
    document.deployedTree.attestationPath,
    resolve(dirname(options.promotionPath), `deployed-tree-${options.releaseStamp}.json`),
    'Promotion deployed-tree transaction path',
  );
  assertEqual(
    document.postLogRuntimeBinding?.protocol,
    'launchctl-ps-lsof-only-v1',
    'Promotion post-log runtime protocol',
  );
  assertEqual(
    document.postLogRuntimeBinding?.pid,
    document.liveRuntime?.pid,
    'Promotion post-log runtime PID',
  );
  assertEqual(
    document.postLogRuntimeBinding?.applicationHttpRequests,
    0,
    'Promotion post-log application HTTP requests',
  );
  assertEqual(
    document.postLogRuntimeBinding?.applicationLogWrites,
    0,
    'Promotion post-log application log writes',
  );
}

export function recoverPromotionTransaction({
  currentLink,
  releaseRoot,
  promotionPath,
  preparedPath,
  expectedCurrentRelease,
  context,
  phaseObserver,
}) {
  if (expectedCurrentRelease !== null && typeof expectedCurrentRelease !== 'string') {
    throw new Error('Promotion recovery requires an explicit expected current release or null.');
  }
  const options = {
    releaseStamp: context.releaseStamp,
    baseCommit: context.baseCommit,
    manifestSha256: context.manifestSha256,
    archiveSha256: context.archiveSha256,
    releaseRoot: resolve(releaseRoot),
    promotionPath: resolve(promotionPath),
    preparedPath: resolve(preparedPath),
    expectedCurrentRelease:
      expectedCurrentRelease === null ? null : resolve(expectedCurrentRelease),
  };
  const finalMetadata = lstatSync(options.promotionPath, { throwIfNoEntry: false });
  const preparedMetadata = lstatSync(options.preparedPath, { throwIfNoEntry: false });
  const preparedCandidate = preparedEvidenceCandidatePath(options.preparedPath);
  const temporaryLink = `${resolve(currentLink)}.next-${context.releaseStamp}`;
  if (finalMetadata && preparedMetadata) {
    throw new Error('Promotion has both final and prepared evidence; recovery is ambiguous.');
  }
  const target = options.releaseRoot;
  if (finalMetadata) {
    const { document } = readOwnerOnlyJson(options.promotionPath, 'Promotion evidence');
    assertPromotionTransactionDocument(document, options);
    if (currentPointerTarget(currentLink) !== target) {
      throw new Error('Final promotion evidence exists but current-release does not match it.');
    }
    fsyncDirectory(dirname(resolve(currentLink)));
    fsyncDirectory(dirname(options.promotionPath));
    return { state: 'committed', promotionPath: options.promotionPath, promotion: document };
  }
  if (!preparedMetadata) {
    const removedCandidate = removeOwnedPreparedCandidate(preparedCandidate);
    const removedPointer = removeOwnedTemporaryPointer(temporaryLink, options.releaseRoot);
    if (removedCandidate || removedPointer) {
      fsyncDirectory(dirname(options.preparedPath));
      fsyncDirectory(dirname(resolve(currentLink)));
      return { state: 'restart-required' };
    }
    return { state: 'absent' };
  }

  const { document } = readOwnerOnlyJson(options.preparedPath, 'Prepared promotion evidence');
  assertPromotionTransactionDocument(document, options);
  const pointer = currentPointerTarget(currentLink);
  if (pointer === target) {
    fsyncDirectory(dirname(resolve(currentLink)));
    phaseObserver?.('recovery-pointer-directory-synced');
    renameSync(options.preparedPath, options.promotionPath);
    phaseObserver?.('recovery-evidence-renamed');
    fsyncDirectory(dirname(options.promotionPath));
    return { state: 'recovered', promotionPath: options.promotionPath, promotion: document };
  }
  const expected = options.expectedCurrentRelease;
  if (pointer !== expected) {
    throw new Error('Prepared promotion evidence conflicts with the current-release pointer.');
  }
  removeOwnedPreparedCandidate(preparedCandidate);
  removeOwnedTemporaryPointer(temporaryLink, target);
  unlinkSync(options.preparedPath);
  fsyncDirectory(dirname(options.preparedPath));
  fsyncDirectory(dirname(resolve(currentLink)));
  return { state: 'restart-required' };
}

export function commitPromotionPointer({
  currentLink,
  releaseRoot,
  promotionPath,
  preparedPath,
  expectedCurrentRelease,
  promotion,
  context = promotion,
  beforePointerRename,
  phaseObserver,
}) {
  if (expectedCurrentRelease !== null && typeof expectedCurrentRelease !== 'string') {
    throw new Error('Promotion commit requires an explicit expected current release or null.');
  }
  const resolvedCurrentLink = resolve(currentLink);
  const resolvedPromotionPath = resolve(promotionPath);
  const resolvedPreparedPath = resolve(preparedPath);
  const target = resolve(releaseRoot);
  const expected = expectedCurrentRelease === null ? null : resolve(expectedCurrentRelease);
  const temporaryLink = `${resolvedCurrentLink}.next-${promotion.releaseStamp}`;
  const preparedCandidate = preparedEvidenceCandidatePath(resolvedPreparedPath);
  const transactionOptions = {
    releaseStamp: context.releaseStamp,
    baseCommit: context.baseCommit,
    manifestSha256: context.manifestSha256,
    archiveSha256: context.archiveSha256,
    releaseRoot: target,
    promotionPath: resolvedPromotionPath,
    preparedPath: resolvedPreparedPath,
    expectedCurrentRelease: expected,
  };
  const recovery = recoverPromotionTransaction({
    currentLink: resolvedCurrentLink,
    releaseRoot: target,
    promotionPath: resolvedPromotionPath,
    preparedPath: resolvedPreparedPath,
    expectedCurrentRelease: expected,
    context,
    phaseObserver,
  });
  if (recovery.state === 'committed' || recovery.state === 'recovered') return recovery;
  assertPromotionTransactionDocument(promotion, transactionOptions);
  if (lstatSync(temporaryLink, { throwIfNoEntry: false })) {
    throw new Error(`Temporary promotion link already exists: ${temporaryLink}`);
  }

  let temporaryLinkOwned = false;
  let preparedCandidateOwned = false;
  let preparedOwned = false;
  let pointerRenamed = false;
  let evidenceRenamed = false;
  try {
    writePrivateFile(preparedCandidate, `${JSON.stringify(promotion, null, 2)}\n`);
    preparedCandidateOwned = true;
    phaseObserver?.('prepared-candidate-written');
    renameSync(preparedCandidate, resolvedPreparedPath);
    preparedCandidateOwned = false;
    preparedOwned = true;
    phaseObserver?.('prepared-evidence-renamed');
    fsyncDirectory(dirname(resolvedPreparedPath));
    phaseObserver?.('prepared-evidence-directory-synced');

    symlinkSync(target, temporaryLink, 'dir');
    temporaryLinkOwned = true;
    assertEqual(
      resolve(dirname(temporaryLink), readlinkSync(temporaryLink)),
      target,
      'Prepared promotion pointer',
    );
    phaseObserver?.('prepared-pointer-created');
    phaseObserver?.('prepared');

    beforePointerRename?.();
    assertPromotionTransactionDocument(promotion, transactionOptions);
    assertPointerCompareAndSwap(resolvedCurrentLink, expected);
    renameSync(temporaryLink, resolvedCurrentLink);
    temporaryLinkOwned = false;
    pointerRenamed = true;
    phaseObserver?.('pointer-renamed');
    fsyncDirectory(dirname(resolvedCurrentLink));
    phaseObserver?.('pointer-directory-synced');

    renameSync(resolvedPreparedPath, resolvedPromotionPath);
    preparedOwned = false;
    evidenceRenamed = true;
    phaseObserver?.('evidence-renamed');
    fsyncDirectory(dirname(resolvedPromotionPath));
    phaseObserver?.('evidence-directory-synced');
    return { state: 'committed', promotionPath: resolvedPromotionPath, promotion };
  } catch (error) {
    if (!pointerRenamed) {
      if (temporaryLinkOwned) rmSync(temporaryLink, { force: true });
      if (preparedCandidateOwned) rmSync(preparedCandidate, { force: true });
      if (preparedOwned) rmSync(resolvedPreparedPath, { force: true });
      fsyncDirectory(dirname(resolvedPreparedPath));
      fsyncDirectory(dirname(resolvedCurrentLink));
    } else if (!evidenceRenamed && !lstatSync(resolvedPreparedPath, { throwIfNoEntry: false })) {
      throw new AggregateError(
        [error],
        'Promotion pointer changed but recoverable prepared evidence is missing.',
        { cause: error },
      );
    }
    throw error;
  }
}

export function verifyLiveServeSnapshot({ attestedPath, serveStatusRunner }) {
  const attested = readJson(attestedPath);
  const runner =
    serveStatusRunner ??
    (() =>
      execFileSync('tailscale', ['serve', 'status', '--json'], {
        encoding: 'utf8',
        timeout: 5_000,
      }));
  const runnerOutput = runner();
  const live = typeof runnerOutput === 'string' ? JSON.parse(runnerOutput) : runnerOutput;
  const comparison = verifyServeChange(attested, live, 'upgrade');
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    attestedPath: resolve(attestedPath),
    comparison,
    snapshot: live,
  };
}

export function verifyAttestedServeEvidence({ beforePath, afterPath, mode, summary }) {
  for (const [name, path] of [
    ['before', beforePath],
    ['after', afterPath],
  ]) {
    const metadata = lstatSync(resolve(path));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Attested Serve ${name} snapshot is not a regular file.`);
    }
    assertEqual(metadata.mode & 0o7777, 0o600, `Attested Serve ${name} permissions`);
  }
  const comparison = verifyServeChange(readJson(beforePath), readJson(afterPath), mode);
  if (JSON.stringify(normalizedJson(comparison)) !== JSON.stringify(normalizedJson(summary))) {
    throw new Error('Cutover Serve summary contradicts the raw before/after snapshots.');
  }
  return comparison;
}

export async function withFinalPromotionValidation(
  {
    context,
    manifest,
    home,
    cutover,
    lifecycle,
    liveContext,
    serveAfterPath,
    serveStatusRunner,
    now,
    maximumLiveContextAgeMs,
    commit,
  },
  dependencies = {},
) {
  if (typeof commit !== 'function') {
    throw new Error('Final promotion validation requires a commit callback.');
  }
  const verifyTailnet = dependencies.verifyApplicationOrigin ?? verifyApplicationOrigin;
  const verifyLocalRuntime = dependencies.verifyRuntime ?? verifyRuntime;
  const verifyServe = dependencies.verifyLiveServeSnapshot ?? verifyLiveServeSnapshot;
  const inspectLogs = dependencies.inspectOperationalLogs ?? inspectOperationalLogs;
  const recheckBinding = dependencies.recheckRuntimeBinding ?? recheckRuntimeBinding;

  const liveTailnet = await verifyTailnet({
    origin: JOURNAL_ORIGIN,
    manifestPath: context.manifest,
  });
  assertApplicationEvidence(liveTailnet, manifest, 'Promotion Tailnet HTTPS', JOURNAL_ORIGIN);

  // Keep the full local runtime verifier as the final HTTP-producing probe. Its
  // own last checks are PID-scoped launchctl/ps/lsof inspection.
  const liveRuntime = await verifyLocalRuntime({
    releaseRoot: context.releaseRoot,
    manifestPath: context.manifest,
    nodePath: manifest.toolchain.nodePath,
    home,
  });
  assertRuntimeEvidence(liveRuntime, context, manifest, 'Promotion runtime');
  assertEqual(
    liveRuntime.pid,
    liveContext.service?.pid,
    'Promotion runtime and post-lifecycle live-context PID',
  );

  const liveServe = verifyServe({
    attestedPath: serveAfterPath,
    serveStatusRunner,
  });
  const promotionTime = now();
  const liveContextFreshness = assertLiveContextFreshness({
    liveContext,
    cutover,
    lifecycle,
    now: promotionTime,
    maximumAgeMs: maximumLiveContextAgeMs,
  });

  // This must remain the last validation capable of observing application log
  // bytes. Nothing after it may issue an application HTTP or MCP request before
  // the prepared evidence and pointer transaction commits.
  const logDirectory = resolve(home, '.journal', 'logs');
  const promotionLogs = {
    ...inspectLogs({
      stdoutPath: resolve(logDirectory, 'launchd.out.log'),
      stderrPath: resolve(logDirectory, 'launchd.err.log'),
      logDirectory,
    }),
    validationPhase: PROMOTION_LOG_VALIDATION_PHASE,
  };
  assertLogEvidence(promotionLogs, home, PROMOTION_LOG_VALIDATION_PHASE);
  const postLogRuntimeBinding = await recheckBinding({
    releaseRoot: context.releaseRoot,
    manifestPath: context.manifest,
    priorRuntime: liveRuntime,
    nodePath: manifest.toolchain.nodePath,
    home,
  });

  return commit({
    liveRuntime,
    liveTailnet,
    liveServe,
    promotionTime,
    liveContextFreshness,
    promotionLogs,
    postLogRuntimeBinding,
  });
}

export async function promoteRelease(options) {
  const home = options.home ?? homedir();
  return withGlobalReleaseLock(
    resolve(home, '.journal', 'release-global.lock'),
    'promotion',
    () => promoteReleaseLocked({ ...options, home }),
    options.globalLockDependencies,
  );
}

async function promoteReleaseLocked({
  contextPath,
  ledgerPath,
  deviceEvidencePath,
  home = homedir(),
  serveStatusRunner,
  now = () => new Date(),
  maximumLiveContextAgeMs = MAX_LIVE_CONTEXT_AGE_MS,
}) {
  const context = readJson(contextPath);
  const effectiveLedgerPath = resolve(ledgerPath ?? context.ledger);
  assertEqual(effectiveLedgerPath, resolve(context.ledger), 'Release-specific ledger path');
  const manifest = readManifest(context.manifest);
  assertEqual(
    resolve(fileURLToPath(import.meta.url)),
    resolve(context.releaseRoot, 'scripts/release-promote.mjs'),
    'Attested promotion helper path',
  );
  assertEqual(process.version, manifest.toolchain.node, 'Promotion Node version');
  assertEqual(process.execPath, manifest.toolchain.nodePath, 'Promotion Node path');
  const attestation = readJson(context.attestation);
  const evidenceRoot = dirname(resolve(contextPath));
  assertEqual(
    resolve(deviceEvidencePath),
    resolve(evidenceRoot, `device-${context.releaseStamp}.json`),
    'Release-specific device evidence path',
  );
  const currentLink = resolve(home, '.journal/current-release');
  const promotionPath = resolve(evidenceRoot, `promotion-${context.releaseStamp}.json`);
  const preparedPromotionPath = resolve(
    evidenceRoot,
    `promotion-prepared-${context.releaseStamp}.json`,
  );
  const rollbackPath = resolve(evidenceRoot, `rollback-${context.releaseStamp}.json`);
  const rollbackSnapshotPath = resolve(
    evidenceRoot,
    `serve-rollback-after-${context.releaseStamp}.json`,
  );
  const terminalLockPath = resolve(evidenceRoot, `terminal-${context.releaseStamp}.lock`);
  const expectedCurrentRelease =
    context.mode === 'first-install' ? null : resolve(context.previousRelease);

  if (
    lstatSync(rollbackPath, { throwIfNoEntry: false }) ||
    lstatSync(rollbackSnapshotPath, { throwIfNoEntry: false })
  ) {
    throw new Error('A rolled-back release context is terminal and cannot be promoted.');
  }
  const recovered = recoverPromotionTransaction({
    currentLink,
    releaseRoot: context.releaseRoot,
    promotionPath,
    preparedPath: preparedPromotionPath,
    expectedCurrentRelease,
    context,
  });
  if (recovered.state === 'committed' || recovered.state === 'recovered') {
    const marker = readTerminalMarker(terminalLockPath, context.releaseStamp);
    if (
      marker?.state !== 'promotion-complete' &&
      marker?.state !== 'cutover-complete' &&
      !(marker?.state === 'in-progress' && marker.operation === 'promotion')
    ) {
      throw new Error('Committed promotion contradicts its terminal marker.');
    }
    writeTerminalMarker(terminalLockPath, context.releaseStamp, 'promotion-complete', 'promotion');
    return recovered;
  }

  return withPromotionTerminalMarker(terminalLockPath, context.releaseStamp, async () => {
    const cutover = readJson(resolve(evidenceRoot, `cutover-${context.releaseStamp}.json`));
    const backup = readJson(resolve(evidenceRoot, `backup-${context.releaseStamp}.json`));
    const lifecycle = readJson(resolve(evidenceRoot, `lifecycle-${context.releaseStamp}.json`));
    const device = readJson(deviceEvidencePath);
    const benchmark = readJson(context.benchmark);
    const serveBeforePath = resolve(evidenceRoot, `serve-before-${context.releaseStamp}.json`);
    const serveAfterPath = resolve(evidenceRoot, `serve-after-${context.releaseStamp}.json`);
    if (
      lstatSync(rollbackPath, { throwIfNoEntry: false }) ||
      lstatSync(rollbackSnapshotPath, { throwIfNoEntry: false })
    ) {
      throw new Error('A rolled-back release context is terminal and cannot be promoted.');
    }

    assertEqual(manifest.git.baseCommit, context.baseCommit, 'Manifest base commit');
    assertEqual(attestation.releaseStamp, context.releaseStamp, 'Attestation release stamp');
    assertEqual(attestation.baseCommit, context.baseCommit, 'Attestation base commit');
    assertEqual(attestation.manifest.sha256, context.manifestSha256, 'Attested manifest hash');
    assertEqual(attestation.archive.sha256, context.archiveSha256, 'Attested archive hash');
    assertEqual(attestation.extractedTreeVerified, true, 'Extracted-tree verification');
    assertEqual(sha256File(context.manifest), context.manifestSha256, 'Current manifest hash');
    assertEqual(sha256File(context.archive), context.archiveSha256, 'Current archive hash');
    assertEqual(lstatSync(context.manifest).mode & 0o7777, 0o600, 'Manifest permissions');
    assertEqual(lstatSync(context.archive).mode & 0o7777, 0o600, 'Archive permissions');
    assertEqual(lstatSync(context.attestation).mode & 0o7777, 0o600, 'Attestation permissions');
    assertEqual(sha256File(context.benchmark), context.benchmarkSha256, 'Benchmark hash');
    assertEqual(lstatSync(context.benchmark).mode & 0o7777, 0o600, 'Benchmark permissions');
    assertEqual(benchmark.status, 'pass', 'Release benchmark status');
    assertEqual(benchmark.source?.baseCommit, context.baseCommit, 'Benchmark base commit');
    assertEqual(benchmark.target?.isolated, true, 'Benchmark isolation');
    assertEqual(benchmark.target?.productionBundleVerified, true, 'Benchmark production bundle');
    for (const metric of ['browserOptimisticVisible', 'ownerCaptureCommitted', 'mcpRead']) {
      assertEqual(benchmark.metrics?.[metric]?.pass, true, `Benchmark ${metric}`);
    }
    verifyManifest(manifest, context.releaseRoot, {
      allowExtra: ['node_modules'],
      ignoreMode: true,
    });
    const immutablePaths = assertImmutableTree(resolve(context.releaseRoot));
    const deployedTree = verifyPromotionDeployedTree({ contextPath, context });
    const { evidence: liveContext, source: liveContextSource } = validateLiveContextEvidence({
      contextPath,
      context,
      manifest,
      home,
      deployedTree,
    });

    assertEqual(lstatSync(effectiveLedgerPath).mode & 0o7777, 0o600, 'Ledger permissions');
    const ledgerBody = readFileSync(effectiveLedgerPath, 'utf8');
    const ledgerSha256 = createHash('sha256').update(ledgerBody).digest('hex');
    const ledger = evaluateLedger(ledgerBody);
    if (!ledger.passed) {
      const failures = ledger.failures.map(({ gate, result }) => `${gate}=${result}`).join(', ');
      throw new Error(`Verification ledger is not releasable: ${failures}`);
    }

    assertContextEvidence(cutover, context, 'Cutover');
    assertEqual(cutover.schemaVersion, 1, 'Cutover evidence schema');
    assertEqual(
      lstatSync(resolve(evidenceRoot, `cutover-${context.releaseStamp}.json`)).mode & 0o7777,
      0o600,
      'Cutover evidence permissions',
    );
    assertEqual(cutover.mode, context.mode, 'Cutover mode');
    assertEqual(cutover.currentReleaseUnchanged, true, 'Cutover pointer guard');
    assertRuntimeEvidence(cutover.runtime, context, manifest, 'Cutover runtime');
    const attestedServe = verifyAttestedServeEvidence({
      beforePath: serveBeforePath,
      afterPath: serveAfterPath,
      mode: context.mode,
      summary: cutover.tailscale,
    });
    assertEqual(
      cutover.tailscale?.required443?.host,
      'mickey-home.tail8a9beb.ts.net:443',
      'Tailscale :443 host',
    );
    assertEqual(
      cutover.tailscale?.required443?.proxy,
      'http://127.0.0.1:5050',
      'Tailscale :443 proxy',
    );
    assertEqual(cutover.tailscale?.required443?.unchanged, true, 'Tailscale :443 preservation');
    assertEqual(
      cutover.tailscale?.normalized?.entireConfigurationCompared,
      true,
      'Full Serve comparison',
    );
    assertEqual(
      cutover.tailscale?.normalized?.zeroCollateralChange,
      true,
      'Serve collateral-change check',
    );
    assertEqual(
      cutover.tailscale?.handler5178?.host,
      'mickey-home.tail8a9beb.ts.net:5178',
      'Tailscale :5178 host',
    );
    assertEqual(
      cutover.tailscale?.handler5178?.proxy,
      'http://127.0.0.1:5178',
      'Tailscale :5178 proxy',
    );
    assertApplicationEvidence(
      cutover.tailnet,
      manifest,
      'Cutover Tailnet HTTPS',
      'https://mickey-home.tail8a9beb.ts.net:5178',
    );

    assertContextEvidence(backup, context, 'Backup');
    assertEqual(backup.schemaVersion, 1, 'Backup evidence schema');
    assertBackupOwnership(backup, home, context.releaseStamp);
    assertEqual(
      lstatSync(resolve(evidenceRoot, `backup-${context.releaseStamp}.json`)).mode & 0o7777,
      0o600,
      'Backup evidence permissions',
    );
    assertEqual(backup.backup?.unique, true, 'Backup uniqueness');
    assertEqual(backup.backup?.mode, 0o600, 'Backup permissions');
    assertEqual(lstatSync(backup.backup.path).mode & 0o7777, 0o600, 'Current backup permissions');
    assertEqual(backup.restore?.quickCheck, 'ok', 'Backup restore quick_check');
    assertEqual(backup.restore?.temporaryCopyRemoved, true, 'Temporary restore cleanup');
    assertEqual(
      backup.restore?.stagedCli?.node,
      resolve(manifest.toolchain.nodePath),
      'Backup staged Node',
    );
    assertEqual(
      backup.restore?.stagedCli?.cli,
      resolve(context.releaseRoot, 'server/dist/cli.js'),
      'Backup staged CLI',
    );
    assertEqual(backup.restore?.stagedCli?.check, 'ok', 'Backup staged CLI check');
    assertEqual(backup.restore?.stagedCli?.exportSchemaValidated, true, 'Backup staged export');
    assertEqual(sha256File(backup.backup.path), backup.backup.sha256, 'Backup hash');

    assertEqual(
      lstatSync(resolve(evidenceRoot, `lifecycle-${context.releaseStamp}.json`)).mode & 0o7777,
      0o600,
      'Lifecycle evidence permissions',
    );
    assertLifecycleEvidence(lifecycle, context, manifest, deployedTree);

    assertContextEvidence(device, context, 'Device evidence');
    assertEqual(device.schemaVersion, 2, 'Device evidence schema');
    assertEqual(lstatSync(deviceEvidencePath).mode & 0o7777, 0o600, 'Device evidence permissions');
    if (device.status !== 'PASS' && device.status !== 'DEVICE HANDOFF') {
      throw new Error('Physical-device evidence is neither PASS nor DEVICE HANDOFF.');
    }
    for (const [name, field] of Object.entries({
      checklistReference: device.checklistReference,
      notes: device.notes,
      ...(device.status === 'PASS'
        ? {
            model: device.device?.model,
            iosVersion: device.device?.iosVersion,
            tailnetAccount: device.device?.tailnetAccount,
          }
        : { assignee: device.handoff?.assignee }),
    })) {
      if (typeof field !== 'string' || field.trim() === '')
        throw new Error(`Device ${name} is empty.`);
    }
    assertDeviceLedgerConsistency(ledger, device);

    assertCurrentPointer(context, currentLink);
    return withFinalPromotionValidation({
      context,
      manifest,
      home,
      cutover,
      lifecycle,
      liveContext,
      serveAfterPath,
      serveStatusRunner,
      now,
      maximumLiveContextAgeMs,
      commit: ({
        liveRuntime,
        liveTailnet,
        liveServe,
        promotionTime,
        liveContextFreshness,
        promotionLogs,
        postLogRuntimeBinding,
      }) => {
        const promotion = {
          schemaVersion: 1,
          releaseStamp: context.releaseStamp,
          recordedAt: promotionTime.toISOString(),
          baseCommit: context.baseCommit,
          manifestSha256: context.manifestSha256,
          archiveSha256: context.archiveSha256,
          benchmarkSha256: context.benchmarkSha256,
          ledger,
          ledgerSource: {
            path: effectiveLedgerPath,
            sha256: ledgerSha256,
            body: ledgerBody,
          },
          liveContextSource,
          liveContextFreshness,
          deployedTree,
          promotionLogs,
          postLogRuntimeBinding,
          immutablePaths,
          liveRuntime,
          liveTailnet,
          attestedServe,
          liveServe,
          previousRelease: expectedCurrentRelease ?? '',
          currentRelease: resolve(context.releaseRoot),
          atomicPointerPromotion: true,
          pointerTransaction: {
            protocol: PROMOTION_TRANSACTION_PROTOCOL,
            expectedCurrentRelease,
            targetCurrentRelease: resolve(context.releaseRoot),
            preparedEvidencePath: preparedPromotionPath,
            preparedEvidenceCandidatePath: preparedEvidenceCandidatePath(preparedPromotionPath),
          },
        };
        return commitPromotionPointer({
          currentLink,
          releaseRoot: context.releaseRoot,
          promotionPath,
          preparedPath: preparedPromotionPath,
          expectedCurrentRelease,
          promotion,
          context,
          beforePointerRename: () => {
            if (
              lstatSync(rollbackPath, { throwIfNoEntry: false }) ||
              lstatSync(rollbackSnapshotPath, { throwIfNoEntry: false })
            ) {
              throw new Error('Rollback evidence appeared before the promotion commit.');
            }
            const currentLiveContextSource = readOwnerOnlyJson(
              liveContextSource.path,
              'Live-context evidence at commit',
            ).source;
            assertEqual(
              currentLiveContextSource.sha256,
              liveContextSource.sha256,
              'Live-context bytes at promotion commit',
            );
            assertCurrentPointer(context, currentLink);
          },
        });
      },
    });
  });
}

async function runCli() {
  const args = process.argv.slice(2);
  const contextPath = value(args, '--context');
  const deviceEvidencePath = value(args, '--device');
  if (!contextPath || !deviceEvidencePath) {
    throw new Error('Usage: release-promote.mjs --context <json> --device <json> [--ledger <md>]');
  }
  const result = await promoteRelease({
    contextPath,
    deviceEvidencePath,
    ledgerPath: value(args, '--ledger'),
  });
  process.stdout.write(`${JSON.stringify({ path: result.promotionPath })}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
