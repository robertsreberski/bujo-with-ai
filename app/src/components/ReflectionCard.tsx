import type { Entry, Reflection, ReflectionVersion } from '../api/types';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Icon } from './Icon';

interface ReflectionCardProps {
  reflection: Reflection;
  entriesById: Record<string, Entry>;
  online: boolean;
  timezone: string;
  onRequest: (id: string) => void;
  onRetry: (id: string) => void;
  onRestore: (id: string, versionId: string) => void;
  onOpenEntry: (entry: Entry) => void;
  onWrite: (weekEnd: string) => void;
}

function shortDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

function generatedAt(value: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(value));
}

function sourceLabel(entry: Entry): string {
  const normalized = entry.text.replace(/\s+/g, ' ').trim();
  return normalized.length > 64 ? `${normalized.slice(0, 61)}…` : normalized;
}

function VersionProvenance({
  version,
  entriesById,
  timezone,
  onOpenEntry,
}: {
  version: ReflectionVersion;
  entriesById: Record<string, Entry>;
  timezone: string;
  onOpenEntry: (entry: Entry) => void;
}) {
  return (
    <div className="grid gap-1.5 text-xs text-fg-mute">
      <p>
        {shortDate(version.sourceFrom)}–{shortDate(version.sourceTo)} · generated{' '}
        {generatedAt(version.generatedAt, timezone)} by {version.generator.label}
      </p>
      <p>Generator source: {version.generator.source}</p>
      {version.sourceEntries.length > 0 ? (
        <div className="flex flex-wrap gap-1" aria-label="Reflection source entries">
          {version.sourceEntries.map((source) => {
            const entry = entriesById[source.id];
            if (!entry) {
              return (
                <span className="rounded-full border border-border px-2 py-1" key={source.id}>
                  Unavailable source …{source.id.slice(-6)}
                </span>
              );
            }
            if (entry.deletedAt !== null) {
              return (
                <span className="rounded-full border border-border px-2 py-1" key={source.id}>
                  Deleted source · {sourceLabel(entry)}
                </span>
              );
            }
            return (
              <button
                className="min-h-8 rounded-full border border-border px-2 text-left text-fg-mid hover:bg-bg-hover"
                type="button"
                key={source.id}
                onClick={() => onOpenEntry(entry)}
              >
                {sourceLabel(entry)}
              </button>
            );
          })}
        </div>
      ) : (
        <p>No source entries were present in this week.</p>
      )}
    </div>
  );
}

const statusCopy = (reflection: Reflection): string => {
  switch (reflection.status) {
    case 'notRequested':
      return 'Optional · ask an assistant when you want a bounded look back.';
    case 'queued':
      return 'Requested · waiting for an assistant to claim it.';
    case 'running':
      return `${reflection.claimedBy?.label ?? 'Assistant'} is working on this week.`;
    case 'current':
      return 'Current for the source entries below.';
    case 'stale':
      return 'Source entries changed after this version was generated.';
    case 'failed':
      return reflection.failure ?? 'The assistant could not complete this Reflection.';
  }
};

export function ReflectionCard({
  reflection,
  entriesById,
  online,
  timezone,
  onRequest,
  onRetry,
  onRestore,
  onOpenEntry,
  onWrite,
}: ReflectionCardProps) {
  const current = reflection.currentVersion;
  const requestable =
    reflection.status === 'notRequested' ||
    reflection.status === 'current' ||
    reflection.status === 'stale';

  return (
    <article
      className="reflection-card mx-4 my-3 overflow-hidden rounded-xl border border-ai-border bg-ai-bg"
      aria-labelledby={`reflection-${reflection.id}`}
    >
      <div className="px-[14px] py-3">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-ai-fg">
              <Icon name="sparkle" size={13} />
              <h2 className="text-sm font-semibold text-fg" id={`reflection-${reflection.id}`}>
                Weekly Reflection
              </h2>
            </div>
            <p className="pt-0.5 text-xs text-fg-mute">
              {shortDate(reflection.weekStart)}–{shortDate(reflection.weekEnd)}
            </p>
          </div>
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 text-count',
              reflection.status === 'failed'
                ? 'border-danger-border text-danger'
                : reflection.status === 'stale'
                  ? 'border-border-strong text-fg-mid'
                  : 'border-ai-border text-ai-fg',
            )}
          >
            {reflection.status === 'notRequested' ? 'not requested' : reflection.status}
          </span>
        </header>
        <p className="pt-2 text-sm leading-[1.5] text-fg-mid">{statusCopy(reflection)}</p>
        {current ? (
          <div className="pt-3">
            <p className="text-base leading-[1.6] text-fg-body text-pretty">{current.text}</p>
            <div className="pt-2">
              <VersionProvenance
                version={current}
                entriesById={entriesById}
                timezone={timezone}
                onOpenEntry={onOpenEntry}
              />
            </div>
          </div>
        ) : null}
        {reflection.versions.length > 0 ? (
          <details className="mt-3 border-t border-ai-border pt-2">
            <summary className="min-h-8 cursor-pointer text-xs leading-8 text-fg-mid">
              Version history ({reflection.versions.length})
            </summary>
            <div className="grid gap-2 pb-1">
              {reflection.versions.map((version) => (
                <section
                  className="rounded-lg border border-border bg-bg px-2.5 py-2"
                  key={version.id}
                >
                  <header className="flex items-center justify-between gap-2">
                    <strong className="text-xs font-medium">
                      Version {version.number}
                      {version.id === reflection.currentVersionId ? ' · selected' : ''}
                    </strong>
                    {version.id !== reflection.currentVersionId ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!online}
                        onClick={() => onRestore(reflection.id, version.id)}
                      >
                        Restore
                      </Button>
                    ) : null}
                  </header>
                  <p className="py-1.5 text-sm text-fg-body">{version.text}</p>
                  <VersionProvenance
                    version={version}
                    entriesById={entriesById}
                    timezone={timezone}
                    onOpenEntry={onOpenEntry}
                  />
                </section>
              ))}
            </div>
          </details>
        ) : null}
      </div>
      <footer className="flex flex-wrap gap-2 border-t border-ai-border bg-bg-hover px-[14px] py-2.5">
        {requestable ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={!online}
            onClick={() => onRequest(reflection.id)}
          >
            {reflection.status === 'notRequested' ? 'Request assistant' : 'Rewrite'}
          </Button>
        ) : null}
        {reflection.status === 'failed' ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={!online}
            onClick={() => onRetry(reflection.id)}
          >
            Retry
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => onWrite(reflection.weekEnd)}>
          Write your reflection
        </Button>
        {!online ? (
          <span className="self-center text-count text-fg-mute">Available offline</span>
        ) : null}
      </footer>
    </article>
  );
}
