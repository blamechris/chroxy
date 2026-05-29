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
}

export function StreamStallChip({ errorText, onRetry }: StreamStallChipProps) {
  const handleClick = useCallback(() => {
    onRetry?.()
  }, [onRetry])

  return (
    <div
      className="stream-stall-chip"
      data-testid="stream-stall-chip"
      role="status"
      title={errorText}
    >
      <span className="stream-stall-chip-text">Stream stalled — retry?</span>
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
