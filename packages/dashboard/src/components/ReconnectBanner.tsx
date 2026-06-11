/**
 * ReconnectBanner — connection lost notification with retry.
 *
 * Two modes:
 *  - **Plain message mode** (default): renders `message` (or a generic
 *    "Connection lost" fallback) plus the attempt counter. Used for ordinary
 *    reconnect attempts.
 *  - **Restart-countdown mode**: when `restartEtaMs`/`restartingSince` are
 *    supplied, renders a live `~M:SS` countdown plus a context line
 *    ("Graceful restart" / "Recovering from crash"), mirroring the mobile
 *    SessionScreen banner. `shutdownReason === 'shutdown'` shows a terminal
 *    "Server shut down" message with no countdown.
 *
 * The countdown ticks client-side on a 1s interval while the banner is
 * visible and is cleaned up on unmount / when restart state clears.
 */
import { useState, useEffect } from 'react'

export type ShutdownReason = 'restart' | 'shutdown' | 'crash' | null

export interface ReconnectBannerProps {
  visible: boolean
  attempt: number
  maxAttempts: number
  message?: string
  onRetry: () => void
  onStartServer?: () => void
  /**
   * Total restart ETA in milliseconds (from the server's health-check
   * `restartEtaMs`). When present together with `restartingSince`, the banner
   * renders restart-countdown mode instead of the plain-message mode.
   */
  restartEtaMs?: number | null
  /** Epoch ms when the restart began — the countdown anchor. */
  restartingSince?: number | null
  /**
   * Why the server is unavailable. `'restart'` → graceful, `'crash'`/null →
   * recovering, `'shutdown'` → terminal (no countdown).
   */
  shutdownReason?: ShutdownReason
}

/**
 * Compute the remaining whole seconds until the restart ETA, clamped at 0.
 * Returns null when restart state isn't populated.
 */
function computeRemaining(restartEtaMs: number | null | undefined, restartingSince: number | null | undefined): number | null {
  if (!restartEtaMs || restartEtaMs <= 0 || !restartingSince) return null
  const elapsed = Date.now() - restartingSince
  return Math.max(0, Math.ceil((restartEtaMs - elapsed) / 1000))
}

function formatCountdown(seconds: number): string {
  return `~${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function ReconnectBanner({
  visible,
  attempt,
  maxAttempts,
  message,
  onRetry,
  onStartServer,
  restartEtaMs,
  restartingSince,
  shutdownReason,
}: ReconnectBannerProps) {
  // Restart-countdown mode is active only when both the ETA and the anchor
  // timestamp are populated. `shutdownReason === 'shutdown'` is terminal and
  // shows no countdown even if an ETA is somehow present.
  const inRestartMode =
    !!restartEtaMs && restartEtaMs > 0 && !!restartingSince && shutdownReason !== 'shutdown'

  // Client-side ticking countdown. Mirrors the mobile SessionScreen effect:
  // recompute every second, clear the interval once it hits zero, and reset to
  // null whenever the banner leaves restart mode. Only runs while visible so a
  // hidden banner doesn't keep a timer alive.
  const [countdown, setCountdown] = useState<number | null>(() =>
    inRestartMode ? computeRemaining(restartEtaMs, restartingSince) : null,
  )
  useEffect(() => {
    if (!visible || !inRestartMode) {
      setCountdown(null)
      return
    }
    // `interval` is declared up front (not `const` in-block) so the first
    // synchronous `update()` — which runs before `setInterval` returns — can
    // safely call `clearInterval(interval)` if the ETA is already expired on
    // mount, instead of hitting a TDZ ReferenceError on the `const`.
    let interval: ReturnType<typeof setInterval> | undefined
    const update = () => {
      const remaining = computeRemaining(restartEtaMs, restartingSince)
      setCountdown(remaining)
      if (remaining != null && remaining <= 0 && interval !== undefined) clearInterval(interval)
    }
    update()
    interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [visible, inRestartMode, restartEtaMs, restartingSince])

  if (!visible) return null

  // Build the primary status line. Restart mode overrides the plain message.
  let statusText: string
  if (shutdownReason === 'shutdown') {
    statusText = 'Server shut down'
  } else if (inRestartMode && countdown != null && countdown > 0) {
    statusText = `Server restarting... ${formatCountdown(countdown)}`
  } else if (inRestartMode || message) {
    statusText = message || 'Server restarting...'
  } else {
    statusText = 'Connection lost. Reconnecting...'
  }

  // Context detail line, restart mode only. `'restart'` → graceful; a null /
  // `'crash'` reason → recovering. `'shutdown'` shows no detail.
  let detail: string | null = null
  if (inRestartMode) {
    if (shutdownReason === 'restart') detail = 'Graceful restart'
    else if (!shutdownReason || shutdownReason === 'crash') detail = 'Recovering from crash'
  }

  return (
    <div className="reconnect-banner" data-testid="reconnect-banner" role="status" aria-live="polite">
      <span className="reconnect-message">
        {statusText} (attempt {attempt}/{maxAttempts})
      </span>
      {detail && (
        <span className="reconnect-detail" data-testid="reconnect-detail">
          {detail}
        </span>
      )}
      {onStartServer && (
        <button
          className="btn-retry"
          data-testid="banner-start-server-button"
          onClick={onStartServer}
          type="button"
        >
          Start Server
        </button>
      )}
      <button
        className="btn-retry"
        data-testid="retry-button"
        onClick={onRetry}
        type="button"
      >
        Reconnect
      </button>
    </div>
  )
}
