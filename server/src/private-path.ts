import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, parse, relative, resolve } from 'node:path';

export type PrivateDirectoryKind = 'data' | 'backup' | 'log';

/** Refuse directory targets whose permission change would affect a broad user/system surface. */
export function assertNarrowPrivateDirectory(path: string): void {
  const target = resolve(path);
  const userHome = resolve(homedir());
  const forbidden = new Set([
    parse(target).root,
    userHome,
    dirname(userHome),
    resolve(process.cwd()),
  ]);
  if (forbidden.has(target)) {
    throw new Error(`Refusing to change permissions on broad directory: ${target}`);
  }
}

/**
 * Creates or verifies an owner-private application directory. An existing
 * broadly-readable directory is never tightened implicitly, so a configuration
 * typo cannot chmod a shared directory. The final component must be a real
 * directory, never a symlink.
 */
export function ensurePrivateDirectory(path: string, kind: PrivateDirectoryKind): string {
  const target = resolve(path);
  assertNarrowPrivateDirectory(target);
  assertCanonicalTargetIsNarrow(target);

  const existing = lstatIfPresent(target);
  if (existing?.isSymbolicLink() === true) {
    throw new Error(`Private ${kind} directory cannot be a symbolic link: ${target}`);
  }
  if (existing !== null && existing !== undefined && !existing.isDirectory()) {
    throw new Error(`Private ${kind} path is not a directory: ${target}`);
  }
  const created = existing === null;
  if (created) mkdirSync(target, { recursive: true, mode: 0o700 });

  const metadata = lstatSync(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Private ${kind} path must be a real directory: ${target}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`Private ${kind} directory is not owned by the current user: ${target}`);
  }

  if ((metadata.mode & 0o077) !== 0) {
    if (!created) {
      throw new Error(`Existing ${kind} directory must already be owner-private (0700): ${target}`);
    }
    // Re-check without following the final path component immediately before
    // the mutation. chmod is safe here because a symlink swap is detected.
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error(`Private ${kind} directory cannot be a symbolic link: ${target}`);
    }
    chmodSync(target, 0o700);
  }

  const descriptor = openSync(
    target,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const verified = fstatSync(descriptor);
    if (!verified.isDirectory() || (verified.mode & 0o077) !== 0) {
      throw new Error(`Unable to restrict ${kind} directory permissions: ${target}`);
    }
  } finally {
    closeSync(descriptor);
  }
  return target;
}

function assertCanonicalTargetIsNarrow(target: string): void {
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const canonicalAncestor = realpathSync(ancestor);
  const suffix = relative(ancestor, target);
  assertNarrowPrivateDirectory(resolve(canonicalAncestor, suffix));
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
