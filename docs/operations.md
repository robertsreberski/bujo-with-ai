# Journal production operations

This is the macOS/zsh release procedure for `mickey-home`. It installs Journal on loopback
`127.0.0.1:5178` and exposes only that port through Tailscale Serve. The existing handler
`mickey-home.tail8a9beb.ts.net:443 -> http://127.0.0.1:5050` is separately owned and must never be
changed.

The helpers are strict and fail on the first error. They create owner-only evidence, never deploy
from the mutable checkout, and do not move `~/.journal/current-release` until every acceptance gate
has passed.

## 1. Prepare the exact browser-tested release

Start in the canonical checkout with no development server on `:5178`:

```zsh
cd /Users/robertsreberski/Personal_Repositories/bujo-with-ai
nvm install
nvm use
npm run release:prepare
```

The helper requires `node --version` to equal `.nvmrc`, classifies the run as a first install or an
upgrade, and runs this fail-fast preflight:

1. `npm ci`
2. `npm audit --audit-level=high`
3. `npm run check`
4. `npm exec tsc -- --project e2e/tsconfig.json`
5. `CI=1 npm run test:e2e`
6. `node scripts/benchmark-release.mjs --spawn-isolated`

`npm run check` performs the first production build. Playwright's configured web server performs
the second and final build before browser testing. `CI=1` enables `forbidOnly`, one retry with
`failOnFlakyTests`, and the CI reporters. The benchmark consumes that same build without rebuilding
it. There is deliberately no third, post-E2E build.

The final line is a unique context path such as:

```zsh
CONTEXT=$HOME/.journal/release-evidence/release-context-20260731T120000Z-abcdef123456-1234.json
```

The context binds the unique release stamp to the base commit, dirty Git status/diffs, Node/npm and
lockfile toolchain, benchmark hash, manifest hash, archive hash, and release version. The manifest
contains every tracked and untracked non-ignored source plus the ignored `app/dist` and
`server/dist` trees, with file type, size, mode, and SHA-256. Archive creation re-fingerprints the
source, refuses drift, restores the archive into a temporary tree, and verifies there are no
missing, changed, or extra paths. The manifest, archive, attestation, benchmark, and context are
mode `0600`. It also points to an owner-only, release-specific copy of the verification ledger.

Do not edit the checkout, manifest, archive, benchmark, attestation, or context after this point.
Do not use an old context for a new attempt.

## 2. Stage an immutable release

```zsh
npm run release:stage -- "$CONTEXT"
```

Staging extracts into a unique `~/.journal/releases/.staging-*` directory, verifies the exact
archive, runs `npm ci --omit=dev`, and executes the staged Node/runtime against an isolated
temporary database, ephemeral loopback port, and the real production bundle. That smoke warms the
new immutable path without touching live Journal data. Staging permits only the resulting
`node_modules` addition, removes all write bits and group/other access from non-symlink paths,
verifies content again, and atomically renames the directory to
`~/.journal/releases/<release-stamp>`. It never changes launchd, Tailscale, the journal database,
or `current-release`.

First-install and upgrade ownership are intentionally different:

- First install requires no `current-release`, config, plist, loaded Journal job, loopback `:5178`
  listener, or Tailscale `:5178` handler. Any partial state is ambiguous and stops the release.
- Upgrade requires `current-release` to resolve to the context's recorded previous release, an
  existing config and plist, one loaded launchd PID, exactly one loopback listener owned by that
  PID, and the exact existing Tailscale `:5178` handler.

## 3. Apply the reversible cutover

```zsh
npm run release:cutover -- apply "$CONTEXT"
```

