// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JournalEntry } from '../components/types';
import { MonthView } from './MonthView';

afterEach(cleanup);

const callbacks = {
  onMonthChange: vi.fn(),
  onDaySelect: vi.fn(),
  onOpenEntry: vi.fn(),
  onToggleEntry: vi.fn(),
  onSaveSummary: vi.fn(),
  onRewriteSummary: vi.fn(),
};

const renderMonth = (entries: JournalEntry[] = []) =>
  render(
    <MonthView
      month="2026-08"
      today="2026-08-03"
      entries={entries}
      summary={null}
      preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
      {...callbacks}
    />,
  );

describe('MonthView', () => {
  it('completes the Monday-start calendar through the final week', () => {
    const { container } = renderMonth();
    const grid = screen.getByRole('group', { name: 'August 2026 calendar' });
    expect(grid).not.toBeNull();
    expect(grid?.children).toHaveLength(49);
    expect(container.querySelectorAll('.calendar-day')).toHaveLength(31);
    expect(grid?.lastElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(
      screen.getByRole('button', { name: /Monday, August 3 — 0 entries/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });

  it('exposes every habit day state without adding tab stops', () => {
    const habit: JournalEntry = {
      id: '01J00000000000000000000000',
      date: '2026-08-03',
      type: 'habit',
      text: 'Morning walk',
      state: 'done',
      time: null,
      tags: [],
      author: 'me',
      source: null,
      migrations: 0,
      collection: null,
      createdAt: '2026-08-03T08:00:00.000Z',
      updatedAt: '2026-08-03T08:00:00.000Z',
      revision: 1,
      deletedAt: null,
    };
    renderMonth([habit]);
    const strip = screen.getByRole('list', { name: 'Morning walk: 1 of 31 days completed' });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(31);
    expect(within(strip).getByRole('listitem', { name: /August 3: done$/i })).not.toHaveAttribute(
      'tabindex',
    );
  });
});
