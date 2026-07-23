/**
 * GithubWebhookConfig (#6540, item 3 of #6536) — the repo-events webhook-secret
 * configuration surface, rendered as a collapsible panel inside RepoEventsSection.
 *
 * Lets an operator light the repo-events feed up end-to-end from the dashboard —
 * without dropping to a shell to export `GITHUB_WEBHOOK_SECRET` or edit config:
 *
 *   - Set / rotate the HMAC webhook secret (write-only field — the stored value
 *     is NEVER displayed back; the server replies with status only). A "Generate"
 *     helper fills a strong random secret client-side so it can be copied into
 *     GitHub before saving.
 *   - Copy the payload URL to paste into GitHub → repo → Settings → Webhooks,
 *     plus the recommended events. A LAN/loopback note appears when GitHub can't
 *     reach the origin (no tunnel, e.g. `--tunnel none`).
 *   - See recent delivery status (count / last / verify result).
 *
 * The raw secret lives only in this component's local input state until Save
 * sends it; the dashboard store only ever holds the value-free config. Writes are
 * host-authority gated server-side (a pairing-bound token is rejected).
 */
import { useCallback, useEffect, useState } from 'react'
import { useConnectionStore } from '../store/connection'
import type { ServerGithubWebhookConfigMessage } from '@chroxy/protocol'

const WS_CLOSED_MESSAGE =
  'Not connected to the server — your change was not saved. Reconnect and try again.'

/** Generate a strong random webhook secret client-side (32 bytes → hex). */
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32)
  const cryptoObj: Crypto | undefined = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return 'whsec_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function sourceLabel(config: ServerGithubWebhookConfigMessage): string {
  if (!config.configured) return 'Not configured'
  if (config.source === 'env') return 'Set (environment)'
  if (config.source === 'store') return 'Set (stored, encrypted)'
  return 'Set'
}

export interface GithubWebhookConfigProps {
  /** Whether the panel is expanded. Controlled by the parent (RepoEventsSection). */
  open: boolean
  /** Toggle the expanded state. */
  onToggle: () => void
  /** Latest config, or null before the first reply. Defaults to the store. */
  config?: ServerGithubWebhookConfigMessage | null
  /** True while a config request/write is in flight. Defaults to the store flag. */
  loading?: boolean
  /** Whether the WS connection is up. Defaults to the store's connected phase. */
  connected?: boolean
  /** Refresh action. Defaults to the store's requestGithubWebhookConfig. */
  onRefresh?: () => boolean | void
  /** Set/rotate action. Defaults to the store's setGithubWebhookSecret. */
  onSetSecret?: (secret: string) => boolean
  /** Clear action. Defaults to the store's clearGithubWebhookSecret. */
  onClearSecret?: () => boolean
}