Before mutation, the helper records the entire Tailscale Serve JSON and, for an upgrade,
owner-preserving copies of the existing config and plist. It verifies the exact `:443` HTTPS proxy
and all ownership preconditions. Because rollback never rewinds the database schema, the migration
guard compares the runtime definitions plus both source and compiled SQL inventories before any
config, plist, service, or database mutation. Historical versions, names, filenames, and SQL bytes
must be identical. A candidate may append a contiguous suffix only when the previous release
declares migration-compatibility protocol 1 and each new SQL file declares
`journal:migration-mode additive`; the bounded grammar permits only new tables/indexes and added
columns. This enforces the release order **compatibility runtime → additive schema release → later
optional contraction**. It then installs the production config, invokes the staged Node runtime and
staged `server/dist/cli.js install-service`, and verifies all of the following:

Because macOS completes `bootout` asynchronously, both replacement and rollback wait up to five
seconds for two consecutive absent `launchctl print` results before bootstrapping the same label.
An unexpected lookup result or an unsettled job fails closed without a competing bootstrap.

- launchd reports exactly one PID within the bounded 30-second cold-release readiness window;
- the plist is mode `0600`; its `ProgramArguments` are `/usr/bin/env -i`, the exact sorted
  production `KEY=value` assignments, staged Node, staged CLI, and `serve`; its `ProcessType` is
  `Interactive`, and its working directory is the immutable staged release;
- the loaded launchd job reports that same working directory, and `lsof` proves the live PID's cwd
  resolves to the same directory and filesystem identity;
- the plist's declarative environment points at exactly `~/.journal/config.json` and `~/.journal`
  and contains the expected production bind, port, host, timezone, and release version values;
  targeted `ps eww -p <pid>` inspection proves the Node PID received those exact keys and values
  after `env -i`, with no inherited credentials, provider variables, or scheduler configuration;
- `lsof` reports exactly one `127.0.0.1:5178` listener and its PID equals launchd's PID;
- `/healthz` reports `status: "ok"`, `db: "ok"`, and the manifest version;
- the app shell's served module has the exact bytes and SHA-256 recorded in the manifest.

On first install only, it then adds:

```text
mickey-home.tail8a9beb.ts.net:5178 -> http://127.0.0.1:5178
```

The before/after verifier canonicalizes and compares the entire Serve configuration. For an
upgrade it requires byte-equivalent normalized JSON. For a first install it removes only the exact
new `TCP["5178"]` and `Web["mickey-home.tail8a9beb.ts.net:5178"]` entries from the after snapshot,
then requires the rest to equal the complete before snapshot. Both snapshots must still contain
the exact `:443 -> http://127.0.0.1:5050` handler, so every unrelated handler is protected.
After configuration comparison, a separate bounded readiness probe fetches
`https://mickey-home.tail8a9beb.ts.net:5178/healthz`, the app shell, and its module asset through
Tailnet TLS. Health must match the release version and the served asset bytes/SHA-256 must match the
manifest; loopback PID/listener proof remains a separate gate.

Any cutover error triggers an immediate self-restore of only release-owned resources. Even if the
first-install Serve command partially mutates and returns an error, rollback attempts the exact
`:5178 off` operation and then proves the complete configuration equals the baseline. The helper
restores the old config/plist/service on upgrade, or removes only the new service/config and
`:5178` handler on first install, then compares the entire restored Serve configuration to the
baseline. `current-release` remains old or absent throughout.

## 4. Prove backup recovery through the staged CLI

```zsh
STAMP=$(jq -er '.releaseStamp' "$CONTEXT")
RELEASE=$(jq -er '.releaseRoot' "$CONTEXT")
MANIFEST=$(jq -er '.manifest' "$CONTEXT")
NODE=$(jq -er '.toolchain.nodePath' "$MANIFEST")
EVIDENCE=${CONTEXT:h}

"$NODE" "$RELEASE/scripts/release-backup-drill.mjs" \
  --context "$CONTEXT" \
  --database "$HOME/.journal/journal.db" \
  --backup-dir "$HOME/.journal/backups" \
  --evidence "$EVIDENCE/backup-$STAMP.json"
```

