# SPEC-07 — App API & Sync

Governs the REST/SSE interface between the PWA and server, the IndexedDB
mirror/outbox, and reconciliation. Requirement IDs: `API-*`. Agents use MCP;
REST and MCP converge on the same transactional domain commands (ARC-5).

## 1. Conventions and authentication

- API-1 `/api` uses JSON and canonical shared Zod schemas. Errors are
  `{ error: { code, message, details? } }` with accurate HTTP status: `400`
  invalid input, `401` unauthenticated, `403` Origin/Host rejection, `404`
  unknown row, `409` revision/idempotency/revert conflict, `429` rate limit,
  and `5xx` server failure. Dates are `YYYY-MM-DD`; timestamps are ISO 8601
  with offset.
- API-2 All `/api` routes require a device cookie except `POST /api/pair`.
  `/healthz` is outside `/api` and public. Pairing is allowed only through an
  accepted Host and same-origin request; it sets a random device credential
  whose hash is stored server-side. Cookie attributes: `HttpOnly`,
  `SameSite=Strict`, `Path=/`, one-year expiry, and `Secure` in production
  (omitted only on loopback HTTP development). Unsafe cookie-authenticated
  methods require an exact allowed `Origin`; CORS is disabled. Losing/expiring
  the cookie requires pairing again. MCP bearer tokens never authenticate REST.
- API-3 List/bootstrap payloads include server `today` and `timezone`. Offline
  creation carries an explicit date-intent context:

  ```ts
  type DateIntent = {
    kind: 'today' | 'tomorrow' | 'absolute';
    date?: string; // required only for absolute
    capturedAt: string; // ISO timestamp from the device
    baseToday: string; // last server-issued YYYY-MM-DD
    timezone: string; // last server-issued IANA zone
  };
  ```

  Replay preserves the intended day across midnight; the server validates the
  context and never silently rebases it to receipt time.

- API-4 Every offline-queueable command requires
  `Idempotency-Key: <client ULID>`. The server persists actor device, canonical
  request hash, status, and result atomically with the domain transaction.
  Same key + same request returns the stored response; same key + different
  request returns `409 mutation_id_reused`. The key is exposed as `mutationId`
  in SSE. Pairing/token creation are not idempotency-key or outbox operations.

## 2. REST endpoints

Server-owned fields (`author`, `source`, initial state, migrations, revision,
timestamps, deletion state) never appear in owner creation DTOs.

