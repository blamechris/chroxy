/**
 * FooterBar — VSCode-style status bar pinned to the bottom of the window.
 *
 * Left: version, connection status, session cwd breadcrumb.
 * Right: model, cost, context tokens, busy indicator, agent count.
 * Spans full width across sidebar + main content (grid-column: 1 / -1).
 */

import {
  costTooltip,
  contextTooltip,
  agentTooltip,
  modelTooltip,
} from '../lib/status-tooltips'

declare const __APP_VERSION__: string

export interface FooterBarProps {
  connectionPhase: string
  tunnelReady?: boolean
  serverPhase?: 'tunnel_warming' | 'tunnel_verifying' | 'ready' | null
  tunnelProgress?: { attempt: number; maxAttempts: number } | null
  serverVersion?: string | null
  cwd?: string
  model?: string
  cost?: number
  context?: string
  contextPercent?: number | null
  isBusy?: boolean
  agentCount?: number
  onShowQr?: () => void
  /** #3070: per-session "Share this session" QR. Undefined hides the button. */
  onShareSession?: () => void
  /** #3858: provider + per-turn data so the chip tooltips can explain values. */
  provider?: string
  contextUsage?: { inputTokens: number; outputTokens: number } | null
  contextWindow?: number | null
}

/** Abbreviate a full path to the last 2 segments: /Users/foo/Projects/bar → Projects/bar */
function abbreviateCwd(cwd: string): string {
  const parts = cwd.replace(/\/+$/, '').split('/')
  return parts.length <= 2 ? cwd : parts.slice(-2).join('/')
}

const STATUS_LABELS: Record<string, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  server_restarting: 'Restarting',
  disconnected: 'Disconnected',
}

export function FooterBar({
  connectionPhase,
  tunnelReady = true,
  serverPhase,
  tunnelProgress,
  serverVersion,
  cwd,
  model,
  cost,
  context,
  contextPercent,
  isBusy,
  agentCount,
  onShowQr,
  onShareSession,
  provider,
  contextUsage,
  contextWindow,
}: FooterBarProps) {
  const costTitle = costTooltip(cost ?? null, provider ?? null)
  const contextTitle = contextTooltip({
    inputTokens: contextUsage?.inputTokens ?? 0,
    outputTokens: contextUsage?.outputTokens ?? 0,
    contextWindow: contextWindow ?? null,
    percent: contextPercent ?? null,
  })
  const modelTitle = modelTooltip(model ?? null, contextWindow ?? null)
  const agentTitle = agentCount != null ? agentTooltip(agentCount) : undefined
  const version = serverVersion ?? (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0')

  // Prefer WS-driven serverPhase over polling-based tunnelReady
  const isWarming = serverPhase === 'tunnel_warming' || serverPhase === 'tunnel_verifying'
  const settingUpTunnel = isWarming
    || (connectionPhase === 'connected' && !tunnelReady && serverPhase == null)
  let statusLabel: string
  if (settingUpTunnel) {
    statusLabel = tunnelProgress
      ? `Tunnel warming up… (${tunnelProgress.attempt}/${tunnelProgress.maxAttempts})`
      : 'Tunnel warming up…'
  } else {
    statusLabel = STATUS_LABELS[connectionPhase] ?? connectionPhase
  }
  const dotClass = settingUpTunnel ? 'connecting' : connectionPhase

  return (
    <footer className="footer-bar" data-testid="footer-bar">
      <div className="footer-left">
        <span className="footer-version">v{version}</span>
        <span className={`footer-status-dot ${dotClass}`} />
        <span className="footer-status-label">{statusLabel}</span>
        {cwd && (
          <span className="footer-cwd" title={cwd}>
            {abbreviateCwd(cwd)}
          </span>
        )}
      </div>
      <div className="footer-right">
        {onShowQr && (
          <button className="footer-qr-btn" onClick={onShowQr} type="button" aria-label="Show QR code">
            QR
          </button>
        )}
        {onShareSession && (
          <button
            className="footer-qr-btn"
            onClick={onShareSession}
            type="button"
            aria-label="Share this session"
            data-testid="btn-share-session"
            title="Share this session — scanner gets a session-bound token (#3070)"
          >
            Share
          </button>
        )}
        {isBusy && <span className="footer-busy" />}
        {agentCount != null && agentCount > 0 && (
          <span
            className="footer-agents"
            title={agentTitle}
            aria-label={agentTitle}
          >
            {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
          </span>
        )}
        {model && (
          <span
            className="footer-model"
            title={modelTitle}
            aria-label={modelTitle}
          >
            {model}
          </span>
        )}
        {cost != null && (
          <span
            className="footer-cost"
            title={costTitle}
            aria-label={costTitle}
          >
            ${cost.toFixed(4)}
          </span>
        )}
        {context && (
          <span className="footer-context" title={contextTitle} aria-label={contextTitle}>
            {contextPercent != null ? (
              <>
                <span
                  className={`footer-context-bar${contextPercent >= 80 ? ' high' : contextPercent >= 50 ? ' medium' : ''}`}
                  role="progressbar"
                  aria-label="Context window usage"
                  aria-valuenow={Math.min(Math.round(contextPercent), 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span className="footer-context-fill" style={{ width: `${Math.min(contextPercent, 100)}%` }} />
                </span>
                <span className="footer-context-label">{Math.min(Math.round(contextPercent), 100)}%</span>
              </>
            ) : context}
          </span>
        )}
      </div>
    </footer>
  )
}
