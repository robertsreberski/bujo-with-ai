// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MigrationDialog } from './MigrationDialog';
import type { JournalEntry } from './types';

afterEach(cleanup);

const task = (id: string, text: string): JournalEntry => ({
  id,
  date: '2026-07-30',
  type: 'task',
  text,
  state: 'open',
  time: null,
  tags: [],
  author: 'me',
  source: null,
  migrations: 0,
  collection: null,
  createdAt: '2026-07-30T09:00:00.000Z',
  updatedAt: '2026-07-30T09:00:00.000Z',
  revision: 1,
  deletedAt: null,
});

const first = task('01J00000000000000000000001', 'Send the brief');
const second = task('01J00000000000000000000002', 'Book the train');

describe('MigrationDialog', () => {
  it('awaits each accepted decision, then announces and focuses the next task', async () => {
    const user = userEvent.setup();
    let acceptMigration: (() => void) | undefined;
    const onMigrate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acceptMigration = resolve;
        }),
    );
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onComplete = vi.fn();
    render(
      <MigrationDialog
        entries={[first, second]}
        onClose={vi.fn()}
        onMigrate={onMigrate}
        onUpdate={onUpdate}
        onSchedule={vi.fn().mockResolvedValue(undefined)}
        onComplete={onComplete}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Move to today' }));
    expect(onMigrate).toHaveBeenCalledWith(first);
    expect(screen.getByRole('button', { name: 'Moving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeDisabled();
    acceptMigration?.();
    const nextHeading = await screen.findByRole('heading', { name: 'Book the train' });
    expect(nextHeading).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Next task: Book the train. 2 of 2.');
    expect(onComplete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onUpdate).toHaveBeenCalledWith(second, 'done');
  });

  it('retains a rejected final item and never reports the queue complete', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    const onUpdate = vi.fn().mockRejectedValue(new Error('Revision conflict'));
    render(
      <MigrationDialog
        entries={[first, second]}
        onClose={vi.fn()}
        onMigrate={vi.fn().mockResolvedValue(undefined)}
        onUpdate={onUpdate}
        onSchedule={vi.fn().mockResolvedValue(undefined)}
        onComplete={onComplete}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Move to today' }));
    await screen.findByRole('heading', { name: 'Book the train' });
    await user.click(screen.getByRole('button', { name: 'Mark done' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Could not update Book the train. It is still waiting for a decision.',
      ),
    );
    expect(screen.getByRole('heading', { name: 'Book the train' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeEnabled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
