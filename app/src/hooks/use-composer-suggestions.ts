import type { TagUsage } from '@journal/server/contracts/app';
import { useEffect, useId, useMemo, useState } from 'react';
import {
  applySuggestion,
  buildSuggestionRows,
  suggestionHint,
  suggestionQuery,
  type SuggestionRow,
} from '../components/composer-suggestions';
import type { JournalCollection } from '../components/types';

interface UseComposerSuggestionsArgs {
  value: string;
  /** `selectionStart` of the composer input, or null while it is unfocused. */
  caret: number | null;
  enabled: boolean;
  collections: readonly JournalCollection[];
  tags: readonly TagUsage[];
  /** Server-synced calendar date; the `>` rows resolve against it, not the clock. */
  today: string;
  /** The month a bare `>14` counts within; the screen's, not the clock's. */
  shiftBase: string;
  /** Fetched lazily, the first time a `#` token appears. */
  onLoadTags?: (() => void) | undefined;
}

export interface ComposerSuggestionsState {
  open: boolean;
  rows: SuggestionRow[];
  /** Grammar caption under the rows, for the sigils a list alone cannot teach. */
  hint: string | null;
  activeIndex: number;
  panelId: string;
  /** Defined only after the owner navigates the panel; the highlight is `activeIndex`. */
  activeOptionId: string | undefined;
  optionId: (index: number) => string;
  setActiveIndex: (index: number) => void;
  /** Wraps around the row list, so ArrowUp from the top lands on the last row. */
  move: (delta: number) => void;
  /** The draft and caret an accept produces, or null when there is nothing to accept. */
  accept: (index?: number) => { value: string; caret: number } | null;
  dismiss: () => void;
}

export function useComposerSuggestions({
  value,
  caret,
  enabled,
  collections,
  tags,
  today,
  shiftBase,
  onLoadTags,
}: UseComposerSuggestionsArgs): ComposerSuggestionsState {
  const baseId = useId();
  const [active, setActive] = useState<{ key: string; index: number } | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const query = enabled ? suggestionQuery(value, caret) : null;
  const queryKey = query === null ? null : `${query.mode}:${query.start}:${query.query}`;
  const mode = query?.mode ?? null;
  /*
   * One clock sample per panel session, not one per render (LOG-48). The `@`
   * rows are the upcoming round hours: re-reading the wall clock on every
   * keystroke lets an hour turning mid-capture renumber the list under the
   * finger already reaching for a row. `mode` is the whole dependency on
   * purpose — entering `@` again resamples, editing the query does not.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the dependency is the intent.
  const now = useMemo(() => new Date(), [mode]);
  // Cheap enough to recompute: both inputs are short, screen-sized lists.
  const rows =
    query === null ? [] : buildSuggestionRows(query, { collections, tags, now, today, shiftBase });
  const open = queryKey !== null && rows.length > 0 && dismissedKey !== queryKey;
  const navigated = active !== null && active.key === queryKey;
  const activeIndex = navigated ? Math.min(active.index, rows.length - 1) : 0;

  // Fires on every entry into tag mode, not once per mount: loadTagSuggestions
  // re-derives from the mirror synchronously and TTL-guards the network call
  // itself, so a journal whose first tags appear after mount still learns them.
  useEffect(() => {
    if (mode !== 'tag') return;
    onLoadTags?.();
  }, [mode, onLoadTags]);

  const panelId = `${baseId}-suggestions`;
  const optionId = (index: number): string => `${baseId}-suggestion-${String(index)}`;

  return {
    open,
    rows,
    hint: query === null ? null : suggestionHint(query.mode),
    activeIndex,
    panelId,
    // Only once the owner has actually moved: an activedescendant that appears
    // the instant a panel opens is one more attribute changing on a focused
    // field, and WebKit answers that by rebuilding the editing context.
    activeOptionId: open && navigated ? optionId(activeIndex) : undefined,
    optionId,
    setActiveIndex: (index) => {
      if (queryKey !== null) setActive({ key: queryKey, index });
    },
    move: (delta) => {
      if (queryKey === null || rows.length === 0) return;
      setActive({ key: queryKey, index: (activeIndex + delta + rows.length) % rows.length });
    },
    accept: (index = activeIndex) => {
      const row = rows[index];
      if (query === null || row === undefined) return null;
      return applySuggestion(value, query, row.insert);
    },
    dismiss: () => setDismissedKey(queryKey),
  };
}
