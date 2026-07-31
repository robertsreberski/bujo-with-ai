CREATE VIRTUAL TABLE entries_fts USING fts5(
  text,
  tags,
  content='entries',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;
CREATE TRIGGER entries_fts_delete AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, text, tags)
  VALUES ('delete', old.rowid, old.text, old.tags);
END;
CREATE TRIGGER entries_fts_update AFTER UPDATE OF text, tags ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, text, tags)
  VALUES ('delete', old.rowid, old.text, old.tags);
  INSERT INTO entries_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;
INSERT INTO entries_fts(entries_fts) VALUES ('rebuild');
