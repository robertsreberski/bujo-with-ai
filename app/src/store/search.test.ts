// @vitest-environment jsdom

import { JournalSearchParseError, entryMatchesJournalSearch } from '@journal/server/contracts/app';
import { describe, expect, it } from 'vitest';

import { parseJournalSearch } from './journal-store';

describe('parseJournalSearch', () => {
  it('turns the assistant saved view into a server-side author filter', () => {
    expect(parseJournalSearch('by:assistant')).toEqual({ author: 'ai' });
    expect(parseJournalSearch('claude')).toEqual({ author: 'ai' });
  });

  it('preserves remaining text alongside structured filters', () => {
    expect(parseJournalSearch('is:open launch')).toEqual({
      type: 'task',
      state: 'open',
      q: 'launch',
    });
    expect(parseJournalSearch('#work')).toEqual({ tag: 'work' });
  });

  it('shares type, tag, date, author, and Unicode text semantics', () => {
    const filters = parseJournalSearch(
      'type:note by:me #work from:2026-07-01 to:2026-07-31 café launch',
    );
    expect(filters).toEqual({
      type: 'note',
      author: 'me',
      tag: 'work',
      from: '2026-07-01',
      to: '2026-07-31',
      q: 'café launch',
    });
    expect(
      entryMatchesJournalSearch(
        {
          author: 'me',
          date: '2026-07-15',
          deletedAt: null,
          state: 'logged',
          tags: ['work'],
          text: 'CAFÉ launch notes',
          type: 'note',
        },
        filters,
      ),
    ).toBe(true);
  });

  it('rejects malformed and conflicting grammar before either search source runs', () => {
    expect(() => parseJournalSearch('type:unknown')).toThrow(JournalSearchParseError);
    expect(() => parseJournalSearch('from:2026-08-01 to:2026-07-01')).toThrow(/cannot follow/i);
    expect(() => parseJournalSearch('"unfinished phrase')).toThrow(/quoted/i);
    expect(() => parseJournalSearch('by:me by:assistant')).toThrow(/one author/i);
  });

  it('does not match presentation-only generated titles', () => {
    const entry = {
      author: 'me' as const,
      date: '2026-07-31',
      deletedAt: null,
      state: 'logged' as const,
      tags: [],
      text: 'Canonical journal text',
      type: 'note' as const,
      generatedTitle: 'Hidden magic phrase',
    };
    expect(entryMatchesJournalSearch(entry, parseJournalSearch('magic'))).toBe(false);
  });
});
