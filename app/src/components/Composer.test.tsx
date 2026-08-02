// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { TagUsage } from '@journal/server/contracts/app';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { parseDraft } from './capture';
import type { Destination } from './destination';
import type { EntryType, JournalCollection, ParsedDraft } from './types';
import type { JournalRoute } from '../routes/useJournalRoute';

const TODAY = '2026-07-31';

/** Copied from Icon.tsx, the way release-evidence pins the sparkle path. */
const CALENDAR_PATH =
  'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z';
const FOLDER_PATH =
  'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.9-1.3A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z';

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
  /** Spied rather than owned: it counts how many times a draft was rewritten. */
  onDraftChange?: (draft: string) => void;
  route?: JournalRoute;
  chipOverride?: Destination | null;
  initialDraft?: string;
  initialType?: EntryType;
}

/** The composer with App's state wired locally, so drafts round trip as they do live. */
function Harness({
  onSubmit = vi.fn(),
  onChipOverrideChange,
  onDraftChange,
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
      onDraftChange={(next) => {
        setDraft(next);
        onDraftChange?.(next);
      }}
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

/**
 * jsdom ships no `PointerEvent`, and fireEvent's fallback silently drops the
 * coordinates the row's slop guard reads. A MouseEvent wearing the two pointer
 * fields is what React hands the handler anyway — it reads the native event's
 * properties, not its constructor.
 */
const pointerEvent = (
  type: string,
  init: { pointerId: number; clientX: number; clientY: number },
): MouseEvent => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
  });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId },
    pointerType: { value: 'touch' },
  });
  return event;
};

const field = () => input() as HTMLTextAreaElement;

/** jsdom leaves the caret at 0 after a programmatic value set, so tests place it. */
const caretToEnd = async (user: ReturnType<typeof userEvent.setup>) => {
  const element = field();
  element.setSelectionRange(element.value.length, element.value.length);
  await user.click(element);
};

/**
 * jsdom lays nothing out, so the field's geometry is dictated here: 20px lines
 * with no padding or border, which puts the four-line cap at exactly 80px. The
 * effect only ever writes `height`, so these survive it.
 */
const stubFieldMetrics = (scrollHeight: () => number) => {
  const element = field();
  element.setAttribute(
    'style',
    'line-height: 20px; padding-top: 0px; padding-bottom: 0px; border-top-width: 0px; border-bottom-width: 0px;',
  );
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: scrollHeight });
  return element;
};

afterEach(cleanup);
afterEach(() => {
  vi.useRealTimers();
});

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
      dateShift: { kind: 'tomorrow' },
      signifierWon: true,
      error: null,
    });
  });

  it('surfaces invalid tags instead of submitting altered text', () => {
    expect(parseDraft('Read #deep_work', 'task').error).toMatch(/underscore/i);
  });
});

