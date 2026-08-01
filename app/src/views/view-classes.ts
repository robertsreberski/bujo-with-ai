/*
 * Shared screen recipes, replacing the `.month-section` / `.index-group` /
 * `.activity-section` / `.section-heading` / `.section-empty` / `.index-card`
 * / `.calendar-day` blocks views.css used to hold. They live in one module
 * because three separate screens render the same section header and card
 * shell; the marker classes e2e locates by are appended at the call site.
 */
export const SECTION = 'px-4 pt-[18px]';

export const SECTION_HEADING = 'flex items-start justify-between gap-2.5 pb-[7px]';

/** `.section-heading--action`: centred against its trailing control, stacked when narrow. */
export const SECTION_HEADING_ACTION =
  'flex items-center justify-between gap-2.5 pb-[7px] max-[480px]:items-start';

export const SECTION_TITLE = 'text-base font-semibold';

export const SECTION_COPY = 'pt-0.5 text-sm leading-[1.5] text-fg-mute text-pretty';

export const SECTION_COUNT = 'flex-none text-xs text-fg-mute';

export const SECTION_EMPTY =
  'rounded-lg border border-border px-[13px] py-[18px] text-center text-sm text-fg-mute';

/** The rounded, clipped list shell shared by the index, activity, and summary cards. */
export const CARD = 'overflow-hidden rounded-xl border border-border';

/*
 * DS-14 calendar cells: a 38px visual square that inflates to the 40px
 * coarse-pointer minimum, which is what the 320px touch sweep measures.
 */
export const CALENDAR_DAY =
  'calendar-day relative grid min-h-[38px] min-w-0 place-items-center rounded-md border border-transparent text-sm text-fg-body hover:bg-bg-hover hover:text-fg touch:min-h-10';

/** Centred empty/placeholder panel used by search, collections, and dead letters. */
export const EMPTY_PANEL =
  'flex flex-col items-center justify-center gap-[5px] p-5 text-center text-fg-mute';
