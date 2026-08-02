import { describe, expect, it } from 'vitest';
import {
  JournalSearchParseError,
  entryMatchesJournalSearch,
  parseJournalSearch,
} from '../src/domain/search-query.js';

describe('shared journal search grammar', () => {
  it('projects aliases and combined structured filters', () => {
    expect(parseJournalSearch('open')).toEqual({ type: 'task', state: 'open' });
    expect(parseJournalSearch('claude')).toEqual({ author: 'ai' });
    expect(
      parseJournalSearch('type:idea by:me #work date:2026-07-31 "launch review" remaining'),
    ).toEqual({
      type: 'idea',
      author: 'me',
      tag: 'work',
      from: '2026-07-31',
      to: '2026-07-31',
      q: 'launch review remaining',
    });
  });

  it('uses canonical entry fields with Unicode- and diacritic-insensitive text matching', () => {
    const entry = {
      author: 'me' as const,
      date: '2026-07-31',
      deletedAt: null,
      state: 'logged' as const,
      tags: ['résumé', 'work'],
      text: 'CAFÉ planning for Zürich',
      type: 'note' as const,
    };
    expect(entryMatchesJournalSearch(entry, parseJournalSearch('cafe zurich'))).toBe(true);
    expect(entryMatchesJournalSearch(entry, parseJournalSearch('resume'))).toBe(true);
    expect(entryMatchesJournalSearch(entry, parseJournalSearch('missing'))).toBe(false);
  });

  it.each([
    ['type:unknown', /Type must/i],
    ['by:someone', /author filters/i],
    ['from:yesterday', /YYYY-MM-DD/i],
    ['from:2026-08-01 to:2026-07-31', /cannot follow/i],
    ['"unclosed phrase', /quoted/i],
    ['type:note type:task', /one entry type/i],
  ])('rejects malformed query %s', (query, message) => {
    expect(() => parseJournalSearch(query)).toThrow(JournalSearchParseError);
    expect(() => parseJournalSearch(query)).toThrow(message);
  });
});
