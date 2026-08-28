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
 *
 * Iteration order is LRU-by-update: `recordHistorySeq` re-inserts the touched
 * key so it moves to the tail (newest), and the cap below evicts from the head
 * (oldest). This keeps the map bounded and — critically — guarantees the
 * just-updated (active) session's cursor is never the one evicted, so a heavy
 * user with hundreds of historical sessions still gets a delta reconnect on the
 * session they're actually viewing (#5555.3 review thread).
 */
const _historyCursors = new Map<string, number>()

/**
 * Per-session "a replay window is open right now" marker (#7420).
 *
 * Deliberately NOT `_rebuildBaseline`: that map only holds FULL rebuilds, and a
 * live prompt can race a DELTA replay just as easily (the server chunks both
 * over `setImmediate`, with back-pressure pauses of up to 30s — ws-history.js).
 * Added at `reconcileReplayStart` for either kind, removed at
 * `reconcileReplayEnd`.
 */
const _replayWindowOpen = new Set<string>()

/**
 * Per-session ids of `prompt` ChatMessages that arrived LIVE — i.e. were NOT
 * delivered by the replay — while that session's replay window was open (#7420).
 *
 * This is the whole fix for #7420. `history_replay_end` sweeps unanswered
 * prompts with `answered: '(resolved)'` on the premise that anything in history
 * is already resolved. `permission_request` is in the server's `builtinTransient`
 * list so it is never replayed, and #7410/#7419 excluded it by `requestId`. But
 * `user_question` IS in the history ring buffer, and the ChatMessage it builds
 * carries no `requestId` and no `expiresAt` — so a live AskUserQuestion that
 * lands mid-replay is byte-identical in store state to a replayed one, and the
 * sweep stamped both, silently destroying the answer path for that turn.
 *
 * The one signal that separates them is the wire frame, which only exists at
 * arrival: `replayHistory` stamps every replayed entry with `historySeq`
 * (ws-history.js) and a live broadcast never carries one. So the call site
 * records the id here as the message is appended, and the sweep skips it.
 *
 * Lifetime is exactly one replay window: the set is dropped at the NEXT
 * `reconcileReplayStart` for that session (anything already on screen when a
 * window opens pre-dates it and stays stampable) and by `resetReplayReconcile`.
 * That also bounds it — the entries are a subset of the ChatMessages the store
 * is already holding for the same window — so it needs no cap of its own, and
 * it leaves {@link sweepUnansweredPromptsAtReplayEnd} a pure read, with no
 * ordering hazard against the caller that consumes it.
 */
const _liveDuringReplay = new Map<string, Set<string>>()

/**
 * Client-side cap on the per-session cursor map. Mirrors the server's
 * `MAX_HISTORY_CURSORS` (ws-auth.js): the server only honours that many keys
 * from a single `auth`, so retaining/sending more is pure bloat. Holding the
 * client cap at the same value (and evicting LRU) means the client never sends
 * a cursor the server would silently drop, and the active session's cursor is
 * always within the honoured window.
 */
const MAX_CLIENT_HISTORY_CURSORS = 64

/**
 * Reset all replay-reconcile state. Called on fresh auth / hard reset so a new
 * connection doesn't inherit a stale baseline. Does NOT clear cursors by
 * default — those are intentionally retained so a reconnect can present them
 * (pass `clearCursors: true` to wipe them too, e.g. on full disconnect/logout).
 */
