import { Icon } from './Icon';

interface ToastProps {
  message: string;
  tone?: 'success' | 'error';
}

export function Toast({ message, tone = 'success' }: ToastProps) {
  return (
    <div
      className={`toast toast--${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <Icon name={tone === 'error' ? 'warning' : 'check'} size={14} />
      <span>{message}</span>
    </div>
  );
}