Every invocation creates a freshly and randomly suffixed owner-only SQLite online backup; it never
reuses a daily filename. The helper runs `quick_check`, restores into a temporary directory,
compares schema version and per-table counts, invokes the staged CLI's `check` and `export`
commands against the restored copy, validates the export with the staged contract schema, reruns
`quick_check`, and removes the temporary restore. The retained backup is hashed and mode `0600`.

`journald export` now writes envelope version 2: canonical entries, collections, activity,
summaries, and settings live under `journal`, while optional future projections live under
`derived`. `journald import` continues to accept the flat version-1 document and the version-2
envelope. A compatibility runtime validates and imports canonical data while intentionally ignoring
unknown keys inside `derived`; derived data can never replace or alter canonical journal content.

## 5. Prove graceful shutdown and crash recovery

```zsh
npm run release:lifecycle -- "$CONTEXT"
```

This targets launchd's exact current PID with `SIGTERM`, measures process exit with a high-resolution
clock, and fails above 5 seconds. It waits for a distinct healthy replacement and reruns the full
runtime/asset verifier. It then targets that exact second PID with `SIGKILL`, requires a third,
distinct healthy PID, and reruns the verifier. SIGTERM and SIGKILL are separate evidence records;
a successful crash recovery cannot substitute for graceful shutdown. The helper verifies the exact
deployed-tree attestation before signaling and again after final recovery; lifecycle evidence records
matching attestation/tree hashes and `stableDuringLifecycle: true`. It holds the shared stable global
release lock from the lifecycle-evidence absence check through evidence commit and refuses to signal
unless the owner-private schema-2 terminal marker is exactly `cutover-complete` / `cutover-apply` for
the same stamp.

## 6. Record physical-device provenance

### The physical iPhone and iPad checklist

Run every check on both a notched iPhone and an iPad with the release installed to the home screen,
in standalone mode, over the Tailnet origin. Record the model, OS, orientation, and result for each;
browser emulation is useful preflight evidence but is never a physical-device pass. This list is
authoritative; it moved here from the retired SPEC-05 when v1 shipped.

1. No white/black bar at top or bottom; status-bar area painted `#16130F`.
2. Composer sits flush above the keyboard while typing; no jitter while typing; it neither shifts
   nor mis-registers taps when the suggestion panel opens; tab bar restored cleanly on dismiss.
3. No page-level rubber-band; day list bounces within itself only.
4. Focusing the composer does not zoom the page.
5. App-switch away during capture → return: draft intact, layout correct, queued entry syncs.
6. Airplane mode: journal readable, capture works, banner shows; disable → entries sync, SSE
   resumes.
7. Home-screen install shows correct icon/name; cold offline launch renders the journal.
8. Type `#` or `/` with the keyboard up: the suggestion panel rides above the composer instead of
   sitting behind the keyboard, and tapping a row completes the token without dismissing it.
9. Open an entry sheet with the keyboard raised, then the destination picker's "New collection"
   field: both must stay above the keyboard — the one known divergence this list leaves open.

### Record the dual-device handoff

The physical-device checklist is explicitly approved as a handoff. Record the assignee, both target
classes, and exact checklist reference without inventing device results:

```zsh
STAMP=$(jq -er '.releaseStamp' "$CONTEXT")
RELEASE=$(jq -er '.releaseRoot' "$CONTEXT")
MANIFEST=$(jq -er '.manifest' "$CONTEXT")
NODE=$(jq -er '.toolchain.nodePath' "$MANIFEST")
EVIDENCE=${CONTEXT:h}

"$NODE" "$RELEASE/scripts/release-device-evidence.mjs" \
  --context "$CONTEXT" \
  --output "$EVIDENCE/device-$STAMP.json" \
  --status 'DEVICE HANDOFF' \
  --assignee 'Robert' \
  --device-targets 'iPhone,iPad' \
  --checklist-reference 'operations.md section 6, nine checks on physical iPhone and iPad' \
  --notes 'Assigned for owner execution on both targets; emulation is not a device pass.'
```

