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
import { formatMonth } from '../components/dates';
import { cn } from '../lib/utils';
import {
  CARD,
  SECTION,
  SECTION_COPY,
  SECTION_HEADING,
  SECTION_HEADING_ACTION,
  SECTION_TITLE,
} from './view-classes';
import type { IndexResponse } from '../api/types';
import type { JournalCollection } from '../components/types';

/* `.index-row__main` / `.index-row__edit`: a 46px list row with a hairline-split
   trailing edit affordance. `--solo` rows drop the split and own the divider. */
const INDEX_ROW_MAIN =
  'index-row__main flex min-h-[46px] min-w-0 items-center gap-[9px] pr-[7px] pl-3 text-left hover:bg-bg-hover hover:text-fg';
const INDEX_ROW_SOLO = cn(INDEX_ROW_MAIN, 'w-full border-b border-bg-line pr-3 last:border-b-0');
const INDEX_ROW_LABEL =
  'min-w-0 flex-1 overflow-hidden text-base text-fg text-ellipsis whitespace-nowrap';
const INDEX_ROW_COUNT = 'flex-none text-xs text-fg-mute';
/** The trailing 42px cells: hairline-split square affordances on the row's edge. */
const INDEX_ROW_ACTION =
  'grid w-[42px] place-items-center border-l border-bg-line text-fg-mute hover:bg-bg-hover hover:text-fg';

interface IndexViewProps {
  index: IndexResponse | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  source: 'none' | 'cached' | 'journal';
  online: boolean;
  error: string | null;
  onRetry: () => void;
  onOpenCollection: (collection: JournalCollection) => void;
  onOpenMonth: (month: string) => void;
  onOpenSearch: (query: string) => void;
  onAddToCollection: (collection: JournalCollection) => void;
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
          <Button
            variant="primary"
            type="submit"
            disabled={!name.trim() || (!collection && !slugify(name))}
          >
            {collection ? 'Save changes' : 'Create collection'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function IndexView({
  index,
  status,
  source,
  online,
  error,
  onRetry,
  onOpenCollection,
  onOpenMonth,
  onOpenSearch,
  onAddToCollection,
  onCreateCollection,
  onUpdateCollection,
}: IndexViewProps) {
  const [editing, setEditing] = useState<JournalCollection | 'new' | null>(null);
  const [archiving, setArchiving] = useState<JournalCollection | null>(null);
  const visibleCollections =
    index?.collections.filter((collection) => !collection.archivedAt) ?? [];
  const archivedCollections =
    index?.collections.filter((collection) => collection.archivedAt !== null) ?? [];
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const collection of index?.collections ?? []) {
      const name = collection.name.toLocaleLowerCase();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
  }, [index]);

