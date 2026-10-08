/**
 * Provider-neutral turn outcome (#7326).
 *
 * Every provider ends a turn with some provider-specific signal (an ACP
 * `StopReason`, an Anthropic `stop_reason`, an Agent SDK result subtype). Before
 * #7326 all of them were discarded: a turn that hit the token ceiling, ran out
 * of its request budget or was refused by the model reached the clients as a
 * plain successful `result`, indistinguishable from a finished one.
 *
 * Not to be confused with `terminatedReason` (#7376, @chroxy/protocol's
 * turn-termination.ts): that stamps a TOOL call whose turn was ended underneath
 * it. This describes how the TURN ended. The name also stays clear of the raw
 * provider `stopReason` / `stop_reason` strings this module maps FROM (ACP,
 * Anthropic, and BYOK's own `result.stopReason`).
 *
 * This module is the ONE place those signals are mapped onto the four-value
 * vocabulary that rides the `result` wire frame (`turnOutcome`):
 *
 *   completed — the model finished on its own.
 *   truncated — the turn was cut short by a limit (tokens, turns, budget, context).
 *   refused   — the model declined to answer.
 *   stopped   — the turn was cancelled.
 *
 * Every mapper returns `undefined` for a signal it does not recognise. The
 * field is then OMITTED from the wire, which clients read as "unknown" and
 * render as nothing, rather than a fabricated `completed`.
 */

import { TURN_OUTCOMES, isTurnOutcome } from '@chroxy/protocol'

// The vocabulary and its wording are single-sourced in @chroxy/protocol (the
// clients word the same values); this module only maps provider signals onto it.
export { TURN_OUTCOMES, isTurnOutcome }

/**
 * ACP `StopReason` (the closed set in the SDK's schema.json `$defs.StopReason`).
 * @param {unknown} stopReason
 * @returns {'completed'|'truncated'|'refused'|'stopped'|undefined}
 */
export function outcomeFromAcpStopReason(stopReason) {
  switch (stopReason) {
    case 'end_turn': return 'completed'
    case 'max_tokens':
    case 'max_turn_requests': return 'truncated'
    case 'refusal': return 'refused'
    case 'cancelled': return 'stopped'
    default: return undefined
  }
}

/**
 * Anthropic Messages API `stop_reason` — also what the Agent SDK's result
 * message and the BYOK loop carry. `tool_use` is deliberately unmapped: a turn
 * is not over while the model is waiting on a tool.
 *
 * Two values are not what their names suggest (checked against
 * `StopReason` / `Message.stop_reason` in @anthropic-ai/sdk 0.91.1's
 * resources/messages/messages.d.ts, #8461):
 *
 *   pause_turn    — "we paused a long-running turn. You may provide the response
 *                   back as-is in a subsequent request to let the model continue."
 *                   The model has NOT finished; a client has to resume it. Neither
 *                   BYOK's loop nor the SDK result path does, so the user is left
 *                   holding a half reply: `truncated`, never `completed`.
 *   stop_sequence — one of the request's own `stop_sequences` was generated, so
 *                   the model stopped where it was told to: `completed`. We send
 *                   no `stop_sequences`, so a genuine one does not occur today.
 *                   The one place it does appear is the OpenAI-compatible shim,
 *                   which folds `content_filter` into it (anthropic-openai-
 *                   translate.js `mapFinishReason`); that path reads as
 *                   `completed` here, a known gap listed in #8461 and left
 *                   unmapped on purpose because a filter is not a clear refusal.
 * @param {unknown} stopReason
 * @returns {'completed'|'truncated'|'refused'|'stopped'|undefined}
 */
export function outcomeFromAnthropicStopReason(stopReason) {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence': return 'completed'
    case 'max_tokens':
    case 'pause_turn':
    case 'model_context_window_exceeded': return 'truncated'
    case 'refusal': return 'refused'
    default: return undefined
  }
}

/**
 * BYOK turn. Same mapping as {@link outcomeFromAnthropicStopReason}, except a
 * turn that spent MAX_TOOL_ROUNDS is `truncated` whatever the summary round
 * said: the forced no-tools summary ends with an ordinary `end_turn`, which
 * overwrites the loop's own stop reason and read as a clean finish (#8461). The
 * work was cut off by the round cap; the summary only reports how far it got.
 * @param {{ stopReason?: unknown, toolRoundCapReached?: boolean }} turn
 * @returns {'completed'|'truncated'|'refused'|'stopped'|undefined}
 */
export function outcomeFromByokTurn({ stopReason, toolRoundCapReached = false } = {}) {
  // A refusal in the summary round still outranks the cap: it is the more specific fact.
  const mapped = outcomeFromAnthropicStopReason(stopReason)
  if (toolRoundCapReached && (mapped === undefined || mapped === 'completed')) return 'truncated'
  return mapped
}

/**
 * Agent SDK `result` message (SDKResultSuccess / SDKResultError). The loop-level
 * signals outrank the API `stop_reason`: `error_max_turns` ends a turn whose last
 * API stop_reason was an ordinary `tool_use`.
 * @param {{ subtype?: unknown, stop_reason?: unknown, terminal_reason?: unknown }|null|undefined} msg
 * @returns {'completed'|'truncated'|'refused'|'stopped'|undefined}
 */
export function outcomeFromSdkResult(msg) {
  if (!msg || typeof msg !== 'object') return undefined
  if (msg.subtype === 'error_max_turns' || msg.terminal_reason === 'max_turns') return 'truncated'
  if (msg.subtype === 'error_max_budget_usd') return 'truncated'
  if (msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools') return 'stopped'
  const mapped = outcomeFromAnthropicStopReason(msg.stop_reason)
  // A failed run (`error_during_execution`, an `is_error` result) can still carry
  // an ordinary `end_turn` from the last API call that DID complete. That is not
  // a clean finish, so `completed` is withheld there; a limit or refusal stands.
  const failed = msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype !== 'success')
  return failed && mapped === 'completed' ? undefined : mapped
}

/**
 * Spread-ready field for a `result` payload: `{ turnOutcome }` for a known
 * reason, `{}` otherwise, so an unmapped signal leaves the key off entirely.
 * @param {unknown} reason
 * @returns {{ turnOutcome?: 'completed'|'truncated'|'refused'|'stopped' }}
 */
export function turnOutcomeField(reason) {
  return isTurnOutcome(reason) ? { turnOutcome: reason } : {}
}
