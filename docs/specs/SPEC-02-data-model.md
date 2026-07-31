# SPEC-02 — Data Model

Governs: entities, states, invariants, identifiers, SQLite schema, soft
deletion, and export format. Requirement IDs: `DM-*`. The model is extracted
from the v2 prototype's entry objects and generalized only where the prototype
used demo shortcuts.

## 1. Entities

```
Entry ────────── the atom of the journal (one line, one type, one date or collection)
Collection ───── a flat, dateless list (plus the implicit per-month "monthly log")
Proposal ─────── an agent-suggested change awaiting Approve/Dismiss
ActivityItem ─── an audit record of an automatic (agent) or approval-applied change
Summary ──────── a weekly reflection written by an agent
AgentToken ───── credential for one MCP client (SPEC-06)
```

## 2. Entry

The prototype's entry object, verbatim, is the contract:

```ts
type EntryType  = 'task' | 'event' | 'note' | 'idea' | 'question' | 'habit' | 'mood';
type EntryState = 'open' | 'done' | 'logged' | 'migrated' | 'scheduled' | 'cancelled';
type Author     = 'me' | 'ai';

interface Entry {
  id: string;              // ULID
  date: string;            // 'YYYY-MM-DD' — the day it belongs to (or filing date for collection entries)
  type: EntryType;
  text: string;            // single line, plain text, 1..500 chars
  state: EntryState;
  time: string | null;     // 'HH:MM' 24h, display + sort hint; not a scheduler
  tags: string[];          // lowercase, no '#', [a-z0-9-]+
  author: Author;
  source: string | null;   // human-readable provenance; REQUIRED when author === 'ai'
  migrations: number;      // times this task has been carried forward (0..n)
  collection: string | null; // null = daily log; 'month:YYYY-MM' = monthly log; else collection id
  createdAt: string;       // ISO 8601, server clock
  updatedAt: string;
  deletedAt: string | null; // soft delete (DM-14)
}
```

- DM-1 **Actionable vs logged types.** `task` and `habit` are *actionable*:
  they start in state `open` and use the checkbox lifecycle. All other types
  are *logged*: they start and remain in state `logged` (their lifecycle is
  positional — moved, filed, or deleted — not completable).
- DM-2 **Provenance invariant.** `author === 'ai'` ⇒ `source` is a non-empty
  string. Enforced at the domain layer for every write path (REST and MCP).
- DM-3 **Placement invariant.** An entry belongs to exactly one place:
  the daily log of `date` when `collection` is null, otherwise the named
  collection (its `date` records when it was filed and is shown as "Jul 20"
  in collection rows).
- DM-4 **Monthly log** is modeled as a collection id `month:YYYY-MM`
  (the prototype's `collection: 'month'` normalized to be month-specific).
  Migrating a task "to monthly log" sets the *original's* state to
  `scheduled`; approving/inspecting monthly items uses the same entry row UI.
- DM-5 `time` is presentation metadata (sorted, monospaced display). The
  system schedules nothing; there are no reminders in v1.

### 2.1 State machine

```
task | habit:                     event | note | idea | question | mood:
  open ──✓──▶ done                  logged (terminal; only position changes)
  open ◀──✓── done   (toggle)
  open ──migrate──▶ migrated   (a copy is created on today with migrations+1)
  open ──to month──▶ scheduled (entry now lives conceptually in the monthly log)
  open ──drop──▶ cancelled
```

- DM-6 **Migration copies, never moves.** "Move to today" creates a *new*
  entry (today's date, state `open`, `migrations = original.migrations + 1`,
  same text/tags/type/author/source) and sets the original to `migrated`.
  The paper-BuJo trail — the task visibly re-written day after day — is the
  point; `migrations` powers the "Moved 4×" honesty nudge.
- DM-7 `done ⇄ open` is freely toggleable. `migrated`, `scheduled`, and
  `cancelled` are exited only via an explicit edit (update proposal or owner
  edit), not via the checkbox.
- DM-8 Derived display labels (used by UI and MCP responses):
  `migrated` → "Moved forward", `scheduled` → "In monthly log",
  `cancelled` → "Dropped", `migrations > 1` → "Moved N×".

## 3. Collection

```ts
interface Collection {
  id: string;          // slug: [a-z0-9-]+ ('books', 'ideas') or 'month:YYYY-MM'
  name: string;        // 'Books to read'
  note: string | null; // one-line description
  createdAt: string;
  archivedAt: string | null;
}
```

- DM-9 Collections are **flat** — no parent field exists (explicit design
  decision). `month:*` collections are auto-created on first use and are not
  archivable.
- DM-10 Deleting/archiving a collection never deletes its entries; they
  remain queryable and the collection un-archives if re-created with the
  same id.

## 4. Identifiers

- DM-11 All ids are ULIDs generated **by the writer** (client or server), so
  offline captures have stable ids before sync (SPEC-07). Server rejects
  duplicate ids idempotently (returns the existing row — makes outbox replay
  and MCP retries safe).
- DM-12 The prototype's id prefixes (`e1`, `u<ts>`, `m<ts>`…) are demo
  artifacts; ULID replaces them.

## 5. Proposal

Generalizes the prototype's three hard-coded proposal kinds (split / drop /
retag) into an operations list the server can apply atomically:

