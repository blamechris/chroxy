/**
 * TurnOutcomeMarker -- #7326
 *
 * The chip at the end of a turn that did not complete normally: the reply was
 * cut off by a limit (`truncated`), the model declined (`refused`), or the turn
 * was `stopped`. Before #7326 all three rendered exactly like a finished turn.
 *
 * Rendered by `useMessageRenderer` for the `type: 'system'` message that
 * store-core's `appendTurnOutcomeMarker` builds from the `result` frame's
 * `turnOutcome`. The wording is `describeTurnOutcome` from `@chroxy/protocol`
 * (re-exported by store-core), shared with the mobile app so the two cannot say
 * different things. A completed turn gets no message and so no chip.
 *
 * Deliberately non-interactive (a status line, `role="status"`), so the 44px
 * tap-target floor does not apply. The sentence in the tooltip / accessible
 * description says what the label means.
 */
import { describeTurnOutcome, TURN_OUTCOME_MARKER_TESTID } from '@chroxy/store-core'
import type { MarkedTurnOutcome } from '@chroxy/store-core'

export interface TurnOutcomeMarkerProps {
  outcome: MarkedTurnOutcome
}

export function TurnOutcomeMarker({ outcome }: TurnOutcomeMarkerProps) {
  const description = describeTurnOutcome(outcome)
  if (!description) return null
  return (
    <div
      className={`turn-outcome-marker turn-outcome-marker-${outcome}`}
      data-testid={TURN_OUTCOME_MARKER_TESTID}
      data-outcome={outcome}
      role="status"
      title={description.detail}
      aria-label={`${description.label}. ${description.detail}`}
    >
      <span className="turn-outcome-marker-icon" aria-hidden="true">{outcome === 'refused' ? '⊘' : outcome === 'stopped' ? '■' : '✂'}</span>
      <span className="turn-outcome-marker-text">{description.label}</span>
    </div>
  )
}
