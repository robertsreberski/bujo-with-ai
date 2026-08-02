// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JournalCollection, JournalEntry } from '../components/types';
import { DEFAULT_LOG_VIEW, type LogViewConfig } from '../domain/log-arrangement';
import { MonthView } from './MonthView';

afterEach(cleanup);

const callbacks = {
  onMonthChange: vi.fn(),
  onDaySelect: vi.fn(),
  onOpenEntry: vi.fn(),
  onToggleEntry: vi.fn(),
  onSaveSummary: vi.fn(),
  onRewriteSummary: vi.fn(),
  onLogViewChange: vi.fn(),
  onAddToMonthlyLog: vi.fn(),
};

const renderMonth = (
  entries: JournalEntry[] = [],
  logView: LogViewConfig = DEFAULT_LOG_VIEW,
  collections: JournalCollection[] = [],
  overrides: Partial<React.ComponentProps<typeof MonthView>> = {},
) =>
  render(
    <MonthView
      month="2026-08"
      today="2026-08-03"
      entries={entries}
      collections={collections}
      summary={null}
      preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
      logView={logView}
      {...callbacks}
      {...overrides}
    />,
  );

const logEntry = (id: string, patch: Partial<JournalEntry> = {}): JournalEntry => ({
  id,
  date: '2026-08-05',
  type: 'task',
  text: `Entry ${id}`,
  state: 'open',
  time: null,
  tags: [],
  author: 'me',
  source: null,
  migrations: 0,
  collection: 'month:2026-08',
  dateStated: false,
  createdAt: '2026-08-05T10:00:00.000Z',
  updatedAt: '2026-08-05T10:00:00.000Z',
  revision: 1,
  deletedAt: null,
  ...patch,
});

describe('MonthView', () => {
  it('renders every counted destination exactly once in the owning month', () => {
    const atlas: JournalCollection = {
      id: 'project-atlas',
      name: 'Project Atlas',
      note: null,
      createdAt: '2026-08-01T08:00:00.000Z',
      archivedAt: null,
    };
    renderMonth(
      [
        logEntry('daily', { text: 'Daily line', collection: null }),
        logEntry('filed', { text: 'Filed line', collection: 'project-atlas' }),
        logEntry('august', {
          text: 'August destination',
          date: '2026-09-02',
          collection: 'month:2026-08',
        }),
        logEntry('september', {
          text: 'September destination',
          date: '2026-08-05',
          collection: 'month:2026-09',
        }),
      ],
      DEFAULT_LOG_VIEW,
      [atlas],
    );

    const timeline = screen.getByRole('region', { name: 'Month timeline' });
    const monthlyLog = screen.getByRole('region', { name: 'Monthly log' });
    expect(within(timeline).getByText('Daily line')).toBeInTheDocument();
    expect(within(timeline).getByText('Filed line')).toBeInTheDocument();
    expect(within(timeline).getByText('Project Atlas')).toBeInTheDocument();
    expect(within(monthlyLog).getByText('August destination')).toBeInTheDocument();
    expect(screen.queryByText('September destination')).not.toBeInTheDocument();
    expect(screen.getAllByText('Daily line')).toHaveLength(1);
    expect(screen.getAllByText('Filed line')).toHaveLength(1);
    expect(screen.getAllByText('August destination')).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: /Wednesday, August 5 — 2 entries/i }),
    ).toBeInTheDocument();
  });

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
      dateStated: true,
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

  it('collapses finished work behind a Done & moved disclosure', () => {
    renderMonth([
      logEntry('a', { text: 'Renew passport' }),
      logEntry('b', { text: 'Call plumber', state: 'done' }),
      logEntry('c', { text: 'Plan trip', state: 'migrated' }),
    ]);
    const log = screen.getByRole('region', { name: 'Monthly log' });
    expect(within(log).getByText('Renew passport')).toBeVisible();
    expect(within(log).getByText('Call plumber')).not.toBeVisible();
    expect(within(log).getByText('Plan trip')).not.toBeVisible();
    expect(within(log).getByText('3 items')).toBeInTheDocument();

    fireEvent.click(within(log).getByText('Done & moved (2)'));
    expect(within(log).getByText('Call plumber')).toBeVisible();
    expect(within(log).getByText('Plan trip')).toBeVisible();
  });

  it('anchors every log row with its date', () => {
    renderMonth([logEntry('a', { text: 'Renew passport', date: '2026-08-05' })]);
    const log = screen.getByRole('region', { name: 'Monthly log' });
    expect(within(log).getByText('Aug 5')).toBeInTheDocument();
  });

  it('reports the narrowed count and offers the arrange trigger', () => {
    renderMonth(
      [
        logEntry('a', { text: 'Renew passport' }),
        logEntry('b', { text: 'Loved the rain', type: 'note', state: 'logged' }),
      ],
      { ...DEFAULT_LOG_VIEW, types: ['task'] },
    );
    const log = screen.getByRole('region', { name: 'Monthly log' });
    expect(within(log).getByText('1 of 2 items')).toBeInTheDocument();
    expect(within(log).getByText('Renew passport')).toBeVisible();
    expect(within(log).queryByText('Loved the rain')).not.toBeInTheDocument();
    expect(
      within(log).getByRole('button', { name: 'Arrange monthly log — filters active' }),
    ).toBeInTheDocument();
  });

  it('groups the active portion by type with count headers on request', () => {
    renderMonth(
      [
        logEntry('a', { text: 'Renew passport' }),
        logEntry('b', { text: 'Loved the rain', type: 'note', state: 'logged' }),
        logEntry('c', { text: 'Call plumber', state: 'done' }),
      ],
      { ...DEFAULT_LOG_VIEW, group: 'type' },
    );
    const log = screen.getByRole('region', { name: 'Monthly log' });
    expect(within(log).getByRole('heading', { level: 3, name: 'Tasks (1)' })).toBeInTheDocument();
    expect(within(log).getByRole('heading', { level: 3, name: 'Notes (1)' })).toBeInTheDocument();
    expect(within(log).getByText('Done & moved (1)')).toBeInTheDocument();
  });

  it('shows a quiet empty note when the arrangement matches nothing', () => {
    renderMonth([logEntry('a', { type: 'note', state: 'logged' })], {
      ...DEFAULT_LOG_VIEW,
      types: ['task'],
    });
    const log = screen.getByRole('region', { name: 'Monthly log' });
    expect(within(log).getByText('Nothing matches the current arrangement.')).toBeInTheDocument();
    expect(within(log).getByText('0 of 1 items')).toBeInTheDocument();
  });
});

