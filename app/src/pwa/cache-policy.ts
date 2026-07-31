/** GET-only runtime fallbacks allowed by SPEC-05; IndexedDB owns bootstrap/settings state. */
export const CACHEABLE_API_PREFIXES = [
  '/api/entries',
  '/api/collections',
  '/api/activity',
  '/api/summary',
] as const;