describe('Composer', () => {
  it('keeps an untouched capture to one row and discloses context on focus', async () => {
    const { container } = render(<Harness />);
    const shell = container.querySelector('.composer-shell');

    expect(shell).toHaveAttribute('data-expanded', 'false');
    expect(screen.getByLabelText('Add an entry')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add entry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Destination: Today' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Entry type: Task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Capture help' })).not.toBeInTheDocument();

    fireEvent.focus(input());
    expect(shell).toHaveAttribute('data-expanded', 'true');
    expect(await screen.findByRole('button', { name: 'Destination: Today' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Entry type: Task' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Capture help' })).toBeInTheDocument();
  });

  it('lets an outside click finish before collapsing the expanded composer', async () => {
    const user = userEvent.setup();
    const onOutsideClick = vi.fn();
    const { container } = render(
      <>
        <Harness />
        <button type="button" onClick={onOutsideClick}>
          Open another surface
        </button>
      </>,
    );

    await user.click(input());
    expect(container.querySelector('.composer-shell')).toHaveAttribute('data-expanded', 'true');

    await user.click(screen.getByRole('button', { name: 'Open another surface' }));

    expect(onOutsideClick).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.composer-shell')).toHaveAttribute('data-expanded', 'false');
  });

  it('previews inferred grammar from a restored draft before focus', () => {
    const { container } = render(<Harness initialDraft="- Standup #work @9:15" />);
    expect(container.querySelector('.composer-shell')).toHaveAttribute('data-expanded', 'true');
    expect(screen.getByRole('button', { name: /^Entry type: Note/ })).toBeInTheDocument();
    expect(screen.getByText('at 09:15')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove tag #work' })).toBeInTheDocument();
  });

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
    await user.click(input());
    const trigger = screen.getByRole('button', { name: 'Entry type: Task' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('menuitemradio', { name: 'Task' })).toHaveFocus();
  });

  it('picks a type from its signifier key while the menu is open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(input());
    const trigger = screen.getByRole('button', { name: 'Entry type: Task' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('~');
    expect(screen.getByRole('button', { name: 'Entry type: Mood' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument();
  });

  it('takes back the time the draft carries without dropping the keyboard', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Standup @9:15');
    expect(screen.getByText('at 09:15')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove time at 09:15' }));
    expect(input()).toHaveValue('Standup');
    // The chip is a pointer surface on the composer, so the caret comes back to
    // the field it edited — on iOS that is the difference between a keyboard
    // that stays up and one that collapses the sheet.
    expect(input()).toHaveFocus();
    expect(screen.queryByText(/^at /)).not.toBeInTheDocument();
  });

  it('strips every occurrence of the tag behind one chip', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Ship it #work and #work again');
    // The parser dedupes, so two typed tokens still show one chip to dismiss.
    expect(screen.getAllByRole('button', { name: 'Remove tag #work' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Remove tag #work' }));
    expect(input()).toHaveValue('Ship it and again');
    expect(input()).toHaveFocus();
  });

  it('lands the caret at the end of the shortened draft, opening no panel', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Ship it #design plan');
    await caretToEnd(user);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove tag #design' }));
    expect(input()).toHaveValue('Ship it plan');
    expect(input()).toHaveFocus();
    // The removal reconciles the caret through the same path an accepted
    // completion uses, so the suggestion machinery reads an offset the input
    // actually has — and nothing pops open behind the owner's back.
    expect(field().selectionStart).toBe('Ship it plan'.length);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('leaves the type chip inert — it restates the control, it cannot be dismissed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), '- A useful detail');
    const typeChip = screen
      .getAllByText('Note')
      .find((node) => node.classList.contains('parse-chip'));
    expect(typeChip?.tagName).toBe('SPAN');
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
  });

  it('answers to the words it shows: every removable chip names its own label', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Standup @9:15 #work');
    const chips = screen.getAllByRole('button', { name: /^Remove/ });
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      // The chip's ink lives on a span inside the button, so its visible text is
      // one level down from the element carrying the name. WCAG 2.5.3 asks that
      // the two still agree: "remove work" has to reach the tag chip.
      const visible = chip.textContent?.trim() ?? '';
      expect(visible).not.toBe('');
      expect(chip.getAttribute('aria-label')).toContain(visible);
    }
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

describe('Composer field', () => {
  it('files on Enter and writes no newline into the single-line draft', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(parsed: ParsedDraft) => void>();
    render(<Harness onSubmit={onSubmit} />);
    await user.type(input(), 'Water the plants');
    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0].text).toBe('Water the plants');
    // The harness keeps the draft (App clears it), so the field still shows
    // exactly what Enter filed — the key's own default never reached it.
    expect(field().value).toBe('Water the plants');
  });

  it('files on Shift+Enter too: there is no second line to reach for', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(parsed: ParsedDraft) => void>();
    render(<Harness onSubmit={onSubmit} />);
    await user.type(input(), 'Water the plants');
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(field().value).toBe('Water the plants');
  });

  it('turns pasted line breaks into spaces before they reach the draft', async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn<(draft: string) => void>();
    render(<Harness onDraftChange={onDraftChange} />);
    await user.click(input());
    await user.paste('Call Mira\nabout the deck\nbefore Friday');

    expect(field().value).toBe('Call Mira about the deck before Friday');
    expect(onDraftChange).toHaveBeenLastCalledWith('Call Mira about the deck before Friday');
    // The caret is mapped through the same collapse, so typing carries on where
    // the paste ended rather than at the top of the draft.
    expect(field().selectionStart).toBe('Call Mira about the deck before Friday'.length);

    // A value arriving whole — a drop, or dictation — takes the same path, and
    // one run of breaks is one space: a CRLF is not two. (user-event normalizes
    // `\r\n` to `\n` on paste, so only a raw change event can say this.)
    fireEvent.change(field(), { target: { value: 'One\r\n\nTwo' } });
    expect(field().value).toBe('One Two');
  });

  it('restores the field when the sanitized draft is the one React already holds', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'a b');

    // Replacing the space with a break sanitizes straight back to the current
    // draft, so nothing re-renders: the value has to come back through React's
    // own controlled restore, and the caret has to be placed without arming a
    // ref that some later, unrelated edit would consume.
    fireEvent.change(field(), { target: { value: 'a\nb' } });
    expect(field().value).toBe('a b');
    await Promise.resolve();
    expect(field().selectionStart).toBe('a b'.length);

    await user.type(field(), 'c');
    expect(field().value).toBe('a bc');
  });

  it('grows with the wrapped draft and scrolls inside itself at four lines', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    let scrollHeight = 20;
    const element = stubFieldMetrics(() => scrollHeight);

    await user.type(input(), 'a');
    expect(element.style.height).toBe('20px');
    expect(element.className).toContain('overflow-hidden');

    scrollHeight = 60;
    await user.type(input(), 'b');
    expect(element.style.height).toBe('60px');
    expect(element.className).toContain('overflow-hidden');

    // Past the cap the field stops growing and takes the scroll itself, so a
    // long capture can never push the day list off the screen.
    scrollHeight = 240;
    await user.type(input(), 'c');
    expect(element.style.height).toBe('80px');
    expect(element.className).toContain('overflow-y-auto');
    expect(element.className).not.toContain('overflow-hidden');

    scrollHeight = 40;
    await user.type(input(), 'd');
    expect(element.style.height).toBe('40px');
    expect(element.className).toContain('overflow-hidden');
  });
});

