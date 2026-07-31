#!/usr/bin/env node
/* global AbortController, Buffer, URL, fetch, process */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { clearTimeout as clearTimer, setTimeout as setTimer } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readManifest } from './release-manifest.mjs';

const execFileAsync = promisify(execFile);
const RELEASE_STAMP_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}-[0-9]+$/;
export const JOURNAL_ENV_EXECUTABLE = '/usr/bin/env';
export const LAUNCH_AGENT_PLIST_KEYS = Object.freeze([
  'EnvironmentVariables',
  'KeepAlive',
  'Label',
  'ProcessType',
  'ProgramArguments',
  'RunAtLoad',
  'StandardErrorPath',
  'StandardOutPath',
  'WorkingDirectory',
]);

function value(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value.`);
  return args[index + 1];
}

async function command(commandPath, args, signal) {
  const { stdout } = await execFileAsync(commandPath, args, {
    encoding: 'utf8',
    timeout: 2_000,
    signal,
  });
  return stdout;
}

export function launchdPid(output) {
  const values = [...output.matchAll(/^\s*pid = ([0-9]+)\s*$/gm)].map((match) => Number(match[1]));
  if (values.length !== 1 || !Number.isSafeInteger(values[0]) || values[0] <= 0) {
    throw new Error('launchd did not report exactly one live PID.');
  }
  return values[0];
}

export function launchdWorkingDirectory(output) {
  const values = [...output.matchAll(/^\s*working directory = (.*)$/gm)].map((match) => match[1]);
  if (values.length !== 1 || !values[0]?.startsWith('/')) {
    throw new Error('launchd did not report exactly one absolute working directory.');
  }
  return values[0];
}

export function launchAgentProgramArguments(environment, nodePath, cliPath) {
  return [
    JOURNAL_ENV_EXECUTABLE,
    '-i',
    ...Object.entries(environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, valueToAssign]) => `${key}=${valueToAssign}`),
    resolve(nodePath),
    resolve(cliPath),
    'serve',
  ];
}

function isRecord(valueToCheck) {
  return valueToCheck !== null && typeof valueToCheck === 'object' && !Array.isArray(valueToCheck);
}

function sameSortedEntries(left, right) {
  const sortedEntries = (valueToSort) =>
    Object.entries(valueToSort).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(sortedEntries(left)) === JSON.stringify(sortedEntries(right));
}

export function validateLaunchAgentPlist(plist, expected) {
  if (!isRecord(plist)) {
    throw new Error('LaunchAgent plist is not a JSON object.');
  }
  if (JSON.stringify(Object.keys(plist).sort()) !== JSON.stringify(LAUNCH_AGENT_PLIST_KEYS)) {
    throw new Error('LaunchAgent plist contains missing, extra, or scheduler keys.');
  }
  if (plist.Label !== expected.label) {
    throw new Error('LaunchAgent label does not match the release contract.');
  }
  if (
    !Array.isArray(plist.ProgramArguments) ||
    JSON.stringify(plist.ProgramArguments) !== JSON.stringify(expected.programArguments)
  ) {
    throw new Error('LaunchAgent ProgramArguments are not the exact isolated production command.');
  }
  if (
    !isRecord(plist.EnvironmentVariables) ||
    !sameSortedEntries(plist.EnvironmentVariables, expected.environment)
  ) {
    throw new Error('LaunchAgent environment is not the exact production allowlist.');
  }
  if (plist.WorkingDirectory !== expected.workingDirectory) {
    throw new Error('LaunchAgent working directory does not match the release contract.');
  }
  if (plist.RunAtLoad !== true || plist.KeepAlive !== true || plist.ProcessType !== 'Interactive') {
    throw new Error('LaunchAgent lifecycle settings are not the exact production policy.');
  }
  if (plist.StandardOutPath !== expected.stdoutPath) {
    throw new Error('LaunchAgent stdout path does not match the release contract.');
  }
  if (plist.StandardErrorPath !== expected.stderrPath) {
    throw new Error('LaunchAgent stderr path does not match the release contract.');
  }
  return true;
}

export function validateLaunchAgentPlistMetadata(metadata, expectedUid = process.getuid?.()) {
  const isRegularFile = typeof metadata?.isFile === 'function' && metadata.isFile();
  const isSymbolicLink =
    typeof metadata?.isSymbolicLink === 'function' && metadata.isSymbolicLink();
  const modeIsPrivate =
    (typeof metadata?.mode === 'number' &&
      Number.isSafeInteger(metadata.mode) &&
      metadata.mode >= 0 &&
      (metadata.mode & 0o7777) === 0o600) ||
    (typeof metadata?.mode === 'bigint' &&
      metadata.mode >= 0n &&
      (metadata.mode & 0o7777n) === 0o600n);
  const validIdentity = (identity) =>
    (typeof identity === 'number' && Number.isSafeInteger(identity) && identity >= 0) ||
    (typeof identity === 'bigint' && identity >= 0n);
  const ownerMatches =
    expectedUid === undefined ||
    (validIdentity(metadata?.uid) &&
      validIdentity(expectedUid) &&
      BigInt(metadata.uid) === BigInt(expectedUid));
  if (!isRegularFile || isSymbolicLink || !modeIsPrivate || !ownerMatches) {
    throw new Error('LaunchAgent plist is not an owner-only regular non-symlink file.');
  }
  return true;
}

function fileIdentity(valueToNormalize, description) {
  if (
    (typeof valueToNormalize !== 'number' ||
      !Number.isSafeInteger(valueToNormalize) ||
      valueToNormalize < 0) &&
    (typeof valueToNormalize !== 'bigint' || valueToNormalize < 0n)
  ) {
    throw new Error(`LaunchAgent plist has an invalid ${description}.`);
  }
  return String(valueToNormalize);
}

export function validateLaunchAgentPlistSnapshot(
  { plist, metadata, contents },
  expected,
  baseline,
) {
  validateLaunchAgentPlistMetadata(metadata);
  validateLaunchAgentPlist(plist, expected);
  const snapshot = {
    device: fileIdentity(metadata.dev, 'device identity'),
    inode: fileIdentity(metadata.ino, 'inode identity'),
    sha256: sha256(contents),
  };
  if (
    baseline !== undefined &&
    (snapshot.device !== baseline.device ||
      snapshot.inode !== baseline.inode ||
      snapshot.sha256 !== baseline.sha256)
  ) {
    throw new Error('LaunchAgent plist identity or contents changed during runtime verification.');
  }
  return snapshot;
}

export function processEnvironmentFromPs(output, expectedCommand) {
  const line = output.replace(/\r?\n$/, '');
  const prefix = `${expectedCommand} `;
  if (!line.startsWith(prefix) || line.includes('\n')) {
    throw new Error('ps did not return the exact journald command and effective environment.');
  }
  const environmentText = line.slice(prefix.length);
  const environment = {};
  for (const assignment of environmentText.split(' ')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(assignment);
    if (!match || Object.hasOwn(environment, match[1])) {
      throw new Error('ps returned malformed or duplicate effective environment metadata.');
    }
    environment[match[1]] = match[2];
  }
  if (Object.keys(environment).length === 0) {
    throw new Error('ps returned no effective environment metadata.');
  }
  return environment;
}

export function assertExactProcessEnvironment(actualEnvironment, expectedEnvironment) {
  const expectedKeys = Object.keys(expectedEnvironment).sort();
  const actualKeys = Object.keys(actualEnvironment).sort();
  const unexpectedKeys = actualKeys.filter((key) => !expectedKeys.includes(key));
  const missingKeys = expectedKeys.filter((key) => !actualKeys.includes(key));
  const alteredKeys = expectedKeys.filter(
    (key) =>
      actualEnvironment[key] !== undefined && actualEnvironment[key] !== expectedEnvironment[key],
  );
  const credentialKeys = unexpectedKeys.filter((key) =>
    /(?:AUTH|COOKIE|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i.test(key),
  );
  if (unexpectedKeys.length !== 0 || missingKeys.length !== 0 || alteredKeys.length !== 0) {
    throw new Error(
      `Journald effective environment is not the exact production allowlist (unexpected keys: ${unexpectedKeys.join(', ') || 'none'}; missing keys: ${missingKeys.join(', ') || 'none'}; altered keys: ${alteredKeys.join(', ') || 'none'}).`,
    );
  }
  return {
    keys: expectedKeys,
    unexpectedKeys: [],
    credentialKeys,
    isolatedBy: `${JOURNAL_ENV_EXECUTABLE} -i`,
    providerOrSchedulerConfigurationAbsent: true,
  };
}

function decimalIdentity(value, description) {
  try {
    const identity = BigInt(value);
    if (identity < 0n) throw new Error('negative identity');
    return identity.toString();
  } catch (error) {
    throw new Error(`lsof reported an invalid ${description}.`, { cause: error });
  }
}

export function cwdIdentityFromLsof(output, expectedPid) {
  let pid;
  let current;
  const directories = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      current = undefined;
    } else if (line.startsWith('f')) {
      if (current !== undefined) directories.push(current);
      current = line === 'fcwd' ? { pid } : undefined;
    } else if (current !== undefined && line.startsWith('D')) {
      current.device = decimalIdentity(line.slice(1), 'cwd device');
    } else if (current !== undefined && line.startsWith('i')) {
      current.inode = decimalIdentity(line.slice(1), 'cwd inode');
    } else if (current !== undefined && line.startsWith('n')) {
      current.path = line.slice(1);
    }
  }
  if (current !== undefined) directories.push(current);
  if (
    directories.length !== 1 ||
    directories[0]?.pid !== expectedPid ||
    !directories[0].path?.startsWith('/') ||
    directories[0].device === undefined ||
    directories[0].inode === undefined
  ) {
    throw new Error('lsof did not report exactly one complete cwd identity for the launchd PID.');
  }
  return directories[0];
}

function assertCanonicalReleaseDirectory(release, home) {
  if (
    dirname(release) !== resolve(home, '.journal', 'releases') ||
    !RELEASE_STAMP_PATTERN.test(basename(release))
  ) {
    throw new Error('Runtime release root is outside the versioned Journal release directory.');
  }
  const metadata = lstatSync(release);
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o0222) !== 0 ||
    (metadata.mode & 0o0077) !== 0 ||
    realpathSync(release) !== release
  ) {
    throw new Error('Runtime release root is not an immutable owner-only canonical directory.');
  }
  return metadata;
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

export function listenersFromLsof(output) {
  const listeners = [];
  let pid = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null) listeners.push({ pid, name: line.slice(1) });
  }
  return listeners;
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

async function inspectLaunchAgentPlist(plistPath, expected, baseline, signal) {
  const metadataBefore = lstatSync(plistPath, { bigint: true });
  const contentsBefore = readFileSync(plistPath);
  const plistJson = await command(
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', plistPath],
    signal,
  );
  let plist;
  try {
    plist = JSON.parse(plistJson);
  } catch (error) {
    throw new Error('plutil returned invalid LaunchAgent plist JSON.', { cause: error });
  }
  const contentsAfter = readFileSync(plistPath);
  const metadataAfter = lstatSync(plistPath, { bigint: true });
  const before = validateLaunchAgentPlistSnapshot(
    { plist, metadata: metadataBefore, contents: contentsBefore },
    expected,
    baseline,
  );
  return validateLaunchAgentPlistSnapshot(
    { plist, metadata: metadataAfter, contents: contentsAfter },
    expected,
    before,
  );
}

export async function withStableLaunchAgentPlist(inspect, operation) {
  const baseline = await inspect();
  const result = await operation();
  await inspect(baseline);
  return result;
}

function expectedAssetRecord(manifest, assetPath) {
  const path = `app/dist/${assetPath.replace(/^\//, '')}`;
  const record = manifest.files.find((candidate) => candidate.path === path);
  if (!record || record.kind !== 'file')
    throw new Error(`Served asset is absent from manifest: ${path}`);
  return record;
}

async function fetchOk(url, signal) {
  const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response;
}

async function verifyApplicationOnce(origin, manifest, signal) {
  const health = await (await fetchOk(`${origin}/healthz`, signal)).json();
  if (
    health?.status !== 'ok' ||
    health?.db !== 'ok' ||
    health?.version !== manifest.release.version
  ) {
    throw new Error(`Health adoption mismatch: ${JSON.stringify(health)}`);
  }

  const html = await (await fetchOk(`${origin}/`, signal)).text();
  const assetPath = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i.exec(html)?.[1];
  if (!assetPath) throw new Error('Served app shell has no script asset.');
  const assetUrl = new URL(assetPath, origin);
  if (assetUrl.origin !== origin || !assetUrl.pathname.startsWith('/assets/')) {
    throw new Error(`Served app asset is outside the expected origin/assets path: ${assetUrl}`);
  }
  const expectedAsset = expectedAssetRecord(manifest, assetUrl.pathname);
  const assetBody = Buffer.from(await (await fetchOk(assetUrl, signal)).arrayBuffer());
  const assetSha256 = sha256(assetBody);
  if (assetBody.byteLength !== expectedAsset.bytes || assetSha256 !== expectedAsset.sha256) {
    throw new Error(`Served app asset does not match manifest: ${expectedAsset.path}`);
  }
  return {
    health: { status: health.status, db: health.db, version: health.version },
    asset: { path: expectedAsset.path, bytes: assetBody.byteLength, sha256: assetSha256 },
  };
}

export async function retryUntilReady(operation, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 100;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 2_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    !Number.isFinite(attemptTimeoutMs) ||
    attemptTimeoutMs <= 0
  ) {
    throw new Error('Readiness timeouts and interval must be positive finite numbers.');
  }
  const started = now();
  let lastError;
  while (now() - started <= timeoutMs) {
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) break;
    const attemptBudget = Math.min(attemptTimeoutMs, remaining);
    const controller = new AbortController();
    let timer;
    try {
      return await new Promise((resolveAttempt, rejectAttempt) => {
        timer = setTimer(() => {
          controller.abort();
          rejectAttempt(new Error(`Readiness attempt exceeded ${attemptBudget}ms.`));
        }, attemptBudget);
        Promise.resolve(operation({ signal: controller.signal })).then(
          resolveAttempt,
          rejectAttempt,
        );
      });
    } catch (error) {
      lastError = error;
    } finally {
      if (timer !== undefined) clearTimer(timer);
      controller.abort();
    }
    const remainingAfterAttempt = timeoutMs - (now() - started);
    if (remainingAfterAttempt <= 0) break;
    await sleep(Math.min(intervalMs, remainingAfterAttempt));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Runtime did not become ready within ${timeoutMs}ms: ${detail}`, {
    cause: lastError,
  });
}

export async function verifyApplicationOrigin({
  origin,
  manifestPath,
  manifest: providedManifest,
  readinessTimeoutMs = 15_000,
}) {
  const normalizedOrigin = new URL(origin).origin;
  if (normalizedOrigin !== origin)
    throw new Error(`Application origin must be canonical: ${origin}`);
  const manifest = providedManifest ?? readManifest(manifestPath);
  const application = await retryUntilReady(
    ({ signal }) => verifyApplicationOnce(normalizedOrigin, manifest, signal),
    { timeoutMs: readinessTimeoutMs },
  );
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    origin: normalizedOrigin,
    ...application,
  };
}

function runtimeContract({ release, manifest, label, port, nodePath, home, uid }) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Runtime port must be an integer between 1 and 65535.');
  }
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('Runtime verification requires a valid user identity.');
  }
  const expectedNode = resolve(nodePath ?? manifest.toolchain.nodePath);
  const expectedCli = resolve(release, 'server/dist/cli.js');
  const dataDirectory = resolve(home, '.journal');
  const logDirectory = resolve(dataDirectory, 'logs');
  const expectedEnvironment = {
    NODE_ENV: 'production',
    JOURNAL_CONFIG: resolve(dataDirectory, 'config.json'),
    JOURNAL_DATA_DIR: dataDirectory,
    JOURNAL_PORT: String(port),
    JOURNAL_BIND_HOST: '127.0.0.1',
    JOURNAL_HOSTS: 'localhost:5178,127.0.0.1:5178,mickey-home.tail8a9beb.ts.net:5178',
    JOURNAL_TZ: 'Europe/Amsterdam',
    JOURNAL_DAY_BOUNDARY_OFFSET_MIN: '0',
    JOURNAL_VERSION: manifest.release.version,
    JOURNAL_TAILNET_HOST: 'mickey-home.tail8a9beb.ts.net:5178',
  };
  const expectedArguments = launchAgentProgramArguments(
    expectedEnvironment,
    expectedNode,
    expectedCli,
  );
  return {
    expectedNode,
    expectedCli,
    expectedEnvironment,
    expectedCommand: [expectedNode, expectedCli, 'serve'].join(' '),
    expectedListener: `127.0.0.1:${port}`,
    serviceTarget: `gui/${uid}/${label}`,
    expectedPlist: {
      label,
      programArguments: expectedArguments,
      environment: expectedEnvironment,
      workingDirectory: release,
      stdoutPath: resolve(logDirectory, 'launchd.out.log'),
      stderrPath: resolve(logDirectory, 'launchd.err.log'),
    },
  };
}

function isCanonicalTimestamp(valueToCheck) {
  return (
    typeof valueToCheck === 'string' &&
    Number.isFinite(Date.parse(valueToCheck)) &&
    new Date(valueToCheck).toISOString() === valueToCheck
  );
}

function assertPriorRuntimeBinding(priorRuntime, release, manifest, contract) {
  if (!isRecord(priorRuntime) || priorRuntime.schemaVersion !== 1) {
    throw new Error('Prior runtime evidence is not a supported verifyRuntime result.');
  }
  if (!isCanonicalTimestamp(priorRuntime.checkedAt)) {
    throw new Error('Prior runtime evidence has no canonical checkedAt timestamp.');
  }
  if (priorRuntime.releaseRoot !== release || priorRuntime.workingDirectory !== release) {
    throw new Error('Prior runtime evidence is bound to a different release directory.');
  }
  if (priorRuntime.version !== manifest.release.version) {
    throw new Error('Prior runtime evidence is bound to a different release version.');
  }
  if (!Number.isSafeInteger(priorRuntime.pid) || priorRuntime.pid <= 0) {
    throw new Error('Prior runtime evidence has no valid launchd PID.');
  }
  if (
    priorRuntime.listener !== contract.expectedListener ||
    priorRuntime.node !== contract.expectedNode ||
    priorRuntime.cli !== contract.expectedCli ||
    priorRuntime.config !== contract.expectedEnvironment.JOURNAL_CONFIG ||
    priorRuntime.dataDirectory !== contract.expectedEnvironment.JOURNAL_DATA_DIR
  ) {
    throw new Error('Prior runtime evidence does not match the expected runtime contract.');
  }
  if (
    !isRecord(priorRuntime.workingDirectoryIdentity) ||
    !/^[0-9]+$/.test(priorRuntime.workingDirectoryIdentity.device ?? '') ||
    !/^[0-9]+$/.test(priorRuntime.workingDirectoryIdentity.inode ?? '')
  ) {
    throw new Error('Prior runtime evidence has no valid working-directory identity.');
  }
  assertObservedDirectory(
    {
      path: priorRuntime.workingDirectory,
      device: priorRuntime.workingDirectoryIdentity.device,
      inode: priorRuntime.workingDirectoryIdentity.inode,
    },
    release,
    'Prior runtime cwd',
  );
  const expectedEnvironmentProof = assertExactProcessEnvironment(
    contract.expectedEnvironment,
    contract.expectedEnvironment,
  );
  if (
    !isRecord(priorRuntime.environment) ||
    !sameSortedEntries(priorRuntime.environment, expectedEnvironmentProof)
  ) {
    throw new Error('Prior runtime evidence has a different effective environment contract.');
  }
}

export async function recheckRuntimeBinding(
  {
    releaseRoot,
    manifestPath,
    priorRuntime,
    label = 'com.rsreberski.journald',
    port = 5178,
    nodePath,
    home = homedir(),
    signal,
  },
  dependencies = {},
) {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'darwin') {
    throw new Error('Runtime binding recheck requires macOS.');
  }
  const release = resolve(releaseRoot);
  if (releaseRoot !== release) {
    throw new Error('Runtime release root must use its canonical absolute spelling.');
  }
  assertCanonicalReleaseDirectory(release, home);
  const manifest = readManifest(manifestPath);
  const uid = dependencies.uid ?? process.getuid?.();
  const contract = runtimeContract({ release, manifest, label, port, nodePath, home, uid });
  assertPriorRuntimeBinding(priorRuntime, release, manifest, contract);

  const runCommand = dependencies.runCommand ?? command;
  const launchOutput = await runCommand(
    '/bin/launchctl',
    ['print', contract.serviceTarget],
    signal,
  );
  if (
    launchdPid(launchOutput) !== priorRuntime.pid ||
    launchdWorkingDirectory(launchOutput) !== release
  ) {
    throw new Error('launchd PID or working directory changed after runtime verification.');
  }

  const listenerOutput = await runCommand(
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(priorRuntime.pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'],
    signal,
  );
  const listeners = listenersFromLsof(listenerOutput);
  if (
    listeners.length !== 1 ||
    listeners[0].pid !== priorRuntime.pid ||
    listeners[0].name !== priorRuntime.listener ||
    listeners[0].name !== contract.expectedListener
  ) {
    throw new Error('Journald listener changed after runtime verification.');
  }

  const cwdOutput = await runCommand(
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(priorRuntime.pid), '-d', 'cwd', '-FpfDin'],
    signal,
  );
  const processWorkingDirectory = cwdIdentityFromLsof(cwdOutput, priorRuntime.pid);
  if (processWorkingDirectory.path !== release) {
    throw new Error('Journald cwd changed after runtime verification.');
  }
  const workingDirectoryIdentity = assertObservedDirectory(
    processWorkingDirectory,
    release,
    'Rechecked launchd PID cwd',
  );
  if (
    workingDirectoryIdentity.device !== priorRuntime.workingDirectoryIdentity.device ||
    workingDirectoryIdentity.inode !== priorRuntime.workingDirectoryIdentity.inode
  ) {
    throw new Error('Journald cwd identity changed after runtime verification.');
  }

  const processEnvironmentOutput = await runCommand(
    '/bin/ps',
    ['eww', '-p', String(priorRuntime.pid), '-o', 'command='],
    signal,
  );
  const processEnvironment = assertExactProcessEnvironment(
    processEnvironmentFromPs(processEnvironmentOutput, contract.expectedCommand),
    contract.expectedEnvironment,
  );
  if (!sameSortedEntries(processEnvironment, priorRuntime.environment)) {
    throw new Error('Journald effective environment changed after runtime verification.');
  }

  const finalLaunchOutput = await runCommand(
    '/bin/launchctl',
    ['print', contract.serviceTarget],
    signal,
  );
  if (
    launchdPid(finalLaunchOutput) !== priorRuntime.pid ||
    launchdWorkingDirectory(finalLaunchOutput) !== release
  ) {
    throw new Error('launchd binding changed during the non-HTTP runtime recheck.');
  }

  const checkedAtValue = (dependencies.now ?? (() => new Date()))();
  if (!(checkedAtValue instanceof Date) || !Number.isFinite(checkedAtValue.getTime())) {
    throw new Error('Runtime binding recheck clock returned an invalid Date.');
  }
  return {
    schemaVersion: 1,
    checkedAt: checkedAtValue.toISOString(),
    protocol: 'launchctl-ps-lsof-only-v1',
    priorRuntimeCheckedAt: priorRuntime.checkedAt,
    releaseRoot: release,
    version: manifest.release.version,
    pid: priorRuntime.pid,
    listener: listeners[0].name,
    node: contract.expectedNode,
    cli: contract.expectedCli,
    workingDirectory: processWorkingDirectory.path,
    workingDirectoryIdentity,
    config: contract.expectedEnvironment.JOURNAL_CONFIG,
    dataDirectory: contract.expectedEnvironment.JOURNAL_DATA_DIR,
    environment: processEnvironment,
    commandPaths: ['/bin/launchctl', '/bin/ps', '/usr/sbin/lsof'],
    applicationHttpRequests: 0,
    applicationLogWrites: 0,
  };
}

export async function verifyRuntime({
  releaseRoot,
  manifestPath,
  label = 'com.rsreberski.journald',
  port = 5178,
  nodePath,
  home = homedir(),
  readinessTimeoutMs = 15_000,
}) {
  if (process.platform !== 'darwin')
    throw new Error('Runtime adoption verification requires macOS.');
  const release = resolve(releaseRoot);
  if (releaseRoot !== release) {
    throw new Error('Runtime release root must use its canonical absolute spelling.');
  }
  assertCanonicalReleaseDirectory(release, home);
  const manifest = readManifest(manifestPath);
  const plistPath = resolve(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const contract = runtimeContract({
    release,
    manifest,
    label,
    port,
    nodePath,
    home,
    uid: process.getuid?.(),
  });
  const {
    expectedNode,
    expectedCli,
    expectedEnvironment,
    expectedCommand,
    serviceTarget,
    expectedPlist,
  } = contract;
  return withStableLaunchAgentPlist(
    (baseline) => inspectLaunchAgentPlist(plistPath, expectedPlist, baseline),
    () =>
      retryUntilReady(
        async ({ signal }) => {
          // A refused loopback fetch is cheap while launchd is still starting. Defer
          // PID-scoped lsof until the exact app is responsive so readiness polling
          // cannot starve a cold Node process on a busy host.
          const application = await verifyApplicationOnce(
            `http://127.0.0.1:${port}`,
            manifest,
            signal,
          );
          const launchOutput = await command('/bin/launchctl', ['print', serviceTarget], signal);
          const pid = launchdPid(launchOutput);
          const loadedWorkingDirectory = launchdWorkingDirectory(launchOutput);
          if (loadedWorkingDirectory !== release) {
            throw new Error('The loaded launchd job did not adopt the attested working directory.');
          }
          const lsof = await command(
            '/usr/sbin/lsof',
            ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'],
            signal,
          );
          const listeners = listenersFromLsof(lsof);
          if (
            listeners.length !== 1 ||
            listeners[0].pid !== pid ||
            listeners[0].name !== `127.0.0.1:${port}`
          ) {
            throw new Error(
              `Expected the launchd PID to own exactly one loopback listener, received ${JSON.stringify(listeners)}.`,
            );
          }

          const cwdOutput = await command(
            '/usr/sbin/lsof',
            ['-nP', '-a', '-p', String(pid), '-d', 'cwd', '-FpfDin'],
            signal,
          );
          const processWorkingDirectory = cwdIdentityFromLsof(cwdOutput, pid);
          if (processWorkingDirectory.path !== release) {
            throw new Error('The launchd PID did not adopt the attested working directory.');
          }
          const workingDirectoryIdentity = assertObservedDirectory(
            processWorkingDirectory,
            release,
            'Launchd PID cwd',
          );
          const processEnvironmentOutput = await command(
            '/bin/ps',
            ['eww', '-p', String(pid), '-o', 'command='],
            signal,
          );
          const processEnvironment = assertExactProcessEnvironment(
            processEnvironmentFromPs(processEnvironmentOutput, expectedCommand),
            expectedEnvironment,
          );

          const finalLaunchOutput = await command(
            '/bin/launchctl',
            ['print', serviceTarget],
            signal,
          );
          if (
            launchdPid(finalLaunchOutput) !== pid ||
            launchdWorkingDirectory(finalLaunchOutput) !== release
          ) {
            throw new Error(
              'launchd PID or working directory changed during runtime verification.',
            );
          }
          const finalCwdOutput = await command(
            '/usr/sbin/lsof',
            ['-nP', '-a', '-p', String(pid), '-d', 'cwd', '-FpfDin'],
            signal,
          );
          const finalWorkingDirectory = cwdIdentityFromLsof(finalCwdOutput, pid);
          if (
            finalWorkingDirectory.path !== release ||
            finalWorkingDirectory.device !== workingDirectoryIdentity.device ||
            finalWorkingDirectory.inode !== workingDirectoryIdentity.inode
          ) {
            throw new Error('launchd PID cwd changed during runtime adoption verification.');
          }
          assertObservedDirectory(finalWorkingDirectory, release, 'Final launchd PID cwd');
          const finalProcessEnvironmentOutput = await command(
            '/bin/ps',
            ['eww', '-p', String(pid), '-o', 'command='],
            signal,
          );
          const finalProcessEnvironment = assertExactProcessEnvironment(
            processEnvironmentFromPs(finalProcessEnvironmentOutput, expectedCommand),
            expectedEnvironment,
          );
          if (JSON.stringify(finalProcessEnvironment) !== JSON.stringify(processEnvironment)) {
            throw new Error(
              'launchd PID effective environment changed during runtime verification.',
            );
          }

          return {
            schemaVersion: 1,
            checkedAt: new Date().toISOString(),
            releaseRoot: release,
            version: manifest.release.version,
            pid,
            listener: listeners[0].name,
            node: expectedNode,
            cli: expectedCli,
            workingDirectory: processWorkingDirectory.path,
            workingDirectoryIdentity,
            config: expectedEnvironment.JOURNAL_CONFIG,
            dataDirectory: expectedEnvironment.JOURNAL_DATA_DIR,
            environment: processEnvironment,
            health: application.health,
            asset: application.asset,
          };
        },
        { timeoutMs: readinessTimeoutMs, attemptTimeoutMs: Math.min(12_000, readinessTimeoutMs) },
      ),
  );
}

async function runCli() {
  const args = process.argv.slice(2);
  const manifestPath = value(args, '--manifest');
  if (args.includes('--origin-only')) {
    if (!manifestPath) throw new Error('--manifest is required with --origin-only.');
    const result = await verifyApplicationOrigin({
      origin: value(args, '--origin', 'https://mickey-home.tail8a9beb.ts.net:5178'),
      manifestPath,
      readinessTimeoutMs: Number(value(args, '--timeout-ms', '15000')),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const releaseRoot = value(args, '--release');
  if (!releaseRoot || !manifestPath) {
    throw new Error('Usage: release-verify-runtime.mjs --release <dir> --manifest <file>');
  }
  const result = await verifyRuntime({
    releaseRoot,
    manifestPath,
    label: value(args, '--label', 'com.rsreberski.journald'),
    port: Number(value(args, '--port', '5178')),
    nodePath: value(args, '--node'),
    readinessTimeoutMs: Number(value(args, '--timeout-ms', '15000')),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
