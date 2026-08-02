// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IndexResponse } from '../api/types';
import type { JournalCollection } from '../components/types';
import { IndexView } from './IndexView';

afterEach(cleanup);

const collection = (
  id: string,
  name: string,
  count: number,
  archivedAt: string | null = null,
): JournalCollection & { count: number } => ({
  id,
  name,
  note: null,
  createdAt: '2026-07-01T09:00:00.000Z',
  archivedAt,
  count,
});

const model = (patch: Partial<IndexResponse> = {}): IndexResponse => ({
  collections: [],
  months: [],
  types: [],
  savedViews: [],
  ...patch,
});

const renderIndex = (
  index: IndexResponse | null,
  state: Partial<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    source: 'none' | 'cached' | 'journal';
    online: boolean;
    error: string | null;
  }> = {},
) => {
  const callbacks = {
    status: 'ready' as const,
    source: 'journal' as const,
    online: true,
    error: null,
    onRetry: vi.fn(),
    onOpenCollection: vi.fn(),
    onOpenMonth: vi.fn(),
    onOpenSearch: vi.fn(),
    onCreateCollection: vi.fn(),
    onUpdateCollection: vi.fn(),
    onAddToCollection: vi.fn(),
  };
  render(<IndexView index={index} {...callbacks} {...state} />);
  return callbacks;
};

describe('IndexView aggregate model', () => {
  it('shows aggregate counts and a quiet empty month state without invented saved views', () => {
    renderIndex(model({ collections: [collection('renamed', 'Renamed collection', 17)] }));

    expect(screen.getByText('Renamed collection')).toBeInTheDocument();
    expect(screen.getByText('17 items')).toBeInTheDocument();
    expect(screen.getByText('No monthly spreads yet.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Saved views' })).not.toBeInTheDocument();
    expect(screen.queryByText(/#work/i)).not.toBeInTheDocument();
  });

  it('renders only persisted owner queries and opens their exact query', async () => {
    const user = userEvent.setup();
    const callbacks = renderIndex(
      model({
        savedViews: [{ id: 'waiting', name: 'Waiting on me', query: 'is:open #waiting', count: 4 }],
      }),
    );

    await user.click(screen.getByRole('button', { name: /Waiting on me/i }));
    expect(callbacks.onOpenSearch).toHaveBeenCalledWith('is:open #waiting');
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('distinguishes duplicate archived names and restores the selected stable id', async () => {
    const user = userEvent.setup();
    const callbacks = renderIndex(
      model({
        collections: [
          collection('focus-a', 'Focus', 2, '2026-08-01T10:00:00.000Z'),
          collection('focus-b', 'Focus', 5, '2026-08-02T10:00:00.000Z'),
        ],
      }),
    );

    expect(screen.getByText('/focus-a')).toBeInTheDocument();
    expect(screen.getByText('/focus-b')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore Focus /focus-b' }));
    expect(callbacks.onUpdateCollection).toHaveBeenCalledWith('focus-b', { archived: false });
    expect(callbacks.onUpdateCollection).not.toHaveBeenCalledWith('focus-a', expect.anything());
  });

  it('ends the first offline load explicitly instead of leaving a spinner', () => {
    renderIndex(null, { status: 'idle', source: 'none', online: false });

    expect(screen.getByText('Journal index isn’t on this device yet.')).toBeInTheDocument();
    expect(screen.getByLabelText('Journal index')).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    expect(screen.queryByText('Loading journal index…')).not.toBeInTheDocument();
  });

  it('labels cached counts as stale and allows an explicit failed-refresh retry', async () => {
    const user = userEvent.setup();
    const callbacks = renderIndex(
      model({ collections: [collection('saved', 'Saved collection', 23)] }),
      {
        status: 'error',
        source: 'cached',
        online: true,
        error: 'Journal is unreachable.',
      },
    );

    expect(screen.getByText('23 items')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'showing saved counts that may be out of date',
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(callbacks.onRetry).toHaveBeenCalledOnce();
  });

  it('never presents a previously fresh snapshot as current while offline', () => {
    renderIndex(model({ months: [{ month: '2026-07', count: 9 }] }), {
      status: 'ready',
      source: 'journal',
      online: false,
    });

    expect(screen.getByRole('status')).toHaveTextContent(
      'Offline — counts are from the last sync and may be out of date.',
    );
  });
});