The artifact records `handoff.targets` as `iPhone` and `iPad` and remains bound to the release stamp,
base commit, manifest SHA-256, and archive SHA-256.
It refuses stale manifest or archive bytes. Only an actual `PASS` record requires and accepts a
concrete device model, iOS version, and Tailnet account. In the release ledger, record this gate as
`EVIDENCE: device-<release-stamp>.json; assignee and section 6 physical iPhone/iPad checklist` with result
`DEVICE HANDOFF`; do not reuse the template's intended-evidence text.

## 7. Capture final context-bound live evidence

Run this evidence-only inspection and temporary-credential smoke after the lifecycle drill and all
other acceptance traffic, so its final log scan covers both SIGTERM/SIGKILL recoveries. Invoke the
attested staged helper, never the mutable checkout copy:

```zsh
STAMP=$(jq -er '.releaseStamp' "$CONTEXT")
RELEASE=$(jq -er '.releaseRoot' "$CONTEXT")
MANIFEST=$(jq -er '.manifest' "$CONTEXT")
NODE=$(jq -er '.toolchain.nodePath' "$MANIFEST")
EVIDENCE=${CONTEXT:h}

"$NODE" "$RELEASE/scripts/release-live-evidence.mjs" \
  --context "$CONTEXT" \
  --origin 'https://mickey-home.tail8a9beb.ts.net:5178' \
  --output "$EVIDENCE/live-context-$STAMP.json"
```

The helper refuses an uncut, rolled-back, stale, altered, or already-recorded release context. It
binds the owner-only JSON to the release stamp, base commit, manifest SHA-256, and archive SHA-256,
and verifies its own bytes and Node path against the manifest. Collection then fails closed unless:

- the exact launchd job, PID, mode-`0600` plist, isolated `env -i` plus staged Node/CLI `serve`
  arguments, loaded working directory, and live PID cwd/filesystem identity agree; the declarative
  plist overlay matches the intended production values while initial and final targeted PID
  inspection prove the effective key/value allowlist, with no inherited credential, provider, or
  scheduler configuration;
- the PID has no descendants and launchd has no second Journal/BuJo-related job;
- the full deployed-tree attestation, including `node_modules`, matches before collection and after
  the final runtime/log checks; evidence binds its attestation/tree hashes and records
  `stableDuringCollection: true`;
- every journald TCP endpoint reported by `lsof` is loopback (only endpoint/state/direction metadata
  is retained);
- launchd stdout is absent or zero bytes, while launchd stderr, `journald.log`, and every gzip
  rotation are complete JSON Lines containing only `server_started`, `server_stopped`,
  `http_request`, or `mcp_tool_call` with each operation's exact metadata-key allowlist; the helper
  validates the complete inventory before creating a credential, revalidates it after its own
  pair/token/MCP/revoke traffic, then performs the final PID/cwd/environment/socket recheck; the
  retained second TCP phase is explicitly `after-final-log-inspection`. Evidence records only final
  hashes, byte/line counts, and operation counts; unknown fields, unstructured lines,
  credential-shaped values, unsafe paths/labels, unexpected log files, or invalid rotation history
  fail without copying any line into evidence;
- the Tailnet MCP origin passes `initialize`, the exact seven-tool inventory, and a read-only
  `search` call using a random no-op query; response bodies are structurally checked and discarded;
- the helper pairs through loopback REST, holds the owner cookie only in memory, creates and revokes
  the temporary MCP token through the live owner API, closes the MCP session, and proves revocation
  with a final Tailnet `401`; neither cookie, bearer secret, session id, query, response body, nor
  journal content is written to stdout or evidence;
- the same launchd PID remains live at the end of the bounded inspection.

