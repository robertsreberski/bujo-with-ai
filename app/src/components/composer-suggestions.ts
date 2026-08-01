import { parseDateShiftToken, type TagUsage } from '@journal/server/contracts/app';
import { formatLongDate, formatWeekdayShortDate } from './dates';
import { resolveDateShift, slugifyCollection } from './destination';
import type { JournalCollection } from './types';

/** The maximum rows the panel ever shows, matching its 6-row height budget. */
export const SUGGESTION_LIMIT = 6;

const SLUG = /^[a-z0-9-]{1,80}$/;
const TAG_QUERY = /^[A-Za-z0-9-]*$/;
/**
 * `>` completes one token of the shift grammar: a word, or an absolute date.
 * Digits and hyphens are admitted so `>2026-08-12` and `>next-week` reach the
 * builder; anything else in the run is somebody's prose, not a half-typed shift.
 */
const DATE_SHIFT_QUERY = /^[a-z0-9-]*$/;
/** `@` completes a clock reading; `@mira` is a handle, not a half-typed time. */
const TIME_QUERY = /^\d{0,2}(?::\d{0,2})?$/;
/** A `>` query the owner is spelling as a date rather than as a word. */
const DATE_SHIFT_DIGITS = /^\d/;

interface DateShiftWord {
  /** The canonical token the row inserts; `parseDateShiftToken` reads it back. */
  token: string;
  label: string;
}

const TODAY_WORD: DateShiftWord = { token: 'today', label: 'Today' };
const TOMORROW_WORD: DateShiftWord = { token: 'tomorrow', label: 'Tomorrow' };
const NEXT_WEEK_WORD: DateShiftWord = { token: 'next-week', label: 'Next week' };
const WEEKEND_WORD: DateShiftWord = { token: 'weekend', label: 'Weekend' };
const WEEKDAY_WORDS: readonly DateShiftWord[] = [
  { token: 'monday', label: 'Monday' },
  { token: 'tuesday', label: 'Tuesday' },
  { token: 'wednesday', label: 'Wednesday' },
  { token: 'thursday', label: 'Thursday' },
  { token: 'friday', label: 'Friday' },
  { token: 'saturday', label: 'Saturday' },
  { token: 'sunday', label: 'Sunday' },
];

/**
 * Every word the `>` grammar takes (LOG-6 step 5), in the order equal days are
 * broken: the relative names, the week in ISO order, then the two aliases that
 * land on a weekday — `next-week` on Monday, `weekend` on Saturday. Only full
 * weekday names are offered; the parser also reads `>mon`, but a completion
 * list teaches one spelling rather than two for the same day.
 */
const DATE_SHIFT_WORDS: readonly DateShiftWord[] = [
  TODAY_WORD,
  TOMORROW_WORD,
  ...WEEKDAY_WORDS,
  NEXT_WEEK_WORD,
  WEEKEND_WORD,
];

/** The times of day worth a name, offered before the clock takes over. */
const NAMED_TIMES: readonly { label: string; clock: string }[] = [
  { label: 'Morning', clock: '09:00' },
  { label: 'Noon', clock: '12:00' },
  { label: 'Afternoon', clock: '15:00' },
  { label: 'Evening', clock: '19:00' },
];

const NAMED_CLOCKS = new Set(NAMED_TIMES.map((time) => time.clock));

export interface TokenSpan {
  start: number;
  end: number;
  text: string;
}

export type SuggestionMode = 'tag' | 'collection' | 'date-shift' | 'time';

export interface SuggestionQuery extends TokenSpan {
  mode: SuggestionMode;
  /** The token minus its `#`/`/`/`>`/`@` sigil, lowercased. */
  query: string;
}

export type SuggestionRow =
  | { kind: 'tag'; key: string; label: string; detail: string; insert: string }
  | { kind: 'collection'; key: string; label: string; detail: string; insert: string }
  | { kind: 'create'; key: string; label: string; detail: string; insert: string; slug: string }
  | { kind: 'date-shift'; key: string; label: string; detail: string; insert: string }
  | { kind: 'time'; key: string; label: string; detail: string; insert: string };

/**
 * The non-whitespace run containing the caret. A caret sitting on whitespace
 * yields an empty token, which is what closes the panel after an accept appends
 * its trailing space.
 */
export function activeToken(value: string, caret: number): TokenSpan {
  const position = Math.max(0, Math.min(caret, value.length));
  let start = position;
  while (start > 0 && !/\s/.test(value.charAt(start - 1))) start -= 1;
  let end = position;
  while (end < value.length && !/\s/.test(value.charAt(end))) end += 1;
  return { start, end, text: value.slice(start, end) };
}

/**
 * Which completion the caret is inside, if any. Every sigil in the capture
 * grammar opens a panel, so the grammar is discoverable by typing it rather
 * than by reading a legend.
 *
 * Because the token is a whole whitespace-delimited run, a sigil only counts
 * when it opens the run — so `https://example.com` and `a#b` are inert, and the
 * parser's `//literal` escape is skipped rather than completed.
 */
