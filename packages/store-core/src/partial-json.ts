/**
 * Cheap structural gate for `JSON.parse` on a partial-JSON buffer (#4242).
 *
 * `tool_input_delta` streams (#4081) append chunks of a JSON-encoded tool
 * input to an accumulator. The ToolBubble renderers try `JSON.parse` on
 * that growing accumulator on every delta so the buffer pretty-prints
 * as soon as the final chunk lands. For a Bash `command` assembled
 * across N chunks, that's N parses guaranteed to throw until the last
 * one — small cost each but easy to amortise.
 *
 * `tryParseCompleteJson` runs a cheap structural check first: a partial
 * JSON document cannot be complete unless its non-whitespace tail is
 * `}` or `]`. If the tail fails that check we skip the parse entirely
 * and return `undefined`. If the tail passes, we still wrap the parse
 * in try/catch — the gate is a fast reject, NOT a validator (e.g.
 * `"foo}"` ends in `}` but isn't valid JSON; an unterminated string
 * that happens to contain a `}` would also pass the gate).
 *
 * Trade-off: one `trim` + `endsWith` per delta against N-1 `JSON.parse`
 * throws on long streams. Noticeable for chatty Bash/Edit inputs.
 *
 * Note: we deliberately do NOT support top-level JSON scalars
 * (`"string"`, `42`, `true`). Tool inputs are always objects or
 * arrays in practice, and including scalars would defeat the gate.
 */
export function tryParseCompleteJson(buffer: string): unknown | undefined {
  if (!buffer) return undefined
  // `trimEnd` is enough: leading whitespace is rare in tool-input deltas
  // and an opening `{`/`[` doesn't gate the parse anyway.
  const trimmed = buffer.trimEnd()
  if (trimmed.length === 0) return undefined
  const last = trimmed.charCodeAt(trimmed.length - 1)
  // 0x7D = '}', 0x5D = ']'
  if (last !== 0x7d && last !== 0x5d) return undefined
  try {
    return JSON.parse(buffer)
  } catch {
    return undefined
  }
}
