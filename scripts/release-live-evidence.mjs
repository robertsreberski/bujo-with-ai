#!/usr/bin/env node
/* global AbortController, Buffer, URL, fetch, process */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { writeOwnerPrivateAtomic } from './release-atomic-file.mjs';
import { verifyDeployedTreeAttestation } from './release-deployed-tree.mjs';
import { readManifest, sha256File } from './release-manifest.mjs';
import {
  assertExactProcessEnvironment,
  cwdIdentityFromLsof,
  launchAgentProgramArguments,
  launchdWorkingDirectory,
  processEnvironmentFromPs,
} from './release-verify-runtime.mjs';

const execFileAsync = promisify(execFile);
const LABEL = 'com.rsreberski.journald';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const EXPECTED_TOOLS = [
  'add_entry',
  'add_to_collection',
  'list_day',
  'search',
  'update_entry',
  'delete_entry',
  'propose_migration',
];
const PLIST_KEYS = [
  'EnvironmentVariables',
  'KeepAlive',
  'Label',
  'ProcessType',
  'ProgramArguments',
  'RunAtLoad',
  'StandardErrorPath',
  'StandardOutPath',
  'WorkingDirectory',
];
const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
const STAMP_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}-[0-9]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ROTATED_LOG_PATTERN = /^[0-9]{8}-[0-9]{4}-[0-9]{2}-journald\.log\.gz$/;
const LOG_SECRET_PATTERN =
  /(?:authorization|bearer\s+|set-cookie|cookie|jrn_[A-Za-z0-9_-]{8,}|api[-_]?key|client[-_]?secret)/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function value(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value.`);
  return args[index + 1];
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function stableJson(valueToNormalize) {
  const normalize = (current) => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current !== null && typeof current === 'object') {
      return Object.fromEntries(
        Object.keys(current)
          .sort()
          .map((key) => [key, normalize(current[key])]),
      );
    }
    return current;
  };
  return JSON.stringify(normalize(valueToNormalize));
}

function assertEqual(actual, expected, description) {
  if (actual !== expected) {
    throw new Error(`${description} does not match the release context.`);
  }
}

function assertPrivateFile(path, description) {
  const resolved = resolve(path);
  const metadata = lstatSync(resolved);
  const uid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o7777) !== 0o600
  ) {
    throw new Error(`${description} must be an owner-only regular file.`);
  }
  return resolved;
}

function assertImmutableReleaseDirectory(path, expectedPath) {
  if (path !== expectedPath) {
    throw new Error('Release root is not the versioned directory owned by this context.');
  }
  const metadata = lstatSync(path);
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o0222) !== 0 ||
    (metadata.mode & 0o0077) !== 0 ||
    realpathSync(path) !== path
  ) {
    throw new Error('Release root must be an immutable owner-only canonical directory.');
  }
}

function assertObservedDirectory(observed, expectedPath, description) {
  const observedReal = realpathSync(observed.path);
  const expectedReal = realpathSync(expectedPath);
  const expected = statSync(expectedReal, { bigint: true });
  if (
    observedReal !== expectedReal ||
    observed.device !== expected.dev.toString() ||
    observed.inode !== expected.ino.toString()
  ) {
    throw new Error(`${description} does not identify the attested release directory.`);
  }
  return { device: observed.device, inode: observed.inode };
}

function assertContextIdentity(document, context, description) {
  assertEqual(document.releaseStamp, context.releaseStamp, `${description} release stamp`);
  assertEqual(document.baseCommit, context.baseCommit, `${description} base commit`);
  assertEqual(document.manifestSha256, context.manifestSha256, `${description} manifest hash`);
  assertEqual(document.archiveSha256, context.archiveSha256, `${description} archive hash`);
}

export function loadReleaseBinding({ contextPath, outputPath, selfPath, home = homedir() }) {
  const resolvedContext = assertPrivateFile(contextPath, 'Release context');
  const context = readJson(resolvedContext);
  if (context.schemaVersion !== 1 || !STAMP_PATTERN.test(context.releaseStamp ?? '')) {
    throw new Error('Release context schema or stamp is invalid.');
  }
  const manifestPath = assertPrivateFile(context.manifest, 'Release manifest');
  const archivePath = assertPrivateFile(context.archive, 'Release archive');
  const attestationPath = assertPrivateFile(context.attestation, 'Release attestation');
  const manifest = readManifest(manifestPath);
  const attestation = readJson(attestationPath);
  assertEqual(sha256File(manifestPath), context.manifestSha256, 'Manifest hash');
  assertEqual(sha256File(archivePath), context.archiveSha256, 'Archive hash');
  assertEqual(manifest.git.baseCommit, context.baseCommit, 'Manifest base commit');
  assertEqual(attestation.releaseStamp, context.releaseStamp, 'Attestation release stamp');
  assertEqual(attestation.baseCommit, context.baseCommit, 'Attestation base commit');
  assertEqual(attestation.releaseVersion, manifest.release.version, 'Attestation release version');
  assertEqual(attestation.treeSha256, manifest.treeSha256, 'Attestation tree hash');
  assertEqual(attestation.manifest?.sha256, context.manifestSha256, 'Attestation manifest hash');
  assertEqual(attestation.archive?.sha256, context.archiveSha256, 'Attestation archive hash');
  assertEqual(attestation.extractedTreeVerified, true, 'Extracted-tree verification');

  if (
    typeof context.releaseRoot !== 'string' ||
    context.releaseRoot !== resolve(context.releaseRoot)
  ) {
    throw new Error('Release root must use its canonical absolute spelling.');
  }
  const releaseRoot = context.releaseRoot;
  assertImmutableReleaseDirectory(
    releaseRoot,
    resolve(home, '.journal', 'releases', context.releaseStamp),
  );
  const expectedSelf = resolve(releaseRoot, 'scripts/release-live-evidence.mjs');
  assertEqual(resolve(selfPath), expectedSelf, 'Staged live-evidence helper path');
  const scriptRecord = manifest.files.find(
    (record) => record.path === 'scripts/release-live-evidence.mjs' && record.kind === 'file',
  );
  if (!scriptRecord || sha256File(expectedSelf) !== scriptRecord.sha256) {
    throw new Error('Staged live-evidence helper is absent from or differs from the manifest.');
  }
  assertEqual(process.version, manifest.toolchain.node, 'Attested Node version');
  assertEqual(process.execPath, manifest.toolchain.nodePath, 'Attested Node path');

  const evidenceRoot = dirname(resolvedContext);
  const deployedTree = verifyDeployedTreeAttestation({
    contextPath: resolvedContext,
    root: releaseRoot,
    attestationPath: resolve(evidenceRoot, `deployed-tree-${context.releaseStamp}.json`),
  });
  const cutoverPath = assertPrivateFile(
    resolve(evidenceRoot, `cutover-${context.releaseStamp}.json`),
    'Cutover evidence',
  );
  const cutover = readJson(cutoverPath);
  assertEqual(cutover.schemaVersion, 1, 'Cutover evidence schema');
  assertContextIdentity(cutover, context, 'Cutover evidence');
  assertEqual(cutover.currentReleaseUnchanged, true, 'Cutover pointer state');
  assertEqual(resolve(cutover.runtime?.releaseRoot ?? ''), releaseRoot, 'Cutover release root');
  if (existsSync(resolve(evidenceRoot, `rollback-${context.releaseStamp}.json`))) {
    throw new Error('Live evidence refuses a release context that has rollback evidence.');
  }

  const resolvedOutput = resolve(outputPath);
  assertEqual(
    resolvedOutput,
    resolve(evidenceRoot, `live-context-${context.releaseStamp}.json`),
    'Live evidence output path',
  );
  if (existsSync(resolvedOutput)) throw new Error('Live evidence already exists for this context.');

  return {
    releaseStamp: context.releaseStamp,
    baseCommit: context.baseCommit,
    manifestSha256: context.manifestSha256,
    archiveSha256: context.archiveSha256,
    releaseRoot,
    manifest,
    outputPath: resolvedOutput,
    contextPath: resolvedContext,
    deployedTree,
  };
}

export async function defaultCommandRunner(commandPath, args, options = {}) {
  const result = await execFileAsync(commandPath, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    signal: options.signal,
  });
  return { stdout: result.stdout };
}

async function withDeadline(label, timeoutMs, operation, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${label} timeout must be a positive finite number.`);
  }
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} exceeded ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runCommand(runner, commandPath, args, timeoutMs, description) {
  const controller = new AbortController();
  try {
    const result = await withDeadline(
      description,
      timeoutMs,
      () => runner(commandPath, args, { timeoutMs, signal: controller.signal }),
      () => controller.abort(),
    );
    if (typeof result === 'string') return result;
    if (!result || typeof result.stdout !== 'string') {
      throw new Error(`${description} returned no text output.`);
    }
    return result.stdout;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${description} exceeded`)) throw error;
    throw new Error(`${description} failed.`, { cause: error });
  } finally {
    controller.abort();
  }
}

export function parseLaunchdPid(output) {
  const values = [...output.matchAll(/^\s*pid = ([0-9]+)\s*$/gm)].map((match) => Number(match[1]));
  if (values.length !== 1 || !Number.isSafeInteger(values[0]) || values[0] <= 0) {
    throw new Error('launchd did not report exactly one live journald PID.');
  }
  return values[0];
}

export function parseProcessTable(output) {
  return output
    .split(/\r?\n/)
    .map((line) => /^\s*([0-9]+)\s+([0-9]+)\s+(.+?)\s*$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] }));
}

function descendantsOf(processes, parentPid) {
  const descendants = [];
  const queue = [parentPid];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const processRow of processes) {
      if (processRow.parentPid === current && !descendants.includes(processRow.pid)) {
        descendants.push(processRow.pid);
        queue.push(processRow.pid);
      }
    }
  }
  return descendants;
}

export function journalLaunchdLabels(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).at(-1) ?? '')
    .filter((label) => label !== 'Label' && /(?:journal|bujo)/i.test(label));
}

function parseEndpoint(valueToParse) {
  const bracketed = /^\[([^\]]+)\]:(\*|[0-9]+)$/.exec(valueToParse);
  if (bracketed) return { address: bracketed[1], port: bracketed[2] };
  const split = valueToParse.lastIndexOf(':');
  if (split <= 0) throw new Error('lsof returned an unparseable TCP endpoint.');
  return { address: valueToParse.slice(0, split), port: valueToParse.slice(split + 1) };
}

function isLoopback(address) {
  return address === '::1' || address === 'localhost' || /^127(?:\.[0-9]{1,3}){3}$/.test(address);
}

export function parseTcpSockets(output, expectedPid, servicePort) {
  const sockets = [];
  let pid;
  let current;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n')) {
      const [localText, remoteText] = line.slice(1).split('->');
      if (!localText || !Number.isSafeInteger(pid)) {
        throw new Error('lsof TCP ownership output is incomplete.');
      }
      current = {
        pid,
        local: parseEndpoint(localText),
        ...(remoteText === undefined ? {} : { remote: parseEndpoint(remoteText) }),
        state: 'UNKNOWN',
      };
      sockets.push(current);
    } else if (line.startsWith('TST=') && current) {
      current.state = line.slice(4);
    }
  }
  if (sockets.length === 0 || sockets.some((socket) => socket.pid !== expectedPid)) {
    throw new Error('lsof did not return TCP metadata owned only by the journald PID.');
  }
  const listener = sockets.filter(
    (socket) =>
      socket.remote === undefined &&
      socket.state === 'LISTEN' &&
      socket.local.address === '127.0.0.1' &&
      socket.local.port === String(servicePort),
  );
  if (listener.length !== 1)
    throw new Error('journald does not own exactly one loopback listener.');
  if (
    sockets.some(
      (socket) =>
        !isLoopback(socket.local.address) ||
        (socket.remote !== undefined && !isLoopback(socket.remote.address)),
    )
  ) {
    throw new Error('journald has an unexpected non-loopback TCP socket.');
  }
  return sockets.map((socket) => ({
    state: socket.state,
    direction:
      socket.remote === undefined
        ? 'listener'
        : socket.local.port === String(servicePort)
          ? 'inbound'
          : 'outbound',
    local: socket.local,
    ...(socket.remote === undefined ? {} : { remote: socket.remote }),
  }));
}

function readOwnedLog(path, { allowAbsent = false, maximumBytes = 12 * 1024 * 1024 } = {}) {
  const resolved = resolve(path);
  let metadata;
  try {
    metadata = lstatSync(resolved);
  } catch (error) {
    if (allowAbsent && error && typeof error === 'object' && error.code === 'ENOENT') {
      return { path: resolved, metadata: null, contents: Buffer.alloc(0) };
    }
    throw error;
  }
  const uid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (uid !== undefined && metadata.uid !== uid)
  ) {
    throw new Error(`Log is not an owner-only regular file: ${basename(resolved)}`);
  }
  if (metadata.size > maximumBytes)
    throw new Error(`Log exceeds inspection cap: ${basename(resolved)}`);
  const contents = readFileSync(resolved);
  if (contents.byteLength !== metadata.size) {
    throw new Error(`Log changed during inspection: ${basename(resolved)}`);
  }
  return { path: resolved, metadata, contents };
}

function zeroContentLog(path) {
  const { path: resolved, metadata, contents } = readOwnedLog(path, { allowAbsent: true });
  if (contents.byteLength !== 0) {
    throw new Error(`Launchd stdout is not zero-content: ${basename(resolved)}`);
  }
  return {
    path: resolved,
    exists: metadata !== null,
    bytes: 0,
    sha256: EMPTY_SHA256,
    policy: 'zero-content',
  };
}

function exactKeys(record, expected, operation) {
  if (stableJson(Object.keys(record).sort()) !== stableJson(expected.slice().sort())) {
    throw new Error(`Structured log ${operation} event contains a non-allowlisted field.`);
  }
}

function finiteNonnegative(valueToCheck) {
  return typeof valueToCheck === 'number' && Number.isFinite(valueToCheck) && valueToCheck >= 0;
}

function hasControlCharacter(valueToCheck) {
  return [...valueToCheck].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 31 || code === 127);
  });
}

function validateStructuredLogEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('Structured log line is not a JSON object.');
  }
  const base = ['level', 'time', 'pid', 'hostname', 'operation'];
  if (
    event.level !== 30 ||
    !finiteNonnegative(event.time) ||
    !Number.isSafeInteger(event.pid) ||
    event.pid <= 0 ||
    typeof event.hostname !== 'string' ||
    !/^[A-Za-z0-9._-]{1,255}$/.test(event.hostname)
  ) {
    throw new Error('Structured log base metadata is invalid.');
  }
  switch (event.operation) {
    case 'server_started':
      exactKeys(event, [...base, 'host', 'port', 'version'], event.operation);
      if (
        event.host !== '127.0.0.1' ||
        event.port !== 5178 ||
        typeof event.version !== 'string' ||
        !/^[A-Za-z0-9._+-]{1,40}$/.test(event.version)
      ) {
        throw new Error('Structured server_started metadata is invalid.');
      }
      break;
    case 'server_stopped':
      exactKeys(event, base, event.operation);
      break;
    case 'http_request':
      exactKeys(event, [...base, 'method', 'path', 'status', 'durationMs'], event.operation);
      if (
        !['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].includes(event.method) ||
        typeof event.path !== 'string' ||
        !/^\/[A-Za-z0-9_./:-]{0,255}$/.test(event.path) ||
        !Number.isInteger(event.status) ||
        event.status < 100 ||
        event.status > 599 ||
        !finiteNonnegative(event.durationMs)
      ) {
        throw new Error('Structured http_request metadata is invalid.');
      }
      break;
    case 'mcp_tool_call':
      {
        const currentKeys = [...base, 'tool', 'tokenId', 'durationMs', 'outcome'];
        const legacyKeys = [...currentKeys, 'tokenLabel'];
        const actualKeys = Object.keys(event).sort();
        const currentShape = JSON.stringify(actualKeys) === JSON.stringify(currentKeys.sort());
        const legacyShape = JSON.stringify(actualKeys) === JSON.stringify(legacyKeys.sort());
        if (!currentShape && !legacyShape) {
          throw new Error('Structured mcp_tool_call has non-allowlisted fields.');
        }
        if (
          legacyShape &&
          (typeof event.tokenLabel !== 'string' ||
            !/^release-live-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}-[0-9]+$/.test(event.tokenLabel))
        ) {
          throw new Error('Structured legacy mcp_tool_call label is not release-bound metadata.');
        }
      }
      if (
        ![...EXPECTED_TOOLS, 'unknown'].includes(event.tool) ||
        typeof event.tokenId !== 'string' ||
        !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(event.tokenId) ||
        !finiteNonnegative(event.durationMs) ||
        !['success', 'error', 'rate_limited'].includes(event.outcome)
      ) {
        throw new Error('Structured mcp_tool_call metadata is invalid.');
      }
      break;
    default:
      throw new Error('Structured log contains a non-allowlisted operation.');
  }
}

export function inspectStructuredLogBuffer(contents, name = 'structured log') {
  if (contents.byteLength === 0) {
    return { lines: 0, operations: {} };
  }
  const text = contents.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(contents) || !text.endsWith('\n')) {
    throw new Error(`${name} is not complete UTF-8 JSON Lines.`);
  }
  if (LOG_SECRET_PATTERN.test(text)) {
    throw new Error(`${name} contains a credential-shaped value.`);
  }
  const operations = {};
  const lines = text.slice(0, -1).split('\n');
  for (const line of lines) {
    if (!line || line.includes('\r')) throw new Error(`${name} contains an unstructured line.`);
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`${name} contains invalid JSON Lines.`, { cause: error });
    }
    validateStructuredLogEvent(event);
    operations[event.operation] = (operations[event.operation] ?? 0) + 1;
  }
  return { lines: lines.length, operations };
}

function structuredLogFile(path, options = {}) {
  const {
    path: resolved,
    metadata,
    contents,
  } = readOwnedLog(path, {
    allowAbsent: options.allowAbsent === true,
  });
  if (metadata === null) {
    return {
      path: resolved,
      kind: options.kind,
      exists: false,
      bytes: 0,
      sha256: EMPTY_SHA256,
      lines: 0,
      operations: {},
    };
  }
  const uncompressed = options.compressed
    ? gunzipSync(contents, { maxOutputLength: 12 * 1024 * 1024 })
    : contents;
  const summary = inspectStructuredLogBuffer(uncompressed, basename(resolved));
  return {
    path: resolved,
    kind: options.kind,
    exists: true,
    bytes: contents.byteLength,
    sha256: sha256(contents),
    ...(options.compressed ? { uncompressedBytes: uncompressed.byteLength } : {}),
    ...summary,
  };
}

function inspectLogHistory(path, rotationNames) {
  const { path: resolved, metadata, contents } = readOwnedLog(path, { allowAbsent: true });
  if (metadata === null) return { path: resolved, exists: false, bytes: 0, entries: 0 };
  const text = contents.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(contents) || (text && !text.endsWith('\n'))) {
    throw new Error('Rotating-log history is not complete UTF-8.');
  }
  const names = text === '' ? [] : text.slice(0, -1).split('\n');
  if (
    names.some((name) => !ROTATED_LOG_PATTERN.test(name)) ||
    names.some((name) => !rotationNames.includes(name))
  ) {
    throw new Error('Rotating-log history contains a non-allowlisted entry.');
  }
  return {
    path: resolved,
    exists: true,
    bytes: contents.byteLength,
    sha256: sha256(contents),
    entries: names.length,
  };
}

export function inspectOperationalLogs({ stdoutPath, stderrPath, logDirectory }) {
  const names = readdirSync(logDirectory, { withFileTypes: true });
  const journalNames = names
    .filter((entry) => entry.name.includes('journald.log'))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('Journald log directory contains a non-regular log path.');
      }
      return entry.name;
    })
    .sort();
  if (
    !journalNames.includes('journald.log') ||
    journalNames.some(
      (name) =>
        name !== 'journald.log' && name !== 'journald.log.txt' && !ROTATED_LOG_PATTERN.test(name),
    )
  ) {
    throw new Error('Journald rotating-log inventory is missing or contains an unexpected file.');
  }
  const rotations = journalNames.filter((name) => ROTATED_LOG_PATTERN.test(name));
  const streams = [
    structuredLogFile(stderrPath, { kind: 'launchd-stderr', allowAbsent: true }),
    structuredLogFile(resolve(logDirectory, 'journald.log'), { kind: 'rotating-current' }),
    ...rotations.map((name) =>
      structuredLogFile(resolve(logDirectory, name), {
        kind: 'rotating-archive',
        compressed: true,
      }),
    ),
  ];
  return {
    policy: 'strict-jsonl-allowlist',
    launchdStdout: zeroContentLog(stdoutPath),
    streams,
    history: inspectLogHistory(resolve(logDirectory, 'journald.log.txt'), rotations),
    allowedOperations: ['server_started', 'server_stopped', 'http_request', 'mcp_tool_call'],
    contentBearingFieldsAccepted: false,
    secretPatternsFound: false,
    journalContentRecorded: false,
  };
}

function expectedEnvironment({ home, port, origin, version }) {
  const host = new URL(origin).host;
  const dataDirectory = resolve(home, '.journal');
  return {
    NODE_ENV: 'production',
    JOURNAL_CONFIG: resolve(dataDirectory, 'config.json'),
    JOURNAL_DATA_DIR: dataDirectory,
    JOURNAL_PORT: String(port),
    JOURNAL_BIND_HOST: '127.0.0.1',
    JOURNAL_HOSTS: `localhost:${port},127.0.0.1:${port},${host}`,
    JOURNAL_TZ: 'Europe/Amsterdam',
    JOURNAL_DAY_BOUNDARY_OFFSET_MIN: '0',
    JOURNAL_VERSION: version,
    JOURNAL_TAILNET_HOST: host,
  };
}

function validatePlist(plist, expected) {
  if (!plist || typeof plist !== 'object' || Array.isArray(plist)) {
    throw new Error('LaunchAgent plist is not a JSON object.');
  }
  if (stableJson(Object.keys(plist).sort()) !== stableJson(PLIST_KEYS)) {
    throw new Error('LaunchAgent plist contains missing, extra, or scheduler keys.');
  }
  assertEqual(plist.Label, LABEL, 'LaunchAgent label');
  if (stableJson(plist.ProgramArguments) !== stableJson(expected.arguments)) {
    throw new Error('LaunchAgent ProgramArguments are not the exact journald serve command.');
  }
  if (stableJson(plist.EnvironmentVariables) !== stableJson(expected.environment)) {
    throw new Error('LaunchAgent environment is not the exact production allowlist.');
  }
  assertEqual(plist.WorkingDirectory, expected.workingDirectory, 'LaunchAgent working directory');
  if (plist.RunAtLoad !== true || plist.KeepAlive !== true || plist.ProcessType !== 'Interactive') {
    throw new Error('LaunchAgent lifecycle settings are not the exact production policy.');
  }
  assertEqual(plist.StandardOutPath, expected.stdoutPath, 'LaunchAgent stdout path');
  assertEqual(plist.StandardErrorPath, expected.stderrPath, 'LaunchAgent stderr path');
}

async function inspectRuntime(binding, options, dependencies) {
  if (options.platform !== 'darwin') throw new Error('Live evidence requires macOS.');
  const originUrl = new URL(options.origin);
  if (
    originUrl.protocol !== 'https:' ||
    originUrl.origin !== options.origin ||
    originUrl.username ||
    originUrl.password
  ) {
    throw new Error('Tailnet origin must be a canonical credential-free HTTPS origin.');
  }
  const serviceTarget = `gui/${options.uid}/${LABEL}`;
  const launchOutput = await runCommand(
    dependencies.runCommand,
    '/bin/launchctl',
    ['print', serviceTarget],
    options.commandTimeoutMs,
    'launchctl PID inspection',
  );
  const pid = parseLaunchdPid(launchOutput);
  const loadedWorkingDirectory = launchdWorkingDirectory(launchOutput);
  if (loadedWorkingDirectory !== binding.releaseRoot) {
    throw new Error('The loaded launchd job working directory is not the attested release root.');
  }
  const plistPath = resolve(options.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const plistMetadata = lstatSync(plistPath);
  if (
    !plistMetadata.isFile() ||
    plistMetadata.isSymbolicLink() ||
    (plistMetadata.mode & 0o7777) !== 0o600 ||
    (process.getuid?.() !== undefined && plistMetadata.uid !== process.getuid())
  ) {
    throw new Error('Journald LaunchAgent plist is not an owner-only regular file.');
  }
  const plistText = await runCommand(
    dependencies.runCommand,
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', plistPath],
    options.commandTimeoutMs,
    'plist inspection',
  );
  let plist;
  try {
    plist = JSON.parse(plistText);
  } catch (error) {
    throw new Error('plutil returned invalid plist JSON.', { cause: error });
  }
  const expectedNode = resolve(binding.manifest.toolchain.nodePath);
  const expectedCli = resolve(binding.releaseRoot, 'server/dist/cli.js');
  const logDirectory = resolve(options.home, '.journal', 'logs');
  const environment = expectedEnvironment({
    home: options.home,
    port: options.port,
    origin: options.origin,
    version: binding.manifest.release.version,
  });
  const expectedArguments = launchAgentProgramArguments(environment, expectedNode, expectedCli);
  validatePlist(plist, {
    arguments: expectedArguments,
    environment,
    workingDirectory: resolve(binding.releaseRoot),
    stdoutPath: resolve(logDirectory, 'launchd.out.log'),
    stderrPath: resolve(logDirectory, 'launchd.err.log'),
  });

  const launchdList = await runCommand(
    dependencies.runCommand,
    '/bin/launchctl',
    ['list'],
    options.commandTimeoutMs,
    'launchctl job inventory',
  );
  const journalLabels = journalLaunchdLabels(launchdList);
  if (stableJson(journalLabels) !== stableJson([LABEL])) {
    throw new Error('launchd has a missing or extra Journal-related job.');
  }

  const processOutput = await runCommand(
    dependencies.runCommand,
    '/bin/ps',
    ['-axo', 'pid=,ppid=,command='],
    options.commandTimeoutMs,
    'process inventory',
  );
  const processes = parseProcessTable(processOutput);
  const runtime = processes.find((processRow) => processRow.pid === pid);
  const expectedCommand = [expectedNode, expectedCli, 'serve'].join(' ');
  if (!runtime || runtime.command !== expectedCommand) {
    throw new Error('The live launchd PID command does not match the attested plist.');
  }
  const descendants = descendantsOf(processes, pid);
  if (descendants.length !== 0) {
    throw new Error('Journald owns an unexpected child process or scheduler.');
  }

  const processEnvironmentOutput = await runCommand(
    dependencies.runCommand,
    '/bin/ps',
    ['eww', '-p', String(pid), '-o', 'command='],
    options.commandTimeoutMs,
    'journald effective environment inspection',
  );
  const processEnvironment = assertExactProcessEnvironment(
    processEnvironmentFromPs(processEnvironmentOutput, expectedCommand),
    environment,
  );

  const cwdOutput = await runCommand(
    dependencies.runCommand,
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(pid), '-d', 'cwd', '-FpfDin'],
    options.commandTimeoutMs,
    'journald cwd inspection',
  );
  const processWorkingDirectory = cwdIdentityFromLsof(cwdOutput, pid);
  if (processWorkingDirectory.path !== binding.releaseRoot) {
    throw new Error('The live journald PID working directory is not the attested release root.');
  }
  const workingDirectoryIdentity = assertObservedDirectory(
    processWorkingDirectory,
    binding.releaseRoot,
    'Live journald cwd',
  );

  const lsofOutput = await runCommand(
    dependencies.runCommand,
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(pid), '-iTCP', '-FpnT'],
    options.commandTimeoutMs,
    'journald TCP socket inspection',
  );
  const sockets = parseTcpSockets(lsofOutput, pid, options.port);

  // Refuse to create even a temporary credential when the existing operational
  // logs already violate the content-free allowlist. Collection repeats this
  // complete inspection after its own MCP traffic and emits only that final
  // inventory.
  inspectOperationalLogs({
    stdoutPath: plist.StandardOutPath,
    stderrPath: plist.StandardErrorPath,
    logDirectory,
  });

  return {
    pid,
    serviceTarget,
    environment,
    logs: {
      stdoutPath: plist.StandardOutPath,
      stderrPath: plist.StandardErrorPath,
      logDirectory,
    },
    evidence: {
      label: LABEL,
      serviceTarget,
      pid,
      plist: {
        path: plistPath,
        sha256: sha256File(plistPath),
        mode: '0600',
        programArguments: expectedArguments,
        workingDirectory: resolve(binding.releaseRoot),
        environmentKeys: Object.keys(environment).sort(),
        environmentSha256: sha256(Buffer.from(stableJson(environment))),
      },
      process: {
        commandSha256: sha256(Buffer.from(expectedCommand)),
        environment: processEnvironment,
        workingDirectory: processWorkingDirectory.path,
        workingDirectoryIdentity,
        descendants: [],
        extraJournalLaunchdJobs: [],
      },
      tcp: {
        metadataOnly: true,
        snapshots: [{ phase: 'before-mcp-smoke', sockets }],
        unexpectedNonLoopbackSockets: [],
      },
    },
  };
}

async function recheckRuntime(binding, runtime, options, dependencies, phase) {
  const descriptionPrefix = phase === 'before-final-log-inspection' ? 'final' : 'post-log';
  const launchOutput = await runCommand(
    dependencies.runCommand,
    '/bin/launchctl',
    ['print', runtime.serviceTarget],
    options.commandTimeoutMs,
    `${descriptionPrefix} launchctl PID inspection`,
  );
  if (
    parseLaunchdPid(launchOutput) !== runtime.pid ||
    launchdWorkingDirectory(launchOutput) !== binding.releaseRoot
  ) {
    throw new Error('Journald PID or loaded working directory changed during evidence collection.');
  }

  const cwdOutput = await runCommand(
    dependencies.runCommand,
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(runtime.pid), '-d', 'cwd', '-FpfDin'],
    options.commandTimeoutMs,
    `${descriptionPrefix} journald cwd inspection`,
  );
  const workingDirectory = cwdIdentityFromLsof(cwdOutput, runtime.pid);
  if (
    workingDirectory.path !== binding.releaseRoot ||
    workingDirectory.device !== runtime.evidence.process.workingDirectoryIdentity.device ||
    workingDirectory.inode !== runtime.evidence.process.workingDirectoryIdentity.inode
  ) {
    throw new Error('Journald cwd changed during live evidence collection.');
  }
  assertObservedDirectory(
    workingDirectory,
    binding.releaseRoot,
    `${descriptionPrefix} journald cwd`,
  );

  const expectedCommand = [
    resolve(binding.manifest.toolchain.nodePath),
    resolve(binding.releaseRoot, 'server/dist/cli.js'),
    'serve',
  ].join(' ');
  const environmentOutput = await runCommand(
    dependencies.runCommand,
    '/bin/ps',
    ['eww', '-p', String(runtime.pid), '-o', 'command='],
    options.commandTimeoutMs,
    `${descriptionPrefix} journald effective environment inspection`,
  );
  const environment = assertExactProcessEnvironment(
    processEnvironmentFromPs(environmentOutput, expectedCommand),
    runtime.environment,
  );
  if (stableJson(environment) !== stableJson(runtime.evidence.process.environment)) {
    throw new Error('Journald effective environment changed during live evidence collection.');
  }

  const lsofOutput = await runCommand(
    dependencies.runCommand,
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(runtime.pid), '-iTCP', '-FpnT'],
    options.commandTimeoutMs,
    `${descriptionPrefix} journald TCP socket inspection`,
  );
  return parseTcpSockets(lsofOutput, runtime.pid, options.port);
}

function parseOwnerTokenInventory(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    stableJson(Object.keys(body).sort()) !== stableJson(['tokens']) ||
    !Array.isArray(body.tokens)
  ) {
    throw new Error('Loopback owner token inventory returned an invalid result.');
  }
  const recordKeys = ['createdAt', 'id', 'label', 'lastUsedAt', 'revokedAt', 'scopes'];
  const validTimestamp = (candidate) =>
    typeof candidate === 'string' &&
    Number.isFinite(Date.parse(candidate)) &&
    new Date(candidate).toISOString() === candidate;
  for (const token of body.tokens) {
    if (
      !token ||
      typeof token !== 'object' ||
      Array.isArray(token) ||
      stableJson(Object.keys(token).sort()) !== stableJson(recordKeys) ||
      typeof token.id !== 'string' ||
      !ULID_PATTERN.test(token.id) ||
      typeof token.label !== 'string' ||
      token.label.length < 1 ||
      token.label.length > 80 ||
      token.label.trim() !== token.label ||
      hasControlCharacter(token.label) ||
      stableJson(token.scopes) !== stableJson(['journal:full']) ||
      !validTimestamp(token.createdAt) ||
      (token.lastUsedAt !== null && !validTimestamp(token.lastUsedAt)) ||
      (token.revokedAt !== null && !validTimestamp(token.revokedAt))
    ) {
      throw new Error('Loopback owner token inventory returned an invalid record.');
    }
  }
  return body.tokens;
}

export function createLoopbackTokenManager({ fetch: fetchImpl, label, port, requestTimeoutMs }) {
  const origin = `http://127.0.0.1:${port}`;
  let cookie;
  const ownerHeaders = () => {
    if (!cookie) throw new Error('Loopback token cleanup has no in-memory owner cookie.');
    return { Accept: 'application/json', Cookie: cookie, Origin: origin };
  };
  const listTokens = async () => {
    const listed = await fetchJsonRpc(fetchImpl, `${origin}/api/tokens`, undefined, {
      description: 'Loopback owner token inventory',
      timeoutMs: requestTimeoutMs,
      expectedStatus: 200,
      headers: ownerHeaders(),
      method: 'GET',
    });
    return parseOwnerTokenInventory(listed.body);
  };
  const deleteToken = async (id) => {
    const revoked = await fetchJsonRpc(
      fetchImpl,
      `${origin}/api/tokens/${encodeURIComponent(id)}`,
      undefined,
      {
        description: 'Loopback temporary token revocation',
        timeoutMs: requestTimeoutMs,
        expectedStatus: 200,
        headers: ownerHeaders(),
        method: 'DELETE',
        settleAfterTimeout: true,
      },
    );
    if (revoked.body?.revoked !== true || revoked.body?.id !== id) {
      throw new Error('Loopback temporary token revocation returned an invalid result.');
    }
  };
  const cleanupMatchingTokens = async (knownIds = []) => {
    if (!cookie) return;
    const known = new Set(knownIds);
    const isActiveTarget = (token) =>
      token.revokedAt === null && (token.label === label || known.has(token.id));
    const initial = await listTokens();
    const active = initial.filter(isActiveTarget);
    if (active.length === 0) return;

    const deletionFailures = [];
    for (const token of active) {
      try {
        await deleteToken(token.id);
      } catch (error) {
        // DELETE may have committed even when its response was lost. Only the
        // owner inventory below decides whether cleanup succeeded.
        deletionFailures.push(error);
      }
    }

    let remaining;
    try {
      remaining = (await listTokens()).filter(isActiveTarget);
    } catch (error) {
      throw new AggregateError(
        [...deletionFailures, error],
        'Loopback temporary token cleanup was not proven by owner inventory.',
        { cause: error },
      );
    }
    if (remaining.length !== 0) {
      throw new AggregateError(
        deletionFailures,
        'Loopback temporary token cleanup left an active matching credential.',
      );
    }
  };
  return {
    create: async () => {
      const paired = await fetchJsonRpc(
        fetchImpl,
        `${origin}/api/pair`,
        { label },
        {
          description: 'Loopback device pairing',
          timeoutMs: requestTimeoutMs,
          expectedStatus: 201,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Origin: origin,
          },
        },
      );
      const setCookie = paired.headers.get('set-cookie') ?? '';
      cookie = setCookie.split(';', 1)[0];
      if (!/^journal_device=[A-Za-z0-9_-]{32,}$/.test(cookie)) {
        throw new Error('Loopback device pairing returned no valid in-memory cookie.');
      }
      // The release-stamp label is a dedicated correlation key. Clear an
      // orphan from any prior failed attempt before minting another secret.
      await cleanupMatchingTokens();
      let issuedId;
      try {
        const issued = await fetchJsonRpc(
          fetchImpl,
          `${origin}/api/tokens`,
          { label },
          {
            description: 'Loopback temporary token creation',
            timeoutMs: requestTimeoutMs,
            expectedStatus: 201,
            settleAfterTimeout: true,
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              Cookie: cookie,
              Origin: origin,
            },
          },
        );
        issuedId = issued.body?.token?.id;
        const issuedLabel = issued.body?.token?.label;
        const secret = issued.body?.secret;
        if (
          typeof issuedId !== 'string' ||
          !ULID_PATTERN.test(issuedId) ||
          issuedLabel !== label ||
          typeof secret !== 'string' ||
          !secret.startsWith('jrn_')
        ) {
          throw new Error('Loopback temporary token creation returned an invalid credential.');
        }
        return { id: issuedId, secret };
      } catch (creationFailure) {
        try {
          await cleanupMatchingTokens(issuedId === undefined ? [] : [issuedId]);
        } catch (cleanupFailure) {
          throw new AggregateError(
            [creationFailure, cleanupFailure],
            'Loopback token creation failed and temporary credential cleanup was not proven.',
            { cause: cleanupFailure },
          );
        }
        throw creationFailure;
      }
    },
    revoke: async (id) => {
      await cleanupMatchingTokens([id]);
    },
    cleanup: () => cleanupMatchingTokens(),
    close: () => {
      cookie = undefined;
    },
  };
}

