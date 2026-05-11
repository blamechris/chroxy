/**
 * Large-paste collapse helpers (#3797).
 *
 * When a user pastes a big block of text into the chat composer, we replace
 * it with an inline placeholder token (e.g. `[Pasted text #1 +5234 lines]`)
 * and stash the full content in component state. On send, the outgoing
 * message body has each token expanded back to its full text so the model
 * receives the unchanged payload.
 *
 * Both clients (mobile + dashboard) import from here so the thresholds,
 * marker shape, and expansion regex stay in lock-step — without that, the
 * mobile and dashboard wire payloads could diverge for the same paste
 * sequence.
 */

/**
 * Threshold above which a paste is treated as "large" and collapsed.
 *
 * Either trigger fires the collapse, whichever comes first:
 *   - char count ≥ PASTE_COLLAPSE_CHAR_THRESHOLD
 *   - newline count ≥ PASTE_COLLAPSE_LINE_THRESHOLD
 *
 * Values chosen to mirror the Claude Code CLI's observed behaviour: a
 * 20-line snippet or a ~1.5KB JSON blob feels disruptive in the
 * composer, smaller pastes fit comfortably inline.
 */
export const PASTE_COLLAPSE_CHAR_THRESHOLD = 1500
export const PASTE_COLLAPSE_LINE_THRESHOLD = 20

/** True when a freshly-pasted string should be collapsed to a marker. */
export function shouldCollapsePaste(text: string): boolean {
  if (!text) return false
  if (text.length >= PASTE_COLLAPSE_CHAR_THRESHOLD) return true
  // Count newlines without splitting — avoids allocating an N-line array.
  let lines = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++
    if (lines >= PASTE_COLLAPSE_LINE_THRESHOLD) return true
  }
  return false
}

/**
 * Render the user-visible placeholder for a collapsed paste.
 *
 * Format is `[Pasted text #N +M lines]` for multi-line pastes (the common
 * case) and `[Pasted text #N +K chars]` for single-line pastes where the
 * line count would read as "+1 lines" (uninformative). The bracket syntax
 * is intentionally plain ASCII so it survives any composer's autocorrect
 * / autocomplete that might otherwise mangle unicode placeholder glyphs.
 */
export function formatPasteMarker(id: number, text: string): string {
  let lineCount = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineCount++
  }
  if (lineCount > 1) {
    return `[Pasted text #${id} +${lineCount} lines]`
  }
  return `[Pasted text #${id} +${text.length} chars]`
}

/**
 * Regex that matches any marker emitted by `formatPasteMarker`.
 *
 * The id capture group is base-10 only and unbounded in width so the regex
 * stays correct after many pastes in one session. The size component (lines
 * or chars) is captured but not used by expansion — only the id matters for
 * lookup. Global flag so `String.prototype.replace` can sweep every marker
 * in one pass.
 */
export const PASTE_MARKER_REGEX = /\[Pasted text #(\d+) \+(\d+) (lines|chars)\]/g

/**
 * Expand every `[Pasted text #N ...]` marker in `text` back to its full
 * content, using `blocks` as the id-to-content lookup. Markers whose id
 * is missing from `blocks` (e.g. the user manually typed a marker, or
 * removed the corresponding chip) pass through unchanged so we never
 * silently drop user-authored text.
 */
export function expandPasteMarkers(
  text: string,
  blocks: ReadonlyMap<number, string> | Record<number, string>,
): string {
  const lookup =
    blocks instanceof Map
      ? (id: number) => blocks.get(id)
      : (id: number) => (blocks as Record<number, string>)[id]
  return text.replace(PASTE_MARKER_REGEX, (full, idStr: string) => {
    const id = Number.parseInt(idStr, 10)
    const content = lookup(id)
    return content == null ? full : content
  })
}

/**
 * Return the set of marker ids actually referenced by `text`. UI surfaces
 * use this to detect chips whose marker the user has edited or deleted —
 * those chips can either auto-clean or show a "marker no longer matchable"
 * hint depending on UX preference.
 */
export function findActiveMarkerIds(text: string): Set<number> {
  const ids = new Set<number>()
  // Clone the regex each call — the source is global-flag and would
  // carry lastIndex across invocations otherwise.
  const re = new RegExp(PASTE_MARKER_REGEX.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) != null) {
    const id = Number.parseInt(match[1]!, 10)
    if (Number.isFinite(id)) ids.add(id)
  }
  return ids
}

/**
 * Recover the inserted substring between two snapshots of a controlled
 * text input (#3797). Returns the longest contiguous span of new content
 * that appeared between `prev` and `next`, computed from the longest
 * common prefix + suffix.
 *
 * Used by the mobile composer to detect oversized pastes: React Native
 * `TextInput` has no native paste event, so the only signal we get is
 * `onChangeText(next)` — diffing against the previous snapshot is how we
 * pull the paste payload out of the input.
 *
 * Returns `null` when the input shrank (deletion) or stayed the same
 * length.
 */
export function detectPasteFromDiff(
  prev: string,
  next: string,
): { inserted: string; prefix: string; suffix: string } | null {
  if (next.length <= prev.length) return null
  let prefixLen = 0
  const maxPrefix = Math.min(prev.length, next.length)
  while (prefixLen < maxPrefix && prev.charCodeAt(prefixLen) === next.charCodeAt(prefixLen)) {
    prefixLen++
  }
  let suffixLen = 0
  const maxSuffix = Math.min(prev.length - prefixLen, next.length - prefixLen)
  while (
    suffixLen < maxSuffix &&
    prev.charCodeAt(prev.length - 1 - suffixLen) === next.charCodeAt(next.length - 1 - suffixLen)
  ) {
    suffixLen++
  }
  return {
    inserted: next.slice(prefixLen, next.length - suffixLen),
    prefix: next.slice(0, prefixLen),
    suffix: next.slice(next.length - suffixLen),
  }
}
