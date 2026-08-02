// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTouch } from '../api/types';
import { EntryRow } from './EntryRow';
import type { JournalEntry } from './types';

const entry: JournalEntry = {
  id: '01J00000000000000000000000',
  date: '2026-07-31',
  type: 'task',
  text: 'Reply to Mira',
  state: 'open',
  time: null,
  tags: ['work'],
  author: 'me',
  source: null,
  migrations: 0,
  collection: null,
  createdAt: '2026-07-31T09:00:00.000Z',
  updatedAt: '2026-07-31T09:00:00.000Z',
  revision: 1,
  deletedAt: null,
};

function setPreviewMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight });
  fireEvent(window, new Event('resize'));
}

function dispatchPointer(target: Element, type: string, x: number, y: number): void {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  fireEvent(target, event);
}

afterEach(cleanup);

describe('EntryRow', () => {
  it('keeps checkbox and detail interactions distinct and keyboard accessible', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    render(
      <EntryRow
        entry={entry}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        onToggle={onToggle}
        onOpen={onOpen}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Mark as done: Reply to Mira' }));
    expect(onToggle).toHaveBeenCalledWith(entry);
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^Reply to Mira/ }));
    expect(onOpen).toHaveBeenCalledWith(entry);
  });

  it('opens terminal tasks instead of offering an illegal toggle', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    const migrated = { ...entry, state: 'migrated' as const, migrations: 2 };
    const { container } = render(
      <EntryRow
        entry={migrated}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        onToggle={onToggle}
        onOpen={onOpen}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Open task: Reply to Mira' }));
    expect(onOpen).toHaveBeenCalledWith(migrated);
    expect(onToggle).not.toHaveBeenCalled();
    expect(container.querySelector('.entry-row')).not.toHaveClass('entry-row--struck');
  });

  it('dims both tombstone states, and neither is struck through', () => {
    for (const state of ['migrated', 'scheduled'] as const) {
      const { container } = render(
        <EntryRow
          entry={{ ...entry, state, migrations: 1 }}
          preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
          onToggle={vi.fn()}
          onOpen={vi.fn()}
        />,
      );
      const row = container.querySelector('.entry-row');
      expect(row, state).toHaveClass('entry-row--dimmed');
      expect(row, state).not.toHaveClass('entry-row--struck');
      cleanup();
    }
  });

  it('offers an explicit disclosure only when canonical text exceeds two lines', async () => {
    const user = userEvent.setup();
    const longText =
      'Review the complete garden plan before ordering soil, timber, irrigation parts, and the remaining native plants.';
    const { container } = render(
      <EntryRow
        entry={{ ...entry, text: longText }}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    const preview = screen.getByText(longText, { exact: true });

    setPreviewMetrics(preview, 60, 40);
    const expand = screen.getByRole('button', { name: /^Expand entry preview:/ });
    expect(expand).toHaveAttribute('aria-controls', preview.id);
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(preview).toHaveClass('line-clamp-2');
    expect(preview).toHaveTextContent(longText);
    expect(container.querySelector('.entry-row__content .entry-row__expand')).toBeNull();

    await user.click(expand);
    expect(screen.getByRole('button', { name: /^Collapse entry preview:/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(preview).not.toHaveClass('line-clamp-2');

    await user.click(screen.getByRole('button', { name: /^Collapse entry preview:/ }));
    expect(screen.getByRole('button', { name: /^Expand entry preview:/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    setPreviewMetrics(preview, 40, 40);
    expect(screen.queryByRole('button', { name: /entry preview/ })).not.toBeInTheDocument();
  });

  it('preserves multiline, Unicode, and long unbroken content across the preview', async () => {
    const user = userEvent.setup();
    const multiline =
      'Zażółć gęślą jaźń 🌱\nhttps://example.test/a/very/long/unbroken/path/that/must/wrap\n月次レビュー';
    const { container } = render(
      <EntryRow
        entry={{ ...entry, text: multiline }}
        preferences={{ density: 'compact', showTypeBadges: false, highlightAiEntries: false }}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    const preview = container.querySelector<HTMLElement>('.entry-row__text');
    expect(preview).not.toBeNull();
    if (!preview) throw new Error('Entry preview did not render.');
    setPreviewMetrics(preview, 72, 36);

    expect(preview).toHaveClass('whitespace-pre-wrap', '[overflow-wrap:anywhere]');
    await user.click(screen.getByRole('button', { name: /^Expand entry preview:/ }));
    expect(preview.textContent).toBe(multiline);
    expect(preview).not.toHaveClass('line-clamp-2');
  });

  it('supports Enter and Space without triggering the entry detail action', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const longText =
      'A long entry that needs a stable keyboard-operated progressive preview control.';
    render(
      <EntryRow
        entry={{ ...entry, text: longText }}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        onToggle={vi.fn()}
        onOpen={onOpen}
      />,
    );
    const preview = screen.getByText(longText, { exact: true });
    setPreviewMetrics(preview, 60, 40);

    const expand = screen.getByRole('button', { name: /^Expand entry preview:/ });
    expand.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: /^Collapse entry preview:/ })).toHaveFocus();
    expect(onOpen).not.toHaveBeenCalled();

    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: /^Expand entry preview:/ })).toHaveFocus();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('keeps text selectable without treating a pointer selection as detail activation', () => {
    const onOpen = vi.fn();
    render(
      <EntryRow
        entry={entry}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        onToggle={vi.fn()}
        onOpen={onOpen}
      />,
    );
    const content = screen.getByRole('button', { name: 'Reply to Mira' });
    const preview = screen.getByText('Reply to Mira', { exact: true });
    const range = document.createRange();
    range.selectNodeContents(preview);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    dispatchPointer(content, 'pointerdown', 10, 10);
    dispatchPointer(content, 'pointermove', 24, 10);
    fireEvent.click(content, { detail: 1 });
    expect(onOpen).not.toHaveBeenCalled();

    // WebKit can leave a Range selection behind after an ordinary tap. With no
    // drag in this gesture, that stale selection must not swallow activation.
    dispatchPointer(content, 'pointerdown', 10, 10);
    fireEvent.click(content, { detail: 1 });
    expect(onOpen).toHaveBeenCalledWith(entry);

    fireEvent.click(content, { detail: 0 });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('shows a Timeline destination without changing the canonical text', () => {
    render(
      <EntryRow
        entry={{ ...entry, collection: 'projects' }}
        destinationLabel="Projects"
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText('Reply to Mira')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toHaveClass('entry-row__destination');
  });

  it('shows only the compact latest meaningful agent touch', () => {
    const agentTouch: AgentTouch = {
      activityId: '01J00000000000000000000003',
      entryId: entry.id,
      at: '2026-07-31T10:00:00.000Z',
      actor: { kind: 'agent', label: 'Mira', tool: 'update_entry' },
      action: 'updated',
      reason: 'Clarified the next action.',
    };
    render(
      <EntryRow
        entry={entry}
        agentTouch={agentTouch}
        preferences={{ density: 'comfortable', showTypeBadges: false, highlightAiEntries: false }}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    const touch = screen
      .getByText('Mira updated · Clarified the next action.', { exact: true })
      .closest('.entry-row__agent-touch');
    expect(touch).toHaveTextContent(
      'Latest agent change: Mira updated · Clarified the next action.',
    );
    expect(touch).not.toHaveAttribute('aria-label');
  });
});
