import { parseCapture, type TagUsage } from '@journal/server/contracts/app';
import { describe, expect, it } from 'vitest';

import {
  activeToken,
  applySuggestion,
  buildSuggestionRows,
  suggestionHint,
  suggestionQuery,
  upcomingHours,
} from './composer-suggestions';
import { formatWeekdayShortDate } from './dates';
import { resolveDateShift } from './destination';
import type { JournalCollection } from './types';

/** A fixed afternoon, so `@` rows are deterministic wherever they surface. */
const NOW = new Date(2026, 6, 31, 15, 20);
/** The same day as `NOW`, a Friday: `>` rows resolve against this, not the clock. */
const TODAY = '2026-07-31';

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

  it('carries a typed date through to the builder, digits and hyphens included', () => {
    expect(queryAt('>2026-08-04|')).toMatchObject({ mode: 'date-shift', query: '2026-08-04' });
    expect(queryAt('>next-week|')).toMatchObject({ mode: 'date-shift', query: 'next-week' });
  });

  it('refuses a date-shift query the completion mode cannot read', () => {
    expect(queryAt('>2026/08/04|')).toBeNull();
    expect(queryAt('>tomorrow?|')).toBeNull();
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
    expect(upcomingHours(new Date(2026, 7, 1, 15, 20), 3)).toEqual([16, 17, 18]);
    expect(upcomingHours(new Date(2026, 7, 1, 15, 0), 3)).toEqual([16, 17, 18]);
  });

  it('wraps past midnight', () => {
    expect(upcomingHours(new Date(2026, 7, 1, 22, 5), 3)).toEqual([23, 0, 1]);
  });
});

describe('suggestionHint', () => {
  it('teaches the sigils a list of completions cannot explain by itself', () => {
    // The `>` caption teaches the shapes the rows do not spell out.
    expect(suggestionHint('date-shift')).toMatch(/>friday/);
    expect(suggestionHint('date-shift')).toMatch(/>2026-08-12/);
    expect(suggestionHint('time')).toMatch(/@4pm/);
  });

  it('stays silent where the rows already speak for themselves', () => {
    expect(suggestionHint('tag')).toBeNull();
    expect(suggestionHint('collection')).toBeNull();
  });
});

