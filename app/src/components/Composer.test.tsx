// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { TagUsage } from '@journal/server/contracts/app';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { parseDraft } from './capture';
import type { Destination } from './destination';
import type { EntryType, JournalCollection, ParsedDraft } from './types';
import type { JournalRoute } from '../routes/useJournalRoute';

const TODAY = '2026-07-31';

const collection = (id: string, name: string): JournalCollection => ({
  id,
  name,
  note: null,
  createdAt: '2026-07-01T08:00:00.000Z',
  archivedAt: null,
});

const READING = collection('reading', 'Reading');
const COLLECTIONS = { reading: READING, 'month:2026-07': collection('month:2026-07', 'July 2026') };

const TAGS: TagUsage[] = [
  { tag: 'design', uses: 9, lastUsedAt: '2026-07-30T08:00:00.000Z' },
  { tag: 'design-review', uses: 2, lastUsedAt: '2026-07-29T08:00:00.000Z' },
  { tag: 'work', uses: 4, lastUsedAt: '2026-07-28T08:00:00.000Z' },
];

interface HarnessProps {
  onSubmit?: (parsed: ParsedDraft) => void;
  onChipOverrideChange?: (destination: Destination | null) => void;
  route?: JournalRoute;
  chipOverride?: Destination | null;
  initialDraft?: string;
  initialType?: EntryType;
}

/** The composer with App's state wired locally, so drafts round trip as they do live. */
function Harness({
  onSubmit = vi.fn(),
  onChipOverrideChange,
  route = { name: 'today', date: null },
  chipOverride = null,
  initialDraft = '',
  initialType = 'task',
}: HarnessProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [type, setType] = useState<EntryType>(initialType);
  const [override, setOverride] = useState<Destination | null>(chipOverride);
  return (
    <Composer
      draft={draft}
      defaultType={type}
      onDraftChange={setDraft}
      onDefaultTypeChange={setType}
      onSubmit={onSubmit}
      route={route}
      today={TODAY}
      collectionsById={COLLECTIONS}
      collections={[READING]}
      tagSuggestions={TAGS}
      chipOverride={override}
      onChipOverrideChange={(next) => {
        setOverride(next);
        onChipOverrideChange?.(next);
      }}
    />
  );
}

const input = () => screen.getByLabelText('Add an entry');

/** jsdom leaves the caret at 0 after a programmatic value set, so tests place it. */
const caretToEnd = async (user: ReturnType<typeof userEvent.setup>) => {
  const element = input() as HTMLInputElement;
  element.setSelectionRange(element.value.length, element.value.length);
  await user.click(element);
};

afterEach(cleanup);

beforeAll(() => {
  // Radix's popper measures with ResizeObserver, which jsdom does not ship.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe('parseDraft', () => {
  it('adapts the canonical capture parser for the composer preview', () => {
    expect(parseDraft('. Reply to Mira #Work @4pm >tomorrow', 'note')).toEqual({
      type: 'task',
      text: 'Reply to Mira',
      time: '16:00',
      tags: ['work'],
      collection: null,
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
    render(<Harness onSubmit={onSubmit} />);
    await user.type(input(), '- A useful detail #design @9:15');
    expect(screen.getAllByText('Note')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /^Entry type: Note/ })).toBeInTheDocument();
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
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Entry type: Task' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('menuitemradio', { name: 'Task' })).toHaveFocus();
  });

  it('picks a type from its signifier key while the menu is open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Entry type: Task' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('~');
    expect(screen.getByRole('button', { name: 'Entry type: Mood' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument();
  });

  it('explains a type the leading signifier already decided', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'o Standup');
    const trigger = screen.getByRole('button', { name: /^Entry type: Event/ });
    expect(trigger).toHaveAccessibleName(/remove it to choose/);
    expect(trigger).toHaveAttribute('title', expect.stringContaining("leading 'o'"));
  });
});

