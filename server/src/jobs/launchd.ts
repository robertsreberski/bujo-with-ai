import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { projectRoot, type JournalConfig } from '../config.js';
import { ensurePrivateDirectory } from '../private-path.js';

export const JOURNAL_LAUNCH_AGENT_LABEL = 'com.rsreberski.journald';
export const JOURNAL_ENV_EXECUTABLE = '/usr/bin/env';

const JOB_ABSENCE_PROBE_ATTEMPTS = 100;
const JOB_ABSENCE_PROBE_DELAY_MS = 50;
const JOB_ABSENCE_CONFIRMATIONS = 2;

export interface LaunchctlResult {
  readonly status: number | null;
  readonly stdout?: string | null;
  readonly stderr?: string | null;
  readonly error?: Error;
}

export type LaunchctlRunner = (
  executable: string,
  arguments_: readonly string[],
) => LaunchctlResult;

export interface InstallLaunchAgentOptions {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly homeDir?: string;
  readonly nodePath?: string;
  readonly cliPath?: string;
  readonly runLaunchctl?: LaunchctlRunner;
  readonly runPlutil?: LaunchctlRunner;
  readonly transitionDelay?: (milliseconds: number) => Promise<void>;
}

export interface LaunchAgentInstallation {
  readonly label: string;
  readonly plistPath: string;
  readonly serviceTarget: string;
}

interface PreviousPlist {
  readonly contents: Buffer;
  readonly mode: number;
}

export function serviceCliPath(root = projectRoot()): string {
  return join(root, 'server', 'dist', 'cli.js');
}

