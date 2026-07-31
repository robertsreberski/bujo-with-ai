import type { SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/*
 * A styled wrapper around a real `<select>` so iOS keeps its native picker.
 * Mirrors the base.css select rule; the coarse-pointer 16px font comes from
 * that element rule and is not repeated here.
 */
export function NativeSelect({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-9 rounded-md border border-border-control bg-bg px-2.5 text-base text-fg focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-hover touch:min-h-10',
        className,
      )}
      {...props}
    />
  );
}
