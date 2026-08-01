import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Dialog, ConfirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui/button';
import {
  DIALOG_ACTIONS_END,
  FIELD,
  FIELD_HINT,
  FIELD_SMALL,
  FORM_STACK,
} from '../components/ui/dialog-classes';
import { formatMonth, monthKey } from '../components/dates';
import { cn } from '../lib/utils';
import {
  CARD,
  SECTION,
  SECTION_COPY,
  SECTION_HEADING,
  SECTION_HEADING_ACTION,
  SECTION_TITLE,
} from './view-classes';
import type { JournalCollection, JournalEntry } from '../components/types';

/* `.index-row__main` / `.index-row__edit`: a 46px list row with a hairline-split
   trailing edit affordance. `--solo` rows drop the split and own the divider. */
const INDEX_ROW_MAIN =
  'index-row__main flex min-h-[46px] min-w-0 items-center gap-[9px] pr-[7px] pl-3 text-left hover:bg-bg-hover hover:text-fg';
const INDEX_ROW_SOLO = cn(INDEX_ROW_MAIN, 'w-full border-b border-bg-line pr-3 last:border-b-0');
const INDEX_ROW_LABEL =
  'min-w-0 flex-1 overflow-hidden text-base text-fg text-ellipsis whitespace-nowrap';
const INDEX_ROW_COUNT = 'flex-none text-xs text-fg-mute';

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
      <form className={FORM_STACK} onSubmit={handleSubmit}>
        <label className={FIELD}>
          <span>Name</span>
          <input
            ref={nameRef}
            value={name}
            maxLength={80}
            required
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label className={FIELD}>
          <span>
            Short description <small className={FIELD_SMALL}>optional</small>
          </span>
          <input
            value={note}
            maxLength={160}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        </label>
        {!collection && name ? (
          <p className={FIELD_HINT}>
            Address: <code>/c/{slugify(name) || '…'}</code>
          </p>
        ) : null}
        <div className={DIALOG_ACTIONS_END}>
          {collection && onArchive ? (
            <Button variant="danger" className="mr-auto" onClick={onArchive}>
              Archive
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!name.trim() || !slugify(name)}>
            {collection ? 'Save changes' : 'Create collection'}
          </Button>
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
    <section className="min-h-full" aria-label="Journal index">
      <section className={cn(SECTION, 'index-group pt-4')} aria-labelledby="collections-heading">
        <header className={SECTION_HEADING_ACTION}>
          <div>
            <h2 className={SECTION_TITLE} id="collections-heading">
              Collections
            </h2>
            <p className={SECTION_COPY}>
              Focused lists for ideas, books, projects, and anything worth returning to.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={13} /> New
          </Button>
        </header>
        <div className={CARD}>
          {visibleCollections.length > 0 ? (
            visibleCollections.map((collection) => (
              <div
                className="index-row grid grid-cols-[minmax(0,1fr)_42px] border-b border-bg-line last:border-b-0"
                key={collection.id}
              >
                <button
                  className={INDEX_ROW_MAIN}
                  type="button"
                  onClick={() => onOpenCollection(collection)}
                >
                  <span className={INDEX_ROW_LABEL}>{collection.name}</span>
                  <small className={INDEX_ROW_COUNT}>
                    {collectionCounts.get(collection.id) ?? 0} items
                  </small>
                  <Icon name="chevronRight" size={14} className="flex-none text-fg-faint" />
                </button>
                <button
                  className="grid w-[42px] place-items-center border-l border-bg-line text-fg-mute hover:bg-bg-hover hover:text-fg"
                  type="button"
                  aria-label={`Edit ${collection.name}`}
                  onClick={() => setEditing(collection)}
                >
                  <Icon name="edit" size={13} />
                </button>
              </div>
            ))
          ) : (
            <div className="flex min-h-[62px] items-center justify-center gap-[7px] text-sm text-fg-mute">
              <Icon name="folder" size={16} />
              <span>No collections yet.</span>
            </div>
          )}
        </div>
      </section>

      <section className={cn(SECTION, 'index-group pt-4')} aria-labelledby="months-heading">
        <header className={SECTION_HEADING}>
          <div>
            <h2 className={SECTION_TITLE} id="months-heading">
              Monthly spreads
            </h2>
            <p className={SECTION_COPY}>Your journal, organized one month at a time.</p>
          </div>
        </header>
        <div className={CARD}>
          {months.map(([month, count]) => (
            <button
              className={INDEX_ROW_SOLO}
              type="button"
              key={month}
              onClick={() => onOpenMonth(month)}
            >
              <span className={INDEX_ROW_LABEL}>{formatMonth(month)}</span>
              <small className={INDEX_ROW_COUNT}>
                {count} {count === 1 ? 'entry' : 'entries'}
              </small>
              <Icon name="chevronRight" size={14} className="flex-none text-fg-faint" />
            </button>
          ))}
        </div>
      </section>

      <section className={cn(SECTION, 'index-group pt-4')} aria-labelledby="saved-heading">
        <header className={SECTION_HEADING}>
          <div>
            <h2 className={SECTION_TITLE} id="saved-heading">
              Saved views
            </h2>
            <p className={SECTION_COPY}>Useful cuts through the journal.</p>
          </div>
        </header>
        <div className={CARD}>
          {savedViews.map((view) => (
            <button
              className={INDEX_ROW_SOLO}
              type="button"
              key={view.name}
              onClick={() => onOpenSearch(view.query)}
            >
              <span className={INDEX_ROW_LABEL}>{view.name}</span>
              <small className={INDEX_ROW_COUNT}>{view.count}</small>
              <Icon name="chevronRight" size={14} className="flex-none text-fg-faint" />
            </button>
          ))}
        </div>
      </section>
      <div className="h-6" aria-hidden="true" />

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
