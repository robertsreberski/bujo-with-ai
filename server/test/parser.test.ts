import { describe, expect, it } from 'vitest';
import { CaptureParseError, parseCapture, safeParseCapture } from '../src/domain/parser.js';

describe('capture parser', () => {
  it('parses the full rapid-log grammar in order', () => {
    expect(parseCapture('. Reply to Mira #work @4pm >tomorrow', 'idea')).toEqual({
      type: 'task',
      text: 'Reply to Mira',
      time: '16:00',
      tags: ['work'],
      collection: null,
      dateShift: { kind: 'tomorrow' },
      signifier: '.',
    });
  });

  it('parses an event and a 24-hour shorthand time', () => {
    expect(parseCapture('o Design review @11', 'task')).toEqual({
      type: 'event',
      text: 'Design review',
      time: '11:00',
      tags: [],
      collection: null,
      dateShift: null,
      signifier: 'o',
    });
  });

  it.each([
    ['- Midnight note @12am', '00:00'],
    ['- Lunch note @12pm', '12:00'],
    ['- Morning note @1:05am', '01:05'],
    ['- Evening note @1:05PM', '13:05'],
    ['- Late note @23:59', '23:59'],
  ])('converts time in %s', (draft, expectedTime) => {
    expect(parseCapture(draft).time).toBe(expectedTime);
  });

  it('lets a signifier override the selected type', () => {
    const parsed = parseCapture('! A smaller capture flow', 'habit');
    expect(parsed.type).toBe('idea');
    expect(parsed.signifier).toBe('!');
  });

  it('uses the selected type when there is no signifier', () => {
    expect(parseCapture('Read 20 minutes', 'habit')).toEqual({
      type: 'habit',
      text: 'Read 20 minutes',
      time: null,
      tags: [],
      collection: null,
      dateShift: null,
      signifier: null,
    });
  });

  it('lowercases and de-duplicates tags while preserving first-seen order', () => {
    expect(parseCapture('- Note #Work #travel #WORK #travel-plans').tags).toEqual([
      'work',
      'travel',
      'travel-plans',
    ]);
  });

  it('rejects underscore tags instead of partially consuming them', () => {
    expect(() => parseCapture('. Fix this #foo_bar')).toThrow(CaptureParseError);
    expect(safeParseCapture('. Fix this #foo_bar')).toMatchObject({
      success: false,
      error: { code: 'invalid_tag', token: '#foo_bar' },
    });
  });

  it('leaves malformed times as journal text', () => {
    expect(parseCapture('- Meet @24:90')).toMatchObject({
      text: 'Meet @24:90',
      time: null,
    });
  });

  it('collapses whitespace after consuming tokens', () => {
    expect(parseCapture('  O   Design   review   #WORK   @11  >Tomorrow  ')).toEqual({
      type: 'event',
      text: 'Design review',
      time: '11:00',
      tags: ['work'],
      collection: null,
      dateShift: { kind: 'tomorrow' },
      signifier: 'o',
    });
  });
});

describe('capture parser date shift token', () => {
  it.each([
    ['- Call the bank >today', { kind: 'today' }],
    ['- Call the bank >tomorrow', { kind: 'tomorrow' }],
    ['- Call the bank >friday', { kind: 'weekday', day: 5 }],
    ['- Call the bank >fri', { kind: 'weekday', day: 5 }],
    ['- Call the bank >Friday', { kind: 'weekday', day: 5 }],
    ['- Call the bank >SUN', { kind: 'weekday', day: 7 }],
    ['- Call the bank >monday', { kind: 'weekday', day: 1 }],
    ['- Call the bank >next-week', { kind: 'next-week' }],
    ['- Call the bank >weekend', { kind: 'weekend' }],
    ['- Call the bank >2026-08-04', { kind: 'absolute', date: '2026-08-04' }],
  ])('reads the shift %s names without resolving it to a date', (draft, expected) => {
    expect(parseCapture(draft)).toMatchObject({ text: 'Call the bank', dateShift: expected });
  });

  it('keeps the first shift and leaves later ones as text', () => {
    expect(parseCapture('- Ship >mon >friday')).toMatchObject({
      text: 'Ship >friday',
      dateShift: { kind: 'weekday', day: 1 },
    });
  });

  it.each([
    '- Call the bank >tomorrowish',
    '- Call the bank >monx',
    '- Call the bank >next-weekend',
    '- Notes > mon please',
    '- Call the bank >2026-13-40',
    '- Call the bank >2026-02-30',
  ])('leaves %s whole, with no shift', (draft) => {
    expect(parseCapture(draft)).toMatchObject({
      text: draft.slice(2),
      dateShift: null,
    });
  });

  /*
   * The token ends at a `\b`, so a shift word followed by a non-word character
   * is read and the remainder stays literal text. Pinned as a decision rather
   * than discovered later: the alternative — refusing anything glued to the
   * word — would also refuse `>fri.` and `>monday,` mid-sentence.
   */
  it.each([
    ['- Call the bank >fri-day', { kind: 'weekday', day: 5 }, 'Call the bank -day'],
    ['- Call the bank >moné', { kind: 'weekday', day: 1 }, 'Call the bank é'],
  ])('reads %s to the word boundary and leaves the tail as text', (draft, expected, text) => {
    expect(parseCapture(draft)).toMatchObject({ text, dateShift: expected });
  });

  it('skips an impossible date and still catches a later valid shift', () => {
    expect(parseCapture('x >2026-13-40 >friday')).toMatchObject({
      text: 'x >2026-13-40',
      dateShift: { kind: 'weekday', day: 5 },
    });
  });
});

