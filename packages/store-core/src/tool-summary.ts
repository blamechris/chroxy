/**
 * Shared tool-summary helpers (#4243).
 *
 * Both the dashboard `ToolBubble` (web) and the mobile `ToolBubble`
 * (React Native) need to surface the same single useful field from a
 * partial or final tool-use input — e.g. Bash's `command`, Read/Edit's
 * `file_path`, or a fallback `description`. Without this, the mobile
 * collapsed preview shows `{"command":"rm -rf node_mod` (a slice of
 * the pretty-printed JSON) while the dashboard shows `rm -rf
 * node_modules` (the extracted field). The early-abort UX (#4063)
 * depends on Bash `command` being visible at a glance, so both
 * surfaces must agree.
 *
 * Pure functions, no DOM / React Native dependencies — safe to import
 * from either consumer.
 */

import { tryParseCompleteJson } from './partial-json'

// #4243 set the original priority order. #4648 added `filePath` for the
// nested-Read-tool input shape `{type:'text', file:{filePath:'/foo'}}` that
// claude TUI emits — without the camelCase variant, the summary was empty
// and ToolBubble fell through to rendering raw JSON head (`{"type":"text",
// "file":{"filePath":...`) directly in the collapsed bubble. Keep snake_case
// `file_path` first since it's the documented top-level shape across more
// tools (Edit, Write, NotebookEdit); camelCase nested is the Read-only case.
const PRIORITY_FIELDS = ['command', 'file_path', 'filePath', 'path', 'description'] as const

const PREVIEW_MAX_LEN = 100

// #4655 — generic-fallback summary for tools whose input shape has none
// of the PRIORITY_FIELDS (ToolSearch `{query, max_results}`, arbitrary
// MCP tool inputs, custom tools, future Anthropic tools, etc.). Without
// this, callers fall through to rendering raw JSON head (`{"matches":
// ["Ask...`) in the collapsed bubble — a leak surface that grows with
// every new tool shape. The generic summary trades structural-but-ugly
// JSON for a compact key:value listing that's still legible.
//
// Cap at PREVIEW_MAX_LEN to match the priority-field summary contract.
// Nested objects/arrays render as `{...}` / `[N]` placeholders so a
// big value doesn't blow the budget on one key. When the first key
// would already overflow, fall back to listing key names only.
function buildGenericSummary(obj: Record<string, unknown>): string | null {
  const keys = Object.keys(obj)
  if (keys.length === 0) return null

  const parts: string[] = []
  let totalLen = 0
  for (const key of keys) {
    const value = obj[key]
    const rendered = `${key}: ${renderGenericValue(value)}`
    // +2 for the ", " separator between parts after the first.
    const additional = parts.length === 0 ? rendered.length : rendered.length + 2
    if (totalLen + additional > PREVIEW_MAX_LEN) break
    parts.push(rendered)
    totalLen += additional
  }

  if (parts.length === 0) {
    // First key:value already overflowed — degrade to a bare key-count
    // summary so something useful still shows ("3 keys: query,
    // max_results, foo"). Caps at PREVIEW_MAX_LEN.
    const head = `${keys.length} key${keys.length === 1 ? '' : 's'}: ${keys.join(', ')}`
    return head.slice(0, PREVIEW_MAX_LEN)
  }

  const joined = parts.join(', ')
  // The remaining keys are implied by the truncation; we don't tack on
  // `…` because the bubble itself is already a disclosure widget that
  // expands to the full JSON.
  return joined.slice(0, PREVIEW_MAX_LEN)
}

function renderGenericValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') {
    // Quoted so it's visually distinct from key names. Long strings get
    // truncated inside the quotes so the suffix is still visible
    // structure.
    return value.length > 40 ? `"${value.slice(0, 37)}..."` : `"${value}"`
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.length}]`
  if (typeof value === 'object') return '{...}'
  return String(value)
}

function pickPriorityString(obj: Record<string, unknown>): string | null {
  // Top-level pass first — the common case for documented tool input shapes.
  for (const field of PRIORITY_FIELDS) {
    const value = obj[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  // #4648: one-level walk into nested objects to find priority fields. Read
  // tool input is `{type:'text', file:{filePath:'/foo'}}` — the priority
  // string lives one level down. Stop after one level (no recursion) so a
  // pathological nesting can't blow up the dashboard preview path. Skip
  // arrays — `Record<string, unknown>` typing already excludes them at the
  // entry, but a nested array value could still exist.
  for (const value of Object.values(obj)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    for (const field of PRIORITY_FIELDS) {
      const nested = (value as Record<string, unknown>)[field]
      if (typeof nested === 'string' && nested.length > 0) return nested
    }
  }
  return null
}

/**
 * Extract the most useful single-field preview from a partial-JSON
 * buffer streamed via `tool_input_delta`. Prefers `command`,
 * `file_path`, `path`, `description` in that order. Returns `null`
 * when:
 *
 *   - the buffer isn't yet valid JSON (mid-stream)
 *   - the parse yields a non-object (`null`, string, number)
 *
 * Callers render the verbatim accumulator head when this returns null
 * so the JSON still shows assembling on-screen.
 *
 * #4242: route the parse through `tryParseCompleteJson` so a chunk
 * that can't structurally be complete JSON yet (doesn't end in `}` or
 * `]`) short-circuits without paying the parse cost.
 *
 * #4655: when the parsed object has no priority field, fall back to a
 * generic key:value summary (`query: "select:foo", max_results: 5`)
 * instead of returning null and letting the caller leak raw JSON head.
 * The old behaviour was bounded only by the hardcoded PRIORITY_FIELDS
 * allowlist — every new tool shape (ToolSearch, MCP tools, custom
 * user tools, future Anthropic tools) extended the leak surface. The
 * generic fallback removes the per-tool maintenance burden.
 */
export function getPartialSummary(partial: string): string | null {
  const parsed = tryParseCompleteJson(partial)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const summary = pickPriorityString(parsed as Record<string, unknown>)
  if (summary) return summary.slice(0, PREVIEW_MAX_LEN)
  // #4655: structured-but-unknown shape — build a compact key:value
  // summary so collapsed bubbles never leak raw JSON.
  return buildGenericSummary(parsed as Record<string, unknown>)
}

/**
 * Extract a collapsed-preview string from a final tool-use `input`
 * payload (object or string). Mirrors `getPartialSummary` for the
 * structured-object case; falls back to truncating raw strings and
 * `JSON.stringify`-ing object-shaped priority fields so the summary is
 * never empty when a recognised field is present.
 *
 * Returns `''` (NOT `null`) when nothing useful can be extracted — the
 * dashboard and mobile both branch on `if (summary)` to decide whether
 * to render the summary line at all.
 */
export function getInputSummary(input: Record<string, unknown> | string | null | undefined): string {
  if (!input) return ''
  if (typeof input === 'string') return input.slice(0, PREVIEW_MAX_LEN)

  // Match the original dashboard `||`-chain: any falsy value (undefined
  // / null / '' / 0 / false) is treated as "field not present" and the
  // walk continues to the next field. Truthy non-string values
  // (objects, arrays) get JSON-stringified so the summary is still
  // informative rather than `[object Object]`.
  const inputObj = input as Record<string, unknown>
  for (const field of PRIORITY_FIELDS) {
    const value = inputObj[field]
    if (!value) continue
    if (typeof value === 'string') return value.slice(0, PREVIEW_MAX_LEN)
    return JSON.stringify(value).slice(0, PREVIEW_MAX_LEN)
  }
  // #4648: same one-level walk as pickPriorityString for the Read tool
  // shape `{type:'text', file:{filePath:'/foo'}}` — without this the
  // summary is '' and ToolBubble falls through to raw JSON head.
  for (const value of Object.values(inputObj)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    for (const field of PRIORITY_FIELDS) {
      const nested = (value as Record<string, unknown>)[field]
      if (typeof nested === 'string' && nested.length > 0) return nested.slice(0, PREVIEW_MAX_LEN)
    }
  }
  // #4655: structured-but-unknown shape (ToolSearch, MCP tools, etc.) —
  // build a compact key:value summary so callers never have to fall
  // back to raw JSON head. The bubble itself remains a disclosure
  // widget that expands to the full pretty-printed JSON.
  const generic = buildGenericSummary(inputObj)
  return generic ?? ''
}
