import { describe, expect, it } from 'vitest';
import { buildEntryActions, scheduleTargetMonth, type EntryActionId } from './entry-actions';
import { ENTRY_TYPES, type EntryState, type EntryType, type JournalEntry } from './types';

const TODAY = '2026-07-31';

const ENTRY_STATES: EntryState[] = ['open', 'done', 'logged', 'migrated', 'scheduled', 'cancelled'];

const makeEntry = (patch: Partial<JournalEntry> = {}): JournalEntry => ({
  id: '01J00000000000000000000000',
  date: TODAY,
  type: 'task',
  text: 'Reply to Mira',
  state: 'open',
  time: null,
  tags: [],
  author: 'me',
  source: null,
  migrations: 0,
  collection: 'project-atlas',
  createdAt: '2026-07-31T09:00:00.000Z',
  updatedAt: '2026-07-31T09:00:00.000Z',
  revision: 1,
  deletedAt: null,
  ...patch,
});

const availableIds = (entry: JournalEntry, contextMonth: string | null = null): EntryActionId[] =>
  buildEntryActions(entry, { contextMonth, today: TODAY })
    .filter((action) => action.available)
    .map((action) => action.id);

const actionable = (state: EntryState): EntryActionId[] => {
  switch (state) {
    case 'open':
      return ['edit', 'toggle-done', 'move-to-today', 'schedule-month', 'file-collection', 'drop'];
    case 'done':
      return ['edit', 'toggle-done', 'file-collection'];
    case 'logged':
    case 'cancelled':
      return ['edit', 'file-collection'];
    case 'migrated':
    case 'scheduled':
      return ['edit'];
  }
};

const loggable = (state: EntryState): EntryActionId[] =>
  state === 'migrated' || state === 'scheduled'
    ? ['edit', 'move-to-today', 'delete']
    : ['edit', 'move-to-today', 'file-collection', 'delete'];

describe('buildEntryActions', () => {
  it.each(ENTRY_TYPES)('offers the %s matrix for every state', (type: EntryType) => {
    const expected = type === 'task' || type === 'habit' ? actionable : loggable;
    for (const state of ENTRY_STATES) {
      expect({ state, ids: availableIds(makeEntry({ type, state })) }).toEqual({
        state,
        ids: expected(state),
      });
    }
  });

  it('returns every action in one render order, availability as a flag', () => {
    const actions = buildEntryActions(makeEntry(), { contextMonth: null, today: TODAY });
    expect(actions.map((action) => action.id)).toEqual([
      'edit',
      'toggle-done',
      'move-to-today',
      'schedule-month',
      'file-collection',
      'drop',
      'delete',
    ]);
    expect(actions.find((action) => action.id === 'delete')?.available).toBe(false);
  });

  it('names the toggle for the state it produces', () => {
    const label = (state: EntryState) =>
      buildEntryActions(makeEntry({ state }), { contextMonth: null, today: TODAY }).find(
        (action) => action.id === 'toggle-done',
      )?.label;
    expect(label('open')).toBe('Mark done');
    expect(label('done')).toBe('Mark not done');
  });

  it('marks a loose note already sitting on today as nowhere left to move', () => {
    const disabled = (entry: JournalEntry) =>
      buildEntryActions(entry, { contextMonth: null, today: TODAY }).find(
        (action) => action.id === 'move-to-today',
      )?.disabled;
    expect(disabled(makeEntry({ type: 'note', state: 'logged', collection: null }))).toBe(true);
    expect(disabled(makeEntry({ type: 'note', state: 'logged' }))).toBe(false);
    expect(
      disabled(makeEntry({ type: 'note', state: 'logged', collection: null, date: '2026-07-30' })),
    ).toBe(false);
    // An open task always migrates, so the rule never disables it.
    expect(disabled(makeEntry({ collection: null }))).toBe(false);
  });

  it('names the schedule action after the month it files into', () => {
    const label = (contextMonth: string | null) =>
      buildEntryActions(makeEntry(), { contextMonth, today: TODAY }).find(
        (action) => action.id === 'schedule-month',
      )?.label;
    expect(label(null)).toBe('To monthly log');
    expect(label('2026-07')).toBe('To monthly log');
    expect(label('2026-08')).toBe('To August log');
    expect(label('2025-12')).toBe('To December log');
  });

  it('targets the browsed month, falling back to the current one', () => {
    expect(scheduleTargetMonth({ contextMonth: null, today: TODAY })).toBe('2026-07');
    expect(scheduleTargetMonth({ contextMonth: '2026-09', today: TODAY })).toBe('2026-09');
  });

  it('offers filing to every type still in play, and to none of the forwarded ones', () => {
    const filing = (entry: JournalEntry) =>
      buildEntryActions(entry, { contextMonth: null, today: TODAY }).find(
        (action) => action.id === 'file-collection',
      )?.available;
    expect(filing(makeEntry())).toBe(true);
    expect(filing(makeEntry({ type: 'habit', state: 'done' }))).toBe(true);
    expect(filing(makeEntry({ type: 'note', state: 'logged' }))).toBe(true);
    expect(filing(makeEntry({ state: 'migrated' }))).toBe(false);
    expect(filing(makeEntry({ state: 'scheduled' }))).toBe(false);
  });

  it('tones the two destructive actions and the two affirmative ones', () => {
    const actions = buildEntryActions(makeEntry({ type: 'note', state: 'logged' }), {
      contextMonth: null,
      today: TODAY,
    });
    const byId = Object.fromEntries(actions.map((action) => [action.id, action]));
    expect(byId['delete']?.destructive).toBe(true);
    expect(byId['drop']?.destructive).toBe(true);
    expect(byId['edit']?.destructive).toBeUndefined();
    // A note's move is the affirmative action; a task's migrate is not.
    expect(byId['move-to-today']?.primary).toBe(true);
    expect(byId['toggle-done']?.primary).toBe(true);
    expect(
      buildEntryActions(makeEntry(), { contextMonth: null, today: TODAY }).find(
        (action) => action.id === 'move-to-today',
      )?.primary,
    ).toBe(false);
  });
});
