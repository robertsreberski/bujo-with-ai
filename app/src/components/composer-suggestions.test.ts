import type { TagUsage } from '@journal/server/contracts/app';
import { describe, expect, it } from 'vitest';

import {
  activeToken,
  applySuggestion,
  buildSuggestionRows,
  suggestionHint,
  suggestionQuery,
  upcomingHours,
} from './composer-suggestions';
import type { JournalCollection } from './types';

/** A fixed afternoon, so `@` rows are deterministic wherever they surface. */
const NOW = new Date(2026, 7, 1, 15, 20);

const collection = (id: string, name = id): JournalCollection => ({
  id,
  name,
  note: null,
  createdAt: '2026-07-01T08:00:00.000Z',
  archivedAt: null,
});

const tag = (name: string, uses: number): TagUsage => ({
  tag: name,
  uses,
  lastUsedAt: '2026-07-30T08:00:00.000Z',
});

const COLLECTIONS = [
  collection('reading', 'Reading'),
  collection('project-atlas', 'Project Atlas'),
];
const TAGS = [tag('work', 12), tag('workshop', 3), tag('walk', 1), tag('design', 8)];

/** `value` with `|` marking the caret, which the helper strips before parsing. */
const at = (marked: string) => {
  const caret = marked.indexOf('|');
  return { value: marked.replace('|', ''), caret };
};

const queryAt = (marked: string) => {
  const { value, caret } = at(marked);
  return suggestionQuery(value, caret);
};

describe('activeToken', () => {
  it('spans the whole non-whitespace run around a caret mid-token', () => {
    const { value, caret } = at('Call #wo|rk today');
    expect(activeToken(value, caret)).toEqual({ start: 5, end: 10, text: '#work' });
  });

  it('reads the token the caret opens at position zero', () => {
    const { value, caret } = at('|#work later');
    expect(activeToken(value, caret)).toEqual({ start: 0, end: 5, text: '#work' });
  });

  it('yields an empty token when the caret sits after a space', () => {
    const { value, caret } = at('#work |');
    expect(activeToken(value, caret)).toEqual({ start: 6, end: 6, text: '' });
  });

  it('clamps a caret past the end of the value', () => {
    expect(activeToken('#work', 99)).toEqual({ start: 0, end: 5, text: '#work' });
  });
});

describe('suggestionQuery', () => {
  it('opens tag mode on a leading hash', () => {
    expect(queryAt('Ship #des|')).toMatchObject({ mode: 'tag', query: 'des', start: 5, end: 9 });
  });

  it('lowercases the tag query so matching is case-insensitive', () => {
    expect(queryAt('#Wo|rk')).toMatchObject({ mode: 'tag', query: 'work' });
  });

  it('opens collection mode on a leading slash', () => {
    expect(queryAt('Note /read|')).toMatchObject({ mode: 'collection', query: 'read' });
  });

  it('stays closed on the // literal-slash escape', () => {
    expect(queryAt('Path //read|')).toBeNull();
  });

  it('stays closed inside a URL, where the slash never opens the token', () => {
    expect(queryAt('See https://exampl|e.com/docs')).toBeNull();
    expect(queryAt('See https://example.com/do|cs')).toBeNull();
  });

  it('ignores a hash that does not open its token', () => {
    expect(queryAt('issue-4|2#note')).toBeNull();
  });

  it('rejects a tag query the parser could never accept', () => {
    expect(queryAt('#deep_wo|rk')).toBeNull();
  });

  it('stays closed with no caret at all', () => {
    expect(suggestionQuery('#work', null)).toBeNull();
  });

  it('opens on a bare sigil so the whole vocabulary is browsable', () => {
    expect(queryAt('#|')).toMatchObject({ mode: 'tag', query: '' });
  });

  it('opens date-shift mode on a leading angle bracket', () => {
    expect(queryAt('Call the bank >|')).toMatchObject({ mode: 'date-shift', query: '' });
    expect(queryAt('Call the bank >tom|')).toMatchObject({ mode: 'date-shift', query: 'tom' });
  });

  it('lowercases the date-shift query so `>Tomorrow` still completes', () => {
    expect(queryAt('>Tom|')).toMatchObject({ mode: 'date-shift', query: 'tom' });
  });

  it('refuses a date-shift query the one supported word could never start', () => {
    expect(queryAt('>2026-08-04|')).toBeNull();
  });

  it('opens time mode on a leading at-sign', () => {
    expect(queryAt('Standup @|')).toMatchObject({ mode: 'time', query: '' });
    expect(queryAt('Standup @9|')).toMatchObject({ mode: 'time', query: '9' });
    expect(queryAt('Standup @23:|')).toMatchObject({ mode: 'time', query: '23:' });
  });

  it('leaves a handle alone rather than reading it as a half-typed clock', () => {
    expect(queryAt('Ask @mira|')).toBeNull();
    expect(queryAt('Mail her@example.com| today')).toBeNull();
  });

  it('stays closed once the time is already spelled the other way', () => {
    // `@4pm` parses perfectly well; there is nothing left to complete.
    expect(queryAt('Standup @4pm|')).toBeNull();
  });

  it('ignores sigils that do not open their token', () => {
    expect(queryAt('a>b| c')).toBeNull();
    expect(queryAt('2<x>|3')).toBeNull();
  });
});

