import { cva } from 'class-variance-authority';
import type { ButtonHTMLAttributes, HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export type ChipVariant = 'fact' | 'removable' | 'error';

/*
 * The composer's derived facts, in one idiom: a 24px hairline pill on the DS-4
 * `2xs` rung, with a leading kind icon supplied by the caller. `removable` is
 * the same pill wearing a button — it grows to the 40px coarse-pointer minimum
 * through `touch:`, exactly like the destination chip's clear half, so the
 * narrow e2e sweep stays green with a draft in flight.
 *
 * `.parse-chip` is load-bearing: every e2e locator finds these by class rather
 * than by role, because a fact chip has none.
 */
const chipVariants = cva(
  'parse-chip inline-flex h-6 flex-none items-center gap-1 rounded-sm px-2 text-2xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        fact: 'bg-bg-line text-fg-mid',
        removable:
          'bg-bg-line text-fg-mid hover:bg-bg-raised hover:text-fg-body touch:h-10 touch:min-w-10',
        error: 'parse-chip--error border border-danger-border bg-danger-bg text-danger',
      },
    },
    defaultVariants: { variant: 'fact' },
  },
);

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** Only the inert variants: a chip you can act on is a `ChipButton`. */
  variant?: Extract<ChipVariant, 'fact' | 'error'>;
}

export function Chip({ className, variant, ...props }: ChipProps) {
  return <span className={cn(chipVariants({ variant }), className)} {...props} />;
}

export type ChipButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

/** A fact that can be taken back: the whole chip is the target, label included. */
export function ChipButton({ className, ...props }: ChipButtonProps) {
  return (
    <button
      className={cn(chipVariants({ variant: 'removable' }), className)}
      type="button"
      {...props}
    />
  );
}
