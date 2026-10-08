/**
 * Turn outcomes (#7326): how a TURN ended, as the `result` frame says it.
 *
 * Providers end a turn with their own signal (an ACP `StopReason`, an
 * Anthropic `stop_reason`, an Agent SDK result subtype). Before #7326 every one
 * was discarded, so a reply cut off by a token limit or refused by the model
 * reached the clients as a plain successful `result` -- indistinguishable from a
 * finished one. The server maps each provider's signal onto this closed,
 * provider-neutral vocabulary (`packages/server/src/turn-outcome.js`) and the
 * clients word it from here, so the dashboard and the mobile app cannot drift.
 *
 * NOT to be confused with `TurnTerminationReason` (`./turn-termination.ts`,
 * #7376): that stamps a TOOL call whose turn was ended underneath it. This
 * describes the turn itself. Nor with a provider's raw `stopReason` /
 * `stop_reason` string, which is the input to the mapping, never the output.
 *
 * Zod-free on purpose (like turn-termination.ts): browser-safe and importable
 * from the Zod-free subpaths.
 *
 *  - `completed` -- the model finished on its own. Renders nothing.
 *  - `truncated` -- cut short by a limit (tokens, turns, budget, context).
 *  - `refused`   -- the model declined to answer.
 *  - `stopped`   -- the turn was cancelled.
 *
 * Append-only: every value is a wire contract. An absent field means the
 * provider did not say, which clients treat like `completed`: no marker.
 */
export const TURN_OUTCOMES = ['completed', 'truncated', 'refused', 'stopped'] as const

export type TurnOutcome = (typeof TURN_OUTCOMES)[number]

/** The outcomes a client marks in the transcript. `completed` is not one. */
export type MarkedTurnOutcome = Exclude<TurnOutcome, 'completed'>

const OUTCOME_SET: ReadonlySet<string> = new Set(TURN_OUTCOMES)

/** Narrow an arbitrary value to a known {@link TurnOutcome}. */
export function isTurnOutcome(value: unknown): value is TurnOutcome {
  return typeof value === 'string' && OUTCOME_SET.has(value)
}

/**
 * Narrow to an outcome that deserves a visible marker. Unknown values (a newer
 * server's) and `completed` both answer false: a client never invents a marker
 * for a reason it cannot word.
 */
export function isMarkedTurnOutcome(value: unknown): value is MarkedTurnOutcome {
  return isTurnOutcome(value) && value !== 'completed'
}

/** What a client shows for a turn that did not complete normally. */
export interface TurnOutcomeDescription {
  /** Short label for the chip, e.g. `Reply cut off`. */
  label: string
  /** One sentence for the chip's tooltip / accessibility label. */
  detail: string
}

const DESCRIPTIONS: Record<MarkedTurnOutcome, TurnOutcomeDescription> = {
  truncated: {
    label: 'Reply cut off',
    detail: 'The turn hit a limit (tokens, turns or budget) before it finished, so the reply may be incomplete.',
  },
  refused: {
    label: 'The model declined',
    detail: 'The model refused to answer this request.',
  },
  stopped: {
    label: 'Stopped',
    detail: 'This turn was stopped before it finished.',
  },
}

/** Wording for a marked outcome; `null` for anything that gets no marker. */
export function describeTurnOutcome(outcome: unknown): TurnOutcomeDescription | null {
  return isMarkedTurnOutcome(outcome) ? DESCRIPTIONS[outcome] : null
}
