import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/*
 * Thin re-plumbing of the base.css `input` element rule. The coarse-pointer
 * 16px font (which stops iOS from zooming on focus) is inherited from that same
 * element rule and is deliberately not repeated here.
 */
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-9 rounded-md border border-border-control bg-bg px-2.5 text-base text-fg focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-hover touch:min-h-10',
        className,
      )}
      {...props}
    />
  );
}
