/*
 * Shared surface recipe for ui/dialog.tsx and ui/alert-dialog.tsx.
 *
 * The overlay is both the flex centering context and the visual-viewport
 * anchor, so `Content` is nested inside it rather than rendered as a sibling.
 * These strings reproduce the retired `.dialog-overlay` / `.dialog-panel` rules
 * exactly, safe-area paddings included; the marker classes stay on the rendered
 * elements because e2e locates both by class.
 */
export const dialogOverlayClassName =
  'dialog-overlay fixed inset-x-0 top-[var(--vv-offset,0px)] bottom-auto z-30 flex h-[var(--vv-height,100%)] items-center justify-center bg-overlay pt-[max(16px,var(--sat))] pr-[max(16px,var(--sar))] pb-[max(16px,var(--sab))] pl-[max(16px,var(--sal))] animate-(--animate-overlay-in) motion-reduce:animate-none';

export const dialogPanelClassName =
  'dialog-panel flex max-h-[min(86vh,calc(var(--vv-height,100vh)_-_32px))] w-full flex-col rounded-2xl border border-border bg-bg shadow-(--shadow-dialog) outline-none animate-(--animate-dialog-in) motion-reduce:animate-none';

export type DialogSize = 'normal' | 'wide';

export const dialogSizeClassName: Record<DialogSize, string> = {
  normal: 'max-w-[400px]',
  wide: 'max-w-[520px]',
};

/*
 * The dialog interior recipes that used to live in components.css as
 * `.dialog-header` / `.dialog-heading` / `.dialog-body` / `.dialog-actions`
 * and the `.form-stack` / `.form-grid` / `.field*` form scaffolding. Five
 * dialogs share them, so they stay one definition rather than five copies.
 * `.dialog-header` and `.dialog-body` keep their marker class names.
 */
export const DIALOG_HEADER =
  'dialog-header flex flex-none items-start justify-between gap-3 px-4 pt-4';

export const DIALOG_HEADING = 'min-w-0';

export const DIALOG_TITLE =
  'overflow-hidden text-lg font-semibold tracking-[-0.01em] text-ellipsis';

export const DIALOG_DESCRIPTION = 'pt-0.5 text-sm leading-[1.5] text-fg-mute text-pretty';

export const DIALOG_BODY = 'dialog-body scrollable min-h-0 px-4 pt-3.5 pb-4';

export const DIALOG_ACTIONS = 'flex flex-wrap gap-2 pt-3.5';

export const DIALOG_ACTIONS_END = `${DIALOG_ACTIONS} justify-end`;

/** Two-up action grid used by the entry detail and migration dialogs. */
export const ACTION_GRID = 'grid grid-cols-2 gap-2 pt-3.5 max-[480px]:grid-cols-1';

export const FORM_STACK = 'flex flex-col gap-3';

export const FORM_GRID = 'grid grid-cols-2 gap-2.5 max-[480px]:grid-cols-1';

/*
 * `.field` also carried `width: 100%; color: var(--fg)` for the controls it
 * wraps, which is kept here as a descendant variant so every form stays a
 * plain `<label><span/><input/></label>`.
 */
export const FIELD =
  'flex min-w-0 flex-col gap-[5px] text-xs text-fg-mid [&_input]:w-full [&_input]:text-fg [&_select]:w-full [&_select]:text-fg';

export const FIELD_SMALL = 'font-normal text-fg-mute';

export const FIELD_ERROR = 'font-normal leading-[1.4] text-danger';

export const FIELD_HINT = 'text-tag text-fg-mute [&_code]:text-fg-mid';

/* The tinted assistant panel behind entry provenance and a freshly issued
   token secret (the old `.provenance-panel, .token-secret` pair). */
export const AI_PANEL = 'rounded-lg border border-ai-border bg-ai-bg px-3 py-[11px] text-ai-fg';

export const AI_PANEL_HEADER = 'flex items-center gap-1.5 text-xs';

export const AI_PANEL_COPY = 'pt-[5px] text-sm leading-[1.55] text-fg-mid text-pretty';
