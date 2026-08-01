import { EntryActionSheet, type EntryActionSheetProps } from './EntryActionSheet';
import { EntryDialog } from './EntryDialog';
import { useInteractionMode } from '../hooks/use-interaction-mode';

/**
 * The props of the entry detail surface. Both faces take exactly this set —
 * passing them straight through to `EntryDialog` below is what keeps that
 * true at compile time.
 */
export type EntryDetailHostProps = EntryActionSheetProps;

/**
 * Picks the entry surface the pointer deserves: a bottom sheet with thumb-sized
 * rows on touch, the dialog on mouse and trackpad. The choice is a live media
 * query rather than a width breakpoint, so an iPad in a wide layout still gets
 * the sheet and a narrow desktop window still gets the dialog.
 */
export function EntryDetailHost(props: EntryDetailHostProps) {
  return useInteractionMode() === 'coarse' ? (
    <EntryActionSheet {...props} />
  ) : (
    <EntryDialog {...props} />
  );
}
