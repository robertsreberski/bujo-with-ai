// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JournalCollection, JournalEntry } from '../components/types';
import { CollectionView } from './CollectionView';
import { DEFAULT_LOG_VIEW, type LogViewConfig } from './log-arrangement';

afterEach(cleanup);

const collection: JournalCollection = {
  id: 'project-atlas',
  name: 'Project Atlas',
  note: null,
  createdAt: '2026-07-01T09:00:00.000Z',
  archivedAt: null,
};

const entry = (id: string, patch: Partial<JournalEntry> = {}): JournalEntry => ({
  id,
  date: '2026-08-05',
  type: 'task',
  text: `Entry ${id}`,
  state: 'open',
  time: null,
  tags: [],
  author: 'me',
  source: null,
  migrations: 0,
  collection: collection.id,
  createdAt: '2026-08-05T10:00:00.000Z',
  updatedAt: '2026-08-05T10:00:00.000Z',
  revision: 1,
  deletedAt: null,
  ...patch,
});

const renderCollection = (entries: JournalEntry[], logView: LogViewConfig = DEFAULT_LOG_VIEW) =>
  render(
    <CollectionView
      collection={collection}
      entries={entries}
      preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
      logView={logView}
      onBack={vi.fn()}
      onOpenEntry={vi.fn()}
      onToggleEntry={vi.fn()}
      onLogViewChange={vi.fn()}
    />,
  );

describe('CollectionView arrangement', () => {
  it('collapses finished work behind a Done & moved disclosure and keeps the done meta', () => {
    renderCollection([
      entry('a', { text: 'Design the schema' }),
      entry('b', { text: 'Ship the spike', state: 'done' }),
    ]);
    const region = screen.getByRole('region', { name: 'Project Atlas' });
    expect(within(region).getByText('2 items · 1 done')).toBeInTheDocument();
    expect(within(region).getByText('Design the schema')).toBeVisible();
    expect(within(region).getByText('Ship the spike')).not.toBeVisible();

    fireEvent.click(within(region).getByText('Done & moved (1)'));
    expect(within(region).getByText('Ship the spike')).toBeVisible();
  });

  it('reports narrowing in the meta and offers the arrange trigger', () => {
    renderCollection(
      [
        entry('a', { text: 'Design the schema' }),
        entry('b', { text: 'A stray thought', type: 'note', state: 'logged' }),
      ],
      { ...DEFAULT_LOG_VIEW, types: ['task'] },
    );
    const region = screen.getByRole('region', { name: 'Project Atlas' });
    expect(within(region).getByText('1 of 2 items · 0 done')).toBeInTheDocument();
    expect(within(region).queryByText('A stray thought')).not.toBeInTheDocument();
    expect(
      within(region).getByRole('button', { name: 'Arrange collection — filters active' }),
    ).toBeInTheDocument();
  });
});
