#!/usr/bin/env node
/* global process, structuredClone */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_HOST = 'mickey-home.tail8a9beb.ts.net';
const REQUIRED_443_PROXY = 'http://127.0.0.1:5050';
const REQUIRED_5178_PROXY = 'http://127.0.0.1:5178';

function value(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`${name} is required.`);
  return args[index + 1];
}

function sortDeep(valueToSort) {
  if (Array.isArray(valueToSort)) return valueToSort.map(sortDeep);
  if (valueToSort !== null && typeof valueToSort === 'object') {
    return Object.fromEntries(
      Object.keys(valueToSort)
        .sort()
        .map((key) => [key, sortDeep(valueToSort[key])]),
    );
  }
  return valueToSort;
}

function canonical(document) {
  return `${JSON.stringify(sortDeep(document))}\n`;
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

function assertExactHandler(document, port, proxy) {
  const host = `${REQUIRED_HOST}:${port}`;
  const tcp = document?.TCP?.[String(port)];
  const web = document?.Web?.[host];
  if (JSON.stringify(tcp) !== JSON.stringify({ HTTPS: true })) {
    throw new Error(`Tailscale TCP :${port} is not the exact expected HTTPS handler.`);
  }
  if (JSON.stringify(web) !== JSON.stringify({ Handlers: { '/': { Proxy: proxy } } })) {
    throw new Error(`Tailscale Web ${host} is not the exact expected proxy handler.`);
  }
}

function withoutExpected5178(document) {
  const copy = structuredClone(document);
  delete copy.TCP?.['5178'];
  delete copy.Web?.[`${REQUIRED_HOST}:5178`];
  if (copy.TCP && Object.keys(copy.TCP).length === 0) delete copy.TCP;
  if (copy.Web && Object.keys(copy.Web).length === 0) delete copy.Web;
  return copy;
}

export function verifyServeBaseline(document, mode) {
  if (mode !== 'first-install' && mode !== 'upgrade') {
    throw new Error(`Invalid release mode: ${mode}`);
  }
  assertExactHandler(document, 443, REQUIRED_443_PROXY);
  if (mode === 'upgrade') {
    assertExactHandler(document, 5178, REQUIRED_5178_PROXY);
  } else if (
    document?.TCP?.['5178'] !== undefined ||
    document?.Web?.[`${REQUIRED_HOST}:5178`] !== undefined
  ) {
    throw new Error('First-install preflight found an already-owned :5178 Serve handler.');
  }
  const normalized = canonical(document);
  return {
    schemaVersion: 1,
    mode,
    operation: 'baseline',
    required443: {
      host: `${REQUIRED_HOST}:443`,
      proxy: REQUIRED_443_PROXY,
      exact: true,
    },
    handler5178: mode === 'upgrade' ? 'exact-existing' : 'absent',
    normalizedSha256: sha256(normalized),
  };
}

export function verifyServeChange(before, after, mode) {
  if (mode !== 'first-install' && mode !== 'upgrade') {
    throw new Error(`Invalid release mode: ${mode}`);
  }
  assertExactHandler(before, 443, REQUIRED_443_PROXY);
  assertExactHandler(after, 443, REQUIRED_443_PROXY);
  assertExactHandler(after, 5178, REQUIRED_5178_PROXY);

  const beforeCanonical = canonical(before);
  const afterCanonical = canonical(after);
  if (mode === 'upgrade') {
    assertExactHandler(before, 5178, REQUIRED_5178_PROXY);
    if (beforeCanonical !== afterCanonical) {
      throw new Error('Upgrade changed the normalized Tailscale Serve configuration.');
    }
  } else if (canonical(withoutExpected5178(after)) !== beforeCanonical) {
    throw new Error(
      'First install changed Tailscale Serve configuration outside exact :5178 additions.',
    );
  }

  return {
    schemaVersion: 1,
    mode,
    required443: {
      host: `${REQUIRED_HOST}:443`,
      proxy: REQUIRED_443_PROXY,
      unchanged: true,
    },
    handler5178: {
      host: `${REQUIRED_HOST}:5178`,
      proxy: REQUIRED_5178_PROXY,
      delta: mode === 'first-install' ? 'added-only' : 'unchanged',
    },
    normalized: {
      entireConfigurationCompared: true,
      zeroCollateralChange: true,
      beforeSha256: sha256(beforeCanonical),
      afterSha256: sha256(afterCanonical),
    },
  };
}

export function verifyServeRollback(baseline, after, mode) {
  if (mode !== 'first-install' && mode !== 'upgrade') {
    throw new Error(`Invalid release mode: ${mode}`);
  }
  assertExactHandler(baseline, 443, REQUIRED_443_PROXY);
  assertExactHandler(after, 443, REQUIRED_443_PROXY);
  if (mode === 'upgrade') {
    assertExactHandler(baseline, 5178, REQUIRED_5178_PROXY);
    assertExactHandler(after, 5178, REQUIRED_5178_PROXY);
  } else if (
    baseline?.TCP?.['5178'] !== undefined ||
    baseline?.Web?.[`${REQUIRED_HOST}:5178`] !== undefined ||
    after?.TCP?.['5178'] !== undefined ||
    after?.Web?.[`${REQUIRED_HOST}:5178`] !== undefined
  ) {
    throw new Error('First-install rollback did not remove only the owned :5178 handler.');
  }
  const baselineCanonical = canonical(baseline);
  const afterCanonical = canonical(after);
  if (baselineCanonical !== afterCanonical) {
    throw new Error(
      'Rollback did not restore the entire normalized Tailscale Serve configuration.',
    );
  }
  return {
    schemaVersion: 1,
    mode,
    operation: 'rollback',
    required443: {
      host: `${REQUIRED_HOST}:443`,
      proxy: REQUIRED_443_PROXY,
      unchanged: true,
    },
    normalized: {
      entireConfigurationCompared: true,
      zeroCollateralChange: true,
      baselineSha256: sha256(baselineCanonical),
      afterSha256: sha256(afterCanonical),
    },
  };
}

function runCli() {
  const args = process.argv.slice(2);
  const beforePath = resolve(value(args, '--before'));
  const afterPath = resolve(value(args, '--after'));
  const mode = value(args, '--mode');
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(readFileSync(afterPath, 'utf8'));
  const result = args.includes('--baseline')
    ? verifyServeBaseline(before, mode)
    : args.includes('--rollback')
      ? verifyServeRollback(before, after, mode)
      : verifyServeChange(before, after, mode);
  process.stdout.write(`${JSON.stringify(result)}\n`);
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
