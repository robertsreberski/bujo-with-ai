import { useEffect, useMemo, useRef, useState } from 'react';
import { Drawer } from 'vaul';
import { EntryDetailFields } from './EntryDetailFields';
import { EntryEditForm } from './EntryEditForm';
import { Icon } from './Icon';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { buildEntryActions, type EntryActionId } from './entry-actions';
import { entryIcon } from './entry-icons';
import { cn } from '../lib/utils';
import {
  isActionable,
  stateLabel,
  TYPE_LABELS,
  type EntryPatch,
  type JournalCollection,
  type JournalEntry,
} from './types';

export interface EntryActionSheetProps {
  entry: JournalEntry;
  collections: JournalCollection[];
  today: string;
  /** The month the surrounding view is showing, or null outside the month log. */
  contextMonth: string | null;
  onClose: () => void;
  onUpdate: (entry: JournalEntry, patch: EntryPatch, message: string) => void;
  onDelete: (entry: JournalEntry) => void;
  onMigrate: (entry: JournalEntry) => void;
  onSchedule: (entry: JournalEntry) => void;
}

/** Which face of the sheet is showing. Every face is the same sheet, swapped. */
type SheetView = 'actions' | 'file' | 'delete' | 'edit';

/*
 * Vaul ships its own motion in an injected stylesheet: a 500ms
 * `cubic-bezier(.32,.72,0,1)` slide for the panel and fade for the scrim, plus
 * an inline `transition` it writes on the panel when a drag is released. DS-24
 * allows 160ms on the dialog curve, so both are overridden here.
 *
 * The `!` is load-bearing twice over: vaul's rules are attribute selectors
 * (specificity 0-2-0, above a utility class) and its release transition is an
 * inline style, which only an important declaration can outrank. The overrides
 * are `motion-safe:` so the global `prefers-reduced-motion` reset in base.css
 * keeps winning on its own terms; under reduced motion the panel is re-pointed
 * at the app's opacity-only `overlay-in` keyframes, dropping the slide (DS-25).
 */
const SHEET_MOTION =
  'motion-safe:[animation-duration:160ms]! motion-safe:[animation-timing-function:cubic-bezier(0.16,1,0.3,1)]! motion-reduce:[animation-name:overlay-in]!';

const PANEL_MOTION = cn(
  SHEET_MOTION,
  'motion-safe:[transition-duration:160ms]! motion-safe:[transition-timing-function:cubic-bezier(0.16,1,0.3,1)]!',
);

/*
 * The panel is anchored to the *visible* viewport rather than the layout one:
 * `--vv-offset`/`--vv-height` track the visual viewport, so an open iOS
 * keyboard lifts the sheet instead of hiding it. `--app-height` is the layout
 * height the `bottom` inset is measured against. Vaul's own `repositionInputs`
 * is disabled for the same reason — two mechanisms moving one panel fight.
 */
const PANEL_BOTTOM =
  'bottom-[calc(var(--app-height,100dvh)_-_var(--vv-offset,0px)_-_var(--vv-height,100dvh))]';

const PANEL_HEIGHT = 'max-h-[calc(var(--vv-height,100dvh)_-_48px)]';

/** A 48px full-width action row: icon, label, and an optional trailing hint. */
const SHEET_ROW =
  'flex min-h-12 w-full items-center gap-3 px-4 text-left text-base hover:bg-bg-hover';

/** The 44px rows of the filing picker. */
const PICK_ROW =
  'flex min-h-11 w-full items-center gap-3 px-4 text-left text-base text-fg-body hover:bg-bg-hover';

const SHEET_HINT = 'flex-none text-xs text-fg-mute';

const DELETE_DESCRIPTION =
  'It will disappear from the journal now and remain recoverable from the server for 30 days.';

const VIEW_TITLE: Record<SheetView, string> = {
  actions: '',
  file: 'File in collection',
  delete: 'Delete this entry?',
  edit: 'Edit entry',
};

