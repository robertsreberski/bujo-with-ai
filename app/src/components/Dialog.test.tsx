// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog } from './Dialog';

afterEach(cleanup);

describe('Dialog', () => {
  it('closes on Escape and restores focus to its trigger', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open settings
          </button>
          {open ? (
            <Dialog title="Settings" onClose={() => setOpen(false)}>
              <button type="button">Save</button>
            </Dialog>
          ) : null}
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open settings' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps the current focus when its parent rerenders', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [count, setCount] = useState(0);
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <Dialog title="Search" onClose={() => undefined} initialFocusRef={inputRef}>
          <input ref={inputRef} aria-label="Search" />
          <button type="button" onClick={() => setCount((value) => value + 1)}>
            Refresh {count}
          </button>
        </Dialog>
      );
    }
    render(<Harness />);
    const refresh = screen.getByRole('button', { name: 'Refresh 0' });
    await user.click(refresh);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(screen.getByRole('button', { name: 'Refresh 1' })).toHaveFocus();
  });

  it('keeps Tab navigation inside when focus starts on the panel or background', async () => {
    const user = userEvent.setup();
    render(
      <>
        <input aria-label="Background composer" />
        <Dialog title="Settings" onClose={() => undefined}>
          <button type="button">First action</button>
          <button type="button">Last action</button>
        </Dialog>
      </>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const close = screen.getByRole('button', { name: 'Close dialog' });
    const last = screen.getByRole('button', { name: 'Last action' });
    dialog.focus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();

    screen.getByRole('textbox', { name: 'Background composer' }).focus();
    await user.tab();
    expect(close).toHaveFocus();
  });

  it('closes only the topmost dialog on Escape', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [outerOpen, setOuterOpen] = useState(true);
      const [innerOpen, setInnerOpen] = useState(true);
      return (
        <>
          {outerOpen ? (
            <Dialog title="Outer" onClose={() => setOuterOpen(false)}>
              <span>Outer content</span>
            </Dialog>
          ) : null}
          {innerOpen ? (
            <Dialog title="Inner" onClose={() => setInnerOpen(false)}>
              <span>Inner content</span>
            </Dialog>
          ) : null}
        </>
      );
    }
    render(<Harness />);
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Inner' })).not.toBeInTheDocument();
  });
});
