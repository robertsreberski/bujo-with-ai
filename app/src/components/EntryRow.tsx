import { Icon } from './Icon';
import { entryIcon } from './entry-icons';
import { formatShortDate } from './dates';
import {
  TYPE_LABELS,
  isActionable,
  stateLabel,
  type DisplayPreferences,
  type JournalEntry,
} from './types';

interface EntryRowProps {
  entry: JournalEntry;
  preferences: DisplayPreferences;
  onOpen: (entry: JournalEntry) => void;
  onToggle: (entry: JournalEntry) => void;
  showDate?: boolean;
}

export function EntryRow({
  entry,
  preferences,
  onOpen,
  onToggle,
  showDate = false,
}: EntryRowProps) {
  const actionable = isActionable(entry);
  const done = entry.state === 'done';
  const toggleable = actionable && (entry.state === 'open' || done);
  const dimmed = done || entry.state === 'cancelled' || entry.state === 'migrated';
  const struck = done || entry.state === 'cancelled';
  const displayState = stateLabel(entry);
  const showType = preferences.showTypeBadges && entry.type !== 'task';
  const showAi = preferences.highlightAiEntries && entry.author === 'ai';
  const metaVisible =
    showDate || showType || showAi || displayState !== null || entry.tags.length > 0;
  const toggleLabel = `${done ? 'Mark as not done' : 'Mark as done'}: ${entry.text}`;

  return (
    <article
      className={`entry-row entry-row--${preferences.density}${dimmed ? ' entry-row--dimmed' : ''}${
        struck ? ' entry-row--struck' : ''
      }${showAi ? ' entry-row--ai' : ''}`}
      data-entry-id={entry.id}
    >
      {actionable ? (
        <button
          className={`entry-row__lead entry-checkbox${done ? ' entry-checkbox--checked' : ''}`}
          type="button"
          aria-label={
            toggleable
              ? toggleLabel
              : `Open ${TYPE_LABELS[entry.type].toLowerCase()}: ${entry.text}`
          }
          aria-pressed={toggleable ? done : undefined}
          onClick={() => (toggleable ? onToggle(entry) : onOpen(entry))}
        >
          <span className="entry-checkbox__visual">
            <Icon name="check" size={11} />
          </span>
        </button>
      ) : (
        <button
          className="entry-row__lead entry-type-icon"
          type="button"
          aria-label={`Open ${TYPE_LABELS[entry.type].toLowerCase()}: ${entry.text}`}
          onClick={() => onOpen(entry)}
        >
          <Icon name={entryIcon[entry.type]} size={15} />
        </button>
      )}
      <button className="entry-row__content" type="button" onClick={() => onOpen(entry)}>
        <span className="entry-row__text">{entry.text}</span>
        {metaVisible ? (
          <span className="entry-row__meta">
            {showDate ? (
              <span className="entry-row__date">{formatShortDate(entry.date)}</span>
            ) : null}
            {showType ? <span className="badge badge--type">{TYPE_LABELS[entry.type]}</span> : null}
            {displayState ? <span className="badge badge--state">{displayState}</span> : null}
            {showAi ? (
              <span
                className="badge badge--ai"
                title="Added by assistant"
                aria-label="Added by assistant"
              >
                <Icon name="sparkle" size={10} />
              </span>
            ) : null}
            {entry.tags.map((tag) => (
              <span className="entry-row__tag" key={tag}>
                #{tag}
              </span>
            ))}
          </span>
        ) : null}
      </button>
      {entry.time ? <time className="entry-row__time">{entry.time}</time> : null}
    </article>
  );
}
