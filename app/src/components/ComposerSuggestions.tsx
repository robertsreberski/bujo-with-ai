import { useRef, type PointerEvent } from 'react';
import { cn } from '../lib/utils';
import type { ComposerSuggestionsState } from '../hooks/use-composer-suggestions';

interface ComposerSuggestionsProps {
  state: ComposerSuggestionsState;
  onAccept: (index: number) => void;
}

const ROW =
  'flex min-h-[34px] w-full cursor-default items-center gap-2 px-3 text-left text-md text-fg-body touch:min-h-10';

/** Travel past this between down and up is a scroll or a drag, not a choice. */
const TAP_SLOP = 10;

/** The row a pointer went down on, so the up that follows can be judged against it. */
interface PendingTap {
  pointerId: number;
  index: number;
  x: number;
  y: number;
}

function isTapOn(pending: PendingTap | null, index: number, event: PointerEvent): boolean {
  if (pending === null || pending.index !== index || pending.pointerId !== event.pointerId) {
    return false;
  }
  return Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < TAP_SLOP;
}

/**
 * The completion list. It renders inside `.composer-shell` rather than a portal
 * so it inherits the composer's keyboard-open pinning, and the surface swallows
 * pointerdown so a tap never blurs the input (which would close the panel and
 * drop the mobile keyboard before the tap resolves).
 *
 * The container and the listbox are always in the DOM and merely `hidden` when
 * shut, so the input's `aria-controls` points at something real at all times
 * instead of appearing and vanishing on a focused field (LOG-49). Only the rows
 * and the caption come and go. `display: none` restarts a CSS animation, so the
 * static `animate-(--animate-menu-in)` still plays on every reopen.
 *
 * The caption lives outside the listbox on purpose: a `role="listbox"` may only
 * parent options, so the one piece of teaching a list of completions cannot
 * carry sits beside it rather than inside it.
 */
export function ComposerSuggestions({ state, onAccept }: ComposerSuggestionsProps) {
  const pendingTapRef = useRef<PendingTap | null>(null);

  return (
    <div
      className="composer-suggestions absolute right-3 bottom-full left-3 z-(--z-menu) mb-1.5 overflow-hidden rounded-lg border border-border bg-bg shadow-(--shadow-menu) animate-(--animate-menu-in) motion-reduce:animate-none"
      hidden={!state.open}
      onPointerDown={(event) => event.preventDefault()}
    >
      <div className="py-1" id={state.panelId} role="listbox" aria-label="Capture suggestions">
        {state.open
          ? state.rows.map((row, index) => (
              <button
                className={cn(ROW, index === state.activeIndex && 'bg-bg-line text-fg')}
                id={state.optionId(index)}
                key={row.key}
                type="button"
                role="option"
                // The rows are reached with the arrow keys from the input, which
                // keeps the caret and the mobile keyboard where they are; the
                // roving focus a listbox would otherwise take is never wanted.
                tabIndex={-1}
                aria-selected={index === state.activeIndex}
                // Touch must not repaint the active row under the finger that is
                // already choosing one; a mouse still previews what it is over.
                onPointerEnter={(event) => {
                  if (event.pointerType !== 'touch') state.setActiveIndex(index);
                }}
                /*
                 * Accepting on pointerup, not on click, is the whole fix: iOS
                 * synthesizes a click for this row unreliably — a bare option
                 * inside a surface that suppressed pointerdown — so a real tap
                 * closed the panel without ever inserting. No preventDefault
                 * here: the wrapper already swallowed the one that retains focus.
                 */
                onPointerDown={(event) => {
                  pendingTapRef.current = {
                    pointerId: event.pointerId,
                    index,
                    x: event.clientX,
                    y: event.clientY,
                  };
                }}
                onPointerUp={(event) => {
                  const pending = pendingTapRef.current;
                  pendingTapRef.current = null;
                  if (!isTapOn(pending, index, event)) return;
                  onAccept(index);
                }}
                onPointerCancel={() => {
                  pendingTapRef.current = null;
                }}
                /*
                 * `detail` is the discriminator, and it needs no state to hold
                 * it. Pointerup already owns every real pointer interaction —
                 * mouse and finger alike — so a click counting a press
                 * (`detail > 0`) is either that same tap arriving twice or the
                 * tail of a drag the slop guard just refused. Neither may
                 * insert. A click with `detail === 0` had no press behind it:
                 * that is assistive technology activating the row on its own,
                 * the one caller left that still needs an answer here.
                 */
                onClick={(event) => {
                  if (event.detail !== 0) return;
                  onAccept(index);
                }}
              >
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {row.label}
                </span>
                <span className="flex-none text-xs text-fg-mute">{row.detail}</span>
              </button>
            ))
          : null}
      </div>
      {state.open && state.hint !== null ? (
        <p className="composer-suggestions__hint border-t border-border px-3 py-2 text-xs text-fg-mute">
          {state.hint}
        </p>
      ) : null}
    </div>
  );
}
