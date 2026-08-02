-- journal:migration-mode additive
--
-- Correct the 008 backfill for filings that named their day.
--
-- 008 stood every pre-existing filing down to undated inventory, assuming a
-- historical filing could only carry the day it happened to be created on.
-- That is wrong wherever a `>` token or an MCP `date` named a different day:
-- those entries are calendar-page items, and standing them down hid them from
-- the very day views this column exists to feed.
--
-- The correction runs once at writable startup and keys off the one signal the
-- data still carries: the server's only default is the creation day, so a date
-- that differs from it cannot have been defaulted. A date equal to the creation
-- day stays inventory, because there it is genuinely indistinguishable from the
-- default and the owner can restate it deliberately.
CREATE TABLE date_stated_restate_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  completed_at TEXT NOT NULL
);
