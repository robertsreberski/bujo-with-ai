# PRD — Journal (bujo-with-ai)

A local-first bullet journal PWA with an AI assistant that participates through MCP.

| | |
|---|---|
| **Status** | Draft v1.0 |
| **Date** | 2026-07-31 |
| **Owner** | Robert Śreberski |
| **Design source of truth** | Claude Design project `c0a757a6-0470-4e9c-88e2-d2e0fbee53df`, file `Bullet Journal v2.dc.html` (interactive prototype with working logic) |
| **Spec set** | `docs/specs/SPEC-01` … `SPEC-07` |

---

## 1. Summary

Journal is a personal bullet journal (BuJo) that runs as a single self-hosted
process on the owner's own machine. It has two faces:

1. **A PWA** — an installable, offline-capable web app implementing the bullet
   journal method: rapid logging with type signifiers, a daily log, a monthly
   spread, collections, an index, and the migration ritual for unfinished tasks.
2. **An MCP endpoint** — the same journal exposed to AI agents (Claude Code,
   Claude Desktop, scheduled agents) over the Model Context Protocol, so agents
   can read the journal and write to it under an explicit, per-tool permission
   model.

Both faces are served by one local server, reachable only on `localhost` and
the owner's **Tailscale tailnet**. There is no cloud component and no
third-party data store: the journal lives in a single SQLite file on the
owner's hardware.

