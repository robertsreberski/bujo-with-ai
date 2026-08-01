import type { TagUsage } from '@journal/server/contracts/app';
import { slugifyCollection } from './destination';
import type { JournalCollection } from './types';

/** The maximum rows the panel ever shows, matching its 6-row height budget. */
export const SUGGESTION_LIMIT = 6;

const SLUG = /^[a-z0-9-]{1,80}$/;
const TAG_QUERY = /^[A-Za-z0-9-]*$/;

export interface TokenSpan {
  start: number;
  end: number;
  text: string;
}

export type SuggestionMode = 'tag' | 'collection';

export interface SuggestionQuery extends TokenSpan {
  mode: SuggestionMode;
  /** The token minus its `#`/`/` sigil, lowercased. */
  query: string;
}

export type SuggestionRow =
  | { kind: 'tag'; key: string; label: string; detail: string; insert: string }
  | { kind: 'collection'; key: string; label: string; detail: string; insert: string }
  | { kind: 'create'; key: string; label: string; detail: string; insert: string; slug: string };

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
 * Which completion the caret is inside, if any.
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
  return null;
}

export function buildSuggestionRows(
  query: SuggestionQuery,
  options: { collections: readonly JournalCollection[]; tags: readonly TagUsage[] },
): SuggestionRow[] {
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
