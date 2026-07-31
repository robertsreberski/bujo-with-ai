# Journal v1 review synthesis

Status: **final — released and promoted**

Scope: approved v1 + P1 implementation, with P2 excluded except versioned JSON portability.

Method: six independent read-only review packets, merged by root cause and rechecked against the
sealed release and live deployment. The normalized record is [findings.csv](findings.csv).

## Result

The review record contains 59 root-cause findings and decisions:

- 53 resolved implementation or release findings;
- 3 accepted technical decisions: deferred whole-record IndexedDB cloning, complete MCP collection
  resources backed by bounded SQL pages, and session-local reconnect-based MCP notification replay;
- 1 accepted product-scope decision covering exactly seven MCP tools and no proposal queue or
  scheduler;
- 1 explicit P2 exclusion;
- 1 physical-device handoff that deliberately does not claim an iPhone pass.

No packet assertion was accepted on confidence alone. Duplicate symptoms were merged into the
underlying state-convergence, lifecycle, durability, transport-backpressure, permission, or release
ownership issue. File/line evidence, remediation, impact, validation and status remain in the CSV.

## Material resolved risks

### Offline and client convergence

Async store work is invalidated at lifecycle and SSE-reset boundaries. Delayed mutation/month
responses cannot overwrite canonical state; permanent conflicts discard only affected optimistic
rows; every 401 path enters one sticky pairing pause. Draft persistence and delayed tasks are
drained or cancelled at shutdown. Offline date intent stays frozen across midnight, and Summary
tombstones retain the correct fallback until canonical refresh.

Service-worker runtime caching is restricted to the four specified history fallback families;
bootstrap and settings remain authoritative network data. Service-worker revision hashing is
deterministic across identical builds because emitted assets are ordered before hashing. The visual
viewport controller rejects transient zero-height samples.

### Accessibility and mobile UI

Dialogs trap and restore focus, the calendar no longer claims an incomplete ARIA grid, migration
announcements follow committed mutations, failed full search is explicitly downloaded-only, and
terminal tasks no longer expose illegal actions. Narrow/coarse controls retain 40px targets, focus
tokens were corrected, safe-area content is inset once, and Yesterday grouping is calendar/DST
safe.

The physical-iPhone standalone checklist remains a release-bound `DEVICE HANDOFF`; desktop,
emulation, or simulator evidence is not substituted for a real device.

### HTTP, MCP and security

Reserved REST/MCP paths return protocol JSON errors rather than the SPA. Host and Origin checks are
scheme-aware. Untrusted tool names/request content do not enter operational logs, mixed JSON-RPC
batches audit each rejection once, and `add_entry` uses the canonical entry-or-Summary output union.

MCP resource-list notifications have bounded session replay, event IDs and exact-once reconnect
tests. REST SSE clients have an explicit byte ceiling and are disconnected on backpressure. The
live deployment exposes exactly seven tools — five automatic writes and two reads — with no
provider or scheduler configuration. A temporary Tailnet MCP token completed initialize, tool-list
and read smoke tests, was revoked, and then returned 401; neither secrets nor journal content were
persisted in evidence.

### Domain, SQLite and service lifecycle

A process-verified writer lease prevents two writable runtimes. Shutdown quiesces ingress first,
can cancel an online backup, and bounds WAL checkpoint wait so a pinned reader does not consume the
five-second launchd budget. Startup failure attempts every acquired-resource cleanup.

Backups are verified before atomic replacement. Corrupt files are preserved without removing the
canonical inode first; corrupt symlinks are never followed. The 03:30 timezone schedule catches up
after restart and ignores future-dated snapshots. Migration history must be a contiguous,
checksum-correct known prefix, and compiled migration assets are exercised.

JSON export is one validated SQLite read snapshot; import preflights cross-references. Unicode
substring matching, deleted Summary-note relinking, private paths/file modes, readonly live-safe
CLI commands and protected output aliases have focused regressions. The launchd installer validates
Node/CLI, serializes installation, lints before bootout, atomically replaces its plist, verifies
adoption and reports incomplete rollback.

### Scale and package boundaries

Entry and Activity adapters use deterministic SQL keyset pages; Activity snapshot eligibility uses
batched entity reads. Client entry updates reindex only touched buckets. The browser imports the
app-safe contract, and the Vite production guard rejects server-only MCP contracts in browser
chunks.

The single-record IndexedDB design is retained for atomic mirror/outbox durability, while cloning
is deferred out of the synchronous capture path. The sealed benchmark recorded p95 0.6ms optimistic
visibility, 1.465ms committed capture and 2.29ms MCP read against limits of 16ms, 100ms and 300ms.

### Release and operations

