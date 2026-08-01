import { ENTRY_TYPES, type EntryType, type JournalEntry } from '../components/types';

export type LogSort = 'newest' | 'oldest';
export type LogGroup = 'none' | 'type';
export type LogStateFilter = 'open' | 'all' | 'closed';

export interface LogViewConfig {
  sort: LogSort;
  group: LogGroup;
  stateFilter: LogStateFilter;
  /** Type narrowing; empty means every type. */
  types: EntryType[];
}

export const DEFAULT_LOG_VIEW: LogViewConfig = Object.freeze({
  sort: 'newest',
  group: 'none',
  stateFilter: 'open',
  types: [],
});

/**
 * The states EntryRow dims — the shell a finished or moved entry leaves
 * behind. `logged` is the resting state of notes and events, so it is
 * content, not clutter.
 */
export const isClosedEntry = (entry: Pick<JournalEntry, 'state'>): boolean =>
  entry.state === 'done' ||
  entry.state === 'cancelled' ||
  entry.state === 'migrated' ||
  entry.state === 'scheduled';

/**
 * Persisted configs survive schema drift: unknown fields fall back to the
 * defaults, unknown types are dropped, and the full type set collapses to
 * "no narrowing" so it cannot masquerade as a filter.
 */
export const normalizeLogView = (value: unknown): LogViewConfig => {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const rawTypes = Array.isArray(raw.types) ? raw.types : [];
  const types = ENTRY_TYPES.filter((type) => rawTypes.includes(type));
  return {
    sort: raw.sort === 'oldest' ? 'oldest' : 'newest',
    group: raw.group === 'type' ? 'type' : 'none',
    stateFilter:
      raw.stateFilter === 'all' || raw.stateFilter === 'closed' ? raw.stateFilter : 'open',
    types: types.length === ENTRY_TYPES.length ? [] : types,
  };
};

export const isDefaultLogView = (config: LogViewConfig): boolean => {
  const normalized = normalizeLogView(config);
  return (
    normalized.sort === 'newest' &&
    normalized.group === 'none' &&
    normalized.stateFilter === 'open' &&
    normalized.types.length === 0
  );
};

export interface LogSection {
  key: string;
  /** Null when the list is ungrouped; a pluralized count header otherwise. */
  label: string | null;
  entries: JournalEntry[];
}

export interface LogArrangement {
  sections: LogSection[];
  /** The "Done & moved" bucket; empty unless the state filter is `open`. */
  closed: JournalEntry[];
  closedCount: number;
  activeCount: number;
  /** Entries reachable on screen, counting the collapsed bucket. */
  visibleCount: number;
  totalCount: number;
}

const TYPE_PLURALS: Record<EntryType, string> = {
  task: 'Tasks',
  event: 'Events',
  note: 'Notes',
  idea: 'Ideas',
  question: 'Questions',
  habit: 'Habits',
  mood: 'Moods',
};

const compareBy =
  (sort: LogSort) =>
  (left: JournalEntry, right: JournalEntry): number => {
    const ascending =
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    return sort === 'newest' ? -ascending : ascending;
  };

export function arrangeLog(entries: JournalEntry[], config: LogViewConfig): LogArrangement {
  const view = normalizeLogView(config);
  const narrowed =
    view.types.length === 0 ? entries : entries.filter((entry) => view.types.includes(entry.type));
  const active = narrowed.filter((entry) => !isClosedEntry(entry));
  const finished = narrowed.filter(isClosedEntry);
  const compare = compareBy(view.sort);

  const shown =
    view.stateFilter === 'all' ? narrowed : view.stateFilter === 'closed' ? finished : active;
  const sorted = [...shown].sort(compare);
  const closed = view.stateFilter === 'open' ? [...finished].sort(compare) : [];

  const sections: LogSection[] =
    view.group === 'type'
      ? ENTRY_TYPES.flatMap((type) => {
          const group = sorted.filter((entry) => entry.type === type);
          if (group.length === 0) return [];
          return [{ key: type, label: `${TYPE_PLURALS[type]} (${group.length})`, entries: group }];
        })
      : [{ key: 'all', label: null, entries: sorted }];

  return {
    sections,
    closed,
    closedCount: closed.length,
    activeCount: active.length,
    visibleCount: sorted.length + closed.length,
    totalCount: entries.length,
  };
}

export const logMetaLabel = (
  arrangement: Pick<LogArrangement, 'visibleCount' | 'totalCount'>,
): string =>
  arrangement.visibleCount === arrangement.totalCount
    ? `${arrangement.totalCount} items`
    : `${arrangement.visibleCount} of ${arrangement.totalCount} items`;
