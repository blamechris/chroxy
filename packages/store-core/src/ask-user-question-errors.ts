/**
 * Retryable AskUserQuestion error codes (#5793).
 *
 * `packages/server/src/claude-tui/form-driver.js` tears down a wedged
 * AskUserQuestion prompt by emitting `error{code, toolUseId}` whose copy ends
 * in "Tap Retry to resend your request." The long-handled
 * `ASK_USER_QUESTION_STALL` (#4614) was the first such code; the multi-select /
 * multi-question denial path now emits five more with the same shape and the
 * same "Tap Retry" affordance in their copy:
 *   - ASK_USER_QUESTION_MULTISELECT_UNSUPPORTED
 *   - ASK_USER_QUESTION_MULTISELECT_UNAVAILABLE
 *   - ASK_USER_QUESTION_MULTISELECT_EMPTY
 *   - ASK_USER_QUESTION_MULTISELECT_BUSY
 *   - ASK_USER_QUESTION_MULTI_QUESTION_UNSUPPORTED
 *
 * Both clients originally hard-coded `=== 'ASK_USER_QUESTION_STALL'` for the
 * stall-chip / retry path, so the five new codes fell through to a generic red
 * error bubble with no retry control — a dead promise. This module is the
 * single source of truth for "is this an AskUserQuestion error that the user
 * can recover from by resending their original request?" Both the shared
 * `buildChatViewMessages` stalled-prompt suppression and the per-client
 * retry-chip renderers narrow off this predicate, so adding a future code is a
 * one-line change here that lights up the retry UX everywhere.
 */

/**
 * The set of AskUserQuestion teardown error codes that carry a "Tap Retry to
 * resend your request" affordance. Typed as `ReadonlySet` so TS consumers can't
 * `.add()`/`.delete()` it — the runtime Set is not actually frozen (Object.freeze
 * doesn't lock a Set's contents), so treat it as immutable by contract. Prefer
 * `isRetryableAskUserQuestionError()` over reaching into the set directly.
 */
export const RETRYABLE_ASK_USER_QUESTION_ERROR_CODES: ReadonlySet<string> =
  new Set([
    'ASK_USER_QUESTION_STALL',
    'ASK_USER_QUESTION_MULTISELECT_UNSUPPORTED',
    'ASK_USER_QUESTION_MULTISELECT_UNAVAILABLE',
    'ASK_USER_QUESTION_MULTISELECT_EMPTY',
    'ASK_USER_QUESTION_MULTISELECT_BUSY',
    'ASK_USER_QUESTION_MULTI_QUESTION_UNSUPPORTED',
  ])

/**
 * True when `code` is an AskUserQuestion teardown error whose copy ends in
 * "Tap Retry to resend your request." — i.e. the prompt is dead but the user
 * can recover by resending. Renderers route these through the stall-chip /
 * retry path; `buildChatViewMessages` adds the invalidated prompt's id to
 * `stalledPromptIds` so the now-dead interactive prompt is suppressed.
 *
 * Returns false for `undefined` / `null` / unrelated codes.
 */
export function isRetryableAskUserQuestionError(
  code: string | null | undefined,
): boolean {
  return code != null && RETRYABLE_ASK_USER_QUESTION_ERROR_CODES.has(code)
}
