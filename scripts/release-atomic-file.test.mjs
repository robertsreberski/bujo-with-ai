import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { recoverOwnerPrivateAtomicWrite, writeOwnerPrivateAtomic } from './release-atomic-file.mjs';

const DEAD_PID = 2_147_483_647;
const UUID_A = '00000000-0000-4000-8000-000000000001';
const UUID_B = '00000000-0000-4000-8000-000000000002';
const SCRIPT_PATH = fileURLToPath(new URL('./release-atomic-file.mjs', import.meta.url));

function makeFixture(testContext, name = 'evidence.json') {
  const root = mkdtempSync(resolve(tmpdir(), 'journal-atomic-evidence-'));
  const evidence = resolve(root, 'evidence');
  const destination = resolve(evidence, name);
  mkdirSync(evidence, { mode: 0o700 });
  testContext.after(() => rmSync(root, { force: true, recursive: true }));
  return { destination, evidence, root };
}

function candidatePath(destination, pid = DEAD_PID, uuid = UUID_A) {
  return resolve(dirname(destination), `.${basename(destination)}.next-${pid}-${uuid}`);
}

function privateWrite(path, body) {
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function deadOwnerOptions(overrides = {}) {
  return {
    isOwnerAlive: () => false,
    randomUuid: () => UUID_B,
    ...overrides,
  };
}

test('publishes a fully written owner-only single-link file and fsyncs it before its directory', (t) => {
  const fixture = makeFixture(t);
  const phases = [];
  const body = '{"proof":true}\n';
  const result = writeOwnerPrivateAtomic(fixture.destination, body, {
    phaseObserver: (phase) => phases.push(phase),
    randomUuid: () => UUID_A,
  });

  assert.equal(result, fixture.destination);
  assert.equal(readFileSync(fixture.destination, 'utf8'), body);
  const metadata = lstatSync(fixture.destination);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.uid, process.getuid());
  assert.equal(metadata.mode & 0o7777, 0o600);
  assert.equal(metadata.nlink, 1);
  assert.equal(
    readdirSync(fixture.evidence).some((entry) => entry.includes('.next-')),
    false,
  );
  assert.ok(phases.indexOf('candidate-fsynced') < phases.indexOf('published'));
  assert.ok(phases.indexOf('published') < phases.lastIndexOf('directory-fsynced'));
});

test('never overwrites an existing destination and exposes a literal EEXIST error', (t) => {
  const fixture = makeFixture(t);
  const original = 'original evidence\n';
  writeOwnerPrivateAtomic(fixture.destination, original, { randomUuid: () => UUID_A });

  assert.throws(
    () => writeOwnerPrivateAtomic(fixture.destination, 'replacement evidence\n'),
    (error) => error?.code === 'EEXIST' && /EEXIST/.test(error.message),
  );
  assert.equal(readFileSync(fixture.destination, 'utf8'), original);
  assert.equal(lstatSync(fixture.destination).nlink, 1);
});

test('removes dead orphan candidates before publishing a new artifact', (t) => {
  const fixture = makeFixture(t);
  const orphan = candidatePath(fixture.destination);
  privateWrite(orphan, 'unfinished evidence\n');

  writeOwnerPrivateAtomic(fixture.destination, 'complete evidence\n', deadOwnerOptions());

  assert.equal(existsSync(orphan), false);
  assert.equal(readFileSync(fixture.destination, 'utf8'), 'complete evidence\n');
  assert.equal(lstatSync(fixture.destination).nlink, 1);
});

test('finalizes an interrupted two-link publication without replacing committed bytes', (t) => {
  const fixture = makeFixture(t);
  const candidate = candidatePath(fixture.destination);
  const committed = 'already committed evidence\n';
  privateWrite(candidate, committed);
  linkSync(candidate, fixture.destination);

  const recovery = recoverOwnerPrivateAtomicWrite(fixture.destination, deadOwnerOptions());
  assert.equal(recovery.state, 'committed');
  assert.equal(recovery.recoveredCandidates, 1);
  assert.equal(existsSync(candidate), false);
  assert.equal(readFileSync(fixture.destination, 'utf8'), committed);
  assert.equal(lstatSync(fixture.destination).nlink, 1);

  assert.throws(
    () => writeOwnerPrivateAtomic(fixture.destination, 'must not replace\n', deadOwnerOptions()),
    (error) => error?.code === 'EEXIST' && /EEXIST/.test(error.message),
  );
  assert.equal(readFileSync(fixture.destination, 'utf8'), committed);
});

