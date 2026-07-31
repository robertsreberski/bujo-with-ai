import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogSizeClassName,
  type DialogSize,
} from './dialog-classes';

export function AlertDialogRoot(props: ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root {...props} />;
}

export function AlertDialogTitle(
  props: ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>,
) {
  return <AlertDialogPrimitive.Title {...props} />;
}

export function AlertDialogDescription(
  props: ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>,
) {
  return <AlertDialogPrimitive.Description {...props} />;
}

/** Radix gives this element the initial focus, matching the old `cancelRef`. */
export function AlertDialogCancel(
  props: ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>,
) {
  return <AlertDialogPrimitive.Cancel {...props} />;
}

interface AlertDialogContentProps
  extends ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content> {
  size?: DialogSize;
  children: ReactNode;
}

/*
 * Same nested Overlay → Content shape as ui/dialog.tsx. `role` is pinned back to
 * `dialog`: Journal's confirmations have always been plain dialogs and the
 * release-evidence suite locates them that way. The alert-dialog behaviour that
 * matters is still Radix's — Cancel takes the initial focus, and an outside
 * press cannot dismiss a destructive confirmation.
 */
export function AlertDialogContent({
  size = 'normal',
  className,
  children,
  ...props
}: AlertDialogContentProps) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className={dialogOverlayClassName}>
        <AlertDialogPrimitive.Content
          role="dialog"
          aria-modal="true"
          className={cn(dialogPanelClassName, dialogSizeClassName[size], className)}
          {...props}
        >
          {children}
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Overlay>
    </AlertDialogPrimitive.Portal>
  );
}
