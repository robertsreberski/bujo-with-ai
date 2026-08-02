import { useCallback, useEffect, useMemo, useState } from 'react';

export type JournalRoute =
  | { name: 'today'; date: string | null }
  | { name: 'month'; month: string | null }
  | { name: 'index' }
  | { name: 'collection'; collectionId: string }
  | { name: 'activity' };

const TIMELINE_ALIASES = new Set(['/today', '/timeline']);
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const COLLECTION_ID = /^(?:[a-z0-9-]+|month:\d{4}-(?:0[1-9]|1[0-2]))$/;
const ENTRY_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

const isDateKey = (value: string): boolean => {
  if (!DATE_KEY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};

export const toHref = (route: JournalRoute): string => {
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
  const url = new URL(href, 'https://journal.local');
  url.searchParams.set('entry', entryId);
  return `${url.pathname}${url.search}`;
};

export function parseJournalUrl(value: string | URL): { route: JournalRoute; href: string } {
  const url = value instanceof URL ? value : new URL(value, 'https://journal.local');
  const entryId = url.searchParams.get('entry');
  const validEntryId = entryId !== null && ENTRY_ID.test(entryId) ? entryId : null;
  const result = (route: JournalRoute): { route: JournalRoute; href: string } => ({
    route,
    href: `${withEntry(toHref(route), validEntryId)}${url.hash}`,
  });

  if (url.pathname === '/' || TIMELINE_ALIASES.has(url.pathname)) {
    const candidate = url.searchParams.get('date');
    const route: JournalRoute = {
      name: 'today',
      date: candidate !== null && isDateKey(candidate) ? candidate : null,
    };
    return result(route);
  }
  if (url.pathname === '/month') {
    const candidate = url.searchParams.get('month');
    const route: JournalRoute = {
      name: 'month',
      month: candidate !== null && MONTH_KEY.test(candidate) ? candidate : null,
    };
    return result(route);
  }
  if (url.pathname === '/index') return result({ name: 'index' });
  if (url.pathname === '/activity' || url.pathname === '/review') {
    return result({ name: 'activity' });
  }
  const collectionMatch = /^\/c\/([^/]+)$/.exec(url.pathname);
  if (collectionMatch?.[1]) {
    try {
      const collectionId = decodeURIComponent(collectionMatch[1]);
      if (COLLECTION_ID.test(collectionId) && collectionId.length <= 80) {
        const route: JournalRoute = { name: 'collection', collectionId };
        return result(route);
      }
    } catch {
      // A malformed escape sequence is an invalid route, not an app crash.
    }
  }
  return result({ name: 'today', date: null });
}

const readRoute = (): JournalRoute => {
  const parsed = parseJournalUrl(window.location.href);
  const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (parsed.href !== currentHref) window.history.replaceState(null, '', parsed.href);
  return parsed.route;
};

export function useJournalRoute() {
  const [route, setRoute] = useState<JournalRoute>(() => readRoute());
  const [entryId, setEntryId] = useState<string | null>(() =>
    new URL(window.location.href).searchParams.get('entry'),
  );

  useEffect(() => {
    const onPopState = () => {
      setRoute(readRoute());
      const url = new URL(window.location.href);
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
