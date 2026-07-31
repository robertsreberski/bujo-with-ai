# bujo-with-ai — Journal

A local-first bullet journal PWA whose AI assistant participates through MCP.
One self-hosted process serves the app, its API, and an `/mcp` endpoint for
agents — reachable only on localhost and the owner's Tailscale tailnet.

**Status:** specification phase. No implementation yet.

## Documents

| Document | Contents |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product requirements: problem, goals, features (FR-1…40), NFRs, milestones, risks |
| [docs/specs/SPEC-01-architecture.md](docs/specs/SPEC-01-architecture.md) | Topology, stack, Tailscale, lifecycle, backups |
| [docs/specs/SPEC-02-data-model.md](docs/specs/SPEC-02-data-model.md) | Entities, state machine, invariants, SQLite schema |
| [docs/specs/SPEC-03-app-logic.md](docs/specs/SPEC-03-app-logic.md) | Views, capture parser, migration ritual, search, review |
| [docs/specs/SPEC-04-design-system.md](docs/specs/SPEC-04-design-system.md) | Tokens, type scale, components, breakpoints, motion |
| [docs/specs/SPEC-05-pwa.md](docs/specs/SPEC-05-pwa.md) | Manifest, service worker, offline, iOS standalone hardening |
| [docs/specs/SPEC-06-mcp-server.md](docs/specs/SPEC-06-mcp-server.md) | MCP transport, auth, the seven tools, resources, security |
| [docs/specs/SPEC-07-sync-api.md](docs/specs/SPEC-07-sync-api.md) | REST + SSE API, offline outbox, reconciliation |

## Design source of truth

The interactive prototype lives in Claude Design project
`c0a757a6-0470-4e9c-88e2-d2e0fbee53df` (file `Bullet Journal v2.dc.html`).
A reference copy is checked in under [`design/`](design/) — `support.js`
there is the design tool's runtime, not product code. Visual deviations from
the prototype are tracked in SPEC-04 §8.

## The contract in one paragraph

Entries are single lines with a type (`task · event · note · idea · question
· habit · mood`), captured with signifier shortcuts (`.` `o` `-` `!` `?` `+`
`~`, `#tag`, `@time`, `>tomorrow`). Agents connect over MCP with per-agent
bearer tokens and get exactly seven tools: `add_entry` and
`add_to_collection` apply immediately (badged, provenance required),
`list_day` and `search` are read-only, and `update_entry`, `delete_entry`,
`propose_migration` only create proposals the owner approves or dismisses in
the Review queue. Every automatic change lands in a reversible activity log.
