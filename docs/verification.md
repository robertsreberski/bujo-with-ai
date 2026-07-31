# Verification Matrix

This is the release evidence ledger for the approved **v1 + P1** build. Update
the Evidence and Result cells with exact test names, commands, screenshots, or
operator output; a green build alone is not evidence for a behavior it did not
exercise.

In the release-specific copy, every `PASS`, `DEVIATION`, and `DEVICE HANDOFF`
Evidence cell must replace the template text with `EVIDENCE: ` followed by a
concrete command/output reference, artifact path, screenshot, acceptance ID, or
handoff record. Changing only Result cells is rejected.

Result values: `NOT RUN`, `PASS`, `FAIL`, `DEVIATION`, `P2 EXCLUDED`, or
`DEVICE HANDOFF`. A release is complete when every included row is `PASS` or
an explicitly accepted `DEVIATION`, except the physical-iPhone row which may be
handed off without claiming certification.

`npm run release:ledger -- docs/verification.md` checks this template; the
staged command in [operations.md](operations.md) checks the release-specific
copy. The gate fails
every included `NOT RUN` or `FAIL`, every `DEVIATION` without an exact matching
acceptance record below, and every `DEVICE HANDOFF` outside the specifically
named physical-iPhone gate. `P2 EXCLUDED` is allowed. Run this gate after all
release evidence has been recorded; `release:promote` runs it again before the
atomic pointer change.

## Product and non-functional requirements

| Requirements | Acceptance focus                                                            | Intended evidence                                     | Result      |
| ------------ | --------------------------------------------------------------------------- | ----------------------------------------------------- | ----------- |
| FR-1…5       | Composer/parser, fast optimistic capture, offline replay                    | parser/component/outbox E2E                           | NOT RUN     |
| FR-6…10      | Day groups, rows/toggles, leftovers                                         | component + browser E2E                               | NOT RUN     |
| FR-11…14     | One-at-a-time migration and four atomic outcomes                            | domain + browser E2E                                  | NOT RUN     |
| FR-15…17     | Calendar day deep link, monthly log, summary actions                        | route/component/API E2E                               | NOT RUN     |
| FR-18…20     | Index, collection management/detail/filing                                  | domain + browser E2E                                  | NOT RUN     |
| FR-21…23     | Entry detail, all actions, full editing                                     | component/API E2E                                     | NOT RUN     |
| FR-24…25     | Search, exact tag, saved views, keyboard                                    | parser/search/browser E2E                             | NOT RUN     |
| FR-26…32     | Exact seven MCP tools; five automatic; Activity/Revert; Summary; tokens     | MCP contract + real-server E2E                        | NOT RUN     |
| FR-33…36     | Install/offline/iOS/responsive PWA                                          | Playwright + manifest + device handoff                | NOT RUN     |
| FR-37        | Habit month grid                                                            | component/visual/E2E                                  | NOT RUN     |
| FR-38        | Conflict-safe one-tap revert                                                | domain/API/browser E2E                                | NOT RUN     |
| FR-39        | Advanced migration date shortcuts                                           | none                                                  | P2 EXCLUDED |
| FR-40        | Multiple journals, archiving, Markdown export                               | none; JSON import/export remains included under DM-20 | P2 EXCLUDED |
| NFR-1        | <16ms optimistic paint, <100ms LAN capture, <300ms local MCP p95            | named-hardware benchmark report                       | NOT RUN     |
| NFR-2        | Offline read/write/replay, launchd restart, WAL recovery                    | offline E2E + process/recovery drill                  | NOT RUN     |
| NFR-3        | no server egress, loopback bind, Host/Origin/token defenses, untrusted data | listener/network/security tests                       | NOT RUN     |
| NFR-4        | transaction durability, verified backups, 30-day soft delete                | failure injection + restore drill                     | NOT RUN     |
| NFR-5        | clean Node 22 build and portable safe backup/export                         | CI + clean-install/import test                        | NOT RUN     |
| NFR-6        | WCAG 2.2 AA, keyboard/focus/live regions, ≥40px targets, reduced motion     | axe + manual/visual checks                            | NOT RUN     |

## Architecture and data requirements

