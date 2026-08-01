import { Icon } from './Icon';
import { Badge } from './ui/badge';
import { entryIcon } from './entry-icons';
import { formatShortDate } from './dates';
import { cn } from '../lib/utils';
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

/*
 * DS-14 row geometry. The 18px lead column carries a 16px visual control, and
 * the button around it is blown up to a physical 40x40 box with matching
 * negative margins: the margin box stays exactly 18x20, so the row keeps the
 * tight prototype rhythm while the coarse-pointer touch sweep still measures a
 * 40px target. `touch:` re-inflates the vertical padding so the phone layout
 * lands on the same 54/46px rows it had before.
 *
 * Vertical inflation is touch-only: a fixed 40px-tall button would overlap the
 * next compact desktop row (~34px) and steal its clicks. On touch the button
 * grows downward (mb -20) so its 40px center sits at content-top + 20 — level
 * with the min-h-10 centered single-line text; multi-line stays top-anchored.
 */
const LEAD_HIT_BOX = '-mx-[11px] grid h-5 w-10 place-items-center touch:h-10 touch:-mb-5';

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
  // `migrated` and `scheduled` are exact peers: both are the shell a copy left
  // behind, so both recede the same way.
  const dimmed =
    done ||
    entry.state === 'cancelled' ||
    entry.state === 'migrated' ||
    entry.state === 'scheduled';
  const struck = done || entry.state === 'cancelled';
  const displayState = stateLabel(entry);
  const showType = preferences.showTypeBadges && entry.type !== 'task';
  const showAi = preferences.highlightAiEntries && entry.author === 'ai';
  const metaVisible =
    showDate || showType || showAi || displayState !== null || entry.tags.length > 0;
  const toggleLabel = `${done ? 'Mark as not done' : 'Mark as done'}: ${entry.text}`;

  return (
    <article
      className={cn(
        'entry-row grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-x-[11px] border-b border-bg-line px-4 transition-[background-color] duration-100 ease-[ease] hover:bg-bg-hover motion-reduce:transition-none',
        preferences.density === 'compact'
          ? 'entry-row--compact py-1.5 touch:py-[3px]'
          : 'entry-row--comfortable py-[9px] touch:py-[7px]',
        dimmed && 'entry-row--dimmed',
        struck && 'entry-row--struck',
        showAi && 'entry-row--ai bg-bg-hover',
      )}
      data-entry-id={entry.id}
    >
      {actionable ? (
        <button
          className={cn(
            'entry-row__lead entry-checkbox text-fg-mute',
            LEAD_HIT_BOX,
            done && 'entry-checkbox--checked',
          )}
          type="button"
          aria-label={
            toggleable
              ? toggleLabel
              : `Open ${TYPE_LABELS[entry.type].toLowerCase()}: ${entry.text}`
          }
          aria-pressed={toggleable ? done : undefined}
          onClick={() => (toggleable ? onToggle(entry) : onOpen(entry))}
        >
          <span
            className={cn(
              'entry-checkbox__visual grid size-4 place-items-center rounded-sm border bg-bg text-primary-fg',
              done ? 'border-primary bg-primary' : 'border-border-control',
            )}
          >
            <Icon name="check" size={11} className={done ? undefined : 'opacity-0'} />
          </span>
        </button>
      ) : (
        <button
          className={cn('entry-row__lead entry-type-icon text-fg-mute', LEAD_HIT_BOX)}
          type="button"
          aria-label={`Open ${TYPE_LABELS[entry.type].toLowerCase()}: ${entry.text}`}
          onClick={() => onOpen(entry)}
        >
          <Icon name={entryIcon[entry.type]} size={15} />
        </button>
      )}
      <button
        className="entry-row__content flex min-w-0 flex-col items-stretch justify-center gap-[5px] text-left touch:min-h-10"
        type="button"
        onClick={() => onOpen(entry)}
      >
        <span
          className={cn(
            'entry-row__text text-base text-pretty decoration-1',
            dimmed ? 'text-fg-mute decoration-fg-faint' : 'text-fg',
            struck && 'line-through',
          )}
        >
          {entry.text}
        </span>
        {metaVisible ? (
          <span className="entry-row__meta flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-[5px]">
            {showDate ? (
              <span className="entry-row__date mr-0.5 font-mono text-tag text-fg-mute">
                {formatShortDate(entry.date)}
              </span>
            ) : null}
            {showType ? (
              <Badge variant="type" className="badge badge--type">
                {TYPE_LABELS[entry.type]}
              </Badge>
            ) : null}
            {displayState ? (
              <Badge variant="state" className="badge badge--state">
                {displayState}
              </Badge>
            ) : null}
            {showAi ? (
              <Badge
                variant="ai"
                className="badge badge--ai"
                title="Added by assistant"
                aria-label="Added by assistant"
              >
                <Icon name="sparkle" size={10} />
              </Badge>
            ) : null}
            {entry.tags.map((tag) => (
              <span className="entry-row__tag text-tag text-fg-mute" key={tag}>
                #{tag}
              </span>
            ))}
          </span>
        ) : null}
      </button>
      {entry.time ? (
        <time className="entry-row__time pt-[2px] text-right font-mono text-tag whitespace-nowrap text-fg-mute">
          {entry.time}
        </time>
      ) : null}
    </article>
  );
}
