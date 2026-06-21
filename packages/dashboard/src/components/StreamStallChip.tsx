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
 *
 * #4603 — polish: per-provider short label in the headline (so the
 * operator can tell at a glance which stack stalled) and an optional
 * "View logs" affordance that hands off to the host app (the dashboard
 * wires it to `setViewMode('system')`).
 */
import { useCallback } from 'react'
import { formatDurationVerbose, getProviderInfo } from '@chroxy/store-core'

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
  /**
   * #4603 — the active session's provider name (e.g. `'claude-sdk'`,
   * `'claude-cli'`, `'claude-tui'`, `'codex'`, `'gemini'`). When
   * provided, the chip prefixes the headline with the provider's short
   * label (e.g. "SDK · No response for 5 minutes — retry?") so operators
   * triaging recurring stalls can tell at a glance which stack is
   * responsible. Different providers stall for qualitatively different
   * reasons — SDK half-open HTTPS to the Anthropic API, CLI subprocess
   * pipe wedge, TUI PTY back-pressure — and the prefix avoids forcing
   * the operator to dig through logs to correlate.
   *
   * Whitespace-only and empty strings are treated as omitted so a stale
   * store value can't degrade the headline. Unknown providers fall
   * through `getProviderInfo`'s uppercase fallback (shared with the
   * mobile app via `@chroxy/store-core/provider-labels`).
   */
  provider?: string
  /**
   * #4603 — optional callback invoked when the user taps the "View logs"
   * affordance. The chip stays decoupled from view-mode plumbing: the
   * dashboard wires this to `setViewMode('system')` so the session's
   * surrounding context surfaces in the System pane; the mobile app
   * can wire it differently or omit it entirely. When omitted, the
   * button is not rendered at all (no dangling affordance on hosts
   * without a logs view).
   */
  onViewLogs?: () => void
}

// #4497 — verbose duration humaniser tailored for the stall headline copy.
// #4510 / #6201 — implementation now lives in `@chroxy/store-core`
// (`formatDurationVerbose`), shared with any other prose-register consumer.
// Headline copy still reads "No response for ${verbose(ms)} — retry?".

export function StreamStallChip({
  errorText,
  onRetry,
  timeoutMs,
  provider,
  onViewLogs,
}: StreamStallChipProps) {
  const handleRetry = useCallback(() => {
    onRetry?.()
  }, [onRetry])

  const handleViewLogs = useCallback(() => {
    onViewLogs?.()
  }, [onViewLogs])

  // #4497: humanise only when the server actually advertised a usable
  // window. Guard against 0 (explicitly disabled, per protocol) and
  // non-finite values so a malformed auth_ok can't degrade the UI.
  const body =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? `No response for ${formatDurationVerbose(timeoutMs)} — retry?`
      : 'Stream stalled — retry?'

  // #4603: prefix the body with the provider short label (e.g. "SDK · ")
  // only when the prop is a non-empty, non-whitespace string. An empty
  // or whitespace value would render as a stray "· " separator with no
  // label, which is worse than no prefix at all.
  const providerShort =
    typeof provider === 'string' && provider.trim().length > 0
      ? getProviderInfo(provider.trim()).short
      : null
  const headline = providerShort ? `${providerShort} · ${body}` : body

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
          onClick={handleRetry}
        >
          Retry
        </button>
      )}
      {onViewLogs && (
        <button
          type="button"
          className="stream-stall-chip-view-logs"
          data-testid="stream-stall-chip-view-logs"
          onClick={handleViewLogs}
        >
          View logs
        </button>
      )}
    </div>
  )
}
