// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JournalEntry } from '../components/types';
import { TodayView } from './TodayView';

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
  preferences: { density: 'comfortable' as const, showTypeBadges: true, highlightAiEntries: true },
  onOpenEntry: vi.fn(),
  onToggleEntry: vi.fn(),
  onStartMigration: vi.fn(),
};

describe('TodayView', () => {
  it('creates a named empty section for a deep-linked calendar day', () => {
    const { container } = render(<TodayView entries={[]} {...props} />);
    const selected = container.querySelector('[data-day="2026-08-03"]');
    expect(selected).toBeInTheDocument();
    expect(selected).toHaveTextContent('No entries yet');
  });

  it('does not steal focus after the selected day receives an update', () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const { rerender } = render(<TodayView entries={[entry]} {...props} />);
      const toggle = screen.getByRole('button', { name: 'Mark as done: Deep-linked task' });
      toggle.focus();
      rerender(<TodayView entries={[{ ...entry, tags: ['updated'], revision: 2 }]} {...props} />);
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
        <TodayView entries={[historical]} {...props} selectedDate={historical.date} />,
      );
      const toggle = screen.getByRole('button', { name: 'Mark as done: Selected historical task' });
      toggle.focus();

      rerender(
        <TodayView
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
      const { rerender } = render(<TodayView entries={[newer, entry, oldClosed]} {...props} />);
      const toggle = screen.getByRole('button', { name: 'Mark as done: Deep-linked task' });
      toggle.focus();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      rerender(
        <TodayView
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
      const { rerender } = render(<TodayView entries={[entry]} {...props} />);
      const toggle = screen.getByRole('button', { name: 'Mark as done: Deep-linked task' });
      toggle.focus();

      rerender(
        <TodayView
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
