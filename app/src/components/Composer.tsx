import type { TagUsage } from '@journal/server/contracts/app';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { CaptureHelp } from './CaptureHelp';
import { ComposerSuggestions } from './ComposerSuggestions';
import { DestinationChip } from './DestinationChip';
import { Icon } from './Icon';
import { parseDraft, removeCaptureToken, type CaptureTokenKind } from './capture';
import { resolveDestination, sameDestination, type Destination } from './destination';
import { entryIcon } from './entry-icons';
import { SIGNIFIER_BY_TYPE, typeForSignifier } from './signifiers';
import { Chip, ChipButton } from './ui/chip';
import { useComposerSuggestions } from '../hooks/use-composer-suggestions';
import { cn } from '../lib/utils';
import type { JournalRoute } from '../routes/useJournalRoute';
import {
  ENTRY_TYPES,
  TYPE_LABELS,
  type EntryType,
  type JournalCollection,
  type ParsedDraft,
} from './types';

/*
 * `text-(length:--text-tag)`: tailwind-merge reads the bare `text-tag` size as a
 * text *color* and drops it when a real color utility follows it in one cn().
 */
const KBD =
  'ml-auto inline-flex min-w-4 flex-none items-center justify-center rounded-sm border border-border px-1 text-(length:--text-tag) font-mono text-fg-faint';

interface ComposerProps {
  draft: string;
  defaultType: EntryType;
  onDraftChange: (draft: string) => void;
  onDefaultTypeChange: (type: EntryType) => void;
  onSubmit: (parsed: ParsedDraft) => void;
  onInputFocus?: (() => void) | undefined;
  /** Screen context for the ambient destination. */
  route: JournalRoute;
  today: string;
  collectionsById: Record<string, JournalCollection>;
  /** Filing targets for the picker and `/slug` completion. */
  collections?: readonly JournalCollection[] | undefined;
  tagSuggestions?: readonly TagUsage[] | undefined;
  onLoadTagSuggestions?: (() => void) | undefined;
  chipOverride?: Destination | null | undefined;
  onChipOverrideChange?: ((destination: Destination | null) => void) | undefined;
  /** Bumped by `focusComposer`; every change pulls focus into the input. */
  focusRequest?: number | undefined;
}