describe('Composer destination chip', () => {
  it('names the screen default without offering to clear it', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Destination: Today' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear destination' })).not.toBeInTheDocument();
  });

  it('follows the viewed day when a past date is open', () => {
    render(<Harness route={{ name: 'today', date: '2026-07-12' }} />);
    expect(screen.getByRole('button', { name: /^Destination: Jul 12/ })).toBeInTheDocument();
  });

  it('names the collection a `/slug` token targets and clears the token', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Finish chapter /reading');
    expect(screen.getByRole('button', { name: 'Destination: Reading' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear destination' }));
    expect(input()).toHaveValue('Finish chapter');
    expect(screen.getByRole('button', { name: 'Destination: Today' })).toBeInTheDocument();
  });

  it('names a `>tomorrow` capture and clears just that token', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Call the bank >tomorrow');
    expect(screen.getByRole('button', { name: 'Destination: Tomorrow' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear destination' }));
    expect(input()).toHaveValue('Call the bank');
  });

  it('flags a slug the mirror has never seen', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Plant bulbs /garden');
    const chip = screen.getByRole('button', { name: 'Destination: Garden' });
    expect(within(chip).getByText('New')).toBeInTheDocument();
  });

  it('drops a picked override back to the screen default', async () => {
    const user = userEvent.setup();
    const onChipOverrideChange = vi.fn<(destination: Destination | null) => void>();
    render(
      <Harness
        chipOverride={{ kind: 'collection', id: 'reading' }}
        onChipOverrideChange={onChipOverrideChange}
      />,
    );
    expect(screen.getByRole('button', { name: 'Destination: Reading' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear destination' }));
    expect(onChipOverrideChange).toHaveBeenCalledWith(null);
    expect(screen.getByRole('button', { name: 'Destination: Today' })).toBeInTheDocument();
  });

  it('lets a typed token outrank the picked chip', async () => {
    const user = userEvent.setup();
    render(<Harness chipOverride={{ kind: 'collection', id: 'reading' }} />);
    await user.type(input(), 'Note it /garden');
    expect(screen.getByRole('button', { name: 'Destination: Garden' })).toBeInTheDocument();
  });

  it('picks a destination from the picker and retires it when it matches the screen', async () => {
    const user = userEvent.setup();
    const onChipOverrideChange = vi.fn<(destination: Destination | null) => void>();
    render(<Harness onChipOverrideChange={onChipOverrideChange} />);
    await user.click(screen.getByRole('button', { name: 'Destination: Today' }));
    await user.click(await screen.findByRole('button', { name: /^Reading/ }));
    expect(onChipOverrideChange).toHaveBeenCalledWith({ kind: 'collection', id: 'reading' });

    await user.click(screen.getByRole('button', { name: 'Destination: Reading' }));
    await user.click(await screen.findByRole('button', { name: /^Daily log — Today/ }));
    expect(onChipOverrideChange).toHaveBeenLastCalledWith(null);
  });

  it('warns that review captures land in the daily log', async () => {
    const user = userEvent.setup();
    render(<Harness route={{ name: 'review' }} />);
    await user.click(screen.getByRole('button', { name: 'Destination: Today' }));
    expect(await screen.findByText(/Review is an audit screen/)).toBeInTheDocument();
  });
});

describe('Composer suggestions', () => {
  it('completes a tag with the keyboard and closes afterwards', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Ship it #des');
    await caretToEnd(user);

    const listbox = await screen.findByRole('listbox', { name: 'Capture suggestions' });
    expect(within(listbox).getAllByRole('option')).toHaveLength(2);
    expect(input()).toHaveAttribute('role', 'combobox');
    expect(input()).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{ArrowDown}');
    expect(within(listbox).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');

    expect(input()).toHaveValue('Ship it #design-review ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input()).toHaveAttribute('role', 'combobox');
    expect(input()).toHaveAttribute('aria-expanded', 'false');
  });

  it('never changes the role of the input, so the caret cannot be dropped', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const atRest = input().getAttribute('role');
    expect(atRest).toBe('combobox');

    await user.type(input(), 'Ship it #des');
    await caretToEnd(user);
    await screen.findByRole('listbox', { name: 'Capture suggestions' });
    expect(input().getAttribute('role')).toBe(atRest);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input().getAttribute('role')).toBe(atRest);
  });

  it('never files the entry with the Enter that accepted a completion', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(parsed: ParsedDraft) => void>();
    render(<Harness onSubmit={onSubmit} />);
    await user.type(input(), 'Ship it #des');
    await caretToEnd(user);
    await screen.findByRole('listbox');
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('files the entry on the very next Add-entry click after an Enter-accepted completion', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(parsed: ParsedDraft) => void>();
    render(<Harness onSubmit={onSubmit} />);
    await user.type(input(), 'Ship it #des');
    await caretToEnd(user);
    await screen.findByRole('listbox');
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    // The accept guard must disarm once its own Enter has passed — a single
    // click on Add entry files the draft, it is not silently swallowed.
    await user.click(screen.getByRole('button', { name: 'Add entry' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('completes a collection by click without blurring the input', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Finish it /read');
    await caretToEnd(user);
    await user.click(await screen.findByRole('option', { name: /Reading/ }));
    expect(input()).toHaveValue('Finish it /reading ');
    expect(input()).toHaveFocus();
  });

  it('inserts the slug behind a create row', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Plant bulbs /garden');
    await caretToEnd(user);
    await user.click(await screen.findByRole('option', { name: /Create collection/ }));
    expect(input()).toHaveValue('Plant bulbs /garden ');
  });

  it('stays shut for a URL and for the // escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Read https://example.com/reading');
    await caretToEnd(user);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('completes `>` into a date shift and moves the destination with it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Call the bank >');
    await caretToEnd(user);

    const listbox = await screen.findByRole('listbox', { name: 'Capture suggestions' });
    expect(within(listbox).getByRole('option', { name: /Tomorrow/ })).toBeInTheDocument();
    // The caption teaches what the sigil does; the row alone cannot.
    expect(screen.getByText(/Files this capture into tomorrow/i)).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(input()).toHaveValue('Call the bank >tomorrow ');
    expect(screen.getByRole('button', { name: 'Destination: Tomorrow' })).toBeInTheDocument();
  });

  it('offers upcoming round hours for `@` and teaches the other time formats', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Standup @');
    await caretToEnd(user);

    const listbox = await screen.findByRole('listbox', { name: 'Capture suggestions' });
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(3);
    for (const option of options) expect(option).toHaveTextContent(/^@\d{2}:00/);
    expect(screen.getByText(/@4pm/)).toBeInTheDocument();

    await user.keyboard('{Enter}');
    // Whichever hour led the list, the draft now carries a token the parser reads.
    expect((input() as HTMLInputElement).value).toMatch(/^Standup @\d{2}:00 $/);
    expect(screen.getByText(/^at \d{2}:00$/)).toBeInTheDocument();
  });

  it('leaves a handle alone instead of completing it as a time', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Ask @mira');
    await caretToEnd(user);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('keeps the listbox free of the non-option caption', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Call the bank >');
    await caretToEnd(user);
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).queryByText(/Files this capture/i)).not.toBeInTheDocument();
  });
});

describe('Composer capture bar', () => {
  it('leads with the destination and drops the legend that used to crowd it', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Destination: Today' })).toBeInTheDocument();
    expect(screen.queryByText(/^Shortcuts:/)).not.toBeInTheDocument();
  });

  it('shows the destination name in full rather than only its arrow', () => {
    render(<Harness chipOverride={{ kind: 'collection', id: 'reading' }} />);
    const chip = screen.getByRole('button', { name: 'Destination: Reading' });
    // The arrow is a separate, decorative element so a long name can never
    // truncate it away and leave the chip reading as a bare `→ …`.
    expect(chip).toHaveTextContent('Reading');
    expect(within(chip).getByText('→')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Composer escape ladder', () => {
  it('closes the suggestions panel, then the type menu, then the draft, then blurs', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Ship it #des');
    await caretToEnd(user);
    await screen.findByRole('listbox');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input()).toHaveValue('Ship it #des');

    await user.click(screen.getByRole('button', { name: /^Entry type:/ }));
    input().focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument();
    expect(input()).toHaveValue('Ship it #des');

    await user.keyboard('{Escape}');
    expect(input()).toHaveValue('');
    expect(input()).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(input()).not.toHaveFocus();
  });

  it('clears the draft from the inline clear button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Clear draft' })).not.toBeInTheDocument();
    await user.type(input(), 'A thought');
    await user.click(screen.getByRole('button', { name: 'Clear draft' }));
    expect(input()).toHaveValue('');
    expect(input()).toHaveFocus();
  });
});

describe('Composer focus requests', () => {
  it('takes focus when the preset nonce changes and not on mount', () => {
    const props = {
      draft: '',
      defaultType: 'task' as EntryType,
      onDraftChange: vi.fn(),
      onDefaultTypeChange: vi.fn(),
      onSubmit: vi.fn(),
      route: { name: 'today', date: null } as JournalRoute,
      today: TODAY,
      collectionsById: COLLECTIONS,
    };
    const view = render(<Composer {...props} />);
    expect(input()).not.toHaveFocus();
    view.rerender(<Composer {...props} focusRequest={1} />);
    expect(input()).toHaveFocus();
  });
});
