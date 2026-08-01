import {
  COLLECTION_TOKEN_SOURCE,
  DATE_SHIFT_TOKEN_SOURCE,
  SIGNIFIER_TOKEN_SOURCE,
  TAG_TOKEN_SOURCE,
  TIME_TOKEN_SOURCE,
  parseDateShiftToken,
  safeParseCapture,
} from '@journal/server/contracts/app';
import type { EntryType, ParsedDraft } from './types';

/** Adapts the canonical shared parser to the composer preview model. */
export function parseDraft(raw: string, defaultType: EntryType): ParsedDraft {
  const result = safeParseCapture(raw, defaultType);
  if (!result.success) {
    return {
      type: defaultType,
      text: raw.trim(),
      time: null,
      tags: [],
      collection: null,
      dateShift: null,
      signifierWon: false,
      error: result.error.message,
    };
  }
  return {
    type: result.data.type,
    time: result.data.time,
    text: result.data.text,
    tags: result.data.tags,
    collection: result.data.collection,
    dateShift: result.data.dateShift,
    signifierWon: result.data.signifier !== null,
    error: null,
  };
}

export type CaptureTokenKind = 'signifier' | 'tag' | 'time' | 'date-shift' | 'collection';

interface TokenSpan {
  start: number;
  end: number;
}

/**
 * Removes the token(s) of `kind` behind a chip, so dismissing a chip edits the
 * draft the owner actually typed. Regexes are rebuilt per call from the
 * parser's exported sources — shared global regexes carry lastIndex.
 *
 * Tags are special: the parser dedupes every occurrence into one chip, so a
 * tag removal strips all occurrences of that tag (`#work then #work` → both).
 * Every other kind removes the single occurrence the parser consumed.
 *
 * `value` targets a specific token (`tag`/`collection` compare case-insensitively
 * and tolerate a leading `#`/`/`; `time` compares the parsed `HH:MM`). Absent
 * tokens return the draft untouched, which keeps repeated removals idempotent.
 */
export function removeCaptureToken(draft: string, kind: CaptureTokenKind, value?: string): string {
  const span = findTokenSpan(draft, kind, value);
  if (span === null) return draft;
  if (kind !== 'tag') return spliceToken(draft, span);
  // Pin the tag from the first span, then splice matching occurrences until dry.
  const wanted = value ?? draft.slice(span.start, span.end);
  let edited = spliceToken(draft, span);
  for (;;) {
    const next = findTokenSpan(edited, 'tag', wanted);
    if (next === null) return edited;
    edited = spliceToken(edited, next);
  }
}

function findTokenSpan(draft: string, kind: CaptureTokenKind, value?: string): TokenSpan | null {
  switch (kind) {
    case 'signifier': {
      // The parser trims before anchoring at ^, so leading space must not hide it.
      const offset = draft.length - draft.trimStart().length;
      const match = new RegExp(SIGNIFIER_TOKEN_SOURCE, 'i').exec(draft.slice(offset));
      if (match === null) return null;
      return { start: offset, end: offset + match[0].length };
    }
    case 'date-shift': {
      for (const match of draft.matchAll(new RegExp(DATE_SHIFT_TOKEN_SOURCE, 'gi'))) {
        // Mirrors the parser: candidates it rejects (>2026-13-40) are skipped
        // rather than removed, so the chip and the removal target agree. Only
        // the first surviving token is the one the parser consumed, so this
        // kind ignores `value` — there is never a second shift to disambiguate.
        const body = match[1];
        if (body === undefined || parseDateShiftToken(body) === null) continue;
        return spanOf(match.index, match[0]);
      }
      return null;
    }
    case 'tag': {
      const wanted = value === undefined ? null : value.replace(/^#/, '').toLowerCase();
      for (const match of draft.matchAll(new RegExp(TAG_TOKEN_SOURCE, 'g'))) {
        if (wanted !== null && match[0].slice(1).toLowerCase() !== wanted) continue;
        return spanOf(match.index, match[0]);
      }
      return null;
    }
    case 'collection': {
      const wanted = value === undefined ? null : value.replace(/^\//, '').toLowerCase();
      // The token's lookbehind already refuses `//escaped`, so escapes survive.
      for (const match of draft.matchAll(new RegExp(COLLECTION_TOKEN_SOURCE, 'g'))) {
        const slug = match[1];
        if (slug === undefined) continue;
        if (wanted !== null && slug.toLowerCase() !== wanted) continue;
        return spanOf(match.index, match[0]);
      }
      return null;
    }
    case 'time': {
      for (const match of draft.matchAll(new RegExp(TIME_TOKEN_SOURCE, 'gi'))) {
        // Mirrors the parser: candidates it rejects (@99, @7:75) are skipped
        // rather than removed, so the chip and the removal target agree.
        const formatted = formatCaptureTime(match);
        if (formatted === null) continue;
        if (value !== undefined && formatted !== value) continue;
        return spanOf(match.index, match[0]);
      }
      return null;
    }
  }
}

function spanOf(index: number | undefined, token: string): TokenSpan | null {
  if (index === undefined) return null;
  return { start: index, end: index + token.length };
}

/** Splices a token out and heals the seam it leaves to a single space. */
function spliceToken(draft: string, span: TokenSpan): string {
  const before = draft.slice(0, span.start);
  const after = draft.slice(span.end);
  const healed = /\s$/.test(before) && /^\s/.test(after) ? after.replace(/^\s+/, '') : after;
  return `${before}${healed}`.trim();
}

/** Local mirror of the parser's time validation; see server/src/domain/parser.ts. */
function formatCaptureTime(match: RegExpMatchArray): string | null {
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
