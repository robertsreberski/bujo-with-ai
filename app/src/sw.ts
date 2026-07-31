/// <reference lib="webworker" />

import { clientsClaim, setCacheNameDetails, type WorkboxPlugin } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';

import { CACHEABLE_API_PREFIXES } from './pwa/cache-policy';

declare const self: ServiceWorkerGlobalScope;

interface PrecacheEntry {
  url: string;
  revision: string;
}

// Replaced by the local Vite plugin after all emitted assets are known.
const precacheManifest = JSON.parse('__JOURNAL_PRECACHE_JSON__') as PrecacheEntry[];

setCacheNameDetails({ prefix: 'journal', suffix: 'v1' });
precacheAndRoute(precacheManifest);
cleanupOutdatedCaches();
clientsClaim();

self.addEventListener('message', (event) => {
  if ((event.data as { type?: unknown } | null)?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

registerRoute(
  ({ request, url }) =>
    request.method === 'GET' &&
    url.origin === self.location.origin &&
    CACHEABLE_API_PREFIXES.some(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    ),
  new NetworkFirst({
    cacheName: 'journal-api-v1',
    networkTimeoutSeconds: 3,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 128,
        maxAgeSeconds: 7 * 24 * 60 * 60,
        purgeOnQuotaError: true,
      }) as unknown as WorkboxPlugin,
    ],
  }),
);

// NavigationRoute only matches navigation requests; API/SSE/mutations never reach it.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

export {};