| Requirements | Implementation owner                                       | Intended evidence                   | Result  |
| ------------ | ---------------------------------------------------------- | ----------------------------------- | ------- |
| ARC-1…5      | server composition, shared contracts/domain                | architecture + integration tests    | NOT RUN |
| ARC-6…10     | `:5178` URLs, loopback/Serve, Host and Tailnet attribution | listener/Host probes + Serve status | NOT RUN |
| ARC-11…14    | launchd, graceful stop/restart, recovery, health           | service lifecycle drill             | NOT RUN |
| ARC-15…16    | config precedence and frozen offline date intent           | config + midnight/timezone tests    | NOT RUN |
| ARC-17…19    | WAL, verified rotation, JSON export/import                 | DB/CLI + restore tests              | NOT RUN |
| ARC-20…21    | content-free local logs and zero Journal egress            | log inspection + network probe      | NOT RUN |
| DM-1…8       | Entry invariants, placement, copy semantics, labels        | table-driven domain tests           | NOT RUN |
| DM-9…12      | flat/month collections and stable IDs/replay               | domain/contract tests               | NOT RUN |
| DM-13        | atomic immediate migration operations                      | failure-injected transaction tests  | NOT RUN |
| DM-14…15     | soft delete/purge and pre/post compare-and-swap revert     | clock/revert conflict tests         | NOT RUN |
| DM-16…17     | Activity ordering and one-per-week Summary lifecycle       | domain/API tests                    | NOT RUN |
| DM-18…19     | FTS/tag behavior and numbered migrations                   | DB/migration tests                  | NOT RUN |
| DM-20        | validated lossless JSON round trip, no credentials         | CLI round-trip test                 | NOT RUN |
| DM-21        | dev-only demo seed; empty production                       | CLI/build-mode test                 | NOT RUN |

## App, design, and PWA requirements

| Requirements | Acceptance focus                                                | Intended evidence                     | Result  |
| ------------ | --------------------------------------------------------------- | ------------------------------------- | ------- |
| LOG-1…5      | routes, back behavior, responsive navigation/header             | router/browser E2E                    | NOT RUN |
| LOG-6…10     | canonical parser, preview, optimistic/date-safe submit          | goldens + component/outbox E2E        | NOT RUN |
| LOG-11…17    | Today data/order/rows/settings                                  | domain + component + visual           | NOT RUN |
| LOG-18…21    | entry detail/actions/edit                                       | component/API E2E                     | NOT RUN |
| LOG-22…24    | resumable migration ritual                                      | browser E2E                           | NOT RUN |
| LOG-25…29    | month route/calendar/log/summary/habits                         | component + visual + E2E              | NOT RUN |
| LOG-30…33    | collection controls and Activity/Revert Review                  | browser + revert E2E                  | NOT RUN |
| LOG-34…37    | search semantics and keyboard behavior                          | search/component E2E                  | NOT RUN |
| LOG-38…42    | feedback, SSE coalescing, truthful Assistant access             | component/two-client E2E              | NOT RUN |
| DS-1…8       | colors, self-hosted typography, icons/AI mark                   | computed styles + asset/network check | NOT RUN |
| DS-9…14      | narrow/mid/wide layout and spacing                              | 375/680/1024+ visual snapshots        | NOT RUN |
| DS-15…23     | controls, rows/cards/dialog/toast/calendar/composer             | component + touch-target audit        | NOT RUN |
| DS-24…25     | bounded motion and reduced-motion behavior                      | computed style/browser test           | NOT RUN |
| PWA-1…8      | manifest/icons, secure install, custom SW/offline/update prompt | manifest/SW/offline E2E               | NOT RUN |
| PWA-9…17     | safe areas, viewport, keyboard docking                          | emulation + physical device           | NOT RUN |
| PWA-18…22    | touch/scroll/dialog containment                                 | hit-box + interaction checks          | NOT RUN |
| PWA-23…26    | resume, rollover, SSE replay, desktop parity                    | lifecycle/browser E2E                 | NOT RUN |

## MCP and sync requirements

| Requirements           | Acceptance focus                                                             | Intended evidence                       | Result  |
| ---------------------- | ---------------------------------------------------------------------------- | --------------------------------------- | ------- |
| MCP-1…4                | stateful Streamable HTTP, session expiry/teardown, exact endpoint            | real HTTP session tests                 | NOT RUN |
| MCP-5…7                | exact modes/count and persistent 60 writes/token/hour                        | contract/rate/concurrency tests         | NOT RUN |
| MCP-8…11               | token lifecycle, challenge, session binding/revocation, Host                 | auth/security integration tests         | NOT RUN |
| MCP-12…15              | schemas/annotations/results/errors/idempotency; all seven tools              | per-tool contract suite                 | NOT RUN |
| MCP-16…17              | six resources, empty compatibility proposals, list change                    | MCP resource tests                      | NOT RUN |
| MCP-18…20              | capture, explicit weekly summary, owner-invoked hygiene; no scheduler        | skill/protocol E2E + process inspection | NOT RUN |
| MCP-21…24              | injection/plain-text boundary, provider disclosure, Activity/failure honesty | malicious-data + failure tests          | NOT RUN |
| MCP-25…26              | README client smoke and bundled `.claude/skills/journal/SKILL.md`            | command/file validation                 | NOT RUN |
| API-1…4                | schemas/errors, cookie pairing/CSRF, dates, mutation replay                  | REST contract/security tests            | NOT RUN |
| API endpoint inventory | every documented path, DTO, status, online/queueable rule                    | generated route/contract matrix         | NOT RUN |
| API-5…7                | post-commit batches, epoch replay/reset, device-specific echo handling       | SSE/two-client/restart tests            | NOT RUN |
| API-8…9                | IndexedDB mirror/history/draft survival                                      | browser eviction/offline tests          | NOT RUN |
| API-10…13              | atomic optimistic outbox, errors/dead letters, canonical reconnect           | crash/lost-response/offline E2E         | NOT RUN |
| API-14…16              | complete domain/parser/security/E2E gates                                    | named Vitest/Playwright suites          | NOT RUN |