describe('buildSuggestionRows', () => {
  /** `context` swaps the frozen clock or calendar date a case needs to exercise. */
  const rows = (marked: string, context: { now?: Date; today?: string } = {}) => {
    const query = queryAt(marked);
    if (query === null) throw new Error(`expected a query for ${marked}`);
    return buildSuggestionRows(query, {
      collections: COLLECTIONS,
      tags: TAGS,
      now: context.now ?? NOW,
      today: context.today ?? TODAY,
    });
  };

  const labelled = (marked: string, context?: { now?: Date; today?: string }) =>
    rows(marked, context).map((row) => `${row.label} · ${row.detail}`);

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
    expect(
      buildSuggestionRows(query, { collections: [], tags: many, now: NOW, today: TODAY }),
    ).toHaveLength(6);
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

  it('opens `>` on tomorrow, the four nearest weekdays behind it, then next week', () => {
    // TODAY is Friday 2026-07-31, so the list crosses into August immediately.
    expect(rows('Call >|')).toEqual([
      {
        kind: 'date-shift',
        key: 'date-shift:tomorrow',
        label: 'Tomorrow',
        detail: 'Sat, Aug 1',
        insert: '>tomorrow ',
      },
      {
        kind: 'date-shift',
        key: 'date-shift:sunday',
        label: 'Sunday',
        detail: 'Sun, Aug 2',
        insert: '>sunday ',
      },
      {
        kind: 'date-shift',
        key: 'date-shift:monday',
        label: 'Monday',
        detail: 'Mon, Aug 3',
        insert: '>monday ',
      },
      {
        kind: 'date-shift',
        key: 'date-shift:tuesday',
        label: 'Tuesday',
        detail: 'Tue, Aug 4',
        insert: '>tuesday ',
      },
      {
        kind: 'date-shift',
        key: 'date-shift:wednesday',
        label: 'Wednesday',
        detail: 'Wed, Aug 5',
        insert: '>wednesday ',
      },
      {
        kind: 'date-shift',
        key: 'date-shift:next-week',
        label: 'Next week',
        // Next Monday is already offered as `Monday`; the row earns its place by
        // teaching the token, and both must agree about the day.
        detail: 'Mon, Aug 3',
        insert: '>next-week ',
      },
    ]);
  });

  it('keeps the bare `>` list six rows long across a year boundary', () => {
    // New Year's Eve 2026 is a Thursday: tomorrow opens 2027.
    expect(labelled('Call >|', { today: '2026-12-31' })).toEqual([
      'Tomorrow · Fri, Jan 1',
      'Saturday · Sat, Jan 2',
      'Sunday · Sun, Jan 3',
      'Monday · Mon, Jan 4',
      'Tuesday · Tue, Jan 5',
      'Next week · Mon, Jan 4',
    ]);
  });

  it('orders a typed word by proximity, today first when it matches', () => {
    expect(labelled('Call >t|')).toEqual([
      'Today · Fri, Jul 31',
      'Tomorrow · Sat, Aug 1',
      'Tuesday · Tue, Aug 4',
      'Thursday · Thu, Aug 6',
    ]);
    // `>w` is the case the proximity rule exists for: the weekend is tomorrow,
    // Wednesday is five days out, and the alphabet has no opinion about that.
    expect(labelled('Call >w|')).toEqual(['Weekend · Sat, Aug 1', 'Wednesday · Wed, Aug 5']);
    expect(labelled('Call >next-|')).toEqual(['Next week · Mon, Aug 3']);
  });

  it('never offers more rows than the panel can show, whatever is typed', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    for (const letter of ['', ...letters]) {
      expect(rows(`Call >${letter}|`).length).toBeLessThanOrEqual(6);
    }
  });

  it('confirms a whole typed date with a single row', () => {
    expect(rows('Call >2026-08-12|')).toEqual([
      {
        kind: 'date-shift',
        key: 'date-shift:2026-08-12',
        label: 'Wednesday, August 12',
        detail: '>2026-08-12',
        insert: '>2026-08-12 ',
      },
    ]);
  });

  it('offers nothing for a date the calendar refuses, exactly as the parser does', () => {
    expect(rows('Call >2026-13-40|')).toEqual([]);
    expect(rows('Call >2026-02-30|')).toEqual([]);
  });

  it('waits for a typed date to finish before it says anything', () => {
    // A half-typed date closes the panel rather than guessing, the way `@4pm`
    // does: there is nothing to complete until the calendar can read it.
    expect(rows('Call >2|')).toEqual([]);
    expect(rows('Call >2026-08|')).toEqual([]);
    expect(rows('Call >2026-08-1|')).toEqual([]);
  });

  it('offers no date shift for a word the grammar could never become', () => {
    expect(rows('Call >q|')).toEqual([]);
  });

  it('never names a day the row it inserts would not actually file into', () => {
    // Every `>` row promises a date. Run the promise through the real parser and
    // the real resolver — insert → parse → resolve — so a row cannot show one
    // day while its token files into another, and cannot insert a token the
    // parser only half-consumes. Covers the shapes the chip round-trips skip:
    // `weekend`, `next-week`, and an absolute date.
    const sample = [...rows('Call >|'), ...rows('Call >w|'), ...rows('Call >2026-08-12|')];
    expect(sample).toHaveLength(9);
    for (const row of sample) {
      const parsed = parseCapture(`x ${row.insert}`);
      const shift = parsed.dateShift;
      if (shift === null) throw new Error(`${row.insert} parsed as text, not as a shift`);
      // Nothing of the token survives as prose: it was consumed whole.
      expect(parsed.text).toBe('x');
      const filed = resolveDateShift(shift, TODAY);
      // The absolute row shows its token; the day rows show the day itself.
      expect(row.detail).toBe(
        row.detail.startsWith('>') ? `>${filed}` : formatWeekdayShortDate(filed),
      );
    }
  });

  it('names the times of day first, then fills with upcoming round hours', () => {
    expect(rows('Standup @|')).toEqual([
      { kind: 'time', key: 'time:09:00', label: 'Morning', detail: '@09:00', insert: '@09:00 ' },
      { kind: 'time', key: 'time:12:00', label: 'Noon', detail: '@12:00', insert: '@12:00 ' },
      { kind: 'time', key: 'time:15:00', label: 'Afternoon', detail: '@15:00', insert: '@15:00 ' },
      { kind: 'time', key: 'time:19:00', label: 'Evening', detail: '@19:00', insert: '@19:00 ' },
      { kind: 'time', key: 'time:16:00', label: '@16:00', detail: '4 pm', insert: '@16:00 ' },
      { kind: 'time', key: 'time:17:00', label: '@17:00', detail: '5 pm', insert: '@17:00 ' },
    ]);
  });

  it('skips an upcoming hour a named time already offered', () => {
    // 11:20 makes noon the next round hour, and `Noon` has already said it.
    expect(labelled('Standup @|', { now: new Date(2026, 6, 31, 11, 20) })).toEqual([
      'Morning · @09:00',
      'Noon · @12:00',
      'Afternoon · @15:00',
      'Evening · @19:00',
      '@13:00 · 1 pm',
      '@14:00 · 2 pm',
    ]);
  });

  it('offers both halves of every hour a typed digit reaches', () => {
    expect(labelled('Standup @16:3|')).toEqual(['@16:30 · 4:30 pm']);
    expect(labelled('Standup @9|', { now: new Date(2026, 6, 31, 8, 40) })).toEqual([
      '@09:00 · 9 am',
      '@09:30 · 9:30 am',
    ]);
    expect(labelled('Standup @09|', { now: new Date(2026, 6, 31, 8, 40) })).toEqual([
      '@09:00 · 9 am',
      '@09:30 · 9:30 am',
    ]);
  });

  it('orders typed hours upcoming-first and stops at the panel budget', () => {
    // Every hour reading `1…` matches; the ones already gone wrap to the back.
    expect(labelled('Standup @1|')).toEqual([
      '@16:00 · 4 pm',
      '@16:30 · 4:30 pm',
      '@17:00 · 5 pm',
      '@17:30 · 5:30 pm',
      '@18:00 · 6 pm',
      '@18:30 · 6:30 pm',
    ]);
    // Midnight reads as 12 am, not 0 am.
    expect(labelled('Standup @0|')[0]).toBe('@00:00 · 12 am');
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