export function resetReplayReconcile(opts: { clearCursors?: boolean } = {}): void {
  _rebuildBaseline.clear()
  // #7420 — an open window and its live-arrival ids are per-connection state
  // like the baseline, never a cursor: a fresh auth must not inherit either.
  _replayWindowOpen.clear()
  _liveDuringReplay.clear()
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
  if (cur !== undefined && seq <= cur) return
  // Re-insert so the touched (active) session moves to the Map tail — LRU order
  // for the cap below. A plain `.set` on an existing key keeps its old slot, so
  // delete-then-set is required to refresh recency.
  _historyCursors.delete(sessionId)
  _historyCursors.set(sessionId, seq)
  // Evict the least-recently-updated cursor(s) from the head once over the cap.
  while (_historyCursors.size > MAX_CLIENT_HISTORY_CURSORS) {
    const oldest = _historyCursors.keys().next().value
    if (oldest === undefined) break
    _historyCursors.delete(oldest)
  }
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
  // #7420 — open the window for BOTH replay kinds, and drop the previous
  // window's live-arrival ids: every prompt already on screen pre-dates this
  // replay, so nothing about it is vouched for by this window.
  _replayWindowOpen.add(sessionId)
  _liveDuringReplay.delete(sessionId)
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
  // #7420 — close the window BEFORE the delta-replay early return below, so a
  // delta replay's window closes too. The live-arrival ids themselves are left
  // in place for `sweepUnansweredPromptsAtReplayEnd`, which the caller runs
  // after this; they are dropped at the next start / on reset.
  if (sessionId) _replayWindowOpen.delete(sessionId)
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

// ---------------------------------------------------------------------------
// #7420 — the `history_replay_end` unanswered-prompt sweep
// ---------------------------------------------------------------------------

/**
 * The `answered` value `history_replay_end` stamps on a prompt nobody answered.
 *
 * `answered` is a decision TOKEN, not a label (#6222/#6223), and this is the
 * one non-decision it may hold — which is why `isPermissionRequestAnswered`
 * (pending-permissions.ts) explicitly rejects it. One writer, here, so the two
 * clients cannot drift on the string.
 */
export const REPLAY_RESOLVED_PLACEHOLDER = '(resolved)'

/** The subset of `ChatMessage` the replay-end sweep reads. */
interface SweepablePrompt {
  id: string
  type: string
  answered?: unknown
  requestId?: unknown
}

/**
 * Record that a `prompt` message arrived LIVE during `sessionId`'s replay
 * window, so {@link sweepUnansweredPromptsAtReplayEnd} leaves it alone (#7420).
 *
 * A no-op when no window is open for that session — a prompt that arrives
 * outside a replay is not racing one, and the next replay's sweep is entitled
 * to stamp it (that is the pre-#7420 behaviour, deliberately kept).
 *
 * The CALLER decides liveness, because only the caller still has the wire
 * frame: a replayed entry carries `historySeq`, a live broadcast does not.
 */
export function noteLivePromptDuringReplay(
  sessionId: string | null | undefined,
  messageId: string | null | undefined,
): void {
  if (!sessionId || !messageId) return
  if (!_replayWindowOpen.has(sessionId)) return
  let ids = _liveDuringReplay.get(sessionId)
  if (!ids) {
    ids = new Set<string>()
    _liveDuringReplay.set(sessionId, ids)
  }
  ids.add(messageId)
}

/** Was this prompt recorded as a live arrival during the current window? */
export function wasPromptLiveDuringReplay(
  sessionId: string | null | undefined,
  messageId: string | null | undefined,
): boolean {
  if (!sessionId || !messageId) return false
  return _liveDuringReplay.get(sessionId)?.has(messageId) === true
}

/**
 * The `history_replay_end` sweep, shared so the app and the dashboard cannot
 * drift on it (they carried byte-identical copies until #7420).
 *
 * Stamps `answered: '(resolved)'` on every unanswered `prompt` in `messages`
 * that the sweep is entitled to touch, and returns the new array — or `null`
 * when there is nothing to stamp, so the caller can return a no-op patch and
 * avoid a re-render.
 *
 * Three exclusions, each for its own reason:
 *
 *   - `m.answered` already set — a real decision, or an earlier sweep.
 *   - `m.requestId` present (#7410/#7419) — only `permission_request` sets it,
 *     and `permission_request` is in the server's `builtinTransient` list
 *     (session-manager.js) so it is NEVER written to the history ring buffer.
 *     A permission prompt at replay-end therefore always RACED the replay; that
 *     is routine, not exotic, because `resendPendingPermissions` runs after
 *     `replayHistory` has already sent its first chunk. Keyed on `requestId`
 *     rather than `isLivePermissionPrompt` because `expiresAt` is only set when
 *     the frame carried `remainingMs` (`.optional()` in the schema), and a
 *     `permission_expired` prompt deliberately keeps `answered` empty.
 *   - recorded by {@link noteLivePromptDuringReplay} (#7420) — a `user_question`
 *     that arrived live inside this window. `user_question` IS in the ring
 *     buffer and its ChatMessage sets neither `requestId` nor `expiresAt`, so
 *     shape alone cannot tell a live one from a replayed one; only the arriving
 *     frame could, and this is where that observation is kept.
 *
 * Everything else — replayed prompts, and prompts that pre-date the window — is
 * stamped, which is the sweep's original premise.
 */
export function sweepUnansweredPromptsAtReplayEnd<T extends SweepablePrompt>(
  sessionId: string | null | undefined,
  messages: readonly T[],
): T[] | null {
  if (!sessionId) return null
  const live = _liveDuringReplay.get(sessionId)
  const isStampable = (m: T): boolean =>
    m.type === 'prompt' && !m.answered && !m.requestId && !(live?.has(m.id) === true)
  if (!messages.some(isStampable)) return null
  return messages.map((m) =>
    isStampable(m) ? ({ ...m, answered: REPLAY_RESOLVED_PLACEHOLDER } as T) : m,
  )
}
