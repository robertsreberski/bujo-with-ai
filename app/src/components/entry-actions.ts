import { formatMonth, fromDateKey } from './dates';
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

/** Monthly logs are the server-owned pseudo-collection `month:YYYY-MM` (DM-4). */
const MONTH_PREFIX = 'month:';

const monthName = (month: string): string =>
  new Intl.DateTimeFormat(undefined, { month: 'long' }).format(fromDateKey(`${month}-01`));

/**
 * How a monthly-log filing is named wherever one is shown — `month:2026-07` →
 * `Monthly log — July 2026` — and null for a filing that is not a monthly log.
 *
 * A monthly log is never in the fileable-collections list, so each surface
 * would otherwise have to invent its own name for it; naming it once keeps the
 * dialog's select, the sheet's picker, and the read-only fact row in step.
 */
export const monthCollectionLabel = (collection: string | null): string | null =>
  collection !== null && collection.startsWith(MONTH_PREFIX)
    ? `Monthly log — ${formatMonth(collection.slice(MONTH_PREFIX.length))}`
    : null;

/** The month `schedule-month` files into: the browsed month, else the current one. */
export const scheduleTargetMonth = (context: EntryActionContext): string =>
  context.contextMonth ?? context.today.slice(0, 7);

const scheduleLabel = (target: string, today: string): string =>
  target === today.slice(0, 7) ? 'To monthly log' : `To ${monthName(target)} log`;

export function buildEntryActions(entry: JournalEntry, context: EntryActionContext): EntryAction[] {
  const actionable = isActionable(entry);
  const open = entry.state === 'open';
  const done = entry.state === 'done';
  // The shell a migration or a scheduling leaves behind, pointing at its copy.
  const tombstone = entry.state === 'migrated' || entry.state === 'scheduled';
  const scheduleTarget = scheduleTargetMonth(context);
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
      label: scheduleLabel(scheduleTarget, context.today),
      icon: 'calendar',
      available: actionable && open,
      // Scheduling files a *copy* into the target month. A task already sitting
      // in that month's log would get a second one beside it.
      disabled: entry.collection === `${MONTH_PREFIX}${scheduleTarget}`,
    },
    // Filing is a property of the entry, not of its type: anything still in
    // play can be moved into a collection. Tombstones point at their copy, so
    // they stay where they are.
    'file-collection': {
      id: 'file-collection',
      label: 'File in collection',
      icon: 'folder',
      available: !tombstone,
    },
    drop: {
      id: 'drop',
      label: 'Drop',
      icon: 'trash',
      available: actionable && open,
      destructive: true,
    },
    // Tasks and habits are dropped rather than deleted; the other types have no
    // "dropped" state, so deletion is their only way out. The exception is a
    // tombstone of any type: nothing else can be done to one, so leaving it
    // undeletable would strand it in the log forever. A cancelled task keeps
    // no delete on purpose — the drop *is* the record.
    delete: {
      id: 'delete',
      label: 'Delete',
      icon: 'trash',
      available: !actionable || tombstone,
      destructive: true,
    },
  };
  return ACTION_ORDER.map((id) => byId[id]);
}
