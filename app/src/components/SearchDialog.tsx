import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { EntryRow } from './EntryRow';
import { Icon } from './Icon';
import type { DisplayPreferences, JournalEntry } from './types';

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
      <div className="search-field">
        <Icon name="search" size={14} />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="Search entries and tags…"
          aria-label="Search entries and tags"
          onChange={(event) => updateQuery(event.currentTarget.value)}
        />
        {query ? (
          <button type="button" aria-label="Clear search" onClick={() => updateQuery('')}>
            <Icon name="close" size={13} />
          </button>
        ) : null}
      </div>
      <div className="search-shortcuts" aria-label="Search examples">
        {['is:open', 'by:assistant', '#work'].map((value) => (
          <button type="button" key={value} onClick={() => updateQuery(value)}>
            {value}
          </button>
        ))}
      </div>
      <div
        className="search-results"
        aria-live="polite"
        aria-label="Search results"
        aria-busy={searching}
      >
        {!normalizedQuery ? (
          <p className="search-results__count">Showing your most recent entries</p>
        ) : null}
        {normalizedQuery && searching ? (
          <p className="search-results__count">Searching the full journal…</p>
        ) : null}
        {normalizedQuery && remoteUnavailable && !searching ? (
          <p className="search-results__notice" role="status">
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
          <div className="search-empty">
            <Icon name="wifiOff" size={18} />
            <p>No downloaded entries match “{normalizedQuery}”.</p>
            <span>Reconnect to search the full journal.</span>
          </div>
        ) : normalizedQuery ? (
          <div className="search-empty">
            <Icon name="search" size={18} />
            <p>No entries match “{normalizedQuery}”.</p>
            <span>Try fewer words or search a tag such as #work.</span>
          </div>
        ) : (
          <div className="search-empty">
            <Icon name="note" size={18} />
            <p>Your journal is ready for its first entry.</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
