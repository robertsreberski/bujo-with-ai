/* global Buffer, process, structuredClone */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { URL } from 'node:url';
import { createServer } from 'node:http';
import test from 'node:test';
import { createReleaseArchive } from './release-archive.mjs';
import { runBackupDrill } from './release-backup-drill.mjs';
import { stopChild } from './benchmark-release.mjs';
import { cleanServerDist, finalizeServerDist } from '../server/scripts/build-output.mjs';
import { createDeviceEvidence } from './release-device-evidence.mjs';
import { createDeployedTreeAttestation } from './release-deployed-tree.mjs';
import { evaluateLedger } from './release-ledger.mjs';
import { createManifest, readManifest, sha256File, verifyManifest } from './release-manifest.mjs';
import {
  assertBackupOwnership,
  assertDeviceLedgerConsistency,
  assertLiveContextFreshness,
  assertLifecycleEvidence,
  commitPromotionPointer,
  recoverPromotionTransaction,
  validateLiveContextEvidence,
  verifyAttestedServeEvidence,
  verifyLiveServeSnapshot,
  verifyPromotionDeployedTree,
  withFinalPromotionValidation,
  withGlobalReleaseLock,
  withPromotionTerminalMarker,
} from './release-promote.mjs';
import {
  verifyServeBaseline,
  verifyServeChange,
  verifyServeRollback,
} from './release-serve-config.mjs';
import {
  cwdIdentityFromLsof,
  launchdPid,
  launchdWorkingDirectory,
  listenersFromLsof,
  retryUntilReady,
  verifyApplicationOrigin,
} from './release-verify-runtime.mjs';

function withTemporaryDirectory(prefix, callback) {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  return Promise.resolve(callback(directory)).finally(() =>
    rmSync(directory, { recursive: true, force: true }),
  );
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function shellFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name} {`);
  const end = source.indexOf(`\nfunction ${nextName} {`, start);
  assert.ok(start >= 0 && end > start, `Unable to extract zsh function ${name}`);
  return source.slice(start, end).trim();
}

function fixture(root) {
  mkdirSync(resolve(root, 'app/dist'), { recursive: true });
  mkdirSync(resolve(root, 'server/dist'), { recursive: true });
  writeFileSync(resolve(root, '.gitignore'), '**/dist/\n');
  writeFileSync(resolve(root, '.nvmrc'), `${process.version.slice(1)}\n`);
  writeFileSync(
    resolve(root, 'package.json'),
    `${JSON.stringify({ name: 'release-fixture', version: '7.8.9' })}\n`,
  );
  writeFileSync(
    resolve(root, 'package-lock.json'),
    `${JSON.stringify({ name: 'release-fixture', version: '7.8.9', lockfileVersion: 3, packages: { '': { name: 'release-fixture', version: '7.8.9' } } })}\n`,
  );
  writeFileSync(resolve(root, 'tracked.txt'), 'original\n');
  writeFileSync(resolve(root, 'app/dist/index.html'), '<script src="/assets/app.js"></script>\n');
  mkdirSync(resolve(root, 'app/dist/assets'));
  writeFileSync(resolve(root, 'app/dist/assets/app.js'), 'console.log("tested");\n');
  writeFileSync(resolve(root, 'server/dist/cli.js'), '#!/usr/bin/env node\n');
  chmodSync(resolve(root, 'server/dist/cli.js'), 0o755);
  mkdirSync(resolve(root, 'scripts'));
  copyFileSync(
    resolve(import.meta.dirname, 'release-stage.zsh'),
    resolve(root, 'scripts/release-stage.zsh'),
  );
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Release Test');
  git(root, 'config', 'user.email', 'release@example.test');
  git(root, 'add', '.gitignore', '.nvmrc', 'package.json', 'package-lock.json', 'tracked.txt');
  git(root, 'commit', '-qm', 'fixture');
  writeFileSync(resolve(root, 'tracked.txt'), 'dirty worktree\n');
  writeFileSync(resolve(root, 'untracked.txt'), 'included untracked source\n');
  return git(root, 'rev-parse', 'HEAD');
}

test('manifest and archive fingerprint exact dirty source, dist bytes, modes, and toolchain', () =>
  withTemporaryDirectory('journal-release-tools-', (temporary) => {
    const root = resolve(temporary, 'repository');
    const evidence = resolve(temporary, 'evidence');
    mkdirSync(root);
    mkdirSync(evidence);
    const commit = fixture(root);
    const manifestPath = resolve(evidence, 'manifest.json');
    const manifest = createManifest({ root, destination: manifestPath });

    assert.equal(manifest.git.baseCommit, commit);
    assert.equal(manifest.git.dirty, true);
    assert.ok(manifest.git.statusEntries >= 2);
    assert.equal(manifest.toolchain.node, process.version);
    assert.equal(manifest.toolchain.nvmrc, process.version.slice(1));
    assert.match(manifest.toolchain.packageLockSha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.release.version, '7.8.9');
    assert.equal(
      manifest.files.find(({ path }) => path === 'server/dist/cli.js').mode & 0o111,
      0o111,
    );
    assert.ok(manifest.files.some(({ path }) => path === 'untracked.txt'));
    assert.ok(manifest.files.some(({ path }) => path === 'app/dist/assets/app.js'));

    const mismatchedManifestPath = resolve(evidence, 'mismatched-toolchain.json');
    writeFileSync(
      mismatchedManifestPath,
      `${JSON.stringify({
        ...manifest,
        toolchain: {
          ...manifest.toolchain,
          node: 'v0.0.0-release-fixture',
          nodePath: '/attested/node/that/is/not-current',
        },
      })}\n`,
    );
    const mismatch = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, 'release-manifest.mjs'),
        '--verify-toolchain',
        mismatchedManifestPath,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /Release toolchain mismatch/);

    const stamp = `20260731T120000Z-${commit.slice(0, 12)}-1234`;
    const archivePath = resolve(evidence, 'release.tgz');
    const attestationPath = resolve(evidence, 'attestation.json');
    const attestation = createReleaseArchive({
      root,
      manifestPath,
      archivePath,
      attestationPath,
      stamp,
    });
    assert.equal(attestation.extractedTreeVerified, true);
    assert.equal(attestation.releaseStamp, stamp);

    const stageHome = resolve(temporary, 'stage-home');
    const fakeBin = resolve(temporary, 'fake-toolchain');
    const stageContextPath = resolve(evidence, 'stage-context.json');
    mkdirSync(stageHome);
    mkdirSync(fakeBin);
    writeFileSync(
      stageContextPath,
      `${JSON.stringify({
        releaseStamp: stamp,
        releaseRoot: resolve(stageHome, '.journal/releases', stamp),
        manifest: manifestPath,
        archive: archivePath,
        attestation: attestationPath,
        manifestSha256: sha256File(manifestPath),
        archiveSha256: sha256File(archivePath),
      })}\n`,
    );
    writeFileSync(
      resolve(fakeBin, 'node'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v0.0.0; else echo /separate-shell/node; fi\n',
    );
    writeFileSync(
      resolve(fakeBin, 'npm'),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${manifest.toolchain.npm}; else exit 86; fi\n`,
    );
    chmodSync(resolve(fakeBin, 'node'), 0o755);
    chmodSync(resolve(fakeBin, 'npm'), 0o755);
    if (process.platform === 'darwin') {
      const stagedWithWrongNode = spawnSync(
        '/bin/zsh',
        [resolve(root, 'scripts/release-stage.zsh'), stageContextPath],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, HOME: stageHome, PATH: `${fakeBin}:${process.env.PATH}` },
        },
      );
      assert.ifError(stagedWithWrongNode.error);
      assert.notEqual(stagedWithWrongNode.status, 0);
      assert.match(stagedWithWrongNode.stderr, /toolchain no longer matches/);
      assert.equal(existsSync(resolve(stageHome, '.journal/releases')), false);
    }

    const extracted = resolve(temporary, 'extracted');
    mkdirSync(extracted);
    execFileSync('tar', ['-xzpf', archivePath, '-C', extracted]);
    assert.doesNotThrow(() => verifyManifest(manifestPath, extracted));
    writeFileSync(resolve(extracted, 'unexpected.txt'), 'not attested\n');
    assert.throws(() => verifyManifest(manifestPath, extracted), /unexpected paths/);
    rmSync(resolve(extracted, 'unexpected.txt'));
    writeFileSync(resolve(extracted, 'tracked.txt'), 'tampered\n');
    assert.throws(() => verifyManifest(readManifest(manifestPath), extracted), /tracked\.txt/);
  }));

test('server build cleanup removes stale output and finalizes a fresh executable CLI', () =>
  withTemporaryDirectory('journal-server-build-', async (temporary) => {
    const serverRoot = resolve(temporary, 'server');
    const dist = resolve(serverRoot, 'dist');
    const migrations = resolve(serverRoot, 'src/db/migrations');
    mkdirSync(resolve(dist, 'db/migrations'), { recursive: true });
    writeFileSync(resolve(dist, 'stale.js'), 'stale output\n');
    writeFileSync(resolve(dist, 'db/migrations/removed.sql'), 'stale migration\n');
    mkdirSync(migrations, { recursive: true });
    writeFileSync(resolve(migrations, '001_current.sql'), 'select 1;\n');

    assert.equal(await cleanServerDist({ serverRoot, distDirectory: dist }), dist);
    assert.equal(existsSync(dist), false);
    mkdirSync(resolve(dist, 'db/migrations'), { recursive: true });
    writeFileSync(resolve(dist, 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o600 });
    writeFileSync(resolve(dist, 'db/migrations/removed.sql'), 'stale after tsc\n');
    await finalizeServerDist({ serverRoot, distDirectory: dist, migrationsDirectory: migrations });
    assert.equal(lstatSync(resolve(dist, 'cli.js')).mode & 0o777, 0o700);
    assert.equal(existsSync(resolve(dist, 'db/migrations/001_current.sql')), true);
    assert.equal(existsSync(resolve(dist, 'db/migrations/removed.sql')), false);
    assert.equal(existsSync(resolve(dist, 'stale.js')), false);
    await assert.rejects(
      cleanServerDist({
        serverRoot,
        distDirectory: resolve(temporary, 'outside-dist'),
      }),
      /not the exact server dist directory/,
    );
  }));

test('staged runtime smoke exercises the production bundle with isolated data', () => {
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, 'release-staged-smoke.mjs')],
    {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.status, 'pass');
  assert.equal(evidence.listener, '127.0.0.1:ephemeral');
  assert.ok(Number.isSafeInteger(evidence.assetBytes) && evidence.assetBytes > 0);
  assert.doesNotMatch(result.stdout, /journal-staged-smoke-|journal\.db|\/Users\//);
});

test('ledger rejects incomplete gates and permits only explicit exceptions', () => {
  const document = `
| Gate | Evidence | Result |
| --- | --- | --- |
| Included | EVIDENCE: command output at run-001.json | PASS |
| Deferred | EVIDENCE: command output at run-002.json | NOT RUN |
| Broken | EVIDENCE: command output at run-003.json | FAIL |
| Accepted risk | EVIDENCE: ticket DEV-2026-001 | DEVIATION |
| FR-39 | none | P2 EXCLUDED |
| Physical iPhone standalone | EVIDENCE: device handoff record run-004.json | DEVICE HANDOFF |

## Explicitly accepted release deviations

| Gate | Acceptance ID | Owner | recordedAt | reason |
| --- | --- | --- | --- | --- |
| Accepted risk | DEV-2026-001 | Robert | 2026-07-31T12:00:00Z | accepted for this release |
`;
  const requiredGates = [
    'Included',
    'Deferred',
    'Broken',
    'Accepted risk',
    'FR-39',
    'Physical iPhone standalone',
  ];
  const result = evaluateLedger(document, { requiredGates });
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.failures.map(({ gate, result: status }) => [gate, status]),
    [
      ['Deferred', 'NOT RUN'],
      ['Broken', 'FAIL'],
    ],
  );
  const passing = evaluateLedger(document.replace('NOT RUN', 'PASS').replace('FAIL', 'PASS'), {
    requiredGates,
  });
  assert.equal(passing.passed, true);
  assert.equal(passing.acceptedDeviations, 1);
  assert.throws(
    () =>
      evaluateLedger(
        document.replace(
          'Accepted risk | EVIDENCE: ticket DEV-2026-001 | DEVIATION',
          'Accepted risk | EVIDENCE: ticket DEV-2026-001 | PASS',
        ),
        { requiredGates },
      ),
    /Unused deviation/,
  );
  assert.throws(() => evaluateLedger('| Placeholder | PASS |'), /missing required gates/);
  assert.equal(
    evaluateLedger('| Existing HTTPS 443 preserved | P2 EXCLUDED |', {
      requiredGates: ['Existing HTTPS 443 preserved'],
    }).passed,
    false,
  );
  const template = readFileSync(resolve(import.meta.dirname, '../docs/verification.md'), 'utf8');
  const statusOnlyForgery = evaluateLedger(template.replaceAll('NOT RUN', 'PASS'));
  assert.equal(statusOnlyForgery.passed, false);
  assert.ok(statusOnlyForgery.failures.some(({ result: status }) => status === 'INVALID EVIDENCE'));
});

