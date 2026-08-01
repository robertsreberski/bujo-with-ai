# SPEC-03 — Application Logic

Governs: view behavior, the capture parser, migration ritual, search,
activity/revert review, and keyboard interactions. Requirement IDs:
`LOG-*`. Every rule here is either lifted directly from the v2 prototype's
component logic or marked **[ext]** where it deliberately extends it.

## 1. Navigation model

- LOG-1 Five screens: **Today**, **Month**, **Index**, **Collection**
  (detail, reached from Index), **Review**. Four overlay dialogs: **Entry**,
  **Migration**, **Search**, **Assistant access (settings)**. One transient
  **type menu** popover and a **toast**.
- LOG-2 Navigation surfaces by breakpoint (SPEC-04 §5): segmented tab bar
  under the header (<1024px) or sidebar (≥1024px). Both list Today, Month,
  Index, Review; the Index item stays active while a Collection is open.
- LOG-3 Review has no _pending_ badge. Agent writes are immediate; Review is a
  chronological activity/revert destination, never an approval inbox. The
  count it does carry (LOG-53) reports work already done, not work awaiting a
  decision. **[amended]**
- LOG-53 **[ext]** Two nav items carry a count, in both the tab bar and the
  sidebar:
  - **Today** — open tasks and habits in the daily log dated today or
    earlier (`state=open`, `type ∈ {task, habit}`, `collection=null`,
    `date ≤ today`), which is exactly the set the Today screen shows as
    actionable.
  - **Review** — recorded changes newer than the last time Review was
    opened, everything when it never has been. `revert` items are excluded:
    a revert is the owner's own action taken _on_ that screen, so counting it
    would re-badge the screen for using it.

  Zero renders no badge. Past nine the badge reads `9+`, because the exact
  number has stopped mattering by then.

- LOG-54 **[ext]** The count is announced, not merely drawn: the badge is
  `aria-hidden` and the number joins the control's accessible name
  (`Today — 3 open tasks`), so it is never read as a digit floating after the
  label. Opening Review marks everything seen; the mark is a local, debounced
  write that never reaches the server and never blocks the route change, and
  it is stamped at `max(now, newest activity time)` so a client clock running
  behind cannot leave just-seen items permanently unseen. It survives reload.
- LOG-4 **[ext]** Screens map to routes (`/?date=YYYY-MM-DD`,
  `/month?month=YYYY-MM`, `/index`, `/c/:collectionId`, `/review`) so day and
  month selections deep-link and browser/PWA back navigation works; omitted
  query values mean the server-issued current day/month.
- LOG-5 Header: app title + date context. Wide: current view title, subtitle
  = long date (Today) or "N days logged". Narrow: "Journal" + "long date · N
  days logged", with search and settings icon buttons on the right.

## 2. Capture composer

Present on every screen, docked to the bottom (keyboard behavior: SPEC-05 §4).

### 2.1 Parser

