import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ComposerPopover } from './ComposerPopover';
import { Icon } from './Icon';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { formatMonth, formatShortDate } from './dates';
import {
  destinationLabel,
  monthCollectionId,
  nextCalendarDate,
  sameDestination,
  slugifyCollection,
  type Destination,
  type ResolvedDestination,
} from './destination';
import { cn } from '../lib/utils';
import type { JournalRoute } from '../routes/useJournalRoute';
import type { JournalCollection } from './types';

/** Above this many collections the picker earns a filter field. */
const FILTER_THRESHOLD = 6;

/*
 * `max-w-[45%]` is the narrow-viewport guard: the chip never shrinks (the hint
 * beside it would win), so a long collection name would otherwise widen the
 * preview row past the document at 320px instead of ellipsing inside it.
 */
const CHIP =
  'destination-chip inline-flex max-w-[45%] min-w-0 flex-none items-center gap-1 border px-[7px] text-2xs font-medium touch:min-h-10 touch:min-w-10';
const CHIP_SCREEN = 'border-transparent bg-bg-line text-fg-mid hover:bg-bg-raised';
const CHIP_ACTIVE = 'border-ai-border bg-ai-bg text-ai-fg';
const OPTION =
  'flex min-h-10 w-full items-center gap-2 rounded-md px-[9px] text-md text-fg-body hover:bg-bg-line hover:text-fg';

interface DestinationChipProps {
  resolved: ResolvedDestination;
  route: JournalRoute;
  today: string;
  collections: readonly JournalCollection[];
  collectionsById: Record<string, JournalCollection>;
  /** What this screen would file into with no chip and no typed token. */
  screenDestination: Destination;
  onSelect: (destination: Destination) => void;
  /** Null on a screen default, which has nothing to take back. */
  onClear: (() => void) | null;
  onRestoreFocus: () => void;
}

export function DestinationChip({
  resolved,
  route,
  today,
  collections,
  collectionsById,
  screenDestination,
  onSelect,
  onClear,
  onRestoreFocus,
}: DestinationChipProps) {
  const [open, setOpen] = useState(false);
  const wasOpenRef = useRef(false);
  const label = destinationLabel(resolved.destination, collectionsById, today);
  const active = resolved.source !== 'screen' || resolved.createsCollection;

  /*
   * The picker steals focus to stay keyboard-operable, and the composer takes
   * it straight back — but only once the close has committed. Restoring focus
   * inside the selecting click instead leaves a focus move in flight that the
   * next trigger click reads as an interaction outside a just-opened layer,
   * which dismisses the picker the instant it reopens.
   */
  useEffect(() => {
    if (wasOpenRef.current && !open) onRestoreFocus();
    wasOpenRef.current = open;
  }, [open, onRestoreFocus]);

  const select = (destination: Destination) => {
    onSelect(destination);
    setOpen(false);
  };

  return (
    <span className="inline-flex min-w-0 flex-none items-center">
      <ComposerPopover
        open={open}
        onOpenChange={setOpen}
        title="File this capture"
        description="Choose where the next entry lands."
        marker="destination-menu"
        onCloseAutoFocus={(event) => event.preventDefault()}
        trigger={
          <button
            className={cn(
              CHIP,
              active ? CHIP_ACTIVE : CHIP_SCREEN,
              onClear ? 'rounded-l-sm' : 'rounded-sm',
            )}
            type="button"
            aria-label={`Destination: ${label}`}
          >
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {`→ ${label}`}
            </span>
            {resolved.createsCollection ? (
              <Badge variant="count" className="flex-none px-1.5">
                New
              </Badge>
            ) : null}
          </button>
        }
      >
        <DestinationOptions
          route={route}
          today={today}
          collections={collections}
          current={resolved.destination}
          screenDestination={screenDestination}
          onSelect={select}
        />
      </ComposerPopover>
      {onClear ? (
        <button
          className={cn(
            CHIP,
            active ? CHIP_ACTIVE : CHIP_SCREEN,
            'rounded-r-sm border-l-0 justify-center px-1.5',
          )}
          type="button"
          aria-label="Clear destination"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            onClear();
            onRestoreFocus();
          }}
        >
          <Icon name="close" size={11} />
        </button>
      ) : null}
    </span>
  );
}

interface DestinationOptionsProps {
  route: JournalRoute;
  today: string;
  collections: readonly JournalCollection[];
  current: Destination;
  screenDestination: Destination;
  onSelect: (destination: Destination) => void;
}

