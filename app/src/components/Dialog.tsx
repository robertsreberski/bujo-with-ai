import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type PropsWithChildren,
  type RefObject,
} from 'react';
import { Icon } from './Icon';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const dialogStack: symbol[] = [];

interface DialogProps extends PropsWithChildren {
  title: string;
  description?: string | undefined;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement> | undefined;
  size?: 'normal' | 'wide' | undefined;
  labelledBy?: string | undefined;
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
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const dialogIdRef = useRef(Symbol('journal-dialog'));
  const generatedTitleId = useId();
  const descriptionId = useId();
  const titleId = labelledBy ?? generatedTitleId;

  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    const dialogId = dialogIdRef.current;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogStack.push(dialogId);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (dialogStack.at(-1) !== dialogId) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const focusIsOutsideSequence =
        active === panelRef.current || !panelRef.current.contains(active);
      if (event.shiftKey && (focusIsOutsideSequence || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (focusIsOutsideSequence || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.documentElement.classList.add('dialog-open');
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const index = dialogStack.lastIndexOf(dialogId);
      if (index >= 0) dialogStack.splice(index, 1);
      if (dialogStack.length === 0) document.documentElement.classList.remove('dialog-open');
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
  }, []);

  useLayoutEffect(() => {
    const target =
      initialFocusRef?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
  }, [initialFocusRef]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    let startY = 0;
    let scroller: HTMLElement | null = null;
    const onTouchStart = (event: TouchEvent) => {
      startY = event.touches[0]?.clientY ?? 0;
      const target = event.target instanceof Element ? event.target : null;
      scroller = target?.closest<HTMLElement>('.scrollable') ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!scroller || scroller.scrollHeight <= scroller.clientHeight) {
        event.preventDefault();
        return;
      }
      const currentY = event.touches[0]?.clientY ?? startY;
      const movingDown = currentY > startY;
      const atTop = scroller.scrollTop <= 0;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if ((atTop && movingDown) || (atBottom && !movingDown)) event.preventDefault();
    };
    overlay.addEventListener('touchstart', onTouchStart, { passive: true });
    overlay.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      overlay.removeEventListener('touchstart', onTouchStart);
      overlay.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  return (
    <div
      ref={overlayRef}
      className="dialog-overlay"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        className={`dialog-panel${size === 'wide' ? ' dialog-panel--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="dialog-header">
          <div className="dialog-heading">
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <button
            className="icon-button icon-button--ghost"
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className="dialog-body scrollable">{children}</div>
      </div>
    </div>
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
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog title={title} description={description} onClose={onCancel} initialFocusRef={cancelRef}>
      <div className="dialog-actions dialog-actions--end">
        <button
          ref={cancelRef}
          className="button button--secondary"
          type="button"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button className="button button--danger-filled" type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
