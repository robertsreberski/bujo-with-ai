/** GET-only runtime fallbacks are the only cacheable responses; IndexedDB owns bootstrap/settings state. */
export const CACHEABLE_API_PREFIXES = [
  '/api/entries',
  '/api/collections',
  '/api/activity',
  '/api/summary',
] as const;
