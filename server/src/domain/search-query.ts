import type { Entry, EntryState, EntryType } from '../contracts/entities.js';
import { CalendarDateSchema, TagSchema } from '../contracts/primitives.js';

const ENTRY_TYPES = new Set<EntryType>([
  'task',
  'event',
  'note',
  'idea',
  'question',
  'habit',
  'mood',
]);

export interface JournalSearchFilters {
  q?: string;
  type?: EntryType;
  state?: EntryState;
  author?: 'me' | 'ai';
  tag?: string;
  from?: string;
  to?: string;
}

export class JournalSearchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalSearchParseError';
  }
}

function tokensFromQuery(raw: string): string[] {
  if ((raw.match(/"/g)?.length ?? 0) % 2 !== 0) {
    throw new JournalSearchParseError('Close the quoted search phrase.');
  }
  return raw.match(/"[^"]*"|\S+/g) ?? [];
}

function assignFilter<K extends keyof JournalSearchFilters>(
  filters: JournalSearchFilters,
  key: K,
  value: NonNullable<JournalSearchFilters[K]>,
  label: string,
): void {
  const current = filters[key];
  if (current !== undefined && current !== value) {
    throw new JournalSearchParseError(`Use only one ${label} filter.`);
  }
  filters[key] = value;
}

function parseDate(value: string, label: string): string {
  const parsed = CalendarDateSchema.safeParse(value);
  if (!parsed.success) {
    throw new JournalSearchParseError(`${label} uses YYYY-MM-DD.`);
  }
  return parsed.data;
}

/**
 * Shared owner-search grammar. The API and downloaded mirror both consume this
 * exact projection, so a query cannot silently change meaning when offline.
 */
export function parseJournalSearch(raw: string): JournalSearchFilters {
  const query = raw.trim().normalize('NFC');
  if (query.length > 500) throw new JournalSearchParseError('Search is limited to 500 characters.');
  if (query === '') return {};

  const lowered = query.toLocaleLowerCase('und');
  if (lowered === 'open') return { type: 'task', state: 'open' };
  if (lowered === 'claude') return { author: 'ai' };

  const filters: JournalSearchFilters = {};
  const remaining: string[] = [];
  for (const token of tokensFromQuery(query)) {
    if (token.startsWith('"')) {
      const phrase = token.slice(1, -1).trim();
      if (phrase !== '') remaining.push(phrase);
      continue;
    }

    const normalized = token.toLocaleLowerCase('und');
    if (normalized === 'is:open') {
      assignFilter(filters, 'type', 'task', 'entry type');
      assignFilter(filters, 'state', 'open', 'entry state');
      continue;
    }
    if (normalized.startsWith('is:')) {
      throw new JournalSearchParseError('Supported state filter: is:open.');
    }
    if (normalized === 'by:assistant') {
      assignFilter(filters, 'author', 'ai', 'author');
      continue;
    }
    if (normalized === 'by:me') {
      assignFilter(filters, 'author', 'me', 'author');
      continue;
    }
    if (normalized.startsWith('by:')) {
      throw new JournalSearchParseError('Supported author filters: by:me or by:assistant.');
    }
    if (normalized.startsWith('type:')) {
      const type = normalized.slice('type:'.length) as EntryType;
      if (!ENTRY_TYPES.has(type)) {
        throw new JournalSearchParseError(
          'Type must be task, event, note, idea, question, habit, or mood.',
        );
      }
      assignFilter(filters, 'type', type, 'entry type');
      continue;
    }
    if (normalized.startsWith('date:')) {
      const date = parseDate(normalized.slice('date:'.length), 'Date');
      assignFilter(filters, 'from', date, 'date');
      assignFilter(filters, 'to', date, 'date');
      continue;
    }
    if (normalized.startsWith('from:')) {
      assignFilter(
        filters,
        'from',
        parseDate(normalized.slice('from:'.length), 'From date'),
        'from date',
      );
      continue;
    }
    if (normalized.startsWith('to:')) {
      assignFilter(filters, 'to', parseDate(normalized.slice('to:'.length), 'To date'), 'to date');
      continue;
    }
    if (normalized.startsWith('#')) {
      const parsed = TagSchema.safeParse(normalized.slice(1));
      if (!parsed.success) {
        throw new JournalSearchParseError(
          'Tags use lowercase letters, digits, and hyphens after #.',
        );
      }
      assignFilter(filters, 'tag', parsed.data, 'tag');
      continue;
    }
    remaining.push(token);
  }

  if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) {
    throw new JournalSearchParseError('The from date cannot follow the to date.');
  }
  if (remaining.length > 0) filters.q = remaining.join(' ').normalize('NFC');
  return filters;
}

export function normalizeJournalSearchText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('und');
}

/** Text needles use the same letter/number token boundaries as SQLite unicode61 FTS. */
export function journalSearchNeedles(value: string | undefined): string[] {
  if (value === undefined) return [];
  const normalized = normalizeJournalSearchText(value.trim());
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length > 0 ? words : normalized === '' ? [] : [normalized];
}

/** Canonical downloaded-mirror matcher; generated titles are intentionally absent. */
export function entryMatchesJournalSearch(
  entry: Pick<Entry, 'author' | 'date' | 'deletedAt' | 'state' | 'tags' | 'text' | 'type'>,
  filters: JournalSearchFilters,
): boolean {
  if (entry.deletedAt !== null) return false;
  if (filters.type !== undefined && entry.type !== filters.type) return false;
  if (filters.state !== undefined && entry.state !== filters.state) return false;
  if (filters.author !== undefined && entry.author !== filters.author) return false;
  if (filters.tag !== undefined && !entry.tags.includes(filters.tag)) return false;
  if (filters.from !== undefined && entry.date < filters.from) return false;
  if (filters.to !== undefined && entry.date > filters.to) return false;

  const needles = journalSearchNeedles(filters.q);
  if (needles.length === 0) return true;
  const haystack = normalizeJournalSearchText(`${entry.text} ${entry.tags.join(' ')}`);
  return needles.every((needle) => haystack.includes(needle));
}
