import { useCallback, useEffect, useMemo, useState } from 'react';

export type JournalRoute =
  | { name: 'today'; date: string | null }
  | { name: 'month'; month: string | null }
  | { name: 'index' }
  | { name: 'collection'; collectionId: string }
  | { name: 'review' };

const TIMELINE_ALIASES = new Set(['/today', '/timeline']);

const canonicalizeTimelineAlias = (): void => {
  const url = new URL(window.location.href);
  if (!TIMELINE_ALIASES.has(url.pathname)) return;
  window.history.replaceState(null, '', `/${url.search}${url.hash}`);
};

const readRoute = (): JournalRoute => {
  const url = new URL(window.location.href);
  if (TIMELINE_ALIASES.has(url.pathname)) {
    return { name: 'today', date: url.searchParams.get('date') };
  }
  if (url.pathname === '/month') return { name: 'month', month: url.searchParams.get('month') };
  if (url.pathname === '/index') return { name: 'index' };
  if (url.pathname === '/review') return { name: 'review' };
  const collectionMatch = /^\/c\/([^/]+)$/.exec(url.pathname);
  if (collectionMatch?.[1]) {
    return { name: 'collection', collectionId: decodeURIComponent(collectionMatch[1]) };
  }
  return { name: 'today', date: url.searchParams.get('date') };
};

const toHref = (route: JournalRoute): string => {
  switch (route.name) {
    case 'today':
      return route.date ? `/?date=${encodeURIComponent(route.date)}` : '/';
    case 'month':
      return route.month ? `/month?month=${encodeURIComponent(route.month)}` : '/month';
    case 'index':
      return '/index';
    case 'collection':
      return `/c/${encodeURIComponent(route.collectionId)}`;
    case 'review':
      return '/review';
  }
};

export function useJournalRoute() {
  const [route, setRoute] = useState<JournalRoute>(() => readRoute());

  useEffect(() => {
    canonicalizeTimelineAlias();
    const onPopState = () => {
      const next = readRoute();
      canonicalizeTimelineAlias();
      setRoute(next);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((next: JournalRoute, options?: { replace?: boolean }) => {
    const href = toHref(next);
    if (options?.replace) window.history.replaceState(null, '', href);
    else window.history.pushState(null, '', href);
    setRoute(next);
  }, []);

  return useMemo(() => ({ route, navigate }), [navigate, route]);
}
