import { describe, expect, it } from 'vitest';

import type { JournalRoute } from '../routes/useJournalRoute';
import {
  destinationLabel,
  destinationRoute,
  humanizeSlug,
  resolveDestination,
  sameDestination,
  type Destination,
} from './destination';
import type { JournalCollection } from './types';

const TODAY = '2026-07-31';
const TOMORROW = '2026-08-01';

function collection(patch: Partial<JournalCollection> & { id: string }): JournalCollection {
  return {
    name: patch.id,
    note: null,
    createdAt: '2026-07-01T08:00:00.000Z',
    archivedAt: null,
    ...patch,
  };
}

const collections = (...items: JournalCollection[]): Record<string, JournalCollection> =>
  Object.fromEntries(items.map((item) => [item.id, item]));

const ATLAS = collection({ id: 'project-atlas', name: 'Project Atlas' });
const ARCHIVED = collection({
  id: 'old-sprint',
  name: 'Old sprint',
  archivedAt: '2026-06-01T08:00:00.000Z',
});
const JULY = collection({ id: 'month:2026-07', name: 'July 2026', note: 'Monthly log' });

function resolve(
  overrides: {
    route?: JournalRoute;
    chipOverride?: Destination | null;
    parsedCollection?: string | null;
    dateShift?: 0 | 1;
    collectionsById?: Record<string, JournalCollection>;
    today?: string;
  } = {},
) {
  return resolveDestination({
    route: overrides.route ?? { name: 'today', date: null },
    today: overrides.today ?? TODAY,
    chipOverride: overrides.chipOverride ?? null,
    parsedCollection: overrides.parsedCollection ?? null,
    dateShift: overrides.dateShift ?? 0,
    collectionsById: overrides.collectionsById ?? collections(ATLAS, ARCHIVED, JULY),
  });
}

describe('resolveDestination precedence', () => {
  it('lets a typed token beat both the chip and the screen', () => {
    expect(
      resolve({
        route: { name: 'collection', collectionId: 'project-atlas' },
        chipOverride: { kind: 'date', date: '2026-07-04' },
        parsedCollection: 'errands',
      }),
    ).toEqual({
      destination: { kind: 'collection', id: 'errands' },
      source: 'token',
      createsCollection: true,
    });
  });

  it('lets the chip beat the screen when no token is typed', () => {
    expect(
      resolve({
        route: { name: 'month', month: '2026-09' },
        chipOverride: { kind: 'date', date: '2026-07-04' },
      }),
    ).toEqual({
      destination: { kind: 'date', date: '2026-07-04' },
      source: 'chip',
      createsCollection: false,
    });
  });

  it('falls back to the screen when nothing else is chosen', () => {
    expect(resolve()).toEqual({
      destination: { kind: 'date', date: TODAY },
      source: 'screen',
      createsCollection: false,
    });
  });
});

describe('resolveDestination screen defaults', () => {
  it('backdates to the day the owner is looking at', () => {
    expect(resolve({ route: { name: 'today', date: '2026-07-12' } }).destination).toEqual({
      kind: 'date',
      date: '2026-07-12',
    });
  });

  it('files into the viewed monthly log, synthesising the current month when unset', () => {
    expect(resolve({ route: { name: 'month', month: '2026-09' } })).toEqual({
      destination: { kind: 'collection', id: 'month:2026-09' },
      source: 'screen',
      createsCollection: false,
    });
    expect(resolve({ route: { name: 'month', month: null } }).destination).toEqual({
      kind: 'collection',
      id: 'month:2026-07',
    });
  });

  it('files into the open collection when it is live in the mirror', () => {
    expect(resolve({ route: { name: 'collection', collectionId: 'project-atlas' } })).toEqual({
      destination: { kind: 'collection', id: 'project-atlas' },
      source: 'screen',
      createsCollection: false,
    });
  });

  it('drops back to today for an archived or unknown collection route', () => {
    expect(
      resolve({ route: { name: 'collection', collectionId: 'old-sprint' } }).destination,
    ).toEqual({ kind: 'date', date: TODAY });
    expect(resolve({ route: { name: 'collection', collectionId: 'ghost' } }).destination).toEqual({
      kind: 'date',
      date: TODAY,
    });
  });

  it('uses today on the index and review screens', () => {
    expect(resolve({ route: { name: 'index' } }).destination).toEqual({
      kind: 'date',
      date: TODAY,
    });
    expect(resolve({ route: { name: 'review' } }).destination).toEqual({
      kind: 'date',
      date: TODAY,
    });
  });
});