async function fetchJsonRpc(fetchImpl, url, request, options) {
  const controller = new AbortController();
  const operation = (async () => {
    const response = await fetchImpl(url, {
      method: options.method ?? 'POST',
      headers: options.headers,
      ...(request === undefined ? {} : { body: JSON.stringify(request) }),
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status !== options.expectedStatus) {
      await response.body?.cancel();
      throw new Error(`${options.description} returned an unexpected HTTP status.`);
    }
    if (options.readBody === false) {
      await response.body?.cancel();
      return { status: response.status, headers: response.headers };
    }
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
      await response.body?.cancel();
      throw new Error(`${options.description} returned a non-JSON response.`);
    }
    const body = await response.json();
    return { status: response.status, headers: response.headers, body };
  })();
  try {
    return await withDeadline(
      options.description,
      options.timeoutMs,
      () => operation,
      () => controller.abort(),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${options.description} exceeded`)) {
      if (options.settleAfterTimeout === true) {
        // A loopback mutation can commit after the client-side deadline wins.
        // Wait for its transport promise to settle before inventory recovery,
        // so close cannot discard the only owner cookie while POST/DELETE is
        // still capable of changing credential state.
        await operation.catch(() => undefined);
      }
      throw error;
    }
    if (error instanceof Error && error.message.startsWith(options.description)) throw error;
    throw new Error(`${options.description} failed.`, { cause: error });
  } finally {
    controller.abort();
  }
}

function rpcResult(response, id, description) {
  const body = response.body;
  if (
    !body ||
    typeof body !== 'object' ||
    body.jsonrpc !== '2.0' ||
    body.id !== id ||
    !body.result ||
    typeof body.result !== 'object' ||
    body.error !== undefined
  ) {
    throw new Error(`${description} returned an invalid JSON-RPC result.`);
  }
  return body.result;
}

async function runMcpSmoke(binding, runtime, options, dependencies) {
  const tokenLabel = `release-live-${binding.releaseStamp}`;
  const manager = await withDeadline('Local token manager setup', options.tokenTimeoutMs, () =>
    dependencies.tokenManagerFactory({
      binding,
      environment: runtime.environment,
      label: tokenLabel,
      fetch: dependencies.fetch,
      port: options.port,
      requestTimeoutMs: Math.min(
        options.commandTimeoutMs,
        options.requestTimeoutMs,
        options.tokenTimeoutMs,
      ),
    }),
  );
  let token;
  let revoked = false;
  let failure;
  let result;
  try {
    // The loopback manager bounds every HTTP request itself. Do not race the
    // aggregate create/revoke operation against another timer: a timeout that
    // wins after POST commits is precisely the ambiguous state cleanup must
    // finish resolving before the owner cookie is discarded.
    token = await manager.create();
    if (
      !token ||
      typeof token.id !== 'string' ||
      typeof token.secret !== 'string' ||
      !token.secret.startsWith('jrn_')
    ) {
      throw new Error('Temporary token creation returned an invalid credential.');
    }
    const baseHeaders = {
      Authorization: `Bearer ${token.secret}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    const mcpUrl = `${options.origin}/mcp`;
    const initialized = await fetchJsonRpc(
      dependencies.fetch,
      mcpUrl,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'journal-release-evidence', version: '1' },
        },
      },
      {
        description: 'MCP initialize smoke',
        timeoutMs: options.requestTimeoutMs,
        expectedStatus: 200,
        headers: baseHeaders,
      },
    );
    const initializeResult = rpcResult(initialized, 1, 'MCP initialize smoke');
    if (initializeResult.protocolVersion !== MCP_PROTOCOL_VERSION) {
      throw new Error('MCP initialize smoke negotiated an unexpected protocol version.');
    }
    const sessionId = initialized.headers.get('mcp-session-id');
    if (!sessionId) throw new Error('MCP initialize smoke returned no session id.');
    const sessionHeaders = {
      ...baseHeaders,
      'Mcp-Session-Id': sessionId,
      'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
    };

    const listed = await fetchJsonRpc(
      dependencies.fetch,
      mcpUrl,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        description: 'MCP tools-list smoke',
        timeoutMs: options.requestTimeoutMs,
        expectedStatus: 200,
        headers: sessionHeaders,
      },
    );
    const tools = rpcResult(listed, 2, 'MCP tools-list smoke').tools;
    const toolNames = Array.isArray(tools) ? tools.map((tool) => tool?.name) : [];
    if (stableJson(toolNames) !== stableJson(EXPECTED_TOOLS)) {
      throw new Error('MCP tools-list smoke returned an unexpected tool inventory.');
    }

    const read = await fetchJsonRpc(
      dependencies.fetch,
      mcpUrl,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'search',
          arguments: { query: `release-evidence-${randomUUID()}`, limit: 1 },
        },
      },
      {
        description: 'MCP read smoke',
        timeoutMs: options.requestTimeoutMs,
        expectedStatus: 200,
        headers: sessionHeaders,
      },
    );
    const readResult = rpcResult(read, 3, 'MCP read smoke');
    if (
      readResult.isError === true ||
      !readResult.structuredContent ||
      typeof readResult.structuredContent.total !== 'number' ||
      !Array.isArray(readResult.structuredContent.entries)
    ) {
      throw new Error('MCP read smoke returned an invalid structured result.');
    }

    await fetchJsonRpc(dependencies.fetch, mcpUrl, undefined, {
      description: 'MCP session cleanup',
      timeoutMs: options.requestTimeoutMs,
      expectedStatus: 200,
      headers: sessionHeaders,
      method: 'DELETE',
      readBody: false,
    });
    await manager.revoke(token.id);
    revoked = true;
    const revokedProbe = await fetchJsonRpc(
      dependencies.fetch,
      mcpUrl,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'journal-release-evidence-revocation-check', version: '1' },
        },
      },
      {
        description: 'MCP revoked-token probe',
        timeoutMs: options.requestTimeoutMs,
        expectedStatus: 401,
        headers: baseHeaders,
        readBody: false,
      },
    );
    result = {
      origin: options.origin,
      transport: 'streamable-http',
      token: {
        createdLocally: true,
        tokenIdSha256: sha256(Buffer.from(token.id)),
        secretRecorded: false,
        revoked: true,
        revokedProbeStatus: revokedProbe.status,
      },
      initialize: {
        httpStatus: initialized.status,
        protocolVersion: MCP_PROTOCOL_VERSION,
        sessionIdSha256: sha256(Buffer.from(sessionId)),
      },
      toolsList: { httpStatus: listed.status, names: EXPECTED_TOOLS },
      read: {
        httpStatus: read.status,
        tool: 'search',
        structuredResultValidated: true,
        journalContentRecorded: false,
      },
      sessionClosed: true,
      secretsRecorded: false,
    };
    const serialized = JSON.stringify(result);
    if (serialized.includes(token.secret) || serialized.includes(sessionId)) {
      throw new Error('MCP evidence redaction invariant failed.');
    }
  } catch (error) {
    failure = error;
  }

  let cleanupFailure;
  if (token && !revoked) {
    try {
      await manager.revoke(token.id);
      revoked = true;
    } catch (error) {
      cleanupFailure = error;
    }
  } else if (!token && typeof manager.cleanup === 'function') {
    try {
      // The default manager also proves cleanup inside create() after an
      // ambiguous response. Repeat it before close so a transient first
      // cleanup failure gets one owner-inventory recovery attempt.
      await manager.cleanup();
    } catch (error) {
      cleanupFailure = error;
    }
  }
  try {
    await withDeadline('Local token manager close', options.tokenTimeoutMs, () => manager.close());
  } catch (error) {
    cleanupFailure ??= error;
  }
  if (cleanupFailure) {
    throw new AggregateError(
      [...(failure ? [failure] : []), cleanupFailure],
      'Live evidence failed closed because temporary token cleanup was not proven.',
    );
  }
  if (failure) throw failure;
  return result;
}