export function suggestionQuery(value: string, caret: number | null): SuggestionQuery | null {
  if (caret === null) return null;
  const token = activeToken(value, caret);
  if (token.text.startsWith('#')) {
    const query = token.text.slice(1);
    if (!TAG_QUERY.test(query)) return null;
    return { ...token, mode: 'tag', query: query.toLowerCase() };
  }
  if (token.text.startsWith('/') && !token.text.startsWith('//')) {
    return { ...token, mode: 'collection', query: token.text.slice(1).toLowerCase() };
  }
  if (token.text.startsWith('>')) {
    const query = token.text.slice(1).toLowerCase();
    if (!DATE_SHIFT_QUERY.test(query)) return null;
    return { ...token, mode: 'date-shift', query };
  }
  if (token.text.startsWith('@')) {
    const query = token.text.slice(1);
    if (!TIME_QUERY.test(query)) return null;
    return { ...token, mode: 'time', query };
  }
  return null;
}

/**
 * The round hours a capture is most likely aimed at: the next `count` of them,
 * wrapping past midnight. Local wall time, because the owner means the clock on
 * the wall in front of them — the parser resolves the token against the same one.
 */
export function upcomingHours(now: Date, count: number): number[] {
  const next = now.getHours() + 1;
  return Array.from({ length: count }, (_, index) => (next + index) % 24);
}

/** `16:00` → `4 pm`, `16:30` → `4:30 pm`: the gloss that teaches `@4pm`. */
function meridiemGloss(clock: string): string {
  const hour = Number(clock.slice(0, 2));
  const minute = clock.slice(3);
  const spoken = String(hour % 12 === 0 ? 12 : hour % 12);
  return `${minute === '00' ? spoken : `${spoken}:${minute}`} ${hour < 12 ? 'am' : 'pm'}`;
}

/**
 * A typed prefix matches a suggested clock in either the padded or the spoken
 * form, so `@9` still finds `09:00` rather than silently closing the panel.
 */
function matchesTimeQuery(clock: string, query: string): boolean {
  return query.length === 0 || clock.startsWith(query) || clock.replace(/^0/, '').startsWith(query);
}

/**
 * The caption under the rows. It carries the part of the grammar a list of
 * completions cannot: what the sigil *does*, and the shapes it also accepts.
 */
export function suggestionHint(mode: SuggestionMode): string | null {
  if (mode === 'date-shift')
    return 'Files this capture into the chosen day. Also reads >friday, >next-week and >2026-08-12.';
  if (mode === 'time') return 'Also reads @4pm, @11 and @23:59.';
  return null;
}

/** A `>` word with the day it resolves to, so rows can sort by proximity. */
interface ResolvedShiftWord extends DateShiftWord {
  date: string;
}

/**
 * Resolves words through the parser's own token reader and the app's own
 * resolver, so a row can never name a day the typed token would not reach.
 */
function resolveWords(words: readonly DateShiftWord[], today: string): ResolvedShiftWord[] {
  return words.flatMap((word) => {
    const shift = parseDateShiftToken(word.token);
    return shift === null ? [] : [{ ...word, date: resolveDateShift(shift, today) }];
  });
}

/** Calendar dates are ISO, so lexical order is chronological order. */
function byProximity(left: ResolvedShiftWord, right: ResolvedShiftWord): number {
  return left.date < right.date ? -1 : left.date > right.date ? 1 : 0;
}

function dateShiftRow(word: ResolvedShiftWord): SuggestionRow {
  return {
    kind: 'date-shift',
    key: `date-shift:${word.token}`,
    label: word.label,
    detail: formatWeekdayShortDate(word.date),
    insert: `>${word.token} `,
  };
}

/**
 * Bare `>`: tomorrow, then the four nearest weekdays past it, then next week.
 * Tomorrow leads by rule — `>` then Enter is the migration the owner's hands
 * already know — and the days behind it teach that the grammar reaches further
 * than one sleep out. `next-week` closes the list rather than sorting into it,
 * because it is the one row that names a week rather than a day.
 */
function bareDateShiftRows(today: string): SuggestionRow[] {
  const tomorrow = resolveWords([TOMORROW_WORD], today);
  const tomorrowDate = tomorrow[0]?.date ?? today;
  const weekdays = resolveWords(WEEKDAY_WORDS, today)
    .filter((word) => word.date > tomorrowDate)
    .sort(byProximity)
    // The two fixed rows are tomorrow and next week; the rest of the budget
    // belongs to the weekdays between them.
    .slice(0, SUGGESTION_LIMIT - 2);
  return [...tomorrow, ...weekdays, ...resolveWords([NEXT_WEEK_WORD], today)].map(dateShiftRow);
}

/**
 * A typed word: every candidate it prefixes, nearest day first — so `>w` offers
 * a weekend that is tomorrow before a Wednesday later in the week, and `>t`
 * puts today ahead of tomorrow.
 */
