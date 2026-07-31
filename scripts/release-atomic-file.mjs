#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { randomUUID as createRandomUuid } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 128 * 1024 * 1024;
const PERMISSION_MASK = 0o7777n;
const GROUP_OR_OTHER_MASK = 0o0077n;
const PRIVATE_FILE_MODE = 0o600n;
const CANDIDATE_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

function ownerUid() {
  if (typeof process.getuid !== 'function') {
    throw new Error('Atomic evidence writes require a POSIX owner identity.');
  }
  return BigInt(process.getuid());
}

function metadataAt(path) {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false });
}

function metadataForDescriptor(descriptor) {
  return fstatSync(descriptor, { bigint: true });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return (
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertOwnerPrivateDirectory(metadata, description) {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== ownerUid() ||
    (metadata.mode & GROUP_OR_OTHER_MASK) !== 0n
  ) {
    throw new Error(`${description} is not an owner-private directory.`);
  }
}

function assertPrivateRegular(metadata, description, allowedLinks = [1n]) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !allowedLinks.includes(metadata.nlink) ||
    metadata.uid !== ownerUid() ||
    (metadata.mode & PERMISSION_MASK) !== PRIVATE_FILE_MODE
  ) {
    throw new Error(`${description} is not an owner-only regular file.`);
  }
}

function openDirectoryGuard(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const named = metadataAt(path);
  if (!named) throw new Error('Atomic evidence directory disappeared.');
  assertOwnerPrivateDirectory(named, 'Atomic evidence directory');

  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = metadataForDescriptor(descriptor);
    assertOwnerPrivateDirectory(opened, 'Opened atomic evidence directory');
    if (!sameIdentity(named, opened)) {
      throw new Error('Atomic evidence directory changed while it was opened.');
    }
    return { descriptor, metadata: opened, path };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertStableDirectory(guard) {
  const named = metadataAt(guard.path);
  if (!named) throw new Error('Atomic evidence directory disappeared.');
  assertOwnerPrivateDirectory(named, 'Atomic evidence directory');
  const opened = metadataForDescriptor(guard.descriptor);
  assertOwnerPrivateDirectory(opened, 'Opened atomic evidence directory');
  if (!sameIdentity(named, guard.metadata) || !sameIdentity(opened, guard.metadata)) {
    throw new Error('Atomic evidence directory changed during the write.');
  }
}

function syncDirectory(guard, options) {
  assertStableDirectory(guard);
  fsyncSync(guard.descriptor);
  options.phaseObserver?.('directory-fsynced', { path: guard.path });
}

function defaultIsOwnerAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return false;
    if (error && typeof error === 'object' && error.code === 'EPERM') return true;
    throw error;
  }
}

function normalizedOptions(options = {}) {
  const isOwnerAlive = options.isOwnerAlive ?? defaultIsOwnerAlive;
  const randomUuid = options.randomUuid ?? createRandomUuid;
  if (typeof isOwnerAlive !== 'function' || typeof randomUuid !== 'function') {
    throw new TypeError('Atomic evidence dependencies must be functions.');
  }
  if (options.phaseObserver !== undefined && typeof options.phaseObserver !== 'function') {
    throw new TypeError('Atomic evidence phase observer must be a function.');
  }
  return { isOwnerAlive, phaseObserver: options.phaseObserver, randomUuid };
}

function candidatePrefix(destination) {
  return `.${basename(destination)}.next-`;
}

