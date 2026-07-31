import type { JournalRoute } from '../routes/useJournalRoute';
import { formatMonth, formatShortDate } from './dates';
import type { JournalCollection } from './types';

const MONTH_COLLECTION_PREFIX = 'month:';

/** Where a capture lands: a calendar day, or a (possibly monthly) collection. */
export type Destination = { kind: 'date'; date: string } | { kind: 'collection'; id: string };

export type DestinationSource = 'token' | 'chip' | 'screen';

export interface ResolvedDestination {
  destination: Destination;
  source: DestinationSource;
  /** True when filing here would mint a collection the mirror has never seen. */
  createsCollection: boolean;
}

export interface ResolveDestinationArgs {
  route: JournalRoute;
  /** Server-synced calendar date (YYYY-MM-DD); never read from the wall clock here. */
  today: string;
  chipOverride: Destination | null;
  /** `ParsedDraft.collection` — the `/slug` token the owner typed. */
  parsedCollection: string | null;
  dateShift: 0 | 1;
  collectionsById: Record<string, JournalCollection>;
}

export const isMonthCollectionId = (id: string): boolean => id.startsWith(MONTH_COLLECTION_PREFIX);

export const monthCollectionId = (month: string): string => `${MONTH_COLLECTION_PREFIX}${month}`;

export const monthFromCollectionId = (id: string): string =>
  id.slice(MONTH_COLLECTION_PREFIX.length);

export const sameDestination = (left: Destination, right: Destination): boolean =>
  left.kind === 'date'
    ? right.kind === 'date' && left.date === right.date
    : right.kind === 'collection' && left.id === right.id;

/** Calendar arithmetic on the passed date only; deliberately clock-free and pure. */
function nextCalendarDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

/** Rough inverse of the index view's slugify: `project-atlas` → `Project atlas`. */
export function humanizeSlug(slug: string): string {
  const words = slug.replace(/-+/g, ' ').trim();
  if (words.length === 0) return slug;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * The screen's ambient default. Backdating wins: capturing while a past day is
 * open files into that day, matching what the owner is looking at.
 */
function screenDestination(
  route: JournalRoute,
  today: string,
  collectionsById: Record<string, JournalCollection>,
): Destination {
  switch (route.name) {
    case 'today':
      return { kind: 'date', date: route.date ?? today };
    case 'month':
      return { kind: 'collection', id: monthCollectionId(route.month ?? today.slice(0, 7)) };
    case 'collection': {
      const collection = collectionsById[route.collectionId];
      // An unknown or archived collection route is a stale link, not a target.
      if (collection === undefined || collection.archivedAt !== null) {
        return { kind: 'date', date: today };
      }
      return { kind: 'collection', id: route.collectionId };
    }
    default:
      return { kind: 'date', date: today };
  }
}

/**
 * A destination only creates a collection when its slug is absent from the
 * mirror. Archived-but-present is a valid target: the server's ensureCollection
 * un-archives on file, so filing there revives rather than creates.
 */
function destinationCreatesCollection(
  destination: Destination,
  collectionsById: Record<string, JournalCollection>,
): boolean {
  if (destination.kind !== 'collection') return false;
  // Monthly logs are server-owned pseudo-collections; capture never mints them.
  if (isMonthCollectionId(destination.id)) return false;
  return collectionsById[destination.id] === undefined;
}

/**
 * Precedence: a typed `/slug` token beats a picked chip, which beats the screen.
 * `>tomorrow` then overrides any *date* destination — explicit grammar beats the
 * ambient viewed date — while collection destinations ignore it because the
 * server owns the entry date for filed captures.
 */
export function resolveDestination(args: ResolveDestinationArgs): ResolvedDestination {
  const { route, today, chipOverride, parsedCollection, dateShift, collectionsById } = args;
  let source: DestinationSource = 'screen';
  let destination: Destination;
  if (parsedCollection !== null) {
    source = 'token';
    destination = { kind: 'collection', id: parsedCollection };
  } else if (chipOverride !== null) {
    source = 'chip';
    destination = chipOverride;
  } else {
    destination = screenDestination(route, today, collectionsById);
  }

  if (dateShift === 1 && destination.kind === 'date') {
    destination = { kind: 'date', date: nextCalendarDate(today) };
    source = 'token';
  }

  return {
    destination,
    source,
    createsCollection: destinationCreatesCollection(destination, collectionsById),
  };
}

export function destinationLabel(
  destination: Destination,
  collectionsById: Record<string, JournalCollection>,
  today: string,
): string {
  if (destination.kind === 'date') {
    if (destination.date === today) return 'Today';
    if (destination.date === nextCalendarDate(today)) return 'Tomorrow';
    return formatShortDate(destination.date);
  }
  const name = collectionsById[destination.id]?.name;
  if (name !== undefined && name.length > 0) return name;
  if (isMonthCollectionId(destination.id)) {
    return formatMonth(monthFromCollectionId(destination.id));
  }
  return humanizeSlug(destination.id);
}

/**
 * Route that shows a destination. Passing `today` keeps the canonical `/` URL
 * for the current day instead of a redundant `?date=` query.
 */
export function destinationRoute(destination: Destination, today?: string): JournalRoute {
  if (destination.kind === 'date') {
    return { name: 'today', date: destination.date === today ? null : destination.date };
  }
  if (isMonthCollectionId(destination.id)) {
    return { name: 'month', month: monthFromCollectionId(destination.id) };
  }
  return { name: 'collection', collectionId: destination.id };
}
