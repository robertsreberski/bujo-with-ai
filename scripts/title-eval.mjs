/* global AbortSignal, fetch */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const endpoint = argument('endpoint');
const label = argument('label', 'model');
const corpusPath = path.resolve(root, argument('corpus', 'experiments/title-eval/corpus.json'));
const outputPath = path.resolve(
  root,
  argument('output', `experiments/title-eval/results/${label}.json`),
);

const cases = JSON.parse(await readFile(corpusPath, 'utf8'));
if (!Array.isArray(cases) || cases.length < 50) {
  throw new Error(`Title evaluation needs at least 50 cases; found ${cases.length}.`);
}

const normalize = (value) =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replaceAll(/[\p{P}\p{S}]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();

const words = (value) => normalize(value).split(' ').filter(Boolean);
const negativeWords = new Set([
  'avoid',
  'cancel',
  'cancelled',
  'cannot',
  'delay',
  'don’t',
  'dont',
  'never',
  'no',
  'not',
  'pause',
  'stop',
  'wait',
  'without',
]);

function heuristicTitle(text) {
  const sourceWords = words(text);
  const removable = new Set(['a', 'an', 'i', 'need', 'the', 'this', 'to', 'we']);
  while (sourceWords.length > 5 && removable.has(sourceWords[0])) sourceWords.shift();
  return sourceWords.slice(0, 5).join(' ');
}

function evaluateTitle(testCase, title) {
  const titleWords = words(title);
  const normalizedTitle = normalize(title);
  const preserve = testCase.preserve.map((term) => ({
    term,
    present: normalizedTitle.includes(normalize(term)),
  }));
  const preservesNegation =
    !testCase.negation || titleWords.some((word) => negativeWords.has(word));
  return {
    wordCount: titleWords.length,
    validLength: title !== 'NO_TITLE' && titleWords.length >= 4 && titleWords.length <= 5,
    preserve,
    preservesAllRequiredTerms: preserve.every((item) => item.present),
    preservesNegation,
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function summarize(results) {
  const successful = results.filter((result) => result.error === null);
  const count = successful.length || 1;
  const durations = successful.map((result) => result.durationMs);
  return {
    cases: results.length,
    successful: successful.length,
    formatRate: successful.filter((result) => result.evaluation.validLength).length / count,
    requiredTermRate:
      successful.filter((result) => result.evaluation.preservesAllRequiredTerms).length / count,
    negationRate: successful.filter((result) => result.evaluation.preservesNegation).length / count,
    medianDurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    totalCostUsd: successful.reduce((total, result) => total + (result.costUsd ?? 0), 0),
  };
}

const heuristicResults = cases.map((testCase) => {
  const title = heuristicTitle(testCase.text);
  return {
    id: testCase.id,
    title,
    evaluation: evaluateTitle(testCase, title),
    durationMs: 0,
    costUsd: 0,
    error: null,
  };
});

const modelResults = [];
if (endpoint) {
  for (const [index, testCase] of cases.entries()) {
    const startedAt = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: testCase.text, mode: 'sync' }),
        signal: AbortSignal.timeout(65_000),
      });
      const payload = await response.json();
      if (!response.ok || payload.status !== 'succeeded' || typeof payload.text !== 'string') {
        throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
      }
      const title = payload.text.trim();
      modelResults.push({
        id: testCase.id,
        title,
        evaluation: evaluateTitle(testCase, title),
        durationMs: payload.metadata?.runtime?.durationMs ?? Date.now() - startedAt,
        costUsd: payload.metadata?.runtime?.usage?.cost_usd ?? null,
        error: null,
      });
    } catch (error) {
      modelResults.push({
        id: testCase.id,
        title: null,
        evaluation: evaluateTitle(testCase, ''),
        durationMs: Date.now() - startedAt,
        costUsd: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    process.stderr.write(`[${label}] ${index + 1}/${cases.length} ${testCase.id}\n`);
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  corpus: path.relative(root, corpusPath),
  label,
  endpointUsed: Boolean(endpoint),
  heuristic: {
    summary: summarize(heuristicResults),
    results: heuristicResults,
  },
  model: endpoint
    ? {
        summary: summarize(modelResults),
        results: modelResults,
      }
    : null,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(
  `${JSON.stringify(report.model?.summary ?? report.heuristic.summary, null, 2)}\n`,
);
process.stdout.write(`Wrote ${outputPath}\n`);
