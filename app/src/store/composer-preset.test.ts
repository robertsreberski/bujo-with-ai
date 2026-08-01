// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { journalActions, useJournalStore } from './journal-store';

afterEach(() => {
  useJournalStore.setState({ composerPreset: null });
});

describe('focusComposer', () => {
  it('starts with no standing request', () => {
    expect(useJournalStore.getState().composerPreset).toBeNull();
  });

  it('records the destination a view asked to file into', () => {
    journalActions.focusComposer({ kind: 'collection', id: 'reading' });
    expect(useJournalStore.getState().composerPreset).toEqual({
      destination: { kind: 'collection', id: 'reading' },
      nonce: 1,
    });
  });

  it('records a bare focus request with no destination', () => {
    journalActions.focusComposer();
    expect(useJournalStore.getState().composerPreset).toEqual({ destination: null, nonce: 1 });
  });

  it('raises the nonce every call, so repeating a destination still lands', () => {
    const destination = { kind: 'collection', id: 'month:2026-07' } as const;
    journalActions.focusComposer(destination);
    journalActions.focusComposer(destination);
    journalActions.focusComposer(destination);
    expect(useJournalStore.getState().composerPreset).toEqual({ destination, nonce: 3 });
  });

  it('publishes a new preset object so a subscriber can compare by identity', () => {
    const seen = vi.fn();
    const unsubscribe = useJournalStore.subscribe((state, previous) => {
      if (state.composerPreset !== previous.composerPreset) seen(state.composerPreset);
    });
    journalActions.focusComposer({ kind: 'date', date: '2026-08-01' });
    journalActions.focusComposer();
    unsubscribe();
    expect(seen).toHaveBeenNthCalledWith(1, {
      destination: { kind: 'date', date: '2026-08-01' },
      nonce: 1,
    });
    expect(seen).toHaveBeenNthCalledWith(2, { destination: null, nonce: 2 });
  });

  it('leaves the draft it is about to focus completely alone', () => {
    journalActions.setDraft('. Half-written thought');
    journalActions.setDefaultType('idea');
    journalActions.focusComposer({ kind: 'collection', id: 'reading' });
    expect(useJournalStore.getState().draft).toBe('. Half-written thought');
    expect(useJournalStore.getState().defaultType).toBe('idea');
  });
});
