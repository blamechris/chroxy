/**
 * FooterBar — VSCode-style status bar pinned to the bottom of the window.
 *
 * Left: version, connection status, session cwd breadcrumb.
 * Right: model, cost, context tokens, busy indicator, agent count,
 * intervention counter (#4653).
 * Spans full width across sidebar + main content (grid-column: 1 / -1).
 */

import { useEffect, useState } from 'react'
import type { SessionIntervention, ChatActivityState } from '@chroxy/store-core'
import {
  costTooltip,
  contextTooltip,
  modelTooltip,
  agentCountTooltip,
} from '../lib/status-tooltips'

declare const __APP_VERSION__: string

export interface FooterBarProps {
  connectionPhase: string
  /** Chat redesign #6392: chat-activity state → breathe the dot when connected + active. */
  chatActivityState?: ChatActivityState
  tunnelReady?: boolean
  serverPhase?: 'tunnel_warming' | 'tunnel_verifying' | 'ready' | null
  tunnelProgress?: { attempt: number; maxAttempts: number } | null
  serverVersion?: string | null
  cwd?: string
  model?: string
  cost?: number
  context?: string
  contextPercent?: number | null
  /** #4205: raw (uncached) input tokens for the most-recent turn (tooltip breakdown). */
  inputTokens?: number
  /** #4205: raw output tokens for the most-recent turn (drives the tooltip breakdown). */
  outputTokens?: number
  /**
   * #6769: cached history tokens currently in the window (cache_read +
   * cache_creation). Threaded to the tooltip so the hover breakdown explains
   * that most of the cumulative fill is cached conversation history.
   */
  cachedTokens?: number
  isBusy?: boolean
  agentCount?: number
  onShowQr?: () => void
  /** #3070: per-session "Share this session" QR. Undefined hides the button. */
  onShareSession?: () => void
  /** #3858: provider id so the cost tooltip can flag client-estimated values. */
  provider?: string
  /** #3858: model context window in tokens for the model tooltip. */
  contextWindow?: number
  /**
   * #3857: invoked when the user clicks the high-utilization "/compact"
   * suggestion chip. Receives the literal text the chip would send (always
   * `/compact`) so the consumer can route it through whatever input pipe
   * is current (sendInput in App.tsx). Undefined hides the chip entirely
   * — read-only dashboards (e.g. archived-session previews) should not
   * surface a CTA that won't fire.
   */
  onCompact?: () => void
  /**
   * #4653 — chroxy-side intervention ring for the active session. The
   * FooterBar renders a small clickable counter chip "{N} chroxy
   * interventions" when non-empty; clicking expands an inline list with
   * timestamps + reasons. Empty array / undefined hides the chip entirely.
   */
  interventions?: SessionIntervention[]
  /**
   * #4653 — active session id, threaded so the FooterBar can reset the
   * expanded-panel local state when the user switches sessions. Without
   * this, the panel would stay open showing the OLD session's entries
   * after a switch (FooterBar is a single instance with no key reset).
   * Undefined when no session is active — the panel just stays collapsed.
   */
  activeSessionId?: string | null
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
  server_down: 'Server down', // #5698 — terminal; avoid leaking the raw enum string
  disconnected: 'Disconnected',
}

/**
 * #3857: high-water threshold for surfacing the `/compact` suggestion chip.
 * Mirrors the Claude Code CLI's own "near limit" cue (~80%). Exported so
 * tests don't re-hardcode the magic number.
 */
export const FOOTER_COMPACT_SUGGEST_THRESHOLD = 80

/** #3857: hard threshold past which the meter is in "over-budget" mode. */
export const FOOTER_OVER_BUDGET_THRESHOLD = 100

