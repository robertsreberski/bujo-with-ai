/* global process */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  assertAppendOnlyMigrationUpgrade,
  assertMigrationDefinitionFilesEqual,
  assertMigrationTreesEqual,
  atomicWritePrivateFile,
  classifyCutoverRecoveryState,
  createCutoverTransaction,
  readTerminalState,
  recordStableGlobalLock,
  removeTerminalState,
  validateCutoverTransaction,
  writeTerminalState,
} from './release-cutover-transaction.mjs';

function writeMigrationRelease(root, name, migrations, { protocol } = {}) {
  const release = resolve(root, name);
  const dist = resolve(release, 'dist');
  const source = resolve(release, 'source');
  mkdirSync(dist, { recursive: true });
  mkdirSync(source, { recursive: true });
  for (const migration of migrations) {
    for (const directory of [dist, source]) {
      writeFileSync(resolve(directory, migration.filename), migration.sql);
    }
  }
  const definition = resolve(release, 'migrations.mjs');
  const runtimeMigrations = migrations.map(({ version, name: migrationName, filename, sql }) => ({
    version,
    name: migrationName,
    ...(protocol === undefined ? {} : { filename }),
    sql,
  }));
  writeFileSync(
    definition,
    `${protocol === undefined ? '' : `export const MIGRATION_COMPATIBILITY_PROTOCOL = ${protocol};\n`}export const migrations = ${JSON.stringify(runtimeMigrations)};\n`,
  );
  for (const file of [
    definition,
    ...migrations.flatMap((migration) => [
      resolve(dist, migration.filename),
      resolve(source, migration.filename),
    ]),
  ]) {
    chmodSync(file, 0o400);
  }
  chmodSync(dist, 0o500);
  chmodSync(source, 0o500);
  return { definition, dist, source };
}

