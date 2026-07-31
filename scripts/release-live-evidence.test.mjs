/* global Buffer, process, Response, URL */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { createDeployedTreeAttestation } from './release-deployed-tree.mjs';
import {
  collectLiveContextEvidence,
  createLoopbackTokenManager,
  defaultCommandRunner,
  inspectOperationalLogs,
  inspectStructuredLogBuffer,
  loadReleaseBinding,
  parseTcpSockets,
  writeLiveContextEvidence,
} from './release-live-evidence.mjs';
import {
  assertExactProcessEnvironment,
  launchAgentProgramArguments,
  processEnvironmentFromPs,
} from './release-verify-runtime.mjs';

const LABEL = 'com.rsreberski.journald';
const ORIGIN = 'https://mickey-home.tail8a9beb.ts.net:5178';
const TOOLS = [
  'add_entry',
  'add_to_collection',
  'list_day',
  'search',
  'update_entry',
  'delete_entry',
  'propose_migration',
];

test('default command runner retains a bounded process inventory larger than one MiB', async () => {
  const bytes = 1_100_000;
  const result = await defaultCommandRunner(
    process.execPath,
    ['-e', `process.stdout.write('x'.repeat(${bytes}))`],
    { timeoutMs: 5_000 },
  );

  assert.equal(result.stdout.length, bytes);
});

function temporaryFixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'journal-live-evidence-'));
  const home = resolve(root, 'home');
  const releaseRoot = resolve(root, 'release');
  const nodePath = resolve(root, 'node');
  const cliPath = resolve(releaseRoot, 'server/dist/cli.js');
  const plistPath = resolve(home, 'Library/LaunchAgents', `${LABEL}.plist`);
  const logDirectory = resolve(home, '.journal/logs');
  mkdirSync(resolve(home, 'Library/LaunchAgents'), { recursive: true });
  mkdirSync(logDirectory, { recursive: true });
  mkdirSync(resolve(releaseRoot, 'server/dist'), { recursive: true });
  writeFileSync(plistPath, 'attested plist fixture\n', { mode: 0o600 });
  chmodSync(plistPath, 0o600);
  writeFileSync(resolve(logDirectory, 'launchd.out.log'), '', { mode: 0o600 });
  const structuredLines = [
    {
      level: 30,
      time: 1_775_000_000_000,
      pid: 4242,
      hostname: 'mickey-home',
      operation: 'server_started',
      host: '127.0.0.1',
      port: 5178,
      version: '1.0.0',
    },
    {
      level: 30,
      time: 1_775_000_000_001,
      pid: 4242,
      hostname: 'mickey-home',
      operation: 'http_request',
      method: 'POST',
      path: '/mcp',
      status: 200,
      durationMs: 4.5,
    },
    {
      level: 30,
      time: 1_775_000_000_002,
      pid: 4242,
      hostname: 'mickey-home',
      operation: 'mcp_tool_call',
      tool: 'search',
      tokenId: '01J00000000000000000000001',
      tokenLabel: 'release-live-20260731T120000Z-abcdef123456-99',
      durationMs: 1.25,
      outcome: 'success',
    },
  ];
  const currentLog = `${structuredLines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  writeFileSync(resolve(logDirectory, 'launchd.err.log'), currentLog, { mode: 0o600 });
  writeFileSync(resolve(logDirectory, 'journald.log'), currentLog, { mode: 0o600 });
  const rotationName = '20260731-1200-01-journald.log.gz';
  const stoppedLine = `${JSON.stringify({
    level: 30,
    time: 1_774_999_999_999,
    pid: 4141,
    hostname: 'mickey-home',
    operation: 'server_stopped',
  })}\n`;
  writeFileSync(resolve(logDirectory, rotationName), gzipSync(stoppedLine), { mode: 0o600 });
  writeFileSync(resolve(logDirectory, 'journald.log.txt'), `${rotationName}\n`, { mode: 0o600 });
  const binding = {
    releaseStamp: '20260731T120000Z-abcdef123456-99',
    baseCommit: 'abcdef1234567890',
    manifestSha256: '1'.repeat(64),
    archiveSha256: '2'.repeat(64),
    releaseRoot,
    manifest: {
      release: { version: '1.0.0' },
      toolchain: { nodePath },
    },
  };
  const environment = {
    NODE_ENV: 'production',
    JOURNAL_CONFIG: resolve(home, '.journal/config.json'),
    JOURNAL_DATA_DIR: resolve(home, '.journal'),
    JOURNAL_PORT: '5178',
    JOURNAL_BIND_HOST: '127.0.0.1',
    JOURNAL_HOSTS: 'localhost:5178,127.0.0.1:5178,mickey-home.tail8a9beb.ts.net:5178',
    JOURNAL_TZ: 'Europe/Amsterdam',
    JOURNAL_DAY_BOUNDARY_OFFSET_MIN: '0',
    JOURNAL_VERSION: '1.0.0',
    JOURNAL_TAILNET_HOST: 'mickey-home.tail8a9beb.ts.net:5178',
  };
  const plist = {
    Label: LABEL,
    ProgramArguments: launchAgentProgramArguments(environment, nodePath, cliPath),
    WorkingDirectory: releaseRoot,
    EnvironmentVariables: environment,
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: 'Interactive',
    StandardOutPath: resolve(logDirectory, 'launchd.out.log'),
    StandardErrorPath: resolve(logDirectory, 'launchd.err.log'),
  };
  return { root, home, binding, plist, nodePath, cliPath };
}

function sha256FileFixture(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function commandRunner(fixture, options = {}) {
  const pid = options.pid ?? 4242;
  let launchPrintCount = 0;
  let cwdInspectionCount = 0;
  let environmentInspectionCount = 0;
  const releaseIdentity = statSync(fixture.binding.releaseRoot, { bigint: true });
  const calls = [];
  const runner = async (command, arguments_) => {
    calls.push([command, ...arguments_]);
    if (command === '/bin/launchctl' && arguments_[0] === 'print') {
      launchPrintCount += 1;
      const reportedPid =
        launchPrintCount > 2
          ? (options.postLogPid ?? options.finalPid ?? pid)
          : launchPrintCount > 1
            ? (options.finalPid ?? pid)
            : pid;
      const workingDirectory =
        launchPrintCount > 2
          ? (options.postLogLaunchWorkingDirectory ??
            options.finalLaunchWorkingDirectory ??
            options.launchWorkingDirectory ??
            fixture.binding.releaseRoot)
          : launchPrintCount > 1
            ? (options.finalLaunchWorkingDirectory ??
              options.launchWorkingDirectory ??
              fixture.binding.releaseRoot)
            : (options.launchWorkingDirectory ?? fixture.binding.releaseRoot);
      return {
        stdout: `state = running\n\tpid = ${reportedPid}\n\tworking directory = ${workingDirectory}\n`,
      };
    }
    if (command === '/bin/launchctl' && arguments_[0] === 'list') {
      return {
        stdout: `PID\tStatus\tLabel\n${pid}\t0\t${LABEL}\n${
          options.extraJournalLabel ? `-\t0\t${options.extraJournalLabel}\n` : ''
        }`,
      };
    }
    if (command === '/usr/bin/plutil') {
      return {
        stdout: JSON.stringify({
          ...fixture.plist,
          WorkingDirectory: options.plistWorkingDirectory ?? fixture.plist.WorkingDirectory,
          EnvironmentVariables: {
            ...fixture.plist.EnvironmentVariables,
            ...(options.extraEnvironment ?? {}),
          },
        }),
      };
    }
    if (command === '/bin/ps' && arguments_[0] === 'eww') {
      environmentInspectionCount += 1;
      const effectiveEnvironment = {
        ...fixture.plist.EnvironmentVariables,
        ...(options.extraEffectiveEnvironment ?? {}),
        ...(environmentInspectionCount > 1 ? (options.finalExtraEffectiveEnvironment ?? {}) : {}),
      };
      return {
        stdout: `${fixture.nodePath} ${fixture.cliPath} serve ${Object.entries(effectiveEnvironment)
          .map(([key, value]) => `${key}=${value}`)
          .join(' ')}\n`,
      };
    }
    if (command === '/bin/ps') {
      return {
        stdout: `1 0 /sbin/launchd\n${pid} 1 ${fixture.nodePath} ${fixture.cliPath} serve\n`,
      };
    }
    if (command === '/usr/sbin/lsof') {
      if (arguments_.includes('-d')) {
        cwdInspectionCount += 1;
        const final = cwdInspectionCount > 1;
        const workingDirectory = final
          ? (options.finalProcessWorkingDirectory ??
            options.processWorkingDirectory ??
            fixture.binding.releaseRoot)
          : (options.processWorkingDirectory ?? fixture.binding.releaseRoot);
        const device = final
          ? (options.finalProcessDevice ?? options.processDevice ?? releaseIdentity.dev.toString())
          : (options.processDevice ?? releaseIdentity.dev.toString());
        const inode = final
          ? (options.finalProcessInode ?? options.processInode ?? releaseIdentity.ino.toString())
          : (options.processInode ?? releaseIdentity.ino.toString());
        return {
          stdout: `p${pid}\nfcwd\nD${device}\ni${inode}\nn${workingDirectory}\n`,
        };
      }
      return {
        stdout:
          options.lsof ??
          `p${pid}\nf10\nPTCP\nn127.0.0.1:5178\nTST=LISTEN\nf11\nPTCP\nn127.0.0.1:5178->127.0.0.1:61000\nTST=ESTABLISHED\n`,
      };
    }
    throw new Error(`Unexpected command fixture: ${command}`);
  };
  return { calls, runner };
}

function jsonResponse(body, options = {}) {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(options.sessionId ? { 'mcp-session-id': options.sessionId } : {}),
      ...(options.headers ?? {}),
    },
  });
}

function tokenRecord(id, label, revokedAt = null) {
  return {
    id,
    label,
    scopes: ['journal:full'],
    createdAt: '2026-07-31T12:00:00.000Z',
    lastUsedAt: null,
    revokedAt,
  };
}

function successfulFetch(secretSentinel, journalSentinel, sessionSentinel) {
  const requests = [];
  const responses = [
    jsonResponse(
      {
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-06-18', instructions: journalSentinel },
      },
      { sessionId: sessionSentinel },
    ),
    jsonResponse({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: TOOLS.map((name) => ({ name })) },
    }),
    jsonResponse({
      jsonrpc: '2.0',
      id: 3,
      result: {
        structuredContent: { total: 1, entries: [{ text: journalSentinel }] },
        content: [{ type: 'text', text: journalSentinel }],
      },
    }),
    new Response(null, { status: 200 }),
    new Response(secretSentinel, { status: 401 }),
  ];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url, init });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected extra fetch');
      return response;
    },
  };
}

test('effective process environment parser accepts only the exact isolated allowlist', () => {
  const expectedCommand = '/opt/node /release/server/dist/cli.js serve';
  const expectedEnvironment = {
    JOURNAL_CONFIG: '/home/.journal/config.json',
    JOURNAL_PORT: '5178',
    NODE_ENV: 'production',
  };
  const environment = processEnvironmentFromPs(
    `${expectedCommand} JOURNAL_CONFIG=/home/.journal/config.json JOURNAL_PORT=5178 NODE_ENV=production\n`,
    expectedCommand,
  );
  assert.deepEqual(assertExactProcessEnvironment(environment, expectedEnvironment), {
    keys: ['JOURNAL_CONFIG', 'JOURNAL_PORT', 'NODE_ENV'],
    unexpectedKeys: [],
    credentialKeys: [],
    isolatedBy: '/usr/bin/env -i',
    providerOrSchedulerConfigurationAbsent: true,
  });
  assert.throws(
    () =>
      assertExactProcessEnvironment(
        processEnvironmentFromPs(
          `${expectedCommand} JOURNAL_CONFIG=/home/.journal/config.json JOURNAL_PORT=5178 NODE_ENV=production TODOIST_API_TOKEN=not-recorded\n`,
          expectedCommand,
        ),
        expectedEnvironment,
      ),
    (error) => {
      assert.match(error.message, /unexpected keys: TODOIST_API_TOKEN/);
      assert.doesNotMatch(error.message, /not-recorded/);
      return true;
    },
  );
  assert.throws(
    () =>
      processEnvironmentFromPs('/other/node cli.js serve NODE_ENV=production\n', expectedCommand),
    /exact journald command/,
  );
  assert.throws(
    () =>
      processEnvironmentFromPs(
        `${expectedCommand} JOURNAL_CONFIG=/home/.journal/config.json unparsed JOURNAL_PORT=5178 NODE_ENV=production\n`,
        expectedCommand,
      ),
    /malformed/,
  );
});

test('live context evidence is release-bound, metadata-only, redacted, and owner-only', async () => {
  const fixture = temporaryFixture();
  try {
    const command = commandRunner(fixture);
    const secretSentinel = 'jrn_SECRET_SENTINEL_that_must_never_be_recorded';
    const journalSentinel = 'PRIVATE JOURNAL CONTENT SENTINEL';
    const sessionSentinel = 'SESSION_SENTINEL_not_evidence';
    const network = successfulFetch(secretSentinel, journalSentinel, sessionSentinel);
    const tokenCalls = { revoked: [], closes: 0 };
    const evidence = await collectLiveContextEvidence(
      fixture.binding,
      {
        home: fixture.home,
        uid: 501,
        platform: 'darwin',
        origin: ORIGIN,
        commandTimeoutMs: 100,
        requestTimeoutMs: 100,
      },
      {
        runCommand: command.runner,
        fetch: network.fetch,
        tokenManagerFactory: async () => ({
          create: () => ({ id: '01J00000000000000000000001', secret: secretSentinel }),
          revoke: (id) => tokenCalls.revoked.push(id),
          close: () => {
            tokenCalls.closes += 1;
          },
        }),
        now: () => new Date('2026-07-31T12:30:00.000Z'),
      },
    );

    assert.equal(evidence.releaseStamp, fixture.binding.releaseStamp);
    assert.equal(evidence.baseCommit, fixture.binding.baseCommit);
    assert.equal(evidence.manifestSha256, fixture.binding.manifestSha256);
    assert.equal(evidence.archiveSha256, fixture.binding.archiveSha256);
    assert.equal(evidence.releaseRoot, fixture.binding.releaseRoot);
    assert.equal(evidence.service.pid, 4242);
    assert.equal(evidence.service.plist.workingDirectory, fixture.binding.releaseRoot);
    assert.equal(evidence.service.process.workingDirectory, fixture.binding.releaseRoot);
    assert.match(evidence.service.process.workingDirectoryIdentity.device, /^[0-9]+$/);
    assert.match(evidence.service.process.workingDirectoryIdentity.inode, /^[0-9]+$/);
    assert.deepEqual(evidence.service.process.descendants, []);
    assert.deepEqual(evidence.service.process.extraJournalLaunchdJobs, []);
    assert.equal(evidence.service.process.environment.isolatedBy, '/usr/bin/env -i');
    assert.equal(evidence.service.process.environment.providerOrSchedulerConfigurationAbsent, true);
    assert.deepEqual(evidence.service.process.environment.unexpectedKeys, []);
    assert.deepEqual(evidence.service.process.environment.credentialKeys, []);
    assert.deepEqual(Object.keys(evidence.service).sort(), [
      'environmentKeysAndValuesStableDuringCollection',
      'label',
      'logs',
      'pid',
      'pidStableDuringCollection',
      'plist',
      'process',
      'serviceTarget',
      'tcp',
      'workingDirectoryStableDuringCollection',
    ]);
    assert.equal(evidence.service.environmentKeysAndValuesStableDuringCollection, true);
    assert.equal(evidence.service.tcp.snapshots.length, 2);
    assert.equal(evidence.service.tcp.snapshots[1].phase, 'after-final-log-inspection');
    assert.deepEqual(evidence.service.tcp.unexpectedNonLoopbackSockets, []);
    assert.equal(evidence.service.logs.policy, 'strict-jsonl-allowlist');
    assert.equal(evidence.service.logs.launchdStdout.bytes, 0);
    assert.equal(evidence.service.logs.streams.length, 3);
    assert.equal(evidence.service.logs.streams[0].operations.mcp_tool_call, 1);
    assert.equal(evidence.service.logs.streams[2].operations.server_stopped, 1);
    assert.equal(
      evidence.service.logs.validationPhase,
      'after-mcp-smoke-before-final-runtime-recheck',
    );
    assert.equal(evidence.mcp.token.revokedProbeStatus, 401);
    assert.deepEqual(evidence.mcp.toolsList.names, TOOLS);
    assert.equal(evidence.mcp.read.journalContentRecorded, false);
    assert.equal(evidence.mcp.secretsRecorded, false);
    assert.deepEqual(tokenCalls.revoked, ['01J00000000000000000000001']);
    assert.equal(tokenCalls.closes, 1);
    assert.equal(network.requests.length, 5);
    assert.ok(
      network.requests.every(
        ({ url, init }) =>
          url === `${ORIGIN}/mcp` && init.headers.Authorization === `Bearer ${secretSentinel}`,
      ),
    );
    assert.equal(
      command.calls.filter(
        ([commandPath, action]) => commandPath === '/bin/launchctl' && action === 'print',
      ).length,
      3,
    );
    assert.equal(
      command.calls.filter(([commandPath, action]) => commandPath === '/bin/ps' && action === 'eww')
        .length,
      3,
    );
    assert.equal(
      command.calls.filter(
        ([commandPath, ...arguments_]) =>
          commandPath === '/usr/sbin/lsof' && arguments_.includes('-d'),
      ).length,
      3,
    );
    assert.equal(
      command.calls.filter(
        ([commandPath, ...arguments_]) =>
          commandPath === '/usr/sbin/lsof' && arguments_.includes('-iTCP'),
      ).length,
      3,
    );
    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /SECRET_SENTINEL|PRIVATE JOURNAL CONTENT|SESSION_SENTINEL/);

    const output = resolve(fixture.root, 'evidence/live-context.json');
    writeLiveContextEvidence(output, evidence);
    assert.equal(lstatSync(output).mode & 0o7777, 0o600);
    assert.doesNotMatch(readFileSync(output, 'utf8'), /SECRET_SENTINEL|PRIVATE JOURNAL CONTENT/);
    assert.throws(() => writeLiveContextEvidence(output, evidence), /EEXIST/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('release binding rejects drift and rollback before any live inspection', () => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'journal-live-binding-')));
  try {
    const stamp = '20260731T120000Z-abcdef123456-99';
    const home = resolve(root, 'home');
    const releaseRoot = resolve(home, '.journal/releases', stamp);
    const evidenceRoot = resolve(root, 'evidence');
    const scriptPath = resolve(releaseRoot, 'scripts/release-live-evidence.mjs');
    mkdirSync(resolve(releaseRoot, 'scripts'), { recursive: true });
    mkdirSync(evidenceRoot);
    copyFileSync(resolve(import.meta.dirname, 'release-live-evidence.mjs'), scriptPath);
    const scriptBody = readFileSync(scriptPath);
    const files = [
      {
        path: 'scripts/release-live-evidence.mjs',
        kind: 'file',
        mode: lstatSync(scriptPath).mode & 0o7777,
        bytes: scriptBody.byteLength,
        sha256: createHash('sha256').update(scriptBody).digest('hex'),
      },
    ];
    const directories = [];
    const treeSha256 = createHash('sha256')
      .update(Buffer.from(JSON.stringify({ directories, files })))
      .digest('hex');
    const manifestPath = resolve(evidenceRoot, 'manifest.json');
    const archivePath = resolve(evidenceRoot, 'archive.tgz');
    const attestationPath = resolve(evidenceRoot, 'attestation.json');
    const contextPath = resolve(evidenceRoot, 'release-context.json');
    const cutoverPath = resolve(evidenceRoot, `cutover-${stamp}.json`);
    const outputPath = resolve(evidenceRoot, 'live-context-20260731T120000Z-abcdef123456-99.json');
    const baseCommit = 'abcdef1234567890';
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 2,
        git: { baseCommit },
        release: { version: '1.0.0' },
        toolchain: { node: process.version, nodePath: process.execPath },
        treeSha256,
        directories,
        files,
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(archivePath, 'attested archive\n', { mode: 0o600 });
    const manifestSha256 = sha256FileFixture(manifestPath);
    const archiveSha256 = sha256FileFixture(archivePath);
    writeFileSync(
      attestationPath,
      `${JSON.stringify({
        releaseStamp: stamp,
        baseCommit,
        releaseVersion: '1.0.0',
        treeSha256,
        extractedTreeVerified: true,
        manifest: { sha256: manifestSha256 },
        archive: { sha256: archiveSha256 },
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      contextPath,
      `${JSON.stringify({
        schemaVersion: 1,
        releaseStamp: stamp,
        releaseRoot,
        manifest: manifestPath,
        archive: archivePath,
        attestation: attestationPath,
        baseCommit,
        manifestSha256,
        archiveSha256,
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      cutoverPath,
      `${JSON.stringify({
        schemaVersion: 1,
        releaseStamp: stamp,
        baseCommit,
        manifestSha256,
        archiveSha256,
        currentReleaseUnchanged: true,
        runtime: { releaseRoot },
      })}\n`,
      { mode: 0o600 },
    );
    chmodSync(scriptPath, 0o500);
    chmodSync(resolve(releaseRoot, 'scripts'), 0o500);
    chmodSync(releaseRoot, 0o500);
    createDeployedTreeAttestation({
      contextPath,
      root: releaseRoot,
      outputPath: resolve(evidenceRoot, `deployed-tree-${stamp}.json`),
    });

    assert.throws(
      () => loadReleaseBinding({ contextPath, outputPath, selfPath: scriptPath }),
      /versioned directory/,
    );
    const loaded = loadReleaseBinding({ contextPath, outputPath, selfPath: scriptPath, home });
    assert.equal(loaded.releaseStamp, stamp);
    assert.equal(loaded.deployedTree.releaseRoot, releaseRoot);
    assert.equal(loaded.deployedTree.paths, 2);
    assert.throws(
      () =>
        loadReleaseBinding({
          contextPath,
          outputPath,
          selfPath: resolve(root, 'different-release/scripts/release-live-evidence.mjs'),
          home,
        }),
      /Staged live-evidence helper path/,
    );
    const cutover = JSON.parse(readFileSync(cutoverPath, 'utf8'));
    writeFileSync(
      cutoverPath,
      `${JSON.stringify({
        ...cutover,
        runtime: { releaseRoot: resolve(root, 'different-release') },
      })}\n`,
      { mode: 0o600 },
    );
    assert.throws(
      () => loadReleaseBinding({ contextPath, outputPath, selfPath: scriptPath, home }),
      /Cutover release root/,
    );
    writeFileSync(cutoverPath, `${JSON.stringify(cutover)}\n`, { mode: 0o600 });
    writeFileSync(archivePath, 'drifted archive\n');
    assert.throws(
      () => loadReleaseBinding({ contextPath, outputPath, selfPath: scriptPath, home }),
      /Archive hash/,
    );
    writeFileSync(archivePath, 'attested archive\n');
    writeFileSync(resolve(evidenceRoot, `rollback-${stamp}.json`), '{}\n');
    assert.throws(
      () => loadReleaseBinding({ contextPath, outputPath, selfPath: scriptPath, home }),
      /rollback evidence/,
    );
  } finally {
    const immutableRelease = resolve(
      root,
      'home/.journal/releases/20260731T120000Z-abcdef123456-99',
    );
    if (existsSync(immutableRelease)) chmodSync(immutableRelease, 0o700);
    const scriptsDirectory = resolve(immutableRelease, 'scripts');
    if (existsSync(scriptsDirectory)) chmodSync(scriptsDirectory, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test('loopback token manager keeps owner credentials in memory and revokes through REST', async () => {
  const pairCookie = `journal_device=${'p'.repeat(48)}`;
  const label = 'release-live-test';
  const tokenId = '01J00000000000000000000008';
  const activeToken = tokenRecord(tokenId, label);
  const revokedToken = tokenRecord(tokenId, label, '2026-07-31T12:01:00.000Z');
  const requests = [];
  const responses = [
    jsonResponse(
      { deviceId: '01J00000000000000000000009', expiresAt: '2027-07-31T12:00:00.000Z' },
      { status: 201, headers: { 'set-cookie': `${pairCookie}; Path=/; HttpOnly; Secure` } },
    ),
    jsonResponse({ tokens: [] }),
    jsonResponse(
      {
        token: activeToken,
        secret: 'jrn_LOOPBACK_SECRET_SENTINEL',
      },
      { status: 201 },
    ),
    jsonResponse({ tokens: [activeToken] }),
    jsonResponse({ revoked: true, id: tokenId }),
    jsonResponse({ tokens: [revokedToken] }),
  ];
  const manager = createLoopbackTokenManager({
    label,
    port: 5178,
    requestTimeoutMs: 100,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return responses.shift();
    },
  });
  const token = await manager.create();
  assert.equal(token.id, tokenId);
  await manager.revoke(token.id);
  manager.close();
  assert.equal(requests.length, 6);
  assert.equal(requests[0].url, 'http://127.0.0.1:5178/api/pair');
  assert.equal(requests[0].init.headers.Origin, 'http://127.0.0.1:5178');
  assert.equal(requests[1].init.method, 'GET');
  assert.equal(requests[1].init.headers.Cookie, pairCookie);
  assert.equal(requests[2].init.headers.Cookie, pairCookie);
  assert.equal(requests[3].init.method, 'GET');
  assert.equal(requests[4].init.method, 'DELETE');
  assert.equal(requests[5].init.method, 'GET');
});

test('loopback token manager recovers a committed create whose response was lost', async () => {
  const pairCookie = `journal_device=${'q'.repeat(48)}`;
  const label = 'release-live-20260731T120000Z-abcdef123456-99';
  const createdId = '01J00000000000000000000018';
  const unrelatedId = '01J00000000000000000000019';
  const secretSentinel = 'jrn_LOST_CREATE_RESPONSE_SECRET_SENTINEL';
  const requests = [];
  let tokens = [tokenRecord(unrelatedId, 'persistent-owner-token')];

  const manager = createLoopbackTokenManager({
    label,
    port: 5178,
    requestTimeoutMs: 100,
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/api/pair')) {
        return jsonResponse(
          { deviceId: '01J00000000000000000000020', expiresAt: '2027-07-31T12:00:00.000Z' },
          { status: 201, headers: { 'set-cookie': `${pairCookie}; Path=/; HttpOnly; Secure` } },
        );
      }
      if (url.endsWith('/api/tokens') && init.method === 'GET') {
        return jsonResponse({ tokens });
      }
      if (url.endsWith('/api/tokens') && init.method === 'POST') {
        tokens = [tokenRecord(createdId, label), ...tokens];
        // The server committed a one-time secret, but the client never receives it.
        throw new Error('injected connection loss after token commit');
      }
      if (url.endsWith(`/api/tokens/${createdId}`) && init.method === 'DELETE') {
        tokens = tokens.map((token) =>
          token.id === createdId ? { ...token, revokedAt: '2026-07-31T12:01:00.000Z' } : token,
        );
        throw new Error('injected connection loss after token revocation');
      }
      throw new Error('Unexpected loopback request');
    },
  });

  await assert.rejects(manager.create(), (error) => {
    assert.match(error.message, /temporary token creation failed/i);
    assert.doesNotMatch(error.message, /connection loss|SECRET_SENTINEL/);
    return true;
  });
  manager.close();

  assert.equal(tokens.find((token) => token.id === createdId)?.revokedAt !== null, true);
  assert.equal(tokens.find((token) => token.id === unrelatedId)?.revokedAt, null);
  assert.equal(
    tokens.some((token) => token.label === label && token.revokedAt === null),
    false,
  );
  assert.deepEqual(
    requests.map(({ url, init }) => [init.method, new URL(url).pathname]),
    [
      ['POST', '/api/pair'],
      ['GET', '/api/tokens'],
      ['POST', '/api/tokens'],
      ['GET', '/api/tokens'],
      ['DELETE', `/api/tokens/${createdId}`],
      ['GET', '/api/tokens'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(requests), new RegExp(secretSentinel));
});

test('token creation timeout waits for a delayed commit before cleanup and close', async () => {
  const fixture = temporaryFixture();
  try {
    const pairCookie = `journal_device=${'r'.repeat(48)}`;
    const label = `release-live-${fixture.binding.releaseStamp}`;
    const createdId = '01J00000000000000000000021';
    const secretSentinel = 'jrn_DELAYED_COMMIT_SECRET_SENTINEL';
    const requests = [];
    let tokens = [];
    let commitFinished = false;

    await assert.rejects(
      collectLiveContextEvidence(
        fixture.binding,
        {
          home: fixture.home,
          uid: 501,
          platform: 'darwin',
          origin: ORIGIN,
          commandTimeoutMs: 100,
          requestTimeoutMs: 10,
          tokenTimeoutMs: 100,
        },
        {
          runCommand: commandRunner(fixture).runner,
          fetch: async (url, init) => {
            requests.push({ url, init });
            if (url.endsWith('/api/pair')) {
              return jsonResponse(
                {
                  deviceId: '01J00000000000000000000022',
                  expiresAt: '2027-07-31T12:00:00.000Z',
                },
                {
                  status: 201,
                  headers: { 'set-cookie': `${pairCookie}; Path=/; HttpOnly; Secure` },
                },
              );
            }
            if (url.endsWith('/api/tokens') && init.method === 'GET') {
              return jsonResponse({ tokens });
            }
            if (url.endsWith('/api/tokens') && init.method === 'POST') {
              // Ignore AbortSignal like a server that has already accepted the
              // request, then commit only after the client deadline fires.
              await delay(25);
              tokens = [tokenRecord(createdId, label)];
              commitFinished = true;
              return jsonResponse({ token: tokens[0], secret: secretSentinel }, { status: 201 });
            }
            if (url.endsWith(`/api/tokens/${createdId}`) && init.method === 'DELETE') {
              tokens = tokens.map((token) => ({
                ...token,
                revokedAt: '2026-07-31T12:01:00.000Z',
              }));
              return jsonResponse({ revoked: true, id: createdId });
            }
            throw new Error('MCP request must not run after timed-out token creation');
          },
        },
      ),
      (error) => {
        assert.match(error.message, /temporary token creation exceeded 10ms/i);
        assert.doesNotMatch(error.message, /DELAYED_COMMIT_SECRET/);
        return true;
      },
    );

    assert.equal(commitFinished, true);
    assert.equal(
      tokens.some((token) => token.label === label && token.revokedAt === null),
      false,
    );
    assert.deepEqual(
      requests.map(({ url, init }) => [init.method, new URL(url).pathname]),
      [
        ['POST', '/api/pair'],
        ['GET', '/api/tokens'],
        ['POST', '/api/tokens'],
        ['GET', '/api/tokens'],
        ['DELETE', `/api/tokens/${createdId}`],
        ['GET', '/api/tokens'],
        ['GET', '/api/tokens'],
      ],
    );
    assert.doesNotMatch(JSON.stringify(requests), /DELAYED_COMMIT_SECRET/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('structured log allowlist accepts operational JSONL and rejects content or credentials', () => {
  const allowed = Buffer.from(
    `${JSON.stringify({
      level: 30,
      time: 1_775_000_000_000,
      pid: 4242,
      hostname: 'mickey-home',
      operation: 'server_started',
      host: '127.0.0.1',
      port: 5178,
      version: '1.0.0',
    })}\n${JSON.stringify({
      level: 30,
      time: 1_775_000_000_001,
      pid: 4242,
      hostname: 'mickey-home',
      operation: 'http_request',
      method: 'GET',
      path: '/healthz',
      status: 200,
      durationMs: 1,
    })}\n`,
  );
  assert.deepEqual(inspectStructuredLogBuffer(allowed), {
    lines: 2,
    operations: { server_started: 1, http_request: 1 },
  });
  assert.throws(
    () =>
      inspectStructuredLogBuffer(
        Buffer.from(
          `${JSON.stringify({
            level: 30,
            time: 1_775_000_000_001,
            pid: 4242,
            hostname: 'mickey-home',
            operation: 'http_request',
            method: 'GET',
            path: '/healthz',
            status: 200,
            durationMs: 1,
            journalText: 'private entry content',
          })}\n`,
        ),
      ),
    /non-allowlisted field/,
  );
  assert.throws(
    () =>
      inspectStructuredLogBuffer(
        Buffer.from('Authorization: Bearer jrn_SECRET_SENTINEL_not_a_json_line\n'),
      ),
    /credential-shaped/,
  );
  assert.throws(
    () =>
      inspectStructuredLogBuffer(
        Buffer.from(
          `${JSON.stringify({
            level: 30,
            time: 1_775_000_000_002,
            pid: 4242,
            hostname: 'mickey-home',
            operation: 'mcp_tool_call',
            tool: 'search',
            tokenId: '01J00000000000000000000001',
            tokenLabel: 'private customer planning notes',
            durationMs: 1,
            outcome: 'success',
          })}\n`,
        ),
      ),
    /label is not release-bound metadata/,
  );
});

test('operational log inspection rejects malformed and credential-bearing content', () => {
  const fixture = temporaryFixture();
  try {
    const logDirectory = resolve(fixture.home, '.journal/logs');
    const options = {
      stdoutPath: resolve(logDirectory, 'launchd.out.log'),
      stderrPath: resolve(logDirectory, 'launchd.err.log'),
      logDirectory,
    };
    const currentLog = resolve(logDirectory, 'journald.log');

    writeFileSync(currentLog, 'not-json\n');
    assert.throws(() => inspectOperationalLogs(options), /invalid JSON Lines/);

    writeFileSync(currentLog, 'Authorization: Bearer jrn_OPERATIONAL_LOG_SECRET_SENTINEL\n');
    assert.throws(() => inspectOperationalLogs(options), /credential-shaped/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('structured logs are revalidated after MCP smoke and reject lines appended during it', async () => {
  const fixture = temporaryFixture();
  try {
    const command = commandRunner(fixture);
    const network = successfulFetch(
      'jrn_POST_SMOKE_SECRET_SENTINEL',
      'POST SMOKE JOURNAL SENTINEL',
      'POST_SMOKE_SESSION_SENTINEL',
    );
    const tokenCalls = { revoked: 0, closed: 0 };
    let appended = false;
    const output = resolve(fixture.root, 'evidence/live-context.json');

    await assert.rejects(
      collectLiveContextEvidence(
        fixture.binding,
        {
          home: fixture.home,
          uid: 501,
          platform: 'darwin',
          origin: ORIGIN,
          commandTimeoutMs: 100,
          requestTimeoutMs: 100,
        },
        {
          runCommand: command.runner,
          fetch: async (url, init) => {
            const response = await network.fetch(url, init);
            if (!appended) {
              appendFileSync(
                resolve(fixture.home, '.journal/logs/journald.log'),
                'PRIVATE JOURNAL CONTENT APPENDED DURING MCP SMOKE\n',
              );
              appended = true;
            }
            return response;
          },
          tokenManagerFactory: async () => ({
            create: () => ({
              id: '01J00000000000000000000007',
              secret: 'jrn_POST_SMOKE_SECRET_SENTINEL',
            }),
            revoke: () => {
              tokenCalls.revoked += 1;
            },
            close: () => {
              tokenCalls.closed += 1;
            },
          }),
        },
      ),
      /invalid JSON Lines/,
    );

    assert.equal(appended, true);
    assert.deepEqual(tokenCalls, { revoked: 1, closed: 1 });
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('live evidence detects a restart after the pre-log socket check and before return', async () => {
  const fixture = temporaryFixture();
  try {
    const restartedPid = 4343;
    const command = commandRunner(fixture, { postLogPid: restartedPid });
    const network = successfulFetch(
      'jrn_POST_LOG_RESTART_SECRET_SENTINEL',
      'POST LOG RESTART JOURNAL SENTINEL',
      'POST_LOG_RESTART_SESSION_SENTINEL',
    );
    const tokenCalls = { revoked: 0, closed: 0 };

    await assert.rejects(
      collectLiveContextEvidence(
        fixture.binding,
        {
          home: fixture.home,
          uid: 501,
          platform: 'darwin',
          origin: ORIGIN,
          commandTimeoutMs: 100,
          requestTimeoutMs: 100,
        },
        {
          runCommand: command.runner,
          fetch: network.fetch,
          tokenManagerFactory: async () => ({
            create: () => ({
              id: '01J00000000000000000000017',
              secret: 'jrn_POST_LOG_RESTART_SECRET_SENTINEL',
            }),
            revoke: () => {
              tokenCalls.revoked += 1;
            },
            close: () => {
              tokenCalls.closed += 1;
            },
          }),
        },
      ),
      /PID or loaded working directory changed during evidence collection/,
    );

    const launchChecks = command.calls.filter(
      ([commandPath, action]) => commandPath === '/bin/launchctl' && action === 'print',
    );
    const socketChecks = command.calls.filter(
      ([commandPath, ...arguments_]) =>
        commandPath === '/usr/sbin/lsof' && arguments_.includes('-iTCP'),
    );
    assert.equal(launchChecks.length, 3);
    assert.match(launchChecks[2].join(' '), /com\.rsreberski\.journald/);
    assert.equal(socketChecks.length, 2);
    assert.deepEqual(tokenCalls, { revoked: 1, closed: 1 });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('live evidence bounds injected command and fetch hangs and cleans up a created token', async () => {
  const fixture = temporaryFixture();
  try {
    let tokenFactoryCalls = 0;
    await assert.rejects(
      collectLiveContextEvidence(
        fixture.binding,
        {
          home: fixture.home,
          uid: 501,
          platform: 'darwin',
          commandTimeoutMs: 10,
        },
        {
          runCommand: async () => new Promise(() => undefined),
          tokenManagerFactory: async () => {
            tokenFactoryCalls += 1;
            throw new Error('must not be reached');
          },
        },
      ),
      /launchctl PID inspection exceeded 10ms/,
    );
    assert.equal(tokenFactoryCalls, 0);

    const command = commandRunner(fixture);
    const calls = { revoked: 0, closed: 0 };
    const secret = 'jrn_TIMEOUT_SECRET_SENTINEL';
    await assert.rejects(
      collectLiveContextEvidence(
        fixture.binding,
        {
          home: fixture.home,
          uid: 501,
          platform: 'darwin',
          commandTimeoutMs: 100,
          requestTimeoutMs: 10,
        },
        {
          runCommand: command.runner,
          fetch: async () => new Promise(() => undefined),
          tokenManagerFactory: async () => ({
            create: () => ({ id: 'temporary-token-id', secret }),
            revoke: () => {
              calls.revoked += 1;
            },
            close: () => {
              calls.closed += 1;
            },
          }),
        },
      ),
      (error) => {
        assert.match(error.message, /MCP initialize smoke exceeded 10ms/);
        assert.doesNotMatch(error.message, /TIMEOUT_SECRET/);
        return true;
      },
    );
    assert.deepEqual(calls, { revoked: 1, closed: 1 });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('live evidence fails closed on provider configuration, extra jobs, sockets, and cleanup failure', async () => {
  const fixture = temporaryFixture();
  try {
    for (const [runner, pattern] of [
      [
        commandRunner(fixture, { extraEnvironment: { OPENAI_API_KEY: 'not-recorded' } }).runner,
        /environment/,
      ],
      [
        commandRunner(fixture, {
          extraEffectiveEnvironment: {
            TODOIST_API_TOKEN: 'todoist-secret-value-not-recorded',
            SSH_AUTH_SOCK: '/private/secret/socket-not-recorded',
          },
        }).runner,
        /effective environment.*unexpected keys: SSH_AUTH_SOCK, TODOIST_API_TOKEN/,
      ],
      [
        commandRunner(fixture, { extraJournalLabel: 'com.example.journal.scheduler' }).runner,
        /extra Journal/,
      ],
      [
        commandRunner(fixture, {
          plistWorkingDirectory: resolve(fixture.root, 'different-release'),
        }).runner,
        /LaunchAgent working directory/,
      ],
      [
        commandRunner(fixture, {
          launchWorkingDirectory: resolve(fixture.root, 'different-release'),
        }).runner,
        /loaded launchd job working directory/,
      ],
      [
        commandRunner(fixture, {
          processWorkingDirectory: resolve(fixture.root, 'different-release'),
        }).runner,
        /live journald PID working directory/,
      ],
      [
        commandRunner(fixture, { processInode: '999999999' }).runner,
        /identify the attested release directory/,
      ],
    ]) {
      await assert.rejects(
        collectLiveContextEvidence(
          fixture.binding,
          { home: fixture.home, uid: 501, platform: 'darwin' },
          {
            runCommand: runner,
            tokenManagerFactory: async () => {
              throw new Error('token creation must not be reached');
            },
          },
        ),
        pattern,
      );
    }

    const finalIdentityNetwork = successfulFetch(
      'jrn_FINAL_IDENTITY_SECRET_SENTINEL',
      'FINAL IDENTITY JOURNAL SENTINEL',
      'FINAL_IDENTITY_SESSION_SENTINEL',
    );
    await assert.rejects(
      collectLiveContextEvidence(
        fixture.binding,
        { home: fixture.home, uid: 501, platform: 'darwin' },
        {
          runCommand: commandRunner(fixture, { finalProcessInode: '999999999' }).runner,
          fetch: finalIdentityNetwork.fetch,
          tokenManagerFactory: async () => ({
            create: () => ({
              id: 'final-identity-token-id',
              secret: 'jrn_FINAL_IDENTITY_SECRET_SENTINEL',
            }),
            revoke: () => undefined,
            close: () => undefined,
          }),
        },
      ),
      /cwd changed during live evidence collection/,
    );

    const finalEnvironmentNetwork = successfulFetch(
      'jrn_FINAL_ENVIRONMENT_SECRET_SENTINEL',
      'FINAL ENVIRONMENT JOURNAL SENTINEL',
      'FINAL_ENVIRONMENT_SESSION_SENTINEL',
    );
    await assert.rejects(
      collectLiveContextEvidence(
        fixture.binding,
        { home: fixture.home, uid: 501, platform: 'darwin' },
        {
          runCommand: commandRunner(fixture, {
            finalExtraEffectiveEnvironment: { SSH_AUTH_SOCK: '/secret/socket-not-recorded' },
          }).runner,
          fetch: finalEnvironmentNetwork.fetch,
          tokenManagerFactory: async () => ({
            create: () => ({
              id: 'final-environment-token-id',
              secret: 'jrn_FINAL_ENVIRONMENT_SECRET_SENTINEL',
            }),
            revoke: () => undefined,
            close: () => undefined,
          }),
        },
      ),
      (error) => {
        assert.match(error.message, /effective environment.*unexpected keys: SSH_AUTH_SOCK/);
        assert.doesNotMatch(error.message, /socket-not-recorded|FINAL_ENVIRONMENT_SECRET/);
        return true;
      },
    );

    assert.throws(
      () =>
        parseTcpSockets(
          'p4242\nf10\nPTCP\nn127.0.0.1:5178\nTST=LISTEN\nf11\nPTCP\nn10.0.0.3:62000->8.8.8.8:443\nTST=ESTABLISHED\n',
          4242,
          5178,
        ),
      /non-loopback/,
    );

    const command = commandRunner(fixture);
    const network = successfulFetch(
      'jrn_CLEANUP_SECRET_SENTINEL',
      'JOURNAL SENTINEL',
      'SESSION SENTINEL',
    );
    await assert.rejects(
      collectLiveContextEvidence(
        fixture.binding,
        { home: fixture.home, uid: 501, platform: 'darwin' },
        {
          runCommand: command.runner,
          fetch: network.fetch,
          tokenManagerFactory: async () => ({
            create: () => ({
              id: 'cleanup-token-id',
              secret: 'jrn_CLEANUP_SECRET_SENTINEL',
            }),
            revoke: () => {
              throw new Error('injected revoke failure');
            },
            close: () => undefined,
          }),
        },
      ),
      (error) => {
        assert.match(error.message, /failed closed.*cleanup was not proven/i);
        assert.doesNotMatch(error.message, /CLEANUP_SECRET/);
        return true;
      },
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
