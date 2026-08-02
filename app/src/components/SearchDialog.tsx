import { parseJournalSearch, type JournalSearchFilters } from '@journal/server/contracts/app';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { EntryRow } from './EntryRow';
import { Icon } from './Icon';
import { buildSearchSnippet } from './search-snippet';
import type { JournalSearchPage } from '../domain/contracts';
import { EMPTY_PANEL } from '../views/view-classes';
import type { DisplayPreferences, JournalEntry } from './types';

const RESULTS_NOTE = 'border-b border-bg-line px-2.5 py-2 text-tag text-fg-mute';
const EMPTY = `${EMPTY_PANEL} min-h-[150px]`;
const EMPTY_TITLE = 'text-md text-fg-body';

interface SearchDialogProps {
  preferences: DisplayPreferences;
  initialQuery?: string;
  onSearch: (query: string, cursor?: string) => Promise<JournalSearchPage>;
  onClose: () => void;
  onOpenEntry: (entry: JournalEntry) => void;
  onToggleEntry: (entry: JournalEntry) => void;
}

function SearchEntryText({
  entry,
  filters,
}: {
  entry: JournalEntry;
  filters: JournalSearchFilters;
}) {
  const snippet = buildSearchSnippet(entry.text, filters.q);
  return (
    <>
      {snippet.leadingEllipsis ? '…' : null}
      {snippet.segments.map((segment, index) =>
        segment.highlighted ? (
          <mark className="rounded-sm bg-ai-bg text-inherit" key={index}>
            {segment.text}
          </mark>
        ) : (
          segment.text
        ),
      )}
      {snippet.trailingEllipsis ? '…' : null}
    </>
  );
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : 'Journal search failed.';
}

export function SearchDialog({
  preferences,
  initialQuery = '',
  onSearch,
  onClose,
  onOpenEntry,
  onToggleEntry,
}: SearchDialogProps) {
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<{ query: string; page: JournalSearchPage } | null>(null);
  const [loading, setLoading] = useState<'initial' | 'more' | null>('initial');
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim();

  const updateQuery = (value: string) => {
    setQuery(value);
    setResult(null);
    setError(null);
    setLoading('initial');
  };

  useEffect(() => {
    const normalized = query.trim();
    let active = true;
    const timer = window.setTimeout(() => {
      void onSearch(normalized)
        .then((page) => {
          if (active) setResult({ query: normalized, page });
        })
        .catch((searchError: unknown) => {
          if (active) setError(messageFromError(searchError));
        })
        .finally(() => {
          if (active) setLoading(null);
        });
    }, 140);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [onSearch, query, retryNonce]);

  const activeResult = result?.query === normalizedQuery ? result.page : null;
  const filters = useMemo(() => {
    try {
      return parseJournalSearch(normalizedQuery);
    } catch {
      return {};
    }
  }, [normalizedQuery]);
  const results = activeResult?.items ?? [];
  const searching = loading === 'initial';

  const retry = () => {
    setResult(null);
    setError(null);
    setLoading('initial');
    setRetryNonce((nonce) => nonce + 1);
  };

  const loadMore = async () => {
    if (!activeResult?.hasMore || !activeResult.nextCursor || loading !== null) return;
    setLoading('more');
    setError(null);
    try {
      const page = await onSearch(normalizedQuery, activeResult.nextCursor);
      setResult((current) => {
        if (current?.query !== normalizedQuery) return current;
        if (current.page.source !== page.source) return { query: normalizedQuery, page };
        const items = [
          ...new Map(
            [...current.page.items, ...page.items].map((entry) => [entry.id, entry]),
          ).values(),
        ];
        return { query: normalizedQuery, page: { ...page, items } };
      });
    } catch (searchError) {
      setError(messageFromError(searchError));
    } finally {
      setLoading(null);
    }
  };

  return (
    <Dialog
      title="Search journal"
      description="Find text, tags, dates, entry types, open tasks, or assistant entries."
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
        aria-busy={loading !== null}
      >
        {!normalizedQuery && searching ? (
          <p className={RESULTS_NOTE}>Loading recent entries from Journal…</p>
        ) : null}
        {!normalizedQuery && activeResult?.source === 'journal' && !searching ? (
          <p className={RESULTS_NOTE}>Showing recent entries from Journal</p>
        ) : null}
        {normalizedQuery && searching ? (
          <p className={RESULTS_NOTE}>Searching the full journal…</p>
        ) : null}
        {activeResult?.source === 'downloaded' && !searching ? (
          <div
            className="flex items-center justify-between gap-3 border-b border-bg-line bg-danger-bg px-2.5 py-2 text-tag text-warning"
            role="status"
          >
            <span>
              {normalizedQuery
                ? 'Searching downloaded history — results may be incomplete.'
                : 'Showing downloaded recent entries — history may be incomplete.'}
            </span>
            <button className="shrink-0 underline underline-offset-2" type="button" onClick={retry}>
              Retry
            </button>
          </div>
        ) : null}
        {error && !searching ? (
          <div
            className="flex items-center justify-between gap-3 border-b border-bg-line bg-danger-bg px-2.5 py-2 text-tag text-warning"
            role="alert"
          >
            <span>Search couldn’t finish — {error}</span>
            <button className="shrink-0 underline underline-offset-2" type="button" onClick={retry}>
              Retry
            </button>
          </div>
        ) : null}
        {results.length > 0 ? (
          <>
            {results.map((entry) => (
              <EntryRow
                entry={entry}
                preferences={preferences}
                showDate
                {...(filters.tag === undefined ? {} : { highlightedTag: filters.tag })}
                textContent={<SearchEntryText entry={entry} filters={filters} />}
                key={entry.id}
                onOpen={(selected) => {
                  onClose();
                  onOpenEntry(selected);
                }}
                onToggle={onToggleEntry}
              />
            ))}
            {activeResult?.hasMore && activeResult.nextCursor ? (
              <div className="flex justify-center border-t border-bg-line p-2.5">
                <button
                  className="min-h-9 rounded-md border border-border-control px-3 text-xs text-fg-mid hover:bg-bg-hover disabled:opacity-60"
                  type="button"
                  disabled={loading === 'more'}
                  onClick={() => void loadMore()}
                >
                  {loading === 'more' ? 'Loading…' : 'Load more'}
                </button>
              </div>
            ) : null}
          </>
        ) : searching ? null : error ? (
          <div className={EMPTY}>
            <Icon name="search" size={18} />
            <p className={EMPTY_TITLE}>Search couldn’t finish.</p>
            <span className="text-xs">Edit the query or retry.</span>
          </div>
        ) : activeResult?.source === 'downloaded' ? (
          <div className={EMPTY}>
            <Icon name="wifiOff" size={18} />
            <p className={EMPTY_TITLE}>
              {normalizedQuery
                ? `No downloaded entries match “${normalizedQuery}”.`
                : 'No downloaded recent entries are available.'}
            </p>
            <span className="text-xs">
              {activeResult.reason === 'offline'
                ? 'Reconnect to search the full journal.'
                : 'Retry when Journal is reachable.'}
            </span>
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
