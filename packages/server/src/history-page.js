// #8860: the shared, bounded page reader for a PRESERVED history array. Two
// callers read a saved history without a live session behind it — a parked
// failed restore (`SessionManager.getFailedRestoreHistory`) and the provider-
// neutral session archive (`SessionArchive.getHistoryPage`) — and both must
// serve exactly the same bounded, replay-safe shape. One implementation, so a
// bound tightened for one cannot stay loose on the other.

// Page bounds. Mirrors the protocol's `get_failed_restore_history` /
// `get_archived_session_history` limit (1..100); the clamp is repeated here
// because this is the enforcement point for any caller, not just the handler.
export const HISTORY_PAGE_DEFAULT_LIMIT = 50
export const HISTORY_PAGE_MAX_LIMIT = 100
// A page is also bounded by its serialized size. It goes out as ONE WebSocket
// frame, and ws-client-sender evicts a client whose post-send bufferedAmount
// passes 1 MiB; with permessage-deflate the buffered size has been measured at
// ~1.34x the JSON. 256 KiB of JSON keeps a page well under that. An entry that
// is alone bigger than the per-entry cap has its large fields shortened for
// display, so a single entry can never blow the page either.
export const HISTORY_PAGE_BYTES = 256 * 1024
export const HISTORY_ENTRY_BYTES = 64 * 1024
export const HISTORY_FIELD_CHARS = 16 * 1024

/**
 * #8860: one preserved-history entry as the history-page replies send it.
 *
 * - The same `truncateEntry` the persistence boundary uses (it also drops
 *   `_seq`), and the same server-only fields normal history replay strips
 *   (`sourceToolUseId`, `answered`; see ws-history.js), so this read path shows
 *   no more than replay would.
 * - An entry still bigger than HISTORY_ENTRY_BYTES (a long
 *   message, a large tool input or result) has `content` / `result` / `input`
 *   shortened for display, and if that is still not enough it is reduced to a
 *   bounded type, a numeric timestamp and `isError`, marked `_truncated` (the
 *   panel shows it as too large to show). Nothing on disk changes.
 * - A non-object slot (a hand-edited state file) becomes `{ type: 'unknown' }`
 *   rather than being dropped, so page offsets keep matching history indexes.
 *
 * @param {unknown} raw
 * @param {{ truncateEntry: (entry: object) => object }} history
 * @returns {object}
 */
export function historyWireEntry(raw, history) {
  if (!raw || typeof raw !== 'object') return { type: 'unknown' }
  const { sourceToolUseId: _sourceToolUseId, answered: _answered, ...entry } = history.truncateEntry(raw)
  if (Buffer.byteLength(JSON.stringify(entry)) <= HISTORY_ENTRY_BYTES) return entry
  const max = HISTORY_FIELD_CHARS
  const shorten = (text) => (text.length > max ? `${text.slice(0, max)}[truncated]` : text)
  for (const key of ['content', 'result', 'input']) {
    const value = entry[key]
    if (typeof value === 'string') {
      entry[key] = shorten(value)
    } else if (value && typeof value === 'object') {
      let serialized
      try { serialized = JSON.stringify(value) } catch { serialized = '[unserializable]' }
      if (typeof serialized === 'string' && serialized.length > max) {
        entry[key] = { _truncated: true, summary: shorten(serialized) }
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(entry)) <= HISTORY_ENTRY_BYTES) return entry
  // Last resort (escape-heavy text, or abnormal fields of a hand-edited file):
  // keep only small, typed metadata so this can never itself be large.
  return {
    type: typeof entry.type === 'string' && entry.type.length <= 64 ? entry.type : 'unknown',
    ...(Number.isFinite(entry.timestamp) ? { timestamp: entry.timestamp } : {}),
    ...(typeof entry.isError === 'boolean' ? { isError: entry.isError } : {}),
    _truncated: true,
  }
}

/**
 * One bounded page of a preserved history, oldest first.
 *
 * Each entry is shaped by `historyWireEntry`, and the page stops early once its
 * serialized size would pass HISTORY_PAGE_BYTES, so `entries` can be shorter
 * than `limit`. `limit` is clamped to 1..MAX (default 50) and `offset` to >= 0,
 * whatever the caller sent; a non-numeric value takes the default rather than
 * propagating NaN into `slice`.
 *
 * @param {unknown} history the saved history (anything but an array reads as empty)
 * @param {{ offset?: number, limit?: number }} [opts]
 * @param {{ truncateEntry: (entry: object) => object }} historyHelper
 * @returns {{ total: number, offset: number, entries: object[] }}
 */
export function pageHistory(history, { offset, limit } = {}, historyHelper) {
  const list = Array.isArray(history) ? history : []
  const pageSize = Number.isFinite(limit)
    ? Math.min(HISTORY_PAGE_MAX_LIMIT, Math.max(1, Math.trunc(limit)))
    : HISTORY_PAGE_DEFAULT_LIMIT
  const start = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0
  const entries = []
  let bytes = 0
  for (const raw of list.slice(start, start + pageSize)) {
    const entry = historyWireEntry(raw, historyHelper)
    const size = Buffer.byteLength(JSON.stringify(entry))
    // Always at least one entry, so paging (the next offset is
    // `offset + entries.length`) can never stall. The per-entry cap already
    // keeps any one entry under the page budget; this holds it if they drift.
    if (entries.length > 0 && bytes + size > HISTORY_PAGE_BYTES) break
    entries.push(entry)
    bytes += size
  }
  return { total: list.length, offset: start, entries }
}
