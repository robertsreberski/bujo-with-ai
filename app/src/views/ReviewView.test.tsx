// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem } from '../components/types';
import { ReviewView } from './ReviewView';

afterEach(cleanup);

const baseActivity: ActivityItem = {
  id: '01J00000000000000000000001',
  at: '2026-07-31T09:41:00.000Z',
  text: 'Added “Book flights for Lisbon” from an email',
  kind: 'agent-add',
  origin: { actor: 'mcp', tokenId: '01J00000000000000000000002', tool: 'add_entry' },
  refs: { entryIds: ['01J00000000000000000000003'] },
  preImages: [],
  postImages: [],
  revertedAt: null,
  revertedByActivityId: null,
  revert: { eligible: true, reason: null },
};

describe('ReviewView', () => {
  it('offers revert only when the server says the snapshot is eligible', async () => {
    const user = userEvent.setup();
    const onRevert = vi.fn();
    render(
      <ReviewView
        activity={[
          baseActivity,
          {
            ...baseActivity,
            id: '01J00000000000000000000004',
            text: 'Updated a later entry',
            revert: { eligible: false, reason: 'post_image_mismatch' },
          },
        ]}
        tokenLabels={{ '01J00000000000000000000002': 'Test agent' }}
        hasMore={false}
        loadingMore={false}
        timezone="Europe/Amsterdam"
        onLoadMore={vi.fn()}
        onRevert={onRevert}
      />,
    );
    expect(screen.getAllByRole('button', { name: 'Revert' })).toHaveLength(1);
    expect(screen.getByText(/Changed since/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revert' }));
    await user.click(screen.getByRole('button', { name: 'Revert change' }));
    expect(onRevert).toHaveBeenCalledWith(baseActivity);
  });

  it('shows the canonical fields that actually changed', async () => {
    const user = userEvent.setup();
    const before = {
      id: '01J00000000000000000000003',
      date: '2026-07-31',
      type: 'task' as const,
      text: 'Book flights',
      state: 'open' as const,
      time: null,
      tags: ['travel'],
      author: 'ai' as const,
      source: 'From Lisbon email',
      migrations: 0,
      collection: null,
      createdAt: '2026-07-31T09:40:00.000Z',
      updatedAt: '2026-07-31T09:40:00.000Z',
      revision: 1,
      deletedAt: null,
    };
    render(
      <ReviewView
        activity={[
          {
            ...baseActivity,
            kind: 'agent-update',
            text: 'Tagged “Book flights”',
            preImages: [{ entity: 'entry', id: before.id, row: before }],
            postImages: [
              {
                entity: 'entry',
                id: before.id,
                row: {
                  ...before,
                  tags: ['travel', 'urgent'],
                  updatedAt: '2026-07-31T09:41:00.000Z',
                  revision: 2,
                },
              },
            ],
          },
        ]}
        tokenLabels={{}}
        hasMore={false}
        loadingMore={false}
        timezone="Europe/Amsterdam"
        onLoadMore={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
    await user.click(screen.getByText('View before and after'));
    const tags = screen.getByText('Tags').parentElement;
    expect(tags).toHaveTextContent('Before #travel');
    expect(tags).toHaveTextContent('After #travel #urgent');
  });

  it('groups near-midnight activity in the configured journal timezone', () => {
    const { container } = render(
      <ReviewView
        activity={[
          { ...baseActivity, id: '01J00000000000000000000005', at: '2026-07-30T22:30:00.000Z' },
          { ...baseActivity, id: '01J00000000000000000000006', at: '2026-07-31T10:00:00.000Z' },
        ]}
        tokenLabels={{}}
        hasMore={false}
        loadingMore={false}
        timezone="Europe/Amsterdam"
        onLoadMore={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('.activity-day')).toHaveLength(1);
  });
});