/**
 * The coarse-pointer face of one entry: the same action set the desktop dialog
 * renders, as thumb-sized rows in a bottom sheet. Filing, deleting, and editing
 * swap the sheet's content instead of stacking another surface on top of it, so
 * a phone never has two modal layers competing for the same 400px of screen.
 *
 * Actions come from `buildEntryActions` and fire exactly what `EntryDialog`
 * fires, so an entry can never be offered more (or less) on one pointer type.
 */
export function EntryActionSheet({
  entry,
  collections,
  today,
  contextMonth,
  onClose,
  onUpdate,
  onDelete,
  onMigrate,
  onSchedule,
}: EntryActionSheetProps) {
  const [view, setView] = useState<SheetView>('actions');
  const textRef = useRef<HTMLInputElement>(null);
  const visibleCollections = useMemo(
    () =>
      collections.filter(
        (collection) => !collection.archivedAt && !collection.id.startsWith('month:'),
      ),
    [collections],
  );
  const actions = useMemo(
    () => buildEntryActions(entry, { contextMonth, today }).filter((action) => action.available),
    [contextMonth, entry, today],
  );
  const filedIn = entry.collection?.startsWith('month:')
    ? 'Monthly log'
    : (visibleCollections.find((collection) => collection.id === entry.collection)?.name ??
      'Daily log');

  // Editing is the one face that wants the keyboard immediately; the others are
  // thumb targets and would only lose height to it.
  useEffect(() => {
    if (view === 'edit') textRef.current?.focus();
  }, [view]);

  const activate = (id: EntryActionId) => {
    switch (id) {
      case 'edit':
        setView('edit');
        return;
      case 'toggle-done':
        onUpdate(
          entry,
          { state: entry.state === 'done' ? 'open' : 'done' },
          entry.state === 'done' ? 'Marked not done' : 'Marked done',
        );
        break;
      case 'move-to-today':
        if (isActionable(entry)) onMigrate(entry);
        else onUpdate(entry, { date: today, collection: null }, 'Moved to today');
        break;
      case 'schedule-month':
        onSchedule(entry);
        break;
      case 'drop':
        onUpdate(entry, { state: 'cancelled' }, 'Dropped');
        break;
      case 'delete':
        setView('delete');
        return;
      case 'file-collection':
        // Filing carries a value, so the picker face drives it directly.
        setView('file');
        return;
    }
    onClose();
  };

  const file = (collection: string | null) => {
    onUpdate(entry, { collection }, 'Entry filed');
    onClose();
  };

  const displayState = stateLabel(entry);
  const description =
    view === 'delete'
      ? DELETE_DESCRIPTION
      : view === 'edit'
        ? 'Keep it short. One line is the useful constraint.'
        : view === 'file'
          ? `Currently in ${filedIn}.`
          : `${TYPE_LABELS[entry.type]}${displayState ? ` · ${displayState}` : ''}`;

  return (
    <Drawer.Root
      open
      repositionInputs={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Drawer.Portal>
        <Drawer.Overlay
          className={cn('entry-sheet__scrim fixed inset-0 z-(--z-scrim) bg-overlay', SHEET_MOTION)}
        />
        <Drawer.Content
          className={cn(
            'entry-sheet fixed inset-x-0 z-(--z-menu) mx-auto flex w-full max-w-[560px] flex-col rounded-t-2xl border-t border-border bg-bg outline-none',
            PANEL_BOTTOM,
            PANEL_HEIGHT,
            PANEL_MOTION,
          )}
        >
          <div
            className="mx-auto my-2 h-1 w-9 flex-none rounded-full bg-border-strong"
            aria-hidden="true"
          />
          <header className="flex-none px-4 pb-2.5">
            {/* The back control sits beside the title rather than inside it, so
                the sheet's accessible name stays the title alone. */}
            <div className="flex items-center gap-2">
              {view === 'actions' ? null : (
                <Button
                  variant="ghost"
                  size="icon"
                  className="-ml-1.5 size-9 flex-none"
                  aria-label="Back to actions"
                  onClick={() => setView('actions')}
                >
                  <Icon name="chevronLeft" size={16} />
                </Button>
              )}
              <Drawer.Title className="min-w-0 text-base leading-[1.45] font-medium text-pretty text-fg">
                {view === 'actions' ? entry.text : VIEW_TITLE[view]}
              </Drawer.Title>
            </div>
            <Drawer.Description className="flex flex-wrap items-center gap-1.5 pt-1 text-sm text-fg-mute">
              {view === 'actions' ? (
                <>
                  <Badge variant="type" className="badge badge--type">
                    <Icon name={entryIcon[entry.type]} size={10} /> {TYPE_LABELS[entry.type]}
                  </Badge>
                  {displayState ? (
                    <Badge variant="state" className="badge badge--state">
                      {displayState}
                    </Badge>
                  ) : null}
                  {entry.author === 'ai' ? (
                    <Badge variant="ai" className="badge badge--ai" aria-label="Added by assistant">
                      <Icon name="sparkle" size={10} />
                    </Badge>
                  ) : null}
                </>
              ) : (
                description
              )}
            </Drawer.Description>
          </header>
          <div className="scrollable min-h-0 flex-1 pb-[max(16px,var(--sab))]">
            {view === 'actions' ? (
              <>
                <details className="border-y border-bg-line">
                  <summary className={cn(SHEET_ROW, 'cursor-pointer list-none text-fg-body')}>
                    <Icon name="info" size={16} />
                    <span className="min-w-0 flex-1">Details</span>
                    <Icon name="chevronDown" size={14} className="flex-none text-fg-faint" />
                  </summary>
                  <div className="px-4 pt-1 pb-3">
                    <EntryDetailFields entry={entry} collections={visibleCollections} />
                  </div>
                </details>
                {actions.map((action) => (
                  <button
                    className={cn(
                      SHEET_ROW,
                      action.destructive
                        ? 'text-danger'
                        : action.primary
                          ? 'text-primary'
                          : 'text-fg-body',
                      action.disabled && 'pointer-events-none opacity-50',
                    )}
                    type="button"
                    disabled={action.disabled}
                    key={action.id}
                    onClick={() => activate(action.id)}
                  >
                    <Icon name={action.icon} size={16} />
                    <span className="min-w-0 flex-1">{action.label}</span>
                    {action.id === 'file-collection' ? (
                      <>
                        <span className={SHEET_HINT}>{filedIn}</span>
                        <Icon name="chevronRight" size={14} className="flex-none text-fg-faint" />
                      </>
                    ) : null}
                  </button>
                ))}
              </>
            ) : null}

            {view === 'file' ? (
              <>
                <button
                  className={cn(PICK_ROW, 'border-t border-bg-line')}
                  type="button"
                  onClick={() => file(null)}
                >
                  <Icon name="note" size={16} />
                  <span className="min-w-0 flex-1">Daily log</span>
                  {entry.collection === null ? (
                    <Icon name="check" size={15} className="flex-none text-primary" />
                  ) : null}
                </button>
                {visibleCollections.map((collection) => (
                  <button
                    className={PICK_ROW}
                    type="button"
                    key={collection.id}
                    onClick={() => file(collection.id)}
                  >
                    <Icon name="folder" size={16} />
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                      {collection.name}
                    </span>
                    {entry.collection === collection.id ? (
                      <Icon name="check" size={15} className="flex-none text-primary" />
                    ) : null}
                  </button>
                ))}
              </>
            ) : null}

            {view === 'delete' ? (
              <div className="flex gap-2 px-4 pt-1.5">
                <Button
                  variant="secondary"
                  size="lg"
                  className="flex-1"
                  onClick={() => setView('actions')}
                >
                  Cancel
                </Button>
                <Button
                  variant="dangerFilled"
                  size="lg"
                  className="flex-1"
                  onClick={() => {
                    onDelete(entry);
                    onClose();
                  }}
                >
                  Delete entry
                </Button>
              </div>
            ) : null}

            {view === 'edit' ? (
              <div className="px-4 pt-1.5">
                <EntryEditForm
                  entry={entry}
                  textRef={textRef}
                  onCancel={() => setView('actions')}
                  onSave={(patch) => {
                    onUpdate(entry, patch, 'Entry updated');
                    onClose();
                  }}
                />
              </div>
            ) : null}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
