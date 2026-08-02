import { useEffect, useRef, useState } from 'react';
import type { Entry, RecentlyDeletedEntry } from '../api/types';
import type { DeadLetter, QueueableCommand } from '../domain/contracts';
import { EMPTY_PANEL } from '../views/view-classes';
import { ConfirmDialog, Dialog } from './Dialog';
import { Icon } from './Icon';
import { Button } from './ui/button';

interface RecoveryDialogProps {
  deadLetters: DeadLetter[];
  recentlyDeleted: RecentlyDeletedEntry[];
  entriesById: Record<string, Entry>;
  recoveryLoading: boolean;
  online: boolean;
  onRefresh: () => void;
  onRestore: (id: string) => void;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
  onOpenEntry: (id: string) => void;
  onClose: () => void;
}

const OPERATION_LABELS: Record<QueueableCommand['kind'], string> = {
  'entry.create': 'Add entry',
  'entry.update': 'Update entry',
  'entry.delete': 'Delete entry',
  'entry.migrate': 'Move entry to today',
  'entry.schedule': 'Add entry to monthly log',
  'collection.create': 'Create collection',
  'collection.update': 'Update collection',
};

function affectedEntryId(command: QueueableCommand): string | null {
  switch (command.kind) {
    case 'entry.create':
      return command.entry.id;
    case 'entry.update':
    case 'entry.delete':
    case 'entry.migrate':
    case 'entry.schedule':
      return command.id;
    case 'collection.create':
    case 'collection.update':
      return null;
  }
}

function attemptedText(
  command: QueueableCommand,
  entriesById: Record<string, Entry>,
): string | null {
  switch (command.kind) {
    case 'entry.create':
      return command.entry.text;
    case 'entry.update':
      return command.patch.text ?? entriesById[command.id]?.text ?? null;
    case 'entry.delete':
      return command.original?.text ?? entriesById[command.id]?.text ?? null;
    case 'entry.migrate':
    case 'entry.schedule':
      return entriesById[command.id]?.text ?? command.copy.text;
    case 'collection.create':
      return command.collection.name;
    case 'collection.update':
      return command.patch.name ?? null;
  }
}

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

function destinationDescription(item: RecentlyDeletedEntry): string {
  switch (item.destination.status) {
    case 'daily':
      return `Daily log · ${item.entry.date}`;
    case 'active':
      return item.destination.collectionName ?? item.destination.collectionId ?? 'Collection';
    case 'archived':
      return `${item.destination.collectionName ?? item.destination.collectionId ?? 'Collection'} · restored and reopened`;
    case 'missing':
      return `Original collection is unavailable · restores to ${item.entry.date}`;
  }
}

function FailedChangeCard({
  letter,
  entriesById,
  onRetry,
  onDiscard,
  onOpenEntry,
}: {
  letter: DeadLetter;
  entriesById: Record<string, Entry>;
  onRetry: (id: string) => void;
  onDiscard: (letter: DeadLetter) => void;
  onOpenEntry: (id: string) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'select'>('idle');
  const textRef = useRef<HTMLTextAreaElement>(null);
  const command = letter.item.command;
  const entryId = affectedEntryId(command);
  const content = attemptedText(command, entriesById);
  const canOpen = entryId !== null && entriesById[entryId]?.deletedAt === null;

  useEffect(() => {
    if (copyState !== 'select') return;
    textRef.current?.focus();
    textRef.current?.select();
  }, [copyState]);

  const copyContent = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopyState('copied');
    } catch {
      setCopyState('select');
    }
  };

  return (
    <article className="rounded-lg border border-danger-border bg-danger-bg p-[11px]">
      <header className="flex gap-2 text-danger">
        <Icon name="warning" size={15} className="mt-0.5 flex-none" />
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-fg">{OPERATION_LABELS[command.kind]}</h3>
          {content ? <p className="pt-1 text-sm text-fg-body">“{excerpt(content)}”</p> : null}
          <p className="pt-1 text-xs text-fg-body">
            {letter.message} <span className="text-fg-mute">({letter.code})</span>
          </p>
          <time className="block pt-[5px] text-count text-fg-mute" dateTime={letter.failedAt}>
            {new Intl.DateTimeFormat(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(letter.failedAt))}
          </time>
        </div>
      </header>
      {content ? (
        <textarea
          ref={textRef}
          className={`mt-2 min-h-20 w-full resize-y text-xs ${copyState === 'select' ? '' : 'sr-only'}`}
          aria-label="Failed change content"
          readOnly
          value={content}
        />
      ) : null}
      <footer className="flex flex-wrap gap-[7px] pt-2">
        <Button variant="secondary" size="sm" onClick={() => onRetry(letter.id)}>
          <Icon name="refresh" size={12} /> Retry
        </Button>
        {canOpen && entryId ? (
          <Button variant="secondary" size="sm" onClick={() => onOpenEntry(entryId)}>
            Open entry
          </Button>
        ) : null}
        {content ? (
          <Button variant="secondary" size="sm" onClick={() => void copyContent()}>
            {copyState === 'copied'
              ? 'Copied'
              : copyState === 'select'
                ? 'Content selected'
                : 'Copy content'}
          </Button>
        ) : null}
        <Button variant="danger" size="sm" onClick={() => onDiscard(letter)}>
          Discard…
        </Button>
      </footer>
    </article>
  );
}

