// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOG_VIEW, type LogViewConfig } from '../views/log-arrangement';
import { ArrangeMenu } from './ArrangeMenu';

afterEach(cleanup);

const renderMenu = (config: LogViewConfig = DEFAULT_LOG_VIEW) => {
  const onChange = vi.fn();
  render(<ArrangeMenu config={config} onChange={onChange} label="Arrange monthly log" />);
  return onChange;
};

const openMenu = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Arrange monthly log/ }));
  return screen.getByRole('menu', { name: 'Arrange monthly log' });
};

describe('ArrangeMenu', () => {
  it('renders a quiet trigger that only mentions filters once some are active', () => {
    renderMenu();
    expect(screen.getByRole('button', { name: 'Arrange monthly log' })).toBeInTheDocument();

    cleanup();
    renderMenu({ ...DEFAULT_LOG_VIEW, types: ['task'] });
    expect(
      screen.getByRole('button', { name: 'Arrange monthly log — filters active' }),
    ).toBeInTheDocument();
  });

  it('opens a menu of radio groups for sort, group, and show plus type checkboxes', () => {
    renderMenu();
    openMenu();
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(7);
    expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(7);
    expect(screen.getByRole('menuitemradio', { name: 'Oldest first' })).toBeChecked();
    expect(screen.getByRole('menuitemradio', { name: 'None' })).toBeChecked();
    expect(screen.getByRole('menuitemradio', { name: 'Open' })).toBeChecked();
    for (const box of screen.getAllByRole('menuitemcheckbox')) expect(box).toBeChecked();
  });

  it('emits the next config and keeps the menu open when a radio row is picked', () => {
    const onChange = renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Newest first' }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_LOG_VIEW, sort: 'newest' });
    expect(screen.getByRole('menu', { name: 'Arrange monthly log' })).toBeInTheDocument();
  });

  it('unchecking one type narrows to the remaining six', () => {
    const onChange = renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Task' }));
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_LOG_VIEW,
      types: ['event', 'note', 'idea', 'question', 'habit', 'mood'],
    });
  });

  it('unchecking the last checked type falls back to every type', () => {
    const onChange = renderMenu({ ...DEFAULT_LOG_VIEW, types: ['task'] });
    openMenu();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Task' })).toBeChecked();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Note' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Task' }));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_LOG_VIEW, types: [] });
  });

  it('offers reset only once the view leaves the defaults', () => {
    renderMenu();
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Reset to defaults' })).not.toBeInTheDocument();

    cleanup();
    const onChange = renderMenu({ ...DEFAULT_LOG_VIEW, sort: 'newest' });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset to defaults' }));
    expect(onChange).toHaveBeenCalledWith(DEFAULT_LOG_VIEW);
  });

  it('roves focus across every row with the keyboard', () => {
    renderMenu();
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(screen.getByRole('menuitemradio', { name: 'Newest first' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitemcheckbox', { name: 'Mood' })).toHaveFocus();
  });
});
