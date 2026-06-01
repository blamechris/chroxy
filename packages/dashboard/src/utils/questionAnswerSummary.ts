/**
 * #4622 — pure helper that turns a `QuestionPrompt` onSelect answer
 * payload into the one-line summary string that App.tsx hands to
 * `markPromptAnswered`. The summary surfaces on the collapsed
 * post-answer chip after the user submits the form.
 *
 * Two answer shapes flow through here:
 *
 * 1. `string` — the legacy single-question / free-text path. Returned
 *    verbatim.
 * 2. `Record<string, string | string[]>` — the multi-question form path
 *    (#4604 Chunk B, widened in #4735). One entry per question, keyed
 *    by question text. Multi-select values arrive as native `string[]`
 *    arrays via the post-#4735 wire (`UserQuestionResponseSchema`
 *    accepts `string | string[]` per question). The summary helper
 *    pretty-prints those arrays as `App, Tests`.
 *
 * Back-compat: pre-#4735 dashboards JSON-stringified multi-select
 * arrays into a single string (`["App","Tests"]`) so the wire shape
 * stayed `Record<string,string>`. The helper still recognises that
 * encoding and renders it the same way as the native-array form so
 * mixed-version rehydrated state stays readable. Non-array JSON shapes
 * (objects, numbers) are kept as their raw stringified form — only
 * arrays trigger the pretty-print path.
 */

/**
 * Pretty-print a single answer value. Arrays render as comma-joined
 * label lists (no brackets, no quotes); a JSON-stringified array string
 * (pre-#4735 wire) is parsed and rendered the same way; everything else
 * is returned unchanged.
 */
function formatAnswerValue(value: string | string[]): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(', ')
  }
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
