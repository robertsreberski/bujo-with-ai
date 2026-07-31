import { EntryRow } from '../components/EntryRow';
import { Icon } from '../components/Icon';
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
      <section className="screen collection-missing">
        <Icon name="folder" size={20} />
        <h2>Collection not found</h2>
        <p>It may have been archived or renamed.</p>
        <button className="button button--secondary" type="button" onClick={onBack}>
          <Icon name="chevronLeft" size={14} /> Back to Index
        </button>
      </section>
    );
  }
  const collectionEntries = entries
    .filter((entry) => entry.collection === collection.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const doneCount = collectionEntries.filter((entry) => entry.state === 'done').length;
  return (
    <section className="screen collection-screen" aria-labelledby="collection-title">
      <header className="collection-header">
        <button className="button button--secondary button--small" type="button" onClick={onBack}>
          <Icon name="chevronLeft" size={14} /> Index
        </button>
        <h2 id="collection-title">{collection.name}</h2>
        <p>
          {collectionEntries.length} items · {doneCount} done
        </p>
        {collection.note ? <p className="collection-header__note">{collection.note}</p> : null}
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
        <div className="collection-empty">
          <Icon name="folder" size={18} />
          <h3>This collection is empty</h3>
          <p>File an entry here from its detail dialog.</p>
        </div>
      )}
      <div className="screen-end" aria-hidden="true" />
    </section>
  );
}
