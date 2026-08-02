// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchDialog } from './SearchDialog';
import { buildSearchSnippet } from './search-snippet';
import type { JournalEntry } from './types';

afterEach(cleanup);

describe('SearchDialog', () => {
  const entry: JournalEntry = {
    id: '01J00000000000000000000000',
    date: '2026-07-31',
    type: 'note',
    text: `${'Context '.repeat(30)}CAFÉ launch notes`,
    state: 'logged',
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

  it('labels downloaded results as partial rather than authoritative', async () => {
    const onSearch = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      hasMore: false,
      source: 'downloaded',
      reason: 'offline',
    });
    render(
      <SearchDialog
        entries={[]}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        initialQuery="missing"
        onSearch={onSearch}
        onClose={vi.fn()}
        onOpenEntry={vi.fn()}
        onToggleEntry={vi.fn()}
      />,
    );

    expect(screen.getByText('Searching the full journal…')).toBeInTheDocument();
    expect(
      await screen.findByText('Searching downloaded history — results may be incomplete.'),
    ).toBeInTheDocument();
    expect(onSearch).toHaveBeenCalledWith('missing');
    expect(screen.queryByText(/^No entries match/)).not.toBeInTheDocument();
    expect(screen.getByText('No downloaded entries match “missing”.')).toBeInTheDocument();
  });

  it('loads cursor pages and highlights a Unicode match inside a canonical-text snippet', async () => {
    const user = userEvent.setup();
    const second = { ...entry, id: '01J00000000000000000000001', text: 'Another café note' };
    const onSearch = vi
      .fn()
      .mockResolvedValueOnce({
        items: [entry],
        nextCursor: 'page-two',
        hasMore: true,
        source: 'journal',
        reason: null,
      })
      .mockResolvedValueOnce({
        items: [second],
        nextCursor: null,
        hasMore: false,
        source: 'journal',
        reason: null,
      });
    render(
      <SearchDialog
        entries={[]}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        initialQuery="cafe"
        onSearch={onSearch}
        onClose={vi.fn()}
        onOpenEntry={vi.fn()}
        onToggleEntry={vi.fn()}
      />,
    );

    expect(await screen.findByText('CAFÉ')).toHaveProperty('tagName', 'MARK');
    expect(screen.getByText(/^…/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onSearch).toHaveBeenLastCalledWith('cafe', 'page-two');
    expect(await screen.findByText('Another', { exact: false })).toBeInTheDocument();
  });

  it('offers an explicit retry after a failed request', async () => {
    const user = userEvent.setup();
    const onSearch = vi
      .fn()
      .mockRejectedValueOnce(new Error('Journal is unreachable.'))
      .mockResolvedValueOnce({
        items: [entry],
        nextCursor: null,
        hasMore: false,
        source: 'journal',
        reason: null,
      });
    render(
      <SearchDialog
        entries={[]}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        initialQuery="launch"
        onSearch={onSearch}
        onClose={vi.fn()}
        onOpenEntry={vi.fn()}
        onToggleEntry={vi.fn()}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Journal is unreachable.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('launch')).toHaveProperty('tagName', 'MARK');
    expect(onSearch).toHaveBeenCalledTimes(2);
  });

  it('keeps snippet generation bounded without replacing canonical text', () => {
    const snippet = buildSearchSnippet(entry.text, 'cafe', 80);
    expect(snippet.leadingEllipsis).toBe(true);
    expect(snippet.segments.find((segment) => segment.highlighted)?.text).toBe('CAFÉ');
    expect(snippet.segments.map((segment) => segment.text).join('')).not.toBe(entry.text);
  });
});
