import { describe, expect, it } from 'vitest';
import { CaptureParseError, parseCapture, safeParseCapture } from '../src/domain/parser.js';

describe('capture parser', () => {
  it('parses the full rapid-log grammar in order', () => {
    expect(parseCapture('. Reply to Mira #work @4pm >tomorrow', 'idea')).toEqual({
      type: 'task',
      text: 'Reply to Mira',
      time: '16:00',
      tags: ['work'],
      dateShift: 1,
      signifier: '.',
    });
  });

  it('parses an event and a 24-hour shorthand time', () => {
    expect(parseCapture('o Design review @11', 'task')).toEqual({
      type: 'event',
      text: 'Design review',
      time: '11:00',
      tags: [],
      dateShift: 0,
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
      dateShift: 0,
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
      dateShift: 1,
      signifier: 'o',
    });
  });
});