function DestinationOptions({
  route,
  today,
  collections,
  current,
  screenDestination,
  onSelect,
}: DestinationOptionsProps) {
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const viewedDate = route.name === 'today' ? (route.date ?? today) : today;
  const month = route.name === 'month' ? (route.month ?? today.slice(0, 7)) : today.slice(0, 7);
  const query = filter.trim().toLowerCase();
  const matches = collections.filter(
    (collection) =>
      query.length === 0 ||
      collection.id.includes(query) ||
      collection.name.toLowerCase().includes(query),
  );

  const slug = slugifyCollection(name);
  const submitNew = (event: FormEvent) => {
    event.preventDefault();
    if (slug.length === 0) return;
    onSelect({ kind: 'collection', id: slug });
  };

  return (
    <div className="flex flex-col gap-0.5">
      <Option
        current={current}
        destination={{ kind: 'date', date: viewedDate }}
        onSelect={onSelect}
      >
        {`Daily log — ${viewedDate === today ? 'Today' : formatShortDate(viewedDate)}`}
      </Option>
      {viewedDate === today ? null : (
        <Option current={current} destination={{ kind: 'date', date: today }} onSelect={onSelect}>
          Daily log — Today
        </Option>
      )}
      <Option
        current={current}
        destination={{ kind: 'date', date: nextCalendarDate(today) }}
        onSelect={onSelect}
      >
        Tomorrow
      </Option>
      <Option
        current={current}
        destination={{ kind: 'collection', id: monthCollectionId(month) }}
        onSelect={onSelect}
      >
        {`Monthly log — ${formatMonth(month)}`}
      </Option>

      <hr className="my-1 border-0 border-t border-border" />

      {collections.length > FILTER_THRESHOLD ? (
        <Input
          className="mb-1 h-8 w-full text-md"
          value={filter}
          placeholder="Filter collections…"
          aria-label="Filter collections"
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
      ) : null}
      {matches.map((collection) => (
        <Option
          current={current}
          destination={{ kind: 'collection', id: collection.id }}
          key={collection.id}
          onSelect={onSelect}
        >
          {collection.name}
        </Option>
      ))}
      {collections.length > 0 && matches.length === 0 ? (
        <p className="px-[9px] py-1.5 text-sm text-fg-mute">No collection matches that filter.</p>
      ) : null}

      {creating ? (
        <form className="flex items-center gap-1.5 px-[3px] pt-1" onSubmit={submitNew}>
          <Input
            className="h-8 min-w-0 flex-1 text-md"
            value={name}
            autoFocus
            maxLength={80}
            placeholder="Collection name"
            aria-label="New collection name"
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <button
            className={cn(
              'flex-none rounded-md border border-primary bg-primary px-2.5 text-xs font-medium text-primary-fg',
              'min-h-8 touch:min-h-10 touch:min-w-10',
            )}
            type="submit"
            disabled={slug.length === 0}
          >
            File
          </button>
        </form>
      ) : (
        <button
          className={cn(OPTION, 'text-fg-mid')}
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setCreating(true)}
        >
          <Icon name="plus" size={13} className="flex-none" />
          <span className="flex-1 text-left">New collection…</span>
        </button>
      )}

      {route.name === 'review' ? (
        <p className="px-[9px] pt-2 text-sm text-fg-mute">
          Review is an audit screen — captures file to your daily log.
        </p>
      ) : null}
      {creating && slug.length > 0 ? (
        <p className="px-[9px] pt-1.5 text-sm text-fg-mute">
          Address: <code>/c/{slug}</code>
        </p>
      ) : null}
      <ScreenDefaultNote screenDestination={screenDestination} current={current} />
    </div>
  );
}

interface OptionProps {
  current: Destination;
  destination: Destination;
  onSelect: (destination: Destination) => void;
  children: ReactNode;
}

function Option({ current, destination, onSelect, children }: OptionProps) {
  const selected = sameDestination(current, destination);
  return (
    <button
      className={cn(OPTION, selected && 'text-fg')}
      type="button"
      aria-pressed={selected}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => onSelect(destination)}
    >
      <span className="min-w-0 flex-1 overflow-hidden text-left text-ellipsis whitespace-nowrap">
        {children}
      </span>
      {selected ? <Icon name="check" size={13} className="flex-none" /> : null}
    </button>
  );
}

function ScreenDefaultNote({
  screenDestination,
  current,
}: {
  screenDestination: Destination;
  current: Destination;
}) {
  if (sameDestination(screenDestination, current)) return null;
  return (
    <p className="px-[9px] pt-2 text-sm text-fg-mute">
      Clearing the chip files into this screen&rsquo;s own log again.
    </p>
  );
}
