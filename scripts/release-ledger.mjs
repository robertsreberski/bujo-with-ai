#!/usr/bin/env node
/* global process */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RESULT_VALUES = new Set([
  'NOT RUN',
  'PASS',
  'FAIL',
  'DEVIATION',
  'P2 EXCLUDED',
  'DEVICE HANDOFF',
]);
const P2_EXCLUSION_GATES = new Set(['FR-39', 'FR-40']);
const DEVICE_HANDOFF_GATE = 'Physical iPhone standalone';
const EVIDENCE_REQUIRED_RESULTS = new Set(['PASS', 'DEVIATION', 'DEVICE HANDOFF']);
const REQUIRED_GATES = Object.freeze([
  'FR-1…5',
  'FR-6…10',
  'FR-11…14',
  'FR-15…17',
  'FR-18…20',
  'FR-21…23',
  'FR-24…25',
  'FR-26…32',
  'FR-33…36',
  'FR-37',
  'FR-38',
  'FR-39',
  'FR-40',
  'NFR-1',
  'NFR-2',
  'NFR-3',
  'NFR-4',
  'NFR-5',
  'NFR-6',
  'ARC-1…5',
  'ARC-6…10',
  'ARC-11…14',
  'ARC-15…16',
  'ARC-17…19',
  'ARC-20…21',
  'DM-1…8',
  'DM-9…12',
  'DM-13',
  'DM-14…15',
  'DM-16…17',
  'DM-18…19',
  'DM-20',
  'DM-21',
  'LOG-1…5',
  'LOG-6…10',
  'LOG-11…17',
  'LOG-18…21',
  'LOG-22…24',
  'LOG-25…29',
  'LOG-30…33',
  'LOG-34…37',
  'LOG-38…42',
  'DS-1…8',
  'DS-9…14',
  'DS-15…23',
  'DS-24…25',
  'PWA-1…8',
  'PWA-9…17',
  'PWA-18…22',
  'PWA-23…26',
  'MCP-1…4',
  'MCP-5…7',
  'MCP-8…11',
  'MCP-12…15',
  'MCP-16…17',
  'MCP-18…20',
  'MCP-21…24',
  'MCP-25…26',
  'API-1…4',
  'API endpoint inventory',
  'API-5…7',
  'API-8…9',
  'API-10…13',
  'API-14…16',
  'Exact Node and clean dependency install',
  'Static, unit, integration, and production build',
  'E2E TypeScript configuration',
  'Browser-tested production bundle',
  'Release tooling fixtures',
  'NFR benchmark',
  'Exact dirty-tree manifest and archive',
  'Immutable staged release',
  'Install or upgrade ownership',
  'Exact launchd adoption',
  'Health and served asset adoption',
  'Tailnet HTTPS reachability and asset',
  'Fresh backup and restore',
  'Entire Tailscale Serve configuration',
  'Existing HTTPS 443 preserved',
  'Graceful SIGTERM lifecycle',
  'SIGKILL crash lifecycle',
  DEVICE_HANDOFF_GATE,
  'Final promotion guard',
]);

function cells(line) {
  if (!line.trimStart().startsWith('|') || !line.trimEnd().endsWith('|')) return [];
  return line
    .trim()
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function isSeparator(row) {
  return row.length > 0 && row.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function hasConcreteEvidence(value) {
  if (typeof value !== 'string') return false;
  const match = /^EVIDENCE:\s+(.+)$/i.exec(value.trim());
  if (!match) return false;
  const detail = match[1].trim();
  return (
    detail.length >= 8 &&
    !/^(?:todo|tbd|none|n\/a|placeholder)$/i.test(detail) &&
    !/\b(?:not run|intended evidence|fill this|replace me)\b/i.test(detail)
  );
}

function acceptedDeviations(document) {
  const accepted = new Map();
  const lines = document.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Explicitly accepted release deviations\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) break;
    if (!inSection) continue;
    const row = cells(line);
    if (row.length === 0 || isSeparator(row) || row[0] === 'Gate') continue;
    const [gate, acceptanceId, owner, recordedAt, reason] = row;
    if (!gate || !/^DEV-[A-Z0-9-]+$/.test(acceptanceId ?? '')) {
      throw new Error(`Invalid deviation acceptance row: ${line}`);
    }
    if (!owner || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(recordedAt ?? '') || !reason) {
      throw new Error(`Incomplete deviation acceptance for ${gate}.`);
    }
    if (accepted.has(gate)) throw new Error(`Duplicate deviation acceptance: ${gate}`);
    accepted.set(gate, { acceptanceId, owner, recordedAt, reason });
  }
  return accepted;
}

export function evaluateLedger(document, options = {}) {
  const accepted = acceptedDeviations(document);
  const requiredGates = options.requiredGates ?? REQUIRED_GATES;
  const gates = [];
  for (const [lineNumber, line] of document.split(/\r?\n/).entries()) {
    const row = cells(line);
    if (row.length < 2 || isSeparator(row)) continue;
    const result = row.at(-1);
    if (!RESULT_VALUES.has(result)) continue;
    const gate = row[0];
    const evidence = row.at(-2);
    gates.push({ gate, evidence, result, line: lineNumber + 1 });
  }
  if (gates.length === 0) throw new Error('Verification ledger contains no result rows.');
  const gateNames = gates.map(({ gate }) => gate);
  const duplicateGates = [
    ...new Set(gateNames.filter((gate, index) => gateNames.indexOf(gate) !== index)),
  ];
  if (duplicateGates.length > 0) {
    throw new Error(`Verification ledger duplicates gates: ${duplicateGates.join(', ')}`);
  }
  const present = new Set(gateNames);
  const missing = requiredGates.filter((gate) => !present.has(gate));
  if (missing.length > 0) {
    throw new Error(`Verification ledger is missing required gates: ${missing.join(', ')}`);
  }

  const failures = [];
  for (const gate of gates) {
    if (EVIDENCE_REQUIRED_RESULTS.has(gate.result) && !hasConcreteEvidence(gate.evidence)) {
      failures.push({ ...gate, result: 'INVALID EVIDENCE' });
      continue;
    }
    if (gate.result === 'PASS') continue;
    if (gate.result === 'P2 EXCLUDED' && P2_EXCLUSION_GATES.has(gate.gate)) continue;
    if (gate.result === 'DEVICE HANDOFF' && gate.gate === DEVICE_HANDOFF_GATE) continue;
    if (gate.result === 'DEVIATION' && accepted.has(gate.gate)) continue;
    failures.push(gate);
  }
  const unusedAcceptances = [...accepted.keys()].filter(
    (gate) =>
      !gates.some((candidate) => candidate.gate === gate && candidate.result === 'DEVIATION'),
  );
  if (unusedAcceptances.length > 0) {
    throw new Error(`Unused deviation acceptances: ${unusedAcceptances.join(', ')}`);
  }
  return {
    passed: failures.length === 0,
    gates: gates.length,
    gateResults: Object.fromEntries(gates.map(({ gate, result }) => [gate, result])),
    requiredGates: requiredGates.length,
    acceptedDeviations: accepted.size,
    failures,
  };
}

function runCli() {
  const path = resolve(process.argv[2] ?? 'docs/verification.md');
  const result = evaluateLedger(readFileSync(path, 'utf8'));
  if (!result.passed) {
    const summary = result.failures
      .map((failure) => `${failure.gate}=${failure.result} (line ${failure.line})`)
      .join(', ');
    throw new Error(`Release ledger is not releasable: ${summary}`);
  }
  process.stdout.write(`${JSON.stringify({ ...result, path })}\n`);
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
