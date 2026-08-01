import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { Button } from './ui/button';
import { EMPTY_PANEL } from '../views/view-classes';
import type { DeadLetter } from '../store/models';

interface DeadLetterDialogProps {
  deadLetters: DeadLetter[];
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
  onClose: () => void;
}

export function DeadLetterDialog({
  deadLetters,
  onRetry,
  onDiscard,
  onClose,
}: DeadLetterDialogProps) {
  return (
    <Dialog
      title="Changes needing attention"
      description="These changes could not be accepted by the server. Nothing was silently dropped."
      onClose={onClose}
    >
      {deadLetters.length > 0 ? (
        <div className="flex flex-col gap-[9px]">
          {deadLetters.map((letter) => (
            <article
              className="grid grid-cols-[20px_1fr] gap-2 rounded-lg border border-danger-border bg-danger-bg p-[11px] text-danger"
              key={letter.id}
            >
              <Icon name="warning" size={15} />
              <div>
                <h3 className="text-sm font-medium text-fg">
                  {letter.operation ?? 'Journal change'}
                </h3>
                <p className="pt-[3px] text-xs text-fg-body">{letter.message}</p>
                <time className="block pt-[5px] text-count text-fg-mute" dateTime={letter.failedAt}>
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(letter.failedAt))}
                </time>
              </div>
              <footer className="col-start-2 flex gap-[7px] pt-1">
                <Button variant="secondary" size="sm" onClick={() => onRetry(letter.id)}>
                  <Icon name="refresh" size={12} /> Retry
                </Button>
                <Button variant="danger" size="sm" onClick={() => onDiscard(letter.id)}>
                  Discard
                </Button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <div className={`${EMPTY_PANEL} min-h-[150px]`}>
          <Icon name="check" size={18} />
          <p className="text-md text-fg-body">Everything is synced.</p>
        </div>
      )}
    </Dialog>
  );
}
