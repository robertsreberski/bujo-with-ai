// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shell, type ShellCounts } from './Shell';
import type { JournalRoute } from '../routes/useJournalRoute';

afterEach(cleanup);

interface RenderOptions {
  counts?: ShellCounts;
  route?: JournalRoute;
}

const renderShell = (options: RenderOptions = {}) =>
  render(
    <Shell
      route={options.route ?? { name: 'today', date: null }}
      today="2026-07-31"
      dayCount={3}
      online
      syncing={false}
      outboxCount={0}
      deadLetterCount={0}
      {...(options.counts ? { counts: options.counts } : {})}
      title="Today"
      subtitle="Friday, July 31"
      onNavigate={vi.fn()}
      onSearch={vi.fn()}
      onSettings={vi.fn()}
      onDeadLetters={vi.fn()}
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
