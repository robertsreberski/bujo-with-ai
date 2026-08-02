// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from './SettingsDialog';

afterEach(cleanup);

const renderSettings = (overrides: Partial<ComponentProps<typeof SettingsDialog>> = {}) =>
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
      onCreateToken={vi.fn()}
      onRevokeToken={vi.fn()}
      onActivateUpdate={vi.fn()}
      {...overrides}
    />,
  );

describe('SettingsDialog', () => {
  it('orders the compact settings journey from display through advanced controls', () => {
    renderSettings();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['Display', 'Assistant access', 'Recovery', 'Advanced']);
    expect(screen.getByText('Protocol permissions and privacy')).toBeInTheDocument();
    expect(screen.getByLabelText('MCP tool permissions')).not.toBeVisible();
    expect(screen.getByText('Setting up')).toBeInTheDocument();
  });

  it('reports offline availability only after the service worker is ready', () => {
    renderSettings({ offlineReady: true });
    expect(screen.getAllByText('Ready')).toHaveLength(2);
    expect(screen.getByText(/app shell and downloaded journal are available/i)).toBeInTheDocument();
  });

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
        onClose={vi.fn()}
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
        onClose={vi.fn()}
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

  it('reveals and selects the full one-time token when clipboard access fails', async () => {
    const user = userEvent.setup();
    const secret = 'journal_secret_01K1H000000000000000000099';
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) },
    });
    try {
      renderSettings({
        onCreateToken: vi.fn().mockResolvedValue({
          secret,
          token: {
            id: '01K1H000000000000000000099',
            label: 'Timeline helper',
            scopes: ['journal:full'],
            createdAt: '2026-08-02T10:00:00.000Z',
            lastUsedAt: null,
            revokedAt: null,
          },
        }),
      });

      await user.type(screen.getByLabelText('New agent token label'), 'Timeline helper');
      await user.click(screen.getByRole('button', { name: 'Create token' }));
      await user.click(await screen.findByRole('button', { name: 'Copy' }));

      const fallback = await screen.findByLabelText('Agent token secret');
      expect(fallback).toHaveValue(secret);
      expect(fallback).toHaveFocus();
      expect((fallback as HTMLInputElement).selectionStart).toBe(0);
      expect((fallback as HTMLInputElement).selectionEnd).toBe(secret.length);
      expect(screen.getByText(/complete token is selected/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Select token' }));
      expect(fallback).toHaveFocus();
      expect((fallback as HTMLInputElement).selectionEnd).toBe(secret.length);
    } finally {
      if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('opens Recovery with truthful deleted and failed counts', async () => {
    const user = userEvent.setup();
    const onOpenRecovery = vi.fn();
    renderSettings({ recentlyDeletedCount: 2, failedChangeCount: 1, onOpenRecovery });

    expect(screen.getByText('2 deleted · 1 failed change')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open recovery' }));
    expect(onOpenRecovery).toHaveBeenCalledTimes(1);
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
        onClose={vi.fn()}
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
});
