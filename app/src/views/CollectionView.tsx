import { ArrangedEntryList } from '../components/ArrangedEntryList';
import { ArrangeMenu } from '../components/ArrangeMenu';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { arrangeLog, logMetaLabel, type LogViewConfig } from '../domain/log-arrangement';
import { EMPTY_PANEL } from './view-classes';
import type { DisplayPreferences, JournalCollection, JournalEntry } from '../components/types';

interface CollectionViewProps {
  collection: JournalCollection | null;
  entries: JournalEntry[];
  preferences: DisplayPreferences;
  logView: LogViewConfig;
  onBack: () => void;
  onOpenEntry: (entry: JournalEntry) => void;
  onToggleEntry: (entry: JournalEntry) => void;
  onLogViewChange: (config: LogViewConfig) => void;
  onAddToCollection: () => void;
}

export function CollectionView({
  collection,
  entries,
  preferences,
  logView,
  onBack,
  onOpenEntry,
  onToggleEntry,
  onLogViewChange,
  onAddToCollection,
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
  const collectionEntries = entries.filter((entry) => entry.collection === collection.id);
  // Done keeps counting the whole collection: the meta's "M done" is a fact
  // about the collection, not about the current arrangement.
  const doneCount = collectionEntries.filter((entry) => entry.state === 'done').length;
  const arrangement = arrangeLog(collectionEntries, logView);
  return (
    <section className="collection-screen min-h-full" aria-labelledby="collection-title">
      <header className="px-4 pt-3.5 pb-[7px]">
        <Button variant="secondary" size="sm" onClick={onBack}>
          <Icon name="chevronLeft" size={14} /> Index
        </Button>
        <h2 className="pt-3 text-xl font-semibold tracking-[-0.01em]" id="collection-title">
          {collection.name}
        </h2>
        <div className="flex items-center gap-1.5 pt-0.5">
          <p className="text-sm text-fg-mute">
            {logMetaLabel(arrangement)} · {doneCount} done
          </p>
          <ArrangeMenu config={logView} onChange={onLogViewChange} label="Arrange collection" />
        </div>
        {collection.note ? (
          <p className="pt-0.5 text-sm leading-[1.5] text-fg-mid">{collection.note}</p>
        ) : null}
      </header>
      {arrangement.totalCount > 0 ? (
        <ArrangedEntryList
          arrangement={arrangement}
          preferences={preferences}
          showDate
          resetKey={collection.id}
          onOpen={onOpenEntry}
          onToggle={onToggleEntry}
        />
      ) : (
        <div className={cn(EMPTY_PANEL, 'min-h-[280px]')}>
          <Icon name="folder" size={18} />
          <h3 className="text-base font-medium text-fg">Nothing filed here yet.</h3>
          <p className="text-sm">Add one below — it lands in {collection.name}.</p>
          <Button variant="secondary" className="mt-[9px]" onClick={onAddToCollection}>
            <Icon name="plus" size={14} /> Add to {collection.name}
          </Button>
        </div>
      )}
      <div className="h-6" aria-hidden="true" />
    </section>
  );
}
