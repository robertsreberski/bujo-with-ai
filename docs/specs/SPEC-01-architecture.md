# SPEC-01 — System Architecture

Governs: process topology, technology stack, networking (Tailscale), service
lifecycle, configuration, and backups. Requirement IDs: `ARC-*`.

## 1. Topology

One process, three surfaces, one database:

```
┌─────────────────────────── owner's machine (tailnet node) ───────────────────────────┐
│                                                                                      │
│   journald (Node 22, TypeScript, Express)                                            │
│   ├── /            static PWA assets (built by Vite)                                 │
│   ├── /api/*       REST + SSE for the PWA          (SPEC-07)                         │
│   ├── /mcp         MCP streamable-HTTP endpoint    (SPEC-06)                         │
│   └── /healthz     liveness + version                                                │
│                                 │                                                    │
│                                 ▼                                                    │
│                        SQLite (WAL) — journal.db   (SPEC-02)                         │
│                                                                                      │
│   tailscale serve  →  https://<host>.<tailnet>.ts.net  →  127.0.0.1:5178             │
└──────────────────────────────────────────────────────────────────────────────────────┘
        ▲                                   ▲                                ▲
        │ HTTPS (tailnet)                   │ HTTPS (tailnet)                │ HTTP (loopback)
   iPhone PWA                        Claude Code / Desktop             local dev / curl
   (installed)                       via MCP bearer token
```

- ARC-1 A single server process (`journald`) serves the PWA, the app API, and
  the MCP endpoint on **one origin**. Rationale: one origin removes CORS
  complexity, gives the service worker a single scope, and matches the design's
  settings dialog which shows one MCP URL on the same host.
- ARC-2 The server binds to `127.0.0.1:5178` only. Tailnet exposure happens
  exclusively through `tailscale serve` (reverse proxy with tailnet TLS). The
  server itself never listens on `0.0.0.0`.
- ARC-3 The SQLite database is the sole source of truth. Clients (PWA
  IndexedDB mirror) are caches; agents hold no state.

## 2. Technology stack (decisions, not options)

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript strict | One language across server, MCP, and PWA. |
| HTTP server | Express 5 | The official MCP TS SDK documents `StreamableHTTPServerTransport` against Express; boring and sufficient. |
| MCP | `@modelcontextprotocol/sdk` (official TS SDK), streamable HTTP transport | Best spec coverage; first to receive protocol updates. |
| Validation | Zod | Shared schemas between REST API and MCP tool inputs. |
| Database | SQLite via `better-sqlite3`, WAL mode | Synchronous, fast, zero-ops, single-file portability. No ORM; a thin typed DAO layer. |
| Frontend | React 18 + Vite + TypeScript | Matches the prototype's React-style component logic (`DCLogic` maps ~1:1 to a React component). |
| Frontend state | Zustand store + SSE subscription | Small surface; optimistic updates with server reconciliation (SPEC-07). |
| Styling | CSS custom properties (design tokens, SPEC-04) + CSS Modules | The prototype is inline-styles; tokens-first CSS keeps it faithful without a framework dependency. |
| Service worker | Workbox 7 | Precache manifest from Vite plugin; custom fetch strategies per SPEC-05. |
| IDs | ULID | Sortable, client-generatable offline (SPEC-02 §4). |

- ARC-4 The prototype's `support.js` (dc-runtime) is **not** part of the
  product. It is the design tool's template runtime; `Bullet Journal
  v2.dc.html` is read as a high-fidelity spec (template → JSX, `renderVals()`
  → view-model functions, `state` → store).

## 3. Repository layout

```
bujo-with-ai/
├── docs/                  # this spec set
├── server/
│   ├── src/
│   │   ├── index.ts       # bootstrap: config, db, express, mcp, sse
│   │   ├── db/            # migrations/, dao.ts (typed queries)
│   │   ├── domain/        # entries.ts, proposals.ts, activity.ts, parser.ts
│   │   ├── api/           # REST routes + SSE hub (SPEC-07)
│   │   └── mcp/           # server.ts, tools/, resources/ (SPEC-06)
│   └── test/
├── app/                   # PWA (Vite root)
│   ├── src/
│   │   ├── views/         # today, month, index, collection, review
│   │   ├── components/    # entry-row, composer, dialogs, toast…
│   │   ├── store/         # zustand store, outbox, sse client
│   │   └── styles/        # tokens.css, base.css
│   └── public/            # manifest, icons
└── package.json           # npm workspaces: server, app
```

- ARC-5 `server/src/domain/` is the only layer that mutates the database.
  REST routes and MCP tools both call the same domain functions, so app and
  agent writes share one code path (validation, activity logging, SSE
  broadcast).

## 4. Networking & Tailscale

- ARC-6 Canonical URLs:
  - App: `https://<host>.<tailnet>.ts.net/`
  - MCP: `https://<host>.<tailnet>.ts.net/mcp`
  - Local dev: `http://localhost:5178/` (+ `/mcp`)