export function FooterBar({
  connectionPhase,
  chatActivityState,
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
  cachedTokens,
  isBusy,
  agentCount,
  onShowQr,
  onShareSession,
  provider,
  contextWindow,
  onCompact,
  interventions,
  activeSessionId,
}: FooterBarProps) {
  // #4653: collapsed by default — the chip just shows the count, click to
  // expand the recent-interventions list. Local state because the panel
  // is a transient UI affordance the store doesn't need to remember.
  const [interventionsOpen, setInterventionsOpen] = useState(false)
  // #4653 Copilot review: FooterBar is a single instance (not keyed by
  // session id), so the panel-open state survives session switches by
  // default. Reset it on switch so the user doesn't see the old session's
  // entries in the panel after switching to a different session.
  useEffect(() => {
    setInterventionsOpen(false)
  }, [activeSessionId])
  const interventionCount = interventions?.length ?? 0
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
  // #6769: thread the cumulative occupancy split (new input/output + cached
  // history) through so the chip's tooltip explains cumulative window fill
  // rather than the pre-#6769 per-turn input/output.
  const contextTip = contextTooltip({
    percent: contextPercent ?? null,
    contextSummary: context,
    inputTokens,
    outputTokens,
    cachedTokens,
  })
  const modelTip = modelTooltip({ model, contextWindow })
  const agentTip = agentCountTooltip(agentCount)

  // #4630 — chips and the QR button were missing one half of the
  // tooltip pair (browser hover OR screen-reader name). Compute the
  // labels once so the `title` / `aria-label` mirror pair can't drift.
  const versionLabel = `Chroxy server v${version}`
  const statusFullLabel = settingUpTunnel
    ? statusLabel
    : (STATUS_LABELS[connectionPhase] ?? `Connection status: ${connectionPhase}`)
  return (
    <footer className="footer-bar" data-testid="footer-bar">
      <div className="footer-left">
        <span
          className="footer-version"
          title={versionLabel}
          aria-label={versionLabel}
        >
          v{version}
        </span>
        {/* #4873 — dot no longer carries `role="status"`. The polite
            live region used to announce every reconnect intermediate
            (connecting → reconnecting → connected → reconnecting…),
            spamming SR users. The aria-label still gives the dot a
            spoken name on focus/hover. The page-level
            ConnectionAnnouncer (App.tsx) handles debounced settled-state
            announcements. */}
        <span
          className={`footer-status-dot ${dotClass}`}
          data-activity={dotClass === 'connected' ? chatActivityState : undefined}
          title={statusFullLabel}
          aria-label={statusFullLabel}
        />
        {/* #4873 — visible label is aria-hidden to avoid a duplicate
            SR announcement next to the dot (which already carries the
            full spoken label via aria-label). Sighted users still see
            the text. */}
        <span className="footer-status-label" aria-hidden="true">{statusLabel}</span>
        {cwd && (
          <span
            className="footer-cwd"
            title={cwd}
            aria-label={`Working directory: ${cwd}`}
          >
            {abbreviateCwd(cwd)}
          </span>
        )}
      </div>
      <div className="footer-right">
        {onShowQr && (
          <button
            className="footer-qr-btn"
            onClick={onShowQr}
            type="button"
            aria-label="Show QR code"
            title="Show QR code — scan with the Chroxy mobile app to pair"
          >
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
        {/* #5731 (a11y): accessible name for the motion-only busy dot (no live
            region — see StatusBar rationale). */}
        {isBusy && <span className="footer-busy" role="img" aria-label="Agent working" />}
        {/*
         * #4653 — chroxy-side intervention counter. Renders only when at
         * least one intervention has fired for the active session. Click
         * toggles an inline list showing the most recent N denials with
         * timestamps and reasons, so the user can audit "did chroxy
         * intervene here?" without reading the server log.
         */}
        {interventionCount > 0 && (
          <>
            <button
              type="button"
              className={`footer-interventions${interventionsOpen ? ' open' : ''}`}
              onClick={() => setInterventionsOpen((v) => !v)}
              aria-expanded={interventionsOpen}
              aria-label={`${interventionCount} chroxy ${interventionCount === 1 ? 'intervention' : 'interventions'} (click to ${interventionsOpen ? 'hide' : 'show'} details)`}
              title="chroxy intervened during this session — click for details"
              data-testid="footer-interventions"
            >
              {interventionCount} {interventionCount === 1 ? 'intervention' : 'interventions'}
            </button>
            {interventionsOpen && (
              <InterventionsPanel
                interventions={interventions!}
                onClose={() => setInterventionsOpen(false)}
              />
            )}
          </>
        )}
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
                  className={`footer-context-bar${
                    contextPercent >= FOOTER_OVER_BUDGET_THRESHOLD
                      ? ' high over-budget'
                      : contextPercent >= FOOTER_COMPACT_SUGGEST_THRESHOLD
                        ? ' high'
                        : contextPercent >= 50
                          ? ' medium'
                          : ''
                  }`}
                  role="progressbar"
                  aria-label="Context window usage"
                  aria-valuenow={Math.min(Math.round(contextPercent), 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span className="footer-context-fill" style={{ width: `${Math.min(contextPercent, 100)}%` }} />
                </span>
                {/*
                 * #3857: show the *true* percent in the label (not the clamped
                 * value) once we cross 100% so the user gets a real over-budget
                 * signal. The bar fill stays clamped at 100% width — a bar
                 * wider than its container is just visual noise — but the
                 * numeric label is what tells the user "you're 18% over".
                 * Sub-100% renders unchanged (Math.min returns the original).
                 */}
                <span className="footer-context-label">
                  {Math.round(contextPercent)}%
                </span>
              </>
            ) : context}
          </span>
        )}
        {/*
         * #3857: clickable "/compact" suggestion chip surfaces at >=80% so
         * users get a remedy hint before the meter pegs at red. Hidden when
         * onCompact is undefined (read-only embeds) so a CTA that won't fire
         * never renders. Rendered AFTER the context chip so the spatial
         * relationship reads as "you're at 90% → here's what to do".
         */}
        {contextPercent != null
          && contextPercent >= FOOTER_COMPACT_SUGGEST_THRESHOLD
          && onCompact && (
          <button
            type="button"
            className={`footer-compact-suggest${
              contextPercent >= FOOTER_OVER_BUDGET_THRESHOLD ? ' over-budget' : ''
            }`}
            onClick={onCompact}
            data-testid="btn-compact-session"
            title={
              contextPercent >= FOOTER_OVER_BUDGET_THRESHOLD
                ? 'Context window full — send /compact to free space (the model may already be silently truncating older context).'
                : 'Context is filling up — send /compact to summarise older turns and free space.'
            }
            aria-label="Compact session — send /compact to free context space"
          >
            /compact
          </button>
        )}
      </div>
    </footer>
  )
}