- LOG-6 Input is parsed on every keystroke. Grammar, applied in order:
  1. **Signifier** — first token when the draft starts with
     `<signifier><space>`: `.` task · `o` event · `-` note · `!` idea ·
     `?` question · `+` habit · `~` mood (case-insensitive `o`). Consumed
     from the text. When present it _overrides_ the type-menu selection and
     the type button renders muted (the signifier "won").
  2. **Collection** — the first `/slug`, matched as
     `(?<=^|\s)/([A-Za-z0-9-]{1,80})(?![A-Za-z0-9_:./-])`. The lookbehind
     requires the token to open a whitespace-delimited run and the lookahead
     rejects a slug continuing into `_ : . / -`, so `https://a.com/b`,
     `/usr/bin`, `/a_b`, `/v1.2`, `a/b`, `/month:2026-07`, and an 81-character
     slug are all ordinary text. Consumed; lowercased into `collection`.
     Only the first token counts — `Plan the week /errands /shop` files into
     `errands` and keeps the literal `/shop`. `//` at the same position is
     the escape: `Prep //standup` yields the literal text `/standup` and no
     collection. Unescaping runs _after_ the match, so
     `Prep //standup /errands` still files into `errands`. **[ext]**
  3. **Tags** — every `#[A-Za-z0-9-]+` anywhere; consumed; lowercased and
     de-duplicated into `tags`. Underscore is deliberately not valid.
  4. **Time** — first `@H`, `@H:MM`, `@Ham/pm`, `@H:MMam/pm`;
     12h converts to 24h (12am → 00); consumed; result `HH:MM`.
  5. **Date shift** — `>tomorrow` (case-insensitive) sets the target date to
     today+1; consumed. (Other targets: FR-39, P2.)
  6. Remaining text is whitespace-collapsed and becomes `text`.

  The collection step runs before tags because tag consumption inserts
  spaces where tokens were: parsed after tags, `#work/x` would leave `/x`
  opening a run and become a collection. Parsed before them it stays a
  `work` tag plus the literal text `/x`. `>tomorrow` may be glued to the
  slug (`/errands>tomorrow` parses both), but a time may not
  (`@9/errands` is a `09:00` time and literal `/errands`), because the time
  token's own lookahead ends the run first. A draft that is nothing but a
  token parses to empty text, exactly as a tag-only draft does.

- LOG-7 A context row above the input reports what the parser found: the
  destination chip (LOG-43) leads, then one preview chip per fact, in order —
  type label, `at HH:MM`, one per `#tag` — and the capture-help control sits
  at its trailing edge. The facts region is `aria-live="polite"` (the chip and
  help control sit outside it, so control churn never announces), and the facts **wrap
  onto further lines rather than truncate**: a capture with several tags stays
  legible instead of scrolling sideways out of view. `>tomorrow` has no chip
  of its own; it is reported by the destination chip reading `Tomorrow`, which
  is the same fact stated once. **[amended]**
- LOG-7a **[ext]** Removing a token behind a chip edits the draft rather
  than the parse result, using regex sources exported by the parser so the
  editor can never drift from it. A removal splices the single occurrence
  the parser consumed and heals the seam to one space; `tag` is the
  exception and strips **every** occurrence of that tag, because the parser
  folds duplicates into one chip. A token that is absent leaves the draft
  untouched, so repeated removals are idempotent.
- LOG-7b **[amended]** An empty draft shows **no legend**. The composer used
  to carry a `Shortcuts: …` hint line, and it is deliberately gone: a legend
  that is only readable while the draft is empty disappears exactly when the
  owner starts needing it, and it spent the one row the facts now use.
  Teaching the grammar is instead split between the two places that can do it
  while the owner types — the sigil-triggered completion panels (LOG-48),
  which answer as each sigil is typed, and the capture-help surface (LOG-52),
  which is the complete reference on demand.
- LOG-8 The type button reflects the _parsed_ type (icon + label) live and
  opens the type menu; picking a type there sets the default for drafts
  without a signifier.

### 2.2 Destination **[ext]**

The composer files into one destination — a calendar day or a collection —
resolved on every keystroke and shown as a chip left of the preview row.

- LOG-43 The destination chip is a **control**, not a derived-fact chip: it
  answers the composer's whole question — where does this land? — so it is
  control-sized (metrics: SPEC-04 §8 row 14) rather than on the smaller ramp
  the preview chips use, and it wears a border and a disclosure chevron so it
  reads as openable. It shows a decorative `→` and the label, under the
  accessible name `Destination: <label>`, and carries a `New` badge when
  filing there would mint a collection. Its wrapper is width-capped so a long
  collection name ellipses inside the chip instead of pushing the row wider
  (metrics: SPEC-04). Labels: `Today`, `Tomorrow`, a short date
  (`Aug 12`) for any other day; for a collection, its name if the mirror
  knows it, else the month name for a `month:` id, else the humanized slug.
  A second, adjacent `Clear destination` button appears only when the
  destination came from a token or a chip — a screen default has nothing to
  take back. Clearing a token edits the draft (LOG-7a); clearing a chip drops
  the override.