| Method and path                                                            | Request / response contract                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/pair`                                                           | Cookie-exempt same-origin pairing. `201 { deviceId, expiresAt }`.                                                                                                                                                                                                                                              |
| `GET /api/bootstrap`                                                       | Consistent snapshot: `{ entries, collections, latestSummary, activity, settings, today, timezone, deviceId, cursor }`. Entries = last 14 days + all open tasks + displayed/current monthly log; activity = latest 50. No proposal field.                                                                       |
| `GET /api/entries?from&to&collection&state&type&author&tag&q&limit&cursor` | Stable order `(date DESC, createdAt DESC, id DESC)`; max 100; `{ items, nextCursor, today, timezone }`.                                                                                                                                                                                                        |
| `POST /api/entries`                                                        | Queueable safe `OwnerEntryCreate` below; `201 { entry }` or replayed original status/result.                                                                                                                                                                                                                   |
| `PATCH /api/entries/:id`                                                   | Queueable `{ patch, expectedRevision? }`; nullable `time`/`collection`; final merged row validation; `200 { entry }`.                                                                                                                                                                                          |
| `DELETE /api/entries/:id`                                                  | Queueable soft delete; optional `If-Match: "<revision>"`; `200 { entry }` post-image.                                                                                                                                                                                                                          |
| `POST /api/entries/:id/migrate`                                            | Queueable semantic daily migration `{ newEntryId: <client ULID>, target: "YYYY-MM-DD", expectedRevision? }`; atomically mark original migrated + create that stable-id copy; `200 { original, copy }`.                                                                                                         |
| `POST /api/entries/:id/schedule`                                           | Queueable semantic monthly scheduling `{ copyId: <client ULID>, month: "YYYY-MM", expectedRevision? }`; atomically mark original scheduled + auto-create month collection + create that stable-id monthly copy; `200 { original, copy }`.                                                                      |
| `POST /api/entries/:id/restore`                                            | Online-only owner restore within 30 days, revision guarded; `200 { entry }`.                                                                                                                                                                                                                                   |
| `POST /api/capture`                                                        | Queueable non-UI capture `{ draft, defaultType, dateIntent }`; server runs LOG-6 and files into the parsed `collection`; `201 { entry, parsed }` where `parsed` carries the canonical `ParsedCapture` including `collection`. An unknown slug is `404 not_found` — capture never mints a collection (API-17a). |
| `GET /api/collections`                                                     | `{ items, today, timezone }`.                                                                                                                                                                                                                                                                                  |
| `GET /api/tags`                                                            | Tag vocabulary for capture completion: `{ items: [{ tag, uses, lastUsedAt }] }` over non-deleted entries, ordered `uses DESC, tag ASC`, capped at 300 (server maximum 500).                                                                                                                                    |
| `POST /api/collections`                                                    | Queueable `{ id, name, note? }`; `201 { collection }`.                                                                                                                                                                                                                                                         |
| `PATCH /api/collections/:id`                                               | Queueable rename/note/archive command; `200 { collection }`. Month collections reject archive.                                                                                                                                                                                                                 |
| `GET /api/activity?before&limit`                                           | Newest-first page `{ items, nextCursor }`; every item includes server-derived `revert: { eligible, reason }`.                                                                                                                                                                                                  |
| `POST /api/activity/:id/revert`                                            | Online-only compare-and-swap revert (DM-15); `200 { activity, rows }` or `409 revert_conflict`. It re-checks eligibility even if the preceding read said true.                                                                                                                                                 |
| `GET /api/summary/latest?month=YYYY-MM`                                    | `{ summary }`, where summary is a Summary row or `null`. Without `month`, returns the greatest week globally; with it, returns the greatest `weekStart` in that displayed month.                                                                                                                               |
| `POST /api/summary/latest/save`                                            | Online-only Save-to-today; optional `{ summaryId, expectedRevision }` targets the displayed historical Summary, otherwise the global latest; `200 { summary, entry }`.                                                                                                                                         |
| `POST /api/summary/latest/rewrite`                                         | Online-only mark stale; optional `{ summaryId, expectedRevision }` targets the displayed historical Summary, otherwise the global latest; `200 { summary }`; does not start an agent or scheduler.                                                                                                             |
| `GET /api/settings` / `PATCH /api/settings`                                | Display preferences and MCP connection-status block. Settings changes require online success.                                                                                                                                                                                                                  |
| `GET /api/tokens` / `POST /api/tokens` / `DELETE /api/tokens/:id`          | Online-only MCP token management. Create returns secret once; list never does.                                                                                                                                                                                                                                 |
| `GET /api/events?cursor=`                                                  | Authenticated SSE stream (§3); `Last-Event-ID` is also accepted.                                                                                                                                                                                                                                               |

Activity `nextCursor` values are opaque keyset cursors over `(at, id)` and
must be sent back unchanged as `before`. For compatibility, `before` also
accepts the earlier ISO-timestamp boundary without making older same-timestamp
rows permanently unreachable.

```ts
type OwnerEntryCreate = {
  id: string; // client ULID
  text: string;
  type?: EntryType; // defaults to task
  time?: string | null;
  tags?: string[];
  collection?: string | null;
  dateIntent: DateIntent;
};
```

Capture/parser and semantic migration endpoints are domain commands, not a way
for a client to submit forged full Entry rows. The client-generated
`newEntryId`/`copyId` gives an optimistic copy stable identity before sync and
across a lost-response replay.

- API-17 **[ext]** `GET /api/tags` is an ordinary cookie-authenticated read: no
  Origin requirement, no idempotency key, never queued. `uses` counts
  non-deleted entries carrying the tag and `lastUsedAt` is the newest such
  entry's creation time, so the ranking answers "what do I actually tag things
  with" rather than "what exists". It is a _suggestion_ source, not a
  vocabulary of record: the client seeds completion from its own mirror first
  (so it works offline), refreshes from this endpoint behind a TTL, and merges
  by tag so a tag that only exists in an unsent capture survives the merge
  (LOG-50).
- API-17a A `/slug` in a capture draft addresses an **existing** collection.
  `POST /api/capture` resolves it through the same `ensureCollection` path as
  `POST /api/entries`, which un-archives a known slug and rejects an unknown
  one with `404`; only `POST /api/collections` creates. The app therefore
  mints a collection explicitly before filing into it (LOG-46) rather than
  relying on the capture endpoint. A `month:` id can never arrive this way —
  the parser's collection token forbids `:` — so the monthly-log
  pseudo-collections stay server-owned and are only auto-created by the
  scheduling command.

## 3. Live updates (SSE)

- API-5 Every successful domain transaction emits exactly one post-commit
  `change` batch (never an event before commit):

  ```text
  event: change
  id: <serverEpoch>:<sequence>
  data: {
    "transactionId": "<ULID>",
    "mutationId": "<Idempotency-Key or MCP key or null>",
    "origin": {
      "kind": "app" | "mcp" | "system",
      "deviceId"?: "...", "tokenId"?: "...",
      "tokenLabel"?: "...", "tool"?: "..."
    },
    "changes": [
      { "kind": "entry.created" | "entry.updated" | "entry.deleted"
              | "activity.appended" | "summary.changed"
              | "collection.changed" | "settings.changed"
              | "token.changed", "payload": <changed row> }
    ]
  }
  ```

  Change order is the domain transaction's deterministic row order. The app
  applies a complete batch before rendering.

- API-6 Cursors are opaque epoch-qualified values. The server retains the last
  1,000 batches for replay. Epoch mismatch, eviction, or an unknown cursor
  returns `event: reset` with a reason/current cursor. Restart creates a new
  epoch. Bootstrap rows and cursor are taken at one mutation-sequencer boundary;
  connecting with that cursor replays every later commit and closes the
  snapshot-to-stream gap. Each batch is serialized once; per-connection output
  buffering is bounded, and a client that applies backpressure is disconnected
  to resume through replay or reset instead of delaying mutations. Comment
  heartbeats do not advance the cursor. After every replay sequence (including
  a `reset` response), the server emits exactly one explicit boundary frame:

  ```text
  event: replay-ready
  id: <serverEpoch>:<sequence>
  data: { "cursor": "<same serverEpoch:sequence>" }
  ```

  Its cursor is captured at the replay boundary. All replay/reset frames precede
  it; commits racing the replay-to-live handoff are buffered within the same
  per-client cap and delivered after it in cursor order.

- API-7 `deviceId` + `mutationId` suppress only the originating client's echo
  toast; a second PWA device still applies and surfaces the owner change. MCP
  origin drives coalesced assistant toasts and Activity attribution.

## 4. Client store and IndexedDB

- API-8 The PWA uses a normalized Zustand store (entries by id plus
  date/collection indexes, activity, summaries by month, collections, settings) backed by
  one versioned IndexedDB database. Journal data, current draft, last cursor,
  optimistic command log, and outbox are persisted there; localStorage is not
  used. The service-worker HTTP cache is only a fallback, never the journal
  mirror.
- API-9 The mirror retains all loaded history. Bootstrap provides the working
  set; older days use the paged entry endpoint and then remain offline. Draft
  changes are persisted promptly enough to survive iOS process eviction.

## 5. Outbox and reconciliation

- API-10 Only deterministic entry/capture/migration/scheduling and collection
  commands enter the outbox. One IndexedDB transaction persists the optimistic
  state, semantic command, `Idempotency-Key`, date context, and enqueue time.
  FIFO flush uses exponential backoff from 1 to 60 seconds. Token, pairing,
  summary, settings, restore, and revert actions are online-only.
- API-11 The server serializes commits by receipt order. Optional revision
  preconditions turn stale intent into `409`; without one, the last committed
  owner command wins. Automatic MCP mutations arrive through the same domain
  layer and SSE batches. Two devices converge by applying server rows/batches,
  never by merging client-authored full entities.
- API-12 Response handling:
  - network, `429`, and `5xx`: keep queued and retry with backoff;
  - `401`: pause, prompt re-pair, and retain the outbox;
  - same-key replay: success using the stored result;
  - genuine `400`/`404`/`409`: move to dead letter, show a specific toast,
    re-bootstrap the affected scope, then reapply remaining semantic optimistic
    commands in order.

  The client never rolls back by applying a stale inverse over later changes.

- API-13 One reconnect algorithm serves cold start, `online`, and iOS resume:
  load the mirror/draft; pair if required; bootstrap if there is no valid
  cursor; establish SSE and await the validated `replay-ready` marker for that
  exact connection generation; only then flush the FIFO outbox while SSE is
  listening. A timer or quiet network window cannot substitute for the marker.
  On `reset`, that stream generation is terminal: its following boundary marker
  cannot unblock the outbox. The client closes it, bootstrap/refetches and
  reapplies remaining optimistic commands, then waits for the replacement
  stream's `replay-ready`; permanent failure also retains the outbox. Finally it
  recomputes server-context today. Every phase is idempotent and cancelable if a
  newer reconnect begins.

## 6. Verification requirements

- API-14 Domain/contract tests cover legal type/state combinations, canonical
  tags, provenance, migration and monthly-copy atomicity under injected
  failure, soft delete/restore/purge, Summary uniqueness and stale replacement,
  activity pre/post images, revert success/conflict, FTS behavior, import/export
  round-trip, backup restore, and mutation-id equal/mismatched replay.
- API-15 Parser goldens cover `. Reply to Mira #work @4pm >tomorrow`,
  `o Design review @11`, `12am`/`12pm`, signifier override, no signifier,
  tag case/de-duplication, and rejection of `#foo_bar`. The collection token
  (LOG-6 step 2) adds: a slug alongside every other token, first-token-wins
  with later ones left as text, slug lowercasing, the `//` escape and an
  escape followed by a real token, `#work/x` staying a tag plus literal text,
  the inert set (`https://a.com/b`, `/usr/bin`, `/a_b`, `/v1.2`, `a/b`,
  `/month:2026-07`, an 81-character slug), a token-only draft, `/errands>tomorrow`
  versus `@9/errands`, and an invalid tag still rejected after a slug is
  consumed. Client/server parser results must be byte-equivalent canonical
  DTOs.
- API-16 End-to-end and security tests cover pairing/cookie/Host/Origin,
  unauthorized REST/SSE, lost-response replay, dependent outbox recovery,
  atomic IndexedDB state+outbox, offline capture across midnight, two-device
  convergence, 1,001-event reset, server-restart epoch reset, bootstrap/SSE
  gap, multi-row batches, and the complete flow:

  `capture → MCP add_entry → SSE → automatic update_entry → Activity → revert`.

  The flow runs against the real server and a temporary SQLite database; no
  proposal approval step or scheduled AI process exists.