export function Composer({
  draft,
  defaultType,
  onDraftChange,
  onDefaultTypeChange,
  onSubmit,
  onInputFocus,
  route,
  today,
  collectionsById,
  collections = [],
  tagSuggestions = [],
  onLoadTagSuggestions,
  chipOverride = null,
  onChipOverrideChange,
  focusRequest,
}: ComposerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [caret, setCaret] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusMenuOnOpenRef = useRef(false);
  const pendingCaretRef = useRef<number | null>(null);
  // Set when Enter accepted a completion, so the submit it would otherwise
  // trigger is swallowed without also disarming a click on "Add entry" —
  // iOS Safari never blurs the input for that click, so it would still look open.
  const consumedEnterRef = useRef(false);
  const labelId = useId();
  const menuLabelId = useId();
  const parsed = parseDraft(draft, defaultType);

  const resolved = resolveDestination({
    route,
    today,
    chipOverride,
    parsedCollection: parsed.collection,
    dateShift: parsed.dateShift,
    collectionsById,
  });
  const screenDestination = resolveDestination({
    route,
    today,
    chipOverride: null,
    parsedCollection: null,
    dateShift: null,
    collectionsById,
  }).destination;

  const suggestions = useComposerSuggestions({
    value: draft,
    caret,
    enabled: focused,
    collections,
    tags: tagSuggestions,
    onLoadTags: onLoadTagSuggestions,
  });

  const focusInput = useCallback(() => inputRef.current?.focus(), []);

  useLayoutEffect(() => {
    if (menuOpen && focusMenuOnOpenRef.current) {
      menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
      focusMenuOnOpenRef.current = false;
    }
  }, [menuOpen]);

  // An accepted completion rewrites the draft through the store, so the caret is
  // restored once the new value has actually landed in the DOM node.
  useLayoutEffect(() => {
    const position = pendingCaretRef.current;
    if (position === null) return;
    pendingCaretRef.current = null;
    inputRef.current?.setSelectionRange(position, position);
    setCaret(position);
  }, [draft]);

  useEffect(() => {
    if (focusRequest === undefined) return;
    inputRef.current?.focus();
  }, [focusRequest]);

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
    // A completion accepted with Enter must never also file the entry.
    if (consumedEnterRef.current) {
      consumedEnterRef.current = false;
      return;
    }
    if (!parsed.text || parsed.error) return;
    onSubmit(parsed);
    setMenuOpen(false);
    inputRef.current?.focus();
  };

  const acceptSuggestion = (index: number) => {
    const next = suggestions.accept(index);
    if (next === null) return;
    if (next.value === draft) {
      // No draft change means no layout effect will fire — place the caret now
      // instead of arming a ref that a later unrelated edit would consume.
      pendingCaretRef.current = null;
      inputRef.current?.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    } else {
      pendingCaretRef.current = next.caret;
      onDraftChange(next.value);
    }
    inputRef.current?.focus();
  };

  const trackCaret = (element: HTMLInputElement) => setCaret(element.selectionStart);

  /*
   * The combobox contract is permanent, per ARIA 1.2: the input is always a
   * combobox and `aria-expanded` reports whether the popup is showing. The role
   * must never change on a focused field — WebKit rebuilds the accessibility
   * and editing context on a role mutation, which drops the caret to the end.
   * Only the popup-relative attributes come and go, because pointing
   * `aria-controls`/`aria-activedescendant` at an element that does not exist
   * is itself an accessibility violation.
   */
  const popupProps = suggestions.open
    ? ({
        'aria-controls': suggestions.panelId,
        'aria-activedescendant': suggestions.activeOptionId,
      } as const)
    : {};

  const clearDestination = ((): (() => void) | null => {
    if (resolved.source === 'chip') return () => onChipOverrideChange?.(null);
    if (resolved.source !== 'token') return null;
    const destination = resolved.destination;
    if (destination.kind === 'collection') {
      return () => onDraftChange(removeCaptureToken(draft, 'collection', destination.id));
    }
    return () => onDraftChange(removeCaptureToken(draft, 'date-shift'));
  })();

  const selectDestination = (destination: Destination) => {
    // Re-picking the screen's own default retires the override rather than
    // pinning a chip that only repeats what the screen already said.
    onChipOverrideChange?.(sameDestination(destination, screenDestination) ? null : destination);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Keys pressed to steer an IME composition are the IME's, not ours: Enter
    // confirms the composition and Escape cancels it — never accept, never
    // clear the draft.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') consumedEnterRef.current = false;
    if (suggestions.open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        suggestions.move(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        if (event.key === 'Enter') {
          // Swallow only the implicit form submission this same Enter would
          // dispatch (synchronously, within this task). Disarming in a
          // microtask keeps a later Add-entry *click* from being eaten —
          // preventDefault() usually stops the submit from ever firing.
          consumedEnterRef.current = true;
          queueMicrotask(() => {
            consumedEnterRef.current = false;
          });
        }
        acceptSuggestion(suggestions.activeIndex);
        return;
      }
    }
    if (event.key !== 'Escape') return;
    // One ladder, rung by rung: the panel, then the type menu, then the draft,
    // and only an already-empty composer gives the keyboard back to the page.
    event.preventDefault();
    event.stopPropagation();
    if (suggestions.open) {
      suggestions.dismiss();
      return;
    }
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    if (draft) {
      onDraftChange('');
      return;
    }
    inputRef.current?.blur();
  };

  const keepComposerFocus = (event: PointerEvent) => event.preventDefault();

  /*
   * Dismissing a fact chip edits the draft the owner actually typed, then hands
   * the caret straight back — the pointer-down was swallowed, so the input never
   * blurred and the iOS keyboard never dropped.
   */
  const removeToken = (kind: CaptureTokenKind, value: string | null) => {
    const next = removeCaptureToken(draft, kind, value ?? undefined);
    /*
     * Arm the caret before the shorter draft lands: the `[draft]` layout effect
     * is the single path that moves the DOM selection and the `caret` state
     * together, and an unreconciled `caret` leaves the suggestion machinery
     * reading the new draft at an offset the input no longer has. Skipped when
     * the removal was a no-op, so no effect can consume a stale armed ref later
     * (the same hazard `acceptSuggestion` guards).
     */
    if (next !== draft) pendingCaretRef.current = next.length;
    onDraftChange(next);
    inputRef.current?.focus();
  };

  const handleMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // A bare signifier keystroke is the shortcut; Ctrl+O is the browser's.
    const bareKey = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
    const signifierType = bareKey ? typeForSignifier(event.key) : null;
    if (signifierType !== null) {
      event.preventDefault();
      onDefaultTypeChange(signifierType);
      setMenuOpen(false);
      inputRef.current?.focus();
      return;
    }
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
      <div className="relative mx-auto w-full max-w-(--content-width) px-3 pt-2 pb-2.5">
        <ComposerSuggestions state={suggestions} onAccept={acceptSuggestion} />
        {/*
         * The context zone: the destination leads at full width, the facts the
         * parser found follow and wrap onto further lines rather than truncate,
         * and help sits at the top right so it stays put as the facts grow.
         */}
        <div className="flex items-start gap-1.5 pb-1.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
            <DestinationChip
              resolved={resolved}
              route={route}
              today={today}
              collections={collections}
              collectionsById={collectionsById}
              screenDestination={screenDestination}
              onSelect={selectDestination}
              onClear={clearDestination}
              onRestoreFocus={focusInput}
            />
            <div
              className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1"
              aria-live="polite"
            >
              {parsed.error ? (
                <Chip variant="error">{parsed.error}</Chip>
              ) : draft ? (
                <>
                  <Chip>
                    <Icon name={entryIcon[parsed.type]} size={11} />
                    {TYPE_LABELS[parsed.type]}
                  </Chip>
                  {parsed.time ? (
                    <ChipButton
                      // WCAG 2.5.3: the visible `at HH:MM` is a substring of the
                      // name, so a voice command can say what the chip reads.
                      aria-label={`Remove time at ${parsed.time}`}
                      onPointerDown={keepComposerFocus}
                      onClick={() => removeToken('time', parsed.time)}
                    >
                      <Icon name="clock" size={11} />
                      {/* Its own element so the chip's text is exactly the fact:
                          the icons contribute nothing to textContent. */}
                      <span>at {parsed.time}</span>
                      <Icon name="close" size={10} className="opacity-60" />
                    </ChipButton>
                  ) : null}
                  {parsed.tags.map((tag) => (
                    <ChipButton
                      aria-label={`Remove tag #${tag}`}
                      key={tag}
                      onPointerDown={keepComposerFocus}
                      onClick={() => removeToken('tag', tag)}
                    >
                      {/* The `#` is the icon, so the label stays the bare tag. */}
                      <Icon name="hash" size={11} />
                      <span>{tag}</span>
                      <Icon name="close" size={10} className="opacity-60" />
                    </ChipButton>
                  ))}
                </>
              ) : null}
            </div>
          </div>
          <CaptureHelp />
        </div>
        <form className="composer__form flex items-center gap-2" onSubmit={submit}>
          <button
            className={cn(
              // Below 480px the label is hidden, so the button stops reserving
              // room for it and gives the draft the width instead.
              'composer__type flex h-9 min-w-[104px] items-center gap-1.5 rounded-md border border-border-control bg-bg px-[9px] text-sm max-[480px]:min-w-[62px] max-[480px]:justify-center max-[480px]:px-2 touch:h-10',
              parsed.signifierWon ? 'composer__type--overridden text-fg-mute' : 'text-fg-body',
            )}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={`${labelId}-menu`}
            aria-label={
              parsed.signifierWon
                ? `Entry type: ${TYPE_LABELS[parsed.type]}. Type set by leading '${SIGNIFIER_BY_TYPE[parsed.type]}' — remove it to choose`
                : `Entry type: ${TYPE_LABELS[parsed.type]}`
            }
            title={
              parsed.signifierWon
                ? `Type set by leading '${SIGNIFIER_BY_TYPE[parsed.type]}' — remove it to choose`
                : undefined
            }
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
          <div className="relative flex min-w-0 flex-1 items-center">
            <input
              ref={inputRef}
              id={`${labelId}-input`}
              className={cn('composer__input h-9 w-full min-w-0 touch:h-10', draft && 'pr-10')}
              value={draft}
              onChange={(event) => {
                trackCaret(event.currentTarget);
                onDraftChange(event.currentTarget.value);
              }}
              placeholder="Add an entry…"
              autoComplete="off"
              enterKeyHint="done"
              onFocus={(event) => {
                setFocused(true);
                trackCaret(event.currentTarget);
                onInputFocus?.();
              }}
              onBlur={() => setFocused(false)}
              onClick={(event) => trackCaret(event.currentTarget)}
              onKeyUp={(event) => trackCaret(event.currentTarget)}
              onKeyDown={handleInputKeyDown}
              role="combobox"
              aria-expanded={suggestions.open}
              aria-autocomplete="list"
              {...popupProps}
            />
            {draft ? (
              <button
                className="absolute top-1/2 right-1 grid size-7 -translate-y-1/2 place-items-center rounded-sm text-fg-mute hover:bg-bg-line hover:text-fg touch:size-10"
                type="button"
                aria-label="Clear draft"
                onPointerDown={keepComposerFocus}
                onClick={() => {
                  onDraftChange('');
                  inputRef.current?.focus();
                }}
              >
                <Icon name="close" size={13} />
              </button>
            ) : null}
          </div>
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
                {/* Hidden from the name: the label already says "Task", and the
                    legend behind the help button teaches the signifier. */}
                <kbd className={KBD} aria-hidden="true">
                  {SIGNIFIER_BY_TYPE[type]}
                </kbd>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
