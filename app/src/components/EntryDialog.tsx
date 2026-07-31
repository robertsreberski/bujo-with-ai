import { useMemo, useRef, useState, type FormEvent } from 'react';
import { ConfirmDialog, Dialog } from './Dialog';
import { Icon } from './Icon';
import { entryIcon } from './entry-icons';
import { formatLongDate } from './dates';
import {
  ENTRY_TYPES,
  TYPE_LABELS,
  isActionable,
  type EntryPatch,
  type EntryState,
  type EntryType,
  type JournalCollection,
  type JournalEntry,
} from './types';

interface EntryDialogProps {
  entry: JournalEntry;
  collections: JournalCollection[];
  today: string;
  onClose: () => void;
  onUpdate: (entry: JournalEntry, patch: EntryPatch, message: string) => void;
  onDelete: (entry: JournalEntry) => void;
  onMigrate: (entry: JournalEntry) => void;
  onSchedule: (entry: JournalEntry) => void;
}

const normalizeStateForType = (type: EntryType, state: EntryState): EntryState => {
  const actionable = type === 'task' || type === 'habit';
  if (!actionable) return 'logged';
  return state === 'logged' ? 'open' : state;
};

export function EntryDialog({
  entry,
  collections,
  today,
  onClose,
  onUpdate,
  onDelete,
  onMigrate,
  onSchedule,
}: EntryDialogProps) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [text, setText] = useState(entry.text);
  const [type, setType] = useState<EntryType>(entry.type);
  const [date, setDate] = useState(entry.date);
  const [time, setTime] = useState(entry.time ?? '');
  const [tags, setTags] = useState(entry.tags.join(', '));
  const textRef = useRef<HTMLInputElement>(null);
  const visibleCollections = useMemo(
    () =>
      collections.filter(
        (collection) => !collection.archivedAt && !collection.id.startsWith('month:'),
      ),
    [collections],
  );
  const actionable = isActionable(entry);
  const open = entry.state === 'open';
  const done = entry.state === 'done';
  const normalizedTagTokens = useMemo(
    () =>
      tags
        .split(/[\s,]+/)
        .map((tag) => tag.replace(/^#/, '').toLowerCase())
        .filter(Boolean),
    [tags],
  );
  const invalidTags = useMemo(
    () => [...new Set(normalizedTagTokens.filter((tag) => !/^[a-z0-9-]+$/.test(tag)))],
    [normalizedTagTokens],
  );
  const normalizedTags = useMemo(() => [...new Set(normalizedTagTokens)], [normalizedTagTokens]);
  const tagError =
    invalidTags.length > 0
      ? `Tags use letters, numbers, and hyphens only: ${invalidTags.join(', ')}`
      : null;

  const save = (event: FormEvent) => {
    event.preventDefault();
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    if (!normalizedText || tagError) return;
    onUpdate(
      entry,
      {
        text: normalizedText,
        type,
        state: normalizeStateForType(type, entry.state),
        date,
        time: time || null,
        tags: normalizedTags,
      },
      'Entry updated',
    );
    onClose();
  };

  if (confirmDelete) {
    return (
      <ConfirmDialog
        title="Delete this entry?"
        description="It will disappear from the journal now and remain recoverable from the server for 30 days."
        confirmLabel="Delete entry"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          onDelete(entry);
          onClose();
        }}
      />
    );
  }

  return (
    <Dialog
      title={editing ? 'Edit entry' : entry.text}
      description={editing ? 'Keep it short. One line is the useful constraint.' : undefined}
      onClose={onClose}
      initialFocusRef={editing ? textRef : undefined}
    >
      {editing ? (
        <form className="form-stack" onSubmit={save}>
          <label className="field">
            <span>Text</span>
            <input
              ref={textRef}
              value={text}
              maxLength={500}
              required
              onChange={(event) => setText(event.currentTarget.value)}
            />
          </label>
          <div className="form-grid">
            <label className="field">
              <span>Type</span>
              <select
                value={type}
                onChange={(event) => setType(event.currentTarget.value as EntryType)}
              >
                {ENTRY_TYPES.map((option) => (
                  <option value={option} key={option}>
                    {TYPE_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Date</span>
              <input
                type="date"
                value={date}
                required
                onChange={(event) => setDate(event.currentTarget.value)}
              />
            </label>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>
                Time <small>optional</small>
              </span>
              <input
                type="time"
                value={time}
                onChange={(event) => setTime(event.currentTarget.value)}
              />
            </label>
            <label className="field">
              <span>
                Tags <small>comma-separated</small>
              </span>
              <input
                value={tags}
                onChange={(event) => setTags(event.currentTarget.value)}
                placeholder="work, design"
                aria-invalid={tagError ? true : undefined}
                aria-describedby={tagError ? 'entry-tags-error' : undefined}
              />
              {tagError ? (
                <small className="field-error" id="entry-tags-error" role="alert">
                  {tagError}
                </small>
              ) : null}
            </label>
          </div>
          <div className="dialog-actions dialog-actions--end">
            <button
              className="button button--secondary"
              type="button"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button
              className="button button--primary"
              type="submit"
              disabled={!text.trim() || Boolean(tagError)}
            >
              Save changes
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="entry-detail-fields">
            <div>
              <span>Type</span>
              <strong>
                <Icon name={entryIcon[entry.type]} size={13} /> {TYPE_LABELS[entry.type]}
              </strong>
            </div>
            <div>
              <span>Status</span>
              <strong>
                {entry.state === 'logged'
                  ? 'Logged'
                  : entry.state.replace(/^./, (value) => value.toUpperCase())}
              </strong>
            </div>
            <div>
              <span>Date</span>
              <strong>
                {formatLongDate(entry.date)} {entry.time ? <small>at {entry.time}</small> : null}
              </strong>
            </div>
            <div>
              <span>Tags</span>
              <strong>
                {entry.tags.length ? entry.tags.map((tag) => `#${tag}`).join(' ') : '—'}
              </strong>
            </div>
            <div>
              <span>Filed in</span>
              <strong>
                {entry.collection?.startsWith('month:')
                  ? 'Monthly log'
                  : (visibleCollections.find((collection) => collection.id === entry.collection)
                      ?.name ?? 'Daily log')}
              </strong>
            </div>
            <div>
              <span>Added by</span>
              <strong>{entry.author === 'ai' ? 'Assistant' : 'You'}</strong>
            </div>
          </div>
          {entry.author === 'ai' && entry.source ? (
            <aside className="provenance-panel">
              <header>
                <Icon name="sparkle" size={12} /> <strong>Added automatically</strong>
              </header>
              <p>{entry.source}</p>
            </aside>
          ) : null}
          <div className="entry-detail-actions">
            <button
              className="button button--secondary"
              type="button"
              onClick={() => setEditing(true)}
            >
              <Icon name="edit" size={14} /> Edit
            </button>
            {actionable && (open || done) ? (
              <button
                className="button button--primary"
                type="button"
                onClick={() => {
                  onUpdate(
                    entry,
                    { state: done ? 'open' : 'done' },
                    done ? 'Marked not done' : 'Marked done',
                  );
                  onClose();
                }}
              >
                <Icon name="check" size={14} /> {done ? 'Mark not done' : 'Mark done'}
              </button>
            ) : null}
            {!actionable || open ? (
              <button
                className={actionable ? 'button button--secondary' : 'button button--primary'}
                type="button"
                disabled={entry.date === today && entry.collection === null && !actionable}
                onClick={() => {
                  if (actionable) onMigrate(entry);
                  else onUpdate(entry, { date: today, collection: null }, 'Moved to today');
                  onClose();
                }}
              >
                <Icon name="arrowRight" size={14} /> Move to today
              </button>
            ) : null}
            {actionable && open ? (
              <button
                className="button button--secondary"
                type="button"
                onClick={() => {
                  onSchedule(entry);
                  onClose();
                }}
              >
                <Icon name="calendar" size={14} /> To monthly log
              </button>
            ) : null}
            {!actionable ? (
              <label className="entry-file-control">
                <span className="sr-only">File in collection</span>
                <Icon name="folder" size={14} />
                <select
                  value={entry.collection?.startsWith('month:') ? '' : (entry.collection ?? '')}
                  aria-label="File in collection"
                  onChange={(event) => {
                    onUpdate(
                      entry,
                      { collection: event.currentTarget.value || null },
                      'Entry filed',
                    );
                    onClose();
                  }}
                >
                  <option value="">Daily log</option>
                  {visibleCollections.map((collection) => (
                    <option value={collection.id} key={collection.id}>
                      {collection.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {actionable && open ? (
              <button
                className="button button--danger"
                type="button"
                onClick={() => {
                  onUpdate(entry, { state: 'cancelled' }, 'Dropped');
                  onClose();
                }}
              >
                <Icon name="trash" size={14} /> Drop
              </button>
            ) : !actionable ? (
              <button
                className="button button--danger"
                type="button"
                onClick={() => setConfirmDelete(true)}
              >
                <Icon name="trash" size={14} /> Delete
              </button>
            ) : null}
          </div>
        </>
      )}
    </Dialog>
  );
}