- LOG-44 Each screen has an ambient default, so capture always means
  "here":

  | Screen                  | Default destination                             |
  | ----------------------- | ----------------------------------------------- |
  | Today (`/`, `/?date=`)  | the **viewed** day — backdating wins over today |
  | Month (`/month?month=`) | `month:<browsed month>`                         |
  | Collection (`/c/:id`)   | that collection                                 |
  | Index, Review           | today                                           |

  A collection route naming an unknown or archived id is a stale link, not a
  target: it falls back to today. The picker's own chip override is scoped to
  the screen that set it, and re-picking a screen's own default retires the
  override instead of pinning a chip whose clear button would do nothing.

- LOG-45 Precedence is **token > chip > screen**: a typed `/slug` beats a
  picked chip, which beats the ambient default. `>tomorrow` then overrides
  any _date_ destination — explicit grammar beats the viewed day — but never
  a collection one, because the server owns the entry date for a filed
  capture. Date destinations travel as intent, not as a literal date: today
  sends neither `date` nor `dateShift`, tomorrow sends `dateShift`, and any
  other day sends an absolute `date` (ARC-16).
- LOG-46 **Create-then-file.** A destination whose slug the mirror has never
  seen is minted on submit: `createCollection` is enqueued first and the
  entry second, so the FIFO outbox creates the collection before the entry
  that files into it, offline included. The new collection's name is the
  humanized slug (`project-atlas` → `Project atlas`). Monthly logs are never
  minted this way — they are server-owned — and an archived-but-present slug
  is not "new" either, because filing there un-archives it (DM-10).
- LOG-47 The picker is one control with two surfaces (SPEC-05 §4): an
  anchored popover ≥680px, a bottom sheet below it, both marked
  `destination-menu`. It offers the daily log (viewed day, plus today when
  those differ), Tomorrow, the browsed monthly log, every active
  non-month collection — behind a filter field past six of them — and an
  inline "New collection…" form that previews the address it would mint.
  Rows suppress `pointerdown` (PWA-19) and the composer takes focus back
  once the surface has closed, not during the selecting click.

### 2.3 Submit

- LOG-9 Submit (Enter or the + button) with empty parsed text, or with a
  parse error, is a no-op. Otherwise create the entry: parsed fields; the
  destination per LOG-45; `state` = `open` for task/habit else `logged`;
  `author: 'me'`; clear the draft; keep focus in the composer. Offline
  commands freeze capture time, last server today, timezone, and date intent
  so replay after midnight preserves intent. **[amended]** Capture no longer
  navigates: the owner stays where they were and the toast reports
  `Added to <destination label>`. When the entry landed somewhere the current
  screen is not showing, that toast carries a **View** action that navigates
  to the destination; when the screen already shows it — a capture on the
  month spread landing in that month's log — no action is offered, because
  there is nothing to go and see.
- LOG-10 Creation is optimistic: the entry renders immediately from the local
  store and reconciles through the outbox (SPEC-07). Capture must never block
  on the network.

### 2.4 Inline completion and composer keyboard **[ext]**

