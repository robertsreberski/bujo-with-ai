import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { Button } from './ui/button';
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
        <div className="dead-letter-list">
          {deadLetters.map((letter) => (
            <article className="dead-letter" key={letter.id}>
              <Icon name="warning" size={15} />
              <div>
                <h3>{letter.operation ?? 'Journal change'}</h3>
                <p>{letter.message}</p>
                <time dateTime={letter.failedAt}>
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(letter.failedAt))}
                </time>
              </div>
              <footer>
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
        <div className="dead-letter-empty">
          <Icon name="check" size={18} />
          <p>Everything is synced.</p>
        </div>
      )}
    </Dialog>
  );
}