describe('upcomingHours', () => {
  it('starts at the next round hour, never the current one', () => {
    expect(upcomingHours(new Date(2026, 7, 1, 15, 20))).toEqual([16, 17, 18]);
    expect(upcomingHours(new Date(2026, 7, 1, 15, 0))).toEqual([16, 17, 18]);
  });

  it('wraps past midnight', () => {
    expect(upcomingHours(new Date(2026, 7, 1, 22, 5))).toEqual([23, 0, 1]);
  });
});

describe('suggestionHint', () => {
  it('teaches the sigils a list of completions cannot explain by itself', () => {
    expect(suggestionHint('date-shift')).toMatch(/tomorrow/i);
    expect(suggestionHint('time')).toMatch(/@4pm/);
  });

  it('stays silent where the rows already speak for themselves', () => {
    expect(suggestionHint('tag')).toBeNull();
    expect(suggestionHint('collection')).toBeNull();
  });
});

describe('buildSuggestionRows', () => {
  const rows = (marked: string) => {
    const query = queryAt(marked);
    if (query === null) throw new Error(`expected a query for ${marked}`);
    return buildSuggestionRows(query, { collections: COLLECTIONS, tags: TAGS, now: NOW });
  };

  it('offers prefix-matched tags with their use counts', () => {
    expect(rows('#wo|')).toEqual([
      { kind: 'tag', key: 'tag:work', label: '#work', detail: '12 uses', insert: '#work ' },
      {
        kind: 'tag',
        key: 'tag:workshop',
        label: '#workshop',
        detail: '3 uses',
        insert: '#workshop ',
      },
    ]);
  });

  it('singularises a lone use', () => {
    expect(rows('#walk|')[0]?.detail).toBe('1 use');
  });

  it('caps the tag list at six rows', () => {
    const query = suggestionQuery('#', 1);
    if (query === null) throw new Error('expected a query');
    const many = Array.from({ length: 20 }, (_, index) => tag(`t${String(index)}`, 1));
    expect(buildSuggestionRows(query, { collections: [], tags: many, now: NOW })).toHaveLength(6);
  });

  it('matches collections on both id and display name', () => {
    // `atlas` matches `project-atlas` by substring and is still a slug nobody
    // owns, so the create row rides along behind the match.
    expect(rows('/atlas|').map((row) => row.key)).toEqual([
      'collection:project-atlas',
      'create:atlas',
    ]);
    expect(rows('/readin|').map((row) => row.key)).toEqual(['collection:reading', 'create:readin']);
  });

  it('offers to create a collection for an unmatched valid slug', () => {
    expect(rows('/garden|')).toEqual([
      {
        kind: 'create',
        key: 'create:garden',
        label: 'Create collection “garden”',
        detail: 'New',
        insert: '/garden ',
        slug: 'garden',
      },
    ]);
  });

  it('never offers to create a collection that already exists', () => {
    expect(rows('/reading|').every((row) => row.kind !== 'create')).toBe(true);
  });

  it('offers nothing to create for an empty slug', () => {
    expect(rows('/|')).toHaveLength(2);
  });

  it('completes the one date shift the parser understands', () => {
    expect(rows('Call >|')).toEqual([
      {
        kind: 'date-shift',
        key: 'date-shift:tomorrow',
        label: 'Tomorrow',
        detail: '>tomorrow',
        insert: '>tomorrow ',
      },
    ]);
    expect(rows('Call >tom|')).toHaveLength(1);
  });

  it('offers no date shift for a word `tomorrow` could never become', () => {
    expect(rows('Call >mon|')).toEqual([]);
  });

  it('offers the next round hours with their 12-hour gloss', () => {
    const at = (marked: string, now: Date) => {
      const query = queryAt(marked);
      if (query === null) throw new Error(`expected a query for ${marked}`);
      return buildSuggestionRows(query, { collections: [], tags: [], now });
    };
    expect(at('Standup @|', new Date(2026, 7, 1, 15, 20))).toEqual([
      { kind: 'time', key: 'time:16:00', label: '@16:00', detail: '4 pm', insert: '@16:00 ' },
      { kind: 'time', key: 'time:17:00', label: '@17:00', detail: '5 pm', insert: '@17:00 ' },
      { kind: 'time', key: 'time:18:00', label: '@18:00', detail: '6 pm', insert: '@18:00 ' },
    ]);
    // Midnight reads as 12 am, not 0 am.
    expect(at('Standup @|', new Date(2026, 7, 1, 23, 5))[0]?.detail).toBe('12 am');
  });

  it('matches a typed hour with or without its leading zero', () => {
    const at = (marked: string) => {
      const query = queryAt(marked);
      if (query === null) throw new Error(`expected a query for ${marked}`);
      return buildSuggestionRows(query, {
        collections: [],
        tags: [],
        now: new Date(2026, 7, 1, 8, 40),
      }).map((row) => row.label);
    };
    expect(at('Standup @|')).toEqual(['@09:00', '@10:00', '@11:00']);
    expect(at('Standup @9|')).toEqual(['@09:00']);
    expect(at('Standup @09|')).toEqual(['@09:00']);
    expect(at('Standup @1|')).toEqual(['@10:00', '@11:00']);
  });
});

