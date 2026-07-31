# Journal v1 final review report

## Review decision

**GO — released and approved.** The approved v1 + P1 product is running from the immutable,
manifest-bound release `20260731T182812Z-88ff6fa9bc5d-14233`. All included implementation and
release gates passed. The only in-scope validation not certified is the deliberately honest
physical-iPhone `DEVICE HANDOFF`; no device certification is claimed. Deferred P2 gates remain
explicitly excluded below.

## Coverage

Six independent review packets covered:

1. offline/PWA convergence;
2. UI/accessibility and narrow mobile behavior;
3. HTTP/MCP security and transport backpressure;
4. domain/SQLite durability and launchd installation;
5. architecture/package boundaries and performance;
6. release contracts, documentation and validation.

The packet summaries are in `results/`; the evidence-backed normalized ledger is
`findings.csv`; merged reasoning is in `synthesis.md`.

## Final disposition

| Disposition                     |  Count | Meaning                                                        |
| ------------------------------- | -----: | -------------------------------------------------------------- |
| Resolved                        |     53 | Source, tests and final release evidence discharge the finding |
| Accepted technical decision     |      3 | Measured or bounded technical tradeoff retained deliberately   |
| Accepted product-scope decision |      1 | Exact seven-tool/no-scheduler product boundary retained        |
| P2 excluded                     |      1 | Explicitly outside v1, except versioned JSON portability       |
| Physical-device handoff         |      1 | Assigned owner action; no physical-iPhone pass is represented  |
| **Total**                       | **59** | Complete normalized review record                              |

## Final verification

- Node `v22.19.0` app Vitest: **24 files / 108 tests passed**.
- Node `v22.19.0` server Vitest: **17 files / 133 tests passed**.
- Node `v22.19.0` server integration Vitest: **3 files / 30 tests passed**.
- Release-tool Node tests: **88 / 88 passed**.
- CI-mode Playwright: **31 passed / 6 intentional project-inapplicable skips**.
- Dependency audit: **0 vulnerabilities**; typecheck, lint, formatting, production build and
  `git diff --check` passed.
- Visual QA: **48 screenshots**, with zero overflow or dimension mismatches.
- Sealed NFR benchmark: **pass** — optimistic p95 0.6ms, committed capture p95 1.465ms, MCP read
  p95 2.29ms.
- Machine ledger: **83 gates** — 80 `PASS`, 2 `P2 EXCLUDED`, 1 `DEVICE HANDOFF`, 0 failures and
  0 accepted deviations.

## Final release evidence

- Release stamp: `20260731T182812Z-88ff6fa9bc5d-14233`
- Immutable deployed-tree SHA-256: `72b16666b885f3d38842a185488a3fff77b1581ef3b3b7767f0f2a7623917560`
- Manifest SHA-256: `c874c8b2dab66b89b6f83b88c5e58904da49f8d92827795f500f40f708c92a8f`
- Archive SHA-256: `b26a60ab0799b6fde545ca3b309355a1b55c91fc1139e0d73104ce04b956083c`
- Ledger SHA-256: `9a821bef6b5f4e8a6d8e68e25cf106f5301ee53db30c99cce50a7767c4fb3a7d`