function liveContextFixture(root) {
  const stamp = '20260731T120000Z-abcdef123456-99';
  const home = resolve(root, 'home');
  const evidenceRoot = resolve(home, '.journal', 'release-evidence');
  const releaseRoot = resolve(home, '.journal', 'releases', stamp);
  const contextPath = resolve(evidenceRoot, `release-context-${stamp}.json`);
  const liveContextPath = resolve(evidenceRoot, `live-context-${stamp}.json`);
  mkdirSync(evidenceRoot, { recursive: true });
  mkdirSync(releaseRoot, { recursive: true });
  const context = {
    schemaVersion: 1,
    releaseStamp: stamp,
    releaseRoot,
    baseCommit: 'abcdef1234567890',
    manifestSha256: '1'.repeat(64),
    archiveSha256: '2'.repeat(64),
  };
  const manifest = {
    release: { version: '7.8.9' },
    toolchain: { nodePath: process.execPath },
  };
  const environment = {
    NODE_ENV: 'production',
    JOURNAL_CONFIG: resolve(home, '.journal', 'config.json'),
    JOURNAL_DATA_DIR: resolve(home, '.journal'),
    JOURNAL_PORT: '5178',
    JOURNAL_BIND_HOST: '127.0.0.1',
    JOURNAL_HOSTS: 'localhost:5178,127.0.0.1:5178,mickey-home.tail8a9beb.ts.net:5178',
    JOURNAL_TZ: 'Europe/Amsterdam',
    JOURNAL_DAY_BOUNDARY_OFFSET_MIN: '0',
    JOURNAL_VERSION: manifest.release.version,
    JOURNAL_TAILNET_HOST: 'mickey-home.tail8a9beb.ts.net:5178',
  };
  const environmentKeys = Object.keys(environment).sort();
  const normalizedEnvironment = Object.fromEntries(
    Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)),
  );
  const expectedNode = resolve(process.execPath);
  const expectedCli = resolve(releaseRoot, 'server/dist/cli.js');
  const emptySha256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  const releaseIdentity = statSync(releaseRoot, { bigint: true });
  const listener = {
    state: 'LISTEN',
    direction: 'listener',
    local: { address: '127.0.0.1', port: '5178' },
  };
  const evidence = {
    schemaVersion: 1,
    releaseStamp: stamp,
    recordedAt: '2026-07-31T12:30:00.000Z',
    baseCommit: context.baseCommit,
    manifestSha256: context.manifestSha256,
    archiveSha256: context.archiveSha256,
    releaseRoot,
    deployedTree: {
      schemaVersion: 1,
      releaseStamp: stamp,
      releaseRoot,
      attestationPath: resolve(evidenceRoot, `deployed-tree-${stamp}.json`),
      attestationSha256: '6'.repeat(64),
      treeSha256: '7'.repeat(64),
      paths: 1,
      stableDuringCollection: true,
    },
    service: {
      label: 'com.rsreberski.journald',
      serviceTarget: `gui/${process.getuid()}/com.rsreberski.journald`,
      pid: 4242,
      plist: {
        path: resolve(home, 'Library/LaunchAgents/com.rsreberski.journald.plist'),
        sha256: '3'.repeat(64),
        mode: '0600',
        programArguments: [
          '/usr/bin/env',
          '-i',
          ...Object.entries(environment)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => `${key}=${value}`),
          expectedNode,
          expectedCli,
          'serve',
        ],
        workingDirectory: releaseRoot,
        environmentKeys,
        environmentSha256: createHash('sha256')
          .update(JSON.stringify(normalizedEnvironment))
          .digest('hex'),
      },
      process: {
        commandSha256: createHash('sha256')
          .update([expectedNode, expectedCli, 'serve'].join(' '))
          .digest('hex'),
        workingDirectory: releaseRoot,
        workingDirectoryIdentity: {
          device: releaseIdentity.dev.toString(),
          inode: releaseIdentity.ino.toString(),
        },
        environment: {
          keys: environmentKeys,
          unexpectedKeys: [],
          credentialKeys: [],
          isolatedBy: '/usr/bin/env -i',
          providerOrSchedulerConfigurationAbsent: true,
        },
        descendants: [],
        extraJournalLaunchdJobs: [],
      },
      tcp: {
        metadataOnly: true,
        snapshots: [
          { phase: 'before-mcp-smoke', sockets: [listener] },
          { phase: 'after-final-log-inspection', sockets: [structuredClone(listener)] },
        ],
        unexpectedNonLoopbackSockets: [],
      },
      logs: {
        policy: 'strict-jsonl-allowlist',
        launchdStdout: {
          path: resolve(home, '.journal/logs/launchd.out.log'),
          exists: false,
          bytes: 0,
          sha256: emptySha256,
          policy: 'zero-content',
        },
        streams: [
          {
            path: resolve(home, '.journal/logs/launchd.err.log'),
            kind: 'launchd-stderr',
            exists: false,
            bytes: 0,
            sha256: emptySha256,
            lines: 0,
            operations: {},
          },
          {
            path: resolve(home, '.journal/logs/journald.log'),
            kind: 'rotating-current',
            exists: true,
            bytes: 0,
            sha256: emptySha256,
            lines: 0,
            operations: {},
          },
        ],
        history: {
          path: resolve(home, '.journal/logs/journald.log.txt'),
          exists: false,
          bytes: 0,
          entries: 0,
        },
        allowedOperations: ['server_started', 'server_stopped', 'http_request', 'mcp_tool_call'],
        contentBearingFieldsAccepted: false,
        secretPatternsFound: false,
        journalContentRecorded: false,
        validationPhase: 'after-mcp-smoke-before-final-runtime-recheck',
      },
      pidStableDuringCollection: true,
      workingDirectoryStableDuringCollection: true,
      environmentKeysAndValuesStableDuringCollection: true,
    },
    mcp: {
      origin: 'https://mickey-home.tail8a9beb.ts.net:5178',
      transport: 'streamable-http',
      token: {
        createdLocally: true,
        tokenIdSha256: '4'.repeat(64),
        secretRecorded: false,
        revoked: true,
        revokedProbeStatus: 401,
      },
      initialize: {
        httpStatus: 200,
        protocolVersion: '2025-06-18',
        sessionIdSha256: '5'.repeat(64),
      },
      toolsList: {
        httpStatus: 200,
        names: [
          'add_entry',
          'add_to_collection',
          'list_day',
          'search',
          'update_entry',
          'delete_entry',
          'propose_migration',
        ],
      },
      read: {
        httpStatus: 200,
        tool: 'search',
        structuredResultValidated: true,
        journalContentRecorded: false,
      },
      sessionClosed: true,
      secretsRecorded: false,
    },
  };
  writeFileSync(contextPath, `${JSON.stringify(context)}\n`, { mode: 0o600 });
  const writeEvidence = (document = evidence) => {
    writeFileSync(liveContextPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    chmodSync(liveContextPath, 0o600);
  };
  writeEvidence();
  return { contextPath, liveContextPath, context, manifest, home, evidence, writeEvidence };
}

function promotionTransactionFixture(root) {
  const live = liveContextFixture(root);
  const oldRelease = resolve(root, 'old-release');
  mkdirSync(oldRelease, { recursive: true });
  const currentLink = resolve(root, 'current-release');
  symlinkSync(oldRelease, currentLink, 'dir');
  const promotionPath = resolve(
    live.home,
    '.journal/release-evidence',
    `promotion-${live.context.releaseStamp}.json`,
  );
  const preparedPath = resolve(
    live.home,
    '.journal/release-evidence',
    `promotion-prepared-${live.context.releaseStamp}.json`,
  );
  const { source: liveContextSource } = validateLiveContextEvidence({
    contextPath: live.contextPath,
    context: live.context,
    manifest: live.manifest,
    home: live.home,
  });
  const promotion = {
    schemaVersion: 1,
    releaseStamp: live.context.releaseStamp,
    recordedAt: '2026-07-31T13:00:00.000Z',
    baseCommit: live.context.baseCommit,
    manifestSha256: live.context.manifestSha256,
    archiveSha256: live.context.archiveSha256,
    liveContextSource,
    promotionLogs: {
      ...structuredClone(live.evidence.service.logs),
      validationPhase: 'after-promotion-http-probes-before-prepared-evidence',
    },
    deployedTree: {
      schemaVersion: 1,
      releaseStamp: live.context.releaseStamp,
      releaseRoot: live.context.releaseRoot,
      attestationPath: resolve(
        live.home,
        '.journal',
        'release-evidence',
        `deployed-tree-${live.context.releaseStamp}.json`,
      ),
      attestationSha256: '6'.repeat(64),
      treeSha256: '7'.repeat(64),
      paths: 1,
    },
    liveRuntime: { pid: live.evidence.service.pid },
    postLogRuntimeBinding: {
      protocol: 'launchctl-ps-lsof-only-v1',
      pid: live.evidence.service.pid,
      applicationHttpRequests: 0,
      applicationLogWrites: 0,
    },
    previousRelease: oldRelease,
    currentRelease: live.context.releaseRoot,
    atomicPointerPromotion: true,
    pointerTransaction: {
      protocol: 'prepared-evidence-cas-v1',
      expectedCurrentRelease: oldRelease,
      targetCurrentRelease: live.context.releaseRoot,
      preparedEvidencePath: preparedPath,
      preparedEvidenceCandidatePath: `${preparedPath}.next`,
    },
  };
  return {
    ...live,
    oldRelease,
    currentLink,
    promotionPath,
    preparedPath,
    promotion,
  };
}

test('promotion live-context validation binds exact private bytes and fails closed on drift', () =>
  withTemporaryDirectory('journal-promotion-live-context-', (temporary) => {
    const fixture = liveContextFixture(temporary);
    const deployedTree = structuredClone(fixture.evidence.deployedTree);
    delete deployedTree.stableDuringCollection;
    const validate = () =>
      validateLiveContextEvidence({
        contextPath: fixture.contextPath,
        context: fixture.context,
        manifest: fixture.manifest,
        home: fixture.home,
        deployedTree,
      });

    const valid = validate();
    assert.equal(valid.source.path, fixture.liveContextPath);
    assert.equal(valid.source.sha256, sha256File(fixture.liveContextPath));
    assert.deepEqual(valid.evidence.mcp.toolsList.names, fixture.evidence.mcp.toolsList.names);

    chmodSync(fixture.liveContextPath, 0o644);
    assert.throws(validate, /owner-only regular file/);
    chmodSync(fixture.liveContextPath, 0o600);

    const symlinkTarget = resolve(temporary, 'live-context-symlink-target.json');
    rmSync(fixture.liveContextPath);
    writeFileSync(symlinkTarget, `${JSON.stringify(fixture.evidence)}\n`, { mode: 0o600 });
    symlinkSync(symlinkTarget, fixture.liveContextPath);
    assert.throws(validate, /owner-only regular file/);
    rmSync(fixture.liveContextPath);
    rmSync(symlinkTarget);
    fixture.writeEvidence();

    const identityTamper = structuredClone(fixture.evidence);
    identityTamper.baseCommit = `${identityTamper.baseCommit.slice(0, -1)}1`;
    fixture.writeEvidence(identityTamper);
    assert.throws(validate, /base commit mismatch/);

    const contradictoryCases = [
      [
        'deployed tree stability',
        (document) => {
          document.deployedTree.stableDuringCollection = false;
        },
        /deployed tree stability mismatch/,
      ],
      [
        'deployed tree binding',
        (document) => {
          document.deployedTree.treeSha256 = '8'.repeat(64);
        },
        /Live-context and promotion deployed-tree treeSha256 mismatch/,
      ],
      [
        'revoked probe',
        (document) => {
          document.mcp.token.revokedProbeStatus = 201;
        },
        /revoked-token probe mismatch/,
      ],
      [
        'tool inventory',
        (document) => {
          document.mcp.toolsList.names.pop();
        },
        /tool inventory is not the exact required value/,
      ],
      [
        'provider isolation',
        (document) => {
          document.service.process.environment.providerOrSchedulerConfigurationAbsent = false;
        },
        /provider or scheduler configuration absence mismatch/,
      ],
      [
        'PID stability',
        (document) => {
          document.service.pidStableDuringCollection = false;
        },
        /PID stability mismatch/,
      ],
      [
        'content-free logs',
        (document) => {
          document.service.logs.secretPatternsFound = true;
        },
        /log secret scan mismatch/,
      ],
      [
        'loopback sockets',
        (document) => {
          document.service.tcp.snapshots[1].sockets[0].local.address = '10.0.0.1';
        },
        /loopback-only TCP metadata/,
      ],
    ];
    for (const [description, mutate, pattern] of contradictoryCases) {
      const contradictory = structuredClone(fixture.evidence);
      mutate(contradictory);
      fixture.writeEvidence(contradictory);
      assert.throws(validate, pattern, description);
    }

    rmSync(fixture.liveContextPath);
    writeFileSync(resolve(temporary, 'live-context-wrong.json'), '{}\n', { mode: 0o600 });
    assert.throws(validate, /missing at its exact release-specific path/);
  }));

