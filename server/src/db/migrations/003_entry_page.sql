CREATE INDEX idx_entries_page
ON entries(date DESC, created_at DESC, id DESC)
WHERE deleted_at IS NULL;
