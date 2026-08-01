import { Icon } from './Icon';
import { cn } from '../lib/utils';

interface ToastProps {
  message: string;
  tone?: 'success' | 'error';
}

/*
 * Anchored 6px above the measured composer. `--composer-height` already
 * contains the composer's own `--sab` padding while the keyboard is closed, so
 * the inset is only re-added in the pre-measurement fallback — and the composer
 * drops that padding once the keyboard covers the home indicator, which is why
 * the `keyboard-open:` anchor omits it too.
 */
const TOAST =
  'toast fixed right-[max(12px,var(--sar))] bottom-[calc(var(--composer-height,calc(88px_+_var(--sab)))_+_6px)] left-[max(12px,var(--sal))] z-(--z-toast) mx-auto flex min-h-10 w-max max-w-[calc(100%_-_24px)] items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium shadow-(--shadow-toast) animate-(--animate-toast-in) motion-reduce:animate-none keyboard-open:bottom-[calc(var(--composer-height,88px)_+_6px_+_(100%_-_var(--vv-offset,0px)_-_var(--vv-height,100%)))]';

export function Toast({ message, tone = 'success' }: ToastProps) {
  return (
    <div
      className={cn(
        TOAST,
        tone === 'error'
          ? 'toast--error border border-danger-border bg-danger-bg text-danger'
          : 'bg-primary text-primary-fg',
      )}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <Icon name={tone === 'error' ? 'warning' : 'check'} size={14} />
      <span>{message}</span>
    </div>
  );
}
