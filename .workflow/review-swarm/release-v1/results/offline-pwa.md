# Offline and PWA review

The first pass found stale-response races between queueable requests and SSE,
runtime API responses being cached by the service worker, incomplete reset and
permanent-conflict cleanup, a stale journal-day intent after an offline resume,
an unflushed draft debounce, partial 401 handling, missing Summary fallback,
and a zero-height viewport regression. Shutdown also left delayed work alive.

All findings were assigned to the sync/PWA wave with deterministic regression
tests, including stale-response ordering, cold offline rollover, and shutdown
with pending work.