function matchedDateShiftRows(query: string, today: string): SuggestionRow[] {
  const matches = DATE_SHIFT_WORDS.filter((word) => word.token.startsWith(query));
  return resolveWords(matches, today)
    .sort(byProximity)
    .slice(0, SUGGESTION_LIMIT)
    .map(dateShiftRow);
}

/**
 * A typed date confirms rather than completes: one row, only once the date is
 * whole and the calendar accepts it (the parser's own reader decides that, so
 * `>2026-02-30` is refused here exactly as it is refused there). A half-typed
 * date matches nothing and closes the panel, the way `@4pm` closes the time one.
 */
function absoluteDateRows(query: string): SuggestionRow[] {
  const shift = parseDateShiftToken(query);
  if (shift?.kind !== 'absolute') return [];
  return [
    {
      kind: 'date-shift',
      key: `date-shift:${shift.date}`,
      label: formatLongDate(shift.date),
      detail: `>${shift.date}`,
      insert: `>${shift.date} `,
    },
  ];
}

/**
 * Bare `@`: the four named times of day, then upcoming round hours to fill the
 * panel, skipping any hour a name already offered. A typed digit drops the
 * names — it has already said what the capture is aimed at — and offers both
 * halves of every hour it prefixes, so `@16:3` finds `16:30`.
 */
function timeRows(now: Date, query: string): SuggestionRow[] {
  const bare = query.length === 0;
  const named: SuggestionRow[] = bare
    ? NAMED_TIMES.map((time) => ({
        kind: 'time',
        key: `time:${time.clock}`,
        label: time.label,
        detail: `@${time.clock}`,
        insert: `@${time.clock} `,
      }))
    : [];
  const clocks = upcomingHours(now, 24)
    .flatMap((hour) => {
      const padded = String(hour).padStart(2, '0');
      return bare ? [`${padded}:00`] : [`${padded}:00`, `${padded}:30`];
    })
    .filter((clock) => matchesTimeQuery(clock, query) && !(bare && NAMED_CLOCKS.has(clock)))
    .slice(0, SUGGESTION_LIMIT - named.length)
    .map((clock) => ({
      kind: 'time' as const,
      key: `time:${clock}`,
      label: `@${clock}`,
      detail: meridiemGloss(clock),
      insert: `@${clock} `,
    }));
  return [...named, ...clocks];
}

export function buildSuggestionRows(
  query: SuggestionQuery,
  options: {
    collections: readonly JournalCollection[];
    tags: readonly TagUsage[];
    /** The clock is the caller's: this module stays pure and replayable. */
    now: Date;
    /** The server-synced calendar date every `>` row resolves against (LOG-45). */
    today: string;
  },
): SuggestionRow[] {
  if (query.mode === 'date-shift') {
    if (DATE_SHIFT_DIGITS.test(query.query)) return absoluteDateRows(query.query);
    if (query.query.length === 0) return bareDateShiftRows(options.today);
    return matchedDateShiftRows(query.query, options.today);
  }

  if (query.mode === 'time') return timeRows(options.now, query.query);

  if (query.mode === 'tag') {
    return options.tags
      .filter((usage) => usage.tag.startsWith(query.query))
      .slice(0, SUGGESTION_LIMIT)
      .map((usage) => ({
        kind: 'tag' as const,
        key: `tag:${usage.tag}`,
        label: `#${usage.tag}`,
        detail: `${usage.uses} ${usage.uses === 1 ? 'use' : 'uses'}`,
        insert: `#${usage.tag} `,
      }));
  }

  const matches = options.collections
    .filter(
      (collection) =>
        collection.id.includes(query.query) || collection.name.toLowerCase().includes(query.query),
    )
    .slice(0, SUGGESTION_LIMIT)
    .map((collection) => ({
      kind: 'collection' as const,
      key: `collection:${collection.id}`,
      label: collection.name,
      detail: `/${collection.id}`,
      insert: `/${collection.id} `,
    }));

  const slug = slugifyCollection(query.query);
  const exists = options.collections.some((collection) => collection.id === slug);
  if (slug.length === 0 || !SLUG.test(slug) || exists) return matches;
  return [
    ...matches.slice(0, SUGGESTION_LIMIT - 1),
    {
      kind: 'create',
      key: `create:${slug}`,
      label: `Create collection “${slug}”`,
      detail: 'New',
      insert: `/${slug} `,
      slug,
    },
  ];
}

/**
 * Swaps the active token for a completion. The completion carries its own
 * trailing space, so an immediately following space is absorbed rather than
 * doubled, and the caret lands past it ready for the next word.
 */
export function applySuggestion(
  value: string,
  span: TokenSpan,
  insert: string,
): { value: string; caret: number } {
  const before = value.slice(0, span.start);
  const after = value.slice(span.end);
  const tail = insert.endsWith(' ') && after.startsWith(' ') ? after.slice(1) : after;
  return { value: `${before}${insert}${tail}`, caret: before.length + insert.length };
}