export function renderLaunchAgentPlist(input: {
  readonly config: JournalConfig;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly label?: string;
}): string {
  const { config, nodePath, cliPath } = input;
  const workingDirectory = dirname(dirname(dirname(resolve(cliPath))));
  const label = input.label ?? JOURNAL_LAUNCH_AGENT_LABEL;
  if (config.configPath === undefined) {
    throw new Error('Cannot install launchd service without the effective JOURNAL_CONFIG path');
  }
  const environment: Array<readonly [string, string]> = [
    ['NODE_ENV', 'production'],
    ['JOURNAL_CONFIG', resolve(config.configPath)],
    ['JOURNAL_DATA_DIR', config.dataDir],
    ['JOURNAL_PORT', String(config.port)],
    ['JOURNAL_BIND_HOST', config.bindHost],
    ['JOURNAL_HOSTS', config.hostAllowlist.join(',')],
    ['JOURNAL_TZ', config.timezone],
    ['JOURNAL_DAY_BOUNDARY_OFFSET_MIN', String(config.dayBoundaryOffsetMin)],
    ['JOURNAL_VERSION', config.version],
  ];
  if (config.tailnetHostname !== undefined) {
    environment.push(['JOURNAL_TAILNET_HOST', config.tailnetHostname]);
  }
  environment.sort(([left], [right]) => left.localeCompare(right));

  const environmentXml = environment
    .map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join('\n');
  const programArguments = [
    JOURNAL_ENV_EXECUTABLE,
    '-i',
    ...environment.map(([key, value]) => `${key}=${value}`),
    nodePath,
    cliPath,
    'serve',
  ];
  const programArgumentsXml = programArguments
    .map((argument) => `    <string>${xml(argument)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgumentsXml}
  </array>
  <key>WorkingDirectory</key><string>${xml(workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(join(config.logDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(config.logDir, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
}

export async function installLaunchAgent(
  config: JournalConfig,
  options: InstallLaunchAgentOptions = {},
): Promise<LaunchAgentInstallation> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    throw new Error('launchd installation is available only on macOS');
  }

  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('Unable to determine the current macOS user id');
  }

  const label = JOURNAL_LAUNCH_AGENT_LABEL;
  const launchAgents = join(options.homeDir ?? homedir(), 'Library', 'LaunchAgents');
  const plistPath = join(launchAgents, `${label}.plist`);
  const serviceTarget = `gui/${uid}/${label}`;
  const cliPath = resolve(options.cliPath ?? serviceCliPath());
  const nodePath = resolve(options.nodePath ?? process.execPath);
  const runLaunchctl = options.runLaunchctl ?? defaultLaunchctlRunner;
  const runPlutil = options.runPlutil ?? defaultLaunchctlRunner;
  const transitionDelay = options.transitionDelay ?? defaultTransitionDelay;

  const cliInfo = await stat(cliPath).catch((error: unknown) => {
    throw new Error(`Built journal CLI is unavailable at ${cliPath}; run npm run build first`, {
      cause: error,
    });
  });
  if (!cliInfo.isFile()) {
    throw new Error(`Built journal CLI is not a regular file: ${cliPath}`);
  }
  const nodeInfo = await stat(nodePath).catch((error: unknown) => {
    throw new Error(`Node executable is unavailable at ${nodePath}`, { cause: error });
  });
  if (!nodeInfo.isFile() || (nodeInfo.mode & 0o111) === 0) {
    throw new Error(`Node executable is not an executable regular file: ${nodePath}`);
  }

  const installLock = await acquireInstallLock(uid, label);
  try {
    await verifyLaunchAgentsDirectoryIfPresent(launchAgents);
    const previous = await readPreviousPlist(plistPath);
    const probe = invokeLaunchctl(runLaunchctl, ['print', serviceTarget]);
    const wasLoaded = probe.status === 0;
    if (!wasLoaded && probe.status !== 3 && probe.status !== 113) {
      const detail = probe.stderr?.trim() || probe.stdout?.trim() || `exit status ${probe.status}`;
      throw new Error(`launchctl print failed: ${detail}`);
    }
    if (wasLoaded && previous === undefined) {
      throw new Error(
        `Refusing to replace loaded service ${serviceTarget}: its prior plist is missing at ${plistPath}`,
      );
    }

    const plist = renderLaunchAgentPlist({ config, nodePath, cliPath, label });
    let plistReplaced = false;
    let previousStopped = false;
    let newBootstrapAttempted = false;
    let jobAbsenceConfirmed = false;

    try {
      await ensureLaunchAgentsDirectory(launchAgents);
      ensurePrivateDirectory(config.dataDir, 'data');
      ensurePrivateDirectory(config.logDir, 'log');
      await atomicReplace(plistPath, plist, 0o600, (temporaryPath) => {
        requireCommandSuccess(
          runPlutil,
          '/usr/bin/plutil',
          ['-lint', temporaryPath],
          'plutil lint',
        );
      });
      plistReplaced = true;

      if (wasLoaded) {
        requireSuccess(runLaunchctl, ['bootout', serviceTarget], 'launchctl bootout');
        previousStopped = true;
        await requireStableJobAbsence(runLaunchctl, serviceTarget, transitionDelay);
        jobAbsenceConfirmed = true;
      }

      newBootstrapAttempted = true;
      jobAbsenceConfirmed = false;
      requireSuccess(runLaunchctl, ['bootstrap', `gui/${uid}`, plistPath], 'launchctl bootstrap');
      requireSuccess(runLaunchctl, ['print', serviceTarget], 'launchctl adoption check');
    } catch (installationError) {
      const rollbackErrors: Error[] = [];

      if (newBootstrapAttempted) {
        try {
          // A failed bootstrap may still have loaded part of the job. launchctl's
          // documented not-found statuses are safe, but every other result fails closed.
          const cleanup = invokeLaunchctl(runLaunchctl, ['bootout', serviceTarget]);
          if (cleanup.status !== 0 && cleanup.status !== 3 && cleanup.status !== 113) {
            const detail =
              cleanup.stderr?.trim() || cleanup.stdout?.trim() || `exit status ${cleanup.status}`;
            rollbackErrors.push(new Error(`launchctl replacement cleanup failed: ${detail}`));
          } else {
            await requireStableJobAbsence(runLaunchctl, serviceTarget, transitionDelay);
            jobAbsenceConfirmed = true;
          }
        } catch (error) {
          rollbackErrors.push(asError(error));
        }
      } else if (previousStopped && installationError instanceof JobAbsenceTimeoutError) {
        try {
          await requireStableJobAbsence(runLaunchctl, serviceTarget, transitionDelay);
          jobAbsenceConfirmed = true;
        } catch (error) {
          rollbackErrors.push(asError(error));
        }
      }

      let restored = !plistReplaced;
      if (plistReplaced) {
        try {
          if (previous === undefined) await unlink(plistPath).catch(ignoreMissingFile);
          else await atomicReplace(plistPath, previous.contents, previous.mode);
          restored = true;
        } catch (error) {
          rollbackErrors.push(asError(error));
        }
      }

      if (wasLoaded && previousStopped && restored) {
        if (!jobAbsenceConfirmed) {
          rollbackErrors.push(
            new Error('launchctl rollback bootstrap refused: job absence was not confirmed'),
          );
        } else {
          try {
            requireSuccess(
              runLaunchctl,
              ['bootstrap', `gui/${uid}`, plistPath],
              'launchctl rollback bootstrap',
            );
          } catch (error) {
            rollbackErrors.push(asError(error));
          }
        }
      }

      const rollbackSuffix =
        rollbackErrors.length === 0
          ? ' Prior plist and service state were restored.'
          : ` Rollback also failed: ${rollbackErrors.map((error) => error.message).join('; ')}`;
      throw new Error(`${asError(installationError).message}${rollbackSuffix}`, {
        cause: installationError,
      });
    }

    return { label, plistPath, serviceTarget };
  } finally {
    releaseInstallLock(installLock);
  }
}

async function acquireInstallLock(uid: number, label: string): Promise<Database.Database> {
  const directory = join(tmpdir(), `${label}.install-${uid}`);
  await preparePrivateInstallLockDirectory(directory);
  const path = join(directory, 'lease.sqlite');
  await preparePrivateInstallLockFile(path);

  const guard = new Database(path);
  try {
    guard.pragma('busy_timeout = 0');
    guard.pragma('journal_mode = DELETE');
    guard.exec('BEGIN EXCLUSIVE');
    return guard;
  } catch (error) {
    guard.close();
    if (!isSqliteBusy(error)) throw error;
    throw new Error(`Install service is already in progress for gui/${uid}/${label}`, {
      cause: error,
    });
  }
}

async function preparePrivateInstallLockDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Install lock path must be a real directory: ${path}`);
  }
  assertPrivateInstallLockMetadata(path, metadata);
}

