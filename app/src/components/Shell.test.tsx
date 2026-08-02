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
  offlineReady?: boolean;
  updateReady?: boolean;
  onActivateUpdate?: () => void;
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
      journalStatus={options.journalStatus ?? onlineStatus}
      offlineReady={options.offlineReady ?? false}
      updateReady={options.updateReady ?? false}
      {...(options.counts ? { counts: options.counts } : {})}
      title="Timeline"
      subtitle="Friday, July 31"
      onNavigate={vi.fn()}
      onSearch={vi.fn()}
      onSettings={vi.fn()}
      onRetryConnection={options.onRetryConnection ?? vi.fn()}
      onRetryLocalSave={options.onRetryLocalSave ?? vi.fn()}
      onReload={options.onReload ?? vi.fn()}
      onActivateUpdate={options.onActivateUpdate ?? vi.fn()}
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
    expect(navPair('Timeline')).toHaveLength(2);
    expect(navPair('Activity')).toHaveLength(2);
    expect(container.querySelectorAll('.nav-item__count, .tab__count')).toHaveLength(0);
  });

  it('folds numeric work and neutral Activity state into accessible names', () => {
    renderShell({ counts: { today: 2, activity: true } });
    expect(navPair('Timeline — 2 open items')).toHaveLength(2);
    expect(navPair('Activity — unseen changes')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Timeline' })).not.toBeInTheDocument();
  });

  it('keeps the badge itself out of the accessibility tree', () => {
    const { container } = renderShell({ counts: { today: 2, activity: true } });
    const badges = [...container.querySelectorAll('.nav-item__count, .tab__count')];
    expect(badges).toHaveLength(4);
    for (const badge of badges) expect(badge).toHaveAttribute('aria-hidden', 'true');
    expect(badges.map((badge) => badge.textContent)).toEqual(['2', '', '2', '']);
  });

  it('says one thing in the singular', () => {
    renderShell({ counts: { today: 1, activity: true } });
    expect(navPair('Timeline — 1 open item')).toHaveLength(2);
    expect(navPair('Activity — unseen changes')).toHaveLength(2);
  });

  it('caps the drawn count at 9+ while announcing the real one', () => {
    const { container } = renderShell({ counts: { today: 12 } });
    expect(navPair('Timeline — 12 open items')).toHaveLength(2);
    for (const badge of container.querySelectorAll('.nav-item__count, .tab__count')) {
      expect(badge).toHaveTextContent('9+');
    }
  });

  it('tints the active destination’s badge and leaves the others neutral', () => {
    const { container } = renderShell({
      counts: { today: 2, activity: true },
      route: { name: 'activity' },
    });
    const active = [...container.querySelectorAll('.nav-item__count, .tab__count')].filter(
      (badge) => badge.className.includes('bg-primary'),
    );
    const inactive = [...container.querySelectorAll('.nav-item__count, .tab__count')].filter(
      (badge) => badge.className.includes('bg-border-strong'),
    );
    expect(active.map((badge) => badge.textContent)).toEqual(['', '']);
    expect(inactive.map((badge) => badge.textContent)).toEqual(['2', '2']);
  });

  it('never counts a destination that has no count', () => {
    const { container } = renderShell({ counts: { today: 2 } });
    expect(navPair('Month')).toHaveLength(2);
    expect(navPair('Index')).toHaveLength(2);
    expect(navPair('Activity')).toHaveLength(2);
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

  it('distinguishes a fully cached offline app from a best-effort fallback', () => {
    renderShell({
      offlineReady: true,
      journalStatus: { ...onlineStatus, connection: 'offline' },
    });

    expect(
      screen.getByText('Offline ready — showing what is saved on this device'),
    ).toBeInTheDocument();
  });

  it('keeps a waiting update visible and activates it only on request', () => {
    const activate = vi.fn();
    renderShell({ updateReady: true, onActivateUpdate: activate });

    fireEvent.click(screen.getByRole('button', { name: /Update ready Reload safely/ }));
    expect(activate).toHaveBeenCalledTimes(1);
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

describe('Shell route context', () => {
  it('uses the route title and subtitle in the responsive header', () => {
    const { container } = renderShell();
    expect(screen.getByRole('heading', { level: 1, name: 'Timeline' })).toBeInTheDocument();
    expect(container.querySelector('.app-header__subtitle')).toHaveTextContent('Friday, July 31');
    expect(screen.queryByRole('heading', { level: 1, name: 'Journal' })).not.toBeInTheDocument();
  });

  it('calls assistant configuration Settings everywhere', () => {
    renderShell();
    expect(navPair('Settings')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Assistant access' })).not.toBeInTheDocument();
  });
});
