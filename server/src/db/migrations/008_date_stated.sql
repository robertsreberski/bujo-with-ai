-- journal:migration-mode additive
--
-- Distinguish a day that was chosen from one that merely defaulted.
--
-- Every entry carries a non-null date, and filing into a collection without
-- naming a day stamps today. That made "book flights sometime in August"
-- indistinguishable from "book flights on the 2nd", which is why dated
-- projections had to exclude monthly logs wholesale.
--
-- The column defaults to 1 because a daily-log entry always states its day and
-- the entry invariant would reject the alternative. Standing every pre-existing
-- filing back down to 0 is data healing, not schema, so it runs once at
-- writable startup and records itself in the state table below.
ALTER TABLE entries ADD COLUMN date_stated INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_entries_stated_day ON entries(date, collection)
WHERE deleted_at IS NULL AND date_stated = 1;

CREATE TABLE date_stated_backfill_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  completed_at TEXT NOT NULL
);
