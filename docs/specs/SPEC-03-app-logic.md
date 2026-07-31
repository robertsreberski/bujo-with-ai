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
- LOG-3 Review has no pending-count badge. Agent writes are immediate; Review
  is a chronological activity/revert destination, not an inbox.
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
  2. **Tags** — every `#[A-Za-z0-9-]+` anywhere; consumed; lowercased and
     de-duplicated into `tags`. Underscore is deliberately not valid.
  3. **Time** — first `@H`, `@H:MM`, `@Ham/pm`, `@H:MMam/pm`;
     12h converts to 24h (12am → 00); consumed; result `HH:MM`.
  4. **Date shift** — `>tomorrow` (case-insensitive) sets the target date to
     today+1; consumed. (Other targets: FR-39, P2.)
  5. Remaining text is whitespace-collapsed and becomes `text`.
- LOG-7 Parse preview chips render above the input while the draft is
  non-empty, in order: type label, `at HH:MM`, one chip per `#tag`,
  `tomorrow`. When the draft is empty a hint line shows instead:
  `Shortcuts: . task · o event · - note · #tag · @3pm · >tomorrow`.
- LOG-8 The type button reflects the _parsed_ type (icon + label) live and
  opens the type menu; picking a type there sets the default for drafts
  without a signifier.

### 2.2 Submit

- LOG-9 Submit (Enter or the + button) with empty parsed text is a no-op.
  Otherwise create the entry: parsed fields; date intent = today (or shifted);
  `state` = `open` for task/habit else `logged`; `author: 'me'`;
  `collection: null`; clear the draft; navigate to Today; toast
  "Added to today". Offline commands freeze capture time, last server today,
  timezone, and date intent so replay after midnight preserves intent.
- LOG-10 Creation is optimistic: the entry renders immediately from the local
  store and reconciles through the outbox (SPEC-07). Capture must never block
  on the network.

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