export async function collectLiveContextEvidence(binding, options = {}, dependencies = {}) {
  const effectiveOptions = {
    origin: options.origin ?? 'https://mickey-home.tail8a9beb.ts.net:5178',
    home: options.home ?? homedir(),
    uid: options.uid ?? process.getuid?.(),
    platform: options.platform ?? process.platform,
    port: options.port ?? 5178,
    commandTimeoutMs: options.commandTimeoutMs ?? 2_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    tokenTimeoutMs: options.tokenTimeoutMs ?? 6_000,
  };
  if (!Number.isSafeInteger(effectiveOptions.uid) || effectiveOptions.uid < 0) {
    throw new Error('Unable to determine the current macOS user id.');
  }
  const effectiveDependencies = {
    runCommand: dependencies.runCommand ?? defaultCommandRunner,
    fetch: dependencies.fetch ?? fetch,
    tokenManagerFactory:
      dependencies.tokenManagerFactory ??
      ((managerOptions) => createLoopbackTokenManager(managerOptions)),
    now: dependencies.now ?? (() => new Date()),
  };
  const runtime = await inspectRuntime(binding, effectiveOptions, effectiveDependencies);
  const mcp = await runMcpSmoke(binding, runtime, effectiveOptions, effectiveDependencies);
  await recheckRuntime(
    binding,
    runtime,
    effectiveOptions,
    effectiveDependencies,
    'before-final-log-inspection',
  );
  const logs = {
    ...inspectOperationalLogs(runtime.logs),
    validationPhase: 'after-mcp-smoke-before-final-runtime-recheck',
  };
  const postLogSockets = await recheckRuntime(
    binding,
    runtime,
    effectiveOptions,
    effectiveDependencies,
    'after-final-log-inspection',
  );
  let deployedTree;
  if (binding.deployedTree !== undefined) {
    const finalDeployedTree = verifyDeployedTreeAttestation({
      contextPath: binding.contextPath,
      root: binding.releaseRoot,
      attestationPath: binding.deployedTree.attestationPath,
    });
    if (stableJson(finalDeployedTree) !== stableJson(binding.deployedTree)) {
      throw new Error('Deployed release tree changed during live evidence collection.');
    }
    deployedTree = { ...finalDeployedTree, stableDuringCollection: true };
  }
  return {
    schemaVersion: 1,
    releaseStamp: binding.releaseStamp,
    recordedAt: effectiveDependencies.now().toISOString(),
    baseCommit: binding.baseCommit,
    manifestSha256: binding.manifestSha256,
    archiveSha256: binding.archiveSha256,
    releaseRoot: binding.releaseRoot,
    ...(deployedTree === undefined ? {} : { deployedTree }),
    service: {
      ...runtime.evidence,
      tcp: {
        ...runtime.evidence.tcp,
        snapshots: [
          ...runtime.evidence.tcp.snapshots,
          { phase: 'after-final-log-inspection', sockets: postLogSockets },
        ],
      },
      logs,
      pidStableDuringCollection: true,
      workingDirectoryStableDuringCollection: true,
      environmentKeysAndValuesStableDuringCollection: true,
    },
    mcp,
  };
}

export function writeLiveContextEvidence(outputPath, evidence) {
  const destination = resolve(outputPath);
  return writeOwnerPrivateAtomic(destination, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function runCli() {
  const args = process.argv.slice(2);
  const contextPath = value(args, '--context');
  const outputPath = value(args, '--output');
  if (!contextPath || !outputPath) {
    throw new Error(
      'Usage: release-live-evidence.mjs --context <release-context.json> --output <evidence.json>',
    );
  }
  const binding = loadReleaseBinding({
    contextPath,
    outputPath,
    selfPath: fileURLToPath(import.meta.url),
  });
  const evidence = await collectLiveContextEvidence(binding, {
    origin: value(args, '--origin', 'https://mickey-home.tail8a9beb.ts.net:5178'),
    commandTimeoutMs: Number(value(args, '--command-timeout-ms', '2000')),
    requestTimeoutMs: Number(value(args, '--request-timeout-ms', '5000')),
    tokenTimeoutMs: Number(value(args, '--token-timeout-ms', '6000')),
  });
  process.stdout.write(`${writeLiveContextEvidence(binding.outputPath, evidence)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Live evidence failed.'}\n`);
    process.exitCode = 1;
  });
}
