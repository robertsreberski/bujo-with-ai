import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  launchAgentProgramArguments,
  recheckRuntimeBinding,
  validateLaunchAgentPlist,
  validateLaunchAgentPlistMetadata,
  validateLaunchAgentPlistSnapshot,
  withStableLaunchAgentPlist,
} from './release-verify-runtime.mjs';

const LABEL = 'com.rsreberski.journald';
const HOME = '/Users/release-test';
const RELEASE = '/Users/release-test/.journal/releases/20260731T120000Z-abcdef1-1';
const NODE = `${RELEASE}/toolchain/bin/node`;
const CLI = `${RELEASE}/server/dist/cli.js`;
const TEST_UID = process.getuid?.() ?? 501;

function contractFixture() {
  const dataDirectory = resolve(HOME, '.journal');
  const logDirectory = resolve(dataDirectory, 'logs');
  const environment = {
    NODE_ENV: 'production',
    JOURNAL_CONFIG: resolve(dataDirectory, 'config.json'),
    JOURNAL_DATA_DIR: dataDirectory,
    JOURNAL_PORT: '5178',
    JOURNAL_BIND_HOST: '127.0.0.1',
    JOURNAL_HOSTS: 'localhost:5178,127.0.0.1:5178,journal.example.test:5178',
    JOURNAL_TZ: 'Europe/Amsterdam',
    JOURNAL_DAY_BOUNDARY_OFFSET_MIN: '0',
    JOURNAL_VERSION: '1.0.0',
    JOURNAL_TAILNET_HOST: 'journal.example.test:5178',
  };
  const expected = {
    label: LABEL,
    programArguments: launchAgentProgramArguments(environment, NODE, CLI),
    environment,
    workingDirectory: RELEASE,
    stdoutPath: resolve(logDirectory, 'launchd.out.log'),
    stderrPath: resolve(logDirectory, 'launchd.err.log'),
  };
  return {
    expected,
    plist: {
      Label: expected.label,
      ProgramArguments: expected.programArguments,
      WorkingDirectory: expected.workingDirectory,
      EnvironmentVariables: expected.environment,
      RunAtLoad: true,
      KeepAlive: true,
      ProcessType: 'Interactive',
      StandardOutPath: expected.stdoutPath,
      StandardErrorPath: expected.stderrPath,
    },
  };
}

function metadata(overrides = {}) {
  return {
    uid: TEST_UID,
    mode: 0o100600,
    dev: 16_777_730,
    ino: 42,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...overrides,
  };
}

