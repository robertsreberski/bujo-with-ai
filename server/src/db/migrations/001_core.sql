CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  type TEXT NOT NULL CHECK (type IN ('task','event','note','idea','question','habit','mood')),
  text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 500 AND instr(text, char(10)) = 0 AND instr(text, char(13)) = 0),
  state TEXT NOT NULL CHECK (state IN ('open','done','logged','migrated','scheduled','cancelled')),
  time TEXT CHECK (time IS NULL OR time GLOB '[0-2][0-9]:[0-5][0-9]'),
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  author TEXT NOT NULL CHECK (author IN ('me','ai')),
  source TEXT,
  migrations INTEGER NOT NULL DEFAULT 0 CHECK (migrations >= 0),
  collection TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (author = 'me' OR length(trim(coalesce(source, ''))) > 0),
  CHECK (
    (type IN ('task','habit') AND state IN ('open','done','migrated','scheduled','cancelled')) OR
    (type NOT IN ('task','habit') AND state = 'logged')
  )
);
CREATE INDEX idx_entries_date ON entries(date, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_entries_collection ON entries(collection, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_entries_state ON entries(state, date DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_entries_author ON entries(author, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  note TEXT CHECK (note IS NULL OR length(note) <= 300),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE summaries (
  id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL UNIQUE CHECK (week_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','stale','saved')),
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  token_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  saved_entry_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE INDEX idx_summaries_created ON summaries(created_at DESC);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'agent-add','agent-update','agent-delete','agent-migration',
    'summary-filed','summary-saved','revert'
  )),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  origin TEXT NOT NULL CHECK (json_valid(origin) AND json_type(origin) = 'object'),
  refs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(refs) AND json_type(refs) = 'object'),
  pre_images TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pre_images) AND json_type(pre_images) = 'array'),
  post_images TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(post_images) AND json_type(post_images) = 'array'),
  reverted_at TEXT,
  reverted_by_activity_id TEXT,
  CHECK ((reverted_at IS NULL) = (reverted_by_activity_id IS NULL))
);
CREATE INDEX idx_activity_at ON activity(at DESC);

CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 80),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  scopes TEXT NOT NULL DEFAULT '["journal:full"]' CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  rate_window_start TEXT,
  rate_write_count INTEGER NOT NULL DEFAULT 0 CHECK (rate_write_count >= 0)
);
CREATE INDEX idx_agent_tokens_active ON agent_tokens(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE device_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_device_tokens_active ON device_tokens(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  density TEXT NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable','compact')),
  show_type_badges INTEGER NOT NULL DEFAULT 1 CHECK (show_type_badges IN (0,1)),
  highlight_ai_entries INTEGER NOT NULL DEFAULT 1 CHECK (highlight_ai_entries IN (0,1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE processed_mutations (
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status_code INTEGER NOT NULL CHECK (status_code BETWEEN 200 AND 599),
  result TEXT NOT NULL CHECK (json_valid(result)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_type, actor_id, mutation_id)
);
CREATE INDEX idx_processed_mutations_created ON processed_mutations(created_at);
