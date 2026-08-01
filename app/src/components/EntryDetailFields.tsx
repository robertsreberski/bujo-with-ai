import { Icon } from './Icon';
import { AI_PANEL, AI_PANEL_COPY, AI_PANEL_HEADER } from './ui/dialog-classes';
import { cn } from '../lib/utils';
import { entryIcon } from './entry-icons';
import { formatLongDate } from './dates';
import { monthCollectionLabel } from './entry-actions';
import { TYPE_LABELS, type JournalCollection, type JournalEntry } from './types';

interface EntryDetailFieldsProps {
  entry: JournalEntry;
  /** Fileable collections: no archives, no server-owned monthly logs. */
  collections: JournalCollection[];
}

/* `.entry-detail-fields`: a hairline-split definition list of read-only facts. */
const DETAIL_ROW =
  'flex min-h-10 items-baseline gap-3 border-b border-bg-line px-[11px] py-[9px] last:border-b-0';
const DETAIL_LABEL = 'w-[70px] flex-none text-xs text-fg-mute';
const DETAIL_VALUE = 'flex min-w-0 items-center gap-[5px] text-sm font-normal text-fg';
const DETAIL_NOTE = 'text-tag text-fg-mute';

/**
 * The read-only face of an entry: the fact rows plus the provenance panel an
 * assistant-authored entry carries. Presentational only, so the desktop dialog
 * and the coarse-pointer sheet can each wrap it in their own chrome.
 */
export function EntryDetailFields({ entry, collections }: EntryDetailFieldsProps) {
  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className={DETAIL_ROW}>
          <span className={DETAIL_LABEL}>Type</span>
          <strong className={DETAIL_VALUE}>
            <Icon name={entryIcon[entry.type]} size={13} /> {TYPE_LABELS[entry.type]}
          </strong>
        </div>
        <div className={DETAIL_ROW}>
          <span className={DETAIL_LABEL}>Status</span>
          <strong className={DETAIL_VALUE}>
            {entry.state === 'logged'
              ? 'Logged'
              : entry.state.replace(/^./, (value) => value.toUpperCase())}
          </strong>
        </div>
        <div className={DETAIL_ROW}>
          <span className={DETAIL_LABEL}>Date</span>
          <strong className={DETAIL_VALUE}>
            {formatLongDate(entry.date)}{' '}
            {entry.time ? <small className={DETAIL_NOTE}>at {entry.time}</small> : null}
          </strong>
        </div>
        <div className={DETAIL_ROW}>
          <span className={DETAIL_LABEL}>Tags</span>
          <strong className={DETAIL_VALUE}>
            {entry.tags.length ? entry.tags.map((tag) => `#${tag}`).join(' ') : '—'}
          </strong>
        </div>
        <div className={DETAIL_ROW}>
          <span className={DETAIL_LABEL}>Filed in</span>
          <strong className={DETAIL_VALUE}>
            {monthCollectionLabel(entry.collection) ??
              collections.find((collection) => collection.id === entry.collection)?.name ??
              'Daily log'}
          </strong>
        </div>
        <div className={DETAIL_ROW}>
          <span className={DETAIL_LABEL}>Added by</span>
          <strong className={DETAIL_VALUE}>{entry.author === 'ai' ? 'Assistant' : 'You'}</strong>
        </div>
      </div>
      {entry.author === 'ai' && entry.source ? (
        <aside className={cn(AI_PANEL, 'mt-3')}>
          <header className={AI_PANEL_HEADER}>
            <Icon name="sparkle" size={12} /> <strong>Added automatically</strong>
          </header>
          <p className={AI_PANEL_COPY}>{entry.source}</p>
        </aside>
      ) : null}
    </>
  );
}
