// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { parseDraft } from './capture';
import type { EntryType, ParsedDraft } from './types';

describe('parseDraft', () => {
  it('adapts the canonical capture parser for the composer preview', () => {
    expect(parseDraft('. Reply to Mira #Work @4pm >tomorrow', 'note')).toEqual({
      type: 'task',
      text: 'Reply to Mira',
      time: '16:00',
      tags: ['work'],
      dateShift: 'tomorrow',
      signifierWon: true,
      error: null,
    });
  });

  it('surfaces invalid tags instead of submitting altered text', () => {
    expect(parseDraft('Read #deep_work', 'task').error).toMatch(/underscore/i);
  });
});

describe('Composer', () => {
  it('renders live facts and submits the parsed draft', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(parsed: ParsedDraft) => void>();
    function Harness() {
      const [draft, setDraft] = useState('');
      const [type, setType] = useState<EntryType>('task');
      return (
        <Composer
          draft={draft}
          defaultType={type}
          onDraftChange={setDraft}
          onDefaultTypeChange={setType}
          onSubmit={onSubmit}
        />
      );
    }
    render(<Harness />);
    await user.type(screen.getByLabelText('Add an entry'), '- A useful detail #design @9:15');
    expect(screen.getAllByText('Note')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Entry type: Note' })).toBeInTheDocument();
    expect(screen.getByText('#design')).toBeInTheDocument();
    expect(screen.getByText('at 09:15')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add entry' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'note',
        text: 'A useful detail',
        tags: ['design'],
        time: '09:15',
      }),
    );
  });

  it('moves keyboard focus into the type menu', async () => {
    const user = userEvent.setup();
    render(
      <Composer
        draft=""
        defaultType="task"
        onDraftChange={vi.fn()}
        onDefaultTypeChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Entry type: Task' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('menuitemradio', { name: 'Task' })).toHaveFocus();
  });
});
