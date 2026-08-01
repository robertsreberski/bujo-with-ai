import { EntryRow } from '../components/EntryRow';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { journalActions } from '../store/journal-store';
import { EMPTY_PANEL } from './view-classes';
import type { DisplayPreferences, JournalCollection, JournalEntry } from '../components/types';

interface CollectionViewProps {
  collection: JournalCollection | null;
  entries: JournalEntry[];
  preferences: DisplayPreferences;
  onBack: () => void;
  onOpenEntry: (entry: JournalEntry) => void;
  onToggleEntry: (entry: JournalEntry) => void;
}

export function CollectionView({
  collection,
  entries,
  preferences,
  onBack,
  onOpenEntry,
  onToggleEntry,
}: CollectionViewProps) {
  if (!collection) {
    return (
      <section className={cn(EMPTY_PANEL, 'min-h-[280px] flex-1 justify-center')}>
        <Icon name="folder" size={20} />
        <h2 className="text-base font-medium text-fg">Collection not found</h2>
        <p className="text-sm">It may have been archived or renamed.</p>
        <Button variant="secondary" className="mt-[9px]" onClick={onBack}>
          <Icon name="chevronLeft" size={14} /> Back to Index
        </Button>
      </section>
    );
  }
  const collectionEntries = entries
    .filter((entry) => entry.collection === collection.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const doneCount = collectionEntries.filter((entry) => entry.state === 'done').length;
  return (
    <section className="collection-screen min-h-full" aria-labelledby="collection-title">
      <header className="px-4 pt-3.5 pb-[7px]">
        <Button variant="secondary" size="sm" onClick={onBack}>
          <Icon name="chevronLeft" size={14} /> Index
        </Button>
        <h2 className="pt-3 text-xl font-semibold tracking-[-0.01em]" id="collection-title">
          {collection.name}
        </h2>
        <p className="pt-0.5 text-sm text-fg-mute">
          {collectionEntries.length} items · {doneCount} done
        </p>
        {collection.note ? (
          <p className="pt-0.5 text-sm leading-[1.5] text-fg-mid">{collection.note}</p>
        ) : null}
      </header>
      {collectionEntries.length > 0 ? (
        collectionEntries.map((entry) => (
          <EntryRow
            entry={entry}
            preferences={preferences}
            showDate
            onOpen={onOpenEntry}
            onToggle={onToggleEntry}
            key={entry.id}
          />
        ))
      ) : (
        <div className={cn(EMPTY_PANEL, 'min-h-[280px]')}>
          <Icon name="folder" size={18} />
          <h3 className="text-base font-medium text-fg">Nothing filed here yet.</h3>
          <p className="text-sm">Add one below — it lands in {collection.name}.</p>
          <Button
            variant="secondary"
            className="mt-[9px]"
            onClick={() => journalActions.focusComposer({ kind: 'collection', id: collection.id })}
          >
            <Icon name="plus" size={14} /> Add to {collection.name}
          </Button>
        </div>
      )}
      <div className="h-6" aria-hidden="true" />
    </section>
  );
}
