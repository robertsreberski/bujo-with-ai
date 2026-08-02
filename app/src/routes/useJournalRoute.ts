import { useCallback, useEffect, useMemo, useState } from 'react';

export type JournalRoute =
  | { name: 'today'; date: string | null }
  | { name: 'month'; month: string | null }
  | { name: 'index' }
  | { name: 'collection'; collectionId: string }
  | { name: 'activity' };

const TIMELINE_ALIASES = new Set(['/today', '/timeline']);

const canonicalizeLegacyPath = (): void => {
  const url = new URL(window.location.href);
  if (TIMELINE_ALIASES.has(url.pathname)) {
    window.history.replaceState(null, '', `/${url.search}${url.hash}`);
  } else if (url.pathname === '/review') {
    window.history.replaceState(null, '', `/activity${url.search}${url.hash}`);
  }
};

const readRoute = (): JournalRoute => {
  const url = new URL(window.location.href);
  if (TIMELINE_ALIASES.has(url.pathname)) {
    return { name: 'today', date: url.searchParams.get('date') };
  }
  if (url.pathname === '/month') return { name: 'month', month: url.searchParams.get('month') };
  if (url.pathname === '/index') return { name: 'index' };
  if (url.pathname === '/activity' || url.pathname === '/review') return { name: 'activity' };
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
    case 'activity':
      return '/activity';
  }
};

const withEntry = (href: string, entryId: string | null): string => {
  if (entryId === null) return href;
  const url = new URL(href, window.location.origin);
  url.searchParams.set('entry', entryId);
  return `${url.pathname}${url.search}`;
};

export function useJournalRoute() {
  const [route, setRoute] = useState<JournalRoute>(() => readRoute());
  const [entryId, setEntryId] = useState<string | null>(() =>
    new URL(window.location.href).searchParams.get('entry'),
  );

  useEffect(() => {
    canonicalizeLegacyPath();
    const onPopState = () => {
      canonicalizeLegacyPath();
      const url = new URL(window.location.href);
      setRoute(readRoute());
      setEntryId(url.searchParams.get('entry'));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((next: JournalRoute, options?: { replace?: boolean }) => {
    const href = toHref(next);
    if (options?.replace) window.history.replaceState(null, '', href);
    else window.history.pushState(null, '', href);
    setRoute(next);
    setEntryId(null);
  }, []);

  const openEntry = useCallback(
    (id: string) => {
      window.history.pushState(null, '', withEntry(toHref(route), id));
      setEntryId(id);
    },
    [route],
  );

  const closeEntry = useCallback(() => {
    window.history.replaceState(null, '', toHref(route));
    setEntryId(null);
  }, [route]);

  return useMemo(
    () => ({ route, entryId, navigate, openEntry, closeEntry }),
    [closeEntry, entryId, navigate, openEntry, route],
  );
}