- LOG-48 **Every sigil in the grammar opens a panel**, so the grammar is
  discoverable by typing it rather than by reading a legend (LOG-7b). The
  whitespace-delimited run under the caret decides which:

  | Token | Completes      | Rows                                                                        |
  | ----- | -------------- | --------------------------------------------------------------------------- |
  | `#…`  | tags           | tags whose name has the query as a prefix, ranked by uses then name         |
  | `/…`  | collections    | collections matching the query in id or name, plus a create row (below)     |
  | `>…`  | the date shift | one `Tomorrow` row inserting `>tomorrow`, while the query prefixes it       |
  | `@…`  | a time         | the next three round hours, each glossed in 12-hour form (`16:00` → `4 pm`) |

  At most six rows. A `/` query whose slug is unknown appends a trailing
  `Create collection “<slug>”` row that mints exactly the slug the parser
  would have read. The `@` rows are the upcoming hours in local wall time,
  wrapping past midnight — the clock the owner is looking at, and the one the
  parser resolves against — and a typed prefix matches either the padded or
  the spoken form, so `@9` still finds `09:00`.

  A sigil only counts when it _opens_ the run, so `a#b` and
  `https://example.com` are inert and `//` (the parser's escape) is skipped
  rather than completed. Each sigil also refuses text that is plainly not a
  completion: `>` takes letters only, and `@` takes `HH`/`HH:MM` digits only,
  so `@mira` is a handle rather than a half-typed time and neither closes over
  ordinary prose. Accepting replaces the run with the completion plus one
  trailing space, absorbing a space that already followed it, and leaves the
  caret past it.

- LOG-48a **[ext]** Two sigils carry a caption the rows alone cannot: `>`
  explains that the token files the capture into tomorrow's log, and `@`
  teaches the shapes the parser also accepts (`@4pm`, `@11`, `@23:59`). The
  caption is a muted line beneath the rows and is a **sibling of the
  listbox, never a child of it** — a `role="listbox"` may only parent options,
  so teaching that is not a completion sits beside them.
- LOG-49 The panel renders inside the composer shell rather than a portal
  (SPEC-05 §4) and the whole surface suppresses `pointerdown`, so a tap on any
  part of it — row or caption — never blurs the input. The input wears
  `role="combobox"` **permanently** (ARIA 1.2), with `aria-autocomplete="list"`
  and an `aria-expanded` that reports whether the panel is showing;
  `aria-controls`/`aria-activedescendant` are present only while it is, since
  they may not dangle. The role is fixed because WebKit rebuilds a focused
  field's accessibility and editing context when its role changes, which drops
  the caret to the end mid-typing. Arrow keys move the active row and wrap; Enter
  and Tab accept it. An Enter that accepts must never also file the entry —
  the guard that swallows that submission is disarmed in a microtask, so a
  later click on **Add entry** still submits. Keystrokes steering an IME
  composition (`isComposing`) belong to the IME: they neither accept nor
  clear.
- LOG-50 The tag vocabulary is requested lazily, on **every** entry into `#`
  mode rather than once per composer mount: the request answers from the
  mirror synchronously — so it works offline — and TTL-guards its own network
  call, which makes repeating it cheap and makes a journal whose first tags
  appear after mount still learn them. The server refresh
  (`GET /api/tags`, API-17) is merged by tag, so a tag that only exists in an
  unsent capture keeps its local count.
- LOG-51 **Escape ladder.** One Escape, one rung, topmost first: the
  completion panel, then the type menu, then the draft (cleared), and only an
  already-empty composer returns the keyboard to the page by blurring. An
  Escape while a dialog is open belongs to that dialog (LOG-37). A `Clear
draft` button inside the input is the pointer equivalent of the third rung.
- LOG-52 Discoverability: each type-menu row carries an `aria-hidden` `<kbd>`
  showing its signifier, and the menu accepts a bare signifier key as a
  shortcut; a help popover (`.capture-help`, same surfaces as LOG-47) lists
  the signifiers, the tokens (`#tag`, `@4pm`, `>tomorrow`, `/collection`,
  `//literal`), and the shortcuts. Pressing `/` anywhere in the app focuses
  the composer, unless a dialog is open or the key was typed into a
  text-entry target — including the composer itself, where `/` is grammar.

## 3. Today view

- LOG-11 Content = all non-collection entries, grouped by `date`, days sorted
  newest-first, entries within a day newest-first (insertion order, matching
  the prototype's position-based sort).
- LOG-12 Day section header (sticky within the scroll container): title
  ("Today" for the current day, else "Thursday, July 30"), subtitle (long
  date, Today only), and a count — "N open" if any open tasks, else
  "N entries"/"1 entry".
- LOG-13 **Leftovers banner** renders above the sections when any entry
  matches: `type=task ∧ state=open ∧ collection=null ∧ date < today`. Title:
  "N task(s) from an earlier day is/are still open"; body: "Decide what to do
  with each one: move it to today, finish it, or drop it."; CTA "Review them"
  opens the Migration dialog with that queue.

### 3.1 Entry row (shared by Today / Month / Collection / Search)

- LOG-14 Row anatomy: lead control · content · time.
  - Lead: tasks/habits get a checkbox (filled + checkmark when done); other
    types show their type icon.
  - Content: text line, then a meta row (only when it has something to show)
    of: type badge (hidden for plain tasks and when `showTypeBadges` is off),
    state badge (per DM-8 labels), AI badge (sparkle chip, tinted orange,
    when `author='ai'` and highlighting on), tags (`#work #travel`), and — in
    dated contexts (search, collections) — a short date prefix.
  - Time: `HH:MM` in Geist Mono, right-aligned, only when set.
- LOG-15 Interactions: row click opens the Entry dialog; checkbox click
  toggles `done ⇄ open` without opening (event stops propagation); on
  non-task rows the lead icon click also opens the dialog.
- LOG-16 Visual state: done/cancelled/migrated rows dim to muted text;
  done and cancelled also strike through. AI rows get a subtly tinted
  background when highlighting is enabled.
- LOG-17 Row density (`comfortable`/`compact`), type-badge visibility, and
  AI-highlight are user settings **[ext:** persisted app settings; in the
  prototype they are component props**]**.

## 4. Entry dialog

- LOG-18 Shows field rows: Type, Status ("Logged" or capitalized state),
  Date ("Thursday, July 31" + "at HH:MM" when timed), Tags (or "—"),
  Added by ("You"/"Assistant").
- LOG-19 AI entries append an "Added automatically" panel rendering the
  entry's `source` verbatim.
- LOG-20 Actions (2-column grid):
  - task/habit: **Mark done/not done** (primary), **Move to today**
    (migration copy per DM-6), **To monthly log** (original → scheduled and
    monthly copy created atomically per DM-4),
    **Drop** (state → cancelled, danger).
  - other types: **Move to today** (sets `date` = today; primary),
    **File in ideas** → **[ext]** generalized to **File in collection…**
    (collection picker; the prototype hard-wired 'ideas'), **Delete**
    (soft delete, danger).
  - every action closes the dialog and toasts its result ("Moved to today",
    "Dropped", "Deleted"…).
- LOG-21 **[ext, included]** An Edit affordance switches fields to inputs
  (text, type, date, nullable time, tags) and saves via the same domain update
  path. Type/state are normalized and the final merged row is validated.

## 5. Migration dialog

- LOG-22 Modal queue over the leftover set, one task at a time. Header
  subtitle: "K of N — what should happen to this one?". Card shows text,
  "From <long date>" + tags; when `migrations > 1` an assistant-toned hint:
  "Moved forward N times already. Consider dropping it."
- LOG-23 Actions: **Move to today** (primary; copy per DM-6), **Mark done**,
  **To monthly log**, **Drop it** (danger). Each advances the queue;
  finishing closes the dialog and toasts "All caught up".
- LOG-24 Dismissing the dialog mid-queue is allowed; remaining leftovers keep
  the banner alive.

## 6. Month view

- LOG-25 Calendar: Monday-start grid (`Mo…Su`), leading/trailing blanks, one
  cell per day with the day number and a dot when the day has ≥1
  non-collection entry. Today's cell is outlined/raised. Prev/next chevrons
  shift the month; the label formats as "July 2026".
- LOG-26 Cell tap navigates to `/?date=YYYY-MM-DD` and scrolls Today to that
  day; empty days render a named empty section. Cell tooltip: "<long date> —
  N entries".
- LOG-27 Monthly log section: entries in `month:<displayed-month>`
  (newest-first), heading meta "N items", explainer "Things that belong to
  the month, not to a day.", standard entry rows.
- LOG-28 Weekly summary card: sparkle icon + "Weekly summary · generated
  automatically", the greatest-weekStart Summary assigned to the displayed
  month (DM-17), and actions **Save to today** / **Rewrite**. Card hides when
  that month has no summary **[ext:** prototype always had one**]**.
- LOG-29 Habit grid (P1 included, FR-37): per habit, a one-cell-per-day month
  strip; a cell is
  filled when a `habit` entry with that text is `done` on that day; count
  label "K / N" where N is the number of days in the displayed month.

## 7. Index, collections, activity review

- LOG-30 Index groups (in order):
  1. **Collections** — non-month, non-archived collections; row = name +
     "N items" + chevron → Collection view. Create, rename, and archive
     controls live here; month collections cannot be archived.
  2. **Monthly spreads** — one row per month having entries ("July 2026",
     "N entries") → Month view of that month.
  3. **Saved views** — "Open tasks" (`type=task ∧ state=open`), "Added by
     assistant" (`author=ai`), "Tagged #work" (tag filter) — each opens
     Search pre-filtered. **[ext]** Saved views are configurable in a later
     release; v1 ships exactly these three.
- LOG-31 Collection view: back-to-Index button, title, meta "N items · M
  done", entry rows with date prefixes (`showDate`).
- LOG-32 Review is the activity/revert center:
  - Intro: "Automatic changes" and a concise explanation that agent writes
    apply immediately with attribution and snapshots.
  - Activity cards show time, sentence, MCP token/tool, affected-row summary,
    and before/after detail on expansion.
  - **Revert** renders only when `revert.eligible` is true. Ineligible cards
    expose the server-derived reason (already reverted, newer row mismatch, or
    not reversible) accessibly without offering a blind action. Success toasts
    "Change reverted"; a race-time `409 revert_conflict` keeps the card and
    explains that newer changes were preserved.
- LOG-33 Activity is newest-first, grouped by day, and paged as the user
  scrolls. A revert appends a linked activity item rather than deleting
  history. Empty state: "No automatic changes yet."
- LOG-55 **[ext]** Screens that show a filing target offer a capture invite —
  the monthly log's `+`, its empty-state button, a collection's own add
  control, and the Index rows' `Add to <name>`. An invite presets the
  composer's destination chip to that target and pulls focus into the input
  (retiring the chip when the target is already the screen's own default,
  per LOG-44). It never opens a separate surface: the composer is the only
  place an entry is written.

## 8. Search

- LOG-34 Open via ⌘K / Ctrl-K anywhere, the sidebar Search row, or header
  search button. Dialog = input (auto-focused) + live results.
- LOG-35 Query semantics over non-deleted entries:
  - starts with `#` → exact tag match;
  - otherwise case-insensitive substring on text **or** tag names
    (FTS5-backed with prefix matching **[ext]**; must behave at least as
    permissively as substring for short journals);
  - filter keywords `is:open` (open tasks) and `by:assistant` (AI-authored)
    replace the prototype's magic strings `open`/`claude` **[ext:** the
    magic strings remain as aliases for the saved views**]**.
- LOG-36 Results render as entry rows with date prefixes; toggling/opening
  works in place. Empty state: `No entries match “<query>”.`
- LOG-37 Keyboard: Esc closes any dialog/popover (single Esc, topmost
  first); Enter submits the composer when it has focus.

## 9. Toast & feedback

- LOG-38 One toast at a time, bottom-anchored above the composer,
  auto-dismisses ≈2.4s, replaced by newer toasts. Toasts confirm: capture,
  entry actions, migration completion, activity revert, summary save,
  and token-management actions.
- LOG-39 **[ext]** Live changes arriving over SSE while the app is open
  (e.g. an agent adds an entry) render within 1s without user action; agent
  additions to today may toast once per burst ("Assistant added 2 entries")
  — never once per entry.

## 10. Settings ("Assistant access")

- LOG-40 Dialog shows: MCP endpoint row (mono URL + Connected/Offline pill
  with status dot), explainer ("Agent writes apply automatically, are
  attributed, and can be reverted safely from Review."), the seven-tool
  permission table (five `automatic`, two `read only`), the AI-provider data
  boundary, and token management (SPEC-06 §3).
- LOG-41 Connected state = server reachable ∧ ≥1 active MCP session in the
  last 5 minutes; otherwise show "Ready" (reachable, no agents) or
  "Offline". **[ext]** — the prototype hard-coded "Connected".
- LOG-42 Display preferences (density, type badges, AI highlight — LOG-17)
  live in this dialog too **[ext]**.
