// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from './SettingsDialog';

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
});
