// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntryDialog } from './EntryDialog';
import type { JournalCollection, JournalEntry } from './types';

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

const renderEntry = (value: JournalEntry, options: RenderOptions = {}) => {
  const handlers = {
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onMigrate: vi.fn(),
    onSchedule: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <EntryDialog
      entry={value}
      collections={options.collections ?? []}
      today="2026-07-31"
      contextMonth={options.contextMonth ?? null}
      {...handlers}
    />,
  );
  return handlers;
};

describe('EntryDialog', () => {
  it('rejects invalid tags and de-duplicates normalized valid tags', async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderEntry(entry);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const tags = screen.getByRole('textbox', { name: /Tags/ });

    await user.clear(tags);
    await user.type(tags, 'work_tag');
    expect(screen.getByRole('alert')).toHaveTextContent('letters, numbers, and hyphens');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await user.clear(tags);
    await user.type(tags, '#Work, work, design');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onUpdate).toHaveBeenCalledWith(
      entry,
      expect.objectContaining({ tags: ['work', 'design'] }),
      'Entry updated',
    );
  });

  it.each(['migrated', 'cancelled'] as const)(
    'does not offer unsupported actions for a %s task',
    (state) => {
      renderEntry({ ...entry, state, migrations: state === 'migrated' ? 2 : 0 });
      expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Move to today' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'To monthly log' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Drop' })).not.toBeInTheDocument();
    },
  );

  it('keeps the non-actionable move, filing, and delete actions', () => {
    renderEntry({ ...entry, type: 'note', state: 'logged' });
    expect(screen.getByRole('button', { name: 'Move to today' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'File in collection' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'To monthly log' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Drop' })).not.toBeInTheDocument();
  });

  it('moves a same-day collection note back to the daily log', async () => {
    const user = userEvent.setup();
    const collected = {
      ...entry,
      type: 'note' as const,
      state: 'logged' as const,
      collection: 'project-atlas',
    };
    const { onUpdate } = renderEntry(collected);
    const move = screen.getByRole('button', { name: 'Move to today' });

    expect(move).toBeEnabled();
    await user.click(move);

    expect(onUpdate).toHaveBeenCalledWith(
      collected,
      { date: '2026-07-31', collection: null },
      'Moved to today',
    );
  });

  it('files an open task into a collection alongside its task actions', async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderEntry(entry, { collections: [atlas] });
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drop' })).toBeInTheDocument();

    const filing = screen.getByRole('combobox', { name: 'File in collection' });
    await user.selectOptions(filing, 'project-atlas');

    expect(onUpdate).toHaveBeenCalledWith(entry, { collection: 'project-atlas' }, 'Entry filed');
  });

  it.each([
    ['open', true],
    ['done', true],
    ['cancelled', true],
    ['migrated', false],
    ['scheduled', false],
  ] as const)('offers filing for a %s task: %s', (state, fileable) => {
    renderEntry({ ...entry, state });
    const filing = screen.queryByRole('combobox', { name: 'File in collection' });
    if (fileable) expect(filing).toBeInTheDocument();
    else expect(filing).not.toBeInTheDocument();
  });

  it('names the schedule action after the month the view is showing', async () => {
    const user = userEvent.setup();
    const { onSchedule } = renderEntry(entry, { contextMonth: '2026-09' });
    expect(screen.queryByRole('button', { name: 'To monthly log' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'To September log' }));
    expect(onSchedule).toHaveBeenCalledWith(entry);
  });

  it('keeps the plain label while the view shows the current month', () => {
    renderEntry(entry, { contextMonth: '2026-07' });
    expect(screen.getByRole('button', { name: 'To monthly log' })).toBeInTheDocument();
  });
});
