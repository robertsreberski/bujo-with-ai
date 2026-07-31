# bujo-with-ai — Journal

A local-first Bullet Journal PWA with an accountable AI co-author. One Node 22
process serves the app, REST/SSE API, and seven-tool MCP server from SQLite.
The process listens only on `127.0.0.1:5178`; production access is through the
owner's Tailnet at `https://mickey-home.tail8a9beb.ts.net:5178`.

## Product contract

Entries are single plain-text lines with a type (`task`, `event`, `note`,
`idea`, `question`, `habit`, or `mood`). The composer understands `.`, `o`,
`-`, `!`, `?`, `+`, `~`, `#tag`, `@time`, and `>tomorrow` shortcuts.

MCP exposes exactly seven tools. `list_day` and `search` are read only. The
other five — `add_entry`, `add_to_collection`, `update_entry`, `delete_entry`,
and the legacy-named `propose_migration` — apply immediately. Agent additions
carry source provenance; every mutation is attributed, rate-limited, captured
with before/after images, and shown in Review with conflict-safe Revert. There
is no proposal or approval queue.

Journal itself has no third-party egress. An MCP client authorized by the owner
may send retrieved content to the AI provider configured in that client.

## Run locally

Requirements: Node.js 22.19.0 or newer within the Node 22 release line, and npm.

```bash
npm ci
npm run dev
```

Development is isolated in `.journal-dev/` and listens on `127.0.0.1:5179`, so
it cannot open, migrate, purge, or contend with production data in
`~/.journal`. Open `http://localhost:5179`. Production builds use:

```bash
npm run check
npm run build
npm start
```

Production databases start empty. Demo content is available only through the
explicit operator command `journald seed --demo`; it is never seeded
automatically.

## MCP access

Create a token in **Assistant access**. The secret is shown once. Configure a
Streamable HTTP client with:

```text
URL: https://mickey-home.tail8a9beb.ts.net:5178/mcp
Authorization: Bearer <token>
```

Claude Code example:

```bash
claude mcp add --transport http journal \
  https://mickey-home.tail8a9beb.ts.net:5178/mcp \
  --header "Authorization: Bearer <token>"
```

Minimal initialization smoke test:

```bash
curl -i -X POST https://mickey-home.tail8a9beb.ts.net:5178/mcp \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl-smoke","version":"1.0"}}}'
```

Never commit a token. The MCP session id returned by initialization must be sent
on subsequent session requests.

The bundled agent guide is [`.claude/skills/journal/SKILL.md`](.claude/skills/journal/SKILL.md).
It includes the weekly-summary protocol. Journal installs no scheduler; a
summary runs only when the owner or owner-managed external automation invokes
that workflow.

## macOS and Tailnet deployment

Do not run `npm run install-service` from the mutable checkout or change
Tailscale Serve by hand. Use the fail-closed [production operations
procedure](docs/operations.md): it archives the exact browser-tested dirty
tree, stages an immutable release, distinguishes first-install from upgrade
ownership, preserves the entire existing Serve configuration (including the
separately owned `:443` handler), proves backup and lifecycle recovery, and
moves `current-release` only after every release gate passes.

## Documentation

| Document                                       | Contents                                                |
| ---------------------------------------------- | ------------------------------------------------------- |
| [PRD](docs/PRD.md)                             | Approved v1 + P1 product requirements and P2 exclusions |
| [SPEC-01](docs/specs/SPEC-01-architecture.md)  | Topology, stack, Tailnet, lifecycle, backups            |
| [SPEC-02](docs/specs/SPEC-02-data-model.md)    | Entities, invariants, SQLite, snapshots                 |
| [SPEC-03](docs/specs/SPEC-03-app-logic.md)     | Views, capture, migration, search, Review               |
| [SPEC-04](docs/specs/SPEC-04-design-system.md) | Tokens, components, responsive layout, motion           |
| [SPEC-05](docs/specs/SPEC-05-pwa.md)           | Offline behavior and iOS standalone hardening           |
| [SPEC-06](docs/specs/SPEC-06-mcp-server.md)    | MCP transport, seven tools, resources, security         |
| [SPEC-07](docs/specs/SPEC-07-sync-api.md)      | REST/SSE, pairing, outbox, reconciliation               |
| [Verification](docs/verification.md)           | Requirement-to-evidence and release-gate matrix         |

The prototype in `design/` is a visual reference only. Its runtime is not
shipped, and intentional accessibility/product-contract deviations are logged
in SPEC-04.
