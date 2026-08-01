import { describe, expect, it } from 'vitest';

import { parseDraft } from './capture';
import { SIGNIFIER_BY_TYPE, SIGNIFIER_KEYS, typeForSignifier } from './signifiers';
import { ENTRY_TYPES } from './types';

describe('signifier map', () => {
  it('agrees with the capture parser for every entry type', () => {
    for (const type of ENTRY_TYPES) {
      const signifier = SIGNIFIER_BY_TYPE[type];
      // 'note' is the loser default, so a wrong mapping cannot pass by accident.
      expect(parseDraft(`${signifier} Something`, 'note').type, signifier).toBe(type);
    }
  });

  it('lists one key per type, in menu order', () => {
    expect(SIGNIFIER_KEYS.map(([, type]) => type)).toEqual([...ENTRY_TYPES]);
    expect(SIGNIFIER_KEYS.map(([key]) => key)).toEqual(['.', 'o', '-', '!', '?', '+', '~']);
  });

  it('resolves a keystroke back to its type', () => {
    expect(typeForSignifier('.')).toBe('task');
    expect(typeForSignifier('O')).toBe('event');
    expect(typeForSignifier('x')).toBeNull();
  });
});
