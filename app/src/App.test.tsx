// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
      loadIndex: vi.fn(() =>
        Promise.resolve({ collections: [], months: [], types: [], savedViews: [] }),
      ),
      loadEntries: vi.fn(() => Promise.resolve([])),
      loadEntry: vi.fn(() => Promise.resolve({} as Entry)),
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
const loadIndex = vi.mocked(journalActions.loadIndex);
const loadEntries = vi.mocked(journalActions.loadEntries);
const loadEntry = vi.mocked(journalActions.loadEntry);

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
    resourceStatus: 'ready',
    online: false,
    connectionStatus: 'offline',
    authenticationRequired: false,
    persistenceStatus: 'available',
    today: TODAY,
    serverToday: TODAY,
    draft: '',
    defaultType: 'task',
    entriesById: {},
    index: null,
    activityById: {},
    activityOrder: [],
    lastReviewSeenAt: null,
    activitySeenThrough: null,
    seenActivityIds: [],
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

describe('App resource loading', () => {
  it('does not render an authoritative empty journal while canonical rows are loading', () => {
    useJournalStore.setState({
      hydrated: true,
      loading: true,
      resourceStatus: 'loading',
      networkOnline: true,
      online: false,
      connectionStatus: 'connecting',
    });

    render(<App />);

    expect(screen.getByText('Opening your local journal…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Add an entry')).not.toBeInTheDocument();
  });

  it('focuses the journal surface when the initial resource finishes loading', async () => {
    useJournalStore.setState({
      hydrated: true,
      loading: true,
      resourceStatus: 'loading',
      networkOnline: true,
      online: false,
      connectionStatus: 'connecting',
    });

    render(<App />);
    expect(document.getElementById('journal-content')).not.toBeInTheDocument();

    act(() => {
      useJournalStore.setState({
        loading: false,
        resourceStatus: 'ready',
        connectionStatus: 'offline',
      });
    });

    await waitFor(() => expect(document.getElementById('journal-content')).toHaveFocus());
  });

  it('opens Index through its aggregate read model instead of lifetime hydration', async () => {
    window.history.replaceState(null, '', '/index');
    useJournalStore.setState({
      hydrated: true,
      loading: false,
      resourceStatus: 'ready',
      networkOnline: true,
      online: true,
      connectionStatus: 'connected',
      cursor: 'epoch:9',
    });

    render(<App />);

    await waitFor(() => expect(loadIndex).toHaveBeenCalledTimes(1));
    expect(loadEntries).not.toHaveBeenCalled();
  });

  it('keeps an Index deep link stable while its route chunk resolves', async () => {
    window.history.replaceState(null, '', '/index');
    useJournalStore.setState({
      index: { collections: [], months: [], types: [], savedViews: [] },
    });

    render(<App />);

    expect(await screen.findByLabelText('Journal index')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/index');
  });
});

describe('App Activity acknowledgement', () => {
  it('does not acknowledge the history merely because the route opened', async () => {
    const markAllSeen = vi.spyOn(journalActions, 'markAllActivitySeen');
    window.history.replaceState(null, '', '/activity');

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Agent history' })).toBeInTheDocument();
    expect(markAllSeen).not.toHaveBeenCalled();
    markAllSeen.mockRestore();
  });

  it('resolves a deep-linked entry that was outside the bootstrap window', async () => {
    window.history.replaceState(null, '', '/activity?entry=01K1H000000000000000000042');
    useJournalStore.setState({ online: true, connectionStatus: 'connected' });

    render(<App />);

    await waitFor(() => expect(loadEntry).toHaveBeenCalledWith('01K1H000000000000000000042'));
  });

  it('opens a locally known entry deep link through the deferred detail surface', async () => {
    const entry: Entry = {
      id: '01K1H000000000000000000043',
      date: TODAY,
      type: 'task',
      text: 'Review the release notes',
      state: 'open',
      time: null,
      tags: [],
      author: 'me',
      source: null,
      migrations: 0,
      collection: null,
      createdAt: `${TODAY}T09:00:00.000Z`,
      updatedAt: `${TODAY}T09:00:00.000Z`,
      revision: 1,
      deletedAt: null,
    };
    window.history.replaceState(null, '', `/activity?entry=${entry.id}`);
    useJournalStore.setState({ entriesById: { [entry.id]: entry } });

    render(<App />);

    expect(
      await screen.findByRole('dialog', { name: 'Review the release notes' }),
    ).toBeInTheDocument();
    expect(window.location.search).toBe(`?entry=${entry.id}`);
  });
});

describe('App deferred dialogs', () => {
  it('opens and closes Settings without changing the current route', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/index');
    useJournalStore.setState({
      index: { collections: [], months: [], types: [], savedViews: [] },
    });
    render(<App />);
    await screen.findByLabelText('Journal index');
    const trigger = screen.getAllByRole('button', { name: 'Settings' })[0] as HTMLButtonElement;

    await user.click(trigger);
    const close = await waitFor(() => screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/index');

    await user.click(close);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    expect(trigger).toHaveFocus();
    expect(window.location.pathname).toBe('/index');
  });
});

describe('App capture', () => {
  it('canonicalizes a current-date Timeline deep link to the root', async () => {
    window.history.replaceState(null, '', `/?date=${TODAY}`);
    render(<App />);

    await waitFor(() => expect(window.location.href).not.toContain('date='));
    expect(window.location.pathname).toBe('/');
    expect(screen.getAllByText('Timeline').length).toBeGreaterThan(0);
  });

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
    expect(screen.queryByRole('button', { name: 'Destination: Today' })).not.toBeInTheDocument();

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
    await user.click(screen.getByLabelText('Add an entry'));
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