function runtimeBindingFixture(testContext) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'journal-runtime-recheck-')));
  const home = resolve(root, 'home');
  const releaseRoot = resolve(home, '.journal/releases/20260731T120000Z-abcdef1234567890-99');
  testContext.after(() => {
    chmodSync(releaseRoot, 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  const nodePath = resolve(releaseRoot, 'toolchain/bin/node');
  const cliPath = resolve(releaseRoot, 'server/dist/cli.js');
  mkdirSync(resolve(releaseRoot, 'server/dist'), { recursive: true, mode: 0o700 });
  const releaseIdentity = statSync(releaseRoot, { bigint: true });
  const manifestPath = resolve(root, 'manifest.json');
  const files = [];
  const directories = [];
  const treeSha256 = createHash('sha256')
    .update(Buffer.from(JSON.stringify({ directories, files })))
    .digest('hex');
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: 2,
      release: { version: '1.0.0' },
      toolchain: { nodePath },
      treeSha256,
      directories,
      files,
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(releaseRoot, 0o500);
  const dataDirectory = resolve(home, '.journal');
  const environment = {
    NODE_ENV: 'production',
    JOURNAL_CONFIG: resolve(dataDirectory, 'config.json'),
    JOURNAL_DATA_DIR: dataDirectory,
    JOURNAL_PORT: '5178',
    JOURNAL_BIND_HOST: '127.0.0.1',
    JOURNAL_HOSTS: 'localhost:5178,127.0.0.1:5178,mickey-home.tail8a9beb.ts.net:5178',
    JOURNAL_TZ: 'Europe/Amsterdam',
    JOURNAL_DAY_BOUNDARY_OFFSET_MIN: '0',
    JOURNAL_VERSION: '1.0.0',
    JOURNAL_TAILNET_HOST: 'mickey-home.tail8a9beb.ts.net:5178',
  };
  const environmentProof = {
    keys: Object.keys(environment).sort(),
    unexpectedKeys: [],
    credentialKeys: [],
    isolatedBy: '/usr/bin/env -i',
    providerOrSchedulerConfigurationAbsent: true,
  };
  const pid = 4242;
  const priorRuntime = {
    schemaVersion: 1,
    checkedAt: '2026-07-31T12:30:00.000Z',
    releaseRoot,
    version: '1.0.0',
    pid,
    listener: '127.0.0.1:5178',
    node: nodePath,
    cli: cliPath,
    workingDirectory: releaseRoot,
    workingDirectoryIdentity: {
      device: releaseIdentity.dev.toString(),
      inode: releaseIdentity.ino.toString(),
    },
    config: environment.JOURNAL_CONFIG,
    dataDirectory,
    environment: environmentProof,
    health: { status: 'ok', db: 'ok', version: '1.0.0' },
    asset: { path: 'app/dist/assets/index.js', bytes: 1, sha256: '0'.repeat(64) },
  };
  return {
    root,
    home,
    releaseRoot,
    manifestPath,
    nodePath,
    cliPath,
    releaseIdentity,
    environment,
    environmentProof,
    pid,
    priorRuntime,
  };
}

function runtimeBindingCommand(fixture, drift = {}) {
  const calls = [];
  const runCommand = async (commandPath, args) => {
    calls.push([commandPath, ...args]);
    if (commandPath === '/bin/launchctl') {
      const pid = drift.pid ?? fixture.pid;
      const workingDirectory = drift.launchWorkingDirectory ?? fixture.releaseRoot;
      return `pid = ${pid}\nworking directory = ${workingDirectory}\n`;
    }
    if (commandPath === '/usr/sbin/lsof' && args.includes('-sTCP:LISTEN')) {
      const pid = drift.socketPid ?? fixture.pid;
      const listener = drift.listener ?? '127.0.0.1:5178';
      return `p${pid}\nn${listener}\n`;
    }
    if (commandPath === '/usr/sbin/lsof' && args.includes('cwd')) {
      const pid = drift.cwdPid ?? fixture.pid;
      const device = drift.cwdDevice ?? fixture.releaseIdentity.dev.toString();
      const inode = drift.cwdInode ?? fixture.releaseIdentity.ino.toString();
      const workingDirectory = drift.cwdPath ?? fixture.releaseRoot;
      return `p${pid}\nfcwd\nD${device}\ni${inode}\nn${workingDirectory}\n`;
    }
    if (commandPath === '/bin/ps') {
      const environment = { ...fixture.environment, ...drift.environment };
      const assignments = Object.entries(environment)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
      return `${fixture.nodePath} ${fixture.cliPath} serve ${assignments}\n`;
    }
    throw new Error(`Unexpected runtime recheck command: ${commandPath}`);
  };
  return { calls, runCommand };
}

function recheckOptions(fixture) {
  return {
    releaseRoot: fixture.releaseRoot,
    manifestPath: fixture.manifestPath,
    priorRuntime: fixture.priorRuntime,
    nodePath: fixture.nodePath,
    home: fixture.home,
  };
}

test('accepts the exact generated LaunchAgent plist and owner-only file metadata', () => {
  const { plist, expected } = contractFixture();

  assert.equal(validateLaunchAgentPlist(plist, expected), true);
  assert.equal(validateLaunchAgentPlistMetadata(metadata(), TEST_UID), true);
  assert.equal(
    validateLaunchAgentPlistMetadata(
      metadata({ uid: BigInt(TEST_UID), mode: 0o100600n }),
      TEST_UID,
    ),
    true,
  );
});

test('rejects extra plist keys, including launchd scheduler keys', () => {
  const { plist, expected } = contractFixture();

  assert.throws(
    () => validateLaunchAgentPlist({ ...plist, StartInterval: 60 }, expected),
    /missing, extra, or scheduler keys/,
  );
});

test('rejects lifecycle policy drift', () => {
  const { plist, expected } = contractFixture();
  for (const drift of [{ RunAtLoad: false }, { KeepAlive: false }, { ProcessType: 'Background' }]) {
    assert.throws(
      () => validateLaunchAgentPlist({ ...plist, ...drift }, expected),
      /lifecycle settings/,
    );
  }
});

test('rejects stdout and stderr path drift', () => {
  const { plist, expected } = contractFixture();

  assert.throws(
    () => validateLaunchAgentPlist({ ...plist, StandardOutPath: '/tmp/journal.out' }, expected),
    /stdout path/,
  );
  assert.throws(
    () => validateLaunchAgentPlist({ ...plist, StandardErrorPath: '/tmp/journal.err' }, expected),
    /stderr path/,
  );
});

test('rejects owner and mode drift in plist metadata', () => {
  assert.throws(
    () => validateLaunchAgentPlistMetadata(metadata({ uid: TEST_UID + 1 }), TEST_UID),
    /owner-only/,
  );
  assert.throws(
    () => validateLaunchAgentPlistMetadata(metadata({ mode: 0o100644 }), TEST_UID),
    /owner-only/,
  );
});

test('rejects non-regular and symlink plist metadata', () => {
  assert.throws(
    () => validateLaunchAgentPlistMetadata(metadata({ isFile: () => false }), TEST_UID),
    /regular non-symlink/,
  );
  assert.throws(
    () => validateLaunchAgentPlistMetadata(metadata({ isSymbolicLink: () => true }), TEST_UID),
    /regular non-symlink/,
  );
});

test('rejects label, isolated command, environment, and working-directory drift', () => {
  const { plist, expected } = contractFixture();

  assert.throws(
    () => validateLaunchAgentPlist({ ...plist, Label: 'com.example.journald' }, expected),
    /label/,
  );
  assert.throws(
    () =>
      validateLaunchAgentPlist(
        { ...plist, ProgramArguments: plist.ProgramArguments.slice(2) },
        expected,
      ),
    /isolated production command/,
  );
  assert.throws(
    () =>
      validateLaunchAgentPlist(
        { ...plist, EnvironmentVariables: { ...plist.EnvironmentVariables, EXTRA: 'redacted' } },
        expected,
      ),
    /production allowlist/,
  );
  assert.throws(
    () => validateLaunchAgentPlist({ ...plist, WorkingDirectory: '/tmp/release' }, expected),
    /working directory/,
  );
});

test('does not include environment values in contract failures', () => {
  const { plist, expected } = contractFixture();
  const sensitiveValue = 'credential-value-that-must-not-be-printed';

  assert.throws(
    () =>
      validateLaunchAgentPlist(
        {
          ...plist,
          EnvironmentVariables: {
            ...plist.EnvironmentVariables,
            JOURNAL_CONFIG: sensitiveValue,
          },
        },
        expected,
      ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(sensitiveValue));
      return true;
    },
  );
});

test('rejects final plist contract, content, and identity drift', () => {
  const { plist, expected } = contractFixture();
  const contents = JSON.stringify(plist);
  const baseline = validateLaunchAgentPlistSnapshot(
    { plist, metadata: metadata(), contents },
    expected,
  );

  assert.throws(
    () =>
      validateLaunchAgentPlistSnapshot(
        { plist: { ...plist, KeepAlive: false }, metadata: metadata(), contents },
        expected,
        baseline,
      ),
    /lifecycle settings/,
  );
  assert.throws(
    () =>
      validateLaunchAgentPlistSnapshot(
        { plist, metadata: metadata(), contents: `${contents}\n` },
        expected,
        baseline,
      ),
    /identity or contents changed/,
  );
  for (const identityDrift of [{ dev: 16_777_731 }, { ino: 43 }]) {
    assert.throws(
      () =>
        validateLaunchAgentPlistSnapshot(
          { plist, metadata: metadata(identityDrift), contents },
          expected,
          baseline,
        ),
      /identity or contents changed/,
    );
  }
});

test('re-inspects the plist after readiness and blocks an otherwise successful result', async () => {
  const { plist, expected } = contractFixture();
  const contents = JSON.stringify(plist);
  const events = [];

  await assert.rejects(
    () =>
      withStableLaunchAgentPlist(
        async (baseline) => {
          events.push(baseline === undefined ? 'initial-plist' : 'final-plist');
          return validateLaunchAgentPlistSnapshot(
            {
              plist: baseline === undefined ? plist : { ...plist, RunAtLoad: false },
              metadata: metadata(),
              contents,
            },
            expected,
            baseline,
          );
        },
        async () => {
          events.push('readiness');
          return 'would-have-succeeded';
        },
      ),
    /lifecycle settings/,
  );
  assert.deepEqual(events, ['initial-plist', 'readiness', 'final-plist']);
});

test('non-HTTP runtime binding recheck preserves the prior complete binding', async (t) => {
  const fixture = runtimeBindingFixture(t);
  const command = runtimeBindingCommand(fixture);
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error('The non-HTTP binding recheck attempted an application request.');
  };
  let result;
  try {
    result = await recheckRuntimeBinding(recheckOptions(fixture), {
      platform: 'darwin',
      uid: TEST_UID,
      runCommand: command.runCommand,
      now: () => new Date('2026-07-31T12:45:00.000Z'),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 0);
  assert.deepEqual([...new Set(command.calls.map(([commandPath]) => commandPath))].sort(), [
    '/bin/launchctl',
    '/bin/ps',
    '/usr/sbin/lsof',
  ]);
  assert.equal(command.calls.filter(([commandPath]) => commandPath === '/bin/launchctl').length, 2);
  assert.equal(command.calls.filter(([commandPath]) => commandPath === '/bin/ps').length, 1);
  assert.equal(command.calls.filter(([commandPath]) => commandPath === '/usr/sbin/lsof').length, 2);
  assert.deepEqual(result, {
    schemaVersion: 1,
    checkedAt: '2026-07-31T12:45:00.000Z',
    protocol: 'launchctl-ps-lsof-only-v1',
    priorRuntimeCheckedAt: fixture.priorRuntime.checkedAt,
    releaseRoot: fixture.releaseRoot,
    version: '1.0.0',
    pid: fixture.pid,
    listener: '127.0.0.1:5178',
    node: fixture.nodePath,
    cli: fixture.cliPath,
    workingDirectory: fixture.releaseRoot,
    workingDirectoryIdentity: fixture.priorRuntime.workingDirectoryIdentity,
    config: fixture.environment.JOURNAL_CONFIG,
    dataDirectory: fixture.environment.JOURNAL_DATA_DIR,
    environment: fixture.environmentProof,
    commandPaths: ['/bin/launchctl', '/bin/ps', '/usr/sbin/lsof'],
    applicationHttpRequests: 0,
    applicationLogWrites: 0,
  });
});

test('non-HTTP runtime binding recheck rejects PID, cwd, environment, and socket drift', async (t) => {
  const fixture = runtimeBindingFixture(t);
  const cases = [
    {
      name: 'PID',
      drift: { pid: fixture.pid + 1 },
      message: /PID or working directory changed/,
    },
    {
      name: 'cwd identity',
      drift: { cwdInode: (fixture.releaseIdentity.ino + 1n).toString() },
      message: /cwd|attested release directory/,
    },
    {
      name: 'environment',
      drift: { environment: { JOURNAL_VERSION: '9.9.9' } },
      message: /effective environment|altered keys/,
    },
    {
      name: 'socket',
      drift: { listener: '127.0.0.1:6178' },
      message: /listener changed/,
    },
  ];

  for (const { name, drift, message } of cases) {
    await t.test(name, async () => {
      const command = runtimeBindingCommand(fixture, drift);
      await assert.rejects(
        () =>
          recheckRuntimeBinding(recheckOptions(fixture), {
            platform: 'darwin',
            uid: TEST_UID,
            runCommand: command.runCommand,
          }),
        message,
      );
    });
  }
});