describe('capture parser collection token', () => {
  it('parses a collection alongside every other token', () => {
    expect(parseCapture('. Reply to Mira /errands #home @9 >tomorrow', 'idea')).toEqual({
      type: 'task',
      text: 'Reply to Mira',
      time: '09:00',
      tags: ['home'],
      collection: 'errands',
      dateShift: { kind: 'tomorrow' },
      signifier: '.',
    });
  });

  it('keeps the first collection token and leaves later ones as text', () => {
    expect(parseCapture('- Plan the week /errands /shop')).toMatchObject({
      text: 'Plan the week /shop',
      collection: 'errands',
    });
  });

  it('lowercases the captured slug', () => {
    expect(parseCapture('- Plan the week /Errands-Weekly')).toMatchObject({
      text: 'Plan the week',
      collection: 'errands-weekly',
    });
  });

  it('treats a doubled slash as an escape that yields literal text', () => {
    expect(parseCapture('- Prep //standup')).toMatchObject({
      text: 'Prep /standup',
      collection: null,
    });
  });

  it('escapes without promoting a later real token to the escaped one', () => {
    expect(parseCapture('- Prep //standup /errands')).toMatchObject({
      text: 'Prep /standup',
      collection: 'errands',
    });
  });

  it('keeps a slash-suffixed tag as a tag plus literal text', () => {
    expect(parseCapture('- Note #work/x')).toMatchObject({
      text: 'Note /x',
      tags: ['work'],
      collection: null,
    });
  });

  it.each([
    ['- Read https://a.com/b', 'Read https://a.com/b'],
    ['- Check /usr/bin', 'Check /usr/bin'],
    ['- Check /a_b', 'Check /a_b'],
    ['- Ship /v1.2', 'Ship /v1.2'],
    ['- Split a/b', 'Split a/b'],
    ['- File /month:2026-07', 'File /month:2026-07'],
    [`- Long /${'a'.repeat(81)}`, `Long /${'a'.repeat(81)}`],
  ])('leaves %s as journal text without a collection', (draft, expectedText) => {
    expect(parseCapture(draft)).toMatchObject({ text: expectedText, collection: null });
  });

  it('empties the text of a token-only draft, exactly like a tag-only draft', () => {
    expect(parseCapture('/errands')).toMatchObject({ text: '', collection: 'errands' });
    expect(parseCapture('#work')).toMatchObject({ text: '', tags: ['work'], collection: null });
  });

  it('accepts a token glued to the date shift but not one glued to a time', () => {
    expect(parseCapture('- Plan the week /errands>tomorrow')).toMatchObject({
      text: 'Plan the week',
      collection: 'errands',
      dateShift: { kind: 'tomorrow' },
    });
    // The shift token has no left-context rule, so every word of the grammar
    // glues the same way `>tomorrow` always has.
    expect(parseCapture('- Plan the week /errands>friday')).toMatchObject({
      text: 'Plan the week',
      collection: 'errands',
      dateShift: { kind: 'weekday', day: 5 },
    });
    expect(parseCapture('- Meet @9/errands')).toMatchObject({
      text: 'Meet /errands',
      collection: null,
      time: '09:00',
    });
  });

  it('still rejects an invalid tag after consuming a collection token', () => {
    expect(safeParseCapture('. Fix this /errands #foo_bar')).toMatchObject({
      success: false,
      error: { code: 'invalid_tag', token: '#foo_bar' },
    });
  });
});