test('finalizes a committed winner alongside a dead unpublished losing candidate', (t) => {
  const fixture = makeFixture(t);
  const winner = candidatePath(fixture.destination, DEAD_PID, UUID_A);
  const loser = candidatePath(fixture.destination, DEAD_PID - 1, UUID_B);
  const committed = 'winner evidence survives recovery\n';
  privateWrite(winner, committed);
  linkSync(winner, fixture.destination);
  privateWrite(loser, 'losing unpublished evidence\n');
  const removed = [];

  const recovery = recoverOwnerPrivateAtomicWrite(
    fixture.destination,
    deadOwnerOptions({
      phaseObserver: (phase, details) => {
        if (phase === 'recovery-candidate-unlinked') removed.push(details.path);
      },
    }),
  );

  assert.equal(recovery.state, 'committed');
  assert.equal(recovery.recoveredCandidates, 2);
  assert.deepEqual(removed, [loser, winner]);
  assert.equal(existsSync(loser), false);
  assert.equal(existsSync(winner), false);
  assert.equal(readFileSync(fixture.destination, 'utf8'), committed);
  assert.equal(lstatSync(fixture.destination).nlink, 1);
  assert.throws(
    () => writeOwnerPrivateAtomic(fixture.destination, 'replacement\n', deadOwnerOptions()),
    (error) => error?.code === 'EEXIST' && /EEXIST/.test(error.message),
  );
  assert.equal(readFileSync(fixture.destination, 'utf8'), committed);
});

test('a live candidate makes recovery fail closed before any dead candidate is removed', (t) => {
  const fixture = makeFixture(t);
  const dead = candidatePath(fixture.destination, DEAD_PID, UUID_A);
  const live = candidatePath(fixture.destination, process.pid, UUID_B);
  privateWrite(dead, 'dead writer\n');
  privateWrite(live, 'live writer\n');

  assert.throws(
    () => recoverOwnerPrivateAtomicWrite(fixture.destination),
    /live process owns atomic evidence work/,
  );
  assert.equal(readFileSync(dead, 'utf8'), 'dead writer\n');
  assert.equal(readFileSync(live, 'utf8'), 'live writer\n');
  assert.equal(existsSync(fixture.destination), false);
});

test('a live loser blocks mixed-state recovery before the committed winner is changed', (t) => {
  const fixture = makeFixture(t);
  const winner = candidatePath(fixture.destination, DEAD_PID, UUID_A);
  const liveLoser = candidatePath(fixture.destination, process.pid, UUID_B);
  const committed = 'committed winner\n';
  privateWrite(winner, committed);
  linkSync(winner, fixture.destination);
  privateWrite(liveLoser, 'live losing writer\n');

  assert.throws(
    () => recoverOwnerPrivateAtomicWrite(fixture.destination),
    /live process owns atomic evidence work/,
  );
  assert.equal(readFileSync(fixture.destination, 'utf8'), committed);
  assert.equal(lstatSync(fixture.destination).nlink, 2);
  assert.equal(existsSync(winner), true);
  assert.equal(existsSync(liveLoser), true);
});

test('candidate recovery preserves a pathname replacement detected at the unlink boundary', (t) => {
  const fixture = makeFixture(t);
  const candidate = candidatePath(fixture.destination);
  const original = resolve(fixture.evidence, 'preserved-original');
  privateWrite(candidate, 'original candidate\n');

  assert.throws(
    () =>
      recoverOwnerPrivateAtomicWrite(
        fixture.destination,
        deadOwnerOptions({
          phaseObserver: (phase, details) => {
            if (phase !== 'before-recovery-candidate-unlink') return;
            renameSync(details.path, original);
            privateWrite(details.path, 'replacement candidate\n');
          },
        }),
      ),
    /changed during recovery cleanup/,
  );
  assert.equal(readFileSync(candidate, 'utf8'), 'replacement candidate\n');
  assert.equal(readFileSync(original, 'utf8'), 'original candidate\n');
  assert.equal(existsSync(fixture.destination), false);
});

