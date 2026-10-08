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
 * separately. When one of them is over the cap on its own, its fields are
 * sanitised one by one, so the fields that did not cause the overflow
 * (`multiSelect`, `header`, a label) survive and the oversized text is clipped
 * after it is redacted.
 *
 * Option labels are the key an answer is matched on (the label the client was
 * shown comes back and is looked up among the stored options). Two labels that
 * differed only in a secret both redact to the same text, so a collision is
 * broken with a position suffix, `[REDACTED] (2)`, and the stored copy carries
 * the same unique labels the client sees.
 */
import { sanitizeToolInput, redactBounded } from '../redaction.js'

const TRUNCATED_MARKER = '... [truncated]'
const TOO_LARGE = '[too large to display]'

// A text field that alone overflows the cap: redact first, then clip. The
// bounded scan drops everything from the last whitespace before its limit, and
// a text with no whitespace at all comes back empty, so say so instead of
// showing nothing.
function clipText(text) {
  const redacted = redactBounded(text)
  if (redacted.length === 0 && text.length > 0) return TOO_LARGE
  return text.length > redacted.length && text.length > 8192 ? redacted + TRUNCATED_MARKER : redacted
}

// `sanitizeToolInput` on one object. Over the cap it answers with a
// `{ _truncated, summary }` wrapper that has none of the object's fields, so
// redo it field by field and keep the ones that fit.
function sanitizeFields(obj) {
  const whole = sanitizeToolInput(obj)
  if (!(whole && typeof whole === 'object' && whole._truncated === true)) return whole
  const out = {}
  for (const [key, value] of Object.entries(obj)) {
    const one = sanitizeToolInput({ [key]: value })
    if (one && one._truncated === true) {
      out[key] = typeof value === 'string' ? clipText(value) : TOO_LARGE
    } else {
      out[key] = one[key]
    }
  }
  return out
}

function sanitizeOption(option) {
  if (typeof option === 'string') return clipText(option)
  if (!option || typeof option !== 'object' || Array.isArray(option)) return option
  return sanitizeFields(option)
}

function sanitizeQuestion(question) {
  if (typeof question === 'string') return clipText(question)
  if (!question || typeof question !== 'object' || Array.isArray(question)) return question
  if (!Array.isArray(question.options)) return sanitizeFields(question)
  const { options, ...rest } = question
  const out = sanitizeFields(rest)
  out.options = uniqueLabels(options, options.map(sanitizeOption))
  return out
}

// Break a label collision that sanitising CREATED: two options whose raw labels
// differed but whose sanitised labels are now equal. Raw labels that were
// already identical are left alone (the first one wins, exactly as before).
function uniqueLabels(rawOptions, options) {
  const labelOf = (o) => (o && typeof o === 'object' && typeof o.label === 'string' ? o.label : null)
  const taken = new Set(options.map(labelOf).filter((l) => l !== null))
  const firstRaw = new Map()
  return options.map((option, i) => {
    const label = labelOf(option)
    if (label === null) return option
    const rawLabel = labelOf(rawOptions[i])
    if (!firstRaw.has(label)) {
      firstRaw.set(label, rawLabel)
      return option
    }
    if (firstRaw.get(label) === rawLabel) return option
    let n = 2
    while (taken.has(`${label} (${n})`)) n++
    const unique = `${label} (${n})`
    taken.add(unique)
    firstRaw.set(unique, rawLabel)
    return { ...option, label: unique }
  })
}

/**
 * @param {unknown[]} questions - `tool_input.questions` from the hook payload
 * @returns {unknown[]} a redacted, capped copy; the input is not mutated
 */
export function sanitizeQuestionsForClients(questions) {
  return Array.isArray(questions) ? questions.map(sanitizeQuestion) : []
}
