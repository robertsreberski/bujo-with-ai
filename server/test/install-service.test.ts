import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JournalConfig } from '../src/config.js';
import {
  installLaunchAgent,
  JOURNAL_ENV_EXECUTABLE,
  JOURNAL_LAUNCH_AGENT_LABEL,
  renderLaunchAgentPlist,
  serviceCliPath,
  type LaunchctlRunner,
} from '../src/jobs/launchd.js';
import { WriterLease } from '../src/jobs/writer-lease.js';

const temporaryRoots: string[] = [];
const validPlutil: LaunchctlRunner = () => ({ status: 0 });
const immediateTransitionDelay = async (): Promise<void> => undefined;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('launchd service installation', () => {
  it('renders a valid plist with the built CLI and every effective configuration value', () => {
    const root = temporaryRoot();
    const config = configFixture(root, {
      configPath: join(root, `config<&"'.json`),
      dataDir: join(root, 'data&directory'),
      hostAllowlist: ['localhost:6123', 'journal.example.test'],
      tailnetHostname: `journal<&"'.tailnet.test`,
    });
    const releaseRoot = `/checkout<&"'`;
    const cliPath = `${releaseRoot}/server/dist/cli.js`;
    const plist = renderLaunchAgentPlist({
      config,
      nodePath: '/opt/node & friends/bin/node',
      cliPath,
    });

    expect(plist).toContain('<plist version="1.0">');
    expect(plist).toContain(`<key>Label</key><string>${JOURNAL_LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain(`<string>${xml(cliPath)}</string>`);
    expect(plist).toContain(`<key>WorkingDirectory</key><string>${xml(releaseRoot)}</string>`);
    expect(plist).toContain('<key>ProcessType</key><string>Interactive</string>');
    expect(plist).not.toContain('src/cli');
    expect(plist).toContain(`<string>${JOURNAL_ENV_EXECUTABLE}</string>`);
    expect(plist).toContain('<string>-i</string>');
    expect(plist).toContain('<string>NODE_ENV=production</string>');
    expect(plist).toContain(`<string>JOURNAL_CONFIG=${xml(config.configPath ?? '')}</string>`);
    expect(plist).toContain('<string>/opt/node &amp; friends/bin/node</string>');
    expect(environmentValue(plist, 'NODE_ENV')).toBe('production');
    expect(environmentValue(plist, 'JOURNAL_CONFIG')).toBe(xml(config.configPath ?? ''));
    expect(environmentValue(plist, 'JOURNAL_DATA_DIR')).toBe(xml(config.dataDir));
    expect(environmentValue(plist, 'JOURNAL_PORT')).toBe('6123');
    expect(environmentValue(plist, 'JOURNAL_BIND_HOST')).toBe('127.0.0.1');
    expect(environmentValue(plist, 'JOURNAL_HOSTS')).toBe('localhost:6123,journal.example.test');
    expect(environmentValue(plist, 'JOURNAL_TAILNET_HOST')).toBe(
      `journal&lt;&amp;&quot;&apos;.tailnet.test`,
    );
    expect(environmentValue(plist, 'JOURNAL_TZ')).toBe('Europe/Amsterdam');
    expect(environmentValue(plist, 'JOURNAL_DAY_BOUNDARY_OFFSET_MIN')).toBe('90');
    expect(environmentValue(plist, 'JOURNAL_VERSION')).toBe('1.2.3');
    expect(plist.match(/<dict>/g)).toHaveLength(2);
    expect(plist.match(/<\/dict>/g)).toHaveLength(2);
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true);

    if (process.platform === 'darwin') {
      const lint = spawnSync('/usr/bin/plutil', ['-lint', '-'], {
        encoding: 'utf8',
        input: plist,
      });
      expect(lint.status, lint.stderr).toBe(0);
    }
  });

  it('resolves the staged production CLI instead of the TypeScript source entrypoint', () => {
    expect(serviceCliPath('/checkout')).toBe('/checkout/server/dist/cli.js');
  });

  it('executes Node with only the explicit environment even when the parent is contaminated', () => {
    const root = temporaryRoot();
    const config = configFixture(root, {
      tailnetHostname: 'journal.example.test:6123',
    });
    const plist = renderLaunchAgentPlist({
      config,
      nodePath: process.execPath,
      cliPath: join(root, 'server', 'dist', 'cli.js'),
    });
    const arguments_ = programArguments(plist);
    const isolatedPrefix = arguments_.slice(0, -3);
    const expectedKeys = isolatedPrefix
      .slice(2)
      .map((assignment) => assignment.slice(0, assignment.indexOf('=')))
      .sort();
    const probe = spawnSync(
      isolatedPrefix[0],
      [
        ...isolatedPrefix.slice(1),
        process.execPath,
        '--eval',
        'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: '/poisoned/home',
          NODE_OPTIONS: '--require=/definitely/not/a/module.js',
          SSH_AUTH_SOCK: '/private/poisoned/socket',
          TODOIST_API_TOKEN: 'poisoned-token',
        },
      },
    );

    expect(probe.status, probe.stderr).toBe(0);
    const actualKeys = JSON.parse(probe.stdout) as string[];
    expect(actualKeys.filter((key) => key !== '__CF_USER_TEXT_ENCODING')).toEqual(expectedKeys);
    expect(actualKeys).not.toContain('HOME');
    expect(actualKeys).not.toContain('NODE_OPTIONS');
    expect(actualKeys).not.toContain('SSH_AUTH_SOCK');
    expect(actualKeys).not.toContain('TODOIST_API_TOKEN');
  });

  it('rejects non-macOS hosts before checking files, spawning processes, or writing directories', async () => {
    const root = temporaryRoot();
    const homeDir = join(root, 'home-that-must-not-exist');
    let spawnCount = 0;

    await expect(
      installLaunchAgent(configFixture(root), {
        platform: 'linux',
        homeDir,
        cliPath: join(root, 'missing-cli.js'),
        runLaunchctl: () => {
          spawnCount += 1;
          return { status: 0 };
        },
      }),
    ).rejects.toThrowError(/only on macOS/);

    expect(existsSync(homeDir)).toBe(false);
    expect(spawnCount).toBe(0);
  });

  it('atomically replaces a prior plist and reloads an existing job', async () => {
    const fixture = installationFixture();
    const calls: string[][] = [];
    let loaded = true;
    const runner: LaunchctlRunner = (_executable, arguments_) => {
      calls.push([...arguments_]);
      if (arguments_[0] === 'print') return { status: loaded ? 0 : 3 };
      if (arguments_[0] === 'bootout') loaded = false;
      if (arguments_[0] === 'bootstrap') loaded = true;
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = await installLaunchAgent(fixture.config, {
      platform: 'darwin',
      uid: 501,
      homeDir: fixture.homeDir,
      nodePath: fixture.nodePath,
      cliPath: fixture.cliPath,
      runLaunchctl: runner,
      runPlutil: validPlutil,
      transitionDelay: immediateTransitionDelay,
    });

    expect(result.plistPath).toBe(fixture.plistPath);
    expect(readFileSync(fixture.plistPath, 'utf8')).toContain(fixture.cliPath);
    expect(statSync(fixture.plistPath).mode & 0o777).toBe(0o600);
    expect(statSync(fixture.config.dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(fixture.config.logDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(fixture.launchAgents).filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(calls).toEqual([
      ['print', 'gui/501/com.rsreberski.journald'],
      ['bootout', 'gui/501/com.rsreberski.journald'],
      ['print', 'gui/501/com.rsreberski.journald'],
      ['print', 'gui/501/com.rsreberski.journald'],
      ['bootstrap', 'gui/501', fixture.plistPath],
      ['print', 'gui/501/com.rsreberski.journald'],
    ]);
  });

  it('waits for two separated absence observations before bootstrapping a replacement', async () => {
    const fixture = installationFixture();
    const events: string[] = [];
    const transitionStatuses = [0, 3, 0, 3, 3];
    let phase: 'initial' | 'draining' | 'candidate' = 'initial';
    const runner: LaunchctlRunner = (_executable, arguments_) => {
      const operation = arguments_[0] ?? '';
      events.push(operation);
      if (operation === 'print') {
        if (phase === 'initial' || phase === 'candidate') return { status: 0 };
        return { status: transitionStatuses.shift() ?? 3 };
      }
      if (operation === 'bootout') {
        phase = 'draining';
        return { status: 0 };
      }
      if (operation === 'bootstrap') {
        expect(transitionStatuses).toEqual([]);
        phase = 'candidate';
        return { status: 0 };
      }
      throw new Error(`Unexpected launchctl operation: ${operation}`);
    };

    await expect(
      installLaunchAgent(fixture.config, {
        platform: 'darwin',
        uid: 510,
        homeDir: fixture.homeDir,
        nodePath: fixture.nodePath,
        cliPath: fixture.cliPath,
        runLaunchctl: runner,
        runPlutil: validPlutil,
        transitionDelay: async () => {
          events.push('delay');
        },
      }),
    ).resolves.toBeDefined();

    expect(events).toEqual([
      'print',
      'bootout',
      'print',
      'delay',
      'print',
      'delay',
      'print',
      'delay',
      'print',
      'delay',
      'print',
      'bootstrap',
      'print',
    ]);
  });

  it('fails closed when launchd never finishes deregistering the old job', async () => {
    const fixture = installationFixture();
    let printCount = 0;
    let delayCount = 0;
    let bootstrapCount = 0;
    const runner: LaunchctlRunner = (_executable, arguments_) => {
      if (arguments_[0] === 'print') {
        printCount += 1;
        return { status: 0 };
      }
      if (arguments_[0] === 'bootout') return { status: 0 };
      bootstrapCount += 1;
      return { status: 0 };
    };

    await expect(
      installLaunchAgent(fixture.config, {
        platform: 'darwin',
        uid: 511,
        homeDir: fixture.homeDir,
        nodePath: fixture.nodePath,
        cliPath: fixture.cliPath,
        runLaunchctl: runner,
        runPlutil: validPlutil,
        transitionDelay: async () => {
          delayCount += 1;
        },
      }),
    ).rejects.toThrow(/timed out waiting.*rollback bootstrap refused/i);

    expect(printCount).toBeGreaterThan(2);
    expect(printCount).toBeLessThan(300);
    expect(delayCount).toBe(printCount - 3);
    expect(bootstrapCount).toBe(0);
    expect(readFileSync(fixture.plistPath, 'utf8')).toBe(fixture.previousPlist);
  });

  it('restores the old job when a bounded rollback retry finally confirms absence', async () => {
    const fixture = installationFixture();
    let printCount = 0;
    const bootstrapContents: string[] = [];
    const runner: LaunchctlRunner = (_executable, arguments_) => {
      if (arguments_[0] === 'print') {
        printCount += 1;
        if (printCount === 1) return { status: 0 };
        return { status: printCount <= 101 ? 0 : 3 };
      }
      if (arguments_[0] === 'bootout') return { status: 0 };
      bootstrapContents.push(readFileSync(fixture.plistPath, 'utf8'));
      return { status: 0 };
    };

    await expect(
      installLaunchAgent(fixture.config, {
        platform: 'darwin',
        uid: 513,
        homeDir: fixture.homeDir,
        nodePath: fixture.nodePath,
        cliPath: fixture.cliPath,
        runLaunchctl: runner,
        runPlutil: validPlutil,
        transitionDelay: immediateTransitionDelay,
      }),
    ).rejects.toThrow(/timed out waiting.*service state were restored/i);

    expect(printCount).toBe(103);
    expect(bootstrapContents).toEqual([fixture.previousPlist]);
    expect(readFileSync(fixture.plistPath, 'utf8')).toBe(fixture.previousPlist);
  });

  it('fails closed on an unexpected absence-probe status', async () => {
    const fixture = installationFixture();
    let initialProbe = true;
    let bootstrapCount = 0;
    const runner: LaunchctlRunner = (_executable, arguments_) => {
      if (arguments_[0] === 'print') {
        if (initialProbe) {
          initialProbe = false;
          return { status: 0 };
        }
        return { status: 64, stderr: 'unexpected lookup failure' };
      }
      if (arguments_[0] === 'bootout') return { status: 0 };
      bootstrapCount += 1;
      return { status: 0 };
    };

    await expect(
      installLaunchAgent(fixture.config, {
        platform: 'darwin',
        uid: 512,
        homeDir: fixture.homeDir,
        nodePath: fixture.nodePath,
        cliPath: fixture.cliPath,
        runLaunchctl: runner,
        runPlutil: validPlutil,
        transitionDelay: immediateTransitionDelay,
      }),
    ).rejects.toThrow(/unexpected lookup failure.*rollback bootstrap refused/i);

    expect(bootstrapCount).toBe(0);
    expect(readFileSync(fixture.plistPath, 'utf8')).toBe(fixture.previousPlist);
  });

  it('restores the previous plist and job when the replacement bootstrap fails', async () => {
    const fixture = installationFixture();
    chmodSync(fixture.plistPath, 0o640);
    const bootstrapContents: string[] = [];
    const calls: string[] = [];
    let bootstrapCount = 0;
    let loaded = true;
    const runner: LaunchctlRunner = (_executable, arguments_) => {
      calls.push(arguments_[0] ?? '');
      if (arguments_[0] === 'print') return { status: loaded ? 0 : 3 };
      if (arguments_[0] === 'bootout') {
        loaded = false;
        return { status: 0 };
      }
      bootstrapCount += 1;
      bootstrapContents.push(readFileSync(fixture.plistPath, 'utf8'));
      loaded = true;
      return bootstrapCount === 1
        ? { status: 5, stderr: 'bootstrap rejected replacement' }
        : { status: 0 };
    };

    await expect(
      installLaunchAgent(fixture.config, {
        platform: 'darwin',
        uid: 502,
        homeDir: fixture.homeDir,
        nodePath: fixture.nodePath,
        cliPath: fixture.cliPath,
        runLaunchctl: runner,
        runPlutil: validPlutil,
        transitionDelay: immediateTransitionDelay,
      }),
    ).rejects.toThrowError(/bootstrap rejected replacement.*restored/);

    expect(bootstrapContents).toHaveLength(2);
    expect(bootstrapContents[0]).toContain(fixture.cliPath);
    expect(bootstrapContents[1]).toBe(fixture.previousPlist);
    expect(readFileSync(fixture.plistPath, 'utf8')).toBe(fixture.previousPlist);
    expect(statSync(fixture.plistPath).mode & 0o777).toBe(0o640);
    expect(calls).toEqual([
      'print',
      'bootout',
      'print',
      'print',
      'bootstrap',
      'bootout',
      'print',
      'print',
      'bootstrap',
    ]);
  });

  it('restores the prior file without reloading when bootout fails', async () => {
    const fixture = installationFixture();
    const runner: LaunchctlRunner = (_executable, arguments_) => {
      if (arguments_[0] === 'print') return { status: 0 };
      if (arguments_[0] === 'bootout') return { status: 36, stderr: 'job stayed loaded' };
      throw new Error('bootstrap must not run after a failed bootout');
    };

    await expect(
      installLaunchAgent(fixture.config, {
        platform: 'darwin',
        uid: 503,
        homeDir: fixture.homeDir,
        nodePath: fixture.nodePath,
        cliPath: fixture.cliPath,
        runLaunchctl: runner,
        runPlutil: validPlutil,
      }),
    ).rejects.toThrowError(/job stayed loaded.*restored/);

    expect(readFileSync(fixture.plistPath, 'utf8')).toBe(fixture.previousPlist);
  });

  it('handles spawn errors before mutation and removes a new plist after failed first install', async () => {
    const root = temporaryRoot();
    const cliPath = join(root, 'dist', 'cli.js');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(cliPath, '#!/usr/bin/env node\n');
    const homeDir = join(root, 'home');
    const launchAgents = join(homeDir, 'Library', 'LaunchAgents');

    await expect(
      installLaunchAgent(configFixture(root), {
        platform: 'darwin',
        uid: 504,
        homeDir,
        cliPath,
        runLaunchctl: () => ({ status: null, error: new Error('spawn ENOENT') }),
        runPlutil: validPlutil,
      }),
    ).rejects.toThrowError(/Unable to spawn launchctl print/);
    expect(existsSync(launchAgents)).toBe(false);

    const calls: string[] = [];
    await expect(
      installLaunchAgent(configFixture(root), {
        platform: 'darwin',
        uid: 504,
        homeDir,
        cliPath,
        runLaunchctl: (_executable, arguments_) => {
          calls.push(arguments_[0] ?? '');
          if (arguments_[0] === 'print' || arguments_[0] === 'bootout') return { status: 3 };
          return { status: 78, stderr: 'bad plist' };
        },
        runPlutil: validPlutil,
        transitionDelay: immediateTransitionDelay,
      }),
    ).rejects.toThrowError(/bad plist.*restored/);

    expect(calls).toEqual(['print', 'bootstrap', 'bootout', 'print', 'print']);
    expect(existsSync(join(launchAgents, `${JOURNAL_LAUNCH_AGENT_LABEL}.plist`))).toBe(false);
  });

  it('lints the staged plist before replacing or stopping the prior service', async () => {
    const fixture = installationFixture();
    const calls: string[] = [];
    await expect(
      installLaunchAgent(fixture.config, {
        platform: 'darwin',
        uid: 505,
        homeDir: fixture.homeDir,
        nodePath: fixture.nodePath,
        cliPath: fixture.cliPath,
        runLaunchctl: (_executable, arguments_) => {
          calls.push(arguments_[0] ?? '');
          return { status: 0 };
        },
        runPlutil: (_executable, arguments_) => {
          expect(arguments_[0]).toBe('-lint');
          expect(readFileSync(arguments_[1]!, 'utf8')).toContain(fixture.cliPath);
          return { status: 1, stderr: 'invalid plist' };
        },
      }),
    ).rejects.toThrow(/plutil lint failed: invalid plist.*restored/i);

    expect(calls).toEqual(['print']);
    expect(readFileSync(fixture.plistPath, 'utf8')).toBe(fixture.previousPlist);
    expect(readdirSync(fixture.launchAgents).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('reports failure to remove a partially loaded replacement during rollback', async () => {
    const root = temporaryRoot();
    const cliPath = join(root, 'dist', 'cli.js');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(cliPath, '#!/usr/bin/env node\n');
    let bootoutCount = 0;
    await expect(
      installLaunchAgent(configFixture(root), {
        platform: 'darwin',
        uid: 506,
        homeDir: join(root, 'home'),
        cliPath,
        runPlutil: validPlutil,
        runLaunchctl: (_executable, arguments_) => {
          if (arguments_[0] === 'print') return { status: 3 };
          if (arguments_[0] === 'bootstrap') return { status: 5, stderr: 'partial load' };
          bootoutCount += 1;
          return { status: 36, stderr: 'partial job remained loaded' };
        },
      }),
    ).rejects.toThrow(/replacement cleanup failed: partial job remained loaded/i);
    expect(bootoutCount).toBe(1);
    expect(
      existsSync(
        join(root, 'home', 'Library', 'LaunchAgents', `${JOURNAL_LAUNCH_AGENT_LABEL}.plist`),
      ),
    ).toBe(false);
  });

  it('fails one concurrent installer before launchd operations can interleave', async () => {
    const fixture = installationFixture();
    const calls: string[][] = [];
    let loaded = true;
    const runner: LaunchctlRunner = (_executable, arguments_) => {
      calls.push([...arguments_]);
      if (arguments_[0] === 'print') return { status: loaded ? 0 : 3 };
      if (arguments_[0] === 'bootout') loaded = false;
      if (arguments_[0] === 'bootstrap') loaded = true;
      return { status: 0 };
    };
    const options = {
      platform: 'darwin' as const,
      uid: 507,
      homeDir: fixture.homeDir,
      nodePath: fixture.nodePath,
      cliPath: fixture.cliPath,
      runLaunchctl: runner,
      runPlutil: validPlutil,
      transitionDelay: immediateTransitionDelay,
    };

    const results = await Promise.allSettled([
      installLaunchAgent(fixture.config, options),
      installLaunchAgent(fixture.config, options),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.reason)).toMatch(/install service is already in progress/i);
    expect(calls).toEqual([
      ['print', 'gui/507/com.rsreberski.journald'],
      ['bootout', 'gui/507/com.rsreberski.journald'],
      ['print', 'gui/507/com.rsreberski.journald'],
      ['print', 'gui/507/com.rsreberski.journald'],
      ['bootstrap', 'gui/507', fixture.plistPath],
      ['print', 'gui/507/com.rsreberski.journald'],
    ]);
  });

  it('does not conflict with the live writer lease and releases after a failed install', async () => {
    const fixture = installationFixture();
    const writerLease = await WriterLease.acquire(fixture.config.dataDir, 'serve', {
      processStart: () => 'test-process-start',
    });
    let loaded = true;
    const options = {
      platform: 'darwin' as const,
      uid: 508,
      homeDir: fixture.homeDir,
      nodePath: fixture.nodePath,
      cliPath: fixture.cliPath,
      runLaunchctl: ((_executable, arguments_) => {
        if (arguments_[0] === 'print') return { status: loaded ? 0 : 3 };
        if (arguments_[0] === 'bootout') loaded = false;
        if (arguments_[0] === 'bootstrap') loaded = true;
        return { status: 0 };
      }) satisfies LaunchctlRunner,
      transitionDelay: immediateTransitionDelay,
    };

    try {
      await expect(
        installLaunchAgent(fixture.config, {
          ...options,
          runPlutil: () => ({ status: 1, stderr: 'deliberate lint failure' }),
        }),
      ).rejects.toThrow(/deliberate lint failure/i);

      await expect(
        installLaunchAgent(fixture.config, { ...options, runPlutil: validPlutil }),
      ).resolves.toMatchObject({ serviceTarget: 'gui/508/com.rsreberski.journald' });
    } finally {
      await writerLease.release();
    }
  });

  it('fails fast on a lock held by another process and recovers after that process dies', async () => {
    const fixture = installationFixture();
    const uid = 509;
    const calls: string[][] = [];
    let loaded = true;
    const options = {
      platform: 'darwin' as const,
      uid,
      homeDir: fixture.homeDir,
      nodePath: fixture.nodePath,
      cliPath: fixture.cliPath,
      runLaunchctl: ((_executable, arguments_) => {
        calls.push([...arguments_]);
        if (arguments_[0] === 'print') return { status: loaded ? 0 : 3 };
        if (arguments_[0] === 'bootout') loaded = false;
        if (arguments_[0] === 'bootstrap') loaded = true;
        return { status: 0 };
      }) satisfies LaunchctlRunner,
      runPlutil: validPlutil,
      transitionDelay: immediateTransitionDelay,
    };

    await installLaunchAgent(fixture.config, options);
    const callsBeforeContention = calls.length;
    const guardPath = join(
      tmpdir(),
      `${JOURNAL_LAUNCH_AGENT_LABEL}.install-${uid}`,
      'lease.sqlite',
    );
    const holder = spawn(
      process.execPath,
      [
        '--eval',
        `const Database = require('better-sqlite3');
const guard = new Database(process.argv[1]);
guard.pragma('busy_timeout = 0');
guard.pragma('journal_mode = DELETE');
guard.exec('BEGIN EXCLUSIVE');
process.stdout.write('locked\\n');
setInterval(() => undefined, 1_000);`,
        guardPath,
      ],
      { cwd: join(import.meta.dirname, '..') },
    );

    try {
      await waitForLockHolder(holder);
      await expect(installLaunchAgent(fixture.config, options)).rejects.toThrow(
        /install service is already in progress/i,
      );
      expect(calls).toHaveLength(callsBeforeContention);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        const exited = once(holder, 'exit');
        holder.kill('SIGKILL');
        await exited;
      }
    }

    await expect(installLaunchAgent(fixture.config, options)).resolves.toBeDefined();
  });
});

async function waitForLockHolder(holder: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    holder.stderr?.setEncoding('utf8');
    holder.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    holder.stdout?.once('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('locked')) resolve();
      else reject(new Error(`Unexpected install lock holder output: ${chunk.toString('utf8')}`));
    });
    holder.once('error', reject);
    holder.once('exit', (code, signal) => {
      reject(
        new Error(
          `Install lock holder exited before acquiring the lock (${String(code ?? signal)}): ${stderr}`,
        ),
      );
    });
  });
}

function configFixture(root: string, overrides: Partial<JournalConfig> = {}): JournalConfig {
  const dataDir = overrides.dataDir ?? join(root, 'journal');
  return {
    configPath: join(root, 'effective-config.json'),
    port: 6_123,
    bindHost: '127.0.0.1',
    dataDir,
    databasePath: join(dataDir, 'journal.db'),
    backupDir: join(dataDir, 'backups'),
    logDir: join(dataDir, 'logs'),
    hostAllowlist: ['localhost:6123'],
    timezone: 'Europe/Amsterdam',
    dayBoundaryOffsetMin: 90,
    deviceCookieName: 'journal_device',
    deviceCredentialTtlDays: 365,
    isDevelopment: false,
    version: '1.2.3',
    ...overrides,
  };
}

function installationFixture(): {
  root: string;
  homeDir: string;
  launchAgents: string;
  plistPath: string;
  cliPath: string;
  nodePath: string;
  previousPlist: string;
  config: JournalConfig;
} {
  const root = temporaryRoot();
  const homeDir = join(root, 'home');
  const launchAgents = join(homeDir, 'Library', 'LaunchAgents');
  const plistPath = join(launchAgents, `${JOURNAL_LAUNCH_AGENT_LABEL}.plist`);
  const cliPath = join(root, 'server', 'dist', 'cli.js');
  const nodePath = join(root, 'bin', 'node');
  const previousPlist = '<plist><dict><key>old</key><true/></dict></plist>\n';
  mkdirSync(launchAgents, { recursive: true });
  mkdirSync(join(root, 'server', 'dist'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(cliPath, '#!/usr/bin/env node\n');
  writeFileSync(nodePath, 'fake node\n');
  chmodSync(nodePath, 0o755);
  writeFileSync(plistPath, previousPlist);
  return {
    root,
    homeDir,
    launchAgents,
    plistPath,
    cliPath,
    nodePath,
    previousPlist,
    config: configFixture(root),
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'journal-launchd-test-'));
  temporaryRoots.push(root);
  return root;
}

function environmentValue(plist: string, key: string): string | undefined {
  const match = new RegExp(`<key>${key}</key><string>([^<]*)</string>`).exec(plist);
  return match?.[1];
}

function programArguments(plist: string): string[] {
  const section = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  if (section === undefined) throw new Error('Generated plist has no ProgramArguments array');
  return [...section.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => xmlDecode(match[1]));
}

function xmlDecode(value: string): string {
  return value
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
