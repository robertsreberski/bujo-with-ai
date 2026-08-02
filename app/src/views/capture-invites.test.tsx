// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionView } from './CollectionView';
import { IndexView } from './IndexView';
import { MonthView } from './MonthView';
import { DEFAULT_LOG_VIEW } from '../domain/log-arrangement';
import type { DisplayPreferences, JournalCollection, JournalEntry } from '../components/types';

const focusComposer = vi.fn();

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const preferences: DisplayPreferences = {
  density: 'comfortable',
  showTypeBadges: true,
  highlightAiEntries: true,
};

const atlas: JournalCollection = {
  id: 'project-atlas',
  name: 'Project Atlas',
  note: null,
  createdAt: '2026-07-01T09:00:00.000Z',
  archivedAt: null,
};

const monthEntry: JournalEntry = {
  id: '01J00000000000000000000000',
  date: '2026-08-03',
  type: 'note',
  text: 'Quarterly planning',
  state: 'logged',
  time: null,
  tags: [],
  author: 'me',
  source: null,
  migrations: 0,
  collection: 'month:2026-08',
  dateStated: false,
  createdAt: '2026-08-03T09:00:00.000Z',
  updatedAt: '2026-08-03T09:00:00.000Z',
  revision: 1,
  deletedAt: null,
};

const renderMonth = (entries: JournalEntry[] = []) =>
  render(
    <MonthView
      month="2026-08"
      today="2026-08-03"
      entries={entries}
      summary={null}
      preferences={preferences}
      logView={DEFAULT_LOG_VIEW}
      onLogViewChange={vi.fn()}
      onMonthChange={vi.fn()}
      onDaySelect={vi.fn()}
      onOpenEntry={vi.fn()}
      onToggleEntry={vi.fn()}
      onSaveSummary={vi.fn()}
      onRewriteSummary={vi.fn()}
      onAddToMonthlyLog={() => focusComposer({ kind: 'collection', id: 'month:2026-08' })}
    />,
  );

describe('capture invites', () => {
  it('invites capture into an empty collection', async () => {
    const user = userEvent.setup();
    render(
      <CollectionView
        collection={atlas}
        entries={[]}
        preferences={preferences}
        logView={DEFAULT_LOG_VIEW}
        onLogViewChange={vi.fn()}
        onBack={vi.fn()}
        onOpenEntry={vi.fn()}
        onToggleEntry={vi.fn()}
        onAddToCollection={() => focusComposer({ kind: 'collection', id: 'project-atlas' })}
      />,
    );
    expect(screen.getByText('Nothing filed here yet.')).toBeInTheDocument();
    expect(screen.getByText('Add one below — it lands in Project Atlas.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add to Project Atlas' }));
    expect(focusComposer).toHaveBeenCalledWith({ kind: 'collection', id: 'project-atlas' });
  });

  it('offers the monthly log an invite from its heading and its empty state', async () => {
    const user = userEvent.setup();
    renderMonth();
    // The heading affordance and the empty state offer the same invite.
    const invites = screen.getAllByRole('button', { name: 'Add to August 2026 log' });
    expect(invites).toHaveLength(2);
    expect(screen.getByText('Nothing belongs to August 2026 yet.')).toBeInTheDocument();

    for (const [index, invite] of invites.entries()) {
      await user.click(invite);
      expect(focusComposer).toHaveBeenNthCalledWith(index + 1, {
        kind: 'collection',
        id: 'month:2026-08',
      });
    }
  });

  it('keeps the heading invite once the monthly log fills up', async () => {
    const user = userEvent.setup();
    renderMonth([monthEntry]);
    expect(screen.queryByText(/Nothing belongs to/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add to August 2026 log' }));
    expect(focusComposer).toHaveBeenCalledWith({ kind: 'collection', id: 'month:2026-08' });
  });

  it('adds a per-collection invite to the index rows without losing the edit action', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <IndexView
        index={{
          collections: [{ ...atlas, count: 0 }],
          months: [],
          types: [],
          savedViews: [],
        }}
        status="ready"
        source="journal"
        online
        error={null}
        onRetry={vi.fn()}
        onOpenCollection={vi.fn()}
        onOpenMonth={vi.fn()}
        onOpenSearch={vi.fn()}
        onCreateCollection={vi.fn()}
        onUpdateCollection={vi.fn()}
        onAddToCollection={(collection) => focusComposer({ kind: 'collection', id: collection.id })}
      />,
    );
    const row = container.querySelector('.index-row');
    expect(row?.querySelectorAll('button')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Edit Project Atlas' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add to Project Atlas' }));
    expect(focusComposer).toHaveBeenCalledWith({ kind: 'collection', id: 'project-atlas' });
  });
});
