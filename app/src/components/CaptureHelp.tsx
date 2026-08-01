import { useState } from 'react';
import { ComposerPopover } from './ComposerPopover';
import { Icon } from './Icon';
import { SIGNIFIER_KEYS } from './signifiers';
import { TYPE_LABELS } from './types';

const GRAMMAR: Array<{ token: string; description: string }> = [
  { token: '#tag', description: 'Tag the entry' },
  { token: '@4pm', description: 'Time — also @11 and @23:59' },
  { token: '>tomorrow', description: 'File into tomorrow' },
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
const ROW = 'flex items-center gap-2 py-[3px] text-md text-fg-body';

/** The capture grammar, one row per token, on the same surface as the picker. */
export function CaptureHelp() {
  const [open, setOpen] = useState(false);
  return (
    <ComposerPopover
      open={open}
      onOpenChange={setOpen}
      title="Capture grammar"
      description="Everything the composer understands as you type."
      marker="capture-help"
      className="max-w-[min(320px,calc(100vw_-_24px))] p-3"
      trigger={
        <button
          className="grid size-6 flex-none place-items-center rounded-sm text-fg-mute hover:bg-bg-line hover:text-fg touch:size-10"
          type="button"
          aria-label="Capture help"
        >
          <Icon name="question" size={14} />
        </button>
      }
    >
      <div className="flex flex-col gap-2.5">
        <section className="flex flex-col">
          <h3 className="pb-1 text-xs font-medium text-fg-mute">Signifiers</h3>
          {SIGNIFIER_KEYS.map(([key, type]) => (
            <p className={ROW} key={key}>
              <kbd className={KBD}>{key}</kbd>
              <span className="min-w-0 flex-1">{TYPE_LABELS[type]}</span>
            </p>
          ))}
        </section>
        <section className="flex flex-col">
          <h3 className="pb-1 text-xs font-medium text-fg-mute">Tokens</h3>
          {GRAMMAR.map((item) => (
            <p className={ROW} key={item.token}>
              <kbd className={KBD}>{item.token}</kbd>
              <span className="min-w-0 flex-1">{item.description}</span>
            </p>
          ))}
        </section>
        <section className="flex flex-col">
          <h3 className="pb-1 text-xs font-medium text-fg-mute">Shortcuts</h3>
          {SHORTCUTS.map((item) => (
            <p className={ROW} key={item.keys}>
              <kbd className={KBD}>{item.keys}</kbd>
              <span className="min-w-0 flex-1">{item.description}</span>
            </p>
          ))}
        </section>
      </div>
    </ComposerPopover>
  );
}
