import { cn } from '../lib/utils';
import type { ComposerSuggestionsState } from '../hooks/use-composer-suggestions';

interface ComposerSuggestionsProps {
  state: ComposerSuggestionsState;
  onAccept: (index: number) => void;
}

const ROW =
  'flex min-h-[34px] cursor-default items-center gap-2 px-3 text-md text-fg-body touch:min-h-10';

/**
 * The completion list. It renders inside `.composer-shell` rather than a portal
 * so it inherits the composer's keyboard-open pinning, and the surface swallows
 * pointerdown so a tap never blurs the input (which would close the panel and
 * drop the mobile keyboard before the tap resolves).
 *
 * The caption lives outside the listbox on purpose: a `role="listbox"` may only
 * parent options, so the one piece of teaching a list of completions cannot
 * carry sits beside it rather than inside it.
 */
export function ComposerSuggestions({ state, onAccept }: ComposerSuggestionsProps) {
  if (!state.open) return null;
  return (
    <div
      className="composer-suggestions absolute right-3 bottom-full left-3 z-(--z-menu) mb-1.5 overflow-hidden rounded-lg border border-border bg-bg shadow-(--shadow-menu) animate-(--animate-menu-in) motion-reduce:animate-none"
      onPointerDown={(event) => event.preventDefault()}
    >
      <div className="py-1" id={state.panelId} role="listbox" aria-label="Capture suggestions">
        {state.rows.map((row, index) => (
          <div
            className={cn(ROW, index === state.activeIndex && 'bg-bg-line text-fg')}
            id={state.optionId(index)}
            key={row.key}
            role="option"
            aria-selected={index === state.activeIndex}
            onPointerEnter={() => state.setActiveIndex(index)}
            onClick={() => onAccept(index)}
          >
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              {row.label}
            </span>
            <span className="flex-none text-xs text-fg-mute">{row.detail}</span>
          </div>
        ))}
      </div>
      {state.hint === null ? null : (
        <p className="composer-suggestions__hint border-t border-border px-3 py-2 text-xs text-fg-mute">
          {state.hint}
        </p>
      )}
    </div>
  );
}