test('promotion deployed-tree gate rejects dependency tampering after read-only mode is restored', () =>
  withTemporaryDirectory('journal-promotion-deployed-tree-', (temporary) => {
    const stamp = '20260731T120000Z-abcdef123456-99';
    const evidenceRoot = resolve(temporary, 'evidence');
    const releaseRoot = resolve(temporary, 'releases', stamp);
    const dependencyDirectory = resolve(releaseRoot, 'node_modules', 'example');
    const dependency = resolve(dependencyDirectory, 'index.js');
    mkdirSync(dependencyDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(evidenceRoot, { mode: 0o700 });
    writeFileSync(dependency, 'export default 1;\n', { mode: 0o400 });
    chmodSync(dependency, 0o400);
    for (const directory of [
      dependencyDirectory,
      resolve(releaseRoot, 'node_modules'),
      releaseRoot,
    ]) {
      chmodSync(directory, 0o500);
    }
    const context = {
      releaseStamp: stamp,
      releaseRoot,
      baseCommit: 'abcdef1234567890',
      manifestSha256: '1'.repeat(64),
      archiveSha256: '2'.repeat(64),
    };
    const contextPath = resolve(evidenceRoot, `release-context-${stamp}.json`);
    const attestationPath = resolve(evidenceRoot, `deployed-tree-${stamp}.json`);
    writeFileSync(contextPath, `${JSON.stringify(context)}\n`, { mode: 0o600 });
    chmodSync(contextPath, 0o600);
    createDeployedTreeAttestation({
      contextPath,
      root: releaseRoot,
      outputPath: attestationPath,
    });
    const initial = verifyPromotionDeployedTree({ contextPath, context });
    assert.match(initial.treeSha256, /^[a-f0-9]{64}$/);

    chmodSync(dependency, 0o600);
    writeFileSync(dependency, 'export default 2;\n');
    chmodSync(dependency, 0o400);
    assert.throws(
      () => verifyPromotionDeployedTree({ contextPath, context }),
      /no longer matches its attestation/,
    );

    chmodSync(releaseRoot, 0o700);
    chmodSync(resolve(releaseRoot, 'node_modules'), 0o700);
    chmodSync(dependencyDirectory, 0o700);
    chmodSync(dependency, 0o600);
  }));

test('promotion requires fresh post-lifecycle live context without PID equality', () => {
  const cutover = { recordedAt: '2026-07-31T12:00:00Z' };
  const lifecycle = { recordedAt: '2026-07-31T12:20:00Z', sigkill: { recoveredPid: 303 } };
  const liveContext = { recordedAt: '2026-07-31T12:30:00.000Z', service: { pid: 404 } };
  const freshness = assertLiveContextFreshness({
    cutover,
    liveContext,
    lifecycle,
    now: new Date('2026-07-31T13:00:00.000Z'),
    maximumAgeMs: 60 * 60 * 1000,
  });
  assert.equal(freshness.ageMs, 30 * 60 * 1000);
  assert.equal(freshness.recordedAfterLifecycle, true);
  assert.equal(freshness.pidContinuityRequiredAcrossLifecycle, false);

  assert.throws(
    () =>
      assertLiveContextFreshness({
        cutover,
        liveContext,
        lifecycle,
        now: new Date('2026-07-31T13:30:00.001Z'),
        maximumAgeMs: 60 * 60 * 1000,
      }),
    /older than/,
  );
  assert.throws(
    () =>
      assertLiveContextFreshness({
        cutover,
        liveContext,
        lifecycle: { recordedAt: '2026-07-31T11:59:59Z' },
        now: new Date('2026-07-31T13:00:00.000Z'),
      }),
    /Lifecycle evidence predates successful cutover/,
  );
  assert.throws(
    () =>
      assertLiveContextFreshness({
        cutover,
        liveContext: { recordedAt: '2026-07-31T12:19:59.000Z' },
        lifecycle,
        now: new Date('2026-07-31T13:00:00.000Z'),
      }),
    /Live-context evidence predates lifecycle completion/,
  );
  for (const recordedAt of ['2026-02-30T12:00:00Z', '2026-07-31T24:00:00Z']) {
    assert.throws(
      () =>
        assertLiveContextFreshness({
          cutover: { recordedAt },
          liveContext,
          lifecycle,
          now: new Date('2026-07-31T13:00:00.000Z'),
        }),
      /canonical UTC timestamp/,
    );
  }
});

test('promotion scans logs after Tailnet probes before prepared evidence or pointer mutation', () =>
  withTemporaryDirectory('journal-promotion-final-log-gate-', async (temporary) => {
    const fixture = liveContextFixture(temporary);
    const logDirectory = resolve(fixture.home, '.journal', 'logs');
    const stdoutPath = resolve(logDirectory, 'launchd.out.log');
    const stderrPath = resolve(logDirectory, 'launchd.err.log');
    const journalPath = resolve(logDirectory, 'journald.log');
    mkdirSync(logDirectory, { recursive: true });
    for (const path of [stdoutPath, stderrPath, journalPath]) {
      writeFileSync(path, '', { mode: 0o600 });
      chmodSync(path, 0o600);
    }

    const asset = {
      path: 'app/dist/assets/app.js',
      kind: 'file',
      bytes: 3,
      sha256: 'a'.repeat(64),
    };
    const manifest = { ...fixture.manifest, files: [asset] };
    const releaseIdentity = statSync(fixture.context.releaseRoot, { bigint: true });
    const application = {
      schemaVersion: 1,
      checkedAt: '2026-07-31T12:59:00.000Z',
      origin: 'https://mickey-home.tail8a9beb.ts.net:5178',
      health: { status: 'ok', db: 'ok', version: manifest.release.version },
      asset: { path: asset.path, bytes: asset.bytes, sha256: asset.sha256 },
    };
    const runtime = {
      schemaVersion: 1,
      checkedAt: '2026-07-31T12:59:30.000Z',
      releaseRoot: fixture.context.releaseRoot,
      version: manifest.release.version,
      pid: fixture.evidence.service.pid,
      listener: '127.0.0.1:5178',
      node: resolve(manifest.toolchain.nodePath),
      cli: resolve(fixture.context.releaseRoot, 'server/dist/cli.js'),
      workingDirectory: fixture.context.releaseRoot,
      workingDirectoryIdentity: {
        device: releaseIdentity.dev.toString(),
        inode: releaseIdentity.ino.toString(),
      },
      environment: structuredClone(fixture.evidence.service.process.environment),
      health: structuredClone(application.health),
      asset: structuredClone(application.asset),
    };

    const oldRelease = resolve(temporary, 'old-release');
    const currentLink = resolve(fixture.home, '.journal', 'current-release');
    const preparedPath = resolve(
      fixture.home,
      '.journal',
      'release-evidence',
      `promotion-prepared-${fixture.context.releaseStamp}.json`,
    );
    mkdirSync(oldRelease);
    symlinkSync(oldRelease, currentLink, 'dir');
    let commitCalled = false;
    const phases = [];

    await assert.rejects(
      withFinalPromotionValidation(
        {
          context: fixture.context,
          manifest,
          home: fixture.home,
          cutover: { recordedAt: '2026-07-31T12:00:00.000Z' },
          lifecycle: { recordedAt: '2026-07-31T12:20:00.000Z' },
          liveContext: fixture.evidence,
          serveAfterPath: resolve(temporary, 'not-read-by-injected-verifier.json'),
          now: () => new Date('2026-07-31T13:00:00.000Z'),
          maximumLiveContextAgeMs: 60 * 60 * 1000,
          commit: () => {
            commitCalled = true;
            writeFileSync(preparedPath, '{}\n', { mode: 0o600 });
            rmSync(currentLink);
            symlinkSync(fixture.context.releaseRoot, currentLink, 'dir');
          },
        },
        {
          verifyApplicationOrigin: async () => {
            phases.push('tailnet-http');
            writeFileSync(journalPath, '{"authorization":"Bearer jrn_injected_secret"}\n');
            return application;
          },
          verifyRuntime: async () => {
            phases.push('local-runtime-http');
            return runtime;
          },
          verifyLiveServeSnapshot: () => {
            phases.push('serve');
            return { checkedAt: '2026-07-31T12:59:45.000Z' };
          },
        },
      ),
      /credential-shaped value/,
    );
    assert.deepEqual(phases, ['tailnet-http', 'local-runtime-http', 'serve']);
    assert.equal(commitCalled, false);
    assert.equal(existsSync(preparedPath), false);
    assert.equal(resolve(fixture.home, '.journal', readlinkSync(currentLink)), oldRelease);
  }));

function baselineServe() {
  return {
    TCP: { 443: { HTTPS: true }, 8443: { TCPForward: '127.0.0.1:8443' } },
    Web: {
      'mickey-home.tail8a9beb.ts.net:443': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:5050' } },
      },
      'mickey-home.tail8a9beb.ts.net:8444': {
        Handlers: { '/other': { Proxy: 'http://127.0.0.1:8444' } },
      },
    },
    AllowFunnel: { 'mickey-home.tail8a9beb.ts.net:8444': false },
  };
}

function with5178(document) {
  const result = structuredClone(document);
  result.TCP['5178'] = { HTTPS: true };
  result.Web['mickey-home.tail8a9beb.ts.net:5178'] = {
    Handlers: { '/': { Proxy: 'http://127.0.0.1:5178' } },
  };
  return result;
}

test('Serve verifier compares the entire config and allows only the exact 5178 delta', () => {
  const before = baselineServe();
  const after = with5178(before);
  assert.equal(verifyServeBaseline(before, 'first-install').handler5178, 'absent');
  assert.equal(
    verifyServeChange(before, after, 'first-install').normalized.zeroCollateralChange,
    true,
  );
  assert.equal(
    verifyServeChange(after, structuredClone(after), 'upgrade').handler5178.delta,
    'unchanged',
  );
  assert.equal(
    verifyServeRollback(before, structuredClone(before), 'first-install').normalized
      .zeroCollateralChange,
    true,
  );

  const collateral = structuredClone(after);
  collateral.AllowFunnel['mickey-home.tail8a9beb.ts.net:8444'] = true;
  assert.throws(
    () => verifyServeChange(before, collateral, 'first-install'),
    /outside exact :5178/,
  );
  const wrong443 = structuredClone(after);
  wrong443.Web['mickey-home.tail8a9beb.ts.net:443'].Handlers['/'].Proxy = 'http://127.0.0.1:9999';
  assert.throws(() => verifyServeChange(before, wrong443, 'first-install'), /:443/);
});

test('promotion compares a fresh full Serve snapshot to attested post-cutover state', () =>
  withTemporaryDirectory('journal-live-serve-', (temporary) => {
    const before = baselineServe();
    const attested = with5178(baselineServe());
    const beforePath = resolve(temporary, 'serve-before.json');
    const attestedPath = resolve(temporary, 'serve-after.json');
    writeFileSync(beforePath, JSON.stringify(before));
    writeFileSync(attestedPath, JSON.stringify(attested));
    chmodSync(beforePath, 0o600);
    chmodSync(attestedPath, 0o600);
    const summary = verifyServeChange(before, attested, 'first-install');
    assert.deepEqual(
      verifyAttestedServeEvidence({
        beforePath,
        afterPath: attestedPath,
        mode: 'first-install',
        summary,
      }),
      summary,
    );
    assert.throws(
      () =>
        verifyAttestedServeEvidence({
          beforePath,
          afterPath: attestedPath,
          mode: 'first-install',
          summary: {
            ...summary,
            normalized: { ...summary.normalized, beforeSha256: '0'.repeat(64) },
          },
        }),
      /summary contradicts/,
    );
    const collateralPath = resolve(temporary, 'serve-after-collateral.json');
    const collateral = structuredClone(attested);
    collateral.AllowFunnel['mickey-home.tail8a9beb.ts.net:8444'] = true;
    writeFileSync(collateralPath, JSON.stringify(collateral), { mode: 0o600 });
    assert.throws(
      () =>
        verifyAttestedServeEvidence({
          beforePath,
          afterPath: collateralPath,
          mode: 'first-install',
          summary,
        }),
      /outside exact :5178/,
    );
    const result = verifyLiveServeSnapshot({
      attestedPath,
      serveStatusRunner: () => JSON.stringify(attested),
    });
    assert.equal(result.comparison.normalized.zeroCollateralChange, true);

    const drifted = structuredClone(attested);
    drifted.Web['mickey-home.tail8a9beb.ts.net:443'].Handlers['/'].Proxy = 'http://127.0.0.1:9999';
    assert.throws(
      () =>
        verifyLiveServeSnapshot({
          attestedPath,
          serveStatusRunner: () => drifted,
        }),
      /:443/,
    );
  }));

