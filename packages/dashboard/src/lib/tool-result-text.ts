/**
 * tool-result-text — unwrap a tool-result payload into human-readable text.
 *
 * #5778: the Output tab (simulated terminal) was dumping the raw JSON envelope
 * of a tool result, e.g. `{"stdout":"total 0\n...","stderr":"",...}`, instead
 * of the stdout text rendered as terminal lines. A tool result reaches the
 * client as a plain string, but for shell-style tools (Bash, etc.) that string
 * is itself a JSON-stringified `{ stdout, stderr, ... }` envelope.
 *
 * `unwrapToolResultText` normalises any of those shapes back to the text a
 * terminal should show:
 *   - already-plain strings pass through unchanged
 *   - JSON objects with stdout/stderr render those streams (stderr appended)
 *   - anything else falls back to a sensible string (never throws)
 */

function streamsToText(obj: Record<string, unknown>): string | null {
  const hasStdout = typeof obj.stdout === 'string'
  const hasStderr = typeof obj.stderr === 'string'
  if (!hasStdout && !hasStderr) return null
  const parts: string[] = []
  if (hasStdout && obj.stdout !== '') parts.push(obj.stdout as string)
  if (hasStderr && obj.stderr !== '') parts.push(obj.stderr as string)
  return parts.join('\n')
}

/**
 * Unwrap a tool-result string for terminal-style display. Returns the
 * human-readable text; never throws.
 */
export function unwrapToolResultText(resultText: string): string {
  if (typeof resultText !== 'string') return String(resultText ?? '')

  const trimmed = resultText.trim()
  // Only attempt a parse when it looks like a JSON object — avoids munging
  // plain output that happens to start with a brace-like character.
  if (!trimmed.startsWith('{')) return resultText

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return resultText
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return resultText
  }

  const text = streamsToText(parsed as Record<string, unknown>)
  // Recognised stdout/stderr envelope → render the streams. Otherwise the
  // object isn't a shell-result shape; leave the original string untouched.
  return text === null ? resultText : text
}