describe('applySuggestion', () => {
  const accept = (marked: string, insert: string) => {
    const { value, caret } = at(marked);
    const query = suggestionQuery(value, caret);
    if (query === null) throw new Error(`expected a query for ${marked}`);
    return applySuggestion(value, query, insert);
  };

  it('replaces the token and parks the caret past the trailing space', () => {
    expect(accept('Ship #des|', '#design ')).toEqual({ value: 'Ship #design ', caret: 13 });
  });

  it('absorbs the following space instead of doubling it', () => {
    expect(accept('Ship #des| today', '#design ')).toEqual({
      value: 'Ship #design today',
      caret: 13,
    });
  });

  it('rewrites a token the caret sits inside without disturbing its tail', () => {
    expect(accept('Ship #de|sn today', '#design ')).toEqual({
      value: 'Ship #design today',
      caret: 13,
    });
  });

  it('inserts a collection token for a create row', () => {
    expect(accept('Log /gard|', '/garden ')).toEqual({ value: 'Log /garden ', caret: 12 });
  });

  it('finishes a half-typed date shift', () => {
    expect(accept('Call the bank >|', '>tomorrow ')).toEqual({
      value: 'Call the bank >tomorrow ',
      caret: 24,
    });
    expect(accept('Call the bank >tom|', '>tomorrow ')).toEqual({
      value: 'Call the bank >tomorrow ',
      caret: 24,
    });
  });

  it('finishes a bare at-sign into a full clock reading', () => {
    expect(accept('Standup @|', '@09:00 ')).toEqual({ value: 'Standup @09:00 ', caret: 15 });
  });
});