test('runtime parsers require one launchd PID and preserve listener ownership', () => {
  const launchOutput = 'state = running\n\tpid = 4812\n\tworking directory = /attested/release\n';
  assert.equal(launchdPid(launchOutput), 4812);
  assert.equal(launchdWorkingDirectory(launchOutput), '/attested/release');
  assert.throws(() => launchdPid('pid = 1\npid = 2\n'), /exactly one/);
  assert.throws(
    () => launchdWorkingDirectory('working directory = relative/release\n'),
    /absolute/,
  );
  assert.deepEqual(listenersFromLsof('p4812\nn127.0.0.1:5178\n'), [
    { pid: 4812, name: '127.0.0.1:5178' },
  ]);
  assert.deepEqual(cwdIdentityFromLsof('p4812\nfcwd\nD0x10\ni42\nn/attested/release\n', 4812), {
    pid: 4812,
    path: '/attested/release',
    device: '16',
    inode: '42',
  });
  assert.throws(
    () => cwdIdentityFromLsof('p4812\nfcwd\nn/attested/release\n', 4812),
    /complete cwd identity/,
  );
});

test('promotion requires coherent lifecycle signal, duration, and PID identity evidence', () => {
  const releaseRoot = tmpdir();
  const releaseIdentity = statSync(releaseRoot, { bigint: true });
  const context = {
    releaseStamp: '20260731T120000Z-abcdef123456-99',
    releaseRoot,
    baseCommit: 'abcdef1234567890',
    manifestSha256: '1'.repeat(64),
    archiveSha256: '2'.repeat(64),
  };
  const asset = {
    path: 'app/dist/assets/app.js',
    bytes: 17,
    sha256: '3'.repeat(64),
  };
  const manifest = {
    release: { version: '7.8.9' },
    toolchain: { nodePath: process.execPath },
    files: [{ ...asset, kind: 'file' }],
  };
  const environment = {
    keys: [
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
    ],
    unexpectedKeys: [],
    credentialKeys: [],
    isolatedBy: '/usr/bin/env -i',
    providerOrSchedulerConfigurationAbsent: true,
  };
  const runtime = (pid) => ({
    releaseRoot,
    version: '7.8.9',
    listener: '127.0.0.1:5178',
    node: process.execPath,
    cli: resolve(releaseRoot, 'server/dist/cli.js'),
    workingDirectory: releaseRoot,
    workingDirectoryIdentity: {
      device: releaseIdentity.dev.toString(),
      inode: releaseIdentity.ino.toString(),
    },
    environment,
    health: { status: 'ok', db: 'ok', version: '7.8.9' },
    asset,
    pid,
  });
  const deployedTree = {
    schemaVersion: 1,
    releaseStamp: context.releaseStamp,
    releaseRoot,
    attestationPath: resolve(tmpdir(), `deployed-tree-${context.releaseStamp}.json`),
    attestationSha256: '4'.repeat(64),
    treeSha256: '5'.repeat(64),
    paths: 42,
  };
  const lifecycle = {
    schemaVersion: 1,
    releaseStamp: context.releaseStamp,
    recordedAt: '2026-07-31T12:20:00Z',
    baseCommit: context.baseCommit,
    manifestSha256: context.manifestSha256,
    archiveSha256: context.archiveSha256,
    deployedTree: { ...deployedTree, stableDuringLifecycle: true },
    initialRuntime: runtime(101),
    sigterm: {
      signal: 'SIGTERM',
      exactPid: 101,
      exitElapsedMs: 125.5,
      withinFiveSeconds: true,
      recoveredPid: 202,
      distinctRecovery: true,
      runtime: runtime(202),
    },
    sigkill: {
      signal: 'SIGKILL',
      exactPid: 202,
      exitElapsedMs: 9.5,
      recoveredPid: 303,
      distinctRecovery: true,
      runtime: runtime(303),
    },
  };
  assert.equal(assertLifecycleEvidence(lifecycle, context, manifest, deployedTree), true);
  assert.throws(
    () =>
      assertLifecycleEvidence(
        { ...lifecycle, sigterm: { ...lifecycle.sigterm, signal: 'SIGKILL' } },
        context,
        manifest,
      ),
    /signal identity mismatch/,
  );
  assert.throws(
    () =>
      assertLifecycleEvidence(
        { ...lifecycle, sigterm: { ...lifecycle.sigterm, exitElapsedMs: Number.NaN } },
        context,
        manifest,
      ),
    /finite nonnegative/,
  );
  assert.throws(
    () =>
      assertLifecycleEvidence(
        { ...lifecycle, sigkill: { ...lifecycle.sigkill, exactPid: 999 } },
        context,
        manifest,
      ),
    /target and SIGTERM recovered PID mismatch/,
  );
  assert.throws(
    () =>
      assertLifecycleEvidence(
        {
          ...lifecycle,
          initialRuntime: {
            ...lifecycle.initialRuntime,
            workingDirectoryIdentity: {
              ...lifecycle.initialRuntime.workingDirectoryIdentity,
              inode: '999999999',
            },
          },
        },
        context,
        manifest,
      ),
    /working-directory inode mismatch/,
  );
});

test('benchmark child cleanup treats a signal-terminated child as already terminal', async () => {
  const child = spawn(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")']);
  await new Promise((resolveExit) => child.once('exit', resolveExit));
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, 'SIGKILL');
  const started = Date.now();
  await stopChild(child);
  assert.ok(Date.now() - started < 250, 'cleanup waited after the child had already exited');
});

test('runtime readiness retry is bounded and exercised', async () => {
  const verifierSource = readFileSync(
    resolve(import.meta.dirname, 'release-verify-runtime.mjs'),
    'utf8',
  );
  const runtimeVerifier = verifierSource.indexOf('export async function verifyRuntime');
  const applicationProbe = verifierSource.indexOf('verifyApplicationOnce(', runtimeVerifier);
  const ownershipProbe = verifierSource.indexOf("'/usr/sbin/lsof'", runtimeVerifier);
  assert.ok(
    runtimeVerifier > 0 && applicationProbe > runtimeVerifier && ownershipProbe > applicationProbe,
    'runtime readiness must wait on the cheap application probe before PID-scoped lsof',
  );
  assert.ok(
    verifierSource.includes(
      "['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn']",
    ),
    'runtime listener proof must ignore Tailscale Serve listeners owned by other PIDs',
  );
  assert.match(
    verifierSource.slice(runtimeVerifier),
    /attemptTimeoutMs: Math\.min\(12_000, readinessTimeoutMs\)/,
    'one complete runtime-attestation attempt must not retain the two-second default cap',
  );

  let attempts = 0;
  let clock = 0;
  const result = await retryUntilReady(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`not ready ${attempts}`);
      return 'ready';
    },
    {
      timeoutMs: 10,
      intervalMs: 1,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    },
  );
  assert.equal(result, 'ready');
  assert.equal(attempts, 3);

  await assert.rejects(
    retryUntilReady(
      async () => {
        throw new Error('still starting');
      },
      {
        timeoutMs: 2,
        intervalMs: 1,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      },
    ),
    /within 2ms.*still starting/,
  );

  const realStarted = Date.now();
  await assert.rejects(
    retryUntilReady(async () => new Promise(() => {}), {
      timeoutMs: 10,
      attemptTimeoutMs: 5,
      intervalMs: 1,
    }),
    /within 10ms.*attempt exceeded/,
  );
  assert.ok(Date.now() - realStarted < 250, 'hung readiness attempt exceeded its hard bound');
});

