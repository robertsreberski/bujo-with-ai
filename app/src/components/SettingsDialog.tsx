import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AgentToken } from '@journal/server/contracts/app';
import { ConfirmDialog, Dialog } from './Dialog';
import { Icon } from './Icon';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { Switch } from './ui/switch';
import { AI_PANEL, AI_PANEL_COPY, AI_PANEL_HEADER } from './ui/dialog-classes';
import { cn } from '../lib/utils';
import type { JournalPersistenceState } from '../domain/contracts';
import type { DisplayPreferences } from './types';

const SECTION = 'mb-[18px] last:mb-0';
/** `.mcp-status-card` / `.update-card`: one boxed row with a trailing control. */
const STATUS_CARD =
  'flex items-center justify-between gap-2.5 rounded-lg border border-border px-3 py-[11px]';
/** `.tool-list` / `.token-list` / `.preferences-card`: a clipped, hairline-split list. */
const LIST_CARD = 'overflow-hidden rounded-lg border border-border';
const SECTION_HEADING = 'pb-2';
const CARD_STRONG = 'text-sm font-medium';
const CARD_SMALL = 'text-tag text-fg-mute';
const PREFERENCE_ROW =
  'flex min-h-[54px] items-center justify-between gap-3 border-b border-bg-line px-[11px] py-2 last:border-b-0';
const PREFERENCE_COPY = 'flex min-w-0 flex-col';

export type AgentTokenView = AgentToken;

