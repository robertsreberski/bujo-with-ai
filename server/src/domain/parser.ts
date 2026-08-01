import { z } from 'zod';
import { EntryTypeSchema, type EntryType } from '../contracts/entities.js';
import { CalendarDateSchema, LocalTimeSchema, TagsSchema } from '../contracts/primitives.js';

export const CaptureSignifierSchema = z.enum(['.', 'o', '-', '!', '?', '+', '~']);

/**
 * What a `>` token asks for, kept symbolic rather than resolved to a date: the
 * parser is clock-free, so the caller resolves against its own `today`.
 * `weekday` carries an ISO day number (Monday = 1).
 */
export const DateShiftSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('today') }),
  z.strictObject({ kind: z.literal('tomorrow') }),
  z.strictObject({ kind: z.literal('weekday'), day: z.number().int().min(1).max(7) }),
  z.strictObject({ kind: z.literal('next-week') }),
  z.strictObject({ kind: z.literal('weekend') }),
  z.strictObject({ kind: z.literal('absolute'), date: CalendarDateSchema }),
]);

export const ParsedCaptureSchema = z.strictObject({
  type: EntryTypeSchema,
  text: z.string(),
  time: LocalTimeSchema.nullable(),
  tags: TagsSchema,
  collection: z
    .string()
    .regex(/^[a-z0-9-]{1,80}$/, 'Collection slugs use lowercase letters, digits, and hyphens.')
    .nullable(),
  dateShift: DateShiftSchema.nullable(),
  signifier: CaptureSignifierSchema.nullable(),
});

export type CaptureSignifier = z.infer<typeof CaptureSignifierSchema>;
export type DateShift = z.infer<typeof DateShiftSchema>;
export type ParsedCapture = z.infer<typeof ParsedCaptureSchema>;

export class CaptureParseError extends Error {
  readonly code: 'invalid_tag';
  readonly token: string;

  constructor(code: 'invalid_tag', token: string, message: string) {
    super(message);
    this.name = 'CaptureParseError';
    this.code = code;
    this.token = token;
  }
}

export type SafeCaptureParseResult =
  | { success: true; data: ParsedCapture }
  | { success: false; error: CaptureParseError };

const SIGNIFIER_TYPES: Readonly<Record<CaptureSignifier, EntryType>> = {
  '.': 'task',
  o: 'event',
  '-': 'note',
  '!': 'idea',
  '?': 'question',
  '+': 'habit',
  '~': 'mood',
};

/**
 * Token grammar sources, exported so editors can highlight or strip the same
 * tokens the parser consumes without re-deriving (and drifting from) them.
 * Build fresh RegExp instances per use; shared global regexes carry lastIndex.
 */
export const SIGNIFIER_TOKEN_SOURCE = String.raw`^([.o\-!?+~])\s+`;
export const COLLECTION_TOKEN_SOURCE = String.raw`(?<=^|\s)/([A-Za-z0-9-]{1,80})(?![A-Za-z0-9_:./-])`;
export const COLLECTION_ESCAPE_SOURCE = String.raw`(?<=^|\s)//(?=[A-Za-z0-9-])`;
export const TAG_TOKEN_SOURCE = String.raw`#[A-Za-z0-9-]+(?![A-Za-z0-9_-])`;
export const TIME_TOKEN_SOURCE = String.raw`@(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm))?(?![A-Za-z0-9:])`;
/*
 * Full weekday names precede their three-letter prefixes so the first winning
 * alternative is the longest one, and the trailing `\b` keeps `>tomorrowish`
 * and `>monx` inert rather than half-consumed.
 */
export const DATE_SHIFT_TOKEN_SOURCE = String.raw`>(today|tomorrow|next-week|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|\d{4}-\d{2}-\d{2})\b`;

const SIGNIFIER_LEAD = new RegExp(SIGNIFIER_TOKEN_SOURCE, 'i');
const COLLECTION_TOKEN = new RegExp(COLLECTION_TOKEN_SOURCE);
const COLLECTION_ESCAPE = new RegExp(COLLECTION_ESCAPE_SOURCE, 'g');
const VALID_TAG = new RegExp(TAG_TOKEN_SOURCE, 'g');
const INVALID_UNDERSCORE_TAG = /#[A-Za-z0-9-]*_[A-Za-z0-9_-]*/;
const TIME_CANDIDATE = new RegExp(TIME_TOKEN_SOURCE, 'gi');
const DATE_SHIFT_CANDIDATE = new RegExp(DATE_SHIFT_TOKEN_SOURCE, 'gi');

const WEEKDAY_NUMBERS: Readonly<Record<string, number>> = {
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
  sunday: 7,
  sun: 7,
};

