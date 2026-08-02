import type { JournalRoute } from '../routes/useJournalRoute';
import type { Destination, DestinationSource, ResolvedDestination } from '../domain/contracts';
import { formatMonth, formatShortDate } from './dates';
import type { DateShift, JournalCollection } from './types';

const MONTH_COLLECTION_PREFIX = 'month:';

/** @deprecated Import neutral destination contracts from ../domain/contracts. */
export type { Destination, DestinationSource, ResolvedDestination } from '../domain/contracts';

export interface ResolveDestinationArgs {
  route: JournalRoute;
  /** Server-synced calendar date (YYYY-MM-DD); never read from the wall clock here. */
  today: string;
  chipOverride: Destination | null;
  /** `ParsedDraft.collection` — the `/slug` token the owner typed. */
  parsedCollection: string | null;
  /** `ParsedDraft.dateShift` — the `>token` shift, still unresolved. */
  dateShift: DateShift | null;
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

/**
 * Calendar arithmetic on the passed date only; deliberately clock-free and pure.
 * Exported so the submit planner's "is this tomorrow?" test and the label's
 * `Tomorrow` string can never drift apart.
 */
export function nextCalendarDate(date: string): string {
  return shiftCalendarDate(date, 1);
}

function shiftCalendarDate(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** ISO weekday of a calendar date: Monday = 1 … Sunday = 7. */
function isoWeekday(date: string): number {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * The next occurrence of an ISO weekday, always **strictly future**: `>monday`
 * typed on a Monday means the Monday coming, not the one being lived. A
 * capture aimed at the current day is what `>today` (or no token) is for, and
 * the ambiguity is worth spending a keyword on rather than resolving silently.
 */
function nextWeekday(today: string, day: number): string {
  const ahead = (day - isoWeekday(today) + 7) % 7;
  return shiftCalendarDate(today, ahead === 0 ? 7 : ahead);
}

export const monthOf = (date: string): string => date.slice(0, 7);

/** Days in the month a date falls in; day 0 of the next month is its last. */
function daysInMonthOf(date: string): number {
  const [year = 0, month = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Resolves a `>` token against a passed `today`. Pure and clock-free, like the
 * parser that produced the shift: every relative target is calendar arithmetic
 * on the server-synced date, and an absolute one passes through untouched —
 * a past date is a deliberate backdate, not an error.
 *
 * A bare day number counts within `base`'s month — the month on screen — so
 * `>14` means the 14th you are looking at rather than the next one to come.
 * It resolves to null on a day that month has no room for (`>31` in February),
 * which leaves the token as inert text rather than silently landing on the 28th.
 */
export function resolveDateShift(shift: DateShift, today: string, base = today): string | null {
  switch (shift.kind) {
    case 'today':
      return today;
    case 'tomorrow':
      return nextCalendarDate(today);
    case 'weekday':
      return nextWeekday(today, shift.day);
    case 'next-week':
      return nextWeekday(today, 1);
    case 'weekend':
      return nextWeekday(today, 6);
    case 'day-of-month':
      return shift.day > daysInMonthOf(base)
        ? null
        : `${monthOf(base)}-${String(shift.day).padStart(2, '0')}`;
    case 'absolute':
      return shift.date;
  }
}

/**
 * The day a bare `>14` counts from: the month on screen. On the daily log that
 * is the day being viewed, so a token typed while a past day is open stays in
 * that day's month instead of jumping to the wall calendar's.
 */
export function shiftBaseDate(route: JournalRoute, today: string): string {
  if (route.name === 'today') return route.date ?? today;
  if (route.name === 'month') return `${route.month ?? monthOf(today)}-01`;
  return today;
}

/** Rough inverse of the index view's slugify: `project-atlas` → `Project atlas`. */
export function humanizeSlug(slug: string): string {
  const words = slug.replace(/-+/g, ' ').trim();
  if (words.length === 0) return slug;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * The index view's slug rule, restated here so composer autocomplete mints the
 * same id the collection editor would for the same name. The cap is 80 rather
 * than the editor's 48 because a slug typed as `/slug` is bounded by the
 * parser's `[A-Za-z0-9-]{1,80}` collection token, and the two must agree about
 * what the owner just typed.
 */
export function slugifyCollection(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
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
 * The destination a screen is currently *showing*, or null for the screens that
 * show none. Distinct from `screenDestination`: the index and the Activity log
 * both file into today without displaying it, which is exactly the difference
 * that decides whether a capture needs a "View" affordance.
 */
export function viewedDestination(route: JournalRoute, today: string): Destination | null {
  switch (route.name) {
    case 'today':
      return { kind: 'date', date: route.date ?? today };
    case 'month':
      return { kind: 'collection', id: monthCollectionId(route.month ?? today.slice(0, 7)) };
    case 'collection':
      return { kind: 'collection', id: route.collectionId };
    default:
      return null;
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
 * A `>` shift then overrides any *date* destination — explicit grammar beats the
 * ambient viewed date, so `>today` typed while a past day is open files into
 * today.
 *
 * A collection destination keeps its collection and takes the day as the
 * entry's own date: the server accepts a date alongside a collection, so a
 * capture filed into a log no longer has to claim the day it was filed. The one
 * exception is a month log, which addresses its own month — a stated day
 * outside it belongs to the month that owns the day, not to the one being
 * browsed, which is the same rule the MCP schema enforces for agents.
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

  let statedDate: string | null = null;
  const date =
    dateShift === null ? null : resolveDateShift(dateShift, today, shiftBaseDate(route, today));
  if (date !== null) {
    if (destination.kind === 'date') {
      destination = { kind: 'date', date };
      source = 'token';
    } else {
      statedDate = date;
      // `source` stays whatever chose the collection: the token only re-dates a
      // filing, so a chip is still the thing a clear should take back. Only a
      // month log the day pulled to another month was truly chosen by the token.
      if (
        isMonthCollectionId(destination.id) &&
        monthFromCollectionId(destination.id) !== monthOf(date)
      ) {
        destination = { kind: 'collection', id: monthCollectionId(monthOf(date)) };
        source = 'token';
      }
    }
  }

  return {
    destination,
    source,
    createsCollection: destinationCreatesCollection(destination, collectionsById),
    statedDate,
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
