import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogSizeClassName,
  type DialogSize,
} from './dialog-classes';

export function DialogRoot(props: ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />;
}

/** Renders the `<h2>` the `.dialog-heading` rules expect, wired to aria-labelledby. */
export function DialogTitle(props: ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title {...props} />;
}

/** Renders the `<p>` the `.dialog-heading` rules expect, wired to aria-describedby. */
export function DialogDescription(
  props: ComponentPropsWithoutRef<typeof DialogPrimitive.Description>,
) {
  return <DialogPrimitive.Description {...props} />;
}

interface DialogContentProps extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  size?: DialogSize;
  children: ReactNode;
}

export function DialogContent({
  size = 'normal',
  className,
  children,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={dialogOverlayClassName}>
        {/* Radix relies on `hideOthers` alone; Journal's a11y contract also
            asserts the explicit modal flag. */}
        <DialogPrimitive.Content
          aria-modal="true"
          className={cn(dialogPanelClassName, dialogSizeClassName[size], className)}
          {...props}
        >
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Overlay>
    </DialogPrimitive.Portal>
  );
}