async function preparePrivateInstallLockFile(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  } finally {
    await handle?.close();
  }

  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`Install lock must be a private regular file: ${path}`);
  }
  assertPrivateInstallLockMetadata(path, metadata);
}

function assertPrivateInstallLockMetadata(
  path: string,
  metadata: { readonly uid: number; readonly mode: number },
): void {
  const processUid = process.getuid?.();
  if (processUid !== undefined && metadata.uid !== processUid) {
    throw new Error(`Install lock is not owned by the current user: ${path}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Install lock permissions are not private: ${path}`);
  }
}

function releaseInstallLock(guard: Database.Database): void {
  try {
    if (guard.inTransaction) guard.exec('ROLLBACK');
  } finally {
    guard.close();
  }
}

async function ensureLaunchAgentsDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await verifyLaunchAgentsDirectoryIfPresent(path);
}

async function verifyLaunchAgentsDirectoryIfPresent(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  });
  if (metadata === null) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`LaunchAgents path must be a real directory: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`LaunchAgents directory is not owned by the current user: ${path}`);
  }
}

async function readPreviousPlist(path: string): Promise<PreviousPlist | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error(`LaunchAgent plist is not a private regular file: ${path}`);
    }
    const contents = await readFile(path);
    return { contents, mode: metadata.mode & 0o777 };
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function atomicReplace(
  path: string,
  contents: string | Buffer,
  mode: number,
  validate?: (temporaryPath: string) => void,
): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', mode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, mode);
    validate?.(temporaryPath);
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function defaultLaunchctlRunner(
  executable: string,
  arguments_: readonly string[],
): LaunchctlResult {
  const result = spawnSync(executable, [...arguments_], { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function invokeLaunchctl(runner: LaunchctlRunner, arguments_: readonly string[]): LaunchctlResult {
  let result: LaunchctlResult;
  try {
    result = runner('/bin/launchctl', arguments_);
  } catch (error) {
    throw new Error(`Unable to spawn launchctl ${arguments_[0] ?? ''}`.trim(), { cause: error });
  }
  if (result.error !== undefined) {
    throw new Error(`Unable to spawn launchctl ${arguments_[0] ?? ''}`.trim(), {
      cause: result.error,
    });
  }
  if (result.status === null) {
    throw new Error(`launchctl ${arguments_[0] ?? ''} terminated without an exit status`.trim());
  }
  return result;
}

function requireSuccess(
  runner: LaunchctlRunner,
  arguments_: readonly string[],
  operation: string,
): void {
  const result = invokeLaunchctl(runner, arguments_);
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit status ${result.status}`;
    throw new Error(`${operation} failed: ${detail}`);
  }
}

async function requireStableJobAbsence(
  runner: LaunchctlRunner,
  serviceTarget: string,
  delay: (milliseconds: number) => Promise<void>,
): Promise<void> {
  let consecutiveAbsences = 0;
  for (let attempt = 0; attempt < JOB_ABSENCE_PROBE_ATTEMPTS; attempt += 1) {
    const probe = invokeLaunchctl(runner, ['print', serviceTarget]);
    if (probe.status === 3 || probe.status === 113) {
      consecutiveAbsences += 1;
      if (consecutiveAbsences === JOB_ABSENCE_CONFIRMATIONS) return;
    } else if (probe.status === 0) {
      consecutiveAbsences = 0;
    } else {
      const detail = probe.stderr?.trim() || probe.stdout?.trim() || `exit status ${probe.status}`;
      throw new Error(`launchctl print failed while confirming job absence: ${detail}`);
    }
    if (attempt + 1 < JOB_ABSENCE_PROBE_ATTEMPTS) {
      await delay(JOB_ABSENCE_PROBE_DELAY_MS);
    }
  }
  throw new JobAbsenceTimeoutError(
    `Timed out waiting for launchd job ${serviceTarget} to become stably absent`,
  );
}

async function defaultTransitionDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class JobAbsenceTimeoutError extends Error {}

function requireCommandSuccess(
  runner: LaunchctlRunner,
  executable: string,
  arguments_: readonly string[],
  operation: string,
): void {
  let result: LaunchctlResult;
  try {
    result = runner(executable, arguments_);
  } catch (error) {
    throw new Error(`Unable to spawn ${operation}`, { cause: error });
  }
  if (result.error !== undefined)
    throw new Error(`Unable to spawn ${operation}`, { cause: result.error });
  if (result.status === null) throw new Error(`${operation} terminated without an exit status`);
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit status ${result.status}`;
    throw new Error(`${operation} failed: ${detail}`);
  }
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isSqliteBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
  );
}

function ignoreMissingFile(error: unknown): void {
  if (!isMissingFile(error)) throw error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