export function RecoveryDialog({
  deadLetters,
  recentlyDeleted,
  entriesById,
  recoveryLoading,
  online,
  onRefresh,
  onRestore,
  onRetry,
  onDiscard,
  onOpenEntry,
  onClose,
}: RecoveryDialogProps) {
  const [discarding, setDiscarding] = useState<DeadLetter | null>(null);

  if (discarding) {
    return (
      <ConfirmDialog
        title="Discard this failed change?"
        description="The attempted content will be removed from this device. Copy it first if you may need it later."
        confirmLabel="Discard failed change"
        onCancel={() => setDiscarding(null)}
        onConfirm={() => {
          onDiscard(discarding.id);
          setDiscarding(null);
        }}
      />
    );
  }

  return (
    <Dialog
      title="Recovery"
      description="Restore deleted entries and resolve changes the server could not accept."
      onClose={onClose}
      size="wide"
    >
      <section className="mb-5" aria-labelledby="recently-deleted-title">
        <header className="flex items-start justify-between gap-3 pb-2">
          <div>
            <h3 className="text-base font-semibold" id="recently-deleted-title">
              Recently deleted
            </h3>
            <p className="pt-0.5 text-xs text-fg-mute">Entries remain recoverable for 30 days.</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={!online || recoveryLoading}
            onClick={onRefresh}
          >
            <Icon name="refresh" size={12} /> {recoveryLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </header>
        {recentlyDeleted.length > 0 ? (
          <div className="flex flex-col gap-2" aria-busy={recoveryLoading}>
            {recentlyDeleted.map((item) => (
              <article className="rounded-lg border border-border p-[11px]" key={item.entry.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="text-sm font-medium text-fg">{excerpt(item.entry.text)}</h4>
                    <p className="pt-1 text-xs text-fg-mute">{destinationDescription(item)}</p>
                    <time className="block pt-1 text-count text-fg-mute" dateTime={item.expiresAt}>
                      Recoverable until{' '}
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(item.expiresAt))}
                    </time>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => onRestore(item.entry.id)}>
                    Restore
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className={`${EMPTY_PANEL} min-h-[110px]`} aria-busy={recoveryLoading}>
            <Icon name="check" size={18} />
            <p className="text-sm text-fg-body">
              {recoveryLoading ? 'Checking deleted entries…' : 'No deleted entries to restore.'}
            </p>
          </div>
        )}
      </section>

      <section className="border-t border-bg-line pt-4" aria-labelledby="failed-changes-title">
        <header className="pb-2">
          <h3 className="text-base font-semibold" id="failed-changes-title">
            Failed changes
          </h3>
          <p className="pt-0.5 text-xs text-fg-mute">
            Retry when the canonical entry is still current, or preserve the content before
            discarding it.
          </p>
        </header>
        {deadLetters.length > 0 ? (
          <div className="flex flex-col gap-[9px]">
            {deadLetters.map((letter) => (
              <FailedChangeCard
                key={letter.id}
                letter={letter}
                entriesById={entriesById}
                onRetry={onRetry}
                onDiscard={setDiscarding}
                onOpenEntry={onOpenEntry}
              />
            ))}
          </div>
        ) : (
          <div className={`${EMPTY_PANEL} min-h-[110px]`}>
            <Icon name="check" size={18} />
            <p className="text-sm text-fg-body">Every local change is accounted for.</p>
          </div>
        )}
      </section>
    </Dialog>
  );
}

/** Compatibility export for callers that still use the former component name. */
export const DeadLetterDialog = RecoveryDialog;
