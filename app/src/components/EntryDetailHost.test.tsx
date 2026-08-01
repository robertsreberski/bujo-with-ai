// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntryDetailHost } from './EntryDetailHost';
import type { JournalEntry } from './types';

/*
 * Vaul is deliberately NOT mocked here: this is the one place the real drawer
 * is mounted, so a breaking change in its composition (Portal/Content/Title)
 * fails a unit test rather than only the e2e sweep. It is mount-only — vaul's
 * drag path needs pointer capture, which jsdom does not implement.
 */

type Handler = (event: MediaQueryListEvent) => void;

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

const installPointer = (coarse: boolean) => {
  const handlers = new Set<Handler>();
  let matches = coarse;
  const query = {
    get matches() {
      return matches;
    },
    media: '(pointer: coarse)',
    onchange: null,
    addEventListener: (_type: string, handler: Handler) => void handlers.add(handler),
    removeEventListener: (_type: string, handler: Handler) => void handlers.delete(handler),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => query as unknown as MediaQueryList),
  });
  return {
    emit(next: boolean) {
      matches = next;
      for (const handler of handlers) handler({ matches: next } as MediaQueryListEvent);
    },
  };
};

afterEach(() => {
  cleanup();
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
});

const entry: JournalEntry = {
  id: '01J00000000000000000000000',
  date: '2026-07-31',
  type: 'task',
  text: 'Reply to Mira',
  state: 'open',
  time: null,
  tags: [],
  author: 'me',
  source: null,
  migrations: 0,
  collection: null,
  createdAt: '2026-07-31T09:00:00.000Z',
  updatedAt: '2026-07-31T09:00:00.000Z',
  revision: 1,
  deletedAt: null,
};

const renderHost = () =>
  render(
    <EntryDetailHost
      entry={entry}
      collections={[]}
      today="2026-07-31"
      contextMonth={null}
      onClose={vi.fn()}
      onUpdate={vi.fn()}
      onDelete={vi.fn()}
      onMigrate={vi.fn()}
      onSchedule={vi.fn()}
    />,
  );

/** The sheet's drag handle and the dialog's close button tell the two apart. */
const showsSheet = () =>
  document.querySelector('.entry-sheet') !== null &&
  screen.queryByRole('button', { name: 'Close dialog' }) === null;

describe('EntryDetailHost', () => {
  it('mounts the action sheet on a coarse pointer', () => {
    installPointer(true);
    renderHost();
    expect(showsSheet()).toBe(true);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeInTheDocument();
  });

  it('mounts the dialog on a fine pointer', () => {
    installPointer(false);
    renderHost();
    expect(showsSheet()).toBe(false);
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'File in collection' })).toBeInTheDocument();
  });

  it('follows the pointer changing under a mounted surface', () => {
    const pointer = installPointer(false);
    renderHost();
    expect(showsSheet()).toBe(false);

    act(() => pointer.emit(true));
    expect(showsSheet()).toBe(true);

    act(() => pointer.emit(false));
    expect(showsSheet()).toBe(false);
  });

  it('offers the same action set on both surfaces', () => {
    installPointer(true);
    renderHost();
    const sheetActions = screen
      .getAllByRole('button')
      .map((button) => button.textContent?.trim())
      .filter((label): label is string => Boolean(label));
    cleanup();

    installPointer(false);
    renderHost();
    const dialogActions = screen
      .getAllByRole('button')
      .map((button) => button.textContent?.trim())
      .filter((label): label is string => Boolean(label));

    for (const label of ['Edit', 'Mark done', 'Move to today', 'To monthly log', 'Drop']) {
      expect(sheetActions).toContain(label);
      expect(dialogActions).toContain(label);
    }
  });
});