The defining product idea, taken directly from the design: **the assistant is a
first-class author in the journal, but never an invisible one.** Every AI
entry is visibly badged and carries human-readable provenance ("From the email
'Lisbon: dates confirmed' (Ana, 09:41)"). Additions are automatic; edits and
deletions require the owner's approval in a Review queue. All automatic
activity is logged and reversible.

## 2. Problem

- Bullet journaling works because it is cheap to write and forces periodic,
  honest review ("cheap to write, expensive to keep — that is the whole
  method"). Paper journals can't capture things that arrive digitally (emails,
  call transcripts, chat messages), so those either interrupt the user or get
  lost.
- Existing task/notes apps that add AI do it as a chat bolted onto the side.
  The AI's changes are invisible, unaccountable, and erode trust in the data.
- Cloud task managers put a personal daily-thinking tool on someone else's
  server. A journal is intimate data; it should stay on hardware the owner
  controls, while still being reachable from their phone and their agents.

## 3. Goals

1. **Frictionless capture.** One text field, type signifiers (`.` `o` `-` `!`
   `?` `+` `~`), inline `#tags`, `@time`, `>tomorrow`. An entry lands in under
   three seconds from app-open on a phone.
2. **The BuJo method, faithfully.** Daily log, monthly log + calendar, index,
   flat collections, and migration as a deliberate ritual — including the
   "moved forward 4× — consider dropping it" honesty nudge.
3. **Agents as accountable co-authors.** Agents add entries automatically
   (badged, with provenance), propose destructive changes for approval, and
   generate weekly reflections — via seven MCP tools with a fixed permission
   model.
4. **Local-first, tailnet-reachable.** Runs on the owner's machine; the PWA
   and MCP endpoint are reachable from any of the owner's devices over
   Tailscale with HTTPS. Works offline on the phone; reconciles when back.
5. **Trust through reversibility.** Activity feed of every automatic change;
   soft deletion; approval queue for anything that mutates or removes existing
   content.

## 4. Non-goals (v1)

- **Multi-user / sharing.** One owner, one journal. No accounts, no collab.
- **Public internet exposure.** Tailnet + localhost only. No Anthropic
  connector-directory submission, no OAuth consent screens.
- **A chat UI.** The app has no chat pane. Conversation with the assistant
  happens in the agent's own surface (Claude Code / Desktop); the journal is
  the artifact they cooperate on.
- **Native apps.** iOS/Android come through the PWA.
- **Long-form notes / rich text.** Entries are single lines of plain text by
  design. No markdown rendering, no attachments in v1.
- **Nested collections.** Collections are flat (an explicit design decision
  recorded in the seed data: "Anders: keep collections flat, no nesting").
- **End-to-end sync between multiple server instances / CRDTs.** One server is
  the source of truth; clients cache and queue. (CRDT sync is listed in the
  design's own "Project ideas" collection — it stays an idea.)

## 5. Users

| Actor | Description | Interface |
|---|---|---|
| **Owner** | A single technical user journaling daily across a Mac and an iPhone. | PWA (installed on iOS home screen, browser on desktop) |
| **Interactive agent** | Claude Code / Claude Desktop session the owner is driving, connected to the journal MCP endpoint over the tailnet. | MCP tools |
| **Scheduled agent** | Headless agent run on a schedule (e.g. nightly triage, weekly summary) on a tailnet machine. | MCP tools |

## 6. Product principles

1. **The journal is the owner's voice.** Agents write *into* it, clearly
   marked; they never rewrite the owner's words without approval.
2. **Additions are cheap, mutations are guarded.** New entries auto-apply
   (worst case: you delete a line). Edits and deletions of existing entries go
   through Review.
3. **Provenance or it didn't happen.** Every AI-authored entry must carry a
   `source` string a human can read and verify.
4. **Honest friction where the method needs it.** Migration is intentionally a
   one-at-a-time decision flow, not a bulk "move all" button.
5. **Fail visible.** If the MCP server is down, the settings dialog says so.
   If a proposal is applied, the activity feed says exactly what changed.

## 7. Feature requirements

Priorities: **P0** = v1 launch, **P1** = fast-follow, **P2** = later.
Every feature below exists in the design prototype unless marked otherwise;
"§" references point to the governing spec.

### 7.1 Capture (P0) — §SPEC-03

- FR-1 Persistent bottom composer on all views: type selector, text input, submit.
- FR-2 Inline parse of the draft on every keystroke: leading signifier → type
  (`.` task, `o` event, `-` note, `!` idea, `?` question, `+` habit, `~` mood),
  `#tag`s, `@time` (12/24h), `>tomorrow` date shift. Parsed facts render as
  chips above the input before submit.
- FR-3 Explicit type menu (popover) overrides/preselects the type; a typed
  signifier wins over the menu selection.
- FR-4 Submit adds the entry to today (or tomorrow via `>tomorrow`), clears the
  draft, returns to the Today view, and confirms with a toast.
- FR-5 Capture works offline; queued entries reconcile when the server is
  reachable (§SPEC-07).

### 7.2 Daily log — "Today" view (P0) — §SPEC-03

- FR-6 Reverse-chronological day sections (Today first), each with a sticky
  header showing day title, date, and an open-task or entry count.
- FR-7 Entry rows show: state control (checkbox for task/habit, type icon
  otherwise), text, meta badges (type, state, AI badge, tags), and a
  monospaced time label when timed.
- FR-8 Checkbox toggles done/open inline without opening the entry.
- FR-9 Completed/dropped/migrated entries render dimmed with strikethrough
  (done, dropped).
- FR-10 A leftovers banner appears when any open task exists on a past date,
  with a count and a "Review them" CTA that starts migration.

### 7.3 Migration ritual (P0) — §SPEC-03

- FR-11 Migration is a modal, one-task-at-a-time queue ("2 of 5 — what should
  happen to this one?") over all leftover open tasks.
- FR-12 Four decisions per task: **Move to today** (copies the task to today,
  original marked *migrated*, migration counter +1), **Mark done**,
  **To monthly log** (state *scheduled*), **Drop it** (state *cancelled*).
- FR-13 Tasks migrated more than once show "Moved forward N× already.
  Consider dropping it."
- FR-14 Finishing the queue confirms with "All caught up."

### 7.4 Month view (P0) — §SPEC-03

- FR-15 Calendar grid (weeks start Monday) with entry-count dots, today
  highlighted, prev/next month navigation; tapping a day surfaces its entry
  count (P0) and navigates to that day in Today view (P1).
- FR-16 Monthly log: entries filed to the month rather than a day ("Things
  that belong to the month, not to a day"), with the same row interactions.
- FR-17 Weekly summary card: latest agent-written reflection with actions
  **Save to today** (files it as a `#summary` note authored by the assistant)
  and **Rewrite** (requests regeneration — see FR-31).

### 7.5 Index & collections (P0) — §SPEC-03

- FR-18 Index view groups: **Collections** (flat, user-defined, e.g. "Books to
  read"), **Monthly spreads** (one per month with data), **Saved views**
  (canned filters: Open tasks, Added by assistant, Tagged #work).
- FR-19 Collection detail: title, "N items · M done" meta, dated entry rows,
  back navigation to Index.
- FR-20 Entries can be filed into a collection from the entry dialog
  ("File in ideas") and by agents (`add_to_collection`).

### 7.6 Entry detail & editing (P0) — §SPEC-03

- FR-21 Entry dialog: fields (Type, Status, Date+time, Tags, Added by), and
  for AI entries an "Added automatically" provenance panel showing `source`.
- FR-22 Task/habit actions: Mark done / Mark not done, Move to today,
  To monthly log, Drop. Non-task actions: Move to today, File in ideas,
  Delete.
- FR-23 Full field editing (text, date, time, tags, type) — P1 (the prototype
  exposes state changes only; editing ships behind the same dialog).

### 7.7 Search (P0) — §SPEC-03

- FR-24 ⌘K (desktop) and search buttons open a search dialog; queries match
  entry text and tags; `#tag` filters by exact tag; results are full entry
  rows (with dates) that open/toggle in place; empty state names the query.
- FR-25 Saved views from the Index open pre-filtered searches.

### 7.8 Assistant integration (P0) — §SPEC-06

- FR-26 MCP endpoint at `/mcp` exposing exactly these tools with these modes
  (the contract shown to the user in the settings dialog):

  | Tool | Mode |
  |---|---|
  | `add_entry` | automatic |
  | `add_to_collection` | automatic |
  | `list_day` | read only |
  | `search` | read only |
  | `update_entry` | needs approval |
  | `delete_entry` | needs approval |
  | `propose_migration` | needs approval |

- FR-27 Automatic writes: apply immediately, `author: "ai"`, **require** a
  human-readable `source`, render with the AI badge and tinted row, and log
  to the activity feed.
- FR-28 Approval-gated tools never mutate directly: they create **proposals**
  in the Review queue. The tool result tells the agent the proposal is
  pending.
- FR-29 Review view: proposal cards (kind badge, title, detail, optional
  bullet lines) with **Approve** (applies the change atomically) and
  **Dismiss**; a badge on the Review tab shows the pending count.
- FR-30 Activity feed on the Review view: timestamped list of automatic
  changes ("09:41 — Added 'Book flights for Lisbon' from an email"), labeled
  "All reversible"; every entry links to a stored before/after snapshot
  (§SPEC-02). One-tap revert from the feed is P1.
- FR-31 Weekly summary loop: a scheduled agent reads the week (`list_day` /
  `search`) and files a reflection; "Rewrite" flags the current one stale for
  the next agent run (P1 for the flag; P0 renders whatever the agent filed).
- FR-32 Settings ("Assistant access") dialog: MCP endpoint URL, connection
  status, per-tool permission list, agent token management (§SPEC-06), and a
  data-reset control (dev builds only).

### 7.9 PWA & platform (P0) — §SPEC-05

- FR-33 Installable PWA: manifest, icons, standalone display, dark theme
  colors matching the design (`#16130F`).
- FR-34 Offline: app shell cached; journal readable offline from the local
  mirror; captures queue and replay (§SPEC-07).
- FR-35 iOS standalone correctness: safe areas, keyboard-docked composer,
  no rubber-banding, resume re-sync — the full checklist in §SPEC-05.
- FR-36 Responsive layout: phone (full-bleed, tab bar), ≥680px (centered
  560px column), ≥1024px (sidebar + 720px content column) — §SPEC-04.

### 7.10 Deferred features

- FR-37 **Habit tracker grid** (P1): per-habit month heatmap. Fully designed
  (present but hidden in the v2 prototype); data model supports it from day
  one via the `habit` type.
- FR-38 One-tap revert from activity feed (P1).
- FR-39 Migration targets beyond tomorrow (`>monday`, `>2026-08-04`) (P2).
- FR-40 Multiple journals / archive & export (P2 — export as JSON/Markdown).

## 8. Non-functional requirements

- NFR-1 **Latency:** UI interactions render optimistically in <16ms; server
  round-trip for a capture <100ms on-LAN; MCP tool calls <300ms p95 (local).
- NFR-2 **Availability:** the journal is readable on the phone with the
  server unreachable (cached mirror). The server auto-starts on login
  (launchd) and recovers cleanly from crash (SQLite WAL).
- NFR-3 **Privacy/security:** no data leaves the tailnet; the server binds
  only to loopback + tailnet interfaces; MCP requires a bearer token even
  inside the tailnet; journal content is treated as untrusted data, never as
  instructions (§SPEC-06 prompt-injection posture).
- NFR-4 **Durability:** single SQLite file, WAL mode, daily on-disk backup
  rotation (7 daily + 4 weekly); soft-delete retention 30 days.
- NFR-5 **Portability:** server runs anywhere Node 22 runs; data directory is
  self-contained and copyable.
- NFR-6 **Accessibility:** all interactive elements keyboard-reachable;
  visible focus states; touch targets ≥40px on mobile; contrast per the token
  audit in §SPEC-04.

## 9. Success measures

Single-user product; measures are honesty checks, not growth metrics:

1. Owner captures ≥5 entries/day median after 2 weeks (capture is frictionless).
2. Leftover queue reaches zero at least 5 days/week (migration ritual works).
3. ≥70% of AI-added entries survive 7 days undeleted (agent writes are useful).
4. ≥80% of proposals get an explicit Approve/Dismiss within 48h (Review queue
   is visited, not ignored).
5. Zero data-loss incidents; every automatic change reconstructible from the
   activity log.

## 10. Release plan

| Milestone | Scope |
|---|---|
| **M1 — Journal core** | Server + SQLite + REST/SSE, PWA with Today/Month/Index/Collections/Search, capture parser, migration ritual. Local only. |
| **M2 — Assistant** | MCP endpoint (7 tools), proposals + Review view, activity feed, AI badging/provenance, agent tokens. |
| **M3 — Tailnet & phone** | Tailscale Serve HTTPS, iOS PWA hardening, offline queue, launchd service, backups. |
| **M4 — Rituals** | Weekly summary loop (scheduled agent + Rewrite flag), habit grid, activity revert. |

## 11. Risks

| Risk | Mitigation |
|---|---|
| iOS PWA keyboard/viewport quirks break the bottom composer | Follow §SPEC-05 checklist verbatim (visualViewport docking, `--app-height`, safe-area single-level rule); test on device each milestone. |
| Prompt injection: journal text read by agents contains adversarial instructions | Tool results wrap content as data with explicit framing; server never echoes content into tool *descriptions*; docs warn agent operators (§SPEC-06). |
| Agent floods journal with low-value auto entries | Provenance required; activity feed surfaces volume; per-token rate limit; Review-first mode toggle per token (P1). |
| Tailnet token leakage | Tokens are per-agent, revocable, hashed at rest, shown once; tailnet ACLs restrict which devices reach the port. |
| Approval queue rots (proposals ignored) | Badge count on Review tab; stale proposals (>7 days) auto-expire with an activity note. |
| Design drift between prototype and build | §SPEC-04 extracts the prototype's exact tokens/measurements; deviations must be recorded in that spec's changelog. |

## 12. Open questions

1. Day boundary: local midnight, or a configurable "day starts at 03:00"
   offset for late-night logging? (v1: local midnight; revisit after use.)
2. Should read-only tools be callable without a token from localhost (agent
   ergonomics) or always require auth? (v1: always require token; simplest
   mental model.)
3. "Rewrite" summary flow depends on a scheduled agent picking up the flag —
   acceptable latency, or does v1.5 need a server-initiated agent hook?

## 13. Spec map

| Spec | Covers |
|---|---|
| `SPEC-01-architecture.md` | Process topology, stack, Tailscale, service lifecycle, backups |
| `SPEC-02-data-model.md` | Entities, states, invariants, SQLite schema, IDs, soft delete |
| `SPEC-03-app-logic.md` | Views, capture parser, migration, search, proposals, activity |
| `SPEC-04-design-system.md` | Tokens, type scale, components, layout/breakpoints, motion |
| `SPEC-05-pwa.md` | Manifest, service worker, offline, iOS standalone hardening |
| `SPEC-06-mcp-server.md` | Transport, auth, the 7 tools (schemas/annotations), resources, security |
| `SPEC-07-sync-api.md` | REST + SSE API, offline outbox, reconciliation |
