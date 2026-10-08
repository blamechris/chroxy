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
export declare const TURN_OUTCOMES: readonly ["completed", "truncated", "refused", "stopped"];
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];
/** The outcomes a client marks in the transcript. `completed` is not one. */
export type MarkedTurnOutcome = Exclude<TurnOutcome, 'completed'>;
/** Narrow an arbitrary value to a known {@link TurnOutcome}. */
export declare function isTurnOutcome(value: unknown): value is TurnOutcome;
/**
 * Narrow to an outcome that deserves a visible marker. Unknown values (a newer
 * server's) and `completed` both answer false: a client never invents a marker
 * for a reason it cannot word.
 */
export declare function isMarkedTurnOutcome(value: unknown): value is MarkedTurnOutcome;
/** What a client shows for a turn that did not complete normally. */
export interface TurnOutcomeDescription {
    /** Short label for the chip, e.g. `Reply cut off`. */
    label: string;
    /** One sentence for the chip's tooltip / accessibility label. */
    detail: string;
}
/** Wording for a marked outcome; `null` for anything that gets no marker. */
export declare function describeTurnOutcome(outcome: unknown): TurnOutcomeDescription | null;