Commands and loopback requests are capped at two seconds, Tailnet MCP requests at five seconds, and
the complete token operation at six seconds by default. Any timeout, unexpected result, or unproven
token cleanup prevents evidence creation. The helper discards the in-memory pairing secret after
cleanup; the server retains only its normal one-way device-token hash. The exact stamped artifact is
a required promotion input. Promotion reads it once from the release-evidence directory, requires an
owner-owned single-link regular file at mode `0600`, hashes those same bytes, and fails closed unless
its release identity plus every service, isolated-environment, socket, log-privacy, MCP-smoke, and
credential-cleanup assertion remains internally consistent. Final promotion requires cutover first,
then lifecycle completion, then this live artifact, which may be no more than two hours old. The
lifecycle drill intentionally replaces earlier PIDs, so freshness validates timestamp ordering and
the final post-lifecycle runtime rather than requiring cross-lifecycle PID equality.

## 8. Complete the ledger, then promote

Update only the release-specific ledger copy with exact commands and evidence paths. For every
`PASS`, `DEVIATION`, or `DEVICE HANDOFF`, replace the template Evidence cell with `EVIDENCE: ` plus
the concrete release output or artifact reference; changing Result cells alone is rejected. The
checked-in [verification.md](verification.md) remains the immutable template and must not change
after attestation. Run the gate only after operational and handoff evidence exists:

```zsh
STAMP=$(jq -er '.releaseStamp' "$CONTEXT")
RELEASE=$(jq -er '.releaseRoot' "$CONTEXT")
MANIFEST=$(jq -er '.manifest' "$CONTEXT")
NODE=$(jq -er '.toolchain.nodePath' "$MANIFEST")
EVIDENCE=${CONTEXT:h}
LEDGER=$(jq -er '.ledger' "$CONTEXT")
"$NODE" "$RELEASE/scripts/release-ledger.mjs" "$LEDGER"
"$NODE" "$RELEASE/scripts/release-promote.mjs" \
  --context "$CONTEXT" \
  --device "$EVIDENCE/device-$STAMP.json" \
  --ledger "$LEDGER"
```

The ledger rejects every included `NOT RUN`, `FAIL`, or unaccepted `DEVIATION`; it permits `P2
EXCLUDED` and the specifically named physical-iPhone `DEVICE HANDOFF`. A deviation passes only
with a matching ID, owner, UTC timestamp, and reason in the acceptance table.

Promotion independently revalidates manifest/archive/benchmark hashes, immutable staging, full
deployed-tree attestation including installed dependency bytes,
cutover evidence against the owner-only raw Serve snapshots, unique backup and staged-CLI restore,
distinct lifecycle recoveries, device provenance or approved handoff, the matching ledger result,
the exact `live-context-$STAMP.json` claims, fresh local runtime adoption, and fresh Tailnet HTTPS
health/asset adoption. After all promotion HTTP probes, it strictly rescans the complete stdout,
stderr, current, rotated, and rotation-history inventory. That scan is the last application-log
validation before prepared evidence and pointer commit; no later promotion step sends application
HTTP or MCP traffic. A malformed, non-allowlisted, content-bearing, or credential-shaped line from
the promotion probes therefore fails before either `promotion-prepared-$STAMP.json` or
`current-release` changes. Promotion evidence records the exact live-context path and SHA-256 plus
the final `promotionLogs` hashes/counts under phase
`after-promotion-http-probes-before-prepared-evidence`. A final HTTP-free
`launchctl`/`ps`/`lsof` binding check then proves the same PID, cwd identity, effective environment,
and loopback listener immediately before commit without appending another application log line.

Every cutover apply, rollback, lifecycle drill, and promotion context uses the same owner-only
`~/.journal/release-global.lock`; rollback and promotion mutate, while lifecycle validates, the
per-context terminal marker. The global path is one stable, owner-owned, single-link, non-symlink
mode-`0600` inode that is never renamed or unlinked. Each operation opens that inode with no-follow,
proves its descriptor and pathname identities match, and acquires a nonblocking macOS BSD `lockf`
on the inherited descriptor before its protected evidence checks or mutations. The descriptor is
held for the complete operation, so the kernel releases ownership on normal exit or process death.
Cutover and promotion write and fsync schema-2 diagnostic JSON in place; lifecycle deliberately does
not rewrite that metadata. The JSON is diagnostic only: file existence, retained operation metadata,
or PID liveness is never treated as lock authority.

