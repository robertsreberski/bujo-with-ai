// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from './SettingsDialog';

afterEach(cleanup);

describe('SettingsDialog', () => {
  it('settles a failed token request after app-level feedback handles the error', async () => {
    const user = userEvent.setup();
    const onCreateToken = vi.fn().mockRejectedValue(new Error('Offline'));
    render(
      <SettingsDialog
        assistantStatus="offline"
        mcpEndpoint="https://journal.example/mcp"
        activeSessions={0}
        tokens={[]}
        tokensLoading={false}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        updateReady={false}
        recentlyDeletedCount={0}
        failedChangeCount={0}
        onClose={vi.fn()}
        onOpenRecovery={vi.fn()}
        onUpdatePreferences={vi.fn()}
        onRefreshTokens={vi.fn()}
        onCreateToken={onCreateToken}
        onRevokeToken={vi.fn()}
        onActivateUpdate={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText('New agent token label'), 'Claude Desktop');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(onCreateToken).toHaveBeenCalledWith('Claude Desktop');
    expect(await screen.findByRole('button', { name: 'Create token' })).toBeEnabled();
    expect(screen.queryByText(/copy it now/i)).not.toBeInTheDocument();
  });

  it('offers an explicit reload only when a service-worker update is ready', async () => {
    const user = userEvent.setup();
    const onActivateUpdate = vi.fn();
    render(
      <SettingsDialog
        assistantStatus="ready"
        mcpEndpoint="https://journal.example/mcp"
        activeSessions={0}
        tokens={[]}
        tokensLoading={false}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        updateReady
        recentlyDeletedCount={0}
        failedChangeCount={0}
        onClose={vi.fn()}
        onOpenRecovery={vi.fn()}
        onUpdatePreferences={vi.fn()}
        onRefreshTokens={vi.fn()}
        onCreateToken={vi.fn()}
        onRevokeToken={vi.fn()}
        onActivateUpdate={onActivateUpdate}
      />,
    );

    expect(screen.getByText('Update ready')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onActivateUpdate).toHaveBeenCalledTimes(1);
  });

  it('exposes the display preferences as switches and reports each change', async () => {
    const user = userEvent.setup();
    const onUpdatePreferences = vi.fn();
    render(
      <SettingsDialog
        assistantStatus="connected"
        mcpEndpoint="https://journal.example/mcp"
        activeSessions={1}
        tokens={[]}
        tokensLoading={false}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: false }}
        updateReady={false}
        recentlyDeletedCount={0}
        failedChangeCount={0}
        onClose={vi.fn()}
        onOpenRecovery={vi.fn()}
        onUpdatePreferences={onUpdatePreferences}
        onRefreshTokens={vi.fn()}
        onCreateToken={vi.fn()}
        onRevokeToken={vi.fn()}
        onActivateUpdate={vi.fn()}
      />,
    );

    const typeBadges = screen.getByRole('switch', { name: 'Type badges' });
    const highlighting = screen.getByRole('switch', { name: 'Assistant highlighting' });
    expect(typeBadges).toBeChecked();
    expect(highlighting).not.toBeChecked();

    await user.click(typeBadges);
    expect(onUpdatePreferences).toHaveBeenCalledWith({ showTypeBadges: false });

    await user.click(highlighting);
    expect(onUpdatePreferences).toHaveBeenCalledWith({ highlightAiEntries: true });

    await user.selectOptions(screen.getByRole('combobox'), 'compact');
    expect(onUpdatePreferences).toHaveBeenCalledWith({ density: 'compact' });
  });

  it('opens Recovery with truthful deleted and failed counts', async () => {
    const user = userEvent.setup();
    const onOpenRecovery = vi.fn();
    render(
      <SettingsDialog
        assistantStatus="ready"
        mcpEndpoint="https://journal.example/mcp"
        activeSessions={0}
        tokens={[]}
        tokensLoading={false}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        updateReady={false}
        recentlyDeletedCount={2}
        failedChangeCount={1}
        onClose={vi.fn()}
        onOpenRecovery={onOpenRecovery}
        onUpdatePreferences={vi.fn()}
        onRefreshTokens={vi.fn()}
        onCreateToken={vi.fn()}
        onRevokeToken={vi.fn()}
        onActivateUpdate={vi.fn()}
      />,
    );

    expect(screen.getByText('2 deleted · 1 failed change')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open recovery' }));
    expect(onOpenRecovery).toHaveBeenCalledTimes(1);
  });

  it('reveals and selects the complete one-time secret when clipboard access fails', async () => {
    const secret = `jrn_${'s'.repeat(43)}`;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) },
    });
    render(
      <SettingsDialog
        assistantStatus="ready"
        mcpEndpoint="https://journal.example/mcp"
        activeSessions={0}
        tokens={[]}
        tokensLoading={false}
        preferences={{ density: 'comfortable', showTypeBadges: true, highlightAiEntries: true }}
        updateReady={false}
        recentlyDeletedCount={0}
        failedChangeCount={0}
        onClose={vi.fn()}
        onOpenRecovery={vi.fn()}
        onUpdatePreferences={vi.fn()}
        onRefreshTokens={vi.fn()}
        onCreateToken={vi.fn().mockResolvedValue({ token: {}, secret })}
        onRevokeToken={vi.fn()}
        onActivateUpdate={vi.fn()}
      />,
    );

    const label = screen.getByLabelText('New agent token label');
    fireEvent.change(label, { target: { value: 'Local worker' } });
    fireEvent.submit(label.closest('form')!);
    const field = await screen.findByRole('textbox', { name: 'New agent token secret' });
    expect(field).toHaveValue(secret);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Select manually' })).toBeInTheDocument();
    expect(field).toHaveFocus();
    expect((field as HTMLInputElement).selectionStart).toBe(0);
    expect((field as HTMLInputElement).selectionEnd).toBe(secret.length);
  });
});
