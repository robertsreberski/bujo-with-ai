-- journal:migration-mode additive
ALTER TABLE settings
  ADD COLUMN saved_views TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(saved_views) AND json_type(saved_views) = 'array');
