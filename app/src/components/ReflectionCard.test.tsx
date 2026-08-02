// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry, Reflection, ReflectionVersion } from '../api/types';
import { ReflectionCard } from './ReflectionCard';

afterEach(cleanup);

const SOURCE_ID = '01J00000000000000000000001';
const DELETED_ID = '01J00000000000000000000002';
const REFLECTION_ID = '01J00000000000000000000003';
const CURRENT_VERSION_ID = '01J00000000000000000000004';
const PRIOR_VERSION_ID = '01J00000000000000000000005';
const REQUEST_ID = '01J00000000000000000000006';
const TOKEN_ID = '01J00000000000000000000007';

const sourceEntry: Entry = {
  id: SOURCE_ID,
  date: '2026-07-21',
  type: 'note',
  text: 'A source entry that remains available',
  state: 'logged',
  time: null,
  tags: [],
  author: 'me',
  source: null,
  migrations: 0,
  collection: null,
  createdAt: '2026-07-21T08:00:00.000Z',
  updatedAt: '2026-07-21T08:00:00.000Z',
  revision: 1,
  deletedAt: null,
};

const deletedEntry: Entry = {
  ...sourceEntry,
  id: DELETED_ID,
  text: 'A source that was later deleted',
  deletedAt: '2026-08-01T09:00:00.000Z',
  revision: 2,
};

const currentVersion: ReflectionVersion = {
  id: CURRENT_VERSION_ID,
  number: 2,
  text: 'The week became calmer once the priorities were explicit.',
  sourceFrom: '2026-07-20',
  sourceTo: '2026-07-26',
  generator: {
    tokenId: TOKEN_ID,
    label: 'Weekly helper',
    tool: 'add_entry',
    source: 'Bounded synthesis from this week only.',
  },
  generatedAt: '2026-07-27T08:30:00.000Z',
  sourceEntries: [
    { id: SOURCE_ID, revision: 1 },
    { id: DELETED_ID, revision: 1 },
  ],
};

const priorVersion: ReflectionVersion = {
  ...currentVersion,
  id: PRIOR_VERSION_ID,
  number: 1,
  text: 'The first reading of the week.',
  generatedAt: '2026-07-27T07:30:00.000Z',
};

const reflection: Reflection = {
  id: REFLECTION_ID,
  weekStart: '2026-07-20',
  weekEnd: '2026-07-26',
  status: 'current',
  revision: 7,
  requestId: null,
  requestedAt: null,
  claimedAt: null,
  claimedBy: null,
  failure: null,
  currentVersionId: CURRENT_VERSION_ID,
  currentVersion,
  versions: [currentVersion, priorVersion],
  createdAt: '2026-07-27T07:00:00.000Z',
  updatedAt: '2026-07-27T08:30:00.000Z',
};

const props = {
  entriesById: { [SOURCE_ID]: sourceEntry, [DELETED_ID]: deletedEntry },
  online: true,
  timezone: 'Europe/Amsterdam',
  onRequest: vi.fn(),
  onRetry: vi.fn(),
  onRestore: vi.fn(),
  onOpenEntry: vi.fn(),
  onWrite: vi.fn(),
};

describe('ReflectionCard', () => {
  it('shows bounded provenance, source links, deleted sources, and restorable prior versions', () => {
    render(<ReflectionCard {...props} reflection={reflection} />);

    expect(screen.getAllByText(currentVersion.text)[0]).toBeVisible();
    expect(screen.getAllByText(/Jul 20–Jul 26/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Weekly helper/).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Deleted source · A source that was later deleted/)[0],
    ).toBeVisible();

    fireEvent.click(screen.getAllByRole('button', { name: sourceEntry.text })[0]!);
    expect(props.onOpenEntry).toHaveBeenCalledWith(sourceEntry);
    fireEvent.click(screen.getByText('Version history (2)'));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(props.onRestore).toHaveBeenCalledWith(REFLECTION_ID, PRIOR_VERSION_ID);
  });

  it('distinguishes queued work from an assistant claim', () => {
    const queued: Reflection = {
      ...reflection,
      status: 'queued',
      requestId: REQUEST_ID,
      requestedAt: '2026-07-27T09:00:00.000Z',
    };
    const { rerender } = render(<ReflectionCard {...props} reflection={queued} />);
    expect(screen.getByText(/waiting for an assistant to claim it/i)).toBeVisible();
    expect(screen.queryByText(/is working on this week/i)).not.toBeInTheDocument();

    rerender(
      <ReflectionCard
        {...props}
        reflection={{
          ...queued,
          status: 'running',
          claimedAt: '2026-07-27T09:05:00.000Z',
          claimedBy: { tokenId: TOKEN_ID, label: 'Weekly helper', tool: 'add_entry' },
        }}
      />,
    );
    expect(screen.getByText('Weekly helper is working on this week.')).toBeVisible();
  });

  it('keeps an offline not-requested card readable and offers a normal owner note', () => {
    render(
      <ReflectionCard
        {...props}
        online={false}
        reflection={{
          ...reflection,
          status: 'notRequested',
          currentVersionId: null,
          currentVersion: null,
          versions: [],
          revision: 1,
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Request assistant' })).toBeDisabled();
    expect(screen.getByText('Available offline')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Write your reflection' }));
    expect(props.onWrite).toHaveBeenCalledWith('2026-07-26');
  });

  it('makes an explicit failed request retryable', () => {
    render(
      <ReflectionCard
        {...props}
        reflection={{
          ...reflection,
          status: 'failed',
          requestId: REQUEST_ID,
          requestedAt: '2026-07-27T09:00:00.000Z',
          failure: 'Generator timed out.',
        }}
      />,
    );
    expect(screen.getByText('Generator timed out.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(props.onRetry).toHaveBeenCalledWith(REFLECTION_ID);
  });
});
