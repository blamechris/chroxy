/**
 * tool-result-text — unwrap a tool-result payload into human-readable text.
 *
 * #5778: the Output tab (simulated terminal) was dumping the raw JSON envelope
 * of a tool result, e.g. `{"stdout":"total 0\n...","stderr":"",...}`, instead
 * of the stdout text rendered as terminal lines. A tool result reaches the
 * client as a plain string, but for shell-style tools (Bash, etc.) that string
 * is itself a JSON-stringified `{ stdout, stderr, ... }` envelope.
 *
 * #5800: hoisted from `packages/dashboard/src/lib/tool-result-text.ts` into
 * store-core (next to the other shared parsers like `partial-json.ts`) so the
 * app gains the same tool-result-envelope unwrap as the dashboard. Zero
 * behavior change for the dashboard.
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
  const stdout = hasStdout && obj.stdout !== '' ? (obj.stdout as string) : ''
  const stderr = hasStderr && obj.stderr !== '' ? (obj.stderr as string) : ''
  if (!stdout) return stderr
  if (!stderr) return stdout
  // Append stderr directly after stdout, mirroring a real terminal. Only insert
  // a separating newline when stdout doesn't already end in one, so shell output
  // that ends with a trailing newline doesn't gain a spurious blank line.
  const sep = stdout.endsWith('\n') ? '' : '\n'
  return stdout + sep + stderr
}

/**
 * Unwrap a tool-result payload for terminal-style display. Returns the
 * human-readable text; never throws. Accepts `unknown` because callers forward
 * loosely-typed wire values — non-string inputs are coerced to a safe string.
 */
export function unwrapToolResultText(resultText: unknown): string {
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
