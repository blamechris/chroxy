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
 *      single store update. When two full replays of one session overlap the
 *      OUTERMOST baseline is the one that survives and the swap waits for the
 *      last end (#7477), so nothing appended between the two starts is sliced
 *      off. The pre-replay prefix stays on screen the whole time
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
 * session (delta replay or no replay). The value is the `messages.length`
 * captured at the OUTERMOST full `history_replay_start` — the index the
 * deferred swap slices at.
 *
 * "Outermost" is the whole of #7477. This map used to be written by every full
 * start and deleted by the first end, which is the non-refcount shape #7455
 * removed from {@link _replayWindowOpen} one map over. Two overlapping full
 * replays of one session (`start start end end` — see that comment for why the
 * server produces them) then had end#1 slice the array at replay #2's baseline
 * and apply the result as the atomic swap, DELETING everything appended between
 * the two starts. That window is exactly the live-racer window #7420 exists to
 * protect: the ledger vouched for the message and the swap threw it away.
 *
 * So the outermost rebuild owns the baseline — set only when absent, cleared
 * only by the end that closes the LAST window (and by the teardown paths). The
 * union of both replays' appended tails survives one swap, in array order;
 * {@link replayDedupCache} is scoped at the same baseline, so replay #2
 * re-delivering entries replay #1 already appended dedups against them normally
 * instead of appending a second copy.
 *
 * The lifetime is therefore tied to the window refcount, and that makes the
 * teardown in `resetReplayReconcile` / {@link dropReplaySessionState}
 * LOAD-BEARING rather than tidy. Say the cost plainly: a `history_replay_start`
 * with no matching end strands a +1, and set-if-absent plus the deferral then
 * mean the baseline is never re-captured AND no later end ever reaches the
 * swap — that session's messages stop being rebuilt for the life of the
 * connection. Pre-#7477 the overwrite-every-start shape SELF-HEALED there: the
 * next full start captured a fresh baseline and its end swapped normally. So
 * this is strictly worse under a stranded start, and it is only safe because
 * the strand is unreachable:
 *
 *   - the only server path that emits a start without an end is
 *     `sendChunkedWithBackpressure` bailing on `ws.readyState !== 1` — the
 *     chunk-entry gate, `sendChunk`'s own re-check, and `scheduleAfterDrain`
 *     (which `ws.close(1013)`s at the max-wait cap). All of them mean the
 *     socket is already gone.
 *   - both clients reset TWICE per connection: `socket.onclose` /
 *     `socket.onerror` and again on `auth_ok` (#7456), plus
 *     `dropReplaySessionState` on session prune and timeout.
 *
 * If either of those ever regresses, this map wedges where it used to recover.
 * Treat the teardown as part of this invariant, not as housekeeping.
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
 * Per-session replay-window REFCOUNT — how many replays are in flight for that
 * session right now (#7420, refcounted by #7455). Absent key ⇒ 0 ⇒ no window.
 *
 * Deliberately NOT `_rebuildBaseline`: that map only holds FULL rebuilds, and a
 * live prompt can race a DELTA replay just as easily (the server chunks both
 * over `setImmediate`, with back-pressure pauses of up to 30s — ws-history.js).
 * Incremented at `reconcileReplayStart` for either kind, decremented at
 * `reconcileReplayEnd`.
 *
 * A COUNT and not membership, because the server can have two replays of ONE
 * session in flight at once and neither caller checks (#7455):
 * `subscribe_sessions` replays every newly-subscribed background session, and
 * `switch_session` calls `replayHistory(ws, id, { forceFull: true })`
 * unconditionally — including for a session the client is already subscribed
 * to. `replayHistory` chunks 20 entries at a time over `setImmediate` with
 * back-pressure pauses, so the wire order is `start(X) start(X) end(X) end(X)`.
 * With a Set the FIRST end closed the window while replay #2 was still
 * streaming, and every live `user_question` in that tail fell through the gate
 * in {@link noteLivePromptDuringReplay} and was stamped '(resolved)' by the
 * second end's sweep — #7420 again, in the one case the gate exists for.
 *
 * (`_rebuildBaseline` carried the same non-refcount shape, pre-existing since
 * #5555.4 and deliberately out of scope for #7455, and it was NOT the cosmetic
 * mis-swap that scoping assumed: the second start overwrote the baseline and
 * the first end sliced a message appended BETWEEN the two starts straight out
 * of the store. Fixed as #7477 — the two compose, the ledger protecting the
 * racer and the swap no longer dropping it.)
 *
 * The value carries {@link ReplayWindow.openLen} alongside the depth because
 * that number has exactly this map's lifetime (#7492) — see the interface.
 */
const _replayWindowOpen = new Map<string, ReplayWindow>()

/**
 * The open replay window for one session: the refcount, plus the
 * `messages.length` captured when it OPENED.
 *
 * One record and not two maps, deliberately. `openLen` is meaningful for
 * exactly as long as the refcount is non-zero and must be dropped at the same
 * instant — so making it a field of the refcount's own value means the four
 * teardown paths (`closeReplayWindow`'s last decrement, `resetReplayReconcile`,
 * {@link dropReplaySessionState}, and the `delete` inside `closeReplayWindow`)
 * cannot clear one and leave the other. A sibling `Map<string, number>` would
 * be a second thing to remember at each of them, which is the drift the
 * `_rebuildBaseline` teardown comment already warns about at length.
 */
interface ReplayWindow {
  /** How many replays are in flight for this session right now (>= 1). */
  depth: number
  /**
   * `messages.length` at the 0->1 transition — the OUTERMOST start, whatever
   * KIND it was (#7492).
   *
   * #7477 made the outermost FULL rebuild own {@link _rebuildBaseline}, which
   * covers `start(full) start(full) end end`. It does not cover a full rebuild
   * nested inside a DELTA window: the delta contributes no baseline, so the
   * nested full start is the first to set one and captures a `messages.length`
   * that already counts everything appended during the delta — including a
   * live racer, which the deferred swap then slices off. That is #7420's own
   * window again, reached by a different interleave: the ledger vouches for the
   * message right up to the moment the swap discards it.
   *
   * So the OUTERMOST WINDOW owns the baseline, not the outermost full rebuild,
   * and a nested full start adopts this number instead of its own `currentLen`.
   * At depth 1 the two are the same value, so every #7477 case is unchanged.
   *
   * KNOWN LIMIT, stated rather than hidden: when the delta actually APPENDED
   * entries before the nested full start, those entries are now inside the
   * preserved tail, so the full replay's re-delivery of them dedups against
   * them ({@link replayDedupCache} is scoped at the same baseline) and they
   * keep their early position while the older history the full replay delivers
   * appends after — a correctly-populated but mis-ORDERED transcript. That is a
   * strictly better failure than the silent DROP it replaces (nothing is lost,
   * and the next full replay re-orders it), and fixing it needs the swap to
   * distinguish replayed appends from live ones — a change to the "slice off a
   * prefix" shape rather than to this number. Tracked as #7519, and PINNED by
   * `full rebuild nested inside a DELTA window (#7492) > the delta's own
   * appends keep their early position` so it cannot change unnoticed.
   */
  openLen: number
}

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
 * Lifetime is exactly one replay window, and this map holds a session only
 * while that window is OPEN (#7456): the ledger is created on the first live
 * arrival, dropped at the NEXT `reconcileReplayStart` for that session
 * (anything already on screen when a window opens pre-dates it and stays
 * stampable), and RELEASED when the last window closes — handed to
 * {@link _sweepableLedger} so the caller's
 * {@link sweepUnansweredPromptsAtReplayEnd}, which runs on the next statement
 * after `reconcileReplayEnd` returns, can still read it. Both stay a pure read,
 * with no ordering hazard against that caller.
 *
 * The claim this comment used to carry — that the store's own message retention
 * bounds the map, so it needs no cap — was wrong (#7456). The store drops a
 * session's `messages` wholesale on prune (`session_list` reconcile) and on
 * `session_timeout`, and neither path touches module state here; and
 * `dispatchUserQuestion` records into the ledger REGARDLESS of its
 * `adapter.hasSession` check, so a session the store holds nothing for can
 * still open a key. What actually bounds it: the release above, the per-session
 * {@link dropReplaySessionState} both clients call from those two prune paths,
 * `resetReplayReconcile` on transport teardown and fresh auth — and,
 * defensively and loudly, {@link MAX_LIVE_REPLAY_LEDGERS}.
 */
const _liveDuringReplay = new Map<string, Set<string>>()

/**
 * The ONE just-closed window's ledger, released out of `_liveDuringReplay` at
 * `reconcileReplayEnd` and held only until its caller's sweep reads it (#7456).
 *
 * A single slot, not a map: the sweep runs synchronously on the statement after
 * `reconcileReplayEnd` in both clients, so at most one closed window is ever
 * awaiting one. It is overwritten by the next replay end for ANY session,
 * cleared by a fresh start for the same session, by `dropReplaySessionState`
 * and by `resetReplayReconcile` — bounded to one entry by construction, with
 * nothing to cap.
 */
let _sweepableLedger: { sessionId: string; ids: Set<string> } | null = null

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
 * Defensive cap on `_liveDuringReplay`, in the same shape as the cursor cap
 * above (#7456).
 *
 * It is ONE-DIMENSIONAL, and deliberately so: it bounds the number of SESSION
 * KEYS — how many sessions may hold an open-window ledger at once — and puts no
 * bound on the `Set<string>` of ids inside any one of them. The unbounded axis
 * is the negligible one: a session blocks on one `AskUserQuestion` at a time,
 * so a realistic window holds 0–1 ids, whereas `subscribe_sessions` replays
 * every background session and so can open many windows at once. Read this as
 * a cap on the key count, not as a complete bound on the map's size.
 *
 * Eviction logs LOUDLY: dropping a ledger un-protects the questions it held, so
 * the next sweep stamps them '(resolved)' and destroys those answer paths. A
 * silent truncation here would be indistinguishable from the #7420 bug itself.
 */
export const MAX_LIVE_REPLAY_LEDGERS = 64

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
  _sweepableLedger = null
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
  // #7420 — open the window for BOTH replay kinds. #7455 — as a REFCOUNT, so
  // two overlapping replays of one session compose instead of the first `end`
  // closing the window out from under the second.
  const existing = _replayWindowOpen.get(sessionId)
  // 0→1 ONLY — a genuinely new window, whatever KIND of replay opened it.
  const isOutermost = existing === undefined
  const replayWindow = existing ?? { depth: 0, openLen: Math.max(0, currentLen | 0) }
  replayWindow.depth += 1
  if (isOutermost) {
    // #7492 — the record (and with it `openLen`) is installed here and nowhere
    // else, so the captured length is the OUTERMOST start's by construction.
    _replayWindowOpen.set(sessionId, replayWindow)
    // Drop the previous window's live-arrival ids: every prompt already on
    // screen pre-dates this replay, so nothing about it is vouched for by this
    // window. A NESTED start must NOT do this — the outer window is still open
    // and still protecting what it recorded (#7455).
    _liveDuringReplay.delete(sessionId)
    if (_sweepableLedger?.sessionId === sessionId) _sweepableLedger = null
  }
  if (fullHistory) {
    // #7477 — set only when ABSENT. The OUTERMOST full rebuild owns the
    // baseline: overwriting it from a nested start makes end#1 slice at the
    // inner baseline and drop everything appended between the two starts.
    // A genuinely new window never has one (the last end and every teardown
    // path clear it), so at depth 1 this always sets.
    //
    // #7492 — and the value is the WINDOW's open length, not this start's own
    // `currentLen`. They are the same number when a full start opened the
    // window; they differ when a DELTA did, and `currentLen` then counts a live
    // racer that arrived during the delta straight into the discarded prefix.
    if (!_rebuildBaseline.has(sessionId)) {
      _rebuildBaseline.set(sessionId, replayWindow.openLen)
    }
    return { rebuildInProgress: true }
  }
  // Delta replay: append-only, and it contributes no baseline of its own. It
  // clears a stale one only when it OPENS the window (#7477): nested inside a
  // full rebuild that is still streaming, deleting the baseline would cancel
  // that rebuild's swap outright and leave the discarded prefix on screen.
  // Since #7492 that rebuild can be one a nested full start installed under a
  // delta-opened window, so this stays keyed on "did I open the window", not on
  // "was the outermost replay a full one".
  if (isOutermost) _rebuildBaseline.delete(sessionId)
  // Reports the session's rebuild state, not this replay's kind — a delta
  // nested inside a live full rebuild is still inside a rebuild.
  return { rebuildInProgress: isRebuildInProgress(sessionId) }
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
 * Also `null` while another replay of the same session is STILL IN FLIGHT
 * (#7477): the swap is deferred to the end that closes the last window, so
 * overlapping replays produce exactly one swap, sliced at the outermost
 * baseline. That is what keeps a live message appended between the two starts
 * — the racer #7420 protects — out of the discarded prefix.
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
  // delta replay's window closes too. The live-arrival ids themselves stay
  // readable for `sweepUnansweredPromptsAtReplayEnd`, which the caller runs
  // after this — see `closeReplayWindow`.
  if (sessionId) closeReplayWindow(sessionId)
  if (!sessionId || !_rebuildBaseline.has(sessionId)) {
    return { swappedMessages: null }
  }
  // #7477 — a window is still open (this end belongs to an INNER replay of an
  // overlapping pair), so the array is not yet the authoritative set and there
  // is nothing to swap to. Defer to the end that closes the last window: it
  // slices at the outer baseline and covers both replays' appended tails in one
  // update. `closeReplayWindow` above already decremented, so > 0 here means a
  // replay is genuinely still streaming — an unmatched end reads 0 and swaps,
  // as it did before.
  if (isReplayWindowOpen(sessionId)) {
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
  if (!isReplayWindowOpen(sessionId)) return
  const existing = _liveDuringReplay.get(sessionId)
  const ids = existing ?? new Set<string>()
  // LRU-by-update, like `_historyCursors`: delete-then-set so the touched
  // session moves to the Map tail and is never the key the cap evicts. A plain
  // `.set` on an existing key keeps its old slot.
  if (existing) _liveDuringReplay.delete(sessionId)
  _liveDuringReplay.set(sessionId, ids)
  ids.add(messageId)
  while (_liveDuringReplay.size > MAX_LIVE_REPLAY_LEDGERS) {
    const oldest = _liveDuringReplay.keys().next().value
    if (oldest === undefined) break
    _liveDuringReplay.delete(oldest)
    // LOUD, never silent (#7456). An evicted ledger un-protects every question
    // it held, so the next `history_replay_end` sweep stamps them and destroys
    // those answer paths. If this ever fires in the wild, the cap is wrong.
    console.warn(
      `[replay-reconcile] live-question ledger cap of ${MAX_LIVE_REPLAY_LEDGERS} exceeded — ` +
        `evicted session "${oldest}" (#7456). A live AskUserQuestion that raced that ` +
        `session's replay may now be stamped '${REPLAY_RESOLVED_PLACEHOLDER}'.`,
    )
  }
}

/** Is a replay window open for this session (refcount > 0)? */
function isReplayWindowOpen(sessionId: string): boolean {
  return (_replayWindowOpen.get(sessionId)?.depth ?? 0) > 0
}

/**
 * Decrement the window refcount and, when the LAST window closes, release the
 * session's live-arrival ledger out of `_liveDuringReplay` (#7455 / #7456).
 *
 * The released ids move to the single-slot `_sweepableLedger` rather than being
 * dropped, because the caller runs `sweepUnansweredPromptsAtReplayEnd` for this
 * same session on the very next statement — the sweep stays a pure, repeatable
 * read, and nothing is retained per-session for a session that is replayed once
 * and then pruned.
 */
function closeReplayWindow(sessionId: string): void {
  const replayWindow = _replayWindowOpen.get(sessionId)
  if (replayWindow && replayWindow.depth > 1) {
    replayWindow.depth -= 1
    return
  }
  // Last (or unmatched) end — the whole record goes, `openLen` with it (#7492).
  _replayWindowOpen.delete(sessionId)
  const ids = _liveDuringReplay.get(sessionId)
  _liveDuringReplay.delete(sessionId)
  _sweepableLedger = ids && ids.size > 0 ? { sessionId, ids } : null
}

/**
 * The live-arrival ids in force for this session: the open window's ledger, or
 * the just-closed window's released one while its sweep is still pending.
 */
function ledgerFor(sessionId: string): ReadonlySet<string> | undefined {
  const open = _liveDuringReplay.get(sessionId)
  if (open) return open
  return _sweepableLedger?.sessionId === sessionId ? _sweepableLedger.ids : undefined
}

/**
 * How many replays are in flight for this session (0 ⇒ no window open).
 * Testing / diagnostics — the refcount is what #7455 turned the window into,
 * and a leaked non-zero depth is the failure that teardown must prevent.
 */
export function getReplayWindowDepth(sessionId: string | null | undefined): number {
  if (!sessionId) return 0
  return _replayWindowOpen.get(sessionId)?.depth ?? 0
}

/**
 * Session ids currently RETAINED in the live-arrival ledger map, in LRU order
 * (oldest first). Testing / diagnostics: the leak in #7456 is precisely an
 * entry that stays here after its session's last replay.
 */
export function getLiveReplayLedgerSessionIds(): string[] {
  return [..._liveDuringReplay.keys()]
}

/**
 * Forget ALL replay-reconcile state for one session (#7456).
 *
 * Called by both clients wherever the store itself drops a session wholesale —
 * the `session_list` prune and `session_timeout` — because those paths already
 * clear `sessionStates` and the persisted messages, and used to leave this
 * module's per-session entries behind with nothing left to correspond to.
 *
 * Unlike `resetReplayReconcile`, this DOES drop the session's history cursor:
 * the session is gone server-side, so a cursor for it can only ever be dead
 * weight in the next `auth` payload.
 */
export function dropReplaySessionState(sessionId: string | null | undefined): void {
  if (!sessionId) return
  _rebuildBaseline.delete(sessionId)
  _replayWindowOpen.delete(sessionId)
  _liveDuringReplay.delete(sessionId)
  _historyCursors.delete(sessionId)
  if (_sweepableLedger?.sessionId === sessionId) _sweepableLedger = null
}

/** Was this prompt recorded as a live arrival during the current window? */
export function wasPromptLiveDuringReplay(
  sessionId: string | null | undefined,
  messageId: string | null | undefined,
): boolean {
  if (!sessionId || !messageId) return false
  return ledgerFor(sessionId)?.has(messageId) === true
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
 *
 * That premise is still WRONG for one case, and it is fixed on the SERVER rather
 * than here (#7457): a question the agent is genuinely still blocked on comes
 * back through the ordinary replay, so it carries `historySeq` and is
 * indistinguishable from a long-answered one by anything the client can see. The
 * daemon re-sends every still-pending question as a live frame right after
 * `history_replay_end` (`ws-history.resendPendingQuestions`), and
 * `dispatchUserQuestion` supersedes the copy this sweep just stamped. Do not try
 * to carve that case out here — there is nothing in `messages` to carve it out
 * BY, which is the whole reason it needed a server-side answer.
 */
export function sweepUnansweredPromptsAtReplayEnd<T extends SweepablePrompt>(
  sessionId: string | null | undefined,
  messages: readonly T[],
): T[] | null {
  if (!sessionId) return null
  const live = ledgerFor(sessionId)
  const isStampable = (m: T): boolean =>
    m.type === 'prompt' && !m.answered && !m.requestId && !(live?.has(m.id) === true)
  if (!messages.some(isStampable)) return null
  return messages.map((m) =>
    isStampable(m) ? ({ ...m, answered: REPLAY_RESOLVED_PLACEHOLDER } as T) : m,
  )
}
