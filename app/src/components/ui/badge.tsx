import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export type BadgeVariant =
  | 'type'
  | 'state'
  | 'ai'
  | 'modeAuto'
  | 'modeRead'
  | 'status'
  | 'statusOffline'
  | 'statusError'
  | 'connection'
  | 'count'
  | 'countActive';

/*
 * Re-plumbing of `.badge--type/state/ai`, `.mode-badge--auto/read`,
 * `.status-pill*`, and `.connection-pill*`, plus the DS-19 `count` pair that
 * Phase 4 wires to real data.
 */
const badgeVariants = cva('inline-flex items-center font-medium whitespace-nowrap', {
  variants: {
    variant: {
      type: 'h-[18px] gap-1 rounded-sm border border-border bg-bg px-1.5 text-2xs text-fg-mid',
      state:
        'h-[18px] gap-1 rounded-sm border border-bg-line bg-bg-line px-1.5 text-2xs text-fg-mid',
      ai: 'size-[18px] justify-center rounded-sm border border-ai-border bg-ai-bg text-2xs text-ai-fg',
      modeAuto: 'h-5 gap-1 rounded-sm border border-ai-border bg-ai-bg px-1.5 text-2xs text-ai-fg',
      modeRead: 'h-5 gap-1 rounded-sm bg-bg-line px-1.5 text-2xs text-fg-mid',
      status:
        'min-h-6 gap-[5px] rounded-full border border-border bg-bg-line px-2 py-0.5 text-2xs text-fg-body',
      statusOffline:
        'min-h-6 gap-[5px] rounded-full border border-border bg-bg-line px-2 py-0.5 text-2xs text-warning',
      statusError:
        'min-h-6 gap-[5px] rounded-full border border-danger-border bg-bg-line px-2 py-0.5 text-2xs text-danger',
      connection:
        'h-6 flex-none gap-[5px] rounded-full border border-border bg-bg-line px-2 text-2xs text-fg',
      count:
        // text-(length:…): tailwind-merge misreads the custom `text-count` size
        // as a text *color* and drops it when a color utility follows.
        'h-4 min-w-4 justify-center rounded-full bg-border-strong px-1 text-(length:--text-count) leading-none font-semibold text-fg',
      countActive:
        'h-4 min-w-4 justify-center rounded-full bg-primary px-1 text-(length:--text-count) leading-none font-semibold text-primary-fg',
    },
  },
  defaultVariants: { variant: 'type' },
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  asChild?: boolean;
}

export function Badge({ className, variant, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot : 'span';
  return <Comp className={cn(badgeVariants({ variant }), className)} {...props} />;
}
