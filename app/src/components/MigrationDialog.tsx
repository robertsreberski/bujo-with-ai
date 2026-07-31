import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { formatLongDate } from './dates';
import type { JournalEntry } from './types';

interface MigrationDialogProps {
  entries: JournalEntry[];
  onClose: () => void;
  onMigrate: (entry: JournalEntry) => Promise<void>;
  onUpdate: (entry: JournalEntry, state: 'done' | 'cancelled') => Promise<void>;
  onSchedule: (entry: JournalEntry) => Promise<void>;
  onComplete: () => void;
}

type PendingAction = 'migrate' | 'done' | 'schedule' | 'drop';

export function MigrationDialog({
  entries,
  onClose,
  onMigrate,
  onUpdate,
  onSchedule,
  onComplete,
}: MigrationDialogProps) {
  const [index, setIndex] = useState(0);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const taskHeadingRef = useRef<HTMLHeadingElement>(null);
  const taskHeadingId = useId();
  const queue = useMemo(() => entries.filter((entry) => entry.state === 'open'), [entries]);
  const current = queue[index];

  useLayoutEffect(() => {
    if (index > 0) taskHeadingRef.current?.focus({ preventScroll: true });
  }, [index]);

  const decide = async (action: PendingAction, operation: () => Promise<void>) => {
    if (!current || pending) return;
    setPending(action);
    setAnnouncement(`Updating ${current.text}.`);
    try {
      await operation();
    } catch {
      setPending(null);
      setAnnouncement(`Could not update ${current.text}. It is still waiting for a decision.`);
      return;
    }
    const nextIndex = index + 1;
    if (nextIndex >= queue.length) {
      setPending(null);
      setAnnouncement('All decisions accepted.');
      onComplete();
      return;
    }
    const next = queue[nextIndex];
    setIndex(nextIndex);
    setPending(null);
    setAnnouncement(
      next ? `Next task: ${next.text}. ${nextIndex + 1} of ${queue.length}.` : 'Next task.',
    );
  };

  if (!current) {
    return (
      <Dialog title="Migration" description="Nothing is waiting for a decision." onClose={onClose}>
        <div className="dialog-actions dialog-actions--end">
          <button className="button button--primary" type="button" onClick={onComplete}>
            Done
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Migration"
      description={`${index + 1} of ${queue.length} — what should happen to this one?`}
      onClose={onClose}
    >
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <article
        className="migration-card"
        aria-labelledby={taskHeadingId}
        aria-busy={pending !== null}
      >
        <h3 ref={taskHeadingRef} id={taskHeadingId} tabIndex={-1}>
          {current.text}
        </h3>
        <p>
          From {formatLongDate(current.date)}
          {current.tags.length ? ` · ${current.tags.map((tag) => `#${tag}`).join(' ')}` : ''}
        </p>
        {current.migrations > 1 ? (
          <aside>
            <Icon name="sparkle" size={12} />
            <span>Moved forward {current.migrations} times already. Consider dropping it.</span>
          </aside>
        ) : null}
      </article>
      <div className="migration-actions" aria-busy={pending !== null}>
        <button
          className="button button--primary"
          type="button"
          disabled={pending !== null}
          onClick={() => void decide('migrate', () => onMigrate(current))}
        >
          <Icon name="arrowRight" size={14} />
          {pending === 'migrate' ? 'Moving…' : 'Move to today'}
        </button>
        <button
          className="button button--secondary"
          type="button"
          disabled={pending !== null}
          onClick={() => void decide('done', () => onUpdate(current, 'done'))}
        >
          <Icon name="check" size={14} /> {pending === 'done' ? 'Saving…' : 'Mark done'}
        </button>
        <button
          className="button button--secondary"
          type="button"
          disabled={pending !== null}
          onClick={() => void decide('schedule', () => onSchedule(current))}
        >
          <Icon name="calendar" size={14} />
          {pending === 'schedule' ? 'Scheduling…' : 'To monthly log'}
        </button>
        <button
          className="button button--danger"
          type="button"
          disabled={pending !== null}
          onClick={() => void decide('drop', () => onUpdate(current, 'cancelled'))}
        >
          <Icon name="trash" size={14} /> {pending === 'drop' ? 'Dropping…' : 'Drop it'}
        </button>
      </div>
    </Dialog>
  );
}
