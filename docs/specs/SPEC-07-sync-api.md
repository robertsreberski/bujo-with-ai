# SPEC-07 — App API & Sync

Governs: the REST + SSE interface between the PWA and the server, the
offline outbox, and reconciliation. Requirement IDs: `API-*`. Agents never
use this API (they use MCP, SPEC-06); both funnel into the same domain layer
(ARC-5).

## 1. Conventions

- API-1 Base path `/api`; JSON bodies; Zod-validated; errors as
  `{ error: { code, message } }` with proper status codes (400 validation,
  404 unknown id, 409 conflict, 401 unauthenticated where applicable).
- API-2 Authentication: the tailnet is the perimeter for the app UI (NFR-3,
  PRD open question 2 resolved: the *app* rides on network trust; *MCP*
  always requires tokens). `/api` additionally requires a device cookie
  issued on first visit (`POST /api/pair` sets it; no password in v1 —
  it exists so a future PIN can slot in without API changes) — except
  `/healthz`, which is open.
- API-3 All timestamps ISO 8601 with offset; all dates `YYYY-MM-DD`;
  "today" is always computed server-side (ARC-16) and returned in list
  responses so clients can detect rollover.
- API-4 Mutations are idempotent by client-generated ULID (DM-11): retrying
  a `POST /api/entries` with an id the server already has returns `200` with
  the existing row instead of duplicating.

## 2. Endpoints

| Method & path | Purpose |
|---|---|
| `GET /api/bootstrap` | One-shot app load: settings, collections, pending proposals, latest summary, activity (last 50), entries for the last 14 days + all open tasks + current month's monthly log, `today`, and the current SSE cursor. |
| `GET /api/entries?from&to&collection&state&type&author&tag&q&limit` | Entry queries (search shares this). |
| `POST /api/entries` | Create (capture, migration copies). Body = full entry with client ULID. |
| `PATCH /api/entries/:id` | Owner edit / state change (toggle, drop, move, file). |
| `DELETE /api/entries/:id` | Owner soft-delete. |
| `POST /api/capture` | Raw-text capture: `{ draft, defaultType }` → runs the LOG-6 parser server-side → created entry. Used by non-UI surfaces (Shortcuts, CLI); the PWA parses client-side for live chips but submits the parsed entry via `POST /api/entries`. |
| `GET /api/collections` / `POST /api/collections` / `PATCH /api/collections/:id` | List / create / rename-archive. |
| `GET /api/proposals?status=` | Review queue. |
| `POST /api/proposals/:id/approve` · `POST /api/proposals/:id/dismiss` | Resolve (DM-13). 409 if already resolved. |
| `GET /api/activity?before&limit` | Activity feed, newest-first, paged. |
| `POST /api/activity/:id/revert` | P1 — apply stored pre-images (DM-15). |
| `GET /api/summary/latest` · `POST /api/summary/latest/save` · `POST /api/summary/latest/rewrite` | Weekly summary read / Save-to-today / mark-stale (DM-17). |
| `GET /api/settings` / `PATCH /api/settings` | Display prefs (LOG-17), MCP status block for the settings dialog. |
| `GET /api/tokens` / `POST /api/tokens` / `DELETE /api/tokens/:id` | Agent token management (MCP-8). Create returns the secret once. |
| `GET /api/events?cursor=` | SSE stream (§3). |

## 3. Live updates (SSE)

- API-5 `GET /api/events` is a server-sent-events stream. Every domain
  mutation (any writer: PWA, MCP tool, proposal approval, sweep jobs)
  broadcasts one event:

  ```
  event: change
  id: <monotonic cursor>
  data: { "kind": "entry.created" | "entry.updated" | "entry.deleted"
                | "proposal.created" | "proposal.resolved"
                | "activity.appended" | "summary.changed" | "collection.changed",
          "payload": <the changed row>, "origin": "app" | "mcp:<tokenLabel>" | "system" }
  ```

- API-6 Events are journaled in a ring buffer (last 1000, with cursor ids)
  so a reconnecting client sends `?cursor=<last-seen>` (or
  `Last-Event-ID`) and replays what it missed. A cursor older than the
  buffer returns `event: reset`, telling the client to refetch via
  `/api/bootstrap` — this is the iOS-resume path (PWA-25).
- API-7 `origin` lets the UI toast agent-driven changes (LOG-39) and skip
  echo-toasting the client's own writes.

## 4. Client store & offline mirror

- API-8 The PWA keeps a normalized store (entries by id, indexes by
  date/collection; proposals; activity; settings) hydrated from
  `/api/bootstrap`, updated by SSE, persisted to IndexedDB (`idb-keyval`
  snapshot per store slice, debounced) for offline reads and instant cold
  starts. localStorage is not used for journal data (the prototype's
  localStorage persistence was a demo shortcut).
- API-9 History depth offline: the mirror retains everything ever loaded;
  bootstrap's 14-day + open-tasks + current-month window means a fresh
  device is fully usable offline for the BuJo working set, and older days
  lazy-load (and then persist) when scrolled to.

## 5. Outbox & reconciliation

- API-10 Every mutation is written to the local store optimistically **and**
  appended to a durable outbox (IndexedDB) as the HTTP request descriptor
  (`method, path, body, ulid, enqueuedAt`). A flusher sends the outbox
  strictly in order; on success, entries clear; on network failure it backs
  off (1s → 2s → … max 60s) and retries on `online`, resume (PWA-23), and
  SSE reconnect.
- API-11 Conflict policy: last-write-wins by server receipt order, which is
  safe here because there is exactly one human writer and agent writes are
  either inserts (new ULIDs — conflict-free) or proposals (applied only
  through Review). The one real race — owner edits an entry that has a
  pending proposal, then approves — resolves per DM-13: ops re-validate at
  approve time and the proposal fails visibly rather than clobbering.
- API-12 4xx outbox responses (validation, 404 on a since-deleted entry) are
  not retried: the item moves to a dead-letter list, the optimistic change
  rolls back from the store, and a toast reports it ("Couldn't sync 1
  change — entry was deleted"). Silent drop is forbidden.
- API-13 Reconnect sequence (single code path for cold start, `online`, and
  iOS resume): flush outbox → SSE connect with cursor → on `reset`,
  re-bootstrap → recompute `today`. Each step idempotent.

## 6. Testing requirements

- API-14 Domain-layer tests cover: provenance invariant (DM-2), migration
  copy semantics (DM-6), proposal atomicity incl. mid-flight entry deletion
  (DM-13), signature-based summary filing (MCP-19), idempotent ULID replay
  (API-4).
- API-15 Parser golden tests: the LOG-6 grammar table, including
  `. Reply to Mira #work @4pm >tomorrow`, `o Design review @11`,
  `12am`/`12pm` conversion, signifier-overrides-menu, and no-signifier
  drafts.
- API-16 An end-to-end test drives capture → agent `add_entry` → SSE
  delivery → `update_entry` proposal → approve → activity pre-image revert,
  against a real server + SQLite in a temp dir.
