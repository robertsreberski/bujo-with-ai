// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import type { Collection, Entry } from './api/types';
import type * as JournalStoreModule from './store/journal-store';
import { journalActions, useJournalStore } from './store/journal-store';

/*
 * The mirror and the router are real — this is about what a capture does to the
 * screen it was typed on. Only the outbound edges are stubbed: `initialize`
 * would open a socket, and `createEntry`/`createCollection` are asserted rather
 * than executed.
 */
vi.mock('./store/journal-store', async (importOriginal) => {
  const actual = await importOriginal<typeof JournalStoreModule>();
  return {
    ...actual,
    journalActions: {
      ...actual.journalActions,
      initialize: vi.fn(() => Promise.resolve()),
      shutdown: vi.fn(),
      refreshTokens: vi.fn(() => Promise.resolve()),
      loadTagSuggestions: vi.fn(),
      createEntry: vi.fn(() => Promise.resolve({} as Entry)),
      createCollection: vi.fn(() => Promise.resolve({} as Collection)),
    },
  };
});

const TODAY = '2026-07-31';

const reading: Collection = {
  id: 'reading',
  name: 'Reading',
  note: null,
  createdAt: '2026-07-01T08:00:00.000Z',
  archivedAt: null,
};

const createEntry = vi.mocked(journalActions.createEntry);
const createCollection = vi.mocked(journalActions.createCollection);

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
  useJournalStore.setState({
    hydrated: true,
    loading: false,
    online: false,
    connectionStatus: 'offline',
    today: TODAY,
    serverToday: TODAY,
    draft: '',
    defaultType: 'task',
    entriesById: {},
    collectionsById: { reading },
    notices: [],
    composerPreset: null,
  });
});

afterEach(cleanup);

const goTo = async (user: ReturnType<typeof userEvent.setup>, view: string) => {
  await user.click(screen.getAllByRole('button', { name: view })[0] as HTMLElement);
};

const capture = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  await user.type(screen.getByLabelText('Add an entry'), text);
  await user.click(screen.getByRole('button', { name: 'Add entry' }));
};

describe('App capture', () => {
  it('stays on the screen the capture was typed on', async () => {
    const user = userEvent.setup();
    render(<App />);
    await goTo(user, 'Index');
    expect(window.location.pathname).toBe('/index');

    await capture(user, 'Buy stamps');
    await screen.findByText('Added to Today');
    expect(window.location.pathname).toBe('/index');
  });

  it('offers a View action only when the entry landed off-screen', async () => {
    const user = userEvent.setup();
    render(<App />);
    await goTo(user, 'Index');
    await capture(user, 'Buy stamps');

    const view = await screen.findByRole('button', { name: 'View' });
    await user.click(view);
    expect(window.location.pathname).toBe('/');
  });

  it('leaves the toast bare when the capture is already in sight', async () => {
    const user = userEvent.setup();
    render(<App />);
    await capture(user, 'Buy stamps');
    await screen.findByText('Added to Today');
    expect(screen.queryByRole('button', { name: 'View' })).not.toBeInTheDocument();
  });

  it('names the collection a `/slug` token filed into and offers to open it', async () => {
    const user = userEvent.setup();
    render(<App />);
    await capture(user, 'Finish chapter /reading');
    await screen.findByText('Added to Reading');
    expect(createEntry).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Finish chapter', collection: 'reading' }),
    );

    await user.click(screen.getByRole('button', { name: 'View' }));
    expect(window.location.pathname).toBe('/c/reading');
  });

  it('mints a never-seen collection before filing into it', async () => {
    const user = userEvent.setup();
    render(<App />);
    await capture(user, 'Plant bulbs /garden');
    await screen.findByText('Added to Garden');
    expect(createCollection).toHaveBeenCalledWith({
      id: 'garden',
      name: 'Garden',
      note: null,
    });
    expect(createEntry).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'garden', text: 'Plant bulbs' }),
    );
  });

  it('sends today as neither a date nor a shift', async () => {
    const user = userEvent.setup();
    render(<App />);
    await capture(user, 'Buy stamps');
    await waitFor(() => expect(createEntry).toHaveBeenCalledTimes(1));
    const input = createEntry.mock.calls[0]?.[0];
    expect(input).toMatchObject({ collection: null, text: 'Buy stamps' });
    expect(input).not.toHaveProperty('date');
    expect(input).not.toHaveProperty('dateShift');
  });

  it('keeps `>tomorrow` on the shift intent', async () => {
    const user = userEvent.setup();
    render(<App />);
    await capture(user, 'Call the bank >tomorrow');
    await screen.findByText('Added to Tomorrow');
    expect(createEntry).toHaveBeenCalledWith(
      expect.objectContaining({ dateShift: 'tomorrow', collection: null }),
    );
  });

  it('sends a `>friday` capture as the absolute day it resolves to', async () => {
    const user = userEvent.setup();
    render(<App />);
    // TODAY is a Friday, so the weekday token means the Friday after it.
    await capture(user, 'Call the bank >friday');
    await screen.findByText('Added to Aug 7');
    expect(createEntry).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-08-07', collection: null }),
    );
  });

  it('clears the draft but leaves the composer ready for the next capture', async () => {
    const user = userEvent.setup();
    render(<App />);
    await capture(user, 'Buy stamps');
    await waitFor(() => expect(screen.getByLabelText('Add an entry')).toHaveValue(''));
    expect(screen.getByLabelText('Add an entry')).toHaveFocus();
  });
});

describe('App composer presets', () => {
  it('takes a destination from a view and pins it as this screen’s chip', async () => {
    render(<App />);
    expect(screen.getByRole('button', { name: 'Destination: Today' })).toBeInTheDocument();

    journalActions.focusComposer({ kind: 'collection', id: 'reading' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Destination: Reading' })).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Add an entry')).toHaveFocus();
  });

  it('drops the pinned chip when the owner navigates away', async () => {
    const user = userEvent.setup();
    render(<App />);
    journalActions.focusComposer({ kind: 'collection', id: 'reading' });
    await screen.findByRole('button', { name: 'Destination: Reading' });

    await goTo(user, 'Index');
    expect(screen.getByRole('button', { name: 'Destination: Today' })).toBeInTheDocument();
  });

  it('files into the pinned destination on the next capture', async () => {
    const user = userEvent.setup();
    render(<App />);
    journalActions.focusComposer({ kind: 'collection', id: 'reading' });
    await screen.findByRole('button', { name: 'Destination: Reading' });

    await capture(user, 'Finish chapter');
    expect(createEntry).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'reading', text: 'Finish chapter' }),
    );
  });

  it('keeps the pinned destination across repeated captures on one screen', async () => {
    const user = userEvent.setup();
    render(<App />);
    journalActions.focusComposer({ kind: 'collection', id: 'reading' });
    await screen.findByRole('button', { name: 'Destination: Reading' });

    await capture(user, 'Chapter one');
    await capture(user, 'Chapter two');
    expect(createEntry).toHaveBeenCalledTimes(2);
    expect(createEntry.mock.calls[1]?.[0]).toMatchObject({ collection: 'reading' });
  });

  it('pulls focus into the composer from the global slash shortcut', async () => {
    const user = userEvent.setup();
    render(<App />);
    document.getElementById('journal-content')?.focus();
    await user.keyboard('/');
    await waitFor(() => expect(screen.getByLabelText('Add an entry')).toHaveFocus());
    expect(screen.getByLabelText('Add an entry')).toHaveValue('');
  });
});