The final tree is immutable and manifest-bound. Rehearsal exposed and closed operational gaps before
promotion: launchd uses `ProcessType=Interactive` for reliable cold Node startup; service-worker
output is deterministic; bounded child-process evidence permits up to 4 MiB; and runtime listener
validation intersects the exact launchd PID with port 5178 rather than counting unrelated
Tailscale IPNExtension sockets.

The later hardening pass also made deployed-tree source ordering explicitly locale-independent;
serialized lifecycle work with cutover and promotion on the stable global release lock; recovered a
committed atomic-evidence winner beside dead losing candidates while failing closed on live owners;
kept UTC release-stamp construction string-safe while using explicit-radix zsh octal checks; and
required two separated launchd label-absence observations before same-label bootstrap. Both staged
cutover and the launchd installer apply the delayed absence rule, including cleanup and rollback,
and refuse to bootstrap when absence cannot be confirmed. These are RV-054 through RV-059.

The promoted launchd job runs Node `22.19.0` from the exact release working directory, owns only
`127.0.0.1:5178`, and reports healthy locally and through Tailnet. The complete Tailscale Serve
configuration was compared, preserving the separately owned exact
`:443 -> http://127.0.0.1:5050` mapping with zero collateral change. A fresh mode-0600 backup was
quick-checked, restored through the staged CLI, schema-validated, and removed after the drill.
SIGTERM replaced PID 19546 with 19790 in 62.727ms; SIGKILL replaced PID 19790 with 20167 in
62.745ms. Both replacement runtimes were healthy and bound to the final immutable tree.

## Final verification

Rechecked on Node `v22.19.0` on 2026-07-31:

| Gate                      | Result                                               |
| ------------------------- | ---------------------------------------------------- |
| App Vitest                | 24 files, 108 tests passed                           |
| Server Vitest             | 17 files, 133 tests passed                           |
| Server integration Vitest | 3 files, 30 tests passed                             |
| Release-tool tests        | 88 / 88 passed                                       |
| CI-mode Playwright        | 31 passed, 6 intentional project-inapplicable skips  |
| Static/build/audit        | type, lint, format, build passed; 0 vulnerabilities  |
| Visual QA                 | 48 screenshots; 0 overflow/dimension mismatches      |
| Sealed NFR benchmark      | pass; 20 measured samples per metric after 3 warmups |
| Release ledger            | 80 PASS, 2 P2 EXCLUDED, 1 DEVICE HANDOFF, 0 failures |

The production release is `20260731T182812Z-88ff6fa9bc5d-14233`, with exact immutable deployed-tree
SHA-256 `72b16666b885f3d38842a185488a3fff77b1581ef3b3b7767f0f2a7623917560`.
The manifest SHA-256 is `c874c8b2dab66b89b6f83b88c5e58904da49f8d92827795f500f40f708c92a8f`,
the archive SHA-256 is `b26a60ab0799b6fde545ca3b309355a1b55c91fc1139e0d73104ce04b956083c`,
and the ledger SHA-256 is `9a821bef6b5f4e8a6d8e68e25cf106f5301ee53db30c99cce50a7767c4fb3a7d`.

Promotion atomically set `~/.journal/current-release` to the exact final release path using the
prepared-evidence compare-and-swap. Its release-bound terminal marker is state
`promotion-complete`; promotion evidence records green local and Tailnet health, the exact final
runtime/tree, and an unchanged `:443 -> http://127.0.0.1:5050` handler with zero Serve collateral
change.

The final report, this synthesis, and the normalized findings CSV were reconciled only after
promotion so they could cite terminal evidence. These three post-release review records are outside
the immutable promoted tree; they did not change its identity, the pointer, live runtime or evidence.

## Accepted decisions and exclusions

- Keep one atomic IndexedDB record until measured limits fail; avoid a speculative multi-store
  redesign.
- Keep `journal://collection/{id}` complete as required by MCP-16 while using bounded SQL pages.
- Keep MCP notification replay session-local/capped and reconnect after notification; introduce no
  keepalive queue.
- Ship exactly seven MCP tools: five automatic writes and two reads. Proposals are compatibility
  metadata only, and no scheduler is installed.
- Exclude P2 advanced migration shortcuts and multi-journal/archive/Markdown export. Versioned JSON
  import/export remains a tested v1 durability requirement.
- Hand the seven physical-iPhone checks to Robert without claiming certification.

## Final decision

**GO.** Journal v1 + P1 is released at `https://mickey-home.tail8a9beb.ts.net:5178`. The immutable
promotion, live runtime/Tailnet adoption, complete Serve preservation, restore-tested backup,
lifecycle recovery, benchmark and 83-gate ledger are all evidenced. RV-034 through RV-039 and
RV-054 through RV-059 are resolved. RV-043 remains the truthful physical-device handoff, and RV-041
remains the explicit P2 exclusion.
