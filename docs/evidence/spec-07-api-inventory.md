# SPEC-07 API endpoint inventory

Generated and verified on 2026-08-01 from the frozen server sources listed in
[Source lock](#source-lock). This is a release-evidence artifact, not a live-service probe.

## Coverage verdict

| Check                                                          | Result |
| -------------------------------------------------------------- | ------ |
| SPEC-07 documented `/api` method/path pairs                    | 25     |
| `createApiRouter` registered method/path pairs                 | 25     |
| Exact matches after adding `/api` and removing query notation  | 25     |
| Missing documented pairs                                       | 0      |
| Undocumented registered pairs                                  | 0      |
| Success-status mismatches                                      | 0      |
| Routes without an explicit authentication classification below | 0      |
| Queueable routes without an idempotency-header requirement     | 0 of 8 |
| Online-only routes that call the REST mutation replay layer    | 0 of 7 |

The 25 rows are intentionally not collapsed. In particular, each method in the combined
settings and token rows in SPEC-07 appears separately. Row 25 (`GET /api/tags`) is the
capture-completion vocabulary that ships with the composer's inline autocomplete; it is kept in
router-registration order rather than renumbered, so every earlier row keeps the number it was
first published under.

## Conventions

Every request first passes the global Host allowlist. `/api` responses set `Cache-Control:
no-store`. `POST` and `PATCH` requests require `Content-Type: application/json`; the JSON body
limit is 1 MiB. CORS is not enabled.

Authentication and execution codes used below:

- **Pair**: no device cookie; an exact same-origin `Origin` and an allowed Host are required.
- **Read**: valid `journal_device` cookie; no Origin requirement.
- **Queue**: valid device cookie plus exact same-origin `Origin`; a valid `Idempotency-Key` is
  required. The runtime also accepts the documented compatibility alias `X-Mutation-ID`.
- **Online**: valid device cookie plus exact same-origin `Origin`; never enters the outbox or
  mutation-replay layer.

The response column names the canonical schema in `server/src/contracts/api.ts`. Entity fields
inside those envelopes are themselves parsed by the domain's canonical entity schemas. The HTTP
adapter does not call the outer response schema's `.parse()` before serialization; this boundary
fact is recorded here so contract enforcement cannot be inferred where it does not exist.

## Complete REST and SSE matrix

| #   | Method and path                    | Auth / mode | Canonical request                                                                                                                 | Success response                                                                                                                  | Status |
| --- | ---------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -----: |
| 1   | `POST /api/pair`                   | Pair        | `PairRequestSchema`: `{ label?: string }`; `{}` by default                                                                        | `PairResponseSchema`: `{ deviceId, expiresAt }`; sets the one-year `journal_device` HttpOnly, Strict, path `/` cookie             |    201 |
| 2   | `GET /api/bootstrap`               | Read        | No body or query                                                                                                                  | `BootstrapResponseSchema`: `{ entries, collections, latestSummary, activity, settings, today, timezone, deviceId, cursor }`       |    200 |
| 3   | `GET /api/entries`                 | Read        | `EntryQuerySchema`: optional `from,to,collection,state,type,author,tag,q,limit,cursor`; `limit` defaults to 100, maximum 100      | `EntryListResponseSchema`: `{ items, nextCursor, today, timezone }`                                                               |    200 |
| 4   | `POST /api/entries`                | Queue       | `CreateEntryRequestSchema`: `{ id, text, type?, time?, tags?, collection?, dateIntent }`; defaults are task/null/[]/null          | `EntryResponseSchema`: `{ entry }`                                                                                                |    201 |
| 5   | `PATCH /api/entries/:id`           | Queue       | ULID path plus `UpdateEntryRequestSchema`: `{ patch, expectedRevision? }`; patch is non-empty                                     | `EntryResponseSchema`: `{ entry }`                                                                                                |    200 |
| 6   | `DELETE /api/entries/:id`          | Queue       | ULID path plus optional `If-Match` positive revision; no body                                                                     | `EntryResponseSchema`: `{ entry }`, the soft-deleted post-image                                                                   |    200 |
| 7   | `POST /api/entries/:id/migrate`    | Queue       | ULID path plus `MigrateEntryRequestSchema`: `{ newEntryId, target, expectedRevision? }`                                           | `MigratedEntryResponseSchema`: `{ original, copy }`                                                                               |    200 |
| 8   | `POST /api/entries/:id/schedule`   | Queue       | ULID path plus `ScheduleMonthlyRequestSchema`: `{ copyId, month, expectedRevision? }`                                             | `ScheduledEntryResponseSchema`: `{ original, copy, collection? }`; the adapter currently returns the two required entry fields    |    200 |
| 9   | `POST /api/entries/:id/restore`    | Online      | ULID path plus `RestoreEntryRequestSchema`: `{ expectedRevision? }`; optional `If-Match` is used when the body omits the revision | `EntryResponseSchema`: `{ entry }`                                                                                                |    200 |
| 10  | `POST /api/capture`                | Queue       | `CaptureRequestSchema`: `{ draft, defaultType?, dateIntent }`; `defaultType` defaults to `task`                                   | `CaptureResponseSchema`: `{ entry, parsed }`; `parsed` is the canonical `ParsedCapture`, including its nullable `collection` slug |    201 |
| 11  | `GET /api/collections`             | Read        | No body or query                                                                                                                  | `CollectionListResponseSchema`: `{ items, today, timezone }`                                                                      |    200 |
| 25  | `GET /api/tags`                    | Read        | No body or query; the adapter calls `listTags()` with its default limit of 300 (domain maximum 500)                               | `TagListResponseSchema`: `{ items: [{ tag, uses, lastUsedAt }] }`, ordered `uses DESC, tag ASC` over non-deleted entries          |    200 |
| 12  | `POST /api/collections`            | Queue       | `CreateCollectionRequestSchema`: `{ id, name, note? }`; `note` defaults to `null`                                                 | `CollectionResponseSchema`: `{ collection }`                                                                                      |    201 |
| 13  | `PATCH /api/collections/:id`       | Queue       | collection-id path plus non-empty `UpdateCollectionRequestSchema`: `{ name?, note?, archived? }`                                  | `CollectionResponseSchema`: `{ collection }`                                                                                      |    200 |
| 14  | `GET /api/activity`                | Read        | `ActivityQuerySchema`: optional opaque/legacy-ISO `before` and `limit`; `limit` defaults to 50, maximum 100                       | `ActivityListResponseSchema`: `{ items, nextCursor }`                                                                             |    200 |
| 15  | `POST /api/activity/:id/revert`    | Online      | ULID path plus `RevertActivityRequestSchema`: `{ expectedActivityId? }`; `{}` by default                                          | `RevertActivityResponseSchema`: `{ activity, rows }`                                                                              |    200 |
| 16  | `GET /api/summary/latest`          | Read        | Optional `month=YYYY-MM`, parsed by `CalendarMonthSchema`                                                                         | `LatestSummaryResponseSchema`: `{ summary }`, where `summary` may be `null`                                                       |    200 |
| 17  | `POST /api/summary/latest/save`    | Online      | `SummarySaveRequestSchema`: `{ summaryId?, expectedRevision? }`; `{}` by default                                                  | `SaveSummaryResponseSchema`: `{ summary, entry }`                                                                                 |    200 |
| 18  | `POST /api/summary/latest/rewrite` | Online      | `SummaryRewriteRequestSchema`: `{ summaryId?, expectedRevision? }`; `{}` by default                                               | `RewriteSummaryResponseSchema`: `{ summary }`                                                                                     |    200 |
| 19  | `GET /api/settings`                | Read        | No body or query                                                                                                                  | `SettingsResponseSchema`: `{ settings, assistant: { endpoint, status, activeSessions } }`                                         |    200 |
| 20  | `PATCH /api/settings`              | Online      | non-empty `SettingsPatchSchema`: `{ density?, showTypeBadges?, highlightAiEntries? }`                                             | `SettingsResponseSchema`: `{ settings, assistant: { endpoint, status, activeSessions } }`                                         |    200 |
| 21  | `GET /api/tokens`                  | Read        | No body or query                                                                                                                  | `TokenListResponseSchema`: `{ tokens }`; token secrets are absent                                                                 |    200 |
| 22  | `POST /api/tokens`                 | Online      | `TokenCreateRequestSchema`: `{ label }`                                                                                           | `TokenCreateResponseSchema`: `{ token, secret }`; secret is returned once                                                         |    201 |
| 23  | `DELETE /api/tokens/:id`           | Online      | ULID path; no body                                                                                                                | `TokenRevokeResponseSchema`: `{ revoked: true, id }`                                                                              |    200 |
| 24  | `GET /api/events`                  | Read        | Optional opaque `cursor` query; `Last-Event-ID` is the fallback when the query is absent                                          | `text/event-stream`: `change`/`reset`/`replay-ready` carry their canonical schemas; comment heartbeats carry no cursor            |    200 |

All Queue routes call `mutation()`. This validates the request header before the operation and
passes the intended stored status (`201` for entry/collection/capture creation, otherwise `200`)
into the atomic domain transaction. A same-key/same-canonical-request replay therefore returns the
same endpoint envelope and status; a different canonical request returns `409
mutation_id_reused`.

## Shared error/status behavior

REST failures use `ApiErrorSchema`: `{ error: { code, message, details? } }`.

| Status | Runtime source and meaning                                                                        |
| -----: | ------------------------------------------------------------------------------------------------- |
|    400 | Zod/query/header validation, malformed/aborted/size-invalid JSON, or a domain validation error    |
|    401 | missing, invalid, or expired device cookie                                                        |
|    403 | Host rejection on every route, or missing/mismatched Origin on Pair/Queue/Online routes           |
|    404 | unknown route/row, or restore unavailable                                                         |
|    409 | revision/idempotency/revert conflict; `IDEMPOTENCY_KEY_REUSED` is exposed as `mutation_id_reused` |
|    413 | JSON request exceeds 1 MiB                                                                        |
|    415 | missing/wrong JSON media type for `POST`/`PATCH`, or unsupported request encoding                 |
|    429 | `RATE_LIMITED` mapping, when raised; no REST adapter invokes the MCP write limiter                |
|    500 | domain `INTEGRITY_ERROR`, or unclassified failure with content-free `internal_error`              |

`GET /api/events` performs cookie authentication before sending stream headers. Once accepted it
stays HTTP 200: an invalid, evicted, future, or wrong-epoch cursor is represented by an SSE `reset`
event, not an HTTP error. The last 1,000 change batches are retained, a slow client is disconnected
instead of blocking writers, and the cursor is captured before bootstrap reads so later commits can
be replayed. The runtime then emits one `replay-ready` event carrying `SseReplayReadySchema` after
the bounded replay and before buffered live events. API-6 specifies that exact ordering and API-13
uses the validated marker for the exact connection generation as the deterministic
replay-completion barrier before outbox flushing. A stream that emitted `reset` is terminal: its
following marker cannot unblock the outbox; the replacement stream's marker must do so.

## Adjacent non-REST boundaries

- `GET /healthz` is outside `/api`, needs no device cookie, returns status 200 with `status: "ok"`,
  the version, `db: "ok"`, and uptime, and still passes the global Host allowlist. "Public" in
  API-2 means cookie-public, not Host-unrestricted.
- `POST/GET/DELETE /mcp` is mounted through `app.all('/mcp', ...)` for the official stateful
  Streamable HTTP transport. Every request requires the global Host allowlist and a bearer token;
  any browser `Origin` is rejected. Initialization assigns `Mcp-Session-Id`, subsequent requests
  require the same token/session pairing, and DELETE tears it down.
- MCP uses JSON-RPC envelopes, not `ApiErrorSchema`. Transport errors include HTTP 400 (session),
  401 (bearer), 403 (Origin), 404 (session/path), 413/415 (body), 500, and 503 (shutdown).
- Exactly seven MCP tools are registered: automatic writes `add_entry`, `add_to_collection`,
  `update_entry`, `delete_entry`, and `propose_migration`; read-only `list_day` and `search`.
  `propose_migration` is an immediate atomic write despite its compatibility name. All tool inputs
  and outputs use `server/src/contracts/mcp.ts`; all five writes accept an optional MCP
  `idempotencyKey` and pass through the same transactional domain layer as REST.
- Six read-only resources are registered: `journal://today`, `journal://day/{date}`,
  `journal://index`, `journal://collection/{id}`, `journal://proposals`, and
  `journal://summary/latest`. The proposals resource is fixed compatibility metadata
  `{ mode: "automatic", proposals: [] }`; there is no proposal queue or approval endpoint.

## Explicit gap register

| Candidate gap                                        | Disposition                                                                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing or extra `/api` route                        | None: normalized SPEC and router sets are identical, 25/25                                                                                                                                                          |
| Auth or queue/online mismatch                        | None found: 8 Queue, 7 Online, 9 Read, 1 Pair                                                                                                                                                                       |
| Success-status mismatch                              | None found: five `201` routes and twenty `200` routes                                                                                                                                                               |
| Capture minting a collection implicitly              | None: `POST /api/capture` resolves a parsed `/slug` through `ensureCollection`, which un-archives a known id and raises `NOT_FOUND` → `404` for an unknown one. `month:` ids are unreachable from the token grammar |
| Error statuses not enumerated in API-1               | Runtime additionally and deliberately exposes `413` and `415`; both retain the canonical REST envelope                                                                                                              |
| Legacy mutation header beyond the preferred contract | `X-Mutation-ID` remains accepted as a compatibility alias; `Idempotency-Key` is the canonical header                                                                                                                |
| Runtime validation of outer success envelopes        | The schemas exist and contract/integration tests exercise the shapes, but route serialization does not invoke outer response `.parse()`                                                                             |
| SSE batch validation at the HTTP boundary            | `ChangeBatchSchema`/`SseResetSchema` are canonical client contracts; the SSE hub serializes trusted post-commit domain events directly                                                                              |
| SSE replay-completion barrier                        | None: `replay-ready` is specified in API-6/API-13, implemented by the hub, and declared as `SseReplayReadySchema`                                                                                                   |
| Undocumented proposal/review endpoint or MCP tool    | None                                                                                                                                                                                                                |

## Verification method

The route set was extracted with the TypeScript compiler API from call expressions on `router`
and `app`, rather than by a line-oriented regular expression. The AST scan found the 25 router
registrations above plus only the adjacent `GET /healthz`, `ALL /mcp`, and SPA `GET *path` mounts in
`server/src/index.ts`. The SPEC set was extracted from every backticked method/path pair in SPEC-07
section 2, expanded where one table row names multiple methods, normalized by removing query
notation, and compared as a set.

Contract symbols were then traced through `routes.ts` into `contracts/api.ts`,
`contracts/commands.ts`, `adapters.ts`, `security.ts`, `errors.ts`, `sse.ts`, and — for the
capture row's parsed `collection` and the tag vocabulary — `domain/parser.ts`. MCP transport,
tool, and resource notes were traced through `index.ts`, `mcp/server.ts`, and `contracts/mcp.ts`.

Validation used the pinned Node 22.19.0 toolchain. The artifact passed Prettier and
`git diff --check`; the server TypeScript check passed; and the focused canonical-contract and SSE
unit run passed 2 files / 18 tests. The final AST comparison reported:

```text
API inventory verified: SPEC=25, router=25, artifact=25, missing=0, extra=0, replay-ready=contracted
```

## Source lock

Any changed digest invalidates this static evidence and requires regeneration.

```text
eff1cd4724c73f44f3527c1de8a8a9adc4d5f9ba44a3b2180f35561dbc3cc8d4  docs/specs/SPEC-07-sync-api.md
1d81cfb467ccb4e0da298708589d999bcf6b51f646424db3edc68a2a3befc989  docs/specs/SPEC-06-mcp-server.md
5811a394e7d3a7c6d8a710f44e8896bdaa812b87183595fb13c1801ae0dbf742  server/src/index.ts
882bce127152ddd10072e07aad700f985e5bfb8cda64852b00e5bf7868303b8e  server/src/api/routes.ts
8f2fc9a590fce2497c71c8e625eeded6790c51ae75fa3b47eda1350301ec95b1  server/src/api/security.ts
ab22cccb6a76295ca60956e42e44fa56a752a1121c7d3be03101b2190b8b13ce  server/src/api/errors.ts
fe6096c95ff4e3455cfd92379be5d56902448601ccc06fe30b432b1cb572adea  server/src/api/sse.ts
f0d0261d181f2e05c0b92baa8c7ef9833eeffe97cafb0bc1e57f0ae58f75f32f  server/src/contracts/api.ts
5383f830d4d38ad226c5726f2ea5322f63c882479fbf62d92067b1ee67aa1fef  server/src/contracts/commands.ts
95aeab7b0b35554c5000df316cefa6964dcf95f2f130c275c93957cb38f5add7  server/src/domain/parser.ts
cdddec2ee5814fe82988bb23e25e73fcbfd5fb36bb68370a2869a2af35179850  server/src/adapters.ts
05b13ab1ca37bf2fe1026d2ed391f38ec9da68e59e49b6aa49bf22489aa7dd2d  server/src/mcp/server.ts
00f10b8477f308326a56e320616165bf22ed12c27c018ddd1819d198e3f9ff9a  server/src/contracts/mcp.ts
```
