CREATE TABLE reflection_slots (
  id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL UNIQUE CHECK (week_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  week_end TEXT NOT NULL CHECK (week_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('notRequested','queued','running','current','stale','failed')),
  request_id TEXT,
  requested_at TEXT,
  claimed_at TEXT,
  claimed_token_id TEXT,
  claimed_label TEXT,
  claimed_tool TEXT,
  failure TEXT,
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK ((request_id IS NULL) = (requested_at IS NULL)),
  CHECK ((claimed_at IS NULL) = (claimed_token_id IS NULL)),
  CHECK ((claimed_at IS NULL) = (claimed_label IS NULL)),
  CHECK ((status = 'failed') = (failure IS NOT NULL))
);

CREATE TABLE reflection_versions (
  id TEXT PRIMARY KEY,
  reflection_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 500),
  source_from TEXT NOT NULL CHECK (source_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  source_to TEXT NOT NULL CHECK (source_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  generator_token_id TEXT NOT NULL,
  generator_label TEXT NOT NULL CHECK (length(trim(generator_label)) BETWEEN 1 AND 80),
  generator_tool TEXT,
  source TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 1 AND 300),
  generated_at TEXT NOT NULL,
  source_entries TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_entries) AND json_type(source_entries) = 'array'),
  FOREIGN KEY (reflection_id) REFERENCES reflection_slots(id) ON DELETE CASCADE,
  UNIQUE (reflection_id, version_number)
);

CREATE INDEX idx_reflection_slots_week ON reflection_slots(week_start DESC);
CREATE INDEX idx_reflection_versions_slot ON reflection_versions(reflection_id, version_number DESC);

INSERT INTO reflection_slots(
  id, week_start, week_end, status, request_id, requested_at, claimed_at,
  claimed_token_id, claimed_label, claimed_tool, failure, current_version_id,
  created_at, updated_at, revision
)
SELECT
  id,
  week_start,
  date(week_start, '+6 days'),
  CASE status WHEN 'stale' THEN 'stale' ELSE 'current' END,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  id,
  created_at,
  updated_at,
  revision
FROM summaries;

INSERT INTO reflection_versions(
  id, reflection_id, version_number, text, source_from, source_to,
  generator_token_id, generator_label, generator_tool, source, generated_at,
  source_entries
)
SELECT
  id,
  id,
  1,
  text,
  week_start,
  date(week_start, '+6 days'),
  token_id,
  'Legacy assistant',
  NULL,
  source,
  updated_at,
  '[]'
FROM summaries;