/**
 * Reads the body of a `>` token (the match's capture group, no sigil) into the
 * shift it names, or null when the shape matched but the calendar refuses it —
 * `>2026-02-30`. Exported so an editor stripping the token can skip exactly the
 * candidates the parser skipped instead of re-deriving the rule.
 */
export function parseDateShiftToken(token: string): DateShift | null {
  const word = token.toLowerCase();
  if (word === 'today' || word === 'tomorrow') return { kind: word };
  if (word === 'next-week' || word === 'weekend') return { kind: word };
  const day = WEEKDAY_NUMBERS[word];
  if (day !== undefined) return { kind: 'weekday', day };
  const date = CalendarDateSchema.safeParse(word);
  return date.success ? { kind: 'absolute', date: date.data } : null;
}

/**
 * Parses the rapid-log grammar in its normative order. It is deterministic,
 * time-zone independent, and safe to share with the browser. Date intent stays
 * symbolic — `{ kind: 'weekday', day: 5 }`, never a resolved date — because the
 * parser never reads a clock; the caller attaches its frozen capture context.
 */
export function parseCapture(draft: string, defaultType: EntryType = 'task'): ParsedCapture {
  let remaining = draft.trim();
  let type = EntryTypeSchema.parse(defaultType);
  let signifier: CaptureSignifier | null = null;

  const lead = SIGNIFIER_LEAD.exec(remaining);
  if (lead?.[1] !== undefined) {
    signifier = CaptureSignifierSchema.parse(lead[1].toLowerCase());
    type = SIGNIFIER_TYPES[signifier];
    remaining = remaining.slice(lead[0].length);
  }

  // The collection token runs before tags because tag removal inserts spaces:
  // `#work/x` must stay a tag plus literal text, not become a collection.
  let collection: string | null = null;
  const collectionMatch = COLLECTION_TOKEN.exec(remaining);
  if (collectionMatch?.[1] !== undefined) {
    collection = collectionMatch[1].toLowerCase();
    remaining = `${remaining.slice(0, collectionMatch.index)} ${remaining.slice(
      collectionMatch.index + collectionMatch[0].length,
    )}`;
  }
  // Unescaping after the match keeps `//standup` literal instead of promoting it.
  remaining = remaining.replace(COLLECTION_ESCAPE, '/');

  const invalidTag = INVALID_UNDERSCORE_TAG.exec(remaining)?.[0];
  if (invalidTag !== undefined) {
    throw new CaptureParseError(
      'invalid_tag',
      invalidTag,
      `Invalid tag ${invalidTag}: tags use letters, digits, and hyphens; underscore is not valid.`,
    );
  }

  const tags: string[] = [];
  for (const match of remaining.matchAll(VALID_TAG)) {
    const tag = match[0].slice(1).toLowerCase();
    if (!tags.includes(tag)) tags.push(tag);
  }
  remaining = remaining.replace(VALID_TAG, ' ');

  let time: string | null = null;
  let timeMatch: RegExpExecArray | null;
  TIME_CANDIDATE.lastIndex = 0;
  while ((timeMatch = TIME_CANDIDATE.exec(remaining)) !== null) {
    const formatted = formatTime(timeMatch);
    if (formatted === null) continue;
    time = formatted;
    remaining = `${remaining.slice(0, timeMatch.index)} ${remaining.slice(
      timeMatch.index + timeMatch[0].length,
    )}`;
    break;
  }

  // Like the time scan: a candidate the calendar rejects (`>2026-13-40`) is
  // left as text and the scan continues, so it cannot mask a later valid token.
  let dateShift: DateShift | null = null;
  let shiftMatch: RegExpExecArray | null;
  DATE_SHIFT_CANDIDATE.lastIndex = 0;
  while ((shiftMatch = DATE_SHIFT_CANDIDATE.exec(remaining)) !== null) {
    const body = shiftMatch[1];
    const shift = body === undefined ? null : parseDateShiftToken(body);
    if (shift === null) continue;
    dateShift = shift;
    remaining = `${remaining.slice(0, shiftMatch.index)} ${remaining.slice(
      shiftMatch.index + shiftMatch[0].length,
    )}`;
    break;
  }

  return ParsedCaptureSchema.parse({
    type,
    text: collapseWhitespace(remaining),
    time,
    tags,
    collection,
    dateShift,
    signifier,
  });
}

export function safeParseCapture(
  draft: string,
  defaultType: EntryType = 'task',
): SafeCaptureParseResult {
  try {
    return { success: true, data: parseCapture(draft, defaultType) };
  } catch (error) {
    if (error instanceof CaptureParseError) return { success: false, error };
    throw error;
  }
}

function formatTime(match: RegExpExecArray): string | null {
  const rawHour = match[1];
  if (rawHour === undefined) return null;
  let hour = Number(rawHour);
  const minute = Number(match[2] ?? '00');
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (meridiem === 'pm' && hour < 12) hour += 12;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
