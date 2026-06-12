/**
 * Shared history-replay reconcile + cursor tracking (#5555.3 / #5555.4)
 *
 * Two coupled concerns, both shared by the mobile app and web dashboard so the
 * two clients can't drift:
 *
 * 1. **lastSeq cursor (#5555.3).** The server stamps each replayed history
 *    entry with `historySeq` (a monotonic per-session sequence). The client
 *    tracks the highest seq it has APPLIED per session and sends the map back
 *    in the next `auth` message (`historyCursors`). The server then replays
 *    only entries newer than the cursor instead of the full ring buffer.
 *
 *    The cursor advances on the REPLAY path only — live-streamed messages carry
 *    no seq, so a session that streams after its replay keeps the cursor pinned
 *    at the last replayed seq. On the next reconnect the server backfills
 *    everything recorded since (bounded by activity-during-disconnect), which is
 *    correct and append-only. The `history_replay_start`/`_end` frames also
 *    carry `latestSeq` so an empty (already-current) delta replay still advances
 *    the cursor with no entry to read a seq off.
 *
 * 2. **No-blank-flash reconcile (#5555.4).** Historically a full replay wiped
 *    the session's `messages` to `[]` at `history_replay_start`, then rebuilt
 *    oldest-first — the worst perceived-speed moment in the product. Now:
 *
 *    - **Delta replay** (`fullHistory: false`, the common reconnect path with a
 *      cursor): purely append-only. No wipe, no baseline, nothing to swap — the
 *      replayed entries are strictly newer than what the client already shows.
 *
 *    - **Full rebuild** (`fullHistory: true`: first connect, or the trim-gap /
 *      seq-reset fallback): keep the existing messages VISIBLE while the
 *      authoritative replayed set is rebuilt, then swap atomically at
 *      `history_replay_end`. Implemented as a "deferred swap": record the
 *      pre-replay message count as a baseline; replayed entries append AFTER it;
 *      at end, slice the array down to the appended tail (the replayed set) in a
 *      single store update. The pre-replay prefix stays on screen the whole time
 *      and vanishes only at the swap — no blank flash, scroll position
 *      preserved by the UI layer because the array identity only changes once.
 *
 *      During a full rebuild the replay-dedup cache MUST be scoped to the
 *      appended tail (`messagesSinceBaseline`) — NOT the whole array — so a
 *      replayed entry is not suppressed by matching an id in the
 *      about-to-be-discarded prefix (which would drop it from the swapped set).
 *
 * Ordering note (replay × delta-flusher race, #5588): a forced delta flush that
 * lands DURING a full rebuild appends a streamed response into the tail just
 * like a replayed entry, so it survives the swap in array order. A flush that
 * lands AFTER `history_replay_end` (rebuild already cleared) appends normally.
 * Either way the swap only ever slices off the pre-baseline prefix, so a racing
 * flush can neither be duplicated nor reordered relative to replayed entries —
 * see `reconcileReplayEnd` and the race test in `replay-reconcile.test.ts`.
 */

/**
 * Per-session full-rebuild state. Absent key ⇒ no rebuild in progress for that
 * session (delta replay or no replay). `baseline` is the `messages.length`
 * captured at `history_replay_start`.
 */
const _rebuildBaseline = new Map<string, number>()

/**
 * Per-session highest applied `historySeq`. Sent back as `historyCursors` in
 * the next `auth`. Survives across reconnects in module memory (the same module
 * instance lives for the app/dashboard session), and is the single source the
 * connect path reads when building the auth payload.
 */
const _historyCursors = new Map<string, number>()

/**
 * Reset all replay-reconcile state. Called on fresh auth / hard reset so a new
 * connection doesn't inherit a stale baseline. Does NOT clear cursors by
 * default — those are intentionally retained so a reconnect can present them
 * (pass `clearCursors: true` to wipe them too, e.g. on full disconnect/logout).
 */
export function resetReplayReconcile(opts: { clearCursors?: boolean } = {}): void {
  _rebuildBaseline.clear()
  if (opts.clearCursors) _historyCursors.clear()
}

/**
 * Record a replayed entry's `historySeq`, advancing the per-session cursor.
 * Ignores non-finite / non-increasing values so out-of-order or malformed
 * frames can't regress the cursor.
 */
