import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { Icon } from './Icon';
import { parseDraft } from './capture';
import { entryIcon } from './entry-icons';
import { cn } from '../lib/utils';
import { ENTRY_TYPES, TYPE_LABELS, type EntryType, type ParsedDraft } from './types';

/** Preview chip shared by the parse result and its error variant. */
const CHIP =
  'parse-chip inline-flex h-5 flex-none items-center rounded-sm bg-bg-line px-[7px] text-2xs font-medium text-fg-mid';

interface ComposerProps {
  draft: string;
  defaultType: EntryType;
  onDraftChange: (draft: string) => void;
  onDefaultTypeChange: (type: EntryType) => void;
  onSubmit: (parsed: ParsedDraft) => void;
  onInputFocus?: (() => void) | undefined;
}

export function Composer({
  draft,
  defaultType,
  onDraftChange,
  onDefaultTypeChange,
  onSubmit,
  onInputFocus,
}: ComposerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusMenuOnOpenRef = useRef(false);
  const labelId = useId();
  const menuLabelId = useId();
  const parsed = parseDraft(draft, defaultType);

  useLayoutEffect(() => {
    if (menuOpen && focusMenuOnOpenRef.current) {
      menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
      focusMenuOnOpenRef.current = false;
    }
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        setMenuOpen(false);
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!parsed.text || parsed.error) return;
    onSubmit(parsed);
    setMenuOpen(false);
    inputRef.current?.focus();
  };

  const keepComposerFocus = (event: PointerEvent) => event.preventDefault();

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
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
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

  return (
    <div className="composer-shell relative z-(--z-composer) flex-none border-t border-border bg-bg pb-(--sab) keyboard-open:fixed keyboard-open:right-auto keyboard-open:bottom-[calc(100%_-_var(--vv-offset,0px)_-_var(--vv-height,100%))] keyboard-open:left-[var(--pane-left,var(--sal))] keyboard-open:w-[var(--pane-width,calc(100%_-_var(--sal)_-_var(--sar)))] keyboard-open:pb-0">
      <div className="mx-auto w-full max-w-(--content-width) px-3 pt-2 pb-2.5">
        <div
          className="flex min-h-[22px] items-center gap-[5px] overflow-x-auto pb-1 [scrollbar-width:none]"
          aria-live="polite"
        >
          {parsed.error ? (
            <span
              className={cn(
                CHIP,
                'parse-chip--error border border-danger-border bg-danger-bg text-danger',
              )}
            >
              {parsed.error}
            </span>
          ) : draft ? (
            <>
              <span className={CHIP}>{TYPE_LABELS[parsed.type]}</span>
              {parsed.time ? <span className={CHIP}>at {parsed.time}</span> : null}
              {parsed.tags.map((tag) => (
                <span className={CHIP} key={tag}>
                  #{tag}
                </span>
              ))}
              {parsed.dateShift ? <span className={CHIP}>tomorrow</span> : null}
            </>
          ) : (
            <span className="overflow-hidden text-tag text-fg-mute text-ellipsis whitespace-nowrap [&>b]:font-medium">
              Shortcuts: <b>.</b> task · <b>o</b> event · <b>-</b> note · #tag · @3pm · &gt;tomorrow
            </span>
          )}
        </div>
        <form className="flex items-center gap-2" onSubmit={submit}>
          <button
            className={cn(
              'composer__type flex h-9 min-w-[104px] items-center gap-1.5 rounded-md border border-border-control bg-bg px-[9px] text-sm max-[480px]:min-w-[86px] touch:h-10',
              parsed.signifierWon ? 'composer__type--overridden text-fg-mute' : 'text-fg-body',
            )}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={`${labelId}-menu`}
            aria-label={`Entry type: ${TYPE_LABELS[parsed.type]}`}
            onClick={() => setMenuOpen((value) => !value)}
            onPointerDown={(event) => {
              focusMenuOnOpenRef.current = false;
              event.preventDefault();
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'ArrowDown' ||
                event.key === 'ArrowUp' ||
                event.key === 'Enter' ||
                event.key === ' '
              ) {
                focusMenuOnOpenRef.current = true;
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setMenuOpen(true);
              }
            }}
          >
            <Icon name={entryIcon[parsed.type]} size={14} />
            <span className="min-w-0 flex-1 text-left max-[480px]:hidden">
              {TYPE_LABELS[parsed.type]}
            </span>
            <Icon name="chevronDown" size={12} />
          </button>
          <label className="sr-only" id={labelId} htmlFor={`${labelId}-input`}>
            Add an entry
          </label>
          <input
            ref={inputRef}
            id={`${labelId}-input`}
            className="composer__input h-9 min-w-0 flex-1 touch:h-10"
            value={draft}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
            placeholder="Add an entry…"
            autoComplete="off"
            enterKeyHint="done"
            onFocus={onInputFocus}
          />
          <button
            className="composer__submit grid size-9 min-w-9 place-items-center rounded-md bg-primary text-primary-fg hover:bg-primary-hover touch:size-10 touch:min-w-10"
            type="submit"
            aria-label="Add entry"
            disabled={!parsed.text || Boolean(parsed.error)}
          >
            <Icon name="plus" size={16} />
          </button>
        </form>
      </div>
      {menuOpen ? (
        <>
          <span className="sr-only" id={menuLabelId}>
            Choose entry type
          </span>
          <button
            className="fixed inset-0 z-(--z-scrim) bg-transparent"
            type="button"
            aria-label="Close type menu"
            onClick={() => setMenuOpen(false)}
          />
          <div
            ref={menuRef}
            id={`${labelId}-menu`}
            className="type-menu absolute bottom-[calc(100%_+_6px)] left-3 z-(--z-menu) w-[208px] rounded-lg border border-border bg-bg p-1 shadow-(--shadow-menu) animate-(--animate-menu-in) motion-reduce:animate-none"
            role="menu"
            aria-labelledby={menuLabelId}
            onKeyDown={handleMenuKey}
            onPointerDown={keepComposerFocus}
          >
            {ENTRY_TYPES.map((type) => (
              <button
                className="flex min-h-10 w-full items-center gap-[9px] rounded-md px-[9px] text-md text-fg-body hover:bg-bg-line hover:text-fg"
                type="button"
                role="menuitemradio"
                aria-checked={defaultType === type}
                key={type}
                onClick={() => {
                  onDefaultTypeChange(type);
                  setMenuOpen(false);
                  inputRef.current?.focus();
                }}
              >
                <Icon name={entryIcon[type]} size={14} />
                <span className="flex-1 text-left">{TYPE_LABELS[type]}</span>
                {defaultType === type ? <Icon name="check" size={13} /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
