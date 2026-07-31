import { safeParseCapture } from '@journal/server/contracts/app';
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
    dateShift: result.data.dateShift === 1 ? 'tomorrow' : null,
    signifierWon: result.data.signifier !== null,
    error: null,
  };
}
