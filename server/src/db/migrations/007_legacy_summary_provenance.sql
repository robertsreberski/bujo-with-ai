-- journal:migration-mode additive
ALTER TABLE reflection_slots ADD COLUMN legacy_summary_id TEXT;

CREATE TABLE summary_reflection_reverts (
  activity_id TEXT PRIMARY KEY,
  reflection_id TEXT NOT NULL,
  legacy_summary_id TEXT,
  pre_state TEXT NOT NULL CHECK (
    json_valid(pre_state) AND json_type(pre_state) IN ('null', 'object')
  ),
  post_state TEXT NOT NULL CHECK (
    json_valid(post_state) AND json_type(post_state) = 'object'
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE legacy_summary_reconciliation_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  completed_at TEXT NOT NULL
);
