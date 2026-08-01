import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { EntryRow } from './EntryRow';
import { Icon } from './Icon';
import { EMPTY_PANEL } from '../views/view-classes';
import type { DisplayPreferences, JournalEntry } from './types';

const RESULTS_NOTE = 'border-b border-bg-line px-2.5 py-2 text-tag text-fg-mute';
const EMPTY = `${EMPTY_PANEL} min-h-[150px]`;
const EMPTY_TITLE = 'text-md text-fg-body';

interface SearchDialogProps {
  entries: JournalEntry[];
  preferences: DisplayPreferences;
  initialQuery?: string;
  onSearch: (query: string) => Promise<JournalEntry[]>;
  onClose: () => void;
  onOpenEntry: (entry: JournalEntry) => void;
  onToggleEntry: (entry: JournalEntry) => void;
}

const matches = (entry: JournalEntry, raw: string): boolean => {
  const tokens = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => {
    if (token === 'is:open' || token === 'open')
      return entry.type === 'task' && entry.state === 'open';
    if (token === 'by:assistant' || token === 'claude') return entry.author === 'ai';
    if (token.startsWith('#')) return entry.tags.includes(token.slice(1));
    return (
      entry.text.toLowerCase().includes(token) || entry.tags.some((tag) => tag.includes(token))
    );
  });
};

export function SearchDialog({
  entries,
  preferences,
  initialQuery = '',
  onSearch,
  onClose,
  onOpenEntry,
  onToggleEntry,
}: SearchDialogProps) {
  const [query, setQuery] = useState(initialQuery);
  const [remoteSearch, setRemoteSearch] = useState<{
    query: string;
    entries: JournalEntry[];
    status: 'complete' | 'unavailable';
  } | null>(null);
  const [pendingQuery, setPendingQuery] = useState<string | null>(initialQuery.trim() || null);
  const inputRef = useRef<HTMLInputElement>(null);
  const updateQuery = (value: string) => {
    setQuery(value);
    setPendingQuery(value.trim() || null);
  };
  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void Promise.resolve()
        .then(() => onSearch(normalized))
        .then((result) => {
          if (active) setRemoteSearch({ query: normalized, entries: result, status: 'complete' });
        })
        .catch(() => {
          if (active) setRemoteSearch({ query: normalized, entries: [], status: 'unavailable' });
        })
        .finally(() => {
          if (active) setPendingQuery((current) => (current === normalized ? null : current));
        });
    }, 140);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [onSearch, query]);
  const normalizedQuery = query.trim();
  const remoteResults = remoteSearch?.query === normalizedQuery ? remoteSearch.entries : null;
  const remoteUnavailable =
    remoteSearch?.query === normalizedQuery && remoteSearch.status === 'unavailable';
  const searching = pendingQuery === normalizedQuery;
  const results = useMemo(() => {
    const candidates = remoteResults
      ? [...new Map([...entries, ...remoteResults].map((entry) => [entry.id, entry])).values()]
      : entries;
    return candidates
      .filter((entry) => matches(entry, query))
      .sort(
        (left, right) =>
          right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt),
      )
      .slice(0, 100);
  }, [entries, query, remoteResults]);
  return (
    <Dialog
      title="Search journal"
      description="Find text, tags, open tasks, or assistant entries."
      onClose={onClose}
      initialFocusRef={inputRef}
      size="wide"
    >
      <div className="flex h-9 items-center gap-2 rounded-md border border-border-control px-2.5 text-fg-faint focus-within:border-primary focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary-hover touch:h-10">
        <Icon name="search" size={14} />
        <input
          ref={inputRef}
          type="search"
          className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 outline-0 [&::-webkit-search-cancel-button]:appearance-none"
          value={query}
          placeholder="Search entries and tags…"
          aria-label="Search entries and tags"
          onChange={(event) => updateQuery(event.currentTarget.value)}
        />
        {query ? (
          <button
            className="grid size-[34px] place-items-center text-fg-mute touch:size-10"
            type="button"
            aria-label="Clear search"
            onClick={() => updateQuery('')}
          >
            <Icon name="close" size={13} />
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5 py-[9px]" aria-label="Search examples">
        {['is:open', 'by:assistant', '#work'].map((value) => (
          <button
            className="min-h-[30px] rounded-full border border-border-control bg-bg-line px-[9px] font-mono text-2xs text-fg-mid hover:text-fg touch:min-h-10"
            type="button"
            key={value}
            onClick={() => updateQuery(value)}
          >
            {value}
          </button>
        ))}
      </div>
      <div
        className="overflow-hidden rounded-lg border border-border"
        aria-live="polite"
        aria-label="Search results"
        aria-busy={searching}
      >
        {!normalizedQuery ? <p className={RESULTS_NOTE}>Showing your most recent entries</p> : null}
        {normalizedQuery && searching ? (
          <p className={RESULTS_NOTE}>Searching the full journal…</p>
        ) : null}
        {normalizedQuery && remoteUnavailable && !searching ? (
          <p
            className="border-b border-bg-line bg-danger-bg px-2.5 py-2 text-tag text-warning"
            role="status"
          >
            Search unavailable — showing downloaded entries.
          </p>
        ) : null}
        {results.length > 0 ? (
          results.map((entry) => (
            <EntryRow
              entry={entry}
              preferences={preferences}
              showDate
              key={entry.id}
              onOpen={(selected) => {
                onClose();
                onOpenEntry(selected);
              }}
              onToggle={onToggleEntry}
            />
          ))
        ) : searching ? null : remoteUnavailable ? (
          <div className={EMPTY}>
            <Icon name="wifiOff" size={18} />
            <p className={EMPTY_TITLE}>No downloaded entries match “{normalizedQuery}”.</p>
            <span className="text-xs">Reconnect to search the full journal.</span>
          </div>
        ) : normalizedQuery ? (
          <div className={EMPTY}>
            <Icon name="search" size={18} />
            <p className={EMPTY_TITLE}>No entries match “{normalizedQuery}”.</p>
            <span className="text-xs">Try fewer words or search a tag such as #work.</span>
          </div>
        ) : (
          <div className={EMPTY}>
            <Icon name="note" size={18} />
            <p className={EMPTY_TITLE}>Your journal is ready for its first entry.</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