  if (index === null) {
    const waiting = status === 'loading' || (status === 'idle' && online);
    return (
      <section className="min-h-full" aria-label="Journal index" aria-busy={waiting}>
        <div className={cn(SECTION, 'index-group pt-4')}>
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-border px-4 py-8 text-center text-sm text-fg-mute">
            {waiting ? (
              <span>Loading journal index…</span>
            ) : (
              <>
                <Icon name={online ? 'folder' : 'wifiOff'} size={18} />
                <div>
                  <p className="text-md text-fg-body">
                    {online
                      ? 'Journal index couldn’t load.'
                      : 'Journal index isn’t on this device yet.'}
                  </p>
                  <p className="mt-1 text-xs">
                    {online
                      ? (error ?? 'Try the bounded index request again.')
                      : 'Reconnect once to download its counts and destinations.'}
                  </p>
                </div>
                <Button variant="secondary" size="sm" disabled={!online} onClick={onRetry}>
                  Retry
                </Button>
              </>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="min-h-full" aria-label="Journal index">
      {!online || source === 'cached' || status === 'error' || status === 'loading' ? (
        <div
          className={cn(
            SECTION,
            'mt-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-line px-3 py-2 text-xs text-fg-mute',
          )}
          role={status === 'error' ? 'alert' : 'status'}
        >
          <span>
            {!online
              ? 'Offline — counts are from the last sync and may be out of date.'
              : status === 'error'
                ? `Couldn’t refresh — showing saved counts that may be out of date.${error ? ` ${error}` : ''}`
                : status === 'loading'
                  ? 'Refreshing counts — showing the last saved snapshot for now.'
                  : 'Showing saved counts until Journal refreshes them.'}
          </span>
          {online && status !== 'loading' ? (
            <Button variant="ghost" size="sm" className="shrink-0" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
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
                className="index-row grid grid-cols-[minmax(0,1fr)_42px_42px] border-b border-bg-line last:border-b-0"
                key={collection.id}
              >
                <button
                  className={INDEX_ROW_MAIN}
                  type="button"
                  onClick={() => onOpenCollection(collection)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block overflow-hidden text-base text-fg text-ellipsis whitespace-nowrap">
                      {collection.name}
                    </span>
                    {duplicateNames.has(collection.name.toLocaleLowerCase()) ? (
                      <small className="block overflow-hidden font-mono text-2xs text-fg-mute text-ellipsis whitespace-nowrap">
                        /{collection.id}
                      </small>
                    ) : null}
                  </span>
                  <small className={INDEX_ROW_COUNT}>
                    {collection.count} {collection.count === 1 ? 'item' : 'items'}
                  </small>
                  <Icon name="chevronRight" size={14} className="flex-none text-fg-faint" />
                </button>
                <button
                  className={INDEX_ROW_ACTION}
                  type="button"
                  aria-label={`Add to ${collection.name}`}
                  onClick={() => onAddToCollection(collection)}
                >
                  <Icon name="plus" size={14} />
                </button>
                <button
                  className={INDEX_ROW_ACTION}
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
          {index.months.length > 0 ? (
            index.months.map(({ month, count }) => (
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
            ))
          ) : (
            <div className="flex min-h-[62px] items-center justify-center gap-[7px] text-sm text-fg-mute">
              <Icon name="calendar" size={16} />
              <span>No monthly spreads yet.</span>
            </div>
          )}
        </div>
      </section>

      {archivedCollections.length > 0 ? (
        <section className={cn(SECTION, 'index-group pt-4')} aria-labelledby="archived-heading">
          <header className={SECTION_HEADING}>
            <div>
              <h2 className={SECTION_TITLE} id="archived-heading">
                Archived collections
              </h2>
              <p className={SECTION_COPY}>Out of the way, with every entry still intact.</p>
            </div>
          </header>
          <div className={CARD}>
            {archivedCollections.map((collection) => (
              <div
                className="index-row grid grid-cols-[minmax(0,1fr)_auto] border-b border-bg-line last:border-b-0"
                key={collection.id}
              >
                <button
                  className={INDEX_ROW_MAIN}
                  type="button"
                  onClick={() => onOpenCollection(collection)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block overflow-hidden text-base text-fg text-ellipsis whitespace-nowrap">
                      {collection.name}
                    </span>
                    <small className="block overflow-hidden font-mono text-2xs text-fg-mute text-ellipsis whitespace-nowrap">
                      /{collection.id}
                    </small>
                  </span>
                  <small className={INDEX_ROW_COUNT}>
                    {collection.count} {collection.count === 1 ? 'item' : 'items'}
                  </small>
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="m-1.5 self-center"
                  aria-label={`Restore ${collection.name} /${collection.id}`}
                  onClick={() => onUpdateCollection(collection.id, { archived: false })}
                >
                  Restore
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {index.savedViews.length > 0 ? (
        <section className={cn(SECTION, 'index-group pt-4')} aria-labelledby="saved-heading">
          <header className={SECTION_HEADING}>
            <div>
              <h2 className={SECTION_TITLE} id="saved-heading">
                Saved views
              </h2>
              <p className={SECTION_COPY}>Queries you chose to keep close.</p>
            </div>
          </header>
          <div className={CARD}>
            {index.savedViews.map((view) => (
              <button
                className={INDEX_ROW_SOLO}
                type="button"
                key={view.id}
                onClick={() => onOpenSearch(view.query)}
              >
                <span className="min-w-0 flex-1">
                  <span className={INDEX_ROW_LABEL}>{view.name}</span>
                  <small className="block overflow-hidden font-mono text-2xs text-fg-mute text-ellipsis whitespace-nowrap">
                    {view.query}
                  </small>
                </span>
                <small className={INDEX_ROW_COUNT}>{view.count}</small>
                <Icon name="chevronRight" size={14} className="flex-none text-fg-faint" />
              </button>
            ))}
          </div>
        </section>
      ) : null}
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
          description="Its entries remain safe and searchable. Restore it later from Archived collections."
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
