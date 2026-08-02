ALTER TABLE reflection_slots ADD COLUMN claimed_source_entries TEXT
  CHECK (
    claimed_source_entries IS NULL OR
    (json_valid(claimed_source_entries) AND json_type(claimed_source_entries) = 'array')
  );

-- A claim created by an older runtime has no trustworthy source binding. Put
-- it back in the durable queue so a current worker can claim a pinned source
-- set before completing it.
UPDATE reflection_slots
SET
  status = 'queued',
  claimed_at = NULL,
  claimed_token_id = NULL,
  claimed_label = NULL,
  claimed_tool = NULL,
  claimed_source_entries = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  revision = revision + 1
WHERE status = 'running';

-- Older releases could leave a saved Summary pointing at an entry in trash.
-- Repair those rows once so readonly portable exports remain schema-valid.
UPDATE summaries
SET
  status = CASE
    WHEN EXISTS (
      SELECT 1 FROM reflection_slots AS reflection
      WHERE reflection.week_start = summaries.week_start
        AND reflection.status = 'current'
    ) THEN 'current'
    ELSE 'stale'
  END,
  saved_entry_id = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  revision = revision + 1
WHERE status = 'saved'
  AND NOT EXISTS (
    SELECT 1 FROM entries
    WHERE entries.id = summaries.saved_entry_id
      AND entries.deleted_at IS NULL
      AND entries.author = 'ai'
      AND entries.type = 'note'
      AND EXISTS (
        SELECT 1 FROM json_each(entries.tags) WHERE value = 'summary'
      )
  );

-- A portable document imported by an older runtime could contain Activity for
-- an entry that was omitted from the document. With no entry tombstone, the
-- ordinary retention purge could never discover that content. Scrub those
-- legacy orphan references while retaining the audit envelope and alignment.
UPDATE activity
SET
  text = CASE kind
    WHEN 'agent-add' THEN 'Added an entry (content expired)'
    WHEN 'agent-update' THEN 'Updated an entry (content expired)'
    WHEN 'agent-delete' THEN 'Deleted an entry (content expired)'
    WHEN 'agent-migration' THEN 'Migrated entries (content expired)'
    WHEN 'summary-filed' THEN 'Filed a reflection (content expired)'
    WHEN 'summary-saved' THEN 'Saved a reflection (content expired)'
    WHEN 'revert' THEN 'Reverted a change (content expired)'
  END,
  pre_images = (
    SELECT coalesce(
      json_group_array(
        json(
          CASE
            WHEN json_extract(snapshot.value, '$.entity') = 'entry'
              AND NOT EXISTS (
                SELECT 1 FROM entries
                WHERE entries.id = json_extract(snapshot.value, '$.id')
              )
            THEN json_set(snapshot.value, '$.row', NULL)
            ELSE snapshot.value
          END
        )
      ),
      '[]'
    )
    FROM json_each(activity.pre_images) AS snapshot
  ),
  post_images = (
    SELECT coalesce(
      json_group_array(
        json(
          CASE
            WHEN json_extract(snapshot.value, '$.entity') = 'entry'
              AND NOT EXISTS (
                SELECT 1 FROM entries
                WHERE entries.id = json_extract(snapshot.value, '$.id')
              )
            THEN json_set(snapshot.value, '$.row', NULL)
            ELSE snapshot.value
          END
        )
      ),
      '[]'
    )
    FROM json_each(activity.post_images) AS snapshot
  )
WHERE EXISTS (
    SELECT 1
    FROM json_each(activity.refs, '$.entryIds') AS ref
    WHERE NOT EXISTS (SELECT 1 FROM entries WHERE entries.id = ref.value)
  )
  OR EXISTS (
    SELECT 1
    FROM json_each(activity.pre_images) AS snapshot
    WHERE json_extract(snapshot.value, '$.entity') = 'entry'
      AND NOT EXISTS (
        SELECT 1 FROM entries WHERE entries.id = json_extract(snapshot.value, '$.id')
      )
  )
  OR EXISTS (
    SELECT 1
    FROM json_each(activity.post_images) AS snapshot
    WHERE json_extract(snapshot.value, '$.entity') = 'entry'
      AND NOT EXISTS (
        SELECT 1 FROM entries WHERE entries.id = json_extract(snapshot.value, '$.id')
      )
  );
