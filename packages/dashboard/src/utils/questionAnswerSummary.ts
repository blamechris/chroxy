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
 * 2. `Record<string,string>` — the multi-question form path (#4604
 *    Chunk B). One entry per question, keyed by question text.
 *    Multi-select values arrive as JSON-stringified string arrays
 *    (see `MultiQuestionForm.handleSubmit` — the wire shape is
 *    `Record<string,string>`, and the server's `respondToQuestion`
 *    JSON.parse splits it back). The summary helper detects and
 *    pretty-prints those arrays as `App, Tests` instead of leaking
 *    `["App","Tests"]` JSON syntax into the UX copy.
 *
 * Non-array JSON shapes (objects, numbers) are kept as their raw
 * stringified form — `MultiQuestionForm` only ever JSON-encodes
 * arrays, so anything else didn't come from the form and we'd rather
 * surface it as-is than mangle it.
 */

/**
 * Pretty-print a single answer value. If the value parses as a JSON
 * array of primitives we render it as a comma-joined list (no
 * brackets, no quotes); otherwise the value is returned unchanged.
 */
function formatMultiSelectValue(value: string): string {
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
  answer: string | Record<string, string> | { otherLabel: string; freeformText: string },
): string {
  if (typeof answer === 'string') return answer
  // #4651 — single-question Other / freeform path. The summary chip
  // should surface the typed text (what the user actually wrote), not
  // the literal label "Other" — matching the post-answer UX of the
  // free-text-only path (#1245) where the typed text becomes the
  // chip content directly.
  if ('freeformText' in answer && 'otherLabel' in answer) {
    return (answer as { freeformText: string }).freeformText
  }
  return Object.entries(answer as Record<string, string>)
    .map(([question, value]) => `${question}: ${formatMultiSelectValue(value)}`)
    .join(' | ')
}
