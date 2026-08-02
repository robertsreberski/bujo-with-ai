// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem } from '../components/types';
import { ActivityView } from './ReviewView';

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

const entry = (id: string, text: string, patch: Record<string, unknown> = {}) => ({
  id,
  date: '2026-07-31',
  type: 'task' as const,
  text,
  state: 'open' as const,
  time: null,
  tags: [],
  author: 'me' as const,
  source: null,
  migrations: 0,
  collection: null,
  dateStated: true,
  createdAt: '2026-07-31T09:40:00.000Z',
  updatedAt: '2026-07-31T09:40:00.000Z',
  revision: 1,
  deletedAt: null,
  ...patch,
});

describe('ActivityView', () => {
  it('offers revert only when the server says the snapshot is eligible', async () => {
    const user = userEvent.setup();
    const onRevert = vi.fn();
    render(
      <ActivityView
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
        unseenIds={[]}
        hasUnseen={false}
        hasMore={false}
        loadingMore={false}
        timezone="Europe/Amsterdam"
        onLoadMore={vi.fn()}
        onRevert={onRevert}
        onOpenEntry={vi.fn()}
        onMarkVisible={vi.fn()}
        onMarkAllSeen={vi.fn()}
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
      dateStated: true,
      createdAt: '2026-07-31T09:40:00.000Z',
      updatedAt: '2026-07-31T09:40:00.000Z',
      revision: 1,
      deletedAt: null,
    };
    render(
      <ActivityView
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
        unseenIds={[]}
        hasUnseen={false}
        hasMore={false}
        loadingMore={false}
        timezone="Europe/Amsterdam"
        onLoadMore={vi.fn()}
        onRevert={vi.fn()}
        onOpenEntry={vi.fn()}
        onMarkVisible={vi.fn()}
        onMarkAllSeen={vi.fn()}
      />,
    );
    await user.click(screen.getByText('View raw details'));
    const tags = screen.getByText('Tags').parentElement;
    expect(tags).toHaveTextContent('Before #travel');
    expect(tags).toHaveTextContent('After #travel #urgent');
  });

  it('groups near-midnight activity in the configured journal timezone', () => {
    const { container } = render(
      <ActivityView
        activity={[
          { ...baseActivity, id: '01J00000000000000000000005', at: '2026-07-30T22:30:00.000Z' },
          { ...baseActivity, id: '01J00000000000000000000006', at: '2026-07-31T10:00:00.000Z' },
        ]}
        tokenLabels={{}}
        unseenIds={[]}
        hasUnseen={false}
        hasMore={false}
        loadingMore={false}
        timezone="Europe/Amsterdam"
        onLoadMore={vi.fn()}
        onRevert={vi.fn()}
        onOpenEntry={vi.fn()}
        onMarkVisible={vi.fn()}
        onMarkAllSeen={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('.activity-day')).toHaveLength(1);
  });

  it('states actor, action, entry, reason, authorship and opens the entry deep link', async () => {
    const user = userEvent.setup();
    const onOpenEntry = vi.fn();
    const row = entry('01J00000000000000000000003', 'Book flights for Lisbon');
    render(
      <ActivityView
        activity={[
          {
            ...baseActivity,
            kind: 'agent-update',
            text: 'Updated “Book flights for Lisbon” — Dates changed in the email',
            preImages: [{ entity: 'entry', id: row.id, row }],
            postImages: [
              {
                entity: 'entry',
                id: row.id,
                row: { ...row, revision: 2, updatedAt: baseActivity.at },
              },
            ],
          },
        ]}
        tokenLabels={{ '01J00000000000000000000002': 'Mail agent' }}
        unseenIds={[]}
        hasUnseen={false}
        hasMore={false}
        loadingMore={false}
        timezone="Europe/Amsterdam"
        onLoadMore={vi.fn()}
        onRevert={vi.fn()}
        onOpenEntry={onOpenEntry}
        onMarkVisible={vi.fn()}
        onMarkAllSeen={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: '“Book flights for Lisbon”' }).parentElement,
    ).toHaveTextContent('Mail agent updated “Book flights for Lisbon”');
    expect(screen.getByText('Reason:').parentElement).toHaveTextContent(
      'Dates changed in the email',
    );
    expect(screen.getByText('Created by You · Last changed by Mail agent')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '“Book flights for Lisbon”' }));
    expect(onOpenEntry).toHaveBeenCalledWith(row.id);
  });

  it('renders both sides of migration lineage as entry links', () => {
    const source = entry('01J00000000000000000000003', 'Book flights');
    const copy = entry('01J00000000000000000000007', 'Book flights', {
      migrations: 1,
      date: '2026-08-01',
    });
    render(
      <ActivityView
        activity={[
          {
            ...baseActivity,
            kind: 'agent-migration',
            text: 'Moved “Book flights” forward',
            refs: { entryIds: [source.id, copy.id] },
            preImages: [
              { entity: 'entry', id: source.id, row: source },
              { entity: 'entry', id: copy.id, row: null },
            ],
            postImages: [
              {
                entity: 'entry',
                id: source.id,
                row: { ...source, state: 'migrated', revision: 2 },
              },
              { entity: 'entry', id: copy.id, row: copy },
            ],
          },
        ]}
        tokenLabels={{}}
        unseenIds={[]}
        hasUnseen={false}
        hasMore={false}
        loadingMore={false}
        timezone="Europe/Amsterdam"
        onLoadMore={vi.fn()}
        onRevert={vi.fn()}
        onOpenEntry={vi.fn()}
        onMarkVisible={vi.fn()}
        onMarkAllSeen={vi.fn()}
      />,
    );

    const lineage = screen.getByLabelText('Migration lineage');
    expect(lineage).toHaveTextContent(/From.*Book flights.*→.*To.*Book flights/);
    expect(lineage.querySelectorAll('button')).toHaveLength(2);
  });

  it('acknowledges intersecting rows and offers an explicit all-seen action', async () => {
    const observed: Element[] = [];
    const observerState: { callback?: IntersectionObserverCallback } = {};
    const OriginalObserver = window.IntersectionObserver;
    class Observer {
      constructor(next: IntersectionObserverCallback) {
        observerState.callback = next;
      }
      observe(target: Element) {
        observed.push(target);
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = '0px';
      thresholds = [0.6];
    }
    window.IntersectionObserver = Observer as unknown as typeof IntersectionObserver;
    const onMarkVisible = vi.fn();
    const onMarkAllSeen = vi.fn();
    const user = userEvent.setup();
    render(
      <ActivityView
        activity={[baseActivity]}
        tokenLabels={{}}
        unseenIds={[baseActivity.id]}
        hasUnseen
        hasMore={false}
        loadingMore={false}
        timezone="Europe/Amsterdam"
        onLoadMore={vi.fn()}
        onRevert={vi.fn()}
        onOpenEntry={vi.fn()}
        onMarkVisible={onMarkVisible}
        onMarkAllSeen={onMarkAllSeen}
      />,
    );
    const row = observed.find((target) => (target as HTMLElement).dataset.activityId);
    expect(row).toBeDefined();
    observerState.callback?.(
      [{ target: row, isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    expect(onMarkVisible).toHaveBeenCalledWith([baseActivity.id]);
    await user.click(screen.getByRole('button', { name: 'Mark all seen' }));
    expect(onMarkAllSeen).toHaveBeenCalledOnce();
    window.IntersectionObserver = OriginalObserver;
  });

  it('does not reconstruct redacted entry text from the raw activity sentence', async () => {
    const user = userEvent.setup();
    render(
      <ActivityView
        activity={[
          {
            ...baseActivity,
            text: 'Deleted “Private health note” — contains sensitive context',
            kind: 'agent-delete',
            presentation: {
              actor: { kind: 'agent', label: 'Mail agent' },
              action: 'deleted',
              objectLabel: '“Private health note”',
              primaryEntryId: baseActivity.refs.entryIds[0]!,
              reason: 'contains sensitive context',
              attribution: [
                {
                  entryId: baseActivity.refs.entryIds[0]!,
                  originalAuthor: 'owner',
                  latestModifier: { kind: 'agent', label: 'Mail agent' },
                },
              ],
              lineage: null,
              latestAgentTouch: null,
            },
          },
        ]}
        tokenLabels={{}}
        unseenIds={[]}
        hasUnseen={false}
        hasMore={false}
        loadingMore={false}
        timezone="Europe/Amsterdam"
        onLoadMore={vi.fn()}
        onRevert={vi.fn()}
        onOpenEntry={vi.fn()}
        onMarkVisible={vi.fn()}
        onMarkAllSeen={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Entry …/ })).toBeInTheDocument();
    await user.click(screen.getByText('View raw details'));
    expect(
      screen.getByText('Entry content removed under the deletion policy.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Private health note/)).not.toBeInTheDocument();
  });
});
