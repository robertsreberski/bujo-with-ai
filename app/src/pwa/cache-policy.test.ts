import { describe, expect, it } from 'vitest';

import { CACHEABLE_API_PREFIXES } from './cache-policy';

describe('service-worker API cache policy', () => {
  it('caches only the history fallbacks, never authoritative bootstrap or settings', () => {
    expect(CACHEABLE_API_PREFIXES).toEqual([
      '/api/entries',
      '/api/collections',
      '/api/activity',
      '/api/summary',
    ]);
    expect(CACHEABLE_API_PREFIXES).not.toContain('/api/bootstrap');
    expect(CACHEABLE_API_PREFIXES).not.toContain('/api/settings');
  });
});