describe('Composer destination chip', () => {
  it('names the screen default without offering to clear it', () => {
    render(<Harness />);
    fireEvent.focus(input());
    expect(screen.getByRole('button', { name: 'Destination: Today' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear destination' })).not.toBeInTheDocument();
  });

  it('follows the viewed day when a past date is open', () => {
    render(<Harness route={{ name: 'today', date: '2026-07-12' }} />);
    fireEvent.focus(input());
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

  it('dates a weekday shift by its next occurrence and clears that token', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // TODAY is a Friday, so `>friday` is the Friday after it.
    await user.type(input(), 'Call the bank >friday');
    expect(screen.getByRole('button', { name: /^Destination: Aug 7/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear destination' }));
    expect(input()).toHaveValue('Call the bank');
    expect(screen.getByRole('button', { name: 'Destination: Today' })).toBeInTheDocument();
  });

  it('lets `>today` pull a capture off the backdated day being viewed', async () => {
    const user = userEvent.setup();
    render(<Harness route={{ name: 'today', date: '2026-07-12' }} />);
    await user.type(input(), 'Call the bank >today');
    expect(screen.getByRole('button', { name: 'Destination: Today' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear destination' }));
    expect(input()).toHaveValue('Call the bank');
    expect(screen.getByRole('button', { name: /^Destination: Jul 12/ })).toBeInTheDocument();
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
    await user.click(input());
    await user.click(screen.getByRole('button', { name: 'Destination: Today' }));
    await user.click(await screen.findByRole('button', { name: /^Reading/ }));
    expect(onChipOverrideChange).toHaveBeenCalledWith({ kind: 'collection', id: 'reading' });

    await user.click(screen.getByRole('button', { name: 'Destination: Reading' }));
    await user.click(await screen.findByRole('button', { name: /^Daily log — Today/ }));
    expect(onChipOverrideChange).toHaveBeenLastCalledWith(null);
  });

  it('warns that Activity captures land in the daily log', async () => {
    const user = userEvent.setup();
    render(<Harness route={{ name: 'activity' }} />);
    await user.click(input());
    await user.click(screen.getByRole('button', { name: 'Destination: Today' }));
    expect(await screen.findByText(/Activity is an audit screen/)).toBeInTheDocument();
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
    // The accept consumed the key outright: no filing, and no newline either.
    expect(field().value).toBe('Ship it #design ');
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

  it('accepts a tapped row on pointerup, and inserts it exactly once', async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn<(draft: string) => void>();
    render(<Harness onDraftChange={onDraftChange} />);
    await user.type(input(), 'Finish it /read');
    await caretToEnd(user);
    const option = await screen.findByRole('option', { name: /Reading/ });
    onDraftChange.mockClear();

    // The sequence an iPhone produces, up to the click it may never synthesize:
    // the insert has to have landed before that click is even considered.
    fireEvent(option, pointerEvent('pointerdown', { pointerId: 4, clientX: 40, clientY: 120 }));
    fireEvent(option, pointerEvent('pointerup', { pointerId: 4, clientX: 43, clientY: 122 }));
    expect(input()).toHaveValue('Finish it /reading ');
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(input()).toHaveFocus();

    // And when the click does arrive, it counts the press it repeats, so the
    // row knows it for the duplicate it is — one tap, one insert.
    fireEvent.click(option, { detail: 1 });
    expect(input()).toHaveValue('Finish it /reading ');
    expect(onDraftChange).toHaveBeenCalledTimes(1);
  });

  it('accepts a click with no press behind it, the way assistive tech sends one', async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn<(draft: string) => void>();
    render(<Harness onDraftChange={onDraftChange} />);
    await user.type(input(), 'Finish it /read');
    await caretToEnd(user);
    const option = await screen.findByRole('option', { name: /Reading/ });
    onDraftChange.mockClear();

    // A VoiceOver double-tap activates the row without any pointer sequence,
    // and `detail: 0` is how that click says so.
    fireEvent.click(option, { detail: 0 });

    expect(input()).toHaveValue('Finish it /reading ');
    expect(onDraftChange).toHaveBeenCalledTimes(1);
  });

  it('reads a finger that travelled as a scroll, not as a choice', async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn<(draft: string) => void>();
    render(<Harness onDraftChange={onDraftChange} />);
    await user.type(input(), 'Finish it /read');
    await caretToEnd(user);
    const option = await screen.findByRole('option', { name: /Reading/ });
    onDraftChange.mockClear();

    fireEvent(option, pointerEvent('pointerdown', { pointerId: 4, clientX: 40, clientY: 120 }));
    fireEvent(option, pointerEvent('pointerup', { pointerId: 4, clientX: 40, clientY: 138 }));
    // The drag's own click must not slip past the guard the pointerup applied.
    fireEvent.click(option, { detail: 1 });

    expect(onDraftChange).not.toHaveBeenCalled();
    expect(input()).toHaveValue('Finish it /read');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('never churns the popup wiring on the focused input', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // The listbox is in the DOM from the first paint, merely hidden, so the
    // input can name it permanently instead of pointing at nothing.
    const controls = input().getAttribute('aria-controls');
    expect(controls).toBe(screen.getByRole('listbox', { hidden: true }).id);
    expect(input()).not.toHaveAttribute('aria-activedescendant');

    await user.type(input(), 'Ship it #des');
    await caretToEnd(user);
    const listbox = await screen.findByRole('listbox');
    expect(input()).toHaveAttribute('aria-controls', controls);
    // Opening the panel is `aria-expanded` and nothing else: an
    // activedescendant nobody has navigated to is churn with no news in it.
    expect(input()).not.toHaveAttribute('aria-activedescendant');

    await user.keyboard('{ArrowDown}');
    const options = within(listbox).getAllByRole('option');
    expect(input()).toHaveAttribute('aria-activedescendant', options[1]?.id);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input()).toHaveAttribute('aria-controls', controls);
    expect(input()).not.toHaveAttribute('aria-activedescendant');
  });

  it('accepts row 0 with Enter although nothing was ever navigated', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Ship it #des');
    await caretToEnd(user);
    const listbox = await screen.findByRole('listbox');
    // The highlight is `activeIndex`, which defaults to row 0 with or without
    // an activedescendant to announce it.
    expect(within(listbox).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    expect(input()).not.toHaveAttribute('aria-activedescendant');

    await user.keyboard('{Enter}');
    expect(input()).toHaveValue('Ship it #design ');
  });

  it('samples the `@` clock once per panel session, not once per render', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 6, 31, 9, 59));
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Standup @');
    await caretToEnd(user);

    const listbox = screen.getByRole('listbox');
    const before = within(listbox)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(before[4]).toMatch(/^@10:00/);

    // The hour turns while the panel is up and the draft keeps moving. The rows
    // must not renumber under a finger already reaching for one of them.
    vi.setSystemTime(new Date(2026, 6, 31, 10, 59));
    await user.keyboard('1{Backspace}');

    expect(
      within(listbox)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(before);
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
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(6);
    // Tomorrow keeps row 0: `>` then Enter is the migration the hands know.
    expect(options[0]).toHaveTextContent(/^Tomorrow/);
    // The rest of the grammar is now offered rather than only documented.
    expect(within(listbox).getByRole('option', { name: /Next week/ })).toBeInTheDocument();
    // TODAY is a Friday, so the days behind tomorrow start on the Sunday.
    expect(within(listbox).getByRole('option', { name: /Sunday/ })).toBeInTheDocument();
    // The caption teaches what the sigil does; the rows alone cannot.
    expect(screen.getByText(/Files this capture into the chosen day/i)).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(input()).toHaveValue('Call the bank >tomorrow ');
    expect(screen.getByRole('button', { name: 'Destination: Tomorrow' })).toBeInTheDocument();
  });

  it('completes a weekday from the `>` panel into the day it names', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Call the bank >');
    await caretToEnd(user);
    await user.click(await screen.findByRole('option', { name: /^Monday/ }));

    expect(input()).toHaveValue('Call the bank >monday ');
    // Monday after Friday 2026-07-31 is 2026-08-03.
    expect(screen.getByRole('button', { name: /^Destination: Aug 3/ })).toBeInTheDocument();
  });

  it('names the times of day for `@` and teaches the other time formats', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'Standup @');
    await caretToEnd(user);

    const listbox = await screen.findByRole('listbox', { name: 'Capture suggestions' });
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(6);
    // Named times lead whatever the wall clock says; round hours fill behind them.
    expect(options[0]).toHaveTextContent(/^Morning/);
    expect(options[3]).toHaveTextContent(/^Evening/);
    for (const option of options.slice(4)) expect(option).toHaveTextContent(/^@\d{2}:00/);
    expect(screen.getByText(/@4pm/)).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(input()).toHaveValue('Standup @09:00 ');
    expect(screen.getByText('at 09:00')).toBeInTheDocument();
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
  it('keeps destination and grammar out of the idle row, then leads with destination', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Destination: Today' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Capture help' })).not.toBeInTheDocument();
    fireEvent.focus(input());
    expect(screen.getByRole('button', { name: 'Destination: Today' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Capture help' })).toBeInTheDocument();
    expect(screen.queryByText(/^Shortcuts:/)).not.toBeInTheDocument();
  });

  it('shows the destination name in full, led by the icon for its kind', () => {
    render(<Harness chipOverride={{ kind: 'collection', id: 'reading' }} />);
    const chip = screen.getByRole('button', { name: 'Destination: Reading' });
    // The kind mark is a separate, decorative element so a long name can never
    // truncate it away and leave the chip reading as a bare `…`.
    expect(chip).toHaveTextContent('Reading');
    const lead = chip.querySelector('svg');
    expect(lead).toHaveAttribute('aria-hidden', 'true');
    // A collection is a folder; a day is a calendar. Never the same mark.
    expect(lead?.querySelector('path')).toHaveAttribute('d', FOLDER_PATH);

    cleanup();
    render(<Harness />);
    fireEvent.focus(input());
    const today = screen.getByRole('button', { name: 'Destination: Today' });
    expect(today.querySelector('path')).toHaveAttribute('d', CALENDAR_PATH);
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
