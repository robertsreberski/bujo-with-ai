import { useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '../lib/utils';
import {
  DEFAULT_LOG_VIEW,
  isDefaultLogView,
  normalizeLogView,
  type LogViewConfig,
} from '../domain/log-arrangement';
import { ComposerPopover } from './ComposerPopover';
import { entryIcon } from './entry-icons';
import { Icon } from './Icon';
import { ENTRY_TYPES, TYPE_LABELS, type EntryType } from './types';
import { Button } from './ui/button';

/* The composer type menu's row recipe (DS-6), so both menus read as one
 * family — at 32px on fine pointers (this menu has 15 rows) with the usual
 * `touch:` inflation. */
const ROW =
  'flex min-h-8 w-full items-center gap-[9px] rounded-md px-[9px] text-md text-fg-body hover:bg-bg-line hover:text-fg touch:min-h-10';
const GROUP_CAPTION = 'px-[9px] pt-2 pb-1 text-tag font-medium text-fg-mute';

interface ArrangeMenuProps {
  config: LogViewConfig;
  onChange: (config: LogViewConfig) => void;
  /** Names the trigger and the surface, e.g. "Arrange monthly log". */
  label: string;
  /** Stable class the surface carries in both forms, for e2e. */
  marker?: string;
}

/**
 * The log's sort/group/filter controls behind one quiet trigger. Unlike the
 * type menu, picking a row keeps the surface open — filters are composed in
 * multiples; Escape or an outside tap closes it.
 */
export function ArrangeMenu({
  config,
  onChange,
  label,
  marker = 'arrange-menu',
}: ArrangeMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const view = normalizeLogView(config);
  const filtered = !isDefaultLogView(view);
  const checkedTypes: readonly EntryType[] = view.types.length === 0 ? ENTRY_TYPES : view.types;

  const emit = (next: LogViewConfig) => onChange(normalizeLogView(next));

  const toggleType = (type: EntryType) => {
    const next = checkedTypes.includes(type)
      ? checkedTypes.filter((item) => item !== type)
      : [...checkedTypes, type];
    // Unchecking the last visible type would show nothing; fall back to all.
    emit({ ...view, types: next.length === 0 ? [] : next });
  };

  const handleMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    )
      return;
    event.preventDefault();
    const options = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [],
    );
    if (options.length === 0) return;
    const current = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement));
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  };

  const radioRow = (name: string, checked: boolean, onSelect: () => void) => (
    <button
      className={ROW}
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      key={name}
      onClick={onSelect}
    >
      <span className="flex-1 text-left">{name}</span>
      {checked ? <Icon name="check" size={13} /> : null}
    </button>
  );

  return (
    <ComposerPopover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      title={label}
      description="Sort, group, and filter this log."
      marker={marker}
      trigger={
        <Button
          variant="ghost"
          size="icon"
          className={cn('size-8', filtered && 'bg-bg-line text-fg')}
          aria-label={filtered ? `${label} — filters active` : label}
        >
          <Icon name="sliders" size={15} />
        </Button>
      }
    >
      <div
        ref={menuRef}
        className="max-h-[var(--radix-popover-content-available-height,60dvh)] overflow-y-auto"
        role="menu"
        aria-label={label}
        onKeyDown={handleMenuKey}
      >
        <div role="group" aria-label="Sort">
          <p className={GROUP_CAPTION} aria-hidden="true">
            Sort
          </p>
          {radioRow('Newest first', view.sort === 'newest', () =>
            emit({ ...view, sort: 'newest' }),
          )}
          {radioRow('Oldest first', view.sort === 'oldest', () =>
            emit({ ...view, sort: 'oldest' }),
          )}
        </div>
        <div role="group" aria-label="Group">
          <p className={GROUP_CAPTION} aria-hidden="true">
            Group
          </p>
          {radioRow('None', view.group === 'none', () => emit({ ...view, group: 'none' }))}
          {radioRow('By type', view.group === 'type', () => emit({ ...view, group: 'type' }))}
        </div>
        <div role="group" aria-label="Show">
          <p className={GROUP_CAPTION} aria-hidden="true">
            Show
          </p>
          {radioRow('Open', view.stateFilter === 'open', () =>
            emit({ ...view, stateFilter: 'open' }),
          )}
          {radioRow('Everything', view.stateFilter === 'all', () =>
            emit({ ...view, stateFilter: 'all' }),
          )}
          {radioRow('Done & moved', view.stateFilter === 'closed', () =>
            emit({ ...view, stateFilter: 'closed' }),
          )}
        </div>
        <div role="group" aria-label="Types">
          <p className={GROUP_CAPTION} aria-hidden="true">
            Types
          </p>
          {ENTRY_TYPES.map((type) => (
            <button
              className={ROW}
              type="button"
              role="menuitemcheckbox"
              aria-checked={checkedTypes.includes(type)}
              key={type}
              onClick={() => toggleType(type)}
            >
              <Icon name={entryIcon[type]} size={14} />
              <span className="flex-1 text-left">{TYPE_LABELS[type]}</span>
              {checkedTypes.includes(type) ? <Icon name="check" size={13} /> : null}
            </button>
          ))}
        </div>
        {filtered ? (
          <button
            className={cn(ROW, 'mt-1 border-t border-bg-line text-fg-mute')}
            type="button"
            role="menuitem"
            onClick={() => emit(DEFAULT_LOG_VIEW)}
          >
            Reset to defaults
          </button>
        ) : null}
      </div>
    </ComposerPopover>
  );
}
