/**
 * WorkingIndicator (#5953, epic #5951) — the in-chat "Claude is working" signal
 * shown at the streaming tail while a turn is in progress.
 *
 * Replaces the bare three-dot `ThinkingDots` with a labelled affordance so a
 * live turn reads as "Claude is actively doing something" rather than a static
 * view that could be mistaken for a hang. The label surfaces the current
 * activity — the in-flight tool ("Running Bash…") when one is running, else a
 * generic "Claude is working…". `ThinkingDots` is kept INSIDE so its animation +
 * `thinking-dots` test id are preserved for existing callers/tests.
 *
 * Presentational: the label is computed by the parent (App derives it from the
 * active session's in-flight tool via `findInFlightToolUse` + `formatToolName`)
 * and passed in, keeping ChatView store-free and unit-testable.
 */
import { ThinkingDots } from './ThinkingDots'

export const DEFAULT_WORKING_LABEL = 'Claude is working…'

export function WorkingIndicator({ label }: { label?: string }) {
  // role="status" + aria-live="polite" so a screen reader announces the working
  // state + current activity (the visual dots alone are invisible to AT). Polite
  // (not assertive) so it doesn't interrupt the streamed response being read.
  return (
    <div
      className="working-indicator"
      data-testid="working-indicator"
      role="status"
      aria-live="polite"
    >
      <ThinkingDots />
      <span className="working-label" data-testid="working-label">
        {label && label.length > 0 ? label : DEFAULT_WORKING_LABEL}
      </span>
    </div>
  )
}