`terminal-$STAMP.lock` is an atomic owner-private schema-2 transaction/state marker with exact
release stamp, state, operation, PID, and timestamp fields. Its state progresses from
`in-progress` to `cutover-complete`, `rollback-complete`, or `promotion-complete`. Only a holder of
the global kernel lock may reconcile an `in-progress` crash residue against prepared/final cutover,
rollback, or promotion evidence; PID-liveness reclamation is forbidden.

Under those locks and only after that final strict log scan, promotion writes and fsyncs the complete
intended evidence to a transaction-owned same-directory candidate, atomically publishes it as
`promotion-prepared-$STAMP.json`, fsyncs the directory, prepares the target symlink, rechecks the
live-context bytes and rollback absence, and performs a compare-and-swap
requiring `current-release` to still be the recorded previous release (or absent for a first
install). It atomically renames the prepared symlink, fsyncs the `current-release` parent directory,
renames the prepared evidence to `promotion-$STAMP.json`, and fsyncs the evidence directory. The
final evidence path therefore never claims success before the pointer is durable.

The transaction is retry-safe after process or host failure. A partial transaction-owned evidence
candidate or orphan prepared symlink is verified and removed before all validation reruns. If
prepared evidence remains with the old pointer, retry removes only that transaction's prepared
link/evidence and reruns every release validation, including deployed-tree and freshness checks. If
the pointer already names the target, retry fsyncs its directory and finalizes the already-fsynced
prepared evidence. A final evidence file plus matching pointer is an idempotent success; any third
pointer value or contradictory prepared/final state fails closed. Completion closes the global
`lockf` descriptor and retains `terminal-$STAMP.lock` in `promotion-complete` state as the rollback
guard.

## Roll back before promotion

If any acceptance step fails after a successful cutover, do not promote. Run:

```zsh
npm run release:cutover -- rollback "$CONTEXT"
```

The rollback is scoped by the context's first-install/upgrade ownership record. It restores the
prior service on upgrade or removes only the newly owned first-install resources, proves the full
normalized Serve configuration equals its original snapshot, and reasserts the exact existing
`:443` proxy. It never rewrites `current-release`, never resets all Tailscale Serve configuration,
and never touches the journal database or unrelated handlers.

Before any rollback mutation, the helper reasserts pointer ownership, rejects existing promotion
evidence, acquires the terminal lock, parses and recomputes the raw before/after Serve evidence, and
checks it against the cutover summary. Upgrade rollback also lints the saved plist, validates the
saved config, and requires the prior Node and CLI executables to remain available. Damaged rollback
evidence therefore stops before bootout, file replacement, or Serve removal.

A successful rollback makes that release stamp and context terminal; promotion rejects its
rollback snapshot/evidence even if the service is later reinstalled by hand. For the required
rehearsal-to-final sequence, confirm the helper reported successful baseline restoration, then run
`release:prepare` again, copy the newly printed context path, stage that new stamp, and apply it as
a clean first install:

```zsh
npm run release:prepare
CONTEXT=$HOME/.journal/release-evidence/release-context-<new-stamp>.json
npm run release:stage -- "$CONTEXT"
npm run release:cutover -- apply "$CONTEXT"
```

The old rehearsal stage may remain immutable for audit, but it must never be reused or promoted.

After promotion, use a new upgrade context whose intended target is the archived previous release;
do not bypass the pointer guard with an old rollback context.

For bounded startup diagnosis only, inspect content-free operational logs:

```zsh
tail -n 100 "$HOME/.journal/logs/launchd.err.log"
tail -n 100 "$HOME/.journal/logs/launchd.out.log"
```
