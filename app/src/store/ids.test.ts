import { describe, expect, it, vi } from 'vitest';

import { createUlid } from './ids';

describe('createUlid', () => {
  it('creates sortable 26-character identifiers', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(7);
        return bytes;
      },
    });

    const first = createUlid(1_700_000_000_000);
    const second = createUlid(1_700_000_000_000);
    const later = createUlid(1_700_000_000_001);

    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second > first).toBe(true);
    expect(later > second).toBe(true);
    vi.unstubAllGlobals();
  });
});
