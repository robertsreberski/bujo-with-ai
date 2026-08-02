// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Reflection } from '../api/types';
import type { JournalEntry } from '../components/types';
import { TimelineView } from './TimelineView';

afterEach(cleanup);

const entry: JournalEntry = {
  id: '01J00000000000000000000000',
  date: '2026-08-03',
  type: 'task',
  text: 'Deep-linked task',
  state: 'open',
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

const props = {
  today: '2026-07-31',
  selectedDate: '2026-08-03',
  loading: false,
  collectionsById: {},
  hasEarlier: false,
  loadingEarlier: false,
  preferences: { density: 'comfortable' as const, showTypeBadges: true, highlightAiEntries: true },
  reflections: [],
  entriesById: { [entry.id]: entry },
  online: true,
  timezone: 'Europe/Amsterdam',
  onOpenEntry: vi.fn(),
  onToggleEntry: vi.fn(),
  onStartMigration: vi.fn(),
  onLoadEarlier: vi.fn(),
  onRequestReflection: vi.fn(),
  onRetryReflection: vi.fn(),
  onRestoreReflection: vi.fn(),
  onWriteReflection: vi.fn(),
};

describe('TimelineView', () => {
  it('shows daily and collection destinations exactly once with a compact label', () => {
    const collectionEntry = {
      ...entry,
      id: '01J00000000000000000000001',
      text: 'Filed thought',
      collection: 'projects',
    };
    const { container } = render(
      <TimelineView
        entries={[entry, collectionEntry, collectionEntry]}
        {...props}
        collectionsById={{
          projects: {
            id: 'projects',
            name: 'Projects',
            note: null,
            createdAt: '2026-07-01T08:00:00.000Z',
            archivedAt: null,
          },
        }}
      />,
    );

    expect(container.querySelectorAll('.entry-row')).toHaveLength(2);
    expect(screen.getByText('Projects')).toHaveClass('entry-row__destination');
  });

  it('renders a collection-only day as one chronological section', () => {
    const collectionEntry = {
      ...entry,
      id: '01J00000000000000000000002',
      text: 'Collection-only thought',
      collection: 'projects',
    };
    const { container } = render(
      <TimelineView
        entries={[collectionEntry]}
        {...props}
        collectionsById={{
          projects: {
            id: 'projects',
            name: 'Projects',
            note: null,
            createdAt: '2026-07-01T08:00:00.000Z',
            archivedAt: null,
          },
        }}
      />,
    );

    expect(container.querySelectorAll(`[data-day="${entry.date}"]`)).toHaveLength(1);
    expect(screen.getByText('Collection-only thought')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
  });

  it('names a future deep link as planning without adding an empty Today section', () => {
    const { container } = render(<TimelineView entries={[]} {...props} />);
    expect(screen.getByRole('heading', { name: /^Planning / })).toBeInTheDocument();
    expect(container.querySelector(`[data-day="${props.today}"]`)).not.toBeInTheDocument();
  });

  it('loads one explicit earlier page', () => {
    const onLoadEarlier = vi.fn();
    render(<TimelineView entries={[entry]} {...props} hasEarlier onLoadEarlier={onLoadEarlier} />);
    screen.getByRole('button', { name: 'Earlier' }).click();
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it('places a compact Reflection at a completed-week boundary even without a Monday entry', () => {
    const weekReflection: Reflection = {
      id: '01J00000000000000000000010',
      weekStart: '2026-07-20',
      weekEnd: '2026-07-26',
      status: 'notRequested',
      revision: 1,
      requestId: null,
      requestedAt: null,
      claimedAt: null,
      claimedBy: null,
      failure: null,
      currentVersionId: null,
      currentVersion: null,
      versions: [],
      createdAt: '2026-07-27T08:00:00.000Z',
      updatedAt: '2026-07-27T08:00:00.000Z',
    };
    const newer = { ...entry, id: 'newer', date: '2026-07-21', text: 'After boundary' };
    const older = { ...entry, id: 'older', date: '2026-07-19', text: 'Before boundary' };
    const { container } = render(
      <TimelineView
        {...props}
        today="2026-07-31"
        selectedDate={null}
        entries={[newer, older]}
        entriesById={{ newer, older }}
        reflections={[weekReflection]}
      />,
    );
    const timeline = [...container.querySelectorAll('.day-section, .reflection-card')].map(
      (node) => node.textContent,
    );
    expect(timeline.findIndex((text) => text?.includes('Weekly Reflection'))).toBeGreaterThan(
      timeline.findIndex((text) => text?.includes('After boundary')),
    );
    expect(timeline.findIndex((text) => text?.includes('Weekly Reflection'))).toBeLessThan(
      timeline.findIndex((text) => text?.includes('Before boundary')),
    );
  });

  it('creates a named empty section for a deep-linked calendar day', () => {
    const { container } = render(<TimelineView entries={[]} {...props} />);
    const selected = container.querySelector('[data-day="2026-08-03"]');
    expect(selected).toBeInTheDocument();
    expect(selected).toHaveTextContent('No entries yet');
  });

  it('shows collection-filed entries when opening a counted calendar day', () => {
    const filed = { ...entry, text: 'Filed on this day', collection: 'project-atlas' };
    render(<TimelineView entries={[filed]} {...props} />);

    expect(screen.getByText('Filed on this day')).toBeInTheDocument();
  });

  it('does not steal focus after the selected day receives an update', () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const { rerender } = render(<TimelineView entries={[entry]} {...props} />);
      const toggle = screen.getByRole('button', { name: 'Mark as done: Deep-linked task' });
      toggle.focus();
      rerender(
        <TimelineView entries={[{ ...entry, tags: ['updated'], revision: 2 }]} {...props} />,
      );
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(toggle).toHaveFocus();
    } finally {
      if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView;
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('does not re-scroll when the selected historical leftover receives a content update', () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const historical = {
      ...entry,
      date: '2026-07-28',
      text: 'Selected historical task',
    };
    try {
      const { rerender } = render(
        <TimelineView entries={[historical]} {...props} selectedDate={historical.date} />,
      );
      const toggle = screen.getByRole('button', { name: 'Mark as done: Selected historical task' });
      toggle.focus();

      rerender(
        <TimelineView
          entries={[
            {
              ...historical,
              text: 'Selected historical task updated',
              tags: ['updated'],
              revision: 2,
              updatedAt: '2026-07-31T09:00:00.000Z',
            },
          ]}
          {...props}
          selectedDate={historical.date}
        />,
      );

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(toggle).toHaveFocus();
    } finally {
      if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView;
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('re-scrolls after geometry above the selected day changes without stealing focus', () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const newer = {
      ...entry,
      id: '01J00000000000000000000001',
      date: '2026-08-04',
      text: 'A short newer row',
    };
    const oldClosed = {
      ...entry,
      id: '01J00000000000000000000002',
      date: '2026-07-01',
      text: 'Old closed task',
      state: 'done' as const,
    };
    try {
      const { rerender } = render(<TimelineView entries={[newer, entry, oldClosed]} {...props} />);
      const toggle = screen.getByRole('button', { name: 'Mark as done: Deep-linked task' });
      toggle.focus();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      rerender(
        <TimelineView
          entries={[
            {
              ...newer,
              text: 'A much longer newer row that changes the height above the selected day',
              revision: 2,
              updatedAt: '2026-08-04T09:00:00.000Z',
            },
            entry,
            {
              ...oldClosed,
              state: 'open',
              revision: 2,
              updatedAt: '2026-08-04T09:00:00.000Z',
            },
          ]}
          {...props}
        />,
      );

      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(toggle).toHaveFocus();
    } finally {
      if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView;
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('re-scrolls after display density changes without stealing focus', () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const { rerender } = render(<TimelineView entries={[entry]} {...props} />);
      const toggle = screen.getByRole('button', { name: 'Mark as done: Deep-linked task' });
      toggle.focus();

      rerender(
        <TimelineView
          entries={[entry]}
          {...props}
          preferences={{ ...props.preferences, density: 'compact' }}
        />,
      );

      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(toggle).toHaveFocus();
    } finally {
      if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView;
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });
});
