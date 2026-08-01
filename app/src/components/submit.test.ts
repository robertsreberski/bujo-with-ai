import { describe, expect, it } from 'vitest';

import { resolveDestination, type ResolvedDestination } from './destination';
import { planSubmit } from './submit';
import type { JournalCollection, ParsedDraft } from './types';

const TODAY = '2026-07-31';
const TOMORROW = '2026-08-01';

const collection = (id: string, name = id): JournalCollection => ({
  id,
  name,
  note: null,
  createdAt: '2026-07-01T08:00:00.000Z',
  archivedAt: null,
});

const COLLECTIONS = {
  reading: collection('reading', 'Reading'),
  'month:2026-07': collection('month:2026-07', 'July 2026'),
};

const draft = (patch: Partial<ParsedDraft> = {}): ParsedDraft => ({
  type: 'task',
  text: 'Reply to Mira',
  time: null,
  tags: ['work'],
  collection: null,
  dateShift: null,
  signifierWon: false,
  error: null,
  ...patch,
});

const resolved = (
  destination: ResolvedDestination['destination'],
  patch: Partial<ResolvedDestination> = {},
): ResolvedDestination => ({
  destination,
  source: 'screen',
  createsCollection: false,
  ...patch,
});

describe('planSubmit date mapping', () => {
  it('sends neither date nor shift for today', () => {
    expect(planSubmit(draft(), resolved({ kind: 'date', date: TODAY }), TODAY)).toEqual({
      entry: {
        text: 'Reply to Mira',
        type: 'task',
        time: null,
        tags: ['work'],
        collection: null,
      },
      collection: null,
    });
  });

  it('sends tomorrow as a shift intent, never as an absolute date', () => {
    const plan = planSubmit(draft(), resolved({ kind: 'date', date: TOMORROW }), TODAY);
    expect(plan.entry).toMatchObject({ collection: null, dateShift: 'tomorrow' });
    expect(plan.entry).not.toHaveProperty('date');
  });

  it('sends any other day as an absolute date', () => {
    const plan = planSubmit(draft(), resolved({ kind: 'date', date: '2026-07-12' }), TODAY);
    expect(plan.entry).toMatchObject({ collection: null, date: '2026-07-12' });
    expect(plan.entry).not.toHaveProperty('dateShift');
  });

  it('backdates a past day rather than shifting it', () => {
    const plan = planSubmit(draft(), resolved({ kind: 'date', date: '2025-12-25' }), TODAY);
    expect(plan.entry).toMatchObject({ date: '2025-12-25' });
  });

  it('carries the parsed facts through untouched', () => {
    const plan = planSubmit(
      draft({ type: 'event', text: 'Standup', time: '09:15', tags: ['team', 'work'] }),
      resolved({ kind: 'date', date: TODAY }),
      TODAY,
    );
    expect(plan.entry).toMatchObject({
      type: 'event',
      text: 'Standup',
      time: '09:15',
      tags: ['team', 'work'],
    });
  });
});

describe('planSubmit collection mapping', () => {
  it('files into a collection without a date or a shift', () => {
    const plan = planSubmit(draft(), resolved({ kind: 'collection', id: 'reading' }), TODAY);
    expect(plan.entry).toMatchObject({ collection: 'reading' });
    expect(plan.entry).not.toHaveProperty('date');
    expect(plan.entry).not.toHaveProperty('dateShift');
    expect(plan.collection).toBeNull();
  });

  it('files into a monthly log the same way', () => {
    const plan = planSubmit(draft(), resolved({ kind: 'collection', id: 'month:2026-07' }), TODAY);
    expect(plan.entry).toMatchObject({ collection: 'month:2026-07' });
  });

  it('seeds a humanised collection when the slug is brand new', () => {
    const plan = planSubmit(
      draft(),
      resolved({ kind: 'collection', id: 'project-atlas' }, { createsCollection: true }),
      TODAY,
    );
    expect(plan.collection).toEqual({ id: 'project-atlas', name: 'Project atlas', note: null });
    expect(plan.entry).toMatchObject({ collection: 'project-atlas' });
  });

  it('never seeds a collection for a date destination', () => {
    const plan = planSubmit(
      draft(),
      resolved({ kind: 'date', date: TODAY }, { createsCollection: true }),
      TODAY,
    );
    expect(plan.collection).toBeNull();
  });
});

describe('planSubmit over the resolver it consumes', () => {
  const plan = (
    args: Partial<Parameters<typeof resolveDestination>[0]> & { parsed?: ParsedDraft },
  ) => {
    const parsed = args.parsed ?? draft();
    return planSubmit(
      parsed,
      resolveDestination({
        route: args.route ?? { name: 'today', date: null },
        today: TODAY,
        chipOverride: args.chipOverride ?? null,
        parsedCollection: parsed.collection,
        dateShift: parsed.dateShift,
        collectionsById: COLLECTIONS,
      }),
      TODAY,
    );
  };

  it('turns a `/slug` token into a collection filing', () => {
    expect(plan({ parsed: draft({ collection: 'reading' }) }).entry).toMatchObject({
      collection: 'reading',
    });
  });

  it('mints the collection a never-seen `/slug` names', () => {
    expect(plan({ parsed: draft({ collection: 'garden' }) }).collection).toEqual({
      id: 'garden',
      name: 'Garden',
      note: null,
    });
  });

  it('keeps a `>tomorrow` capture on the shift intent from a backdated screen', () => {
    const result = plan({
      route: { name: 'today', date: '2026-07-12' },
      parsed: draft({ dateShift: { kind: 'tomorrow' } }),
    });
    expect(result.entry).toMatchObject({ dateShift: 'tomorrow' });
  });

  it('sends a further-out shift as the absolute day it resolved to', () => {
    // TODAY is a Friday, so `>friday` is the Friday after it.
    const result = plan({ parsed: draft({ dateShift: { kind: 'weekday', day: 5 } }) });
    expect(result.entry).toMatchObject({ date: '2026-08-07', collection: null });
    expect(result.entry).not.toHaveProperty('dateShift');
  });

  it('backdates a plain capture taken while a past day is open', () => {
    expect(plan({ route: { name: 'today', date: '2026-07-12' } }).entry).toMatchObject({
      date: '2026-07-12',
    });
  });

  it('files into the monthly log while the month spread is open', () => {
    expect(plan({ route: { name: 'month', month: '2026-07' } }).entry).toMatchObject({
      collection: 'month:2026-07',
    });
  });

  it('files into today from the index, which shows no destination of its own', () => {
    const result = plan({ route: { name: 'index' } });
    expect(result.entry).toMatchObject({ collection: null });
    expect(result.entry).not.toHaveProperty('date');
  });

  it('ignores `>tomorrow` when the destination is a collection', () => {
    const result = plan({
      route: { name: 'collection', collectionId: 'reading' },
      parsed: draft({ dateShift: { kind: 'tomorrow' } }),
    });
    expect(result.entry).toMatchObject({ collection: 'reading' });
    expect(result.entry).not.toHaveProperty('dateShift');
  });
});
