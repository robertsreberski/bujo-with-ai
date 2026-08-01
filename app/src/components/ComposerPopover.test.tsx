// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ComposerPopover } from './ComposerPopover';

/** Drives `useCompactSurface`, which is the only thing that picks a surface. */
function matchMedia(compact: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: compact && query === '(max-width: 679px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // vaul drives its drag gesture through pointer capture, which jsdom omits.
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <ComposerPopover
      open={open}
      onOpenChange={setOpen}
      title="File this capture"
      description="Choose where the next entry lands."
      marker="destination-menu"
      trigger={
        <button type="button" aria-label="Destination: Today">
          → Today
        </button>
      }
    >
      <button type="button" onClick={() => setOpen(false)}>
        Tomorrow
      </button>
    </ComposerPopover>
  );
}

const openSurface = async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Destination: Today' }));
  return user;
};

describe('ComposerPopover', () => {
  it('anchors a popover on a wide layout', async () => {
    matchMedia(false);
    await openSurface();
    expect(await screen.findByRole('button', { name: 'Tomorrow' })).toBeInTheDocument();
    // The anchored panel, not the sheet: no vaul drawer is mounted at all.
    expect(document.querySelector('.destination-menu')).not.toBeNull();
    expect(document.querySelector('[data-vaul-drawer]')).toBeNull();
  });

  it('falls back to the popover when matchMedia is unavailable', async () => {
    vi.stubGlobal('matchMedia', undefined);
    await openSurface();
    expect(await screen.findByRole('button', { name: 'Tomorrow' })).toBeInTheDocument();
  });

  it('opens a drag-handled bottom sheet below the shell breakpoint', async () => {
    matchMedia(true);
    await openSurface();
    const sheet = await screen.findByRole('dialog', { name: 'File this capture' });
    expect(sheet).toHaveClass('destination-menu');
    expect(sheet.querySelector('[data-vaul-handle]')).not.toBeNull();
    expect(screen.getByText('Choose where the next entry lands.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Tomorrow' })).toBeInTheDocument();
  });

  it('overrides vaul’s 500ms slide with Journal’s 160ms dialog motion', async () => {
    matchMedia(true);
    await openSurface();
    const sheet = await screen.findByRole('dialog', { name: 'File this capture' });
    // `!important` utilities: vaul re-asserts its own duration inline and in an
    // injected `[data-vaul-drawer]` rule, so nothing weaker would survive.
    expect(sheet.className).toContain('[animation-duration:160ms]!');
    expect(sheet.className).toContain('[transition:transform_160ms_cubic-bezier(0.16,1,0.3,1)]!');
    expect(sheet.className).toContain('motion-reduce:[animation:none]!');
  });
});
