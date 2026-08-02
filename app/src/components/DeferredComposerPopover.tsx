import {
  cloneElement,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ReactElement,
} from 'react';
import type { ComposerPopover as ComposerPopoverValue } from './ComposerPopover';

type ComposerPopoverComponent = typeof ComposerPopoverValue;
type ComposerPopoverProps = ComponentProps<ComposerPopoverComponent>;

interface DeferredComposerPopoverProps extends Omit<ComposerPopoverProps, 'trigger'> {
  trigger: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
}

let pendingLoad: Promise<ComposerPopoverComponent> | null = null;

function loadComposerPopover(): Promise<ComposerPopoverComponent> {
  pendingLoad ??= import('./ComposerPopover')
    .then((module) => module.ComposerPopover)
    .catch((error: unknown) => {
      // A failed module fetch must be retryable after the connection returns.
      pendingLoad = null;
      throw error;
    });
  return pendingLoad;
}

/**
 * Keeps the capture controls usable before the optional popover/sheet runtime
 * arrives. A failed dynamic import closes only that optional surface; it never
 * escapes through React and blanks the capture-first application shell.
 */
export function DeferredComposerPopover({
  open,
  onOpenChange,
  trigger,
  ...props
}: DeferredComposerPopoverProps) {
  const [Popover, setPopover] = useState<ComposerPopoverComponent | null>(null);

  useEffect(() => {
    if (!open || Popover !== null) return;
    let active = true;
    void loadComposerPopover()
      .then((component) => {
        if (active) setPopover(() => component);
      })
      .catch(() => {
        if (active) onOpenChange(false);
      });
    return () => {
      active = false;
    };
  }, [onOpenChange, open, Popover]);

  if (Popover !== null) {
    return <Popover {...props} open={open} onOpenChange={onOpenChange} trigger={trigger} />;
  }

  return cloneElement(trigger, {
    'aria-busy': open || undefined,
    'aria-expanded': open || undefined,
    onClick: (event) => {
      trigger.props.onClick?.(event);
      if (!event.defaultPrevented) onOpenChange(true);
    },
  });
}
