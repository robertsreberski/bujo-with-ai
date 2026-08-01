import type { TagUsage } from '@journal/server/contracts/app';
import { slugifyCollection } from './destination';
import type { JournalCollection } from './types';

/** The maximum rows the panel ever shows, matching its 6-row height budget. */
export const SUGGESTION_LIMIT = 6;

const SLUG = /^[a-z0-9-]{1,80}$/;
const TAG_QUERY = /^[A-Za-z0-9-]*$/;
/** `>` completes one word, so anything non-alphabetic is somebody else's text. */
const DATE_SHIFT_QUERY = /^[a-z]*$/;
/** `@` completes a clock reading; `@mira` is a handle, not a half-typed time. */
const TIME_QUERY = /^\d{0,2}(?::\d{0,2})?$/;

/**
 * The only shift this panel completes. The parser reads the whole grammar
 * (`>friday`, `>next-week`, `>2026-08-12`; LOG-6 step 5) — completing the rest
 * of it is a later phase, so until then those are reached by typing.
 */
const DATE_SHIFT_WORD = 'tomorrow';

/** Upcoming round hours the `@` panel offers before the caption takes over. */
const TIME_SUGGESTION_COUNT = 3;

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
export function upcomingHours(now: Date, count: number = TIME_SUGGESTION_COUNT): number[] {
  const next = now.getHours() + 1;
  return Array.from({ length: count }, (_, index) => (next + index) % 24);
}

/** `16` → `4 pm`: the 12-hour gloss that teaches `@4pm` is the same instant. */
function meridiemGloss(hour: number): string {
  return `${String(hour % 12 === 0 ? 12 : hour % 12)} ${hour < 12 ? 'am' : 'pm'}`;
}

/**
 * A typed prefix matches a suggested hour in either the padded or the spoken
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
  if (mode === 'date-shift') return 'Files this capture into tomorrow’s log.';
  if (mode === 'time') return 'Also reads @4pm, @11 and @23:59.';
  return null;
}

export function buildSuggestionRows(
  query: SuggestionQuery,
  options: {
    collections: readonly JournalCollection[];
    tags: readonly TagUsage[];
    /** The clock is the caller's: this module stays pure and replayable. */
    now: Date;
  },
): SuggestionRow[] {
  if (query.mode === 'date-shift') {
    if (!DATE_SHIFT_WORD.startsWith(query.query)) return [];
    return [
      {
        kind: 'date-shift',
        key: 'date-shift:tomorrow',
        label: 'Tomorrow',
        detail: `>${DATE_SHIFT_WORD}`,
        insert: `>${DATE_SHIFT_WORD} `,
      },
    ];
  }

  if (query.mode === 'time') {
    return upcomingHours(options.now)
      .map((hour) => `${String(hour).padStart(2, '0')}:00`)
      .filter((clock) => matchesTimeQuery(clock, query.query))
      .map((clock) => ({
        kind: 'time' as const,
        key: `time:${clock}`,
        label: `@${clock}`,
        detail: meridiemGloss(Number(clock.slice(0, 2))),
        insert: `@${clock} `,
      }));
  }

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
