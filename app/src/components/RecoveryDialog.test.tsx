// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry, RecentlyDeletedEntry } from '../api/types';
import type { DeadLetter } from '../store/models';
import { RecoveryDialog } from './DeadLetterDialog';

afterEach(cleanup);

const row: Entry = {
  id: 'entry-recovery',
  date: '2026-07-31',
  type: 'note',
  text: 'Keep this exact recovery content for later',
  state: 'logged',
  time: null,
  tags: [],
  author: 'me',
  source: null,
  migrations: 0,
  collection: null,
  dateStated: true,
  createdAt: '2026-07-31T10:00:00.000Z',
  updatedAt: '2026-07-31T11:00:00.000Z',
  revision: 2,
  deletedAt: '2026-07-31T11:00:00.000Z',
};

const deleted: RecentlyDeletedEntry = {
  entry: row,
  expiresAt: '2026-08-30T11:00:00.000Z',
  destination: {
    collectionId: 'lost-project',
    collectionName: null,
    status: 'missing',
  },
};

const failed: DeadLetter = {
  id: 'failed-1',
  mutationId: 'mutation-1',
  message: 'Entry changed since revision 1',
  code: 'revision_conflict',
  failedAt: '2026-07-31T12:00:00.000Z',
  operation: 'entry.update',
  item: {
    mutationId: 'mutation-1',
    method: 'PATCH',
    path: '/api/entries/entry-recovery',
    body: { patch: { text: row.text } },
    enqueuedAt: '2026-07-31T11:59:00.000Z',
    command: {
      kind: 'entry.update',
      id: row.id,
      patch: { text: row.text },
      expectedRevision: 1,
      at: '2026-07-31T11:59:00.000Z',
    },
  },
};

function renderRecovery(patch: Partial<ComponentProps<typeof RecoveryDialog>> = {}) {
  const props: ComponentProps<typeof RecoveryDialog> = {
    deadLetters: [],
    recentlyDeleted: [],
    entriesById: {},
    recoveryLoading: false,
    online: true,
    onRefresh: vi.fn(),
    onRestore: vi.fn(),
    onRetry: vi.fn(),
    onDiscard: vi.fn(),
    onOpenEntry: vi.fn(),
    onClose: vi.fn(),
    ...patch,
  };
  render(<RecoveryDialog {...props} />);
  return props;
}

describe('RecoveryDialog', () => {
  it('explains a missing destination before restoring the entry', async () => {
    const user = userEvent.setup();
    const { onRestore } = renderRecovery({ recentlyDeleted: [deleted] });

    expect(screen.getByText(/original collection is unavailable/i)).toHaveTextContent(
      'restores to 2026-07-31',
    );
    expect(screen.getByText(/recoverable until/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onRestore).toHaveBeenCalledWith(row.id);
  });

  it('shows intended content, offers truthful copy fallback, and confirms discard', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
    const live = { ...row, revision: 3, deletedAt: null };
    const { onOpenEntry, onDiscard } = renderRecovery({
      deadLetters: [failed],
      entriesById: { [live.id]: live },
    });

    expect(screen.getByText('Update entry')).toBeInTheDocument();
    expect(screen.getByText(/revision_conflict/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open entry' }));
    expect(onOpenEntry).toHaveBeenCalledWith(row.id);

    await user.click(screen.getByRole('button', { name: 'Copy content' }));
    const selectable = screen.getByRole('textbox', { name: 'Failed change content' });
    expect(selectable).toHaveValue(row.text);
    expect(selectable).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Content selected' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Discard…' }));
    expect(screen.getByRole('dialog', { name: 'Discard this failed change?' })).toBeInTheDocument();
    expect(onDiscard).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Discard failed change' }));
    expect(onDiscard).toHaveBeenCalledWith(failed.id);
  });
});
