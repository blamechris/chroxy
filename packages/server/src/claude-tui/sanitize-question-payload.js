/**
 * #8373 -- the AskUserQuestion payload claude-tui lifts out of a PreToolUse
 * hook and hands to clients (live `user_question`, the history ring buffer, the
 * pending-question replay).
 *
 * It used to go out exactly as the hook wrote it: a secret-shaped string in the
 * question text, a header, or an option reached every client of the session
 * unredacted and uncapped. Every string now goes through the shared
 * `redaction.js` floor (`sanitizeToolInput`: key and value redaction plus the
 * per-string / whole-object cap), the same floor the tool_start input takes.
 *
 * The shape is preserved on purpose. `questions` stays an array of
 * `{ question, header, options: [{ label, description }], multiSelect }`, because
 * the dashboard renders it and the form driver counts options and matches the
 * label a client sends back. Running the whole array through
 * `sanitizeToolInput` would replace it with a `{ _truncated, summary }` object
 * as soon as it passed the cap, so each question and each option is sanitised
 * separately and an oversized piece degrades to its own text field instead.
 */
import { sanitizeToolInput, redactBounded } from '../redaction.js'

// `sanitizeToolInput` answers an over-cap object with `{ _truncated, summary }`.
// Keep the piece usable by putting the (already redacted, capped) summary back
// under the field the renderer reads.
function unwrapTruncated(sanitized, field) {
  if (sanitized && typeof sanitized === 'object' && sanitized._truncated === true && typeof sanitized.summary === 'string') {
    return { [field]: sanitized.summary }
  }
  return sanitized
}

function sanitizeOption(option) {
  if (typeof option === 'string') return redactBounded(option)
  if (!option || typeof option !== 'object' || Array.isArray(option)) return option
  return unwrapTruncated(sanitizeToolInput(option), 'label')
}

function sanitizeQuestion(question) {
  if (typeof question === 'string') return redactBounded(question)
  if (!question || typeof question !== 'object' || Array.isArray(question)) return question
  if (!Array.isArray(question.options)) return unwrapTruncated(sanitizeToolInput(question), 'question')
  const { options, ...rest } = question
  const out = unwrapTruncated(sanitizeToolInput(rest), 'question')
  out.options = options.map(sanitizeOption)
  return out
}

/**
 * @param {unknown[]} questions - `tool_input.questions` from the hook payload
 * @returns {unknown[]} a redacted, capped copy; the input is not mutated
 */
export function sanitizeQuestionsForClients(questions) {
  return Array.isArray(questions) ? questions.map(sanitizeQuestion) : []
}
