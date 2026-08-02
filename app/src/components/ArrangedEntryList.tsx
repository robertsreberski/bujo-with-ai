import { Fragment } from 'react';
import type { LogArrangement } from '../domain/log-arrangement';
import { SECTION_EMPTY } from '../views/view-classes';
import { EntryRow } from './EntryRow';
import { Icon } from './Icon';
import type { DisplayPreferences, JournalEntry } from './types';

interface ArrangedEntryListProps {
  arrangement: LogArrangement;
  preferences: DisplayPreferences;
  showDate?: boolean;
  /**
   * Remounts the disclosure when it changes (pass the month or collection id):
   * its expand state is DOM-only, so navigation resets it to collapsed.
   */
  resetKey: string;
  onOpen: (entry: JournalEntry) => void;
  onToggle: (entry: JournalEntry) => void;
}

/**
 * An arranged log body: the active sections, then the closed shells behind a
 * native disclosure so finished work stops crowding the list without ever
 * being more than one tap away.
 */
export function ArrangedEntryList({
  arrangement,
  preferences,
  showDate = false,
  resetKey,
  onOpen,
  onToggle,
}: ArrangedEntryListProps) {
  const { sections, closed, closedCount, visibleCount, totalCount } = arrangement;

  if (visibleCount === 0 && totalCount > 0) {
    return (
      <div className={SECTION_EMPTY}>
        <p>Nothing matches the current arrangement.</p>
      </div>
    );
  }

  const row = (entry: JournalEntry) => (
    <EntryRow
      entry={entry}
      preferences={preferences}
      showDate={showDate}
      onOpen={onOpen}
      onToggle={onToggle}
      key={entry.id}
    />
  );

  return (
    <>
      {sections.map((section) => (
        <Fragment key={section.key}>
          {section.label !== null ? (
            <h3 className="px-4 pt-3 pb-1 text-xs font-medium text-fg-mute">{section.label}</h3>
          ) : null}
          {section.entries.map(row)}
        </Fragment>
      ))}
      {closedCount > 0 ? (
        <details className="log-closed group" key={resetKey}>
          <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1.5 border-b border-bg-line px-4 text-sm text-fg-mute hover:bg-bg-hover hover:text-fg touch:min-h-10 [&::-webkit-details-marker]:hidden">
            <Icon name="chevronRight" size={12} className="group-open:rotate-90" />
            {`Done & moved (${closedCount})`}
          </summary>
          {closed.map(row)}
        </details>
      ) : null}
    </>
  );
}
