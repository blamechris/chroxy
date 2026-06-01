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
 *    (#4604 Chunk B). One entry per question, keyed by question text.
 *    Multi-select values arrive as native `string[]` (#4621) and are
 *    pretty-printed as comma-joined labels (`App, Tests`) instead of
 *    `["App","Tests"]` JSON syntax.
 *
 *    For back-compat with payloads sent by older dashboards still using
 *    the pre-#4621 wire shape, a JSON-stringified array value is also
 *    detected and flattened the same way. Non-array JSON shapes
 *    (objects, numbers) keep their raw stringified form — the form only
 *    ever produced array JSON, so anything else didn't come from us and
 *    we'd rather surface it as-is than mangle it.
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
  answer: string | Record<string, string | string[]> | { otherLabel: string; freeformText: string },
): string {
  if (typeof answer === 'string') return answer
  // #4651 — single-question Other / freeform path. The summary chip
  // should surface the typed text (what the user actually wrote), not
  // the literal label "Other" — matching the post-answer UX of the
  // free-text-only path (#1245) where the typed text becomes the
  // chip content directly.
  //
  // Copilot review (#4753): tight detection — require EXACTLY two keys
  // (`freeformText` + `otherLabel`) AND string values for both. A
  // multi-question Record whose question keys happen to be those exact
  // strings would otherwise misclassify here.
  if (
    !Array.isArray(answer)
    && Object.keys(answer).length === 2
    && 'freeformText' in answer && 'otherLabel' in answer
    && typeof (answer as Record<string, unknown>).freeformText === 'string'
    && typeof (answer as Record<string, unknown>).otherLabel === 'string'
  ) {
    return (answer as { freeformText: string }).freeformText
  }
  return Object.entries(answer as Record<string, string | string[]>)
    .map(([question, value]) => `${question}: ${formatAnswerValue(value)}`)
    .join(' | ')
}
