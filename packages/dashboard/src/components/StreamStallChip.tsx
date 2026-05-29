/**
 * StreamStallChip — #4476
 *
 * Replaces the generic red error bubble when the server emits
 * `error{code: 'stream_stall'}` (server PR #4475). Signals "recoverable,
 * just retry" rather than "something is broken" via a distinct chip
 * affordance, and provides a one-tap retry button that re-sends the last
 * user message.
 *
 * The full error text remains accessible via the title attribute so
 * diagnostics aren't lost — operators investigating a stall pattern can
 * hover for the underlying server message.
 */
import { useCallback } from 'react'

export interface StreamStallChipProps {
  /** The raw error text from the server (e.g. "Stream stalled — no response for 5 minutes"). */
  errorText: string
  /**
   * Invoked when the user taps Retry. Caller is responsible for resending
   * the last user message — the chip itself doesn't know which message to
   * resend. Setting this to undefined hides the retry button (e.g. for
   * historical entries replayed from session_messages where the original
   * user input is no longer the obvious target).
   */
  onRetry?: () => void
  /**
   * #4497 — the server's configured stream-stall inactivity window in ms,
   * as advertised on `auth_ok` (server PR #4483 / #4477). When provided,
   * the chip swaps the generic "Stream stalled — retry?" phrase for the
   * more informative "No response for ${humanize(ms)} — retry?" so the
   * user knows the actual timeout that elapsed.
   *
   * Falls back to the static phrase when omitted, zero, or non-finite —
   * older servers omit the field, and a malformed value should never
   * produce "No response for NaN minutes" garbage in the UI.
   *
   * The tooltip (raw server text) is unaffected; humanising is a headline
   * concern only.
   */
  timeoutMs?: number
}

/**
 * #4497 — verbose duration humaniser tailored for the stall headline copy.
 *
 * Returns "30 seconds", "1 minute", "5 minutes", "2 hours", etc. The terser
 * "5m" / "30s" form used by ActivityIndicator's `formatDuration` is wrong
 * for prose — we want the chip text to read naturally. Thresholds at 1s /
 * 1min / 1h keep the helper simple; rounding (Math.round) avoids "4 minutes"
 * for a 299_999ms window.
 */
function humanizeDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  const hours = Math.round(minutes / 60)
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

export function StreamStallChip({ errorText, onRetry, timeoutMs }: StreamStallChipProps) {
  const handleClick = useCallback(() => {
    onRetry?.()
  }, [onRetry])

  // #4497: humanise only when the server actually advertised a usable
  // window. Guard against 0 (explicitly disabled, per protocol) and
  // non-finite values so a malformed auth_ok can't degrade the UI.
  const headline =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? `No response for ${humanizeDuration(timeoutMs)} — retry?`
      : 'Stream stalled — retry?'

  return (
    <div
      className="stream-stall-chip"
      data-testid="stream-stall-chip"
      role="status"
      title={errorText}
    >
      <span className="stream-stall-chip-text">{headline}</span>
      {onRetry && (
        <button
          type="button"
          className="stream-stall-chip-retry"
          data-testid="stream-stall-chip-retry"
          onClick={handleClick}
        >
          Retry
        </button>
      )}
    </div>
  )
}
