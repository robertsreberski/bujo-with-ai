-- journal:migration-mode additive
ALTER TABLE reflection_slots ADD COLUMN claimed_source_entries TEXT
  CHECK (
    claimed_source_entries IS NULL OR
    (json_valid(claimed_source_entries) AND json_type(claimed_source_entries) = 'array')
  );
