import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { Button } from './ui/button';
import { ACTION_GRID, DIALOG_ACTIONS_END } from './ui/dialog-classes';
import { formatLongDate } from './dates';
import { monthCollectionLabel } from './entry-actions';
import type { JournalEntry } from './types';

interface MigrationDialogProps {
  entries: JournalEntry[];
  /** The month `onSchedule` files into, so the queue cannot offer a no-op. */
  scheduleMonth: string;
  onClose: () => void;
  onMigrate: (entry: JournalEntry) => Promise<void>;
  onUpdate: (entry: JournalEntry, state: 'done' | 'cancelled') => Promise<void>;
  onSchedule: (entry: JournalEntry) => Promise<void>;
  onComplete: () => void;
}

type PendingAction = 'migrate' | 'done' | 'schedule' | 'drop';

export function MigrationDialog({
  entries,
  scheduleMonth,
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
        <div className={DIALOG_ACTIONS_END}>
          <Button variant="primary" onClick={onComplete}>
            Done
          </Button>
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
        className="rounded-lg border border-border px-[14px] py-[13px]"
        aria-labelledby={taskHeadingId}
        aria-busy={pending !== null}
      >
        <h3
          className="text-card font-medium leading-[1.45] text-pretty focus:rounded-sm focus:outline-2 focus:outline-offset-[3px] focus:outline-primary-hover"
          ref={taskHeadingRef}
          id={taskHeadingId}
          tabIndex={-1}
        >
          {current.text}
        </h3>
        <p className="pt-1 text-xs text-fg-mute">
          From {formatLongDate(current.date)}
          {/* The queue mixes the daily log with monthly-log tasks that let
              their day pass, so a row has to say which one it came from. */}
          {monthCollectionLabel(current.collection) === null
            ? ''
            : ` · ${monthCollectionLabel(current.collection)}`}
          {current.tags.length ? ` · ${current.tags.map((tag) => `#${tag}`).join(' ')}` : ''}
        </p>
        {current.migrations > 1 ? (
          <aside className="mt-2.5 flex gap-[7px] border-t border-bg-line pt-[9px] text-sm leading-[1.5] text-fg-mid">
            <Icon name="sparkle" size={12} />
            <span>Moved forward {current.migrations} times already. Consider dropping it.</span>
          </aside>
        ) : null}
      </article>
      <div className={ACTION_GRID} aria-busy={pending !== null}>
        <Button
          variant="primary"
          disabled={pending !== null}
          onClick={() => void decide('migrate', () => onMigrate(current))}
        >
          <Icon name="arrowRight" size={14} />
          {pending === 'migrate' ? 'Moving…' : 'Move to today'}
        </Button>
        <Button
          variant="secondary"
          disabled={pending !== null}
          onClick={() => void decide('done', () => onUpdate(current, 'done'))}
        >
          <Icon name="check" size={14} /> {pending === 'done' ? 'Saving…' : 'Mark done'}
        </Button>
        <Button
          variant="secondary"
          // Scheduling files a copy into the target month. A task already
          // sitting in that log would get a second one beside it — the same
          // rule buildEntryActions applies to `schedule-month`.
          disabled={pending !== null || current.collection === `month:${scheduleMonth}`}
          onClick={() => void decide('schedule', () => onSchedule(current))}
        >
          <Icon name="calendar" size={14} />
          {pending === 'schedule' ? 'Scheduling…' : 'To monthly log'}
        </Button>
        <Button
          variant="danger"
          disabled={pending !== null}
          onClick={() => void decide('drop', () => onUpdate(current, 'cancelled'))}
        >
          <Icon name="trash" size={14} /> {pending === 'drop' ? 'Dropping…' : 'Drop it'}
        </Button>
      </div>
    </Dialog>
  );
}