function withTemporaryDirectory(prefix, operation) {
  const temporary = mkdtempSync(resolve(tmpdir(), prefix));
  try {
    return operation(temporary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function writePrivate(path, body) {
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

test('stable BSD lockf ownership serializes contenders and survives diagnostic rewrites', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('requires macOS BSD lockf');
    return;
  }
  const temporary = mkdtempSync(resolve(tmpdir(), 'journal-cutover-lockf-'));
  try {
    const lockPath = resolve(temporary, 'release-global.lock');
    writePrivate(lockPath, '{}\n');
    const originalIdentity = lstatSync(lockPath);
    const descriptor = openSync(lockPath, 'r+');
    const diagnostic = recordStableGlobalLock({
      path: lockPath,
      fd: descriptor,
      ownerPid: process.pid,
      operation: 'cutover-apply',
      now: () => new Date('2026-07-31T12:00:00.000Z'),
    });
    closeSync(descriptor);
    assert.deepEqual(diagnostic, {
      schemaVersion: 2,
      purpose: 'global-release',
      pid: process.pid,
      createdAt: '2026-07-31T12:00:00.000Z',
      operation: 'cutover-apply',
    });
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), diagnostic);
    assert.equal(lstatSync(lockPath).mode & 0o7777, 0o600);
    assert.equal(lstatSync(lockPath).nlink, 1);
    assert.equal(lstatSync(lockPath).ino, originalIdentity.ino);
    assert.equal(lstatSync(lockPath).dev, originalIdentity.dev);

    const holder = spawn(
      '/usr/bin/lockf',
      [
        '-s',
        '-k',
        '-t',
        '0',
        lockPath,
        process.execPath,
        '-e',
        'process.stdout.write("ready\\n"); process.stdin.resume();',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    await once(holder.stdout, 'data');
    const contender = spawnSync('/usr/bin/lockf', [
      '-s',
      '-k',
      '-t',
      '0',
      lockPath,
      '/usr/bin/true',
    ]);
    assert.equal(contender.status, 75);
    holder.stdin.end();
    const [holderExit] = await once(holder, 'exit');
    assert.equal(holderExit, 0);
    const afterCrashBoundary = spawnSync('/usr/bin/lockf', [
      '-s',
      '-k',
      '-t',
      '0',
      lockPath,
      '/usr/bin/true',
    ]);
    assert.equal(afterCrashBoundary.status, 0);
    assert.equal(existsSync(lockPath), true);
    assert.equal(lstatSync(lockPath).ino, originalIdentity.ino);

    const guardedPath = resolve(temporary, 'guarded-global.lock');
    const displacedPath = resolve(temporary, 'displaced-global.lock');
    writePrivate(guardedPath, '{}\n');
    const guardedDescriptor = openSync(guardedPath, 'r+');
    renameSync(guardedPath, displacedPath);
    writePrivate(guardedPath, '{}\n');
    assert.throws(
      () =>
        recordStableGlobalLock({
          path: guardedPath,
          fd: guardedDescriptor,
          ownerPid: process.pid,
          operation: 'cutover-apply',
        }),
      /unsafe ownership or identity/,
    );
    closeSync(guardedDescriptor);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('terminal markers transition atomically and are removed only from the expected state', () =>
  withTemporaryDirectory('journal-cutover-terminal-', (temporary) => {
    const markerPath = resolve(temporary, 'terminal-stamp.lock');
    const releaseStamp = '20260731T120000Z-abcdef0-1';
    assert.equal(readTerminalState(markerPath, releaseStamp), null);
    writeTerminalState({
      path: markerPath,
      releaseStamp,
      state: 'in-progress',
      operation: 'cutover-apply',
      ownerPid: process.pid,
      now: () => new Date('2026-07-31T12:00:00.000Z'),
    });
    const inProgress = readTerminalState(markerPath, releaseStamp);
    assert.deepEqual(Object.keys(inProgress).sort(), [
      'operation',
      'pid',
      'recordedAt',
      'releaseStamp',
      'schemaVersion',
      'state',
    ]);
    assert.equal(inProgress.schemaVersion, 2);
    assert.equal(inProgress.state, 'in-progress');
    assert.equal(lstatSync(markerPath).mode & 0o7777, 0o600);
    assert.equal(existsSync(`${markerPath}.next`), false);
    writeTerminalState({
      path: markerPath,
      releaseStamp,
      state: 'cutover-complete',
      operation: 'cutover-apply',
      ownerPid: process.pid,
      now: () => new Date('2026-07-31T12:01:00.000Z'),
    });
    assert.equal(readTerminalState(markerPath, releaseStamp).state, 'cutover-complete');
    assert.throws(
      () =>
        removeTerminalState({
          path: markerPath,
          releaseStamp,
          expectedState: 'in-progress',
          expectedOperation: 'cutover-apply',
        }),
      /state changed/,
    );
    writeTerminalState({
      path: markerPath,
      releaseStamp,
      state: 'in-progress',
      operation: 'cutover-apply',
      ownerPid: process.pid,
    });
    removeTerminalState({
      path: markerPath,
      releaseStamp,
      expectedState: 'in-progress',
      expectedOperation: 'cutover-apply',
    });
    assert.equal(existsSync(markerPath), false);
  }));

test('private atomic writes expose only a complete final file and do not overwrite', () =>
  withTemporaryDirectory('journal-cutover-atomic-', (temporary) => {
    const target = resolve(temporary, 'evidence.json');
    const body = '{"complete":true}\n';
    const phases = [];
    atomicWritePrivateFile(target, body, {
      phaseObserver: (phase) => {
        phases.push(phase);
        if (phase === 'next-fsynced') {
          assert.equal(existsSync(target), false);
          assert.equal(readFileSync(`${target}.next`, 'utf8'), body);
          assert.equal(lstatSync(`${target}.next`).mode & 0o7777, 0o600);
        }
        if (phase === 'renamed') {
          assert.equal(existsSync(`${target}.next`), false);
          assert.equal(readFileSync(target, 'utf8'), body);
        }
      },
    });
    assert.deepEqual(phases, ['next-fsynced', 'renamed', 'directory-fsynced']);
    assert.equal(lstatSync(target).mode & 0o7777, 0o600);
    assert.throws(() => atomicWritePrivateFile(target, 'replacement\n'), /already exists/);
    assert.equal(readFileSync(target, 'utf8'), body);

    const rejected = resolve(temporary, 'rejected.json');
    assert.throws(
      () =>
        atomicWritePrivateFile(rejected, body, {
          beforeRename: () => {
            throw new Error('injected pre-rename failure');
          },
        }),
      /injected pre-rename failure/,
    );
    assert.equal(existsSync(rejected), false);
    assert.equal(existsSync(`${rejected}.next`), false);
  }));

test('cutover transaction atomically binds private baseline bytes and context identity', () =>
  withTemporaryDirectory('journal-cutover-transaction-', (temporary) => {
    const evidence = resolve(temporary, 'evidence');
    const home = resolve(temporary, 'home');
    const releaseRoot = resolve(temporary, 'release');
    const previousRelease = resolve(temporary, 'previous');
    mkdirSync(evidence);
    mkdirSync(resolve(home, '.journal'), { recursive: true });
    mkdirSync(resolve(home, 'Library/LaunchAgents'), { recursive: true });
    mkdirSync(releaseRoot);
    mkdirSync(previousRelease);
    const options = {
      transactionPath: resolve(evidence, 'cutover-transaction-stamp.json'),
      releaseStamp: '20260731T120000Z-abcdef0-1',
      mode: 'upgrade',
      baseCommit: 'a'.repeat(40),
      manifestSha256: 'b'.repeat(64),
      archiveSha256: 'c'.repeat(64),
      releaseRoot,
      previousRelease,
      currentLink: resolve(home, '.journal/current-release'),
      config: resolve(home, '.journal/config.json'),
      plist: resolve(home, 'Library/LaunchAgents/com.rsreberski.journald.plist'),
      serviceTarget: 'gui/501/com.rsreberski.journald',
      serveBefore: resolve(evidence, 'serve-before.json'),
      configBefore: resolve(evidence, 'config-before.json'),
      plistBefore: resolve(evidence, 'plist-before.plist'),
      configNext: resolve(evidence, 'config-next.json'),
      serveAfter: resolve(evidence, 'serve-after.json'),
      serveRecovery: resolve(evidence, 'serve-recovery.json'),
      serveRollbackAfter: resolve(evidence, 'serve-rollback-after.json'),
      cutoverEvidence: resolve(evidence, 'cutover.json'),
      rollbackEvidence: resolve(evidence, 'rollback.json'),
      now: () => new Date('2026-07-31T12:00:00.000Z'),
    };
    writePrivate(options.serveBefore, '{"TCP":{"443":{"HTTPS":true}}}\n');
    writePrivate(options.configBefore, '{"old":"config"}\n');
    writePrivate(options.plistBefore, '<plist>old</plist>\n');
    const transaction = createCutoverTransaction(options);
    assert.equal(transaction.protocol, 'cutover-baseline-restore-v1');
    assert.equal(transaction.context.previousRelease, previousRelease);
    assert.equal(transaction.baseline.config.sha256.length, 64);
    assert.equal(transaction.baseline.plist.path, options.plistBefore);
    assert.equal(existsSync(`${options.transactionPath}.next`), false);
    assert.equal(lstatSync(options.transactionPath).mode & 0o7777, 0o600);
    assert.equal(validateCutoverTransaction(options).releaseStamp, options.releaseStamp);

    writePrivate(options.configBefore, '{"silently":"replaced"}\n');
    assert.throws(() => validateCutoverTransaction(options), /Config baseline (size|hash) changed/);
  }));

test('upgrade migration guard compares complete inventories and file bytes', () =>
  withTemporaryDirectory('journal-cutover-migrations-', (temporary) => {
    const candidate = resolve(temporary, 'candidate');
    const previous = resolve(temporary, 'previous');
    const candidateDefinition = resolve(temporary, 'candidate-migrations.js');
    const previousDefinition = resolve(temporary, 'previous-migrations.js');
    mkdirSync(resolve(candidate, 'nested'), { recursive: true });
    mkdirSync(resolve(previous, 'nested'), { recursive: true });
    writeFileSync(resolve(candidate, '001-init.sql'), 'CREATE TABLE journal(id INTEGER);\n');
    writeFileSync(resolve(previous, '001-init.sql'), 'CREATE TABLE journal(id INTEGER);\n');
    writeFileSync(resolve(candidate, 'nested/002-index.sql'), 'CREATE INDEX journal_id;\n');
    writeFileSync(resolve(previous, 'nested/002-index.sql'), 'CREATE INDEX journal_id;\n');
    writeFileSync(candidateDefinition, 'export const migrations = ["001", "002"];\n');
    writeFileSync(previousDefinition, 'export const migrations = ["001", "002"];\n');
    for (const directory of [
      candidate,
      previous,
      resolve(candidate, 'nested'),
      resolve(previous, 'nested'),
    ]) {
      chmodSync(directory, 0o500);
    }
    for (const file of [
      resolve(candidate, '001-init.sql'),
      resolve(previous, '001-init.sql'),
      resolve(candidate, 'nested/002-index.sql'),
      resolve(previous, 'nested/002-index.sql'),
      candidateDefinition,
      previousDefinition,
    ]) {
      chmodSync(file, 0o400);
    }
    assert.equal(assertMigrationTreesEqual(candidate, previous).length, 3);
    assert.equal(
      assertMigrationDefinitionFilesEqual(candidateDefinition, previousDefinition).bytes,
      42,
    );
    chmodSync(candidateDefinition, 0o600);
    writeFileSync(candidateDefinition, 'export const migrations = ["002", "001"];\n');
    chmodSync(candidateDefinition, 0o400);
    assert.throws(
      () => assertMigrationDefinitionFilesEqual(candidateDefinition, previousDefinition),
      /runtime migration definitions are not identical/,
    );
    chmodSync(candidateDefinition, 0o600);
    writeFileSync(candidateDefinition, 'export const migrations = ["001", "002"];\n');
    chmodSync(candidateDefinition, 0o400);
    chmodSync(resolve(candidate, 'nested/002-index.sql'), 0o600);
    writeFileSync(resolve(candidate, 'nested/002-index.sql'), 'DROP INDEX journal_id;\n');
    chmodSync(resolve(candidate, 'nested/002-index.sql'), 0o400);
    assert.throws(
      () => assertMigrationTreesEqual(candidate, previous),
      /schema-changing upgrades are unsupported/,
    );
    chmodSync(resolve(candidate, 'nested/002-index.sql'), 0o600);
    writeFileSync(resolve(candidate, 'nested/002-index.sql'), 'CREATE INDEX journal_id;\n');
    chmodSync(resolve(candidate, 'nested/002-index.sql'), 0o400);
    chmodSync(candidate, 0o700);
    writeFileSync(resolve(candidate, '003-future.sql'), 'ALTER TABLE journal ADD COLUMN future;\n');
    chmodSync(resolve(candidate, '003-future.sql'), 0o400);
    chmodSync(candidate, 0o500);
    assert.throws(
      () => assertMigrationTreesEqual(candidate, previous),
      /schema-changing upgrades are unsupported/,
    );
    for (const directory of [
      resolve(candidate, 'nested'),
      resolve(previous, 'nested'),
      candidate,
      previous,
    ]) {
      chmodSync(directory, 0o700);
    }
  }));

test('append-only migration upgrades require a compatibility predecessor and preserve history', async (testContext) => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'journal-cutover-additive-migrations-'));
  testContext.after(() => {
    for (const release of [
      'legacy',
      'compatibility',
      'additive',
      'changed-history',
      'destructive',
    ]) {
      for (const tree of ['dist', 'source']) {
        const path = resolve(temporary, release, tree);
        if (existsSync(path)) chmodSync(path, 0o700);
      }
    }
    rmSync(temporary, { recursive: true, force: true });
  });
  const core = {
    version: 1,
    name: 'core',
    filename: '001_core.sql',
    sql: 'CREATE TABLE journal(id INTEGER PRIMARY KEY);\n',
  };
  const additive = {
    version: 2,
    name: 'entry-title',
    filename: '002_entry_title.sql',
    sql: '-- journal:migration-mode additive\nCREATE TABLE IF NOT EXISTS entry_title(entry_id INTEGER PRIMARY KEY);\n',
  };
  const legacy = writeMigrationRelease(temporary, 'legacy', [core]);
  const compatibility = writeMigrationRelease(temporary, 'compatibility', [core], {
    protocol: 1,
  });

  assert.deepEqual(
    await assertAppendOnlyMigrationUpgrade({
      candidateDefinition: compatibility.definition,
      previousDefinition: legacy.definition,
      candidateDistRoot: compatibility.dist,
      previousDistRoot: legacy.dist,
      candidateSourceRoot: compatibility.source,
      previousSourceRoot: legacy.source,
    }),
    { previousCount: 1, candidateCount: 1, added: [] },
  );
  await assert.rejects(
    assertAppendOnlyMigrationUpgrade({
      candidateDefinition: legacy.definition,
      previousDefinition: compatibility.definition,
      candidateDistRoot: legacy.dist,
      previousDistRoot: compatibility.dist,
      candidateSourceRoot: legacy.source,
      previousSourceRoot: compatibility.source,
    }),
    /protocol regressed/i,
  );

  const additiveRelease = writeMigrationRelease(temporary, 'additive', [core, additive], {
    protocol: 1,
  });
  const accepted = await assertAppendOnlyMigrationUpgrade({
    candidateDefinition: additiveRelease.definition,
    previousDefinition: compatibility.definition,
    candidateDistRoot: additiveRelease.dist,
    previousDistRoot: compatibility.dist,
    candidateSourceRoot: additiveRelease.source,
    previousSourceRoot: compatibility.source,
  });
  assert.equal(accepted.previousCount, 1);
  assert.equal(accepted.candidateCount, 2);
  assert.deepEqual(
    accepted.added.map(({ version, name, filename }) => ({ version, name, filename })),
    [{ version: 2, name: 'entry-title', filename: '002_entry_title.sql' }],
  );

  await assert.rejects(
    assertAppendOnlyMigrationUpgrade({
      candidateDefinition: additiveRelease.definition,
      previousDefinition: legacy.definition,
      candidateDistRoot: additiveRelease.dist,
      previousDistRoot: legacy.dist,
      candidateSourceRoot: additiveRelease.source,
      previousSourceRoot: legacy.source,
    }),
    /deploy a compatibility release/i,
  );

  const changedCore = { ...core, sql: 'CREATE TABLE journal(id TEXT PRIMARY KEY);\n' };
  const changedHistory = writeMigrationRelease(
    temporary,
    'changed-history',
    [changedCore, additive],
    { protocol: 1 },
  );
  await assert.rejects(
    assertAppendOnlyMigrationUpgrade({
      candidateDefinition: changedHistory.definition,
      previousDefinition: compatibility.definition,
      candidateDistRoot: changedHistory.dist,
      previousDistRoot: compatibility.dist,
      candidateSourceRoot: changedHistory.source,
      previousSourceRoot: compatibility.source,
    }),
    /changed historical migration bytes/i,
  );

  const destructive = {
    ...additive,
    sql: '-- journal:migration-mode additive\nDROP TABLE journal;\n',
  };
  const destructiveRelease = writeMigrationRelease(temporary, 'destructive', [core, destructive], {
    protocol: 1,
  });
  await assert.rejects(
    assertAppendOnlyMigrationUpgrade({
      candidateDefinition: destructiveRelease.definition,
      previousDefinition: compatibility.definition,
      candidateDistRoot: destructiveRelease.dist,
      previousDistRoot: compatibility.dist,
      candidateSourceRoot: destructiveRelease.source,
      previousSourceRoot: compatibility.source,
    }),
    /not additive-only/i,
  );
});

test('modeled crash boundaries always select a retry-safe recovery action', () => {
  const phases = [
    ['clean start', {}, 'clean'],
    [
      'Serve or file snapshot committed before transaction',
      { provisionalExists: true },
      'clean-provisional',
    ],
    [
      'transaction committed before live mutation',
      { transactionExists: true },
      'restore-transaction',
    ],
    ['config replaced', { transactionExists: true }, 'restore-transaction'],
    ['service replaced', { transactionExists: true }, 'restore-transaction'],
    ['Serve changed', { transactionExists: true }, 'restore-transaction'],
    [
      'cutover evidence committed before transaction cleanup',
      { transactionExists: true, cutoverExists: true },
      'finalize-cutover',
    ],
    ['cutover transaction cleaned', { cutoverExists: true }, 'cutover-committed'],
    [
      'rollback evidence committed before transaction cleanup',
      { transactionExists: true, cutoverExists: true, rollbackExists: true },
      'finalize-rollback',
    ],
    ['rollback committed', { cutoverExists: true, rollbackExists: true }, 'rolled-back'],
  ];
  for (const [description, state, expected] of phases) {
    assert.equal(
      classifyCutoverRecoveryState({
        transactionExists: false,
        cutoverExists: false,
        rollbackExists: false,
        provisionalExists: false,
        ...state,
      }),
      expected,
      description,
    );
  }
});
