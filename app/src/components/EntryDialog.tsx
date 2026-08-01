import { useMemo, useRef, useState } from 'react';
import { ConfirmDialog, Dialog } from './Dialog';
import { EntryDetailFields } from './EntryDetailFields';
import { EntryEditForm } from './EntryEditForm';
import { Icon } from './Icon';
import { Button, type ButtonVariant } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { ACTION_GRID } from './ui/dialog-classes';
import {
  buildEntryActions,
  monthCollectionLabel,
  type EntryAction,
  type EntryActionId,
} from './entry-actions';
import { isActionable, type EntryPatch, type JournalCollection, type JournalEntry } from './types';

interface EntryDialogProps {
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

const FILE_CONTROL =
  'flex min-h-[34px] min-w-0 items-center gap-1.5 rounded-md border border-border-control bg-bg pl-2.5 text-fg touch:min-h-10';

const variantFor = (action: EntryAction): ButtonVariant => {
  if (action.destructive) return 'danger';
  return action.primary ? 'primary' : 'secondary';
};

/**
 * The pointer-fine surface for one entry: facts, actions, edit form, and the
 * delete confirmation. The action row renders straight from
 * `buildEntryActions`, so a coarse-pointer sheet built on the same descriptors
 * offers exactly the same set.
 */
export function EntryDialog({
  entry,
  collections,
  today,
  contextMonth,
  onClose,
  onUpdate,
  onDelete,
  onMigrate,
  onSchedule,
}: EntryDialogProps) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  // The select names the entry's real filing, monthly logs included, so it can
  // never claim "Daily log" for something the daily log does not hold. A
  // monthly log is not a fileable destination, so its option is inert: it shows
  // where the entry is, and picking anything else is an explicit move out.
  const filedValue = entry.collection ?? '';
  const filedMonth = monthCollectionLabel(entry.collection);

  const activate = (id: EntryActionId) => {
    switch (id) {
      case 'edit':
        setEditing(true);
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
        setConfirmDelete(true);
        return;
      case 'file-collection':
        // Filing carries a value, so the select drives it directly.
        return;
    }
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
        <EntryEditForm
          entry={entry}
          textRef={textRef}
          onCancel={() => setEditing(false)}
          onSave={(patch) => {
            onUpdate(entry, patch, 'Entry updated');
            onClose();
          }}
        />
      ) : (
        <>
          <EntryDetailFields entry={entry} collections={visibleCollections} />
          <div className={ACTION_GRID}>
            {actions.map((action) =>
              action.id === 'file-collection' ? (
                <label className={FILE_CONTROL} key={action.id}>
                  <span className="sr-only">{action.label}</span>
                  <Icon name={action.icon} size={14} />
                  <NativeSelect
                    className="h-8 min-w-0 flex-1 rounded-none border-0 bg-transparent pr-2 pl-0 text-sm"
                    value={filedValue}
                    aria-label={action.label}
                    onChange={(event) => {
                      onUpdate(
                        entry,
                        { collection: event.currentTarget.value || null },
                        'Entry filed',
                      );
                      onClose();
                    }}
                  >
                    {filedMonth ? (
                      <option value={filedValue} disabled>
                        {filedMonth}
                      </option>
                    ) : null}
                    <option value="">Daily log</option>
                    {visibleCollections.map((collection) => (
                      <option value={collection.id} key={collection.id}>
                        {collection.name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              ) : (
                <Button
                  variant={variantFor(action)}
                  disabled={action.disabled}
                  key={action.id}
                  onClick={() => activate(action.id)}
                >
                  <Icon name={action.icon} size={14} /> {action.label}
                </Button>
              ),
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
