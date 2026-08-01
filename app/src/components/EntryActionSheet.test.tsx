// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JournalCollection, JournalEntry } from './types';

/*
 * Vaul drives its drag gesture through pointer capture and a computed
 * `transform`, neither of which jsdom implements: a real click on a row throws
 * out of vaul's `onPointerDown`/`onPointerUp` and fails the run. The drawer is
 * therefore replaced with the plain elements it would render, which is exactly
 * the seam this component depends on — everything below the Content element is
 * ours. Vaul's own composition is covered instead by EntryDetailHost.test.tsx,
 * which renders the real drawer (mount only, no gesture).
 */
vi.mock('vaul', async () => {
  const react = await import('react');
  interface StubProps {
    children?: React.ReactNode;
    className?: string;
  }
  const box =
    (tag: string, attributes: Record<string, unknown> = {}) =>
    ({ children, className }: StubProps) =>
      react.createElement(tag, { className, ...attributes }, children);
  const passthrough = ({ children }: StubProps) =>
    react.createElement(react.Fragment, null, children);
  return {
    Drawer: {
      Root: passthrough,
      Portal: passthrough,
      Overlay: box('div'),
      Content: box('div', { role: 'dialog', 'aria-modal': 'true' }),
      Title: box('h2'),
      Description: box('p'),
    },
  };
});

const { EntryActionSheet } = await import('./EntryActionSheet');

afterEach(cleanup);

const entry: JournalEntry = {
  id: '01J00000000000000000000000',
  date: '2026-07-31',
  type: 'task',
  text: 'Reply to Mira',
  state: 'open',
  time: null,
  tags: ['work'],
  author: 'me',
  source: null,
  migrations: 0,
  collection: null,
  createdAt: '2026-07-31T09:00:00.000Z',
  updatedAt: '2026-07-31T09:00:00.000Z',
  revision: 1,
  deletedAt: null,
};

const atlas: JournalCollection = {
  id: 'project-atlas',
  name: 'Project Atlas',
  note: null,
  createdAt: '2026-07-01T09:00:00.000Z',
  archivedAt: null,
};

interface RenderOptions {
  collections?: JournalCollection[];
  contextMonth?: string | null;
}

const renderSheet = (value: JournalEntry = entry, options: RenderOptions = {}) => {
  const handlers = {
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onMigrate: vi.fn(),
    onSchedule: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <EntryActionSheet
      entry={value}
      collections={options.collections ?? []}
      today="2026-07-31"
      contextMonth={options.contextMonth ?? null}
      {...handlers}
    />,
  );
  return handlers;
};

describe('EntryActionSheet', () => {
  it('offers the entry’s available actions as rows under its text', () => {
    renderSheet();
    expect(screen.getByRole('heading', { name: 'Reply to Mira' })).toBeInTheDocument();
    for (const label of ['Edit', 'Mark done', 'Move to today', 'To monthly log', 'Drop']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /File in collection/ })).toBeInTheDocument();
    // Tasks are dropped, never deleted — the same rule the dialog applies.
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it.each(['migrated', 'cancelled'] as const)(
    'does not offer unsupported actions for a %s task',
    (state) => {
      renderSheet({ ...entry, state, migrations: state === 'migrated' ? 2 : 0 });
      expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Move to today' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'To monthly log' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Drop' })).not.toBeInTheDocument();
    },
  );

  it('fires the state actions and closes, exactly as the dialog does', async () => {
    const user = userEvent.setup();
    const { onUpdate, onClose } = renderSheet();

    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(onUpdate).toHaveBeenCalledWith(entry, { state: 'done' }, 'Marked done');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('drops an open task and migrates it through the migration handler', async () => {
    const user = userEvent.setup();
    const first = renderSheet();
    await user.click(screen.getByRole('button', { name: 'Move to today' }));
    expect(first.onMigrate).toHaveBeenCalledWith(entry);
    expect(first.onClose).toHaveBeenCalledTimes(1);

    cleanup();
    const second = renderSheet();
    await user.click(screen.getByRole('button', { name: 'Drop' }));
    expect(second.onUpdate).toHaveBeenCalledWith(entry, { state: 'cancelled' }, 'Dropped');
  });

  it('moves a filed note back to the daily log and inerts the row that has nowhere to go', async () => {
    const user = userEvent.setup();
    const collected = { ...entry, type: 'note' as const, state: 'logged' as const };
    const { onUpdate } = renderSheet({ ...collected, collection: 'project-atlas' });
    await user.click(screen.getByRole('button', { name: 'Move to today' }));
    expect(onUpdate).toHaveBeenCalledWith(
      { ...collected, collection: 'project-atlas' },
      { date: '2026-07-31', collection: null },
      'Moved to today',
    );

    cleanup();
    renderSheet(collected);
    expect(screen.getByRole('button', { name: 'Move to today' })).toBeDisabled();
  });

  it('names the schedule row after the month the view is showing', async () => {
    const user = userEvent.setup();
    const { onSchedule, onClose } = renderSheet(entry, { contextMonth: '2026-09' });
    expect(screen.queryByRole('button', { name: 'To monthly log' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'To September log' }));
    expect(onSchedule).toHaveBeenCalledWith(entry);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('files through a picker face inside the sheet', async () => {
    const user = userEvent.setup();
    const { onUpdate, onClose } = renderSheet(entry, { collections: [atlas] });

    await user.click(screen.getByRole('button', { name: /File in collection/ }));
    expect(screen.getByRole('heading', { name: /File in collection/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Daily log' })).toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Project Atlas' }));
    expect(onUpdate).toHaveBeenCalledWith(entry, { collection: 'project-atlas' }, 'Entry filed');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns from a face to the action list without touching the entry', async () => {
    const user = userEvent.setup();
    const { onUpdate, onDelete, onClose } = renderSheet(entry, { collections: [atlas] });

    await user.click(screen.getByRole('button', { name: /File in collection/ }));
    await user.click(screen.getByRole('button', { name: 'Back to actions' }));
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeInTheDocument();

    expect(onUpdate).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('confirms deletion inside the sheet rather than stacking a dialog', async () => {
    const user = userEvent.setup();
    const note = { ...entry, type: 'note' as const, state: 'logged' as const };
    const { onDelete, onClose } = renderSheet(note);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: /Delete this entry\?/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete entry' }));
    expect(onDelete).toHaveBeenCalledWith(note);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('edits in place and saves through the update handler', async () => {
    const user = userEvent.setup();
    const { onUpdate, onClose } = renderSheet();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const text = screen.getByRole('textbox', { name: 'Text' });
    await user.clear(text);
    await user.type(text, 'Reply to Mira today');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onUpdate).toHaveBeenCalledWith(
      entry,
      expect.objectContaining({ text: 'Reply to Mira today' }),
      'Entry updated',
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the read-only facts behind a Details disclosure', async () => {
    const user = userEvent.setup();
    renderSheet(entry, { collections: [atlas] });
    const details = screen.getByText('Details');

    const disclosure = details.closest('details');
    expect(disclosure).not.toHaveAttribute('open');
    await user.click(details);
    expect(disclosure).toHaveAttribute('open');
    expect(within(disclosure as HTMLElement).getByText('Added by')).toBeInTheDocument();
    expect(within(disclosure as HTMLElement).getByText('Filed in')).toBeInTheDocument();
  });
});
