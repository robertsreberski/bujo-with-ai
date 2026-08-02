// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useJournalRoute } from './useJournalRoute';

afterEach(() => window.history.replaceState(null, '', '/'));

describe('useJournalRoute Timeline aliases', () => {
  it.each(['/today', '/timeline'])('reads %s and replaces it with the canonical root', (alias) => {
    window.history.replaceState(null, '', `${alias}?date=2026-08-03`);
    const { result } = renderHook(() => useJournalRoute());

    expect(result.current.route).toEqual({ name: 'today', date: '2026-08-03' });
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('?date=2026-08-03');
  });

  it('keeps the root canonical when navigation returns to Timeline', () => {
    const { result } = renderHook(() => useJournalRoute());
    act(() => result.current.navigate({ name: 'today', date: null }));
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
  });
});

describe('useJournalRoute Activity compatibility', () => {
  it('replaces the legacy Review URL while retaining an entry deep link', async () => {
    window.history.replaceState(null, '', '/review?entry=01K1H0000000000000000011');
    const { result } = renderHook(() => useJournalRoute());

    expect(result.current.route).toEqual({ name: 'activity' });
    expect(result.current.entryId).toBe('01K1H0000000000000000011');
    await waitFor(() => expect(window.location.pathname).toBe('/activity'));
    expect(window.location.search).toBe('?entry=01K1H0000000000000000011');
  });

  it('opens and closes an entry through a shareable Activity URL', () => {
    window.history.replaceState(null, '', '/activity');
    const { result } = renderHook(() => useJournalRoute());

    act(() => result.current.openEntry('01K1H0000000000000000022'));
    expect(window.location.href).toContain('/activity?entry=01K1H0000000000000000022');
    expect(result.current.entryId).toBe('01K1H0000000000000000022');

    act(() => result.current.closeEntry());
    expect(window.location.pathname).toBe('/activity');
    expect(window.location.search).toBe('');
    expect(result.current.entryId).toBeNull();
  });
});
