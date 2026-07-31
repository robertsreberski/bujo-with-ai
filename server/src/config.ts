import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const configFileSchema = z
  .object({
    port: z.number().int().min(1).max(65_535).optional(),
    bindHost: z.string().min(1).optional(),
    dataDir: z.string().min(1).optional(),
    hostAllowlist: z.array(z.string().min(1)).optional(),
    tailnetHostname: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    dayBoundaryOffsetMin: z.number().int().min(0).max(1_439).optional(),
  })
  .strict();

export interface JournalConfig {
  /** Absolute path of the configuration file whose effective values were loaded. */
  readonly configPath?: string;
  readonly port: number;
  readonly bindHost: string;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly backupDir: string;
  readonly logDir: string;
  readonly hostAllowlist: readonly string[];
  readonly tailnetHostname?: string;
  readonly timezone: string;
  readonly dayBoundaryOffsetMin: number;
  readonly deviceCookieName: string;
  readonly deviceCredentialTtlDays: number;
  readonly isDevelopment: boolean;
  readonly version: string;
}

export interface LoadConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly configPath?: string;
  readonly cwd?: string;
}

function parseInteger(value: string | undefined, key: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${key} must be an integer`);
  return parsed;
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

function readConfigFile(path: string): z.infer<typeof configFileSchema> {
  try {
    return configFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw new Error(`Unable to read journal config at ${path}`, { cause: error });
  }
}

function detectTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function loadConfig(options: LoadConfigOptions = {}): JournalConfig {
  const env = options.env ?? process.env;
  const configPath = resolve(
    expandHome(options.configPath ?? env.JOURNAL_CONFIG ?? '~/.journal/config.json'),
  );
  const file = readConfigFile(configPath);
  const port = parseInteger(env.JOURNAL_PORT, 'JOURNAL_PORT') ?? file.port ?? 5_178;
  if (port < 1 || port > 65_535) throw new Error('JOURNAL_PORT must be between 1 and 65535');

  const configuredDataDir = env.JOURNAL_DATA_DIR ?? file.dataDir ?? dirname(configPath);
  const dataDir = resolve(expandHome(configuredDataDir));
  const tailnetHostname = env.JOURNAL_TAILNET_HOST ?? file.tailnetHostname;
  const envHosts = env.JOURNAL_HOSTS?.split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const defaults = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (tailnetHostname !== undefined) {
    const tailnetHost = tailnetHostname.toLowerCase();
    defaults.push(tailnetHost);
    if (!tailnetHost.includes(':')) defaults.push(`${tailnetHost}:${port}`);
  }
  const hostAllowlist = [
    ...new Set((envHosts ?? file.hostAllowlist ?? defaults).map((host) => host.toLowerCase())),
  ];
  const timezone = env.JOURNAL_TZ ?? file.timezone ?? detectTimezone();
  const dayBoundaryOffsetMin =
    parseInteger(env.JOURNAL_DAY_BOUNDARY_OFFSET_MIN, 'JOURNAL_DAY_BOUNDARY_OFFSET_MIN') ??
    file.dayBoundaryOffsetMin ??
    0;
  if (dayBoundaryOffsetMin < 0 || dayBoundaryOffsetMin > 1_439) {
    throw new Error('JOURNAL_DAY_BOUNDARY_OFFSET_MIN must be between 0 and 1439');
  }

  // Validate the timezone at startup instead of discovering it on the first write.
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());

  const configuredBindHost = env.JOURNAL_BIND_HOST ?? file.bindHost ?? '127.0.0.1';
  if (configuredBindHost !== '127.0.0.1') {
    throw new Error('Journal must bind to 127.0.0.1; use Tailscale Serve for Tailnet access');
  }

  return {
    configPath,
    port,
    bindHost: configuredBindHost,
    dataDir,
    databasePath: join(dataDir, 'journal.db'),
    backupDir: join(dataDir, 'backups'),
    logDir: join(dataDir, 'logs'),
    hostAllowlist,
    ...(tailnetHostname === undefined ? {} : { tailnetHostname }),
    timezone,
    dayBoundaryOffsetMin,
    deviceCookieName: 'journal_device',
    deviceCredentialTtlDays: 365,
    isDevelopment: env.NODE_ENV !== 'production',
    version: env.JOURNAL_VERSION ?? '1.0.0',
  };
}

export function journalDate(
  config: Pick<JournalConfig, 'timezone' | 'dayBoundaryOffsetMin'>,
  instant = new Date(),
): string {
  const shifted = new Date(instant.getTime() - config.dayBoundaryOffsetMin * 60_000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(shifted);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}
