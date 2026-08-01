import { fromDateKey } from './dates';
import type { IconName } from './Icon';
import { isActionable, type JournalEntry } from './types';

/**
 * The single description of what an entry can have done to it.
 *
 * The desktop dialog and the coarse-pointer sheet both render from this list,
 * so an availability rule can never be true on one surface and false on the
 * other. The module is pure: no React, no store, no DOM.
 */
export interface EntryActionContext {
  /** The month the surrounding view is showing, or null outside the month log. */
  contextMonth: string | null;
  /** Today's date key, as the store computes it. */
  today: string;
}

export type EntryActionId =
  | 'toggle-done'
  | 'move-to-today'
  | 'schedule-month'
  | 'file-collection'
  | 'edit'
  | 'drop'
  | 'delete';

export interface EntryAction {
  id: EntryActionId;
  label: string;
  icon: IconName;
  available: boolean;
  /** The surface's affirmative action: a filled button on the desktop dialog. */
  primary?: boolean;
  /** Destructive: a danger-toned control, and a confirmation for `delete`. */
  destructive?: boolean;
  /** Offered but inert — the entry is already in the state the action produces. */
  disabled?: boolean;
}

/** Render order, shared by every surface. */
const ACTION_ORDER: EntryActionId[] = [
  'edit',
  'toggle-done',
  'move-to-today',
  'schedule-month',
  'file-collection',
  'drop',
  'delete',
];

const monthName = (month: string): string =>
  new Intl.DateTimeFormat(undefined, { month: 'long' }).format(fromDateKey(`${month}-01`));

/** The month `schedule-month` files into: the browsed month, else the current one. */
export const scheduleTargetMonth = (context: EntryActionContext): string =>
  context.contextMonth ?? context.today.slice(0, 7);

const scheduleLabel = (context: EntryActionContext): string => {
  const target = scheduleTargetMonth(context);
  return target === context.today.slice(0, 7) ? 'To monthly log' : `To ${monthName(target)} log`;
};

export function buildEntryActions(entry: JournalEntry, context: EntryActionContext): EntryAction[] {
  const actionable = isActionable(entry);
  const open = entry.state === 'open';
  const done = entry.state === 'done';
  const byId: Record<EntryActionId, EntryAction> = {
    edit: { id: 'edit', label: 'Edit', icon: 'edit', available: true },
    'toggle-done': {
      id: 'toggle-done',
      label: done ? 'Mark not done' : 'Mark done',
      icon: 'check',
      available: actionable && (open || done),
      primary: true,
    },
    'move-to-today': {
      id: 'move-to-today',
      label: 'Move to today',
      icon: 'arrowRight',
      available: !actionable || open,
      primary: !actionable,
      // A loose note already sitting on today has nowhere to move.
      disabled: !actionable && entry.date === context.today && entry.collection === null,
    },
    'schedule-month': {
      id: 'schedule-month',
      label: scheduleLabel(context),
      icon: 'calendar',
      available: actionable && open,
    },
    // Filing is a property of the entry, not of its type: anything still in
    // play can be moved into a collection. Migrated and scheduled entries are
    // tombstones pointing at their copy, so they stay where they are.
    'file-collection': {
      id: 'file-collection',
      label: 'File in collection',
      icon: 'folder',
      available: entry.state !== 'migrated' && entry.state !== 'scheduled',
    },
    drop: {
      id: 'drop',
      label: 'Drop',
      icon: 'trash',
      available: actionable && open,
      destructive: true,
    },
    // Tasks and habits are dropped rather than deleted; the other types have no
    // "dropped" state, so deletion is their only way out.
    delete: {
      id: 'delete',
      label: 'Delete',
      icon: 'trash',
      available: !actionable,
      destructive: true,
    },
  };
  return ACTION_ORDER.map((id) => byId[id]);
}