/**
 * #4653 — expanded list panel for the FooterBar's intervention counter.
 *
 * Renders newest-first since the operator just clicked the counter to
 * understand "what just happened?". Pure presentational: takes the
 * intervention array verbatim from the active session's state and renders
 * one row per entry with a humanised reason + relative timestamp. Wired
 * to the same SessionIntervention shape that store-core writes via
 * handleMultiQuestionIntervention.
 */
interface InterventionsPanelProps {
  interventions: SessionIntervention[]
  onClose: () => void
}

function InterventionsPanel({ interventions, onClose }: InterventionsPanelProps) {
  // Newest-first — operator clicked the counter to debug "what JUST happened".
  // Reverse a shallow copy so we don't mutate the array the store handed us.
  const ordered = [...interventions].reverse()
  return (
    <div
      className="footer-interventions-panel"
      role="dialog"
      aria-label="Recent chroxy interventions"
      data-testid="footer-interventions-panel"
    >
      <div className="footer-interventions-panel-header">
        <span>Recent chroxy interventions</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close interventions panel"
          className="footer-interventions-close"
        >
          ×
        </button>
      </div>
      <ul className="footer-interventions-list">
        {ordered.map((iv) => (
          <li
            key={iv.toolUseId}
            className="footer-interventions-item"
            data-testid={`intervention-${iv.toolUseId}`}
          >
            <div className="footer-interventions-reason">
              {describeIntervention(iv)}
            </div>
            <div className="footer-interventions-meta">
              {formatRelativeTimestamp(iv.timestamp)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Humanise an intervention's discriminator into a one-line operator-facing
 * description. Keep copy short so the panel stays compact; longer help text
 * (the "why?" link the issue mentions) is intentionally deferred until the
 * help-docs route exists.
 */
function describeIntervention(iv: SessionIntervention): string {
  switch (iv.kind) {
    case 'multi_question':
      return `Multi-question form intercepted (${iv.count} questions) — asked agent to ask one at a time`
    default: {
      // Exhaustive fallback for future discriminator additions. Renders the
      // raw kind so a forgotten case still gives the operator SOMETHING to
      // grep on rather than an empty row.
      const _exhaustive: never = iv.kind
      return `chroxy intervention: ${String(_exhaustive)}`
    }
  }
}

/**
 * Format a wall-clock timestamp as a short relative string ("3s ago",
 * "2m ago", "1h ago"). Falls back to ISO date string for entries older
 * than 24 hours so the operator can still tell which day a stuck-model
 * session originally went sideways.
 */
function formatRelativeTimestamp(ts: number): string {
  const elapsedMs = Date.now() - ts
  if (elapsedMs < 0) return 'just now'
  const seconds = Math.floor(elapsedMs / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(ts).toISOString().slice(0, 10)
}
