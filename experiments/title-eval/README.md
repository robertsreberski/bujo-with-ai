# Four-to-five-word title evaluation

This experiment tests whether a locked-down mono-agent can improve skimming without changing canonical journal text. It uses 50 synthetic long notes, ideas, questions, and reflections. No real journal entry was read or sent to a model.

## Runtime boundary

Both models ran through mono-agent 0.16.0 using the Pi OpenAI-Codex provider with:

- `runtime.maxTurns: 1`, `runtime.effort: "minimal"`, and per-message sessions;
- `tools.allowedTools: []`, no MCP servers, no skills, and no memory;
- a loopback-only synchronous webhook;
- native fail-closed sandboxing and one-day local artifact retention.

The identity required exactly four or five plain words, preservation of negation, names, commitments, and dates, no invented facts, and `NO_TITLE` when a faithful result was impossible.

## Reproduction

Start an equivalently constrained webhook on `127.0.0.1`, then run:

```sh
npm run title:eval -- \
  --endpoint http://127.0.0.1:48179/webhook/title \
  --label luna
```

Change the configured model and label to repeat the run for Terra. Without `--endpoint`, the script evaluates the deterministic first-phrase heuristic only.

## Results

| Candidate              | Format: 4–5 words | Required-term preservation | Negation preservation |   Median |      p95 |    Cost |
| ---------------------- | ----------------: | -------------------------: | --------------------: | -------: | -------: | ------: |
| First-phrase heuristic |              100% |                        12% |                   62% |     0 ms |     0 ms |      $0 |
| GPT-5.6 Luna           |               66% |                        42% |                   60% | 3,372 ms | 9,194 ms | $0.0597 |
| GPT-5.6 Terra          |               68% |                        54% |                   64% | 1,543 ms | 7,203 ms | $0.0956 |

The predeclared gate required at least 95% format compliance and 98% preservation of meaningful negation, names, and dates before usefulness testing. Both model candidates fail the hard gate by a wide margin. Examples include six- or seven-word outputs despite the exact constraint, `NO_TITLE` for eligible entries, and titles that remove an explicit `not`, `never`, or `without` boundary.

## Decision

Do not ship generated titles, a derived-title schema, or a provider worker in this release. Keep canonical text authoritative and ship the deterministic two-line expandable preview. A future experiment may revisit structured-output enforcement or a local non-generative summarizer, but it must open a new gate rather than weakening this one.

The complete synthetic corpus and per-case outputs are retained beside this report for review and repeatability.
