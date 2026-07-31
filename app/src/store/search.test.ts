// @vitest-environment jsdom

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
});
