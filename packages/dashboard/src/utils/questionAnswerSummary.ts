/**
 * #4622 / #4621 — pure helper that turns a `QuestionPrompt` onSelect
 * answer payload into the one-line summary string that App.tsx hands to
 * `markPromptAnswered`. The summary surfaces on the collapsed
 * post-answer chip after the user submits the form.
 *
 * Two answer shapes flow through here:
 *
 * 1. `string` — the legacy single-question / free-text path. Returned
 *    verbatim.
 * 2. `Record<string, string | string[]>` — the multi-question form path
 *    (#4604 Chunk B, widened in #4621 / #4735). One entry per question,
 *    keyed by question text. Multi-select values arrive as native
 *    `string[]` (#4621) via the widened wire
 *    (`UserQuestionResponseSchema` accepts `string | string[]` per
 *    question). The summary helper pretty-prints those arrays as
 *    `App, Tests` instead of `["App","Tests"]` JSON syntax.
 *
 *    For back-compat with payloads sent by older dashboards still using
 *    the pre-#4621 wire shape (`Record<string,string>` with the array
 *    JSON-stringified into a single string), a JSON-stringified array
 *    value is also detected and flattened the same way. Non-array JSON
 *    shapes (objects, numbers) keep their raw stringified form — the
 *    form only ever produced array JSON, so anything else didn't come
 *    from us and we'd rather surface it as-is than mangle it.
 */

/**
 * Pretty-print a single answer value:
 *  - `string[]`   → comma-joined labels (native #4621 path).
 *  - `'[...]'`    → parsed as JSON; if it's an array, joined; else returned as-is.
 *  - anything else → returned unchanged.
 */
function formatAnswerValue(value: string | string[]): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ')
  // Cheap pre-check to avoid JSON.parse-ing every short-string answer.
  if (!value.startsWith('[')) return value
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return value
  }
  if (!Array.isArray(parsed)) return value
  return parsed.map((item) => String(item)).join(', ')
}

export function formatQuestionAnswerSummary(
  answer: string | Record<string, string | string[]>,
): string {
  if (typeof answer === 'string') return answer
  return Object.entries(answer)
    .map(([question, value]) => `${question}: ${formatAnswerValue(value)}`)
    .join(' | ')
}
