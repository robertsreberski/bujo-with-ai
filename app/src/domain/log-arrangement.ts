import type { Entry as JournalEntry, EntryType } from '../api/types';
import {
  DEFAULT_LOG_VIEW,
  ENTRY_TYPES,
  type LogGroup,
  type LogSort,
  type LogViewConfig,
} from './contracts';

export { DEFAULT_LOG_VIEW, DEFAULT_MONTH_LOG_VIEW } from './contracts';
export type { LogGroup, LogSort, LogStateFilter, LogViewConfig } from './contracts';

/**
 * The default from before the log sorted by entry date. A saved copy of it
 * means the arrangement was never really customized — only reset — so it
 * yields to the current default instead of pinning the old sort forever.
 *
 * The monthly log's move to a split default deliberately does *not* join this
 * list: `oldest/none` is only ever stored by someone who picked it from the
 * arrange menu, and collapsing it would make "None" impossible to keep.
 */
const LEGACY_DEFAULT_LOG_VIEW: LogViewConfig = Object.freeze({
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
    sort: raw.sort === 'newest' ? 'newest' : 'oldest',
    group: raw.group === 'type' || raw.group === 'day' ? raw.group : 'none',
    stateFilter:
      raw.stateFilter === 'all' || raw.stateFilter === 'closed' ? raw.stateFilter : 'open',
    types: types.length === ENTRY_TYPES.length ? [] : types,
  };
};

const matchesLogView = (config: LogViewConfig, other: LogViewConfig): boolean =>
  config.sort === other.sort &&
  config.group === other.group &&
  config.stateFilter === other.stateFilter &&
  config.types.length === other.types.length &&
  config.types.every((type) => other.types.includes(type));

export const isDefaultLogView = (
  config: LogViewConfig,
  defaultView: LogViewConfig = DEFAULT_LOG_VIEW,
): boolean => matchesLogView(normalizeLogView(config), defaultView);

/**
 * Reads a persisted arrangement back. Null means "no opinion, use the
 * default", so a stored copy of a superseded default collapses to null rather
 * than outranking the one that replaced it.
 */
export const hydrateLogView = (value: unknown): LogViewConfig | null => {
  if (value === null || value === undefined) return null;
  const normalized = normalizeLogView(value);
  return matchesLogView(normalized, LEGACY_DEFAULT_LOG_VIEW) ? null : normalized;
};

export interface LogSection {
  key: string;
  /** Null when the list is ungrouped; a pluralized count header otherwise. */
  label: string | null;
  entries: JournalEntry[];
  /**
   * Whether rows in this section should show their date. False for a section
   * that exists *because* its rows have no day worth showing.
   */
  showDate: boolean;
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

/**
 * Orders by the date the row actually shows, so a log reads the way it looks —
 * capture time only breaks ties within a day. Matches the server's own
 * `ORDER BY date, created_at, id`.
 */
const compareBy =
  (sort: LogSort) =>
  (left: JournalEntry, right: JournalEntry): number => {
    const ascending =
      left.date.localeCompare(right.date) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id);
    return sort === 'newest' ? -ascending : ascending;
  };

export interface ArrangeOptions {
  /**
   * Names the undated half under `group: 'day'`. A monthly log calls it "This
   * month"; a flat collection has no such span, so it falls back to "No day".
   */
  undatedLabel?: string;
}

function buildSections(
  sorted: JournalEntry[],
  group: LogGroup,
  undatedLabel: string,
): LogSection[] {
  if (group === 'type') {
    return ENTRY_TYPES.flatMap((type) => {
      const entries = sorted.filter((entry) => entry.type === type);
      if (entries.length === 0) return [];
      return [
        { key: type, label: `${TYPE_PLURALS[type]} (${entries.length})`, entries, showDate: true },
      ];
    });
  }
  if (group === 'day') {
    // The two facing pages of a paper monthly log. The calendar page shows the
    // day each row named; the task page has no day to show, so it shows none.
    const dated = sorted.filter((entry) => entry.dateStated);
    const undated = sorted.filter((entry) => !entry.dateStated);
    return [
      { key: 'dated', label: `On a day (${dated.length})`, entries: dated, showDate: true },
      {
        key: 'undated',
        label: `${undatedLabel} (${undated.length})`,
        entries: undated,
        showDate: false,
      },
    ].filter((section) => section.entries.length > 0);
  }
  return [{ key: 'all', label: null, entries: sorted, showDate: true }];
}

export function arrangeLog(
  entries: JournalEntry[],
  config: LogViewConfig,
  options: ArrangeOptions = {},
): LogArrangement {
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

  const sections: LogSection[] = buildSections(
    sorted,
    view.group,
    options.undatedLabel ?? 'No day',
  );

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
