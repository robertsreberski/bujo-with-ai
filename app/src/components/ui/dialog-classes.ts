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
