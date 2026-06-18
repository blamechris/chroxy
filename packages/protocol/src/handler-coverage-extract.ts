/**
 * Shared static-parse extractor for the two clients' `message-handler.ts`
 * handler universes (#6021).
 *
 * BACKGROUND
 * ----------
 * Two guards static-parse the app + dashboard `message-handler.ts` sources to
 * derive "which message types does each client handle":
 *   - `packages/protocol/tests/handler-coverage.test.js` — the exhaustiveness
 *     guard (every ServerMessageType has *some* handler `case` or an explicit
 *     exclusion).
 *   - `packages/store-core/src/contract-fixtures/coverage-lint.test.ts` (#5619)
 *     — the both-clients no-new-drift fixture lint.
 *
 * Each used to carry its OWN regex. They drifted: the store-core copy was
 * STRICTER (its HANDLERS-map terminator was `\n}`, which a non-greedily matched
 * map containing a nested object literal truncates early, and its key matcher
 * was `[a-z_]+`). This module is the SINGLE source of truth both consume so
 * they can never diverge again, and it uses the more-permissive / correct parse.
 *
 * This file is intentionally dependency-free static text analysis — it imports
 * nothing from the protocol enum/schemas, so it stays cheap to import from both
 * the protocol `node --test` runner and the store-core vitest runner.
 */

/**
 * Extract `case '<type>':` clause labels from a handler source.
 *
 * The app handler dispatches purely through a `switch`, so this is its whole
 * universe; the dashboard handler also uses `case` clauses (plus, historically,
 * a `HANDLERS` map — see {@link extractHandlersMapKeys}).
 */
export function extractCaseTypes(src: string): Set<string> {
  return new Set([...src.matchAll(/case\s+'([a-z_]+)'/g)].map((m) => m[1]))
}

/**
 * Extract the keys of a `const HANDLERS: Record<string, Handler> = { ... }`
 * map from a handler source, if present.
 *
 * Why a brace-balanced scan instead of a single regex: the previous two copies
 * both terminated the map body with a non-greedy `[\s\S]*?` against either `}`
 * (protocol — stops at the FIRST `}`, truncating at a nested object literal) or
 * `\n}` (store-core — stops at the first newline-prefixed `}`, same failure
 * mode plus brittle to the closing brace's column/trailing tokens such as
 * `} as const` / `} satisfies …`). A balanced scan from the opening `{` to its
 * matching `}` parses the real map regardless of nested object values or how
 * the closing brace is decorated, then reads only TOP-LEVEL keys.
 *
 * Keys are read with the per-line matcher `^\s*(\w+):` (permissively `\w+` so a
 * future key with a digit or capital isn't silently dropped) applied only to
 * lines at the map's TOP LEVEL — a running brace-depth counter skips any line
 * inside a nested object value, so a `someType: { ... }` entry contributes only
 * its top-level key `someType`, never the nested literal's inner keys. Per-line
 * matching is also robust to interleaved `//` comment lines between entries.
 */
export function extractHandlersMapKeys(src: string): Set<string> {
  const keys = new Set<string>()
  const header = src.match(/const HANDLERS:\s*Record<string,\s*Handler>\s*=\s*\{/)
  if (!header || header.index === undefined) return keys

  // Find the matching close brace for the `{` that ends the header match.
  const openIdx = header.index + header[0].length - 1 // index of the `{`
  let depth = 0
  let endIdx = -1
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        endIdx = i
        break
      }
    }
  }
  if (endIdx === -1) return keys
  const body = src.slice(openIdx + 1, endIdx)

  // Walk line by line tracking brace depth; collect keys only at the map's top
  // level (depth 0) so a nested object value's inner keys are not mistaken for
  // message types. The key on a `someType: {` line is matched before that line
  // raises the depth, so the real top-level key is still captured.
  let lineDepth = 0
  for (const line of body.split('\n')) {
    if (lineDepth === 0) {
      const m = line.match(/^\s*(\w+)\s*:/)
      if (m) keys.add(m[1])
    }
    for (const ch of line) {
      if (ch === '{') lineDepth++
      else if (ch === '}') lineDepth--
    }
  }
  return keys
}

/**
 * The app handler's full type universe: `case` clauses only.
 */
export function extractAppHandlerTypes(appSrc: string): Set<string> {
  return extractCaseTypes(appSrc)
}

/**
 * The dashboard handler's full type universe: `case` clauses plus any
 * `HANDLERS` map keys.
 */
export function extractDashboardHandlerTypes(dashSrc: string): Set<string> {
  const types = extractCaseTypes(dashSrc)
  for (const k of extractHandlersMapKeys(dashSrc)) types.add(k)
  return types
}
