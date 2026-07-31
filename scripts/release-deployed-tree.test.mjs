import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  createDeployedTreeAttestation,
  discardIncompleteAttestation,
  inventoryDeployedTree,
  verifyDeployedTreeAttestation,
} from './release-deployed-tree.mjs';

const STAMP = '20260731T120000Z-abcdef123456-99';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function makeFixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'journal-deployed-tree-'));
  const evidence = resolve(root, 'evidence');
  const releaseRoot = resolve(root, 'releases', STAMP);
  mkdirSync(resolve(releaseRoot, 'node_modules/example'), { recursive: true, mode: 0o700 });
  mkdirSync(resolve(releaseRoot, 'server/dist'), { recursive: true, mode: 0o700 });
  mkdirSync(resolve(releaseRoot, 'app/src/api'), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(releaseRoot, 'node_modules/example/index.js'), 'export default 1;\n');
  writeFileSync(resolve(releaseRoot, 'server/dist/cli.js'), '#!/usr/bin/env node\n');
  writeFileSync(resolve(releaseRoot, 'app/src/App.tsx'), 'export default null;\n');
  writeFileSync(resolve(releaseRoot, 'app/src/api/types.ts'), 'export type Example = true;\n');
  symlinkSync('../server', resolve(releaseRoot, 'node_modules/server-workspace'));
  for (const file of [
    resolve(releaseRoot, 'node_modules/example/index.js'),
    resolve(releaseRoot, 'server/dist/cli.js'),
    resolve(releaseRoot, 'app/src/App.tsx'),
    resolve(releaseRoot, 'app/src/api/types.ts'),
  ]) {
    chmodSync(file, file.endsWith('cli.js') ? 0o500 : 0o400);
  }
  for (const directory of [
    resolve(releaseRoot, 'node_modules/example'),
    resolve(releaseRoot, 'node_modules'),
    resolve(releaseRoot, 'server/dist'),
    resolve(releaseRoot, 'server'),
    resolve(releaseRoot, 'app/src/api'),
    resolve(releaseRoot, 'app/src'),
    resolve(releaseRoot, 'app'),
    releaseRoot,
  ]) {
    chmodSync(directory, 0o500);
  }
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const contextPath = resolve(evidence, `release-context-${STAMP}.json`);
  const context = {
    releaseStamp: STAMP,
    baseCommit: 'abcdef1234567890',
    manifestSha256: SHA_A,
    archiveSha256: SHA_B,
    releaseRoot,
  };
  writeFileSync(contextPath, `${JSON.stringify(context)}\n`, { mode: 0o600 });
  chmodSync(contextPath, 0o600);
  return {
    root,
    releaseRoot,
    contextPath,
    context,
    attestationPath: resolve(evidence, `deployed-tree-${STAMP}.json`),
  };
}

function makeRemovable(path) {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (!metadata || metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) makeRemovable(resolve(path, entry));
  } else {
    chmodSync(path, 0o600);
  }
}

function destroyFixture(fixture) {
  makeRemovable(fixture.root);
  rmSync(fixture.root, { recursive: true, force: true });
}

function removeReleaseRoot(fixture) {
  makeRemovable(fixture.releaseRoot);
  rmSync(fixture.releaseRoot, { recursive: true, force: true });
}

function createAndVerify(fixture) {
  createDeployedTreeAttestation({
    contextPath: fixture.contextPath,
    root: fixture.releaseRoot,
    outputPath: fixture.attestationPath,
  });
  return verifyFixture(fixture);
}

function verifyFixture(fixture) {
  return verifyDeployedTreeAttestation({
    contextPath: fixture.contextPath,
    root: fixture.releaseRoot,
    attestationPath: fixture.attestationPath,
  });
}

test('deployed tree attestation is deterministic, context-bound, and includes dependencies', () => {
  const left = makeFixture();
  const right = makeFixture();
  try {
    const leftResult = createAndVerify(left);
    const rightResult = createAndVerify(right);
    assert.equal(leftResult.treeSha256, rightResult.treeSha256);
    assert.equal(leftResult.paths > 0, true);
    const document = JSON.parse(readFileSync(left.attestationPath, 'utf8'));
    assert.equal(
      document.tree.records.some((record) => record.path.startsWith('node_modules/')),
      true,
    );
    assert.equal(
      document.tree.records.some((record) => record.kind === 'symlink'),
      true,
    );
    const mixedCasePaths = document.tree.records
      .map((record) => record.path)
      .filter((path) => path === 'app/src/App.tsx' || path === 'app/src/api/types.ts');
    assert.deepEqual(mixedCasePaths, ['app/src/App.tsx', 'app/src/api/types.ts']);
  } finally {
    destroyFixture(left);
    destroyFixture(right);
  }
});