export function recordHistorySeq(sessionId: string | null | undefined, seq: unknown): void {
  if (!sessionId) return
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return
  const cur = _historyCursors.get(sessionId)
  if (cur === undefined || seq > cur) _historyCursors.set(sessionId, seq)
}

/**
 * Snapshot of the per-session cursors for the `auth.historyCursors` field.
 * Returns a plain object (never a live Map). Empty ⇒ omit the field (old-client
 * shape) so the server falls back to a full replay.
 */
export function getHistoryCursors(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [sid, seq] of _historyCursors) out[sid] = seq
  return out
}

/** Read a single session's cursor (testing / diagnostics). */
export function getHistoryCursor(sessionId: string): number | undefined {
  return _historyCursors.get(sessionId)
}

/**
 * Begin a replay for a session. `fullHistory` is the server's flag from
 * `history_replay_start`; `currentLen` is `messages.length` right now.
 *
 * For a full rebuild we record the baseline so the appended replay tail can be
 * sliced out at end.
 *
 * The `latestSeq` carried on the start frame is INTENTIONALLY NOT applied to
 * the cursor here. If the socket drops mid-replay (before history_replay_end),
 * advancing the cursor to `latestSeq` at start would make the next reconnect
 * claim it has entries it never applied → silent gap. The cursor advances
 * per-entry as entries are applied, and is finalised from `latestSeq` only at
 * `reconcileReplayEnd` — i.e. once the whole slice has been delivered.
 *
 * Returns whether a full rebuild is now in progress (the caller does NOT wipe
 * messages either way — the whole point of #5555.4).
 */
export function reconcileReplayStart(
  sessionId: string | null,
  fullHistory: boolean,
  currentLen: number,
  // Accepted for call-site symmetry with the wire frame; deliberately unused —
  // see the doc comment above on why the cursor is not advanced at start.
  _latestSeq?: unknown,
): { rebuildInProgress: boolean } {
  if (!sessionId) return { rebuildInProgress: false }
  if (fullHistory) {
    _rebuildBaseline.set(sessionId, Math.max(0, currentLen | 0))
    return { rebuildInProgress: true }
  }
  // Delta replay: append-only, ensure no stale baseline lingers.
  _rebuildBaseline.delete(sessionId)
  return { rebuildInProgress: false }
}

/** Is a full rebuild currently in progress for this session? */
export function isRebuildInProgress(sessionId: string | null | undefined): boolean {
  return !!sessionId && _rebuildBaseline.has(sessionId)
}

/**
 * The dedup cache a replayed entry should be matched against. During a full
 * rebuild this is the appended tail only (entries replayed so far) so a
 * replayed entry isn't suppressed by an id in the discarded prefix. For a delta
 * replay (or no rebuild) it's the whole array, matching the historical behavior
 * (dedup replayed entries against everything the client already shows).
 */
export function replayDedupCache<T>(
  sessionId: string | null | undefined,
  messages: readonly T[],
): readonly T[] {
  if (sessionId && _rebuildBaseline.has(sessionId)) {
    const base = _rebuildBaseline.get(sessionId) as number
    return messages.slice(base)
  }
  return messages
}

/**
 * Finish a replay for a session. For a full rebuild, returns the swapped
 * message array (the appended tail = the authoritative replayed set) so the
 * caller applies it in ONE store update — the atomic swap. For a delta replay /
 * no rebuild, returns `null` (caller leaves `messages` untouched).
 *
 * `latestSeq` (when present) advances the cursor one last time, covering the
 * empty-slice case where no entry carried a seq.
 */
export function reconcileReplayEnd(
  sessionId: string | null,
  messages: readonly unknown[],
  latestSeq?: unknown,
): { swappedMessages: unknown[] | null } {
  if (sessionId && typeof latestSeq === 'number' && Number.isFinite(latestSeq)) {
    recordHistorySeq(sessionId, latestSeq)
  }
  if (!sessionId || !_rebuildBaseline.has(sessionId)) {
    return { swappedMessages: null }
  }
  const base = _rebuildBaseline.get(sessionId) as number
  _rebuildBaseline.delete(sessionId)
  // Slice off the pre-replay prefix → exactly the replayed (+ any racing live)
  // tail, in array order. A baseline at or past the end yields [] (a session
  // that genuinely had no replayed entries, e.g. server-side trim to empty).
  return { swappedMessages: messages.slice(base) }
}