function candidatePattern(destination) {
  const escaped = basename(destination).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\.${escaped}\\.next-([1-9][0-9]*)-(${CANDIDATE_UUID})$`);
}

function candidateInventory(destination, guard) {
  assertStableDirectory(guard);
  const prefix = candidatePrefix(destination);
  const pattern = candidatePattern(destination);
  return readdirSync(guard.path, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(prefix))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const match = pattern.exec(entry.name);
      if (!match) {
        throw new Error(`Malformed atomic evidence candidate: ${entry.name}`);
      }
      const path = resolve(guard.path, entry.name);
      const metadata = metadataAt(path);
      if (!metadata) throw new Error(`Atomic evidence candidate disappeared: ${path}`);
      assertPrivateRegular(metadata, 'Atomic evidence candidate', [1n, 2n]);
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error('Atomic evidence candidate owner PID is invalid.');
      }
      return { metadata, path, pid };
    });
}

function assertOwnerStatuses(candidates, options) {
  const live = [];
  for (const candidate of candidates) {
    // Candidate names predate a process-incarnation marker. Treat a reused PID
    // as live instead of guessing from timestamps and risking another writer's
    // bytes; recovery remains fail-closed until that PID exits.
    const alive = options.isOwnerAlive(candidate.pid);
    if (alive !== true && alive !== false) {
      throw new Error('Atomic evidence owner liveness result is ambiguous.');
    }
    if (alive) live.push(candidate.pid);
  }
  if (live.length > 0) {
    throw new Error(
      `Another live process owns atomic evidence work (PID ${[...new Set(live)].join(', ')}).`,
    );
  }
}

function removeExpectedPath(path, expected, guard, options, phase) {
  assertStableDirectory(guard);
  const before = metadataAt(path);
  if (!before || !sameSnapshot(before, expected)) {
    throw new Error(`Atomic evidence ${phase} changed before recovery cleanup.`);
  }
  options.phaseObserver?.(`before-${phase}-unlink`, {
    path,
    device: expected.dev.toString(),
    inode: expected.ino.toString(),
  });
  assertStableDirectory(guard);
  const immediatelyBeforeUnlink = metadataAt(path);
  if (!immediatelyBeforeUnlink || !sameSnapshot(immediatelyBeforeUnlink, expected)) {
    throw new Error(`Atomic evidence ${phase} changed during recovery cleanup.`);
  }
  unlinkSync(path);
  if (metadataAt(path)) {
    throw new Error(`Atomic evidence ${phase} pathname reappeared during recovery cleanup.`);
  }
  options.phaseObserver?.(`${phase}-unlinked`, { path });
}

function destinationMetadata(destination) {
  const metadata = metadataAt(destination);
  if (metadata) {
    assertPrivateRegular(metadata, 'Atomic evidence destination', [1n, 2n]);
  }
  return metadata;
}

function recoverWithGuard(destination, guard, options) {
  const destinationBefore = destinationMetadata(destination);
  const candidates = candidateInventory(destination, guard);
  options.phaseObserver?.('recovery-inventoried', {
    candidates: candidates.map(({ path, pid }) => ({ path, pid })),
    destination,
  });

  // Discover every live owner before mutating any candidate. This prevents a
  // directory-order-dependent partial cleanup when even one writer is live.
  assertOwnerStatuses(candidates, options);

  if (destinationBefore?.nlink === 2n) {
    const matching = candidates.filter(({ metadata }) => sameIdentity(metadata, destinationBefore));
    const unmatched = candidates.filter(
      ({ metadata }) => !sameIdentity(metadata, destinationBefore),
    );
    if (matching.length !== 1) {
      throw new Error('Interrupted evidence hardlink commit is ambiguous.');
    }
    if (matching[0].metadata.nlink !== 2n) {
      throw new Error('Interrupted evidence candidate link count is invalid.');
    }
    if (unmatched.some(({ metadata }) => metadata.nlink !== 1n)) {
      throw new Error('Interrupted evidence coexists with an unmatched candidate hardlink.');
    }

    // A losing writer can leave an unpublished one-link candidate beside a
    // winner that crashed after linking the destination. All owners were
    // classified before mutation, so remove those dead orphans first. Each
    // removal leaves a retry-safe state if this recovery crashes; the final
    // directory fsync makes the completed sequence durable.
    for (const candidate of unmatched) {
      removeExpectedPath(candidate.path, candidate.metadata, guard, options, 'recovery-candidate');
    }
    const destinationBeforeFinalization = destinationMetadata(destination);
    if (
      !destinationBeforeFinalization ||
      !sameSnapshot(destinationBefore, destinationBeforeFinalization)
    ) {
      throw new Error('Committed evidence changed while orphan candidates were recovered.');
    }
    removeExpectedPath(
      matching[0].path,
      matching[0].metadata,
      guard,
      options,
      'recovery-candidate',
    );
    const destinationAfter = destinationMetadata(destination);
    if (
      !destinationAfter ||
      destinationAfter.nlink !== 1n ||
      !sameIdentity(destinationBefore, destinationAfter)
    ) {
      throw new Error('Committed evidence changed while finalizing its interrupted hardlink.');
    }
    syncDirectory(guard, options);
    return {
      path: destination,
      recoveredCandidates: candidates.length,
      state: 'committed',
    };
  }

  if (destinationBefore) {
    if (candidates.some(({ metadata }) => metadata.nlink !== 1n)) {
      throw new Error('Committed evidence coexists with an ambiguous candidate hardlink.');
    }
    for (const candidate of candidates) {
      removeExpectedPath(candidate.path, candidate.metadata, guard, options, 'recovery-candidate');
    }
    const destinationAfter = destinationMetadata(destination);
    if (!destinationAfter || !sameSnapshot(destinationBefore, destinationAfter)) {
      throw new Error('Committed evidence changed during candidate recovery.');
    }
    if (candidates.length > 0) syncDirectory(guard, options);
    return {
      path: destination,
      recoveredCandidates: candidates.length,
      state: 'committed',
    };
  }

  if (candidates.some(({ metadata }) => metadata.nlink !== 1n)) {
    throw new Error('Orphan atomic evidence candidate has an unexpected hardlink.');
  }
  for (const candidate of candidates) {
    removeExpectedPath(candidate.path, candidate.metadata, guard, options, 'recovery-candidate');
  }
  if (candidates.length > 0) syncDirectory(guard, options);

  // A concurrent protocol writer may have started after the first inventory.
  // Do not clean or adopt that state in this pass; a retry can classify it.
  const destinationAfter = destinationMetadata(destination);
  const candidatesAfter = candidateInventory(destination, guard);
  if (destinationAfter || candidatesAfter.length > 0) {
    throw new Error('Atomic evidence state changed during recovery; retry is required.');
  }
  return {
    path: destination,
    recoveredCandidates: candidates.length,
    state: 'absent',
  };
}

export function recoverOwnerPrivateAtomicWrite(outputPath, rawOptions = {}) {
  const destination = resolve(outputPath);
  const options = normalizedOptions(rawOptions);
  const guard = openDirectoryGuard(dirname(destination));
  try {
    return recoverWithGuard(destination, guard, options);
  } finally {
    closeSync(guard.descriptor);
  }
}

function evidenceAlreadyExists(destination) {
  const error = new Error(`EEXIST: atomic evidence already exists: ${destination}`);
  error.code = 'EEXIST';
  return error;
}

function evidenceBytes(body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BODY_BYTES) {
    throw new Error('Atomic evidence body has an invalid size.');
  }
  return bytes;
}

export function writeOwnerPrivateAtomic(outputPath, body, rawOptions = {}) {
  const destination = resolve(outputPath);
  const bytes = evidenceBytes(body);
  const options = normalizedOptions(rawOptions);
  const guard = openDirectoryGuard(dirname(destination));
  let descriptor;
  let candidate;
  let openedCandidate;
  try {
    const recovery = recoverWithGuard(destination, guard, options);
    if (recovery.state === 'committed') {
      syncDirectory(guard, options);
      throw evidenceAlreadyExists(destination);
    }

    const uuid = options.randomUuid();
    if (typeof uuid !== 'string' || !new RegExp(`^${CANDIDATE_UUID}$`).test(uuid)) {
      throw new Error('Atomic evidence UUID generator returned an invalid UUID.');
    }
    candidate = resolve(guard.path, `.${basename(destination)}.next-${process.pid}-${uuid}`);
    assertStableDirectory(guard);
    descriptor = openSync(
      candidate,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    openedCandidate = metadataForDescriptor(descriptor);
    assertPrivateRegular(openedCandidate, 'Opened atomic evidence candidate');
    options.phaseObserver?.('candidate-opened', { path: candidate });

    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (written <= 0) throw new Error('Atomic evidence write made no progress.');
      offset += written;
    }
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    openedCandidate = metadataForDescriptor(descriptor);
    assertPrivateRegular(openedCandidate, 'Fsynced atomic evidence candidate');
    if (openedCandidate.size !== BigInt(bytes.byteLength)) {
      throw new Error('Atomic evidence candidate size changed during its write.');
    }
    options.phaseObserver?.('candidate-fsynced', { path: candidate });

    assertStableDirectory(guard);
    const namedCandidate = metadataAt(candidate);
    if (!namedCandidate || !sameSnapshot(namedCandidate, openedCandidate)) {
      throw new Error('Atomic evidence candidate changed before publication.');
    }
    options.phaseObserver?.('before-publication', { candidate, destination });
    assertStableDirectory(guard);
    const immediatelyBeforeLink = metadataAt(candidate);
    if (!immediatelyBeforeLink || !sameSnapshot(immediatelyBeforeLink, openedCandidate)) {
      throw new Error('Atomic evidence candidate changed during publication.');
    }

    try {
      linkSync(candidate, destination);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'EEXIST') {
        throw evidenceAlreadyExists(destination);
      }
      throw error;
    }
    options.phaseObserver?.('published', { candidate, destination });

    const descriptorAfterLink = metadataForDescriptor(descriptor);
    const candidateAfterLink = metadataAt(candidate);
    const destinationAfterLink = destinationMetadata(destination);
    if (
      !candidateAfterLink ||
      !destinationAfterLink ||
      descriptorAfterLink.nlink !== 2n ||
      !sameSnapshot(candidateAfterLink, descriptorAfterLink) ||
      !sameSnapshot(destinationAfterLink, descriptorAfterLink)
    ) {
      throw new Error('Atomic evidence hardlink publication changed unexpectedly.');
    }

    removeExpectedPath(candidate, candidateAfterLink, guard, options, 'published-candidate');
    const destinationFinal = destinationMetadata(destination);
    const descriptorFinal = metadataForDescriptor(descriptor);
    if (
      !destinationFinal ||
      destinationFinal.nlink !== 1n ||
      descriptorFinal.nlink !== 1n ||
      !sameSnapshot(destinationFinal, descriptorFinal)
    ) {
      throw new Error('Atomic evidence destination changed while publication completed.');
    }
    syncDirectory(guard, options);
    closeSync(descriptor);
    descriptor = undefined;
    return destination;
  } catch (error) {
    if (candidate && descriptor !== undefined) {
      const currentCandidate = metadataAt(candidate);
      if (currentCandidate) {
        // Only remove the inode created by this invocation. If its pathname was
        // replaced, fail closed and preserve the replacement for inspection.
        // Keeping the original descriptor open pins its inode against reuse.
        if (!sameIdentity(currentCandidate, metadataForDescriptor(descriptor))) {
          throw new Error('Atomic evidence candidate pathname was replaced after failure.', {
            cause: error,
          });
        }
        removeExpectedPath(candidate, currentCandidate, guard, options, 'failed-write-candidate');
        syncDirectory(guard, options);
      }
    }
    if (descriptor !== undefined) {
      closeSync(descriptor);
      descriptor = undefined;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    closeSync(guard.descriptor);
  }
}

function parseCliArguments(args) {
  let output;
  let validateJson = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      if (validateJson) throw new Error('--json may be provided only once.');
      validateJson = true;
      continue;
    }
    if (argument === '--output') {
      if (output !== undefined) throw new Error('--output may be provided only once.');
      output = args[index + 1];
      if (!output || output.startsWith('--')) throw new Error('--output requires a value.');
      index += 1;
      continue;
    }
    throw new Error(`Unknown atomic evidence option: ${argument}`);
  }
  if (output === undefined) throw new Error('--output requires a value.');
  return { output, validateJson };
}

function runCli() {
  const { output, validateJson } = parseCliArguments(process.argv.slice(2));
  const body = readFileSync(0);
  evidenceBytes(body);
  if (validateJson) {
    const source = body.toString('utf8');
    if (!source.endsWith('\n')) {
      throw new Error('Atomic JSON evidence must end with a newline.');
    }
    try {
      JSON.parse(source);
    } catch (error) {
      throw new Error('Atomic JSON evidence is invalid JSON.', { cause: error });
    }
  }
  process.stdout.write(`${writeOwnerPrivateAtomic(output, body)}\n`);
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
