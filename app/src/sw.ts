/// <reference lib="webworker" />

import { clientsClaim, setCacheNameDetails } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope;

interface PrecacheEntry {
  url: string;
  revision: string;
}

// Replaced by the local Vite plugin after all emitted assets are known.
const precacheManifest = JSON.parse('__JOURNAL_PRECACHE_JSON__') as PrecacheEntry[];
const LEGACY_API_CACHE = 'journal-api-v1';

setCacheNameDetails({ prefix: 'journal', suffix: 'v1' });
precacheAndRoute(precacheManifest);
cleanupOutdatedCaches();
clientsClaim();

// Versions before Timeline v2 cached journal API payloads. They are no longer
// read, and deleting the cache on activation removes stale journal data from
// Cache Storage after the upgrade.
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.delete(LEGACY_API_CACHE));
});

self.addEventListener('message', (event) => {
  if ((event.data as { type?: unknown } | null)?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

// IndexedDB is the sole offline journal-data source. Keeping API responses out
// of Cache Storage prevents a stale fallback from looking like a canonical
// network response to the store. NavigationRoute only matches navigations, so
// API, SSE, and mutation requests never reach the cached application shell.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

export {};
