import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/utils';

/*
 * Re-plumbing of the legacy `.preference-toggle` recipe: a 40×24 track with an
 * 18px thumb travelling 16px. On coarse pointers the root grows to a 44×44 hit
 * area around the unchanged track, the way the old absolutely-positioned
 * checkbox did.
 */
export function Switch({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'group grid h-6 w-10 flex-none place-items-center bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-hover touch:size-11 touch:min-h-11 touch:min-w-11',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none block h-6 w-10 rounded-full border border-border-control bg-bg-line p-0.5 transition-colors group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary motion-reduce:transition-none"
      >
        <SwitchPrimitive.Thumb className="block size-[18px] rounded-full bg-fg-mute transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary-fg motion-reduce:transition-none" />
      </span>
    </SwitchPrimitive.Root>
  );
}