```ts
type ProposalKind = 'split' | 'drop' | 'retag' | 'edit' | 'delete' | 'migrate' | 'other';

interface Proposal {
  id: string;                 // ULID
  kind: ProposalKind;         // drives the card badge label
  title: string;              // '“Plan the launch” is too vague to start'
  detail: string;             // one/two sentences of rationale
  lines: string[];            // optional display bullets (e.g. the split-out tasks)
  ops: ProposalOp[];          // what Approve actually executes, in order, atomically
  origin: { tokenId: string; tool: string };  // which agent, via which tool
  status: 'pending' | 'approved' | 'dismissed' | 'expired';
  createdAt: string;
  resolvedAt: string | null;
}

type ProposalOp =
  | { op: 'create'; entry: Omit<Entry, 'createdAt'|'updatedAt'|'deletedAt'> }
  | { op: 'update'; id: string; patch: Partial<Pick<Entry,'text'|'type'|'date'|'time'|'tags'|'state'|'collection'>> }
  | { op: 'delete'; id: string }
  | { op: 'retag';  from: string; to: string };   // journal-wide tag rename/merge
```

- DM-13 Approve executes all `ops` in one SQLite transaction; any failure
  (e.g. target entry since deleted) fails the whole proposal, which returns
  to `pending` with an error note surfaced on the card. Dismiss touches
  nothing. Both outcomes write an ActivityItem.

## 6. Soft delete & reversibility

- DM-14 Deletion sets `deletedAt`; rows purge after 30 days via a daily
  sweep. All queries exclude soft-deleted rows unless explicitly asked
  (`includeDeleted` is internal-only).
- DM-15 Every mutation performed by an agent tool or an approved proposal
  stores a JSON snapshot of each affected entry (pre-image) on its
  ActivityItem — this is what makes "All reversible" true and enables the
  P1 revert feature.

## 7. ActivityItem & Summary

```ts
interface ActivityItem {
  id: string;
  at: string;                       // ISO 8601
  text: string;                     // human sentence: 'Added “Book flights for Lisbon” from an email'
  kind: 'auto-add' | 'proposal-created' | 'proposal-approved' | 'proposal-dismissed'
      | 'proposal-expired' | 'summary-filed' | 'revert';
  refs: { entryIds: string[]; proposalId?: string; tokenId?: string };
  preImages: Entry[];               // snapshots per DM-15 (empty for pure adds)
}

interface Summary {
  id: string;
  weekStart: string;                // 'YYYY-MM-DD' (Monday)
  text: string;
  status: 'current' | 'stale' | 'saved';  // stale = owner hit Rewrite
  createdAt: string;
}
```

- DM-16 The Review view's feed renders ActivityItems newest-first with
  `HH:MM` timestamps (Geist Mono), grouped by day.
- DM-17 "Save to today" on a summary creates a `note` entry
  (`tags: ['summary']`, `author: 'ai'`, `source: 'Weekly summary, saved by
  you on <date>.'`) and marks the summary `saved`. "Rewrite" marks it
  `stale`; the scheduled summary agent replaces stale/old summaries on its
  next run (SPEC-06 §6).

## 8. SQLite schema

```sql
CREATE TABLE entries (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,              -- 'YYYY-MM-DD'
  type        TEXT NOT NULL CHECK (type IN ('task','event','note','idea','question','habit','mood')),
  text        TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  state       TEXT NOT NULL CHECK (state IN ('open','done','logged','migrated','scheduled','cancelled')),
  time        TEXT,                       -- 'HH:MM' | NULL
  tags        TEXT NOT NULL DEFAULT '[]', -- JSON array
  author      TEXT NOT NULL CHECK (author IN ('me','ai')),
  source      TEXT,
  migrations  INTEGER NOT NULL DEFAULT 0,
  collection  TEXT,                       -- NULL | collection id
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  CHECK (author = 'me' OR (source IS NOT NULL AND length(source) > 0))
);
CREATE INDEX idx_entries_date       ON entries(date)       WHERE deleted_at IS NULL;
CREATE INDEX idx_entries_collection ON entries(collection) WHERE deleted_at IS NULL;
CREATE INDEX idx_entries_state      ON entries(state)      WHERE deleted_at IS NULL;

CREATE TABLE collections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT,
  created_at TEXT NOT NULL, archived_at TEXT
);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', lines TEXT NOT NULL DEFAULT '[]',
  ops TEXT NOT NULL,                       -- JSON ProposalOp[]
  origin_token TEXT NOT NULL, origin_tool TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','dismissed','expired')),
  created_at TEXT NOT NULL, resolved_at TEXT
);

CREATE TABLE activity (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '{}',
  pre_images TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE summaries (
  id TEXT PRIMARY KEY, week_start TEXT NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','stale','saved')),
  created_at TEXT NOT NULL
);

CREATE TABLE agent_tokens (                -- details in SPEC-06 §3
  id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
);

CREATE VIRTUAL TABLE entries_fts USING fts5(
  text, tags, content='entries', content_rowid='rowid', tokenize='unicode61'
);
-- kept in sync via entry INSERT/UPDATE/DELETE triggers
```

- DM-18 Tags are stored denormalized (JSON array) *and* indexed in FTS5;
  search semantics live in SPEC-03 §6. A tag-rename op rewrites all affected
  rows in one transaction.
- DM-19 Schema migrations are numbered SQL files applied at boot inside a
  transaction, tracked in a `schema_migrations` table; a backup is taken
  first (ARC-18).

## 9. Export format

- DM-20 `journald export` emits
  `{ version: 1, exportedAt, entries[], collections[], proposals[], activity[], summaries[] }`
  with soft-deleted rows excluded. This file re-imports losslessly with
  `journald import` (id collisions resolved by skip + report).

## 10. Seed data

- DM-21 Dev builds ship the prototype's demo seed (the July 2026 dataset:
  Lisbon tasks, Anders call, Books/Ideas collections, three proposals, the
  activity trio) behind `journald seed --demo`, and the settings dialog's
  "Reset demo data" button appears only in dev builds. Production builds
  start empty.
