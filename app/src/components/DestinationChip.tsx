import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { DeferredComposerPopover } from './DeferredComposerPopover';
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
 * The width cap lives on the wrapper, never on the chip itself: the wrapper is a
 * flex item of a row with a definite width, so `65%` has something real to
 * resolve against. A percentage cap on the chip resolved against its own
 * shrink-to-fit parent instead, which collapsed it to the bare touch target and
 * left every state reading as a kind icon, an ellipsis, and a chevron — the
 * name, the one thing the chip exists to say, squeezed out entirely.
 */
const WRAP = 'inline-flex max-w-[65%] min-w-0 flex-none items-center';

/*
 * Chip-sized, like every other chip in the context zone: 24px on the `2xs` rung
 * at radius 4. The destination answers the composer's whole question — where
 * does this land? — but it says so through the hairline border, the ai tint once
 * it is no longer the screen's own default, the 12px kind icon, the chevron, and
 * the "New" badge. Not through size. Reading as one family is what makes the row
 * scannable; a chip a size larger than its neighbours only reads as a mistake.
 *
 * Both halves are a transparent button whose only job is to measure 40px on a
 * coarse pointer (`touch:-my-2` gives the extra height back, so the row still
 * occupies 24px), with all the ink on the span inside — the parse-chip idiom.
 * `INK` carries no horizontal padding: the clear half states its own, and a
 * `px` plus a `pl` in one recipe leaves the winner to stylesheet order.
 */
// `p-0`: preflight is off, so a bare button keeps the UA's 1px/6px padding —
// outside the ink, where it would open a 12px hole in the seam between halves.
const HIT = 'group inline-flex h-6 min-w-0 items-center p-0 touch:h-10 touch:min-w-10 touch:-my-2';
const INK = 'flex h-6 min-w-0 items-center gap-1 border text-2xs font-medium whitespace-nowrap';
const CHIP_SCREEN =
  'border-border bg-bg-line text-fg-mid group-hover:bg-bg-raised group-hover:text-fg-body';
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
  const place = destinationLabel(resolved.destination, collectionsById, today);
  // A filing that states its own day says both halves: the log it lands in, and
  // the day it will claim there. Without the day the chip would report only
  // half of what the typed token just decided.
  const label =
    resolved.statedDate === null ? place : `${place} · ${formatShortDate(resolved.statedDate)}`;
  const active =
    resolved.source !== 'screen' || resolved.createsCollection || resolved.statedDate !== null;

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
    <span className={WRAP}>
      <DeferredComposerPopover
        open={open}
        onOpenChange={setOpen}
        title="File this capture"
        description="Choose where the next entry lands."
        marker="destination-menu"
        onCloseAutoFocus={(event) => event.preventDefault()}
        trigger={
          <button
            className={cn('destination-chip', HIT)}
            type="button"
            aria-label={`Destination: ${label}`}
          >
            <span
              className={cn(
                INK,
                'px-2',
                active ? CHIP_ACTIVE : CHIP_SCREEN,
                onClear ? 'rounded-l-sm' : 'rounded-sm',
              )}
            >
              {/* Its own element so the kind mark survives a truncation the name
                  causes; a day and a collection are the two things it can be. */}
              <Icon
                name={resolved.destination.kind === 'date' ? 'calendar' : 'folder'}
                size={12}
                className="flex-none opacity-60"
              />
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                {label}
              </span>
              {resolved.createsCollection ? (
                <Badge variant="count" className="flex-none px-1.5">
                  New
                </Badge>
              ) : null}
              <Icon name="chevronDown" size={11} className="flex-none opacity-60" />
            </span>
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
      </DeferredComposerPopover>
      {onClear ? (
        <button
          // `justify-start` is the seam's guard: on touch the button is 40px
          // wide around ~26px of ink, and start-aligning it drops every pixel of
          // that slack outboard, where it cannot open a gap between the halves.
          className={cn(HIT, 'flex-none touch:justify-start')}
          type="button"
          aria-label="Clear destination"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            onClear();
            onRestoreFocus();
          }}
        >
          <span
            className={cn(
              INK,
              active ? CHIP_ACTIVE : CHIP_SCREEN,
              // No left border of its own: the trigger's right edge is the seam,
              // so the pair reads as one chip split into two targets.
              'rounded-r-sm border-l-0 pr-2 pl-1.5',
            )}
          >
            <Icon name="close" size={12} className="flex-none" />
          </span>
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

      {route.name === 'activity' ? (
        <p className="px-[9px] pt-2 text-sm text-fg-mute">
          Activity is an audit screen — captures file to your daily log.
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
