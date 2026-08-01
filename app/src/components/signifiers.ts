import { ENTRY_TYPES, type EntryType } from './types';

/**
 * The leading characters the capture parser maps to entry types.
 *
 * The parser owns `SIGNIFIER_TYPES` but does not export the map itself (only the
 * token regex), so this is a deliberate local mirror. `signifiers.test.ts` round
 * trips every pair through `parseDraft`, which fails loudly if the two drift.
 */
export const SIGNIFIER_BY_TYPE: Readonly<Record<EntryType, string>> = {
  task: '.',
  event: 'o',
  note: '-',
  idea: '!',
  question: '?',
  habit: '+',
  mood: '~',
};

/** `[signifier, type]` in menu order, for the type menu's hints and the legend. */
export const SIGNIFIER_KEYS: ReadonlyArray<readonly [string, EntryType]> = ENTRY_TYPES.map(
  (type) => [SIGNIFIER_BY_TYPE[type], type] as const,
);

const TYPE_BY_SIGNIFIER = new Map<string, EntryType>(
  SIGNIFIER_KEYS.map(([key, type]) => [key, type]),
);

/** The type a bare signifier keystroke selects, or null for any other key. */
export function typeForSignifier(key: string): EntryType | null {
  return TYPE_BY_SIGNIFIER.get(key.toLowerCase()) ?? null;
}