test('application-origin proof checks health and exact served manifest asset', async () => {
  const asset = Buffer.from('console.log("release asset");\n');
  const server = createServer((request, response) => {
    if (request.url === '/healthz') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', db: 'ok', version: '7.8.9' }));
    } else if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<script type="module" src="/assets/app.js"></script>');
    } else if (request.url === '/assets/app.js') {
      response.end(asset);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, 'object');
    const result = await verifyApplicationOrigin({
      origin: `http://127.0.0.1:${address.port}`,
      manifest: {
        release: { version: '7.8.9' },
        files: [
          {
            path: 'app/dist/assets/app.js',
            kind: 'file',
            bytes: asset.byteLength,
            sha256: createHash('sha256').update(asset).digest('hex'),
          },
        ],
      },
      readinessTimeoutMs: 500,
    });
    assert.equal(result.health.db, 'ok');
    assert.equal(result.asset.path, 'app/dist/assets/app.js');
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('zsh helpers execute safe failure paths without special-parameter collisions', () =>
  withTemporaryDirectory('journal-zsh-smoke-', (temporary) => {
    const scripts = resolve(import.meta.dirname);
    const invocations = [
      ['release-prepare.zsh'],
      ['release-stage.zsh'],
      ['release-cutover.zsh', 'invalid', '/nonexistent'],
      ['release-lifecycle.zsh'],
    ];
    for (const arguments_ of invocations) {
      if (process.platform !== 'darwin') {
        break;
      }
      const result = spawnSync(
        '/bin/zsh',
        [resolve(scripts, arguments_[0]), ...arguments_.slice(1)],
        {
          cwd: temporary,
          encoding: 'utf8',
        },
      );
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, `${arguments_[0]} unexpectedly succeeded`);
      assert.doesNotMatch(
        result.stderr,
        /read-?only variable|can't change.*special|PATH.*changed/i,
      );
    }

    const reserved =
      /(?:\b(?:typeset|local)(?:\s+-[A-Za-z]+)*\s+|\bfor\s+)(?:status|path|commands|pipestatus|signals|argv|reply|match|fpath|cdpath|manpath)(?:=|\s|$)/m;
    const maskedDeclaration = /^\s*(?:typeset|local)\b[^\n]*\$\((?!\()[^\n]*/m;
    for (const name of invocations.map(([script]) => script)) {
      const source = readFileSync(resolve(scripts, name), 'utf8');
      assert.doesNotMatch(source, reserved, name);
      assert.doesNotMatch(source, maskedDeclaration, `${name} masks command status in declaration`);
    }
    const prepare = readFileSync(resolve(scripts, 'release-prepare.zsh'), 'utf8');
    const e2eTypecheck = prepare.indexOf('npm exec tsc -- --project e2e/tsconfig.json');
    const ciPlaywright = prepare.indexOf('CI=1 npm run test:e2e');
    const benchmark = prepare.indexOf('node scripts/benchmark-release.mjs --spawn-isolated');
    const manifest = prepare.indexOf('node scripts/release-manifest.mjs --output');
    assert.ok(e2eTypecheck > 0 && e2eTypecheck < ciPlaywright);
    assert.ok(ciPlaywright < benchmark && benchmark < manifest);
    assert.doesNotMatch(prepare.slice(ciPlaywright), /npm run build/);
    assert.match(
      prepare,
      /--arg previousRelease "\$\{previous_release\}"/,
      'first-install context generation must preserve the empty previous-release argument',
    );
    const contextWrite = prepare.indexOf("}' > ${context_next}");
    const contextValidation = prepare.indexOf('${context_next} >/dev/null', contextWrite);
    const contextRename = prepare.indexOf('mv -- ${context_next} ${context}', contextValidation);
    assert.ok(
      contextWrite > 0 && contextValidation > contextWrite && contextRename > contextValidation,
      'release context must be written to a temporary path, validated, then atomically renamed',
    );
    for (const name of invocations.map(([script]) => script)) {
      const source = readFileSync(resolve(scripts, name), 'utf8');
      assert.doesNotMatch(
        source,
        /--arg(?:json)?\s+[A-Za-z][A-Za-z0-9]*\s+\$\{/,
        `${name} must quote jq option values so empty successes cannot shift arguments`,
      );
    }
    const cutover = readFileSync(resolve(scripts, 'release-cutover.zsh'), 'utf8');
    assert.match(cutover, /mode\] & 8#170000 \)\) == \$\(\( 8#100000 \)\)/);
    assert.match(cutover, /mode\] & 8#7777 \)\) == \$\(\( 8#600 \)\)/);
    assert.doesNotMatch(cutover, /mode\] & 0(?:170000|7777)/);
    assert.match(
      cutover,
      /runtime_json=\$\(bounded_command 35[\s\S]*?--timeout-ms 30000\)/,
      'cold-release adoption must have a bounded verifier window and outer kill margin',
    );
    assert.match(
      cutover,
      /plutil -extract WorkingDirectory raw -o - \$\{plist\}/,
      'upgrade preflight must bind the plist working directory to the previous release',
    );
    assert.ok(
      cutover.includes('loaded_working_directory=$(print -r -- ${launch_output}') &&
        cutover.includes('[[ ${loaded_working_directory} == ${previous_release} ]]'),
      'upgrade preflight must bind the loaded launchd working directory',
    );
    assert.ok(
      cutover.includes('/usr/sbin/lsof -nP -a -p ${pid} -d cwd -Fn') &&
        cutover.includes('[[ ${process_working_directory} == ${previous_release}'),
      'upgrade preflight must bind the running PID cwd to the previous release',
    );
    assert.ok(
      cutover.includes(
        'journal_previous_working_directory=$(/usr/bin/plutil -extract WorkingDirectory raw -o - ${plist_before})',
      ) && cutover.includes('[[ ${journal_previous_working_directory} == ${previous_release} ]]'),
      'rollback validation must reject a snapshot from a different working directory',
    );
    const promotionTerminalGuard = cutover.indexOf('if [[ -e ${promotion_evidence} ]]');
    const rollbackBranch = cutover.indexOf('if [[ ${action} == rollback ||');
    const rollbackPointerGuard = cutover.indexOf('assert_current_pointer', rollbackBranch);
    const rollbackValidation = cutover.indexOf('validate_rollback_evidence', rollbackBranch);
    const rollbackMarker = cutover.indexOf(
      'write_terminal_marker in-progress cutover-rollback',
      rollbackValidation,
    );
    const rollbackTreeCheck = cutover.indexOf('verify_deployed_tree', rollbackMarker);
    const rollbackMutation = cutover.indexOf('restore_baseline_resources', rollbackTreeCheck);
    const rollbackEvidenceCommit = cutover.indexOf(
      'write_json_atomically ${rollback_evidence}',
      rollbackMutation,
    );
    const rollbackTerminalCommit = cutover.indexOf(
      'write_terminal_marker rollback-complete cutover-rollback',
      rollbackEvidenceCommit,
    );
    assert.ok(
      promotionTerminalGuard > 0 &&
        rollbackBranch > 0 &&
        rollbackBranch > promotionTerminalGuard &&
        rollbackPointerGuard > rollbackBranch &&
        rollbackValidation > rollbackPointerGuard &&
        rollbackMarker > rollbackValidation &&
        rollbackTreeCheck > rollbackMarker &&
        rollbackMutation > rollbackTreeCheck &&
        rollbackEvidenceCommit > rollbackMutation &&
        rollbackTerminalCommit > rollbackEvidenceCommit,
    );
    assert.match(cutover, /journal_launch_exit == 3 \|\| journal_launch_exit == 113/);
    assert.match(
      cutover,
      /journal_listener_rows=\$\(listener_rows \$\{journal_listener_remaining\}\) \|\| return 1/,
    );
    assert.match(cutover, /validation_timeout=\$\{1:-12\.0\}/);
    assert.match(cutover, /journal_max_attempt_timeout=\$\{2:-12\.0\}/);
    const launchdAbsence = shellFunction(
      cutover,
      'wait_launchctl_job_absent',
      'bootout_owned_service',
    );
    assert.match(launchdAbsence, /journal_stable_absence_count >= 2/);
    assert.match(launchdAbsence, /journal_absence_exit == 3 \|\| journal_absence_exit == 113/);
    assert.match(
      shellFunction(cutover, 'bootout_owned_service', 'assert_owner_private_file'),
      /wait_launchctl_job_absent 5\.0/,
      'every accepted bootout must settle before a same-label bootstrap can run',
    );
    const stage = readFileSync(resolve(scripts, 'release-stage.zsh'), 'utf8');
    assert.match(stage, /trap 'abort_staging 130' INT/);
    const lifecycle = readFileSync(resolve(scripts, 'release-lifecycle.zsh'), 'utf8');
    assert.match(lifecycle, /candidate=\$\(live_pid \$\{launch_timeout\}/);
    assert.match(lifecycle, /zmodload zsh\/system/);
    assert.match(lifecycle, /zmodload -F zsh\/stat b:zstat/);
    assert.match(lifecycle, /global_lock=\$\{HOME\}\/\.journal\/release-global\.lock/);
    assert.match(lifecycle, /sysopen -rw -o creat,nofollow -m 0600/);
    assert.match(lifecycle, /\/usr\/bin\/lockf -s -t 0 \$\{global_lock_fd\}/);
    assert.match(lifecycle, /\.state == "cutover-complete" and \.operation == "cutover-apply"/);
    assert.doesNotMatch(lifecycle, /(?:rm|unlink)[^\n]*global_lock/);
    const lifecycleAcquire = lifecycle.indexOf('\nacquire_global_lock\n');
    const lifecycleExitTrap = lifecycle.indexOf(
      'trap lifecycle_exit_handler EXIT',
      lifecycleAcquire,
    );
    const lifecycleEvidenceAbsence = lifecycle.indexOf(
      '[[ ! -e ${evidence} && ! -L ${evidence} ]]',
      lifecycleExitTrap,
    );
    const lifecycleInitialTree = lifecycle.indexOf(
      'deployed_initial=$(bounded_command 30',
      lifecycleEvidenceAbsence,
    );
    const lifecycleTerminal = lifecycle.indexOf(
      '\nassert_cutover_terminal\n',
      lifecycleInitialTree,
    );
    const lifecycleInitialRuntime = lifecycle.indexOf(
      'initial_runtime=$(bounded_command 20',
      lifecycleTerminal,
    );
    const lifecycleTermSignal = lifecycle.indexOf(
      'kill -TERM ${term_pid}',
      lifecycleInitialRuntime,
    );
    const lifecycleKillSignal = lifecycle.indexOf(
      'kill -KILL ${term_recovered_pid}',
      lifecycleTermSignal,
    );
    const lifecycleFinalTree = lifecycle.indexOf(
      'deployed_final=$(bounded_command 30',
      lifecycleKillSignal,
    );
    const lifecycleEvidenceCommit = lifecycle.indexOf(
      '${release}/scripts/release-atomic-file.mjs',
      lifecycleFinalTree,
    );
    assert.ok(
      lifecycleAcquire > 0 &&
        lifecycleExitTrap > lifecycleAcquire &&
        lifecycleEvidenceAbsence > lifecycleExitTrap &&
        lifecycleInitialTree > lifecycleEvidenceAbsence &&
        lifecycleTerminal > lifecycleInitialTree &&
        lifecycleInitialRuntime > lifecycleTerminal &&
        lifecycleTermSignal > lifecycleInitialRuntime &&
        lifecycleKillSignal > lifecycleTermSignal &&
        lifecycleFinalTree > lifecycleKillSignal &&
        lifecycleEvidenceCommit > lifecycleFinalTree,
      'lifecycle must hold the global lock from evidence absence through terminal validation, signals, runtime checks, and evidence commit',
    );
    const lifecycleRelease = shellFunction(
      lifecycle,
      'release_global_lock',
      'lifecycle_exit_handler',
    );
    assert.ok(
      lifecycleRelease.indexOf('assert_global_lock_identity yes') <
        lifecycleRelease.indexOf('exec {global_lock_fd}>&-'),
      'lifecycle must verify the stable lock identity before closing its descriptor',
    );
    assert.match(
      shellFunction(lifecycle, 'lifecycle_exit_handler', 'assert_cutover_terminal'),
      /release_global_lock \|\| journal_lifecycle_exit=1/,
    );
    const launchdListenerRows = shellFunction(
      cutover,
      'launchd_listener_rows',
      'assert_current_pointer',
    );
    assert.match(
      launchdListenerRows,
      /\/usr\/sbin\/lsof -nP -a -p \$\{journal_launchd_pid\}[\s\\]*-iTCP:5178 -sTCP:LISTEN -Fpn/,
      'upgrade listener inspection must be scoped to the launchd-owned PID',
    );
    const upgradeRuntime = shellFunction(cutover, 'assert_upgrade_runtime', 'wait_upgrade_runtime');
    assert.match(
      upgradeRuntime,
      /rows=\$\(launchd_listener_rows \$\{validation_remaining\} \$\{pid\}\)/,
    );
    assert.doesNotMatch(upgradeRuntime, /rows=\$\(listener_rows /);
    const initialLaunchRead = upgradeRuntime.indexOf('/bin/launchctl print ${service_target}');
    const listenerRead = upgradeRuntime.indexOf(
      'launchd_listener_rows ${validation_remaining} ${pid}',
    );
    const cwdRead = upgradeRuntime.indexOf('/usr/sbin/lsof -nP -a -p ${pid} -d cwd -Fn');
    const finalLaunchRead = upgradeRuntime.indexOf(
      '/bin/launchctl print ${service_target}',
      initialLaunchRead + 1,
    );
    const generationGuard = upgradeRuntime.indexOf('[[ ${final_pid} == ${pid}');
    assert.ok(
      initialLaunchRead > 0 &&
        listenerRead > initialLaunchRead &&
        cwdRead > listenerRead &&
        finalLaunchRead > cwdRead &&
        generationGuard > finalLaunchRead,
      'upgrade preflight must recheck launchd PID and cwd after listener/cwd inspection',
    );
    const upgradeBranch = cutover.indexOf('if [[ ${mode} == upgrade ]]', rollbackMutation);
    const privateConfig = cutover.indexOf('assert_owner_private_file ${config}', upgradeBranch);
    const runtimePreflight = cutover.indexOf('assert_upgrade_runtime 12.0', privateConfig);
    const snapshotCopy = cutover.indexOf(
      'copy_private_atomically ${config} ${config_before}',
      runtimePreflight,
    );
    const snapshotCompare = cutover.indexOf(
      'compare_private_files ${config_before} ${config}',
      snapshotCopy,
    );
    const finalRuntimePreflight = cutover.indexOf('assert_upgrade_runtime 12.0', snapshotCompare);
    const transactionCreate = cutover.indexOf(
      'transaction_command transaction-create',
      finalRuntimePreflight,
    );
    const applyTreeCheck = cutover.indexOf('verify_deployed_tree', transactionCreate);
    const applyPointerGuard = cutover.indexOf('assert_current_pointer', applyTreeCheck);
    const applyMutation = cutover.indexOf(
      'restore_private_atomically ${config_next} ${config}',
      applyPointerGuard,
    );
    assert.ok(
      privateConfig > upgradeBranch &&
        runtimePreflight > privateConfig &&
        snapshotCopy > runtimePreflight &&
        snapshotCompare > snapshotCopy &&
        finalRuntimePreflight > snapshotCompare &&
        transactionCreate > finalRuntimePreflight &&
        applyTreeCheck > transactionCreate &&
        applyPointerGuard > applyTreeCheck &&
        applyMutation > applyPointerGuard,
    );

    const applyAbsenceGuard = cutover.lastIndexOf(
      '[[ ! -e ${rollback_evidence} && ! -e ${serve_rollback_after}',
    );
    const initialPointerGuard = cutover.indexOf('\nassert_current_pointer\n', applyAbsenceGuard);
    const initialDnsRead = cutover.indexOf(
      'self_dns=$(bounded_command 5 tailscale status',
      initialPointerGuard,
    );
    const initialDnsGuard = cutover.indexOf(
      '[[ ${self_dns} == ${expected_host} ]]',
      initialDnsRead,
    );
    const initialUpgradeBranch = cutover.indexOf('if [[ ${mode} == upgrade ]]', initialDnsGuard);
    const initialConfigGuard = cutover.indexOf(
      '[[ -f ${config} && -f ${plist} ]]',
      initialUpgradeBranch,
    );
    const initialConfigOwnership = cutover.indexOf(
      'assert_owner_private_file ${config}',
      initialConfigGuard,
    );
    const initialPlistOwnership = cutover.indexOf(
      'assert_owner_private_file ${plist}',
      initialConfigOwnership,
    );
    const initialRuntimeGuard = cutover.indexOf(
      'assert_upgrade_runtime 12.0',
      initialPlistOwnership,
    );
    const initialFirstInstallGuard = cutover.indexOf(
      'assert_first_install_absent',
      initialRuntimeGuard,
    );
    const applyMarker = cutover.indexOf(
      'write_terminal_marker in-progress cutover-apply',
      initialFirstInstallGuard,
    );
    const firstSnapshot = cutover.indexOf('capture_serve_snapshot ${serve_before}', applyMarker);
    assert.ok(
      applyAbsenceGuard > 0 &&
        initialPointerGuard > applyAbsenceGuard &&
        initialDnsRead > initialPointerGuard &&
        initialDnsGuard > initialDnsRead &&
        initialUpgradeBranch > initialDnsGuard &&
        initialConfigGuard > initialUpgradeBranch &&
        initialConfigOwnership > initialConfigGuard &&
        initialPlistOwnership > initialConfigOwnership &&
        initialRuntimeGuard > initialPlistOwnership &&
        initialFirstInstallGuard > initialRuntimeGuard &&
        applyMarker > initialFirstInstallGuard &&
        firstSnapshot > applyMarker,
      'the apply marker must follow all read-only preflight and precede the first snapshot',
    );
    assert.doesNotMatch(
      cutover.slice(applyAbsenceGuard, applyMarker),
      /(?:capture_serve_snapshot|copy_private_atomically|restore_private_atomically|write_json_atomically|transaction_command transaction-create|install-service|tailscale serve --)/,
      'no snapshot or runtime/config mutation may precede the initial apply marker',
    );

    const previousProgramHarness = `
emulate -LR zsh
setopt NO_UNSET PIPE_FAIL
${shellFunction(cutover, 'parse_previous_program', 'assert_upgrade_runtime')}
typeset -r expected_cli=/releases/previous/server/dist/cli.js
typeset -r environment='{"NODE_ENV":"production","JOURNAL_PORT":"5178"}'
typeset -r legacy='["/opt/node/bin/node","/releases/previous/server/dist/cli.js","serve"]'
typeset -r isolated='["/usr/bin/env","-i","JOURNAL_PORT=5178","NODE_ENV=production","/opt/node/bin/node","/releases/previous/server/dist/cli.js","serve"]'
typeset -r extra='["/usr/bin/env","-i","EXTRA_PROVIDER_KEY=secret","JOURNAL_PORT=5178","NODE_ENV=production","/opt/node/bin/node","/releases/previous/server/dist/cli.js","serve"]'
typeset -r missing='["/usr/bin/env","-i","NODE_ENV=production","/opt/node/bin/node","/releases/previous/server/dist/cli.js","serve"]'
typeset -r duplicate='["/usr/bin/env","-i","JOURNAL_PORT=5178","JOURNAL_PORT=5178","NODE_ENV=production","/opt/node/bin/node","/releases/previous/server/dist/cli.js","serve"]'
typeset -r altered='["/usr/bin/env","-i","JOURNAL_PORT=9999","NODE_ENV=production","/opt/node/bin/node","/releases/previous/server/dist/cli.js","serve"]'
typeset -r expected=$'/opt/node/bin/node\t/releases/previous/server/dist/cli.js'
[[ $(parse_previous_program "\${legacy}" "\${expected_cli}" "\${environment}") == "\${expected}" ]] || exit 81
[[ $(parse_previous_program "\${isolated}" "\${expected_cli}" "\${environment}") == "\${expected}" ]] || exit 82
typeset rejected
for rejected in "\${extra}" "\${missing}" "\${duplicate}" "\${altered}"; do
  if parse_previous_program "\${rejected}" "\${expected_cli}" "\${environment}" >/dev/null 2>&1; then
    exit 83
  fi
done
print -- previous-program-shapes
`;
    const previousProgramResult = spawnSync('zsh', ['-c', previousProgramHarness], {
      encoding: 'utf8',
    });
    assert.equal(previousProgramResult.status, 0, previousProgramResult.stderr);
    assert.match(previousProgramResult.stdout, /previous-program-shapes/);

    const predicateHarness = `
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL
${shellFunction(cutover, 'bounded_command', 'listener_rows')}
${shellFunction(cutover, 'wait_upgrade_runtime', 'wait_no_listener')}
${shellFunction(cutover, 'wait_no_listener', 'assert_launchctl_job_absent')}
${shellFunction(cutover, 'assert_launchctl_job_absent', 'assert_first_install_absent')}
zmodload zsh/datetime
assert_upgrade_runtime() { sleep \${1}; return 1 }
typeset started=\${EPOCHREALTIME}
if bounded_command 0.05 /bin/sleep 1; then exit 89; fi
typeset bounded_elapsed=$(( EPOCHREALTIME - started ))
(( bounded_elapsed < 0.25 )) || exit 95
started=\${EPOCHREALTIME}
if wait_upgrade_runtime 0.08 0.02; then exit 90; fi
typeset elapsed=$(( EPOCHREALTIME - started ))
(( elapsed < 0.25 )) || exit 91
listener_rows() { return 41 }
if wait_no_listener; then exit 92; fi
listener_rows() { bounded_command \${1} /bin/sleep 1 }
started=\${EPOCHREALTIME}
if wait_no_listener 0.05; then exit 96; fi
elapsed=$(( EPOCHREALTIME - started ))
(( elapsed < 0.25 )) || exit 97
if assert_launchctl_job_absent 1 permission-denied; then exit 93; fi
assert_launchctl_job_absent 3 ''
assert_launchctl_job_absent 113 ''
if assert_launchctl_job_absent 0 loaded; then exit 94; fi
print -- fail-closed-predicates
`;
    const predicateResult = spawnSync('zsh', ['-c', predicateHarness], { encoding: 'utf8' });
    assert.equal(predicateResult.status, 0, predicateResult.stderr);
    assert.match(predicateResult.stdout, /fail-closed-predicates/);

    const absenceCounter = resolve(temporary, 'launchd-absence-counter');
    const absenceHarness = `
emulate -LR zsh
setopt NO_UNSET PIPE_FAIL
zmodload zsh/datetime
typeset -r service_target=gui/501/com.rsreberski.journald
typeset -r journal_test_mode=\${TEST_ABSENCE_MODE}
function bounded_command {
  typeset -r journal_test_timeout=$1
  shift
  (( journal_test_timeout > 0.0 )) || return 124
  [[ $1 == /bin/launchctl && $2 == print ]] || return 72
  typeset journal_test_count=0
  [[ ! -s \${TEST_ABSENCE_COUNTER} ]] || journal_test_count=$(<\${TEST_ABSENCE_COUNTER})
  (( journal_test_count += 1 ))
  print -r -- \${journal_test_count} >| \${TEST_ABSENCE_COUNTER}
  case \${journal_test_mode} in
    delayed)
      (( journal_test_count == 1 )) && { print -- loaded; return 0; }
      return 3
      ;;
    flap)
      (( journal_test_count == 2 )) && { print -- loaded; return 0; }
      return 3
      ;;
    loaded) print -- loaded; return 0 ;;
    unexpected) print -- denied; return 77 ;;
    *) return 78 ;;
  esac
}
${launchdAbsence}
if wait_launchctl_job_absent 1.2; then
  print -- launchd-absence-pass
  exit 0
fi
exit 1
`;
    for (const [mode, shouldPass] of [
      ['delayed', true],
      ['flap', true],
      ['loaded', false],
      ['unexpected', false],
    ]) {
      writeFileSync(absenceCounter, '0\n');
      const startedAt = Date.now();
      const result = spawnSync('zsh', ['-c', absenceHarness], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TEST_ABSENCE_COUNTER: absenceCounter,
          TEST_ABSENCE_MODE: mode,
        },
      });
      // The flap path needs four probes across three external `sleep 0.1`
      // spawns; at 0.6s the budget sat on the edge of macOS process-spawn
      // latency and the suite coin-flipped on busy machines. 1.2s keeps the
      // boundedness claim (the real cutover allows 5.0s) without the flake.
      assert.ok(Date.now() - startedAt < 3_000, `${mode} absence probe was not bounded`);
      assert.equal(result.status === 0, shouldPass, `${mode}: ${result.stderr}`);
      if (shouldPass) assert.match(result.stdout, /launchd-absence-pass/);
    }

    const listenerHome = resolve(temporary, 'listener-home');
    const previousRelease = resolve(temporary, 'previous-release');
    const listenerConfig = resolve(listenerHome, '.journal/config.json');
    const listenerPlist = resolve(listenerHome, 'journal.plist');
    const listenerCounter = resolve(temporary, 'launch-counter');
    const previousNode = resolve(previousRelease, 'bin/node');
    const previousCli = resolve(previousRelease, 'server/dist/cli.js');
    mkdirSync(resolve(listenerHome, '.journal'), { recursive: true });
    mkdirSync(resolve(previousRelease, 'bin'), { recursive: true });
    mkdirSync(resolve(previousRelease, 'server/dist'), { recursive: true });
    writeFileSync(previousNode, '#!/bin/sh\nexit 0\n');
    writeFileSync(previousCli, '#!/bin/sh\nexit 0\n');
    chmodSync(previousNode, 0o755);
    chmodSync(previousCli, 0o755);
    writeFileSync(listenerPlist, 'test fixture\n');
    writeFileSync(
      listenerConfig,
      `${JSON.stringify({
        port: 5178,
        bindHost: '127.0.0.1',
        dataDir: resolve(listenerHome, '.journal'),
        hostAllowlist: ['localhost:5178', '127.0.0.1:5178', 'mickey-home.tail8a9beb.ts.net:5178'],
        tailnetHostname: 'mickey-home.tail8a9beb.ts.net:5178',
        timezone: 'Europe/Amsterdam',
        dayBoundaryOffsetMin: 0,
      })}\n`,
    );
    const listenerHarness = `
emulate -LR zsh
setopt NO_UNSET PIPE_FAIL
zmodload zsh/datetime
typeset -r service_target=gui/501/com.rsreberski.journald
typeset -r previous_release=\${TEST_PREVIOUS_RELEASE}
typeset -r plist=\${TEST_PLIST}
typeset -r config=\${TEST_CONFIG}
typeset -r listener_mode=\${TEST_LISTENER_MODE}
typeset -r launch_mode=\${TEST_LAUNCH_MODE}
function bounded_command {
  typeset -r journal_test_timeout=$1
  shift
  (( journal_test_timeout > 0.0 )) || return 124
  typeset -r journal_test_command=$1
  case \${journal_test_command} in
    /bin/launchctl)
      typeset journal_test_count=0 journal_test_pid=4812 journal_test_cwd=\${previous_release}
      [[ ! -s \${TEST_LAUNCH_COUNTER} ]] || journal_test_count=$(<\${TEST_LAUNCH_COUNTER})
      (( journal_test_count += 1 ))
      print -r -- \${journal_test_count} >| \${TEST_LAUNCH_COUNTER}
      if (( journal_test_count > 1 )); then
        [[ \${launch_mode} != pid-drift ]] || journal_test_pid=4813
        [[ \${launch_mode} != cwd-drift ]] || journal_test_cwd=\${previous_release}/replacement
      fi
      print -r -- 'service = {'
      print -r -- "    working directory = \${journal_test_cwd}"
      print -r -- "    pid = \${journal_test_pid}"
      print -r -- '}'
      ;;
    /usr/bin/plutil)
      case $3 in
        ProgramArguments) print -r -- \${TEST_PROGRAM_ARGUMENTS} ;;
        EnvironmentVariables) print -r -- \${TEST_PLIST_ENVIRONMENT} ;;
        WorkingDirectory) print -r -- \${previous_release} ;;
        *) return 70 ;;
      esac
      ;;
    /usr/sbin/lsof)
      typeset -r journal_test_arguments="\${(j: :)@}"
      if [[ \${journal_test_arguments} == *'-d cwd'* ]]; then
        print -r -- $'p4812\\nfcwd\\nn'\${previous_release}
      elif [[ \${journal_test_arguments} != *'-a -p 4812 -iTCP:5178'* ]]; then
        print -r -- $'p4812\\nn127.0.0.1:5178\\np777\\nn100.100.100.100:5178\\np778\\nn*:5178'
      else
        case \${listener_mode} in
          owned) print -r -- $'p4812\\nn127.0.0.1:5178' ;;
          missing) return 1 ;;
          duplicate) print -r -- $'p4812\\nn127.0.0.1:5178\\nn127.0.0.1:5178' ;;
          wrong-endpoint) print -r -- $'p4812\\nn[::1]:5178' ;;
          wrong-pid) print -r -- $'p9999\\nn127.0.0.1:5178' ;;
          *) return 71 ;;
        esac
      fi
      ;;
    curl) print -r -- '{"status":"ok","db":"ok","version":"1.0.0"}' ;;
    jq) command "$@" ;;
    *) return 72 ;;
  esac
}
${shellFunction(cutover, 'parse_previous_program', 'assert_upgrade_runtime')}
${launchdListenerRows}
${upgradeRuntime}
if assert_upgrade_runtime 3; then
  print -- listener-preflight-pass
  exit 0
fi
exit 1
`;
    const listenerEnvironment = {
      ...process.env,
      HOME: listenerHome,
      TEST_PREVIOUS_RELEASE: previousRelease,
      TEST_CONFIG: listenerConfig,
      TEST_PLIST: listenerPlist,
      TEST_PROGRAM_ARGUMENTS: JSON.stringify([previousNode, previousCli, 'serve']),
      TEST_PLIST_ENVIRONMENT: JSON.stringify({
        JOURNAL_CONFIG: listenerConfig,
        JOURNAL_DATA_DIR: resolve(listenerHome, '.journal'),
        JOURNAL_VERSION: '1.0.0',
      }),
      TEST_LAUNCH_COUNTER: listenerCounter,
    };
    for (const [listenerMode, launchMode, shouldPass] of [
      ['owned', 'stable', true],
      ['missing', 'stable', false],
      ['duplicate', 'stable', false],
      ['wrong-endpoint', 'stable', false],
      ['wrong-pid', 'stable', false],
      ['owned', 'pid-drift', false],
      ['owned', 'cwd-drift', false],
    ]) {
      writeFileSync(listenerCounter, '0\n');
      const result = spawnSync('zsh', ['-c', listenerHarness], {
        encoding: 'utf8',
        env: {
          ...listenerEnvironment,
          TEST_LISTENER_MODE: listenerMode,
          TEST_LAUNCH_MODE: launchMode,
        },
      });
      assert.equal(
        result.status === 0,
        shouldPass,
        `${listenerMode}/${launchMode}: ${result.stderr}`,
      );
      if (shouldPass) assert.match(result.stdout, /listener-preflight-pass/);
    }

    const fixtureRoot = resolve(temporary, 'failure-injection');
    const fixtureScripts = resolve(fixtureRoot, 'scripts');
    const fixtureBin = resolve(fixtureRoot, 'bin');
    const fixtureHome = resolve(fixtureRoot, 'home');
    const sentinel = resolve(fixtureRoot, 'mutation-sentinel');
    mkdirSync(fixtureScripts, { recursive: true });
    mkdirSync(fixtureBin);
    mkdirSync(fixtureHome);
    writeFileSync(resolve(fixtureRoot, '.nvmrc'), '0.0.0\n');
    for (const name of invocations.map(([script]) => script)) {
      copyFileSync(resolve(scripts, name), resolve(fixtureScripts, name));
    }
    writeFileSync(resolve(fixtureRoot, 'context.json'), '{}\n');
    writeFileSync(resolve(fixtureBin, 'jq'), '#!/bin/sh\nexit 41\n');
    for (const commandName of ['npm', 'tailscale']) {
      writeFileSync(
        resolve(fixtureBin, commandName),
        `#!/bin/sh\nprintf mutation > ${JSON.stringify(sentinel)}\nexit 42\n`,
      );
      chmodSync(resolve(fixtureBin, commandName), 0o755);
    }
    chmodSync(resolve(fixtureBin, 'jq'), 0o755);
    const injectedEnvironment = {
      ...process.env,
      HOME: fixtureHome,
      PATH: `${fixtureBin}:${process.env.PATH}`,
    };
    for (const [name, arguments_] of [
      ['release-prepare.zsh', []],
      ['release-stage.zsh', [resolve(fixtureRoot, 'context.json')]],
      ['release-cutover.zsh', ['apply', resolve(fixtureRoot, 'context.json')]],
      ['release-lifecycle.zsh', [resolve(fixtureRoot, 'context.json')]],
    ]) {
      rmSync(sentinel, { force: true });
      const result = spawnSync('zsh', [resolve(fixtureScripts, name), ...arguments_], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: injectedEnvironment,
      });
      assert.notEqual(result.status, 0, `${name} accepted an injected validation failure`);
      assert.equal(existsSync(sentinel), false, `${name} reached a mutation sentinel`);
    }
  }));

test('promotion transaction binds validated live-context bytes before pointer CAS', () =>
  withTemporaryDirectory('journal-promotion-commit-', (temporary) => {
    const fixture = promotionTransactionFixture(temporary);
    let preparedObserved = false;
    const result = commitPromotionPointer({
      currentLink: fixture.currentLink,
      releaseRoot: fixture.context.releaseRoot,
      promotionPath: fixture.promotionPath,
      preparedPath: fixture.preparedPath,
      expectedCurrentRelease: fixture.oldRelease,
      promotion: fixture.promotion,
      context: fixture.context,
      beforePointerRename: () => {
        preparedObserved = true;
        assert.equal(resolve(temporary, readlinkSync(fixture.currentLink)), fixture.oldRelease);
        assert.equal(existsSync(fixture.promotionPath), false);
        const prepared = JSON.parse(readFileSync(fixture.preparedPath, 'utf8'));
        assert.deepEqual(prepared.liveContextSource, fixture.promotion.liveContextSource);
        assert.equal(prepared.liveContextSource.sha256, sha256File(fixture.liveContextPath));
      },
    });
    assert.equal(result.state, 'committed');
    assert.equal(preparedObserved, true);
    assert.equal(
      resolve(temporary, readlinkSync(fixture.currentLink)),
      fixture.context.releaseRoot,
    );
    assert.equal(existsSync(fixture.preparedPath), false);
    assert.equal(lstatSync(fixture.promotionPath).mode & 0o7777, 0o600);
    const finalEvidence = JSON.parse(readFileSync(fixture.promotionPath, 'utf8'));
    assert.deepEqual(finalEvidence.liveContextSource, fixture.promotion.liveContextSource);
    assert.equal(
      recoverPromotionTransaction({
        currentLink: fixture.currentLink,
        releaseRoot: fixture.context.releaseRoot,
        promotionPath: fixture.promotionPath,
        preparedPath: fixture.preparedPath,
        expectedCurrentRelease: fixture.oldRelease,
        context: fixture.context,
      }).state,
      'committed',
    );
  }));

test('promotion commit rechecks live-context bytes immediately before pointer CAS', () =>
  withTemporaryDirectory('journal-promotion-live-context-cas-', (temporary) => {
    const fixture = promotionTransactionFixture(temporary);
    assert.throws(
      () =>
        commitPromotionPointer({
          currentLink: fixture.currentLink,
          releaseRoot: fixture.context.releaseRoot,
          promotionPath: fixture.promotionPath,
          preparedPath: fixture.preparedPath,
          expectedCurrentRelease: fixture.oldRelease,
          promotion: fixture.promotion,
          context: fixture.context,
          beforePointerRename: () => {
            fixture.writeEvidence({
              ...fixture.evidence,
              recordedAt: '2026-07-31T12:31:00.000Z',
            });
          },
        }),
      /Promotion live-context bound bytes mismatch/,
    );
    assert.equal(resolve(temporary, readlinkSync(fixture.currentLink)), fixture.oldRelease);
    assert.equal(existsSync(fixture.preparedPath), false);
    assert.equal(existsSync(fixture.promotionPath), false);
  }));

test('promotion pointer commit is compare-and-swap and preserves a competing winner', () =>
  withTemporaryDirectory('journal-promotion-cas-', (temporary) => {
    const fixture = promotionTransactionFixture(temporary);
    const competingRelease = resolve(temporary, 'competing-release');
    mkdirSync(competingRelease);
    assert.throws(
      () =>
        commitPromotionPointer({
          currentLink: fixture.currentLink,
          releaseRoot: fixture.context.releaseRoot,
          promotionPath: fixture.promotionPath,
          preparedPath: fixture.preparedPath,
          expectedCurrentRelease: fixture.oldRelease,
          promotion: fixture.promotion,
          context: fixture.context,
          beforePointerRename: () => {
            rmSync(fixture.currentLink);
            symlinkSync(competingRelease, fixture.currentLink, 'dir');
          },
        }),
      /changed before the promotion compare-and-swap/,
    );
    assert.equal(resolve(temporary, readlinkSync(fixture.currentLink)), competingRelease);
    assert.equal(existsSync(fixture.preparedPath), false);
    assert.equal(existsSync(fixture.promotionPath), false);
  }));

test('promotion transaction recovers every durable crash boundary without false final evidence', () =>
  withTemporaryDirectory('journal-promotion-crash-', (temporary) => {
    const moduleUrl = new URL('./release-promote.mjs', import.meta.url).href;
    const childSource = `
import { readFileSync } from 'node:fs';
import { commitPromotionPointer } from ${JSON.stringify(moduleUrl)};
const input = JSON.parse(readFileSync(process.argv[1], 'utf8'));
commitPromotionPointer({
  ...input,
  phaseObserver: (phase) => {
    if (phase === process.argv[2]) process.kill(process.pid, 'SIGKILL');
  },
});
`;
    const prePointerPhases = new Set([
      'prepared-candidate-written',
      'prepared-evidence-renamed',
      'prepared-evidence-directory-synced',
      'prepared-pointer-created',
      'prepared',
    ]);
    for (const phase of [
      ...prePointerPhases,
      'pointer-renamed',
      'pointer-directory-synced',
      'evidence-renamed',
    ]) {
      const phaseRoot = resolve(temporary, phase);
      mkdirSync(phaseRoot, { recursive: true });
      const fixture = promotionTransactionFixture(phaseRoot);
      const inputPath = resolve(phaseRoot, 'child-input.json');
      writeFileSync(
        inputPath,
        `${JSON.stringify({
          currentLink: fixture.currentLink,
          releaseRoot: fixture.context.releaseRoot,
          promotionPath: fixture.promotionPath,
          preparedPath: fixture.preparedPath,
          expectedCurrentRelease: fixture.oldRelease,
          promotion: fixture.promotion,
          context: fixture.context,
        })}\n`,
      );
      const crashed = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', childSource, inputPath, phase],
        { encoding: 'utf8' },
      );
      assert.equal(crashed.signal, 'SIGKILL', `${phase}: ${crashed.stderr}`);

      const recovery = recoverPromotionTransaction({
        currentLink: fixture.currentLink,
        releaseRoot: fixture.context.releaseRoot,
        promotionPath: fixture.promotionPath,
        preparedPath: fixture.preparedPath,
        expectedCurrentRelease: fixture.oldRelease,
        context: fixture.context,
      });
      if (prePointerPhases.has(phase)) {
        assert.equal(recovery.state, 'restart-required');
        assert.equal(existsSync(fixture.promotionPath), false);
        assert.equal(resolve(phaseRoot, readlinkSync(fixture.currentLink)), fixture.oldRelease);
        assert.equal(
          commitPromotionPointer({
            currentLink: fixture.currentLink,
            releaseRoot: fixture.context.releaseRoot,
            promotionPath: fixture.promotionPath,
            preparedPath: fixture.preparedPath,
            expectedCurrentRelease: fixture.oldRelease,
            promotion: fixture.promotion,
            context: fixture.context,
          }).state,
          'committed',
        );
      } else {
        assert.ok(['recovered', 'committed'].includes(recovery.state));
      }
      assert.equal(
        resolve(phaseRoot, readlinkSync(fixture.currentLink)),
        fixture.context.releaseRoot,
      );
      assert.equal(existsSync(fixture.preparedPath), false);
      assert.equal(existsSync(fixture.promotionPath), true);
    }
  }));

test('promotion recovery removes only its partial candidate and orphan pointer before retry', () =>
  withTemporaryDirectory('journal-promotion-partial-candidate-', (temporary) => {
    const fixture = promotionTransactionFixture(temporary);
    const candidatePath = `${fixture.preparedPath}.next`;
    const temporaryLink = `${fixture.currentLink}.next-${fixture.context.releaseStamp}`;
    writeFileSync(candidatePath, '{"partial":', { mode: 0o600 });
    chmodSync(candidatePath, 0o600);
    symlinkSync(fixture.context.releaseRoot, temporaryLink, 'dir');
    assert.equal(
      recoverPromotionTransaction({
        currentLink: fixture.currentLink,
        releaseRoot: fixture.context.releaseRoot,
        promotionPath: fixture.promotionPath,
        preparedPath: fixture.preparedPath,
        expectedCurrentRelease: fixture.oldRelease,
        context: fixture.context,
      }).state,
      'restart-required',
    );
    assert.equal(existsSync(candidatePath), false);
    assert.equal(existsSync(temporaryLink), false);
    assert.equal(resolve(temporary, readlinkSync(fixture.currentLink)), fixture.oldRelease);
    assert.equal(
      commitPromotionPointer({
        currentLink: fixture.currentLink,
        releaseRoot: fixture.context.releaseRoot,
        promotionPath: fixture.promotionPath,
        preparedPath: fixture.preparedPath,
        expectedCurrentRelease: fixture.oldRelease,
        promotion: fixture.promotion,
        context: fixture.context,
      }).state,
      'committed',
    );
  }));

test('stable global lockf inode serializes before work and survives owner exit', () =>
  withTemporaryDirectory('journal-terminal-lock-', async (temporary) => {
    const globalLock = resolve(temporary, 'release-global.lock');
    let entered = false;
    await assert.rejects(
      withGlobalReleaseLock(
        globalLock,
        'promotion',
        async () => {
          entered = true;
        },
        {
          runLockf: () => {
            throw new Error('injected contention');
          },
        },
      ),
      /Another global release operation/,
    );
    assert.equal(entered, false);
    assert.equal(lstatSync(globalLock).isFile(), true);
    assert.equal(lstatSync(globalLock).mode & 0o7777, 0o600);

    if (process.platform === 'darwin') {
      let releaseFirst;
      let markEntered;
      const firstEntered = new Promise((resolveEntered) => {
        markEntered = resolveEntered;
      });
      const gate = new Promise((resolveGate) => {
        releaseFirst = resolveGate;
      });
      const first = withGlobalReleaseLock(globalLock, 'promotion', async () => {
        markEntered();
        await gate;
        return 'first-context';
      });
      await firstEntered;
      const lockedIdentity = lstatSync(globalLock);
      await assert.rejects(
        withGlobalReleaseLock(globalLock, 'cutover-apply', async () => 'second-context'),
        /Another global release operation/,
      );
      releaseFirst();
      assert.equal(await first, 'first-context');
      const releasedIdentity = lstatSync(globalLock);
      assert.equal(releasedIdentity.dev, lockedIdentity.dev);
      assert.equal(releasedIdentity.ino, lockedIdentity.ino);
      assert.equal(
        await withGlobalReleaseLock(globalLock, 'cutover-rollback', async () => 'next'),
        'next',
      );
      const finalIdentity = lstatSync(globalLock);
      assert.equal(finalIdentity.dev, lockedIdentity.dev);
      assert.equal(finalIdentity.ino, lockedIdentity.ino);
      assert.deepEqual(JSON.parse(readFileSync(globalLock, 'utf8')), {
        schemaVersion: 2,
        purpose: 'global-release',
        pid: process.pid,
        createdAt: JSON.parse(readFileSync(globalLock, 'utf8')).createdAt,
        operation: 'cutover-rollback',
      });
    }
  }));

test(
  'lifecycle holds the stable descriptor lock across contention and crash release',
  { skip: process.platform !== 'darwin' },
  () =>
    withTemporaryDirectory('journal-lifecycle-lock-', async (temporary) => {
      const lifecycle = readFileSync(resolve(import.meta.dirname, 'release-lifecycle.zsh'), 'utf8');
      const functions = [
        shellFunction(lifecycle, 'assert_global_lock_identity', 'acquire_global_lock'),
        shellFunction(lifecycle, 'acquire_global_lock', 'release_global_lock'),
        shellFunction(lifecycle, 'release_global_lock', 'lifecycle_exit_handler'),
      ].join('\n\n');
      const globalLock = resolve(temporary, 'release-global.lock');
      const prelude = `
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL NO_CLOBBER
zmodload zsh/system
zmodload -F zsh/stat b:zstat
umask 077
typeset -r global_lock=$1
typeset user_id
user_id=$(id -u)
typeset -r user_id
typeset global_lock_fd=-1
${functions}
`;
      const holderSource = `${prelude}
acquire_global_lock
print -r -- acquired
IFS= read -r journal_release_gate
release_global_lock
`;
      const contenderSource = `${prelude}
acquire_global_lock
release_global_lock
`;
      const holder = spawn('zsh', ['-c', holderSource, 'lifecycle-lock-holder', globalLock], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let holderStderr = '';
      holder.stderr.setEncoding('utf8');
      holder.stderr.on('data', (chunk) => {
        holderStderr += chunk;
      });
      try {
        await new Promise((resolveReady, rejectReady) => {
          holder.stdout.once('data', (chunk) => {
            if (String(chunk).includes('acquired')) resolveReady();
            else rejectReady(new Error(`Unexpected lifecycle lock holder output: ${chunk}`));
          });
          holder.once('exit', (code, signal) => {
            rejectReady(
              new Error(
                `Lifecycle lock holder exited before readiness: ${code}/${signal}: ${holderStderr}`,
              ),
            );
          });
        });
        const lockedIdentity = lstatSync(globalLock);
        assert.equal(lockedIdentity.isFile(), true);
        assert.equal(lockedIdentity.nlink, 1);
        assert.equal(lockedIdentity.mode & 0o7777, 0o600);

        const contender = spawnSync(
          'zsh',
          ['-c', contenderSource, 'lifecycle-lock-contender', globalLock],
          { encoding: 'utf8' },
        );
        assert.equal(contender.status, 75, contender.stderr);
        assert.match(contender.stderr, /Another global release operation/);

        holder.kill('SIGKILL');
        const crash = await new Promise((resolveExit) => {
          holder.once('exit', (code, signal) => resolveExit({ code, signal }));
        });
        assert.equal(crash.code, null);
        assert.equal(crash.signal, 'SIGKILL');

        const afterCrash = spawnSync(
          'zsh',
          ['-c', contenderSource, 'lifecycle-lock-after-crash', globalLock],
          { encoding: 'utf8' },
        );
        assert.equal(afterCrash.status, 0, afterCrash.stderr);
        const finalIdentity = lstatSync(globalLock);
        assert.equal(finalIdentity.dev, lockedIdentity.dev);
        assert.equal(finalIdentity.ino, lockedIdentity.ino);
        assert.equal(finalIdentity.mode & 0o7777, 0o600);
      } finally {
        if (holder.exitCode === null && holder.signalCode === null) {
          holder.kill('SIGKILL');
          await new Promise((resolveExit) => holder.once('exit', resolveExit));
        }
      }
    }),
);

test('promotion terminal marker reconciles residue and records terminal state', () =>
  withTemporaryDirectory('journal-promotion-terminal-marker-', async (temporary) => {
    const stamp = '20260731T120000Z-abcdef123456-99';
    const markerPath = resolve(temporary, `terminal-${stamp}.lock`);
    const marker = (state, operation) => ({
      schemaVersion: 2,
      releaseStamp: stamp,
      state,
      operation,
      pid: process.pid,
      recordedAt: '2026-07-31T12:00:00.000Z',
    });
    const writeMarker = (state, operation) => {
      writeFileSync(markerPath, `${JSON.stringify(marker(state, operation))}\n`, { mode: 0o600 });
      chmodSync(markerPath, 0o600);
    };

    writeMarker('cutover-complete', 'cutover-apply');
    await assert.rejects(
      withPromotionTerminalMarker(markerPath, stamp, async () => {
        assert.equal(JSON.parse(readFileSync(markerPath, 'utf8')).state, 'in-progress');
        throw new Error('injected validation failure');
      }),
      /injected validation failure/,
    );
    assert.equal(JSON.parse(readFileSync(markerPath, 'utf8')).state, 'cutover-complete');

    writeMarker('in-progress', 'promotion');
    writeFileSync(`${markerPath}.next`, '{"partial":', { mode: 0o600 });
    assert.equal(
      await withPromotionTerminalMarker(markerPath, stamp, async () => 'promoted'),
      'promoted',
    );
    const committed = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.equal(committed.state, 'promotion-complete');
    assert.equal(committed.operation, 'promotion');
    assert.equal(existsSync(`${markerPath}.next`), false);

    writeMarker('cutover-complete', 'promotion');
    await assert.rejects(
      withPromotionTerminalMarker(markerPath, stamp, async () => 'impossible'),
      /state and operation are inconsistent/,
    );

    writeMarker('rollback-complete', 'cutover-rollback');
    await assert.rejects(
      withPromotionTerminalMarker(markerPath, stamp, async () => 'impossible'),
      /requires a cutover-complete terminal marker/,
    );
  }));

test('backup drill creates a fresh uniquely named backup and validates a temporary restore', () =>
  withTemporaryDirectory('journal-backup-drill-', async (temporary) => {
    const releaseRoot = resolve(import.meta.dirname, '..');
    const stagedCli = resolve(releaseRoot, 'server/dist/cli.js');
    const databasePath = resolve(temporary, 'journal.db');
    execFileSync(process.execPath, [stagedCli, 'seed', '--demo'], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        JOURNAL_CONFIG: resolve(temporary, 'config.json'),
        JOURNAL_DATA_DIR: temporary,
      },
    });
    const backupDirectory = resolve(temporary, 'backups');
    const stamp = '20260731T120000Z-abcdef123456-99';
    await assert.rejects(
      runBackupDrill({
        databasePath,
        backupDirectory,
        evidencePath: resolve(temporary, 'invalid-backup.json'),
        stamp,
        releaseRoot: resolve(temporary, 'missing-release'),
        nodePath: process.execPath,
      }),
      /Staged CLI is unavailable/,
    );
    assert.equal(
      readdirSync(temporary).some((name) => name.startsWith(`.restore-${stamp}-`)),
      false,
    );
    const unwritableEvidence = resolve(temporary, 'unwritable-evidence');
    mkdirSync(unwritableEvidence, { mode: 0o500 });
    const backupsBeforeFailure = existsSync(backupDirectory) ? readdirSync(backupDirectory) : [];
    try {
      await assert.rejects(
        runBackupDrill({
          databasePath,
          backupDirectory,
          evidencePath: resolve(unwritableEvidence, 'backup.json'),
          stamp,
          releaseRoot,
          nodePath: process.execPath,
        }),
      );
    } finally {
      chmodSync(unwritableEvidence, 0o700);
    }
    assert.deepEqual(readdirSync(backupDirectory), backupsBeforeFailure);
    const first = await runBackupDrill({
      databasePath,
      backupDirectory,
      evidencePath: resolve(temporary, 'backup-one.json'),
      stamp,
      releaseRoot,
      nodePath: process.execPath,
    });
    const second = await runBackupDrill({
      databasePath,
      backupDirectory,
      evidencePath: resolve(temporary, 'backup-two.json'),
      stamp,
      releaseRoot,
      nodePath: process.execPath,
    });
    assert.notEqual(first.backup.path, second.backup.path);
    assert.equal(first.backup.mode, 0o600);
    assert.equal(first.restore.quickCheck, 'ok');
    assert.equal(Number.isInteger(first.restore.schemaVersion), true);
    assert.ok(first.restore.tableCounts.entries > 0);
    assert.equal(first.restore.temporaryCopyRemoved, true);
    assert.equal(first.restore.stagedCli.check, 'ok');
    assert.equal(first.restore.stagedCli.exportSchemaValidated, true);
    assert.equal(existsSync(first.backup.path), true);
  }));

