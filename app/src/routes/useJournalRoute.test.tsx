// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
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