describe('resolveDestination date shift', () => {
  it('beats a backdated screen and reports the token as the source', () => {
    expect(resolve({ route: { name: 'today', date: '2026-07-12' }, dateShift: 1 })).toEqual({
      destination: { kind: 'date', date: TOMORROW },
      source: 'token',
      createsCollection: false,
    });
  });

  it('beats a date chip', () => {
    expect(
      resolve({ chipOverride: { kind: 'date', date: '2026-07-04' }, dateShift: 1 }).destination,
    ).toEqual({ kind: 'date', date: TOMORROW });
  });

  it('crosses month and year boundaries without reading the clock', () => {
    expect(resolve({ today: '2026-12-31', dateShift: 1 }).destination).toEqual({
      kind: 'date',
      date: '2027-01-01',
    });
  });

  it('is ignored for collection destinations, which take their date server-side', () => {
    expect(resolve({ parsedCollection: 'project-atlas', dateShift: 1 })).toEqual({
      destination: { kind: 'collection', id: 'project-atlas' },
      source: 'token',
      createsCollection: false,
    });
    expect(
      resolve({ route: { name: 'month', month: '2026-09' }, dateShift: 1 }).destination,
    ).toEqual({ kind: 'collection', id: 'month:2026-09' });
  });
});

describe('resolveDestination createsCollection', () => {
  it('flags a slug the mirror has never seen', () => {
    expect(resolve({ parsedCollection: 'reading-list' }).createsCollection).toBe(true);
  });

  it('does not flag an archived collection: filing there un-archives it server-side', () => {
    expect(resolve({ parsedCollection: 'old-sprint' })).toEqual({
      destination: { kind: 'collection', id: 'old-sprint' },
      source: 'token',
      createsCollection: false,
    });
  });

  it('never flags monthly logs, even when the mirror lacks them', () => {
    expect(
      resolve({ route: { name: 'month', month: '2027-03' }, collectionsById: {} }),
    ).toMatchObject({ createsCollection: false });
  });

  it('flags a chip pointing at a collection the mirror dropped', () => {
    expect(resolve({ chipOverride: { kind: 'collection', id: 'errands' } })).toEqual({
      destination: { kind: 'collection', id: 'errands' },
      source: 'chip',
      createsCollection: true,
    });
  });
});

describe('destinationLabel', () => {
  const byId = collections(ATLAS, JULY);

  it('names the relative days the owner captures into most', () => {
    expect(destinationLabel({ kind: 'date', date: TODAY }, byId, TODAY)).toBe('Today');
    expect(destinationLabel({ kind: 'date', date: TOMORROW }, byId, TODAY)).toBe('Tomorrow');
  });

  it('falls back to a short calendar label for any other day', () => {
    expect(destinationLabel({ kind: 'date', date: '2026-07-12' }, byId, TODAY)).toBe('Jul 12');
  });

  it('prefers the stored collection name', () => {
    expect(destinationLabel({ kind: 'collection', id: 'project-atlas' }, byId, TODAY)).toBe(
      'Project Atlas',
    );
    expect(destinationLabel({ kind: 'collection', id: 'month:2026-07' }, byId, TODAY)).toBe(
      'July 2026',
    );
  });

  it('humanises unknown slugs and computes unknown monthly logs', () => {
    expect(destinationLabel({ kind: 'collection', id: 'reading-list' }, byId, TODAY)).toBe(
      'Reading list',
    );
    expect(destinationLabel({ kind: 'collection', id: 'month:2026-09' }, byId, TODAY)).toBe(
      'September 2026',
    );
  });
});

describe('destinationRoute', () => {
  it('keeps the canonical today URL and spells out other days', () => {
    expect(destinationRoute({ kind: 'date', date: TODAY }, TODAY)).toEqual({
      name: 'today',
      date: null,
    });
    expect(destinationRoute({ kind: 'date', date: '2026-07-12' }, TODAY)).toEqual({
      name: 'today',
      date: '2026-07-12',
    });
    expect(destinationRoute({ kind: 'date', date: TODAY })).toEqual({
      name: 'today',
      date: TODAY,
    });
  });

  it('sends monthly logs to the month screen and collections to their own', () => {
    expect(destinationRoute({ kind: 'collection', id: 'month:2026-09' })).toEqual({
      name: 'month',
      month: '2026-09',
    });
    expect(destinationRoute({ kind: 'collection', id: 'project-atlas' })).toEqual({
      name: 'collection',
      collectionId: 'project-atlas',
    });
  });
});

describe('humanizeSlug', () => {
  it('reads hyphenated slugs back as a sentence', () => {
    expect(humanizeSlug('project-atlas')).toBe('Project atlas');
    expect(humanizeSlug('errands')).toBe('Errands');
    expect(humanizeSlug('q3--goals')).toBe('Q3 goals');
  });
});

describe('sameDestination', () => {
  it('compares kind and identity', () => {
    expect(sameDestination({ kind: 'date', date: TODAY }, { kind: 'date', date: TODAY })).toBe(
      true,
    );
    expect(sameDestination({ kind: 'date', date: TODAY }, { kind: 'collection', id: TODAY })).toBe(
      false,
    );
    expect(sameDestination({ kind: 'collection', id: 'a' }, { kind: 'collection', id: 'b' })).toBe(
      false,
    );
  });
});
