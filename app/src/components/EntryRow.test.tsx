// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EntryRow } from './EntryRow';
import type { JournalEntry } from './types';

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

describe('EntryRow', () => {
  it('keeps checkbox and detail interactions distinct and keyboard accessible', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    render(
      <EntryRow
        entry={entry}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        onToggle={onToggle}
        onOpen={onOpen}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Mark as done: Reply to Mira' }));
    expect(onToggle).toHaveBeenCalledWith(entry);
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^Reply to Mira/ }));
    expect(onOpen).toHaveBeenCalledWith(entry);
  });

  it('opens terminal tasks instead of offering an illegal toggle', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    const migrated = { ...entry, state: 'migrated' as const, migrations: 2 };
    const { container } = render(
      <EntryRow
        entry={migrated}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        onToggle={onToggle}
        onOpen={onOpen}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Open task: Reply to Mira' }));
    expect(onOpen).toHaveBeenCalledWith(migrated);
    expect(onToggle).not.toHaveBeenCalled();
    expect(container.querySelector('.entry-row')).not.toHaveClass('entry-row--struck');
  });

  it('dims both tombstone states, and neither is struck through', () => {
    for (const state of ['migrated', 'scheduled'] as const) {
      const { container } = render(
        <EntryRow
          entry={{ ...entry, state, migrations: 1 }}
          preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
          onToggle={vi.fn()}
          onOpen={vi.fn()}
        />,
      );
      const row = container.querySelector('.entry-row');
      expect(row, state).toHaveClass('entry-row--dimmed');
      expect(row, state).not.toHaveClass('entry-row--struck');
      cleanup();
    }
  });
});