test('deployed tree verification rejects changed, added, missing, and mode-drifted paths', () => {
  for (const mutation of ['changed', 'added', 'missing', 'mode']) {
    const fixture = makeFixture();
    try {
      createAndVerify(fixture);
      const dependency = resolve(fixture.releaseRoot, 'node_modules/example/index.js');
      if (mutation === 'changed') {
        chmodSync(dependency, 0o600);
        writeFileSync(dependency, 'export default 2;\n');
        chmodSync(dependency, 0o400);
      } else if (mutation === 'added') {
        chmodSync(resolve(fixture.releaseRoot, 'node_modules/example'), 0o700);
        const added = resolve(fixture.releaseRoot, 'node_modules/example/extra.js');
        writeFileSync(added, 'extra\n');
        chmodSync(added, 0o400);
        chmodSync(resolve(fixture.releaseRoot, 'node_modules/example'), 0o500);
      } else if (mutation === 'missing') {
        chmodSync(resolve(fixture.releaseRoot, 'node_modules/example'), 0o700);
        rmSync(dependency);
        chmodSync(resolve(fixture.releaseRoot, 'node_modules/example'), 0o500);
      } else {
        chmodSync(dependency, 0o500);
      }
      assert.throws(() => verifyFixture(fixture), /no longer matches/);
    } finally {
      destroyFixture(fixture);
    }
  }
});

test('deployed tree inventory rejects escaping symlinks, hardlinks, and unsafe names', () => {
  for (const attack of ['symlink', 'hardlink', 'path']) {
    const fixture = makeFixture();
    try {
      chmodSync(fixture.releaseRoot, 0o700);
      if (attack === 'symlink') {
        symlinkSync('/tmp', resolve(fixture.releaseRoot, 'escape'));
      } else if (attack === 'hardlink') {
        const outside = resolve(fixture.root, 'outside');
        writeFileSync(outside, 'same inode\n', { mode: 0o400 });
        linkSync(outside, resolve(fixture.releaseRoot, 'hardlink'));
      } else {
        const unsafe = resolve(fixture.releaseRoot, 'bad\\name');
        writeFileSync(unsafe, 'unsafe\n', { mode: 0o400 });
      }
      chmodSync(fixture.releaseRoot, 0o500);
      assert.throws(
        () => inventoryDeployedTree(fixture.releaseRoot),
        /symlink|hard link|unsafe path/i,
      );
    } finally {
      destroyFixture(fixture);
    }
  }
});

test('deployed tree verifier rejects release binding and attestation hardlink drift', () => {
  const fixture = makeFixture();
  try {
    createAndVerify(fixture);
    const secondLink = resolve(fixture.root, 'attestation-link.json');
    linkSync(fixture.attestationPath, secondLink);
    assert.throws(() => verifyFixture(fixture), /single-link/);
    rmSync(secondLink);

    writeFileSync(
      fixture.contextPath,
      `${JSON.stringify({ ...fixture.context, archiveSha256: 'c'.repeat(64) })}\n`,
      { mode: 0o600 },
    );
    chmodSync(fixture.contextPath, 0o600);
    assert.throws(() => verifyFixture(fixture), /does not match/);
  } finally {
    destroyFixture(fixture);
  }
});

test('deployed tree artifact commit is exclusive and recovers a killed hardlink boundary', () => {
  const fixture = makeFixture();
  try {
    createAndVerify(fixture);
    const original = readFileSync(fixture.attestationPath);
    assert.throws(
      () =>
        createDeployedTreeAttestation({
          contextPath: fixture.contextPath,
          root: fixture.releaseRoot,
          outputPath: fixture.attestationPath,
        }),
      /already exists/,
    );
    assert.deepEqual(readFileSync(fixture.attestationPath), original);

    const deadPid = 2_147_483_647;
    const candidate = resolve(
      fixture.root,
      `evidence/.deployed-tree-${STAMP}.next-${deadPid}-00000000-0000-4000-8000-000000000000.json`,
    );
    linkSync(fixture.attestationPath, candidate);
    removeReleaseRoot(fixture);
    assert.equal(
      discardIncompleteAttestation({
        contextPath: fixture.contextPath,
        attestationPath: fixture.attestationPath,
      }),
      true,
    );
    assert.equal(existsSync(fixture.attestationPath), false);
    assert.equal(existsSync(candidate), false);
  } finally {
    destroyFixture(fixture);
  }
});
