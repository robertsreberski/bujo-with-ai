import { describe, expect, it } from 'vitest';

import { parseDraft, removeCaptureToken } from './capture';

describe('parseDraft collections', () => {
  it('carries the collection token through to the preview model', () => {
    expect(parseDraft('. Draft the brief /project-atlas #work', 'note')).toEqual({
      type: 'task',
      text: 'Draft the brief',
      time: null,
      tags: ['work'],
      collection: 'project-atlas',
      dateShift: null,
      signifierWon: true,
      error: null,
    });
  });

  it('lowercases the slug and leaves an escaped slash as literal text', () => {
    expect(parseDraft('Ship /Project-Atlas', 'note')).toMatchObject({
      collection: 'project-atlas',
      text: 'Ship',
    });
    expect(parseDraft('Ship //standup notes', 'note')).toMatchObject({
      collection: null,
      text: 'Ship /standup notes',
    });
  });

  it('reports no collection when the draft cannot be parsed', () => {
    expect(parseDraft('Read #deep_work /work', 'task')).toMatchObject({
      collection: null,
      error: expect.stringMatching(/underscore/i),
    });
  });
});

describe('removeCaptureToken', () => {
  it('removes a leading signifier, including through leading whitespace', () => {
    expect(removeCaptureToken('. Reply to Mira', 'signifier')).toBe('Reply to Mira');
    expect(removeCaptureToken('  ~ Feeling steady', 'signifier')).toBe('Feeling steady');
    expect(removeCaptureToken('O Standup', 'signifier')).toBe('Standup');
  });

  it('removes the first tag and heals the whitespace it leaves', () => {
    expect(removeCaptureToken('Buy milk #home later', 'tag')).toBe('Buy milk later');
    expect(removeCaptureToken('Buy milk #home', 'tag')).toBe('Buy milk');
    expect(removeCaptureToken('#home buy milk', 'tag')).toBe('buy milk');
  });

  it('removes every occurrence of a tag, because the parser dedupes them into one chip', () => {
    expect(removeCaptureToken('call #work then #work again', 'tag')).toBe('call then again');
    expect(removeCaptureToken('call #Work then #work #home', 'tag', 'work')).toBe(
      'call then #home',
    );
    expect(
      parseDraft(removeCaptureToken('call #work then #work', 'tag', 'work'), 'task').tags,
    ).toEqual([]);
  });

  it('targets a named tag case-insensitively, with or without the hash', () => {
    expect(removeCaptureToken('Plan #home and #Work today', 'tag', 'work')).toBe(
      'Plan #home and today',
    );
    expect(removeCaptureToken('Plan #home and #Work today', 'tag', '#WORK')).toBe(
      'Plan #home and today',
    );
  });

  it('removes the time the parser actually chose, skipping invalid candidates', () => {
    expect(removeCaptureToken('Standup @9:15 sharp', 'time')).toBe('Standup sharp');
    expect(parseDraft('Retro @99 @4pm', 'note').time).toBe('16:00');
    expect(removeCaptureToken('Retro @99 @4pm', 'time')).toBe('Retro @99');
    expect(removeCaptureToken('Retro @9am @4pm', 'time', '16:00')).toBe('Retro @9am');
  });

  it('removes the date shift case-insensitively, whatever day it names', () => {
    expect(removeCaptureToken('Call the bank >Tomorrow', 'date-shift')).toBe('Call the bank');
    expect(removeCaptureToken('>tomorrow call the bank', 'date-shift')).toBe('call the bank');
    expect(removeCaptureToken('Call the bank >Friday', 'date-shift')).toBe('Call the bank');
    expect(removeCaptureToken('Call the bank >next-week', 'date-shift')).toBe('Call the bank');
    expect(removeCaptureToken('Call the bank >2026-08-04', 'date-shift')).toBe('Call the bank');
  });

  it('removes the shift the parser actually chose, skipping impossible dates', () => {
    expect(parseDraft('Call >2026-13-40 >friday', 'note').dateShift).toEqual({
      kind: 'weekday',
      day: 5,
    });
    expect(removeCaptureToken('Call >2026-13-40 >friday', 'date-shift')).toBe('Call >2026-13-40');
    expect(removeCaptureToken('Call >tomorrowish today', 'date-shift')).toBe(
      'Call >tomorrowish today',
    );
  });

  it('removes the collection token without touching an escaped slash', () => {
    expect(removeCaptureToken('Draft the brief /project-atlas', 'collection')).toBe(
      'Draft the brief',
    );
    expect(removeCaptureToken('Notes //standup only', 'collection')).toBe('Notes //standup only');
    expect(removeCaptureToken('Notes //standup /work', 'collection')).toBe('Notes //standup');
    expect(removeCaptureToken('Notes //standup /work', 'collection', 'standup')).toBe(
      'Notes //standup /work',
    );
    expect(removeCaptureToken('Notes /Work today', 'collection', '/work')).toBe('Notes today');
  });

  it('leaves a draft untouched when the token is absent, so removal is idempotent', () => {
    const draft = 'Buy milk';
    for (const kind of ['signifier', 'tag', 'time', 'date-shift', 'collection'] as const) {
      expect(removeCaptureToken(draft, kind)).toBe(draft);
    }
    const once = removeCaptureToken('Buy milk #home', 'tag');
    expect(removeCaptureToken(once, 'tag')).toBe(once);
    expect(removeCaptureToken('Buy milk #home', 'tag', 'errands')).toBe('Buy milk #home');
  });

  it('round-trips with the parser: removing a token clears exactly that fact', () => {
    const draft = '. Draft the brief /project-atlas #work @9:15 >tomorrow';
    expect(parseDraft(draft, 'note')).toMatchObject({
      type: 'task',
      text: 'Draft the brief',
      collection: 'project-atlas',
      tags: ['work'],
      time: '09:15',
      dateShift: { kind: 'tomorrow' },
    });

    const withoutCollection = removeCaptureToken(draft, 'collection');
    expect(withoutCollection).toBe('. Draft the brief #work @9:15 >tomorrow');
    expect(parseDraft(withoutCollection, 'note')).toMatchObject({
      collection: null,
      tags: ['work'],
      time: '09:15',
      dateShift: { kind: 'tomorrow' },
      text: 'Draft the brief',
    });

    const withoutShift = removeCaptureToken(withoutCollection, 'date-shift');
    expect(parseDraft(withoutShift, 'note')).toMatchObject({
      dateShift: null,
      time: '09:15',
      text: 'Draft the brief',
    });

    const withoutSignifier = removeCaptureToken(withoutShift, 'signifier');
    expect(parseDraft(withoutSignifier, 'note')).toMatchObject({
      type: 'note',
      signifierWon: false,
      text: 'Draft the brief',
    });
  });
});
