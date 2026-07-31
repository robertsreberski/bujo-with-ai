import { z } from 'zod';
import { EntryTypeSchema, type EntryType } from '../contracts/entities.js';
import { LocalTimeSchema, TagsSchema } from '../contracts/primitives.js';

export const CaptureSignifierSchema = z.enum(['.', 'o', '-', '!', '?', '+', '~']);

export const ParsedCaptureSchema = z.strictObject({
  type: EntryTypeSchema,
  text: z.string(),
  time: LocalTimeSchema.nullable(),
  tags: TagsSchema,
  dateShift: z.union([z.literal(0), z.literal(1)]),
  signifier: CaptureSignifierSchema.nullable(),
});

export type CaptureSignifier = z.infer<typeof CaptureSignifierSchema>;
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

const VALID_TAG = /#[A-Za-z0-9-]+(?![A-Za-z0-9_-])/g;
const INVALID_UNDERSCORE_TAG = /#[A-Za-z0-9-]*_[A-Za-z0-9_-]*/;
const TIME_CANDIDATE = /@(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm))?(?![A-Za-z0-9:])/gi;

/**
 * Parses the rapid-log grammar in its normative order. It is deterministic,
 * time-zone independent, and safe to share with the browser. Date intent is
 * represented as a 0/1 shift; the caller attaches its frozen capture context.
 */
export function parseCapture(draft: string, defaultType: EntryType = 'task'): ParsedCapture {
  let remaining = draft.trim();
  let type = EntryTypeSchema.parse(defaultType);
  let signifier: CaptureSignifier | null = null;

  const lead = /^([.o\-!?+~])\s+/i.exec(remaining);
  if (lead?.[1] !== undefined) {
    signifier = CaptureSignifierSchema.parse(lead[1].toLowerCase());
    type = SIGNIFIER_TYPES[signifier];
    remaining = remaining.slice(lead[0].length);
  }

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

  const tomorrow = />tomorrow\b/i.exec(remaining);
  const dateShift: 0 | 1 = tomorrow === null ? 0 : 1;
  if (tomorrow !== null) {
    remaining = `${remaining.slice(0, tomorrow.index)} ${remaining.slice(
      tomorrow.index + tomorrow[0].length,
    )}`;
  }

  return ParsedCaptureSchema.parse({
    type,
    text: collapseWhitespace(remaining),
    time,
    tags,
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
