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
import { ENTRY_TYPES, TYPE_LABELS, type EntryType, type ParsedDraft } from './types';

interface ComposerProps {
  draft: string;
  defaultType: EntryType;
  onDraftChange: (draft: string) => void;
  onDefaultTypeChange: (type: EntryType) => void;
  onSubmit: (parsed: ParsedDraft) => void;
}

export function Composer({
  draft,
  defaultType,
  onDraftChange,
  onDefaultTypeChange,
  onSubmit,
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
  const revealNewestDay = () => {
    const day = document.querySelector<HTMLElement>('.day-section');
    if (typeof day?.scrollIntoView === 'function') {
      day.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
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
    <div className="composer-shell">
      <div className="content-column composer">
        <div className="composer__preview" aria-live="polite">
          {parsed.error ? (
            <span className="parse-chip parse-chip--error">{parsed.error}</span>
          ) : draft ? (
            <>
              <span className="parse-chip">{TYPE_LABELS[parsed.type]}</span>
              {parsed.time ? <span className="parse-chip">at {parsed.time}</span> : null}
              {parsed.tags.map((tag) => (
                <span className="parse-chip" key={tag}>
                  #{tag}
                </span>
              ))}
              {parsed.dateShift ? <span className="parse-chip">tomorrow</span> : null}
            </>
          ) : (
            <span className="composer__hint">
              Shortcuts: <b>.</b> task · <b>o</b> event · <b>-</b> note · #tag · @3pm · &gt;tomorrow
            </span>
          )}
        </div>
        <form className="composer__form" onSubmit={submit}>
          <button
            className={`composer__type${parsed.signifierWon ? ' composer__type--overridden' : ''}`}
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
            <span>{TYPE_LABELS[parsed.type]}</span>
            <Icon name="chevronDown" size={12} />
          </button>
          <label className="sr-only" id={labelId} htmlFor={`${labelId}-input`}>
            Add an entry
          </label>
          <input
            ref={inputRef}
            id={`${labelId}-input`}
            className="composer__input"
            value={draft}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
            placeholder="Add an entry…"
            autoComplete="off"
            enterKeyHint="done"
            onFocus={revealNewestDay}
          />
          <button
            className="composer__submit"
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
            className="popover-scrim"
            type="button"
            aria-label="Close type menu"
            onClick={() => setMenuOpen(false)}
          />
          <div
            ref={menuRef}
            id={`${labelId}-menu`}
            className="type-menu"
            role="menu"
            aria-labelledby={menuLabelId}
            onKeyDown={handleMenuKey}
            onPointerDown={keepComposerFocus}
          >
            {ENTRY_TYPES.map((type) => (
              <button
                className="type-menu__option"
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
                <span>{TYPE_LABELS[type]}</span>
                {defaultType === type ? <Icon name="check" size={13} /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
