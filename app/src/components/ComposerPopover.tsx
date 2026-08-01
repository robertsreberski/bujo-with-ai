import * as Popover from '@radix-ui/react-popover';
import type { ReactNode } from 'react';
import { Drawer } from 'vaul';
import { useCompactSurface } from '../hooks/use-compact-surface';
import { cn } from '../lib/utils';

interface ComposerPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The control that opens the surface; receives the trigger props. */
  trigger: ReactNode;
  title: string;
  description: string;
  /** Stable class the surface carries in both forms, for tests and motion audits. */
  marker: string;
  className?: string;
  /** Radix hands focus back to the trigger by default; composer surfaces refuse it. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
  /** Popover placement relative to the trigger; composer surfaces open upward. */
  side?: 'top' | 'bottom';
  children: ReactNode;
}

/*
 * Vaul hardcodes a 500ms slide (`[data-vaul-drawer]{animation-duration:.5s}`)
 * and re-asserts a matching inline `transition` while dragging, so the only way
 * to reach Journal's 160ms dialog motion is an `!important` override of both.
 * Author `!important` outranks vaul's non-important inline style, which is what
 * makes the drag transition follow too.
 */
const SHEET_MOTION =
  '[animation-duration:160ms]! [animation-timing-function:cubic-bezier(0.16,1,0.3,1)]! [transition:transform_160ms_cubic-bezier(0.16,1,0.3,1)]! motion-reduce:[animation:none]! motion-reduce:[transition:none]!';

const SHEET =
  'fixed inset-x-0 bottom-0 z-(--z-dialog) flex max-h-[calc(var(--vv-height,100dvh)_-_56px)] flex-col rounded-t-2xl border-t border-border bg-bg pb-[max(16px,var(--sab))] outline-none';

const PANEL =
  'w-[min(288px,calc(100vw_-_24px))] rounded-lg border border-border bg-bg p-1 shadow-(--shadow-menu) z-(--z-menu) animate-(--animate-menu-in) motion-reduce:animate-none';

/**
 * One trigger, two surfaces: an anchored Radix popover on a wide pointer-driven
 * layout, a vaul bottom sheet below 680px. Both keep the composer's own menu
 * styling so the picker and the type menu read as one family.
 */
export function ComposerPopover({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  marker,
  className,
  onCloseAutoFocus,
  side = 'top',
  children,
}: ComposerPopoverProps) {
  const compact = useCompactSurface();

  if (compact) {
    return (
      <Drawer.Root open={open} onOpenChange={onOpenChange}>
        <Drawer.Trigger asChild>{trigger}</Drawer.Trigger>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-(--z-scrim) bg-overlay" />
          <Drawer.Content
            className={cn(marker, SHEET, SHEET_MOTION, className)}
            onCloseAutoFocus={onCloseAutoFocus}
          >
            <Drawer.Handle className="mx-auto mt-2.5 mb-1 h-1 w-9 flex-none rounded-full bg-border-strong" />
            <Drawer.Title className="flex-none px-4 pt-2 text-lg text-fg">{title}</Drawer.Title>
            <Drawer.Description className="flex-none px-4 pt-0.5 text-sm text-fg-mute">
              {description}
            </Drawer.Description>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={cn(marker, PANEL, className)}
          side={side}
          align="start"
          sideOffset={6}
          collisionPadding={12}
          aria-label={title}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
