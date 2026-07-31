import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Dialog, ConfirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { formatMonth, monthKey } from '../components/dates';
import type { JournalCollection, JournalEntry } from '../components/types';

interface IndexViewProps {
  collections: JournalCollection[];
  entries: JournalEntry[];
  onOpenCollection: (collection: JournalCollection) => void;
  onOpenMonth: (month: string) => void;
  onOpenSearch: (query: string) => void;
  onCreateCollection: (input: { id: string; name: string; note: string | null }) => void;
  onUpdateCollection: (
    id: string,
    patch: { name?: string; note?: string | null; archived?: boolean },
  ) => void;
}

const slugify = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);

interface CollectionEditorProps {
  collection?: JournalCollection | undefined;
  onSave: (input: { id: string; name: string; note: string | null }) => void;
  onClose: () => void;
  onArchive?: (() => void) | undefined;
}

function CollectionEditor({ collection, onSave, onClose, onArchive }: CollectionEditorProps) {
  const [name, setName] = useState(collection?.name ?? '');
  const [note, setNote] = useState(collection?.note ?? '');
  const nameRef = useRef<HTMLInputElement>(null);
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const normalizedName = name.trim();
    const id = collection?.id ?? slugify(normalizedName);
    if (!normalizedName || !id) return;
    onSave({ id, name: normalizedName, note: note.trim() || null });
  };
  return (
    <Dialog
      title={collection ? 'Edit collection' : 'New collection'}
      description="Collections stay flat and focused: one list, one purpose."
      onClose={onClose}
      initialFocusRef={nameRef}
    >
      <form className="form-stack" onSubmit={handleSubmit}>
        <label className="field">
          <span>Name</span>
          <input
            ref={nameRef}
            value={name}
            maxLength={80}
            required
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label className="field">
          <span>
            Short description <small>optional</small>
          </span>
          <input
            value={note}
            maxLength={160}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        </label>
        {!collection && name ? (
          <p className="field-hint">
            Address: <code>/c/{slugify(name) || '…'}</code>
          </p>
        ) : null}
        <div className="dialog-actions dialog-actions--end">
          {collection && onArchive ? (
            <button
              className="button button--danger dialog-actions__leading"
              type="button"
              onClick={onArchive}
            >
              Archive
            </button>
          ) : null}
          <button className="button button--secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button button--primary"
            type="submit"
            disabled={!name.trim() || !slugify(name)}
          >
            {collection ? 'Save changes' : 'Create collection'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const savedViews = [
  { name: 'Open tasks', count: 'is:open', query: 'is:open' },
  { name: 'Added by assistant', count: 'by:assistant', query: 'by:assistant' },
  { name: 'Tagged #work', count: '#work', query: '#work' },
];

export function IndexView({
  collections,
  entries,
  onOpenCollection,
  onOpenMonth,
  onOpenSearch,
  onCreateCollection,
  onUpdateCollection,
}: IndexViewProps) {
  const [editing, setEditing] = useState<JournalCollection | 'new' | null>(null);
  const [archiving, setArchiving] = useState<JournalCollection | null>(null);
  const visibleCollections = collections.filter(
    (collection) => !collection.archivedAt && !collection.id.startsWith('month:'),
  );
  const collectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      if (entry.collection) counts.set(entry.collection, (counts.get(entry.collection) ?? 0) + 1);
    }
    return counts;
  }, [entries]);
  const months = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const month = entry.collection?.startsWith('month:')
        ? entry.collection.slice(6)
        : monthKey(entry.date);
      counts.set(month, (counts.get(month) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([left], [right]) => right.localeCompare(left));
  }, [entries]);

  return (
    <section className="screen index-screen" aria-label="Journal index">
      <section className="index-group" aria-labelledby="collections-heading">
        <header className="section-heading section-heading--action">
          <div>
            <h2 id="collections-heading">Collections</h2>
            <p>Focused lists for ideas, books, projects, and anything worth returning to.</p>
          </div>
          <button
            className="button button--secondary button--small"
            type="button"
            onClick={() => setEditing('new')}
          >
            <Icon name="plus" size={13} /> New
          </button>
        </header>
        <div className="index-card">
          {visibleCollections.length > 0 ? (
            visibleCollections.map((collection) => (
              <div className="index-row" key={collection.id}>
                <button
                  className="index-row__main"
                  type="button"
                  onClick={() => onOpenCollection(collection)}
                >
                  <span>{collection.name}</span>
                  <small>{collectionCounts.get(collection.id) ?? 0} items</small>
                  <Icon name="chevronRight" size={14} />
                </button>
                <button
                  className="index-row__edit"
                  type="button"
                  aria-label={`Edit ${collection.name}`}
                  onClick={() => setEditing(collection)}
                >
                  <Icon name="edit" size={13} />
                </button>
              </div>
            ))
          ) : (
            <div className="index-empty">
              <Icon name="folder" size={16} />
              <span>No collections yet.</span>
            </div>
          )}
        </div>
      </section>

      <section className="index-group" aria-labelledby="months-heading">
        <header className="section-heading">
          <div>
            <h2 id="months-heading">Monthly spreads</h2>
            <p>Your journal, organized one month at a time.</p>
          </div>
        </header>
        <div className="index-card">
          {months.map(([month, count]) => (
            <button
              className="index-row__main index-row__main--solo"
              type="button"
              key={month}
              onClick={() => onOpenMonth(month)}
            >
              <span>{formatMonth(month)}</span>
              <small>
                {count} {count === 1 ? 'entry' : 'entries'}
              </small>
              <Icon name="chevronRight" size={14} />
            </button>
          ))}
        </div>
      </section>

      <section className="index-group" aria-labelledby="saved-heading">
        <header className="section-heading">
          <div>
            <h2 id="saved-heading">Saved views</h2>
            <p>Useful cuts through the journal.</p>
          </div>
        </header>
        <div className="index-card">
          {savedViews.map((view) => (
            <button
              className="index-row__main index-row__main--solo"
              type="button"
              key={view.name}
              onClick={() => onOpenSearch(view.query)}
            >
              <span>{view.name}</span>
              <small>{view.count}</small>
              <Icon name="chevronRight" size={14} />
            </button>
          ))}
        </div>
      </section>
      <div className="screen-end" aria-hidden="true" />

      {editing ? (
        <CollectionEditor
          collection={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onArchive={
            editing === 'new'
              ? undefined
              : () => {
                  setArchiving(editing);
                  setEditing(null);
                }
          }
          onSave={(input) => {
            if (editing === 'new') onCreateCollection(input);
            else onUpdateCollection(editing.id, { name: input.name, note: input.note });
            setEditing(null);
          }}
        />
      ) : null}
      {archiving ? (
        <ConfirmDialog
          title={`Archive ${archiving.name}?`}
          description="Its entries remain safe and searchable. Creating this collection again will restore it."
          confirmLabel="Archive collection"
          onCancel={() => setArchiving(null)}
          onConfirm={() => {
            onUpdateCollection(archiving.id, { archived: true });
            setArchiving(null);
          }}
        />
      ) : null}
    </section>
  );
}
