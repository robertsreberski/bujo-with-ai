import { Fragment, useState } from 'react';
import { DeferredComposerPopover } from './DeferredComposerPopover';
import { Icon } from './Icon';
import { SIGNIFIER_KEYS } from './signifiers';
import { TYPE_LABELS } from './types';

const GRAMMAR: Array<{ token: string; description: string }> = [
  { token: '#tag', description: 'Tag the entry' },
  { token: '@4pm', description: 'Time — also @11 and @23:59' },
  {
    token: '>tomorrow',
    description: 'Another day — also >friday, >next-week, >14, >2026-08-12',
  },
  { token: '/collection', description: 'File into a collection' },
  { token: '//literal', description: 'A slash you meant to keep' },
];

const SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: '/', description: 'Jump to the composer' },
  { keys: '⌘K', description: 'Search the journal' },
];

/*
 * `text-(length:--text-tag)` rather than `text-tag`: tailwind-merge reads the
 * bare custom size as a text *color* and drops it next to `text-fg-faint`.
 */
const KBD =
  'inline-flex min-w-5 flex-none items-center justify-center rounded-sm border border-border bg-bg-line px-1 py-px text-(length:--text-tag) font-mono text-fg-faint';

/*
 * A two-column grid rather than a row of flex pairs: the token column sizes to
 * the widest `kbd` in its own section, so every description starts on the same
 * line. This surface inherited the legend the capture bar used to carry, which
 * makes scannability the whole point.
 */
// `m-0`/`ml-0`: the base reset leaves the UA's own `dl` margin and `dd` indent.
const LIST = 'm-0 grid grid-cols-[max-content_1fr] items-center gap-x-2.5 gap-y-1';
const TERM = 'flex';
const DESCRIPTION = 'ml-0 min-w-0 text-md text-fg-body';

/** The capture grammar, one row per token, on the same surface as the picker. */
export function CaptureHelp() {
  const [open, setOpen] = useState(false);
  return (
    <DeferredComposerPopover
      open={open}
      onOpenChange={setOpen}
      title="Capture grammar"
      description="Everything the composer understands as you type."
      marker="capture-help"
      /*
       * Popover-only sizing. `ComposerPopover` hands this class to both of its
       * surfaces, and below 680px the surface is a full-width bottom sheet: an
       * unscoped `max-w`/`p-3` there pinned a 320px slab to the left edge and
       * overwrote the sheet's safe-area bottom padding.
       */
      className="min-[680px]:max-w-[min(320px,calc(100vw_-_24px))] min-[680px]:p-3"
      trigger={
        <button
          /*
           * `touch:-my-1.5` for the same reason the chips carry `touch:-my-2`:
           * the 40px touch box is a target, not a size, so it hands the 12px it
           * added back to the layout and the context row stays 28px tall
           * instead of being propped open by the one control in it that is not
           * a chip.
           */
          className="grid size-7 flex-none place-items-center rounded-md text-fg-mute hover:bg-bg-line hover:text-fg touch:-my-1.5 touch:size-10"
          type="button"
          aria-label="Capture help"
        >
          <Icon name="question" size={14} />
        </button>
      }
    >
      {/* `px-2` on the sheet only, to meet the 16px inset its title already uses. */}
      <div className="flex flex-col gap-3 max-[679px]:px-2 max-[679px]:pt-1">
        <section>
          <h3 className="pb-1.5 text-xs font-medium text-fg-mute">Signifiers</h3>
          <dl className={LIST}>
            {SIGNIFIER_KEYS.map(([key, type]) => (
              <Fragment key={key}>
                <dt className={TERM}>
                  <kbd className={KBD}>{key}</kbd>
                </dt>
                <dd className={DESCRIPTION}>{TYPE_LABELS[type]}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
        <section>
          <h3 className="pb-1.5 text-xs font-medium text-fg-mute">Tokens</h3>
          <dl className={LIST}>
            {GRAMMAR.map((item) => (
              <Fragment key={item.token}>
                <dt className={TERM}>
                  <kbd className={KBD}>{item.token}</kbd>
                </dt>
                <dd className={DESCRIPTION}>{item.description}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
        <section>
          <h3 className="pb-1.5 text-xs font-medium text-fg-mute">Shortcuts</h3>
          <dl className={LIST}>
            {SHORTCUTS.map((item) => (
              <Fragment key={item.keys}>
                <dt className={TERM}>
                  <kbd className={KBD}>{item.keys}</kbd>
                </dt>
                <dd className={DESCRIPTION}>{item.description}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
      </div>
    </DeferredComposerPopover>
  );
}
