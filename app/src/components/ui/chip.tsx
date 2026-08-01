import { cva } from 'class-variance-authority';
import type { ButtonHTMLAttributes, HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export type ChipVariant = 'fact' | 'removable' | 'error';

/*
 * One ink for every chip in the composer's context zone, the destination
 * included: a 24px hairline pill on the DS-4 `2xs` rung with a leading kind icon
 * supplied by the caller. Size never varies — a chip that can be acted on looks
 * exactly like one that cannot.
 *
 * So the coarse-pointer minimum is paid outside the ink. `ChipButton` is a
 * transparent 40x40 box (`touch:h-10 touch:min-w-10`) with the pill as its only
 * child, and `touch:-my-2` hands the extra height straight back to the layout,
 * so the row still occupies 24px: the growth is symmetric, 8px up into the
 * shell's own `pt-2` dead zone and 8px down onto the input, which paints later
 * and so keeps its own taps. The e2e sweep measures the button's box (40px);
 * the owner sees the pill (24px). No horizontal negative margins — a chip that
 * bled sideways would eat its neighbour's target instead of dead space.
 *
 * Inert chips (`fact`, `error`) never grow: they are not targets, and growing
 * them was the whole reason the row used to render two chip sizes at once.
 */
const INK = 'h-6 items-center gap-1 rounded-sm px-2 text-2xs font-medium whitespace-nowrap';

const chipInk = cva(INK, {
  variants: {
    variant: {
      fact: 'bg-bg-line text-fg-mid',
      // Hover lives on the ink but is driven by the button, so the whole 40px
      // box lights the pill it belongs to.
      removable: 'bg-bg-line text-fg-mid group-hover:bg-bg-raised group-hover:text-fg-body',
      error: 'parse-chip--error border border-danger-border bg-danger-bg text-danger',
    },
  },
  defaultVariants: { variant: 'fact' },
});

/*
 * `.parse-chip` is load-bearing and stays on the outer element of both shapes:
 * every e2e locator finds these by class rather than by role, because a fact
 * chip has none.
 */
const OUTER = 'parse-chip inline-flex flex-none';

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** Only the inert variants: a chip you can act on is a `ChipButton`. */
  variant?: Extract<ChipVariant, 'fact' | 'error'>;
}

export function Chip({ className, variant, ...props }: ChipProps) {
  return <span className={cn(OUTER, chipInk({ variant }), className)} {...props} />;
}

export type ChipButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

/** A fact that can be taken back: the whole chip is the target, label included. */
export function ChipButton({ className, children, ...props }: ChipButtonProps) {
  return (
    <button
      className={cn(
        // `p-0`: preflight is off, so a bare button still wears the UA's own
        // 1px/6px padding — which would sit *outside* the ink and push every
        // chip 6px right of where the row placed it.
        'group items-center h-6 p-0 touch:h-10 touch:min-w-10 touch:-my-2',
        OUTER,
        className,
      )}
      type="button"
      {...props}
    >
      <span className={cn('flex', chipInk({ variant: 'removable' }))}>{children}</span>
    </button>
  );
}
