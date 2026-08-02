import { journalSearchNeedles, normalizeJournalSearchText } from '@journal/server/contracts/app';

const MAX_SNIPPET_LENGTH = 180;

interface HighlightRange {
  start: number;
  end: number;
}

export interface SearchSnippet {
  leadingEllipsis: boolean;
  trailingEllipsis: boolean;
  segments: { text: string; highlighted: boolean }[];
}

function normalizedIndex(value: string): {
  text: string;
  starts: number[];
  ends: number[];
} {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let originalOffset = 0;
  for (const character of value) {
    const start = originalOffset;
    const end = start + character.length;
    originalOffset = end;
    const normalized = normalizeJournalSearchText(character);
    text += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      starts.push(start);
      ends.push(end);
    }
  }
  return { text, starts, ends };
}

function highlightRanges(value: string, query: string | undefined): HighlightRange[] {
  const needles = journalSearchNeedles(query);
  if (needles.length === 0) return [];
  const indexed = normalizedIndex(value);
  const ranges: HighlightRange[] = [];
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const match = indexed.text.indexOf(needle, from);
      if (match < 0) break;
      const start = indexed.starts[match];
      const end = indexed.ends[match + needle.length - 1];
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
      from = match + needle.length;
    }
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: HighlightRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Builds a presentation-only excerpt; entry text remains the canonical searchable value. */
export function buildSearchSnippet(
  value: string,
  query: string | undefined,
  maximumLength = MAX_SNIPPET_LENGTH,
): SearchSnippet {
  const ranges = highlightRanges(value, query);
  let start = 0;
  let end = value.length;
  if (value.length > maximumLength) {
    const anchor = ranges[0]?.start ?? 0;
    start = Math.max(
      0,
      Math.min(anchor - Math.floor(maximumLength / 3), value.length - maximumLength),
    );
    end = Math.min(value.length, start + maximumLength);
    if (start > 0) {
      const boundary = value.slice(start, Math.min(end, start + 24)).search(/\s/u);
      if (boundary >= 0) start += boundary + 1;
    }
    if (end < value.length) {
      const boundary = value.slice(Math.max(start, end - 24), end).search(/\s[^\s]*$/u);
      if (boundary >= 0) end = Math.max(start, end - 24) + boundary;
    }
  }

  const visibleRanges = ranges
    .filter((range) => range.end > start && range.start < end)
    .map((range) => ({ start: Math.max(range.start, start), end: Math.min(range.end, end) }));
  const segments: SearchSnippet['segments'] = [];
  let cursor = start;
  for (const range of visibleRanges) {
    if (range.start > cursor) {
      segments.push({ text: value.slice(cursor, range.start), highlighted: false });
    }
    segments.push({ text: value.slice(range.start, range.end), highlighted: true });
    cursor = range.end;
  }
  if (cursor < end) segments.push({ text: value.slice(cursor, end), highlighted: false });
  return {
    leadingEllipsis: start > 0,
    trailingEllipsis: end < value.length,
    segments,
  };
}