- ARC-7 Tailnet exposure via `tailscale serve --bg --https=443 127.0.0.1:5178`
  (persisted config). Tailscale terminates TLS with tailnet certs; no
  self-managed certificates. HTTPS is required for service-worker installation
  on non-localhost origins (SPEC-05).
- ARC-8 The server validates the `Host` header against an allowlist
  (`localhost:5178`, the configured `*.ts.net` name) as DNS-rebinding
  protection for both `/api` and `/mcp`.
- ARC-9 When fronted by `tailscale serve`, requests carry Tailscale identity
  headers (`Tailscale-User-Login`). The server logs them into the activity
  trail for MCP sessions but does **not** use them as authentication —
  bearer tokens remain mandatory for `/mcp` (SPEC-06 §3). Rationale: tokens
  are revocable per-agent and survive a move off Tailscale Serve.
- ARC-10 Recommended tailnet ACL posture (documented, not enforced by the
  app): restrict port 443 on this node to the owner's devices and the tagged
  agent machines.

## 5. Service lifecycle

- ARC-11 macOS: a `launchd` user agent (`com.rsreberski.journald.plist`) with
  `KeepAlive: true` starts the server at login and restarts on crash.
  `npm run install-service` generates and loads it.
- ARC-12 Graceful shutdown on SIGTERM: stop accepting connections, close SSE
  streams, checkpoint WAL, exit ≤5s.
- ARC-13 Crash recovery: on boot the server runs pending migrations, then an
  integrity pass (`PRAGMA integrity_check` quick mode) and expires stale
  proposals (SPEC-03 §7).
- ARC-14 `/healthz` returns `{ status, version, db: "ok", uptime }`; the PWA
  settings dialog uses it (plus MCP session state) for the Connected badge.

## 6. Configuration

- ARC-15 Config file `~/.journal/config.json` overridden by env vars:

  | Key | Env | Default |
  |---|---|---|
  | `port` | `JOURNAL_PORT` | `5178` |
  | `dataDir` | `JOURNAL_DATA_DIR` | `~/.journal` |
  | `hostAllowlist` | `JOURNAL_HOSTS` | `["localhost:5178"]` + configured ts.net name |
  | `timezone` | `JOURNAL_TZ` | system timezone |
  | `dayBoundaryOffsetMin` | — | `0` (see PRD open question 1) |

- ARC-16 "Today" is computed server-side in the configured timezone; clients
  never decide the date for server-persisted operations (they may render
  optimistically). This keeps phone/laptop/agent views consistent.

## 7. Backups & data safety

- ARC-17 SQLite runs in WAL mode with `synchronous=NORMAL`.
- ARC-18 Daily backup at 03:30 local via SQLite Online Backup API to
  `<dataDir>/backups/journal-YYYY-MM-DD.db`; retain 7 daily + 4 weekly;
  a backup also runs before every schema migration.
- ARC-19 `journald export` CLI dumps the full journal as JSON (schema in
  SPEC-02 §8) for portability; a Markdown export (one file per day) is P2.

## 8. Observability

- ARC-20 Structured logs (pino) to stderr + rotating file in `<dataDir>/logs`;
  request logs exclude entry text (privacy) — they log ids and operation
  names only. MCP tool invocations log tool name, token label, duration, and
  outcome.
- ARC-21 No telemetry, no crash reporting to third parties. Ever.
