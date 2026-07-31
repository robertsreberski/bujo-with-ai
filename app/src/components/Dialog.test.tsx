// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('moves initial focus to the requested control', async () => {
    function Harness() {
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <Dialog title="Search" onClose={() => undefined} initialFocusRef={inputRef}>
          <input ref={inputRef} aria-label="Search" />
        </Dialog>
      );
    }
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search' })).toHaveFocus());
  });

  it('falls back to the first control in the panel when no initial focus is requested', async () => {
    render(
      <Dialog title="Settings" onClose={() => undefined}>
        <button type="button">Save</button>
      </Dialog>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus());
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
    await user.click(screen.getByRole('button', { name: 'Refresh 0' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh 1' })).toHaveFocus());
  });

  it('traps Tab navigation inside the panel', async () => {
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

    const close = screen.getByRole('button', { name: 'Close dialog' });
    const first = screen.getByRole('button', { name: 'First action' });
    const last = screen.getByRole('button', { name: 'Last action' });

    last.focus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.tab();
    expect(first).toHaveFocus();

    close.focus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
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
    // The topmost modal hides every other subtree from assistive technology, so
    // the outer dialog is only reachable through a hidden-inclusive query while
    // the inner one is open.
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2);

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Inner', hidden: true })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeInTheDocument();
  });
});