test('promotion binds backup evidence to the live Journal database and backup directory', () =>
  withTemporaryDirectory('journal-backup-ownership-', (temporary) => {
    const stamp = '20260731T120000Z-abcdef123456-99';
    const valid = {
      source: resolve(temporary, '.journal/journal.db'),
      backup: {
        path: resolve(temporary, `.journal/backups/journal-release-${stamp}-abcdef123456.db`),
      },
    };
    assert.doesNotThrow(() => assertBackupOwnership(valid, temporary, stamp));
    assert.throws(
      () =>
        assertBackupOwnership(
          { ...valid, source: resolve(temporary, 'fixture.db') },
          temporary,
          stamp,
        ),
      /source database/,
    );
    assert.throws(
      () =>
        assertBackupOwnership(
          { ...valid, backup: { path: resolve(temporary, 'elsewhere/backup.db') } },
          temporary,
          stamp,
        ),
      /Backup directory/,
    );
    assert.throws(
      () =>
        assertBackupOwnership(
          {
            ...valid,
            backup: {
              path: resolve(
                temporary,
                '.journal/backups/journal-release-20260731T130000Z-abcdef123456-100-abcdef123456.db',
              ),
            },
          },
          temporary,
          stamp,
        ),
      /filename/,
    );
  }));

test('device evidence distinguishes approved handoff from a concrete physical pass', () =>
  withTemporaryDirectory('journal-device-evidence-', (temporary) => {
    const manifest = resolve(temporary, 'manifest.json');
    const archive = resolve(temporary, 'archive.tgz');
    writeFileSync(manifest, '{}\n');
    writeFileSync(archive, 'archive bytes');
    const attestationPath = resolve(temporary, 'attestation.json');
    writeFileSync(
      attestationPath,
      JSON.stringify({
        releaseStamp: '20260731T120000Z-abcdef123456-99',
        baseCommit: 'abcdef1234567890',
        extractedTreeVerified: true,
        manifest: { path: manifest, sha256: sha256File(manifest) },
        archive: { path: archive, sha256: sha256File(archive) },
      }),
    );
    const evidence = createDeviceEvidence({
      attestationPath,
      outputPath: resolve(temporary, 'device.json'),
      status: 'DEVICE HANDOFF',
      assignee: 'Robert',
      checklistReference: 'SPEC-05 section 8',
      notes: 'Physical checks remain assigned to the owner.',
    });
    assert.equal(evidence.releaseStamp, '20260731T120000Z-abcdef123456-99');
    assert.match(evidence.manifestSha256, /^[a-f0-9]{64}$/);
    assert.match(evidence.archiveSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(evidence.handoff, {
      assignee: 'Robert',
      targets: ['iPhone', 'iPad'],
    });
    assert.equal(evidence.device, undefined);
    assert.doesNotThrow(() =>
      assertDeviceLedgerConsistency(
        { gateResults: { 'Physical iPhone standalone': 'DEVICE HANDOFF' } },
        evidence,
      ),
    );
    assert.throws(
      () =>
        assertDeviceLedgerConsistency(
          { gateResults: { 'Physical iPhone standalone': 'PASS' } },
          evidence,
        ),
      /status mismatch/,
    );
    assert.throws(
      () =>
        createDeviceEvidence({
          attestationPath,
          outputPath: resolve(temporary, 'invalid-pass.json'),
          status: 'PASS',
          checklistReference: 'SPEC-05 section 8',
          notes: 'Claimed pass without device provenance.',
        }),
      /deviceModel/,
    );
    const passed = createDeviceEvidence({
      attestationPath,
      outputPath: resolve(temporary, 'passed-device.json'),
      status: 'PASS',
      deviceModel: 'iPhone 15 Pro',
      iosVersion: 'iOS 19.0',
      tailnetAccount: 'owner@example.test',
      checklistReference: 'SPEC-05 section 8',
      notes: 'All seven checks passed.',
    });
    assert.equal(passed.device.model, 'iPhone 15 Pro');
    assert.equal(passed.handoff, undefined);
  }));