describe('MonthView and the monthly log that names a day', () => {
  const dated = (id: string, patch: Partial<JournalEntry> = {}) =>
    logEntry(id, { dateStated: true, ...patch });

  it('splits the monthly log into a calendar page and a task page', () => {
    renderMonth(
      [
        logEntry('a', { text: 'Book flights' }),
        dated('b', { text: 'File the tax extension', date: '2026-08-03' }),
      ],
      { ...DEFAULT_LOG_VIEW, group: 'day' },
    );
    const log = screen.getByRole('region', { name: 'Monthly log' });
    expect(
      within(log).getByRole('heading', { level: 3, name: 'On a day (1)' }),
    ).toBeInTheDocument();
    expect(
      within(log).getByRole('heading', { level: 3, name: 'This month (1)' }),
    ).toBeInTheDocument();
  });

  it('counts a dated monthly-log entry on the calendar and in the month timeline', () => {
    renderMonth([
      logEntry('a', { text: 'Book flights', date: '2026-08-03' }),
      dated('b', { text: 'File the tax extension', date: '2026-08-03' }),
    ]);

    expect(
      screen.getByRole('button', { name: /Monday, August 3 — 1 entries/i }),
    ).toBeInTheDocument();
    const timeline = screen.getByRole('region', { name: 'Month timeline' });
    expect(within(timeline).getByText('File the tax extension')).toBeInTheDocument();
    expect(within(timeline).queryByText('Book flights')).not.toBeInTheDocument();
    expect(within(timeline).getByText('August 2026')).toBeInTheDocument();
  });

  it('offers last month’s unfinished tasks when setting up the current spread', () => {
    const onStartMonthReview = vi.fn();
    renderMonth(
      [
        logEntry('a', { collection: 'month:2026-07', text: 'Renew the passport' }),
        logEntry('b', { collection: 'month:2026-07', text: 'Cancel the gym', state: 'done' }),
      ],
      DEFAULT_LOG_VIEW,
      [],
      { onStartMonthReview },
    );

    expect(
      screen.getByRole('heading', { name: 'July 2026 left 1 task unfinished' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review July 2026' }));
    expect(onStartMonthReview).toHaveBeenCalledWith([
      expect.objectContaining({ text: 'Renew the passport' }),
    ]);
  });

  it('stays quiet once the review is waved off, and while browsing an old month', () => {
    const leftover = logEntry('a', {
      collection: 'month:2026-07',
      text: 'Renew the passport',
    });
    renderMonth([leftover], DEFAULT_LOG_VIEW, [], {
      onStartMonthReview: vi.fn(),
      monthReviewDismissed: '2026-08',
    });
    expect(
      screen.queryByRole('heading', { name: /left 1 task unfinished/ }),
    ).not.toBeInTheDocument();

    cleanup();
    renderMonth([logEntry('a', { collection: 'month:2026-06' })], DEFAULT_LOG_VIEW, [], {
      month: '2026-07',
      onStartMonthReview: vi.fn(),
    });
    expect(screen.queryByRole('heading', { name: /unfinished/ })).not.toBeInTheDocument();
  });
});
