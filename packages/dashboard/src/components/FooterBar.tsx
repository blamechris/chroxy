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
  modelTooltip,
  agentCountTooltip,
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
  /** #4205: raw input tokens for the most-recent turn (drives the tooltip breakdown). */
  inputTokens?: number
  /** #4205: raw output tokens for the most-recent turn (drives the tooltip breakdown). */
  outputTokens?: number
  isBusy?: boolean
  agentCount?: number
  onShowQr?: () => void
  /** #3070: per-session "Share this session" QR. Undefined hides the button. */
  onShareSession?: () => void
  /** #3858: provider id so the cost tooltip can flag client-estimated values. */
  provider?: string
  /** #3858: model context window in tokens for the model tooltip. */
  contextWindow?: number
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
  inputTokens,
  outputTokens,
  isBusy,
  agentCount,
  onShowQr,
  onShareSession,
  provider,
  contextWindow,
}: FooterBarProps) {
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

  // #4204 Copilot review: compute each chip's tooltip once so the
  // `title` + `aria-label` mirror pair stays in lockstep.
  const costTip = costTooltip({ cost: cost ?? undefined, provider })
  // #4205: thread input/output tokens through so the chip's tooltip
  // carries the in/out/total breakdown (the #3858 acceptance criterion
  // PR #4204 added the helper for but left unwired).
  const contextTip = contextTooltip({
    percent: contextPercent ?? null,
    contextSummary: context,
    inputTokens,
    outputTokens,
  })
  const modelTip = modelTooltip({ model, contextWindow })
  const agentTip = agentCountTooltip(agentCount)

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
            title={agentTip}
            aria-label={agentTip}
          >
            {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
          </span>
        )}
        {model && (
          <span
            className="footer-model"
            title={modelTip}
            aria-label={modelTip}
          >
            {model}
          </span>
        )}
        {cost != null && (
          <span
            className="footer-cost"
            title={costTip}
            aria-label={costTip}
          >
            ${cost.toFixed(4)}
          </span>
        )}
        {context && (
          <span
            className="footer-context"
            title={contextTip}
            aria-label={contextTip}
          >
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