| Evidence                                                  | Result         | Artifact                                                                            |
| --------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| Clean Node 22 preparation, manifest and sealed archive    | PASS           | `release-manifest-20260731T182812Z-88ff6fa9bc5d-14233.json`; release attestation    |
| Immutable staged-tree inventory                           | PASS           | `deployed-tree-20260731T182812Z-88ff6fa9bc5d-14233.json`; 6,040 attested paths      |
| Final upgrade cutover                                     | PASS           | `cutover-20260731T182812Z-88ff6fa9bc5d-14233.json`                                  |
| Local + Tailnet health and exact asset adoption           | PASS           | `live-context-20260731T182812Z-88ff6fa9bc5d-14233.json`                             |
| Fresh backup restored through the staged CLI              | PASS           | `backup-20260731T182812Z-88ff6fa9bc5d-14233.json`                                   |
| Full Serve preservation; existing HTTPS 443 unchanged     | PASS           | `serve-after-20260731T182812Z-88ff6fa9bc5d-14233.json`; zero collateral change      |
| SIGTERM <=5s and distinct healthy PID                     | PASS           | 62.727ms; PID 19546 -> 19790                                                        |
| SIGKILL and distinct healthy PID                          | PASS           | 62.745ms; PID 19790 -> 20167                                                        |
| Physical-iPhone evidence                                  | DEVICE HANDOFF | `device-20260731T182812Z-88ff6fa9bc5d-14233.json`; assigned to Robert               |
| Machine-green release ledger                              | PASS           | `verification-ledger-20260731T182812Z-88ff6fa9bc5d-14233.md`; exact SHA above       |
| Atomic `current-release` promotion and terminal ownership | PASS           | `promotion-20260731T182812Z-88ff6fa9bc5d-14233.json`; terminal `promotion-complete` |

The live service is launchd-owned, uses the exact staged Node/CLI and release working directory,
and owns only `127.0.0.1:5178`. Both local and Tailnet health report version `1.0.0`. The complete
Tailscale Serve configuration was compared: the exact
`:443 -> http://127.0.0.1:5050` handler is unchanged, the Journal handler is exactly
`:5178 -> http://127.0.0.1:5178`, and no collateral change was detected.

The `current-release` pointer resolves exactly to
`/Users/robertsreberski/.journal/releases/20260731T182812Z-88ff6fa9bc5d-14233`.
Promotion evidence records the prepared-evidence compare-and-swap as atomic, and the release-bound
terminal marker is schema v2 state `promotion-complete` with operation `promotion`.

## Post-release hardening closure

RV-054 through RV-059 record six later review discoveries resolved inside the promoted tree:

- locale-independent deployed-tree path ordering (`scripts/release-deployed-tree.mjs:46`, tested at
  `scripts/release-deployed-tree.test.mjs:119`);
- lifecycle serialization on the stable global release lock from preflight through evidence commit
  (`scripts/release-lifecycle.zsh:100`, asserted at `scripts/release-tools.test.mjs:1487`);
- mixed crash-state recovery for a committed atomic-evidence winner plus losing candidates
  (`scripts/release-atomic-file.mjs:230`, tested at `scripts/release-atomic-file.test.mjs:126`);
- string-safe UTC release-stamp construction and explicit-radix zsh octal checks
  (`scripts/release-prepare.zsh:62`, `scripts/release-cutover.zsh:44`, tested at
  `scripts/release-tools.test.mjs:1407`);
- PID-scoped launchd listener inspection, excluding unrelated Tailscale IPNExtension sockets
  (`scripts/release-cutover.zsh:340`, asserted and exercised at
  `scripts/release-tools.test.mjs:1560`); and
- delayed, two-observation launchd label-absence confirmation before same-label bootstrap, including
  rollback (`server/src/jobs/launchd.ts:197`, tested at `server/test/install-service.test.ts:198`,
  with the staged cutover equivalent at `scripts/release-cutover.zsh:585`).

The final server 133/133 and release-tool 88/88 runs cover these changes; terminal promotion,
deployed-tree, lifecycle, cutover and live-context evidence prove their adoption in the final release.

## Review-record provenance

This report, `synthesis.md`, and `findings.csv` were reconciled after atomic promotion so they could
cite the terminal release evidence. They are post-release review records outside the immutable
promoted tree, not a claim that the mutable checkout still byte-matches it. Updating these three
records does not alter the promoted tree, live runtime, pointer or any release-evidence hash.

## Approval

The review is final. Journal v1 + P1 is approved at
`https://mickey-home.tail8a9beb.ts.net:5178`. P2 remains excluded except for tested versioned JSON
portability. The physical-iPhone checklist remains an explicit owner handoff and does not block the
truthful software release decision.
