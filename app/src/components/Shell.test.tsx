// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shell, type ShellCounts } from './Shell';
import type { JournalRoute } from '../routes/useJournalRoute';
import type { JournalStatus } from '../store/models';

afterEach(cleanup);

interface RenderOptions {
  counts?: ShellCounts;
  route?: JournalRoute;
  journalStatus?: JournalStatus;
  onRetryConnection?: () => void;
  onRetryLocalSave?: () => void;
  onReload?: () => void;
  onOpenRecovery?: () => void;
}

const onlineStatus: JournalStatus = {
  resource: 'ready',
  connection: 'online',
  synchronization: 'idle',
  persistence: 'available',
  pendingChanges: 0,
  failedChanges: 0,
};

const renderShell = (options: RenderOptions = {}) =>
  render(
    <Shell
      route={options.route ?? { name: 'today', date: null }}
      today="2026-07-31"
      dayCount={3}
      journalStatus={options.journalStatus ?? onlineStatus}
      {...(options.counts ? { counts: options.counts } : {})}
      title="Today"
      subtitle="Friday, July 31"
      onNavigate={vi.fn()}
      onSearch={vi.fn()}
      onSettings={vi.fn()}
      onRetryConnection={options.onRetryConnection ?? vi.fn()}
      onRetryLocalSave={options.onRetryLocalSave ?? vi.fn()}
      onReload={options.onReload ?? vi.fn()}
      onOpenRecovery={options.onOpenRecovery ?? vi.fn()}
      composer={<div className="composer-shell" />}
    >
      <p>content</p>
    </Shell>,
  );

/** Both chromes render in jsdom (only CSS hides one), so each nav item is a pair. */
const navPair = (name: string | RegExp) => screen.getAllByRole('button', { name });

describe('Shell counts', () => {
  it('renders no badge and a plain label when nothing is pending', () => {
    const { container } = renderShell();
    expect(navPair('Today')).toHaveLength(2);
    expect(navPair('Review')).toHaveLength(2);
    expect(container.querySelectorAll('.nav-item__count, .tab__count')).toHaveLength(0);
  });

  it('folds the count into the accessible name of both chromes', () => {
    renderShell({ counts: { today: 2, review: 3 } });
    expect(navPair('Today — 2 open tasks')).toHaveLength(2);
    expect(navPair('Review — 3 unseen changes')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Today' })).not.toBeInTheDocument();
  });

  it('keeps the badge itself out of the accessibility tree', () => {
    const { container } = renderShell({ counts: { today: 2, review: 3 } });
    const badges = [...container.querySelectorAll('.nav-item__count, .tab__count')];
    expect(badges).toHaveLength(4);
    for (const badge of badges) expect(badge).toHaveAttribute('aria-hidden', 'true');
    expect(badges.map((badge) => badge.textContent)).toEqual(['2', '3', '2', '3']);
  });

  it('says one thing in the singular', () => {
    renderShell({ counts: { today: 1, review: 1 } });
    expect(navPair('Today — 1 open task')).toHaveLength(2);
    expect(navPair('Review — 1 unseen change')).toHaveLength(2);
  });

  it('caps the drawn count at 9+ while announcing the real one', () => {
    const { container } = renderShell({ counts: { today: 12 } });
    expect(navPair('Today — 12 open tasks')).toHaveLength(2);
    for (const badge of container.querySelectorAll('.nav-item__count, .tab__count')) {
      expect(badge).toHaveTextContent('9+');
    }
  });

  it('tints the active destination’s badge and leaves the others neutral', () => {
    const { container } = renderShell({
      counts: { today: 2, review: 3 },
      route: { name: 'review' },
    });
    const active = [...container.querySelectorAll('.nav-item__count, .tab__count')].filter(
      (badge) => badge.className.includes('bg-primary'),
    );
    const inactive = [...container.querySelectorAll('.nav-item__count, .tab__count')].filter(
      (badge) => badge.className.includes('bg-border-strong'),
    );
    expect(active.map((badge) => badge.textContent)).toEqual(['3', '3']);
    expect(inactive.map((badge) => badge.textContent)).toEqual(['2', '2']);
  });

  it('never counts a destination that has no count', () => {
    const { container } = renderShell({ counts: { today: 2 } });
    expect(navPair('Month')).toHaveLength(2);
    expect(navPair('Index')).toHaveLength(2);
    expect(navPair('Review')).toHaveLength(2);
    expect(container.querySelectorAll('.nav-item__count, .tab__count')).toHaveLength(2);
  });
});

describe('Shell journal status', () => {
  it('describes offline mutations only as saved on this device', () => {
    renderShell({
      journalStatus: {
        ...onlineStatus,
        connection: 'offline',
        synchronization: 'pending',
        pendingChanges: 2,
      },
    });

    expect(screen.getByText('Offline — 2 changes saved on this device')).toBeInTheDocument();
    expect(screen.queryByText(/will sync/i)).not.toBeInTheDocument();
  });

  it('offers a retry while keeping reconnecting mutations visibly local', () => {
    const retry = vi.fn();
    renderShell({
      journalStatus: {
        ...onlineStatus,
        connection: 'reconnecting',
        synchronization: 'pending',
        pendingChanges: 1,
      },
      onRetryConnection: retry,
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: /Reconnecting to Journal — 1 change saved on this device Retry/,
      }),
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an unavailable server from expired authentication', () => {
    const retry = vi.fn();
    const first = renderShell({
      journalStatus: { ...onlineStatus, connection: 'serverUnavailable' },
      onRetryConnection: retry,
    });
    fireEvent.click(screen.getByRole('button', { name: /Journal server unavailable Retry/ }));
    expect(retry).toHaveBeenCalledTimes(1);
    first.unmount();

    const reload = vi.fn();
    renderShell({
      journalStatus: {
        ...onlineStatus,
        connection: 'authenticationRequired',
        synchronization: 'pending',
        pendingChanges: 3,
      },
      onReload: reload,
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: /Pairing expired — 3 changes saved on this device Reload/,
      }),
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('opens recovery for failed changes independently of connection state', () => {
    const openRecovery = vi.fn();
    renderShell({
      journalStatus: {
        ...onlineStatus,
        connection: 'offline',
        synchronization: 'attention',
        failedChanges: 2,
      },
      onOpenRecovery: openRecovery,
    });

    fireEvent.click(screen.getByRole('button', { name: /2 changes need attention Open recovery/ }));
    expect(openRecovery).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText('Offline — showing what is available on this device'),
    ).toBeInTheDocument();
  });

  it('never calls an IndexedDB failure saved and offers to retry it', () => {
    const retryLocalSave = vi.fn();
    renderShell({
      journalStatus: {
        ...onlineStatus,
        connection: 'offline',
        synchronization: 'attention',
        persistence: 'unavailable',
        pendingChanges: 1,
      },
      onRetryLocalSave: retryLocalSave,
    });

    expect(screen.getByText(/Offline — 1 change only in this open tab/)).toBeInTheDocument();
    expect(screen.queryByText(/1 change saved on this device/)).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: /Local saving unavailable — 1 change only in this open tab Retry saving/,
      }),
    );
    expect(retryLocalSave).toHaveBeenCalledTimes(1);
  });
});
