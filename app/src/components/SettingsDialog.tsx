import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentToken } from '@journal/server/contracts/app';
import { ConfirmDialog, Dialog } from './Dialog';
import { Icon } from './Icon';
import type { DisplayPreferences } from './types';

export type AgentTokenView = AgentToken;

interface SettingsDialogProps {
  assistantStatus: 'offline' | 'ready' | 'connected';
  mcpEndpoint: string;
  activeSessions: number;
  tokens: AgentTokenView[];
  tokensLoading: boolean;
  preferences: DisplayPreferences;
  updateReady: boolean;
  onClose: () => void;
  onUpdatePreferences: (patch: Partial<DisplayPreferences>) => void;
  onRefreshTokens: () => void;
  onCreateToken: (label: string) => Promise<{ token: AgentTokenView; secret: string }>;
  onRevokeToken: (id: string) => void;
  onActivateUpdate: () => void;
}

const tools = [
  ['add_entry', 'automatic'],
  ['add_to_collection', 'automatic'],
  ['list_day', 'read only'],
  ['search', 'read only'],
  ['update_entry', 'automatic'],
  ['delete_entry', 'automatic'],
  ['propose_migration', 'automatic'],
] as const;

export function SettingsDialog({
  assistantStatus,
  mcpEndpoint,
  activeSessions,
  tokens,
  tokensLoading,
  preferences,
  updateReady,
  onClose,
  onUpdatePreferences,
  onRefreshTokens,
  onCreateToken,
  onRevokeToken,
  onActivateUpdate,
}: SettingsDialogProps) {
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [revoking, setRevoking] = useState<AgentTokenView | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const statusLabel =
    assistantStatus === 'connected' && activeSessions > 0
      ? 'Connected'
      : assistantStatus === 'offline'
        ? 'Offline'
        : 'Ready';

  useEffect(() => {
    onRefreshTokens();
  }, [onRefreshTokens]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = label.trim();
    if (!normalized || creating) return;
    setCreating(true);
    try {
      const result = await onCreateToken(normalized);
      setSecret(result.secret);
      setLabel('');
    } catch {
      // The app-level action reports the server error without leaving an unhandled rejection.
    } finally {
      setCreating(false);
    }
  };

  const copySecret = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  if (revoking) {
    return (
      <ConfirmDialog
        title={`Revoke ${revoking.label}?`}
        description="The agent will lose access immediately. Existing journal entries and activity remain unchanged."
        confirmLabel="Revoke token"
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          onRevokeToken(revoking.id);
          setRevoking(null);
        }}
      />
    );
  }

  return (
    <Dialog
      title="Assistant access"
      description="Connect trusted agents to your journal over MCP."
      onClose={onClose}
      size="wide"
    >
      <section className="settings-section">
        <div className="mcp-status-card">
          <div>
            <strong>MCP server</strong>
            <code>{mcpEndpoint}</code>
          </div>
          <span className={`connection-pill connection-pill--${statusLabel.toLowerCase()}`}>
            <i /> {statusLabel}
          </span>
        </div>
        <p className="settings-explainer">
          All five write tools apply immediately. Every assistant mutation is attributed,
          snapshotted, rate-limited, and available to revert from Review.
        </p>
        <div className="tool-list" aria-label="MCP tool permissions">
          {tools.map(([name, mode]) => (
            <div className="tool-row" key={name}>
              <code>{name}</code>
              <span className={`mode-badge mode-badge--${mode === 'automatic' ? 'auto' : 'read'}`}>
                {mode}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="tokens-title">
        <header className="settings-section__heading">
          <div>
            <h3 id="tokens-title">Agent tokens</h3>
            <p>Use one token per agent so access can be revoked independently.</p>
          </div>
        </header>
        {secret ? (
          <aside className="token-secret" aria-live="polite">
            <header>
              <Icon name="check" size={13} /> <strong>Token created — copy it now</strong>
            </header>
            <p>This secret is shown once and cannot be recovered.</p>
            <div>
              <code>{secret}</code>
              <button
                className="button button--secondary button--small"
                type="button"
                onClick={copySecret}
              >
                {copyState === 'copied'
                  ? 'Copied'
                  : copyState === 'failed'
                    ? 'Select manually'
                    : 'Copy'}
              </button>
            </div>
            <button className="token-secret__dismiss" type="button" onClick={() => setSecret(null)}>
              I have saved it
            </button>
          </aside>
        ) : null}
        <form className="token-create" onSubmit={create}>
          <label className="sr-only" htmlFor="new-token-label">
            New agent token label
          </label>
          <input
            ref={labelRef}
            id="new-token-label"
            value={label}
            maxLength={80}
            placeholder="e.g. Claude Desktop"
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
          <button
            className="button button--primary"
            type="submit"
            disabled={!label.trim() || creating}
          >
            {creating ? 'Creating…' : 'Create token'}
          </button>
        </form>
        <div className="token-list" aria-busy={tokensLoading}>
          {tokens.filter((token) => !token.revokedAt).length > 0 ? (
            tokens
              .filter((token) => !token.revokedAt)
              .map((token) => (
                <div className="token-row" key={token.id}>
                  <div>
                    <strong>{token.label}</strong>
                    <span>
                      {token.lastUsedAt
                        ? `Last used ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(token.lastUsedAt))}`
                        : 'Never used'}
                    </span>
                  </div>
                  <button
                    className="button button--danger button--small"
                    type="button"
                    onClick={() => setRevoking(token)}
                  >
                    Revoke
                  </button>
                </div>
              ))
          ) : (
            <p className="token-list__empty">
              {tokensLoading ? 'Loading tokens…' : 'No active agent tokens.'}
            </p>
          )}
        </div>
      </section>

      <section className="settings-section" aria-labelledby="display-title">
        <header className="settings-section__heading">
          <div>
            <h3 id="display-title">Display</h3>
            <p>These preferences apply on this journal across your devices.</p>
          </div>
        </header>
        <div className="preferences-card">
          <label>
            <span>
              <strong>Row density</strong>
              <small>Choose more breathing room or more entries on screen.</small>
            </span>
            <select
              value={preferences.density}
              onChange={(event) =>
                onUpdatePreferences({
                  density: event.currentTarget.value as DisplayPreferences['density'],
                })
              }
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </label>
          <label>
            <span>
              <strong>Type badges</strong>
              <small>Show type labels below entries.</small>
            </span>
            <span className="preference-toggle">
              <input
                type="checkbox"
                checked={preferences.showTypeBadges}
                onChange={(event) =>
                  onUpdatePreferences({ showTypeBadges: event.currentTarget.checked })
                }
              />
              <span className="preference-toggle__track" aria-hidden="true" />
            </span>
          </label>
          <label>
            <span>
              <strong>Assistant highlighting</strong>
              <small>Tint entries written by an agent.</small>
            </span>
            <span className="preference-toggle">
              <input
                type="checkbox"
                checked={preferences.highlightAiEntries}
                onChange={(event) =>
                  onUpdatePreferences({ highlightAiEntries: event.currentTarget.checked })
                }
              />
              <span className="preference-toggle__track" aria-hidden="true" />
            </span>
          </label>
        </div>
      </section>

      <section className="settings-section settings-section--privacy">
        <Icon name="info" size={14} />
        <p>
          The Journal server has no third-party data egress. An MCP client you authorize may
          transmit retrieved content to its configured AI provider.
        </p>
      </section>

      {updateReady ? (
        <section className="update-card" aria-live="polite">
          <div>
            <Icon name="download" size={14} />
            <span>
              <strong>Update ready</strong>
              <small>Reload when you have finished this thought.</small>
            </span>
          </div>
          <button className="button button--primary" type="button" onClick={onActivateUpdate}>
            Reload
          </button>
        </section>
      ) : null}
    </Dialog>
  );
}