test('rejects malformed, symlinked, non-private, and hardlinked candidate state', async (t) => {
  await t.test('malformed candidate name', (child) => {
    const fixture = makeFixture(child);
    privateWrite(resolve(fixture.evidence, '.evidence.json.next-not-a-valid-owner'), 'x\n');
    assert.throws(
      () => writeOwnerPrivateAtomic(fixture.destination, 'body\n'),
      /Malformed atomic evidence candidate/,
    );
  });

  await t.test('candidate symlink', (child) => {
    const fixture = makeFixture(child);
    const outside = resolve(fixture.root, 'outside');
    privateWrite(outside, 'outside\n');
    symlinkSync(outside, candidatePath(fixture.destination));
    assert.throws(
      () => writeOwnerPrivateAtomic(fixture.destination, 'body\n', deadOwnerOptions()),
      /owner-only regular file/,
    );
    assert.equal(readFileSync(outside, 'utf8'), 'outside\n');
  });

  await t.test('candidate permissions', (child) => {
    const fixture = makeFixture(child);
    const candidate = candidatePath(fixture.destination);
    privateWrite(candidate, 'candidate\n');
    chmodSync(candidate, 0o644);
    assert.throws(
      () => writeOwnerPrivateAtomic(fixture.destination, 'body\n', deadOwnerOptions()),
      /owner-only regular file/,
    );
  });

  await t.test('orphan candidate hardlink', (child) => {
    const fixture = makeFixture(child);
    const candidate = candidatePath(fixture.destination);
    const other = resolve(fixture.root, 'candidate-hardlink');
    privateWrite(candidate, 'candidate\n');
    linkSync(candidate, other);
    assert.throws(
      () => writeOwnerPrivateAtomic(fixture.destination, 'body\n', deadOwnerOptions()),
      /unexpected hardlink/,
    );
    assert.equal(existsSync(candidate), true);
    assert.equal(existsSync(other), true);
  });
});

test('rejects unsafe evidence directories and existing destination objects', async (t) => {
  await t.test('non-private directory', (child) => {
    const fixture = makeFixture(child);
    chmodSync(fixture.evidence, 0o755);
    assert.throws(
      () => writeOwnerPrivateAtomic(fixture.destination, 'body\n'),
      /owner-private directory/,
    );
  });

  await t.test('directory symlink', (child) => {
    const root = mkdtempSync(resolve(tmpdir(), 'journal-atomic-symlink-'));
    child.after(() => rmSync(root, { force: true, recursive: true }));
    const actual = resolve(root, 'actual');
    const linked = resolve(root, 'linked');
    mkdirSync(actual, { mode: 0o700 });
    symlinkSync(actual, linked);
    assert.throws(
      () => writeOwnerPrivateAtomic(resolve(linked, 'evidence.json'), 'body\n'),
      /owner-private directory/,
    );
  });

  await t.test('destination symlink', (child) => {
    const fixture = makeFixture(child);
    const outside = resolve(fixture.root, 'outside');
    privateWrite(outside, 'outside\n');
    symlinkSync(outside, fixture.destination);
    assert.throws(
      () => writeOwnerPrivateAtomic(fixture.destination, 'body\n'),
      /owner-only regular file/,
    );
    assert.equal(readFileSync(outside, 'utf8'), 'outside\n');
  });

  await t.test('destination permissions', (child) => {
    const fixture = makeFixture(child);
    privateWrite(fixture.destination, 'existing\n');
    chmodSync(fixture.destination, 0o644);
    assert.throws(
      () => writeOwnerPrivateAtomic(fixture.destination, 'body\n'),
      /owner-only regular file/,
    );
  });

  await t.test('destination directory', (child) => {
    const fixture = makeFixture(child);
    mkdirSync(fixture.destination, { mode: 0o700 });
    assert.throws(
      () => writeOwnerPrivateAtomic(fixture.destination, 'body\n'),
      /owner-only regular file/,
    );
  });

  await t.test('unrecognized destination hardlink', (child) => {
    const fixture = makeFixture(child);
    const other = resolve(fixture.root, 'other-link');
    privateWrite(fixture.destination, 'existing\n');
    linkSync(fixture.destination, other);
    assert.throws(
      () => writeOwnerPrivateAtomic(fixture.destination, 'body\n'),
      /hardlink commit is ambiguous/,
    );
    assert.equal(readFileSync(fixture.destination, 'utf8'), 'existing\n');
    assert.equal(readFileSync(other, 'utf8'), 'existing\n');
  });
});

test('CLI rejects invalid JSON and malformed options before creating evidence', async (t) => {
  const fixture = makeFixture(t);
  const cases = [
    {
      args: ['--json', '--output', fixture.destination],
      input: '{"broken":\n',
      message: /invalid JSON/,
    },
    {
      args: ['--json', '--output', fixture.destination],
      input: '{"valid":true}',
      message: /must end with a newline/,
    },
    {
      args: ['--unknown', '--output', fixture.destination],
      input: '{}\n',
      message: /Unknown atomic evidence option/,
    },
  ];

  for (const entry of cases) {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, ...entry.args], {
      encoding: 'utf8',
      input: entry.input,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, entry.message);
    assert.equal(existsSync(fixture.destination), false);
  }
});