export function GithubWebhookConfig({
  open,
  onToggle,
  config: configProp,
  loading: loadingProp,
  connected: connectedProp,
  onRefresh,
  onSetSecret,
  onClearSecret,
}: GithubWebhookConfigProps) {
  const storeConfig = useConnectionStore((s) => s.githubWebhookConfig)
  const storeLoading = useConnectionStore((s) => s.githubWebhookConfigLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestConfig = useConnectionStore((s) => s.requestGithubWebhookConfig)
  const setSecretAction = useConnectionStore((s) => s.setGithubWebhookSecret)
  const clearSecretAction = useConnectionStore((s) => s.clearGithubWebhookSecret)

  const config = configProp !== undefined ? configProp : storeConfig
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const refresh = onRefresh ?? requestConfig
  const setSecret = onSetSecret ?? setSecretAction
  const clearSecret = onClearSecret ?? clearSecretAction

  const [value, setValue] = useState('')
  const [wsClosed, setWsClosed] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Refresh the config whenever the panel opens so it's accurate after an
  // out-of-band change (another dashboard, an env var, an edit to the store).
  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const envWins = config?.source === 'env'
  const isConfigured = Boolean(config?.configured)

  const handleSave = useCallback(() => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    const sent = setSecret(trimmed)
    if (sent) {
      setWsClosed(null)
      setValue('')
    } else {
      setWsClosed(WS_CLOSED_MESSAGE)
    }
  }, [value, setSecret])

  const handleClear = useCallback(() => {
    const sent = clearSecret()
    setWsClosed(sent ? null : WS_CLOSED_MESSAGE)
  }, [clearSecret])

  const handleCopy = useCallback(() => {
    const url = config?.payloadUrl
    if (!url) return
    void navigator?.clipboard?.writeText?.(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [config?.payloadUrl])

  return (
    <div className="cr-webhook" data-testid="github-webhook-config">
      <button
        type="button"
        className="cr-webhook-toggle"
        data-testid="github-webhook-toggle"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span>Webhook setup {open ? '▾' : '▸'}</span>
        {config && (
          <span
            className={`cr-tag ${isConfigured ? 'cr-tag-ok' : 'cr-tag-warn'}`}
            data-testid="github-webhook-status"
          >
            {sourceLabel(config)}
          </span>
        )}
      </button>

      {open && (
        <div className="cr-webhook-body" data-testid="github-webhook-body" aria-busy={loading}>
          {!connected && (
            <p className="cr-dim" data-testid="github-webhook-not-connected">
              Not connected to the server.
            </p>
          )}

          {/* Payload URL — copy into GitHub → repo → Settings → Webhooks. */}
          <div className="cr-webhook-field">
            <span className="cr-webhook-label">Payload URL</span>
            <div className="cr-webhook-urlrow">
              <code className="cr-mono cr-webhook-url" data-testid="github-webhook-payload-url">
                {config?.payloadUrl ?? '—'}
              </code>
              <button
                type="button"
                className="cr-refresh"
                data-testid="github-webhook-copy"
                onClick={handleCopy}
                disabled={!config?.payloadUrl}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            {config?.lanOnly && config?.note && (
              <p className="cr-callout cr-callout-bad" data-testid="github-webhook-lan-note" role="alert">
                {config.note}
              </p>
            )}
          </div>

          {/* Recommended events to subscribe the webhook to. */}
          {config && config.recommendedEvents.length > 0 && (
            <div className="cr-webhook-field">
              <span className="cr-webhook-label">Recommended events</span>
              <div className="cr-chips" data-testid="github-webhook-events">
                {config.recommendedEvents.map((ev) => (
                  <span className="cr-chip" key={ev} data-testid={`github-webhook-event-${ev}`}>
                    {ev}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Recent delivery status. */}
          {config && (
            <div className="cr-webhook-field">
              <span className="cr-webhook-label">Recent deliveries</span>
              <div className="cr-chips" data-testid="github-webhook-deliveries">
                <span className="cr-chip">
                  Total: <b data-testid="github-webhook-deliveries-total">{config.deliveries.total}</b>
                </span>
                <span className="cr-chip">
                  Verified: <b data-testid="github-webhook-deliveries-verified">{config.deliveries.verified}</b>
                </span>
                <span className="cr-chip">
                  Rejected: <b data-testid="github-webhook-deliveries-rejected">{config.deliveries.rejected}</b>
                </span>
                <span className="cr-chip" data-testid="github-webhook-deliveries-last">
                  Last:{' '}
                  <b>
                    {config.deliveries.lastResult
                      ? `${config.deliveries.lastResult}${config.deliveries.lastKind ? ` (${config.deliveries.lastKind})` : ''}`
                      : 'none yet'}
                  </b>
                </span>
              </div>
            </div>
          )}

          {/* Set / rotate the secret. Write-only — never shows the stored value. */}
          {envWins ? (
            <p className="cr-dim" data-testid="github-webhook-env-hint">
              A <span className="cr-mono">GITHUB_WEBHOOK_SECRET</span> environment variable is set and
              takes precedence over a stored value — so it can&apos;t be changed or removed here. To
              manage the secret from the dashboard, unset that variable and reconnect.
            </p>
          ) : (
            <div className="cr-webhook-field">
              <label className="cr-webhook-label" htmlFor="github-webhook-secret-input">
                {isConfigured ? 'Rotate secret' : 'Set secret'}
              </label>
              <input
                id="github-webhook-secret-input"
                className="cr-webhook-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste or generate a webhook secret"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                data-testid="github-webhook-secret-input"
              />
              <div className="cr-webhook-actions">
                <button
                  type="button"
                  className="cr-refresh"
                  data-testid="github-webhook-generate"
                  onClick={() => setValue(generateWebhookSecret())}
                >
                  Generate
                </button>
                <button
                  type="button"
                  className="cr-refresh"
                  data-testid="github-webhook-save"
                  onClick={handleSave}
                  disabled={value.trim().length === 0 || loading}
                >
                  {isConfigured ? 'Rotate' : 'Save'}
                </button>
                {config?.source === 'store' && (
                  <button
                    type="button"
                    className="cr-refresh cr-action-danger"
                    data-testid="github-webhook-clear"
                    onClick={handleClear}
                    disabled={loading}
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className="cr-dim">
                The secret is stored encrypted at rest (OS keychain when available) and never shown
                again — paste the same value into GitHub&apos;s webhook &quot;Secret&quot; field.
              </p>
            </div>
          )}

          {wsClosed && (
            <p className="cr-callout cr-callout-bad" role="alert" data-testid="github-webhook-ws-closed">
              {wsClosed}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
