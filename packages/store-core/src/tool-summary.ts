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

const PRIORITY_FIELDS = ['command', 'file_path', 'path', 'description'] as const

const PREVIEW_MAX_LEN = 100

function pickPriorityString(obj: Record<string, unknown>): string | null {
  for (const field of PRIORITY_FIELDS) {
    const value = obj[field]
    if (typeof value === 'string' && value.length > 0) return value
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
 *   - none of the priority fields are non-empty strings
 *
 * Callers render the verbatim accumulator head when this returns null
 * so the JSON still shows assembling on-screen.
 *
 * #4242: route the parse through `tryParseCompleteJson` so a chunk
 * that can't structurally be complete JSON yet (doesn't end in `}` or
 * `]`) short-circuits without paying the parse cost.
 */
export function getPartialSummary(partial: string): string | null {
  const parsed = tryParseCompleteJson(partial)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const summary = pickPriorityString(parsed as Record<string, unknown>)
  if (!summary) return null
  return summary.slice(0, PREVIEW_MAX_LEN)
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

  // Walk the priority list ourselves so the object-shaped fallback
  // mirrors the existing dashboard behaviour: if `command` is present
  // but it happens to be an object, JSON.stringify it rather than
  // skipping past to `file_path`.
  for (const field of PRIORITY_FIELDS) {
    const value = (input as Record<string, unknown>)[field]
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      if (!value) continue
      return value.slice(0, PREVIEW_MAX_LEN)
    }
    // Object-shaped recognised field — JSON-stringify so the summary
    // is still informative rather than `[object Object]`.
    return JSON.stringify(value).slice(0, PREVIEW_MAX_LEN)
  }
  return ''
}