## Release commands and operational evidence

| Gate                                            | Command or evidence                                                                                | Result         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------- |
| Exact Node and clean dependency install         | `.nvmrc` equality; `npm ci`; high-severity audit                                                   | NOT RUN        |
| Static, unit, integration, and production build | `npm run check`                                                                                    | NOT RUN        |
| E2E TypeScript configuration                    | `npm exec tsc -- --project e2e/tsconfig.json` before Playwright                                    | NOT RUN        |
| Browser-tested production bundle                | `CI=1 npm run test:e2e`; forbidOnly/flaky gate; no post-E2E build                                  | NOT RUN        |
| Release tooling fixtures                        | manifest/archive/mode/tamper, ledger, Serve, backup, and stamped live-context fail-closed tests    | NOT RUN        |
| NFR benchmark                                   | isolated report passes optimistic, owner-capture, and MCP p95 thresholds                           | NOT RUN        |
| Exact dirty-tree manifest and archive           | Git base/status/diffs, dist, modes, hashes, toolchain, no extras, extracted-tree verification      | NOT RUN        |
| Immutable staged release                        | exact extraction, production install, only `node_modules` extra, no write/group/other bits         | NOT RUN        |
| Install or upgrade ownership                    | unambiguous pre-state; old/absent `current-release` remains unchanged                              | NOT RUN        |
| Exact launchd adoption                          | `env -i`, exact PID environment, staged Node/CLI/cwd identity, one launchd-owned loopback listener | NOT RUN        |
| Health and served asset adoption                | exact `status`, `db`, version, and served manifest asset SHA-256                                   | NOT RUN        |
| Tailnet HTTPS reachability and asset            | bounded exact `/healthz` plus served manifest asset SHA-256 through Tailnet TLS                    | NOT RUN        |
| Fresh backup and restore                        | unique mode-0600 backup; counts/quick_check; staged CLI check and schema-validated export          | NOT RUN        |
| Entire Tailscale Serve configuration            | complete normalized before/after comparison; only exact `:5178` first-install delta                | NOT RUN        |
| Existing HTTPS 443 preserved                    | exact `mickey-home.tail8a9beb.ts.net:443 -> http://127.0.0.1:5050` in every snapshot               | NOT RUN        |
| Graceful SIGTERM lifecycle                      | exact PID exits in no more than 5 seconds; distinct healthy launchd recovery                       | NOT RUN        |
| SIGKILL crash lifecycle                         | separate exact PID; distinct healthy launchd recovery                                              | NOT RUN        |
| Physical iPhone standalone                      | seven checks in SPEC-05 section 8 plus stamped device provenance                                   | DEVICE HANDOFF |
| Final promotion guard                           | lockf + CAS; deployed-tree and <=2h live SHA; strict log scan + HTTP-free binding; crash recovery  | NOT RUN        |

## Explicitly accepted release deviations

Add a row only after an accountable owner accepts a release-specific deviation.
The Gate cell must exactly equal the deviating gate above.

| Gate | Acceptance ID | Owner | recordedAt | reason |
| ---- | ------------- | ----- | ---------- | ------ |

## Approved deviations and exclusions

- P0 and historical P1 ship together; P2 FR-39/FR-40 remain excluded except
  versioned JSON portability, which is an explicit v1 durability requirement.
- All five MCP writes are automatic. Proposal entities, endpoints, storage,
  badges, and queues are intentionally absent. `journal://proposals` is empty
  compatibility metadata only.
- Weekly AI integration includes the MCP protocol, tests, documentation, and
  `.claude/skills/journal/SKILL.md`; no scheduled process is installed.
- The Journal server has no third-party egress. Owner-authorized MCP clients
  may transmit retrieved data to their configured AI provider.
- Prototype contrast/touch-target values may be corrected for WCAG 2.2 AA;
  SPEC-04's deviation log records the exact changes.