interface SettingsDialogProps {
  assistantStatus: 'offline' | 'ready' | 'connected';
  mcpEndpoint: string;
  activeSessions: number;
  tokens: AgentTokenView[];
  tokensLoading: boolean;
  preferences: DisplayPreferences;
  updateReady: boolean;
  offlineReady?: boolean;
  persistenceStatus: JournalPersistenceState;
  recentlyDeletedCount?: number;
  failedChangeCount?: number;
  onClose: () => void;
  onUpdatePreferences: (patch: Partial<DisplayPreferences>) => void;
  onRefreshTokens: () => void;
  onCreateToken: (label: string) => Promise<{ token: AgentTokenView; secret: string }>;
  onRevokeToken: (id: string) => void;
  onActivateUpdate: () => void;
  onOpenRecovery?: (() => void) | undefined;
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
  offlineReady = false,
  persistenceStatus,
  recentlyDeletedCount = 0,
  failedChangeCount = 0,
  onClose,
  onUpdatePreferences,
  onRefreshTokens,
  onCreateToken,
  onRevokeToken,
  onActivateUpdate,
  onOpenRecovery,
}: SettingsDialogProps) {
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [revoking, setRevoking] = useState<AgentTokenView | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const typeBadgesLabelId = useId();
  const highlightLabelId = useId();
  const statusLabel =
    assistantStatus === 'connected' && activeSessions > 0
      ? 'Connected'
      : assistantStatus === 'offline'
        ? 'Offline'
        : 'Ready';
  const durableOfflineReady = offlineReady && persistenceStatus === 'available';
  const offlineUseCopy =
    persistenceStatus === 'unavailable'
      ? offlineReady
        ? 'The app shell is available without a connection, but journal data is not being saved on this device.'
        : 'Journal data is not being saved on this device, so offline setup cannot finish.'
      : durableOfflineReady
        ? 'The app shell and downloaded journal are available without a connection.'
        : 'Finishing setup while this page remains open.';

  useEffect(() => {
    onRefreshTokens();
  }, [onRefreshTokens]);

  useEffect(() => {
    if (copyState !== 'failed') return;
    secretRef.current?.focus();
    secretRef.current?.select();
  }, [copyState]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = label.trim();
    if (!normalized || creating) return;
    setCreating(true);
    try {
      const result = await onCreateToken(normalized);
      setSecret(result.secret);
      setCopyState('idle');
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

  const selectSecret = () => {
    secretRef.current?.focus();
    secretRef.current?.select();
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
      title="Settings"
      description="Display, recovery, and trusted agent access."
      onClose={onClose}
      size="wide"
    >
      <section className={SECTION} aria-labelledby="display-title">
        <header className={SECTION_HEADING}>
          <div>
            <h3 className="text-base font-semibold" id="display-title">
              Display
            </h3>
            <p className="pt-0.5 text-xs text-fg-mute">
              These preferences apply on this journal across your devices.
            </p>
          </div>
        </header>
        <div className={LIST_CARD}>
          <label className={PREFERENCE_ROW}>
            <span className={PREFERENCE_COPY}>
              <strong className={CARD_STRONG}>Row density</strong>
              <small className={CARD_SMALL}>
                Choose more breathing room or more entries on screen.
              </small>
            </span>
            <NativeSelect
              className="max-w-[135px]"
              value={preferences.density}
              onChange={(event) =>
                onUpdatePreferences({
                  density: event.currentTarget.value as DisplayPreferences['density'],
                })
              }
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </NativeSelect>
          </label>
          <label className={PREFERENCE_ROW}>
            <span className={PREFERENCE_COPY}>
              <strong className={CARD_STRONG} id={typeBadgesLabelId}>
                Type badges
              </strong>
              <small className={CARD_SMALL}>Show type labels below entries.</small>
            </span>
            <Switch
              aria-labelledby={typeBadgesLabelId}
              checked={preferences.showTypeBadges}
              onCheckedChange={(checked) => onUpdatePreferences({ showTypeBadges: checked })}
            />
          </label>
          <label className={PREFERENCE_ROW}>
            <span className={PREFERENCE_COPY}>
              <strong className={CARD_STRONG} id={highlightLabelId}>
                Assistant highlighting
              </strong>
              <small className={CARD_SMALL}>Tint entries written by an agent.</small>
            </span>
            <Switch
              aria-labelledby={highlightLabelId}
              checked={preferences.highlightAiEntries}
              onCheckedChange={(checked) => onUpdatePreferences({ highlightAiEntries: checked })}
            />
          </label>
        </div>
      </section>

      <section className={SECTION} aria-labelledby="assistant-access-title">
        <header className={SECTION_HEADING}>
          <h3 className="text-base font-semibold" id="assistant-access-title">
            Assistant access
          </h3>
          <p className="pt-0.5 text-xs text-fg-mute">
            Connect trusted agents over MCP, with one revocable token per agent.
          </p>
        </header>
        <div className={cn(STATUS_CARD, 'mcp-status-card mb-2.5')}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <strong className={CARD_STRONG}>MCP server</strong>
            <code className="overflow-hidden text-tag text-fg-mute text-ellipsis whitespace-nowrap">
              {mcpEndpoint}
            </code>
          </div>
          <Badge variant="connection" className="connection-pill">
            <i
              className={`size-[5px] flex-none rounded-full ${
                statusLabel === 'Offline'
                  ? 'bg-danger'
                  : statusLabel === 'Ready'
                    ? 'bg-warning'
                    : 'bg-ok'
              }`}
            />{' '}
            {statusLabel}
          </Badge>
        </div>

        {secret ? (
          <aside className={cn(AI_PANEL, 'mb-2.5')} aria-live="polite">
            <header className={AI_PANEL_HEADER}>
              <Icon name="check" size={13} /> <strong>Token created — copy it now</strong>
            </header>
            <p className={AI_PANEL_COPY}>This secret is shown once and cannot be recovered.</p>
            <div className="flex items-center gap-2 pt-2">
              {copyState === 'failed' ? (
                <input
                  ref={secretRef}
                  className="min-w-0 flex-1 bg-[rgb(0_0_0/22%)] font-mono text-2xs text-fg"
                  aria-label="Agent token secret"
                  readOnly
                  value={secret}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onFocus={(event) => event.currentTarget.select()}
                />
              ) : (
                <code className="min-w-0 flex-1 overflow-hidden rounded-sm bg-[rgb(0_0_0/22%)] px-2 py-[7px] text-2xs text-fg text-ellipsis whitespace-nowrap">
                  {secret}
                </code>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={copyState === 'failed' ? selectSecret : copySecret}
              >
                {copyState === 'copied'
                  ? 'Copied'
                  : copyState === 'failed'
                    ? 'Select token'
                    : 'Copy'}
              </Button>
            </div>
            {copyState === 'failed' ? (
              <p className="pt-1.5 text-xs text-ai-fg">
                Clipboard access is unavailable. The complete token is selected for manual copy.
              </p>
            ) : null}
            <button
              className="mt-[5px] min-h-[34px] text-xs text-ai-fg underline underline-offset-[3px] touch:min-h-10"
              type="button"
              onClick={() => {
                setSecret(null);
                setCopyState('idle');
              }}
            >
              I have saved it
            </button>
          </aside>
        ) : null}
        <form className="mb-2 flex gap-2" onSubmit={create}>
          <label className="sr-only" htmlFor="new-token-label">
            New agent token label
          </label>
          <input
            ref={labelRef}
            id="new-token-label"
            className="min-w-0 flex-1"
            value={label}
            maxLength={80}
            placeholder="e.g. Claude Desktop"
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
          <Button variant="primary" type="submit" disabled={!label.trim() || creating}>
            {creating ? 'Creating…' : 'Create token'}
          </Button>
        </form>
        <div className={LIST_CARD} aria-busy={tokensLoading}>
          {tokens.filter((token) => !token.revokedAt).length > 0 ? (
            tokens
              .filter((token) => !token.revokedAt)
              .map((token) => (
                <div
                  className="flex min-h-[55px] items-center justify-between gap-2.5 border-b border-bg-line px-2.5 py-2 last:border-b-0"
                  key={token.id}
                >
                  <div className="flex min-w-0 flex-col">
                    <strong className="overflow-hidden text-sm font-medium text-ellipsis whitespace-nowrap">
                      {token.label}
                    </strong>
                    <span className={CARD_SMALL}>
                      {token.lastUsedAt
                        ? `Last used ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(token.lastUsedAt))}`
                        : 'Never used'}
                    </span>
                  </div>
                  <Button variant="danger" size="sm" onClick={() => setRevoking(token)}>
                    Revoke
                  </Button>
                </div>
              ))
          ) : (
            <p className="p-3 text-center text-tag text-fg-mute">
              {tokensLoading ? 'Loading tokens…' : 'No active agent tokens.'}
            </p>
          )}
        </div>
      </section>

      <section className={SECTION} aria-labelledby="recovery-title">
        <header className={SECTION_HEADING}>
          <h3 className="text-base font-semibold" id="recovery-title">
            Recovery
          </h3>
          <p className="pt-0.5 text-xs text-fg-mute">
            Restore deleted entries and resolve changes that need attention.
          </p>
        </header>
        <div className={STATUS_CARD}>
          <span className="flex min-w-0 flex-col">
            <strong className={CARD_STRONG}>Journal recovery</strong>
            <small className={CARD_SMALL}>
              {recentlyDeletedCount} deleted · {failedChangeCount} failed{' '}
              {failedChangeCount === 1 ? 'change' : 'changes'}
            </small>
          </span>
          <Button variant="secondary" size="sm" disabled={!onOpenRecovery} onClick={onOpenRecovery}>
            Open recovery
          </Button>
        </div>
      </section>

      <section className={SECTION} aria-labelledby="advanced-title">
        <header className={SECTION_HEADING}>
          <h3 className="text-base font-semibold" id="advanced-title">
            Advanced
          </h3>
        </header>
        <div className={cn(STATUS_CARD, 'mb-2.5')}>
          <span className="flex min-w-0 flex-col">
            <strong className={CARD_STRONG}>Offline use</strong>
            <small className={CARD_SMALL}>{offlineUseCopy}</small>
          </span>
          <Badge
            variant={
              persistenceStatus === 'unavailable'
                ? 'statusError'
                : durableOfflineReady
                  ? 'connection'
                  : 'status'
            }
          >
            {persistenceStatus === 'unavailable'
              ? 'Not saved'
              : durableOfflineReady
                ? 'Ready'
                : 'Setting up'}
          </Badge>
        </div>
        <details className={cn(LIST_CARD, updateReady && 'mb-2.5')}>
          <summary className="flex min-h-10 cursor-pointer items-center px-[11px] text-sm font-medium">
            Protocol permissions and privacy
          </summary>
          <div className="border-t border-bg-line p-2.5">
            <p className="pb-2 text-sm leading-[1.55] text-fg-mute">
              All five write tools apply immediately. Every assistant mutation is attributed,
              snapshotted, rate-limited, and available to revert from Activity.
            </p>
            <div className={LIST_CARD} aria-label="MCP tool permissions">
              {tools.map(([name, mode]) => (
                <div
                  className="flex min-h-[38px] items-center gap-2.5 border-b border-bg-line px-[11px] last:border-b-0"
                  key={name}
                >
                  <code className="min-w-0 flex-1 overflow-hidden text-tag text-ellipsis whitespace-nowrap">
                    {name}
                  </code>
                  <Badge
                    variant={mode === 'automatic' ? 'modeAuto' : 'modeRead'}
                    className="mode-badge"
                  >
                    {mode}
                  </Badge>
                </div>
              ))}
            </div>
            <div className="mt-2.5 flex gap-2 border-t border-bg-line pt-[13px] text-fg-mute">
              <Icon name="info" size={14} className="mt-0.5 flex-none" />
              <p className="text-tag leading-[1.5]">
                The Journal server has no third-party data egress. An MCP client you authorize may
                transmit retrieved content to its configured AI provider.
              </p>
            </div>
          </div>
        </details>
        {updateReady ? (
          <div
            className={cn(STATUS_CARD, 'update-card border-ai-border bg-ai-bg')}
            aria-live="polite"
          >
            <div className="flex items-center gap-2">
              <Icon name="download" size={14} />
              <span className="flex flex-col">
                <strong className="text-sm">Update ready</strong>
                <small className="text-tag text-fg-mid">
                  Reload when you have finished this thought.
                </small>
              </span>
            </div>
            <Button variant="primary" onClick={onActivateUpdate}>
              Reload
            </Button>
          </div>
        ) : null}
      </section>
    </Dialog>
  );
}
