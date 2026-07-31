import { useLayoutEffect, useRef, type PropsWithChildren, type RefObject } from 'react';
import { Icon } from './Icon';
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogRoot,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Button } from './ui/button';
import { DialogContent, DialogDescription, DialogRoot, DialogTitle } from './ui/dialog';

interface DialogProps extends PropsWithChildren {
  title: string;
  description?: string | undefined;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement> | undefined;
  size?: 'normal' | 'wide' | undefined;
  labelledBy?: string | undefined;
}

/*
 * Radix owns the focus trap, the nested-dialog Escape routing, the background
 * scroll lock, and the aria wiring. Both content components are modal, so their
 * built-in close-autofocus targets a `Trigger` this app never renders — the
 * dialogs mount from state instead. Each adapter therefore records the element
 * that had focus on mount and restores it itself.
 */
function useRestoreFocus(): (event: Event) => void {
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);
  return (event: Event) => {
    event.preventDefault();
    const previous = previousFocusRef.current;
    if (previous?.isConnected) previous.focus();
  };
}

export function Dialog({
  title,
  description,
  onClose,
  children,
  initialFocusRef,
  size = 'normal',
  labelledBy,
}: DialogProps) {
  const closeRef = useRef(onClose);
  const restoreFocus = useRestoreFocus();

  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) closeRef.current();
      }}
    >
      <DialogContent
        size={size}
        onCloseAutoFocus={restoreFocus}
        onOpenAutoFocus={(event) => {
          const target = initialFocusRef?.current;
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
        {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <header className="dialog-header">
          <div className="dialog-heading">
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-[26px] touch:size-10"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <Icon name="close" size={15} />
          </Button>
        </header>
        <div className="dialog-body scrollable">{children}</div>
      </DialogContent>
    </DialogRoot>
  );
}

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef(onCancel);
  const restoreFocus = useRestoreFocus();

  useLayoutEffect(() => {
    cancelRef.current = onCancel;
  }, [onCancel]);

  return (
    <AlertDialogRoot
      open
      onOpenChange={(open) => {
        if (!open) cancelRef.current();
      }}
    >
      <AlertDialogContent onCloseAutoFocus={restoreFocus}>
        <header className="dialog-header">
          <div className="dialog-heading">
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-[26px] touch:size-10"
            onClick={onCancel}
            aria-label="Close dialog"
          >
            <Icon name="close" size={15} />
          </Button>
        </header>
        <div className="dialog-body scrollable">
          <div className="dialog-actions dialog-actions--end">
            {/* Cancel carries no handler of its own: Radix closes through
                `onOpenChange`, which already reports the cancellation. */}
            <AlertDialogCancel asChild>
              <Button variant="secondary">Cancel</Button>
            </AlertDialogCancel>
            <Button variant="dangerFilled" onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      </AlertDialogContent>
    </AlertDialogRoot>
  );
}
