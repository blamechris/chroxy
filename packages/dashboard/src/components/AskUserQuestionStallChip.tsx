/**
 * AskUserQuestionStallChip — #4615
 *
 * Replaces the generic red error toast when the server emits
 * `error{code: 'ASK_USER_QUESTION_STALL'}` (server PR #4614). The server
 * fires this code when the Claude TUI never acknowledges an AskUserQuestion
 * answer — typically a multi-question form wedge where the keystroke
 * driver can't reliably deliver answers to the combined form.
 *
 * Signals "recoverable, just resend your request" rather than "something
 * is broken" via a distinct chip affordance, and provides a one-tap retry
 * button that re-sends the last user message. The full server error text
 * remains accessible via the title attribute so diagnostics aren't lost —
 * operators investigating a wedge pattern can hover for the underlying
 * message.
 *
 * Mirrors StreamStallChip (#4476). Distinct testID + headline copy so
 * E2E tests can target the correct affordance, but reuses the
 * `stream-stall-chip` CSS classes (amber-warning palette already conveys
 * "recoverable" — adding a second nearly-identical class set would just
 * duplicate the theme tokens for no UX benefit).
 */
import { useCallback } from 'react'

export interface AskUserQuestionStallChipProps {
  /** The raw error text from the server (action-oriented copy, currently
   *  "Couldn't deliver your answers. Tap Retry to resend your original
   *  request."). */
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

export function AskUserQuestionStallChip({ errorText, onRetry }: AskUserQuestionStallChipProps) {
  const handleClick = useCallback(() => {
    onRetry?.()
  }, [onRetry])

  return (
    <div
      className="stream-stall-chip"
      data-testid="ask-user-question-stall-chip"
      role="status"
      title={errorText}
    >
      <span className="stream-stall-chip-text">Question delivery failed — retry?</span>
      {onRetry && (
        <button
          type="button"
          className="stream-stall-chip-retry"
          data-testid="ask-user-question-stall-chip-retry"
          onClick={handleClick}
        >
          Retry
        </button>
      )}
    </div>
  )
}
