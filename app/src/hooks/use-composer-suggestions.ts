import type { TagUsage } from '@journal/server/contracts/app';
import { useEffect, useId, useRef, useState } from 'react';
import {
  applySuggestion,
  buildSuggestionRows,
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
  /** Fetched lazily, the first time a `#` token appears. */
  onLoadTags?: (() => void) | undefined;
}

export interface ComposerSuggestionsState {
  open: boolean;
  rows: SuggestionRow[];
  activeIndex: number;
  panelId: string;
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
  onLoadTags,
}: UseComposerSuggestionsArgs): ComposerSuggestionsState {
  const baseId = useId();
  const [active, setActive] = useState<{ key: string; index: number } | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const requestedTagsRef = useRef(false);

  const query = enabled ? suggestionQuery(value, caret) : null;
  const queryKey = query === null ? null : `${query.mode}:${query.start}:${query.query}`;
  // Cheap enough to recompute: both inputs are short, screen-sized lists.
  const rows = query === null ? [] : buildSuggestionRows(query, { collections, tags });
  const open = queryKey !== null && rows.length > 0 && dismissedKey !== queryKey;
  const activeIndex =
    active !== null && active.key === queryKey ? Math.min(active.index, rows.length - 1) : 0;

  const mode = query?.mode ?? null;
  useEffect(() => {
    if (mode !== 'tag' || requestedTagsRef.current) return;
    requestedTagsRef.current = true;
    onLoadTags?.();
  }, [mode, onLoadTags]);

  const panelId = `${baseId}-suggestions`;
  const optionId = (index: number): string => `${baseId}-suggestion-${String(index)}`;

  return {
    open,
    rows,
    activeIndex,
    panelId,
    activeOptionId: open ? optionId(activeIndex) : undefined,
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
