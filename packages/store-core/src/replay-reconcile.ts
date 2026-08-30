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
 *      pre-replay prefix as a baseline; replayed entries append AFTER it; at
 *      end, slice the array down to the appended tail (the replayed set) in a
 *      single store update. The baseline records the prefix's message IDS and
 *      re-derives the cut at each use (#7524), so a store path that REMOVES a
 *      message mid-window — Stop dropping the queued bubbles — moves the cut
 *      instead of leaving it pointing at the wrong element. When two full replays of one session overlap the
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
 * Ordering note (replay × delta-flusher race, #5588 / #7519): a forced delta
 * flush that lands DURING a full rebuild appends a streamed response into the
 * tail just like a replayed entry, so it survives the swap. A flush that lands
 * AFTER `history_replay_end` (rebuild already cleared) appends normally. Either
 * way the swap only ever slices off the pre-baseline prefix, so a racing flush
 * can never be duplicated or dropped — see `reconcileReplayEnd` and the race
 * tests in `replay-reconcile.test.ts`.
 *
 * It CAN now be reordered relative to replayed entries, and that is the one
 * clause #7519 retracts. This note used to say array order was preserved and
 * therefore nothing moved; array order was the bug. Where every append during
 * the window is accounted for, the swap returns (everything the replay
 * delivered, in the server's `historySeq` order) ++ (everything that arrived
 * live, in arrival order) — so a flush that landed between two replayed entries
 * comes back after both, which is where a live streamed response chronologically
 * belongs. Measured: `['r-1','f-1','r-2']` before, `['r-1','r-2','f-1']` after,
 * pinned by the pair of tests in the `#5588` block. Where the record is
 * incomplete or un-alignable the swap falls back to array order exactly as
 * described above.
 *
 * #7524 does not touch that shape: it changes only HOW the end of the prefix is
 * identified (by the ids captured at window open, not by a fixed index), so the
 * cut still falls between prefix and tail — and now keeps falling there when the
 * prefix shrinks underneath it.
 */

/**
 * Per-session full-rebuild state. Absent key ⇒ no rebuild in progress for that
 * session (delta replay or no replay). The value is the {@link RebuildBaseline}
 * adopted from the OUTERMOST replay WINDOW (#7492) — where the deferred swap
 * cuts, held as message IDENTITY rather than as a bare array index (#7524).
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
const _rebuildBaseline = new Map<string, RebuildBaseline>()

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
 * The value carries {@link ReplayWindow.baseline} alongside the depth because
 * that record has exactly this map's lifetime (#7492) — see the interface.
 */
const _replayWindowOpen = new Map<string, ReplayWindow>()

/**
 * The open replay window for one session: the refcount, plus the BASELINE
 * captured when it OPENED — where the deferred swap will cut.
 *
 * One record and not two maps, deliberately. The baseline is meaningful for
 * exactly as long as the refcount is non-zero and must be dropped at the same
 * instant — so making it a field of the refcount's own value means the four
 * teardown paths (`closeReplayWindow`'s last decrement, `resetReplayReconcile`,
 * {@link dropReplaySessionState}, and the `delete` inside `closeReplayWindow`)
 * cannot clear one and leave the other. A sibling map would be a second thing
 * to remember at each of them, which is the drift the `_rebuildBaseline`
 * teardown comment already warns about at length.
 */
interface ReplayWindow {
  /** How many replays are in flight for this session right now (>= 1). */
  depth: number
  /**
   * The prefix as it stood at the 0->1 transition — the OUTERMOST start,
   * whatever KIND it was (#7492).
   *
   * #7477 made the outermost FULL rebuild own {@link _rebuildBaseline}, which
   * covers `start(full) start(full) end end`. It does not cover a full rebuild
   * nested inside a DELTA window: the delta contributes no baseline, so the
   * nested full start is the first to set one and captures a prefix that
   * already counts everything appended during the delta — including a live
   * racer, which the deferred swap then slices off. That is #7420's own window
   * again, reached by a different interleave: the ledger vouches for the
   * message right up to the moment the swap discards it.
   *
   * So the OUTERMOST WINDOW owns the baseline, not the outermost full rebuild,
   * and a nested full start adopts this record instead of snapshotting its own.
   * At depth 1 the two are the same prefix, so every #7477 case is unchanged.
   *
   * That interleave left ONE artifact, which was this comment's KNOWN LIMIT and
   * is now fixed (#7519): when the delta actually APPENDED entries before the
   * nested full start, those entries are inside the preserved tail, so the full
   * replay's re-delivery of them dedups against them
   * ({@link replayDedupCache} is scoped at the same baseline) and in ARRAY order
   * they keep their early position while the older history the full replay
   * delivers lands after — a correctly-populated but mis-ORDERED transcript
   * (`['d-1','racer','old']` where `['old','d-1','racer']` was wanted).
   *
   * Fixing it needed what this comment said it needed: the swap distinguishing
   * replayed appends from live ones, which is a change to the "slice off a
   * prefix" SHAPE rather than to where the prefix ends. That is
   * {@link ReplayAppend} — per-append, positional, recorded while the window is
   * open and dying with it — and the swap now orders the tail by it. Pinned by
   * `full rebuild nested inside a DELTA window (#7492) > the delta's own appends
   * come back in HISTORY order, racer last (#7519)` and by the whole
   * `append PROVENANCE orders the swapped tail (#7519)` block.
   */
  baseline: RebuildBaseline
}

/**
 * Where the deferred swap cuts, in a form that survives a non-append-only
 * mutation of `messages` while the window is open (#7524).
 *
 * A bare `openLen` is an array INDEX, captured once at the window's 0->1
 * transition and held until the last end — a span that can cover 30s of
 * back-pressure (`BACKPRESSURE_MAX_WAIT_MS`, ws-history.js). Nothing in this
 * module owns `messages`, and store paths REMOVE from it without touching the
 * window: `sendInterrupt` drops every queued bubble on Stop
 * (`connection.ts:3721` dashboard, `:1876` app), `cancelQueuedMessage` drops
 * one (`:3793` / `:1918`), and `reorderEmptyResponseSlot` moves one to the end
 * of the array (`message-handler.ts:2498-2511`). After any of those the index
 * addresses a different element and the swap cuts there anyway. Measured on the
 * reviewer's reproduction: `['r3']` where `['r1','r2','r3']` had just been
 * replayed, and `[]` — a blanked transcript — for a larger shrink. Both
 * silent.
 *
 * So the record also carries the IDS the prefix consisted of, and
 * {@link resolveBaselineIndex} re-derives the cut from them against the array
 * as it stands at each use.
 *
 * Identity rather than a notification from those three call sites, and the
 * difference is the whole point: a "tell the reconciler you shrank" hook is
 * correct only for the mutations someone remembered to wire it to, and the next
 * one lands silently — the guard-wired-to-only-some-of-its-callers shape this
 * repo keeps a catalogue entry for. Re-deriving needs no cooperation from any
 * mutator, present or future.
 *
 * Clamping — `Math.min(openLen, messages.length)` at the slice — is NOT an
 * alternative: `Array.prototype.slice` already clamps a past-the-end start, so
 * the expression is INERT. It cannot even stop the blanked transcript, which is
 * `slice` landing exactly AT the end rather than past it.
 */
interface RebuildBaseline {
  /**
   * The prefix length at window open. The cut whenever the prefix is intact,
   * which is every append-only window — i.e. the overwhelming majority.
   */
  openLen: number
  /**
   * The ids of `messages[0..openLen)` at window open, in order — or `null` when
   * the snapshot could not be taken (see {@link snapshotPrefix}), which degrades
   * to the pre-#7524 index behaviour rather than to a guess.
   */
  prefixIds: readonly string[] | null
  /**
   * Every append made since the window opened, in order, each carrying whether
   * the frame that produced it was REPLAY-delivered (#7519). `null` once the
   * record can no longer be trusted positionally — see
   * {@link noteReplayMessagesUpdate}.
   *
   * On the BASELINE record and not on {@link ReplayWindow} itself, for a
   * lifetime reason that is load-bearing rather than tidy: `reconcileReplayEnd`
   * calls `closeReplayWindow` — which DELETES the window record — three
   * statements before it reads `_rebuildBaseline` and performs the swap. The
   * two maps hold the SAME object (`ReplayWindow.baseline` is shared, never
   * copied), so provenance parked here is still readable at the one moment the
   * swap needs it, and is still dropped by all four teardowns because they drop
   * both maps. A sibling map would have neither property.
   */
  appends: ReplayAppend[] | null
}

/**
 * ONE append made while a replay window was open — the per-append provenance
 * the swap orders by (#7519).
 *
 * PER-APPEND and POSITIONAL, because #7556 proved an id-keyed SET insufficient:
 * during a full rebuild `replayDedupCache` is scoped to the appended tail, so a
 * replayed entry whose id matches a SURVIVING prefix entry is appended as a
 * second copy, and a membership test then matches the PREFIX copy and cuts at 0
 * — an identity slice, which is #7477's failure. The record is therefore a
 * parallel ARRAY, aligned index-for-index with the tail the swap keeps, and
 * every use of it re-verifies that alignment against the array as it stands
 * (see {@link provenanceStart}) rather than assuming it.
 */
interface ReplayAppend {
  /**
   * The appended message's id. Never `null`: an id-less append disables the
   * whole record instead of recording a hole, on the same reasoning as
   * {@link snapshotPrefix} — two id-less entries would compare EQUAL in the
   * alignment check and silently license a wrong re-order.
   */
  id: string
  /**
   * The `historySeq` the delivering frame carried, or `null` when it carried
   * none — i.e. when the append was a LIVE arrival.
   *
   * The same discriminator {@link noteLivePromptDuringReplay} already runs on,
   * and for the same reason: `replayHistory` stamps every replayed entry
   * (ws-history.js `sendHistoryEntry`) and a live broadcast never does. Held as
   * the seq itself rather than as a boolean because the seq is the server's
   * authoritative ORDER for history, which is what makes the swap chronological
   * rather than merely grouped — see {@link orderByProvenance}.
   */
  seq: number | null
}

/** A message's id, or `null` when it has none this module can match on. */
function idOf(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null
  const id = (message as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * Snapshot the prefix a replay window opens over.
 *
 * Bails to `prefixIds: null` — index only — the moment an entry has no matchable
 * id, rather than recording a snapshot with a HOLE in it. The walk in
 * {@link resolveBaselineIndex} would stall AT that hole, and a hole early in the
 * prefix collapses the cut towards 0 — an identity slice, i.e. a swap that
 * silently does not happen and leaves the discarded prefix on screen for the
 * life of the connection. That is #7477's failure, not #7524's, and it is worse
 * than the index this degrades to.
 *
 * How reachable, stated rather than assumed: the `ChatMessage` TYPE requires a
 * non-empty string id and no producer omits one, but the type is not enforced on
 * REHYDRATION — `loadSessionMessages` (dashboard `persistence.ts:688-707`, and
 * the app's equivalent) returns `Array.isArray(parsed) ? parsed : []` straight
 * out of `JSON.parse(localStorage)` with no per-element validation. A legacy or
 * corrupt blob can therefore seed an id-less entry, and ONE anywhere in the
 * prefix reverts that whole window to the pre-#7524 index — silently, with no
 * signal that it happened. The degradation is deliberate and pinned; "floor,
 * not a live path" was too strong.
 */
function snapshotPrefix(messages: readonly unknown[]): RebuildBaseline {
  const prefixIds: string[] = []
  for (const message of messages) {
    const id = idOf(message)
    if (id === null) return { openLen: messages.length, prefixIds: null, appends: [] }
    prefixIds.push(id)
  }
  return { openLen: prefixIds.length, prefixIds, appends: [] }
}

/**
 * Where to cut `messages` for this baseline, RIGHT NOW.
 *
 * A greedy SUBSEQUENCE walk. Being exact about that is the point of this
 * paragraph: the first version of it claimed the walk "can only ever
 * UNDER-advance", which is false, and a comment describing a stronger check
 * than its code performs is its own catalogued defect (#7290, #7291).
 *
 * Each recorded prefix id in turn is compared against the message sitting AT the
 * cut. On a match the cut advances by one; otherwise that prefix id is skipped
 * as removed and the NEXT one is tried against the SAME message. So
 * `messages[0..cut)` is the greedy prefix of `messages` that matches
 * `prefixIds` as a subsequence, and `cut <= openLen` always — the walk can never
 * consume more entries than the prefix held. It does NOT stop at the first
 * mismatch, and must not: a stop-on-mismatch walk returns 0 for a removal at the
 * FRONT of the prefix.
 *
 * What that buys, stated as narrowly as it is true:
 *
 *   - Appends never move the cut. Whatever is appended sits past the surviving
 *     prefix, and the walk halts at the first message that does not continue the
 *     match.
 *   - A removal moves the cut BACK by the number removed, UNLESS the message now
 *     at the cut equals one of the prefix ids the walk has not yet tried — i.e.
 *     unless the replay re-delivers, at exactly that position, an id from the
 *     removed part of the prefix.
 *
 * WHAT THIS FUNCTION STILL CANNOT DO (#7543), unchanged and stated here because
 * its CALLER is where the answer lives. When the surviving prefix runs out and
 * the tail continues the match, the walk marches into the replayed tail and
 * would have the swap discard it. Measured: `[]` for a whole-prefix-removed
 * window whose ids the replay re-delivers in order, and `['c']` — the cut moved
 * by ZERO after two removals — for the splice-then-re-append shape. `main`
 * returns those same two values, so this is the #7524 symptom in a shape
 * identity cannot reach, not something identity broke. Because `replayHistory`
 * re-delivers oldest-first, a prefix entry surviving at the front normally
 * blocks it (the oldest id is already consumed, so it cannot match a later one)
 * — normally, not always: a server-side trim can make the tail begin at a LATER
 * prefix id, which does continue the match.
 *
 * Not "no id-based fix has been found" — no such fix EXISTS, and that is pinned
 * rather than argued: `#7543 is undecidable from the IDS, and DECIDED by the
 * provenance` builds the legitimate empty replay (prefix intact, history trimmed
 * to nothing, correct swap `[]`) beside the degenerate one (prefix removed, same
 * ids re-delivered, correct swap `[a, b]`) and asserts they present this
 * function the SAME id sequence against the SAME `prefixIds`. Since `idOf` is
 * the only reader this module has of a message, any resolution HERE that returns
 * the replayed set for the second returns it for the first too and breaks
 * `empty replay (baseline at end) swaps to []` in the same motion — which is
 * what rules out the three shapes reviewed for #7543 (a degenerate-outcome
 * guard, an `openLen`-bounded fallback, a survivor anchor). Object identity is
 * not the missing input either: a mid-window update REPLACES a prefix message's
 * object (`finalizeThinkingStreams`, `peelSlotContent`, every tool_result patch
 * — all `{ ...m, … }`), so an identity walk stalls at the first patched prefix
 * entry and collapses the cut to an identity slice, i.e. #7477's failure on a
 * much more reachable path.
 *
 * So the missing input was never in this function's arguments, and #7519 supplied
 * it from outside them: per-append provenance ({@link ReplayAppend}), which knows
 * the empty replay appended NOTHING and the degenerate one appended two. The cut
 * both callers use is {@link resolveCut}, which takes the smaller of this walk
 * and `messages.length - appends.length`. Leave THIS function strict — a walk
 * that tried to guess its way out of the above is the thing the pin refuses, and
 * it would still be wrong.
 *
 * Strict rather than a search-ahead for a MEASURED reason, then, and not an
 * absolute one: a walk allowed to scan forward makes that limit the NORMAL case
 * instead of the edge, because it finds a removed id's re-delivered copy
 * anywhere in the tail rather than only at the cut. The mutant that does exactly
 * that dies on `reorderEmptyResponseSlot`'s move-to-the-end and on the
 * re-delivered-id pin. Where the two resolutions differ from the raw index, this
 * one keeps strictly more: measured `['a','b']` here against `main`'s `['b']`.
 *
 * Cost is O(openLen) — the PREFIX, which is precisely the part that used to cost
 * nothing. It is NOT free work already being done: the `messages.slice()` both
 * callers pay is O(n - cut), the TAIL. Measured on node 22 over a 1000-entry
 * replay: 4.2ms at a 1 000-entry prefix, 20.3ms at 10 000, 47.7ms at 20 000,
 * against ~0.4ms for the bare index — ~20µs per replayed entry at a 10k prefix,
 * and the server's ring caps a replay at `maxMessages` (default 1000).
 * Immaterial, and said with the right numbers rather than waved at. Recomputed
 * rather than memoised, because a cache keyed on anything this module can see (a
 * length, an array identity) is exactly what shrink-then-append defeats.
 */
function resolveBaselineIndex(baseline: RebuildBaseline, messages: readonly unknown[]): number {
  const { openLen, prefixIds } = baseline
  // Index-only snapshot — the documented degradation, never a guess. There is
  // deliberately no `openLen === 0` fast path above this: an empty prefix gives
  // `prefixIds: []`, the loop below never runs, and the walk returns 0 anyway.
  // A branch whose two sides cannot be told apart by any input is a branch no
  // test can prove, so it is not written.
  if (prefixIds === null) return openLen
  let cut = 0
  for (const prefixId of prefixIds) {
    if (cut >= messages.length) break
    if (idOf(messages[cut]) === prefixId) cut += 1
  }
  return cut
}

/**
 * Where the recorded appends BEGIN in `messages` right now — or `null` when the
 * record cannot be trusted against this array (#7519).
 *
 * The appends are, by construction, the LAST `appends.length` entries: nothing
 * in this module appends, and {@link noteReplayMessagesUpdate} gives the record
 * up the moment an update disturbs that shape. "By construction" is not a
 * licence to assume it, though — the record is written by call sites this module
 * does not control and cannot enumerate, so every use re-verifies the whole run
 * positionally, id by id, and returns `null` on the first disagreement.
 *
 * That verification is the mechanism's load-bearing guard, not a belt-and-braces
 * extra. A provenance array that has DRIFTED by one position describes each tail
 * entry with its neighbour's provenance, so the swap would reorder against a
 * lie — silently, and in exactly the direction that looks like a fix. Everything
 * downstream is gated on this returning non-null, so a drift degrades to the
 * pre-#7519 behaviour (array order, walk-resolved cut) instead.
 */
function provenanceStart(baseline: RebuildBaseline, messages: readonly unknown[]): number | null {
  const { appends } = baseline
  if (appends === null) return null
  const start = messages.length - appends.length
  if (start < 0) return null
  for (let i = 0; i < appends.length; i++) {
    const append = appends[i]
    if (append === undefined || idOf(messages[start + i]) !== append.id) return null
  }
  return start
}

/**
 * Where the deferred swap (and the dedup cache, which must be the SAME number —
 * see {@link replayDedupCache}) cuts `messages` right now.
 *
 * Two independent resolutions of the same question, and the SMALLER wins:
 *
 *   - the id walk ({@link resolveBaselineIndex}), which knows what the prefix
 *     was, and
 *   - the provenance run, which knows how many entries this window APPENDED —
 *     and everything a window appended is, by definition, past the prefix.
 *
 * `Math.min` and not the provenance number alone, because the record is allowed
 * to UNDER-count: an append made by a path that does not route through
 * {@link noteReplayMessagesUpdate} is simply absent from it. Taking the minimum
 * makes an under-count cost only the improvement — the cut can never move LATER
 * than the walk already put it, so no entry this module used to keep can be
 * dropped by provenance being incomplete. Over-counting cannot survive
 * {@link provenanceStart}'s alignment check, which returns `null` and takes the
 * walk unmodified.
 *
 * Verified, not counted. `provenanceStart` walks the run id by id on this path,
 * which is the `replayDedupCache` hot path, and that is deliberate: taking the
 * COUNT alone here (and keeping the verification only for the swap's ordering
 * guard) reds `the record is POSITIONAL: a tail that no longer matches it is
 * refused, not trusted` — measured, on exactly that mutant. An unverified count
 * widens the dedup window past the prefix boundary, and a replayed entry can
 * then be suppressed by an about-to-be-discarded prefix id and lost from the
 * swap, which is #7477's failure. The cost was measured over a whole 1000-entry
 * replay on node 22 rather than argued: 5.7ms vs 2.6ms at a 0-entry prefix,
 * 5.9 vs 4.1 at 1 000, 25.4 vs 23.2 at 10 000 — +1.8ms across an entire replay
 * at the server's ring cap, dominated by the O(n·openLen) walk #7524 already
 * measured and accepted. The asymptotics are real; the magnitude does not buy
 * the guard's removal.
 *
 * The provenance side is what closes #7543. That issue's degenerate case (whole
 * prefix removed, the replay re-delivering its ids) and the legitimate empty
 * replay beside it present the WALK identical inputs — proven, not asserted, and
 * that proof is why an id-only fix was refused. They do not present the same
 * inputs here: the empty replay recorded ZERO appends and the degenerate one
 * recorded two, so `messages.length - appends.length` is `2` for the first and
 * `0` for the second while the walk says `2` for both.
 */
function resolveCut(baseline: RebuildBaseline, messages: readonly unknown[]): number {
  const walk = resolveBaselineIndex(baseline, messages)
  const start = provenanceStart(baseline, messages)
  return start === null ? walk : Math.min(walk, start)
}

/**
 * The swapped tail, in CHRONOLOGICAL order rather than in array order (#7519).
 *
 * `tail[i]` is described by `appends[i]` — the caller has already established
 * that via {@link provenanceStart}. The order is then:
 *
 *   1. everything the replay DELIVERED, sorted by `historySeq` — the server's
 *      own monotonic per-session order, so this is history's true chronology and
 *      not merely the order the frames happened to arrive in, then
 *   2. everything that arrived LIVE, in arrival order.
 *
 * Sorting the replayed half is what makes the transformation correct rather than
 * just different, and it is the whole reason the provenance holds the seq rather
 * than a boolean. On #7519's worked example a mere replayed/live PARTITION
 * yields `['d-1','old','racer']` — the delta replayed 'd-1' before the nested
 * full rebuild re-delivered the older 'old', so delivery order is not history
 * order — where the seqs put it back to `['old','d-1','racer']`.
 *
 * Live LAST, and stated as the assumption it is: a live broadcast is emitted as
 * the event happens, so it is newer than any history entry the same window is
 * replaying. The one way that could be false is a replay delivering an entry
 * recorded AFTER a live arrival — and such an entry is one the client already
 * holds from that live broadcast, so `replayDedupCache` suppresses it and it is
 * never appended at all.
 *
 * A live entry with no seq to sort by keeps its arrival order; a replayed entry
 * whose frame carried no seq is indistinguishable from a live one HERE by
 * construction (that absence is the discriminator) and sorts with the live half.
 */
function orderByProvenance<T>(tail: readonly T[], appends: readonly ReplayAppend[]): T[] {
  const replayed: { index: number; seq: number }[] = []
  const arrivedLive: number[] = []
  for (let i = 0; i < appends.length; i++) {
    const seq = appends[i]?.seq ?? null
    if (seq === null) arrivedLive.push(i)
    else replayed.push({ index: i, seq })
  }
  // Explicit index tiebreak rather than a bare comparator leaning on V8's stable
  // sort: equal seqs (and a re-delivered duplicate the dedup let through) then
  // keep delivery order by the comparator's own terms, not by the engine's.
  replayed.sort((a, b) => a.seq - b.seq || a.index - b.index)
  const out: T[] = []
  for (const { index } of replayed) out.push(tail[index] as T)
  for (const index of arrivedLive) out.push(tail[index] as T)
  return out
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
  // #7519 — the frame scope is per-connection state too. `endReplayFrame`'s
  // `finally` is the normal clear; this covers a teardown that lands with a
  // dispatch still on the stack.
  _currentFrameSeq = null
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
 * `history_replay_start`; `currentMessages` is the session's `messages` array
 * right now.
 *
 * For a full rebuild we record the baseline so the appended replay tail can be
 * sliced out at end. The ARRAY and not its length, since #7524: the baseline
 * has to be re-derivable from message identity, or a mid-window removal leaves
 * it addressing the wrong element (see {@link RebuildBaseline}). Making it a
 * required parameter rather than an optional extra is the guard — the compiler
 * refuses a caller that still hands over only a count, which no test can do for
 * a call site that has not been written yet.
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
  currentMessages: readonly unknown[],
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
  const replayWindow: ReplayWindow = existing ?? {
    depth: 0,
    baseline: snapshotPrefix(currentMessages),
  }
  replayWindow.depth += 1
  if (isOutermost) {
    // #7492 — the record (and with it the baseline) is installed here and
    // nowhere else, so the captured prefix is the OUTERMOST start's by
    // construction.
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
    // #7492 — and the value is the WINDOW's prefix, not one snapshotted here.
    // They are the same prefix when a full start opened the window; they differ
    // when a DELTA did, and this start's own view then counts a live racer that
    // arrived during the delta straight into the discarded prefix.
    //
    // The window's record is SHARED, not copied, and since #7519 that is
    // load-bearing rather than merely economical: `noteReplayMessagesUpdate`
    // writes the append provenance onto THIS object through the window map,
    // while `reconcileReplayEnd` reads it back through `_rebuildBaseline` —
    // three statements after `closeReplayWindow` has dropped the window. One
    // object is what makes those the same record. (`openLen` and `prefixIds`
    // are still never mutated; `appends` is, in place, and only here.) The two
    // maps are otherwise cleared independently, on paths that must not clear
    // the other — which is exactly that `closeReplayWindow`-then-swap order.
    if (!_rebuildBaseline.has(sessionId)) {
      _rebuildBaseline.set(sessionId, replayWindow.baseline)
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
  const baseline = sessionId ? _rebuildBaseline.get(sessionId) : undefined
  // #7524 — resolved against THIS array, on every call. The cut and the swap's
  // cut are the same computation over the same record, so a mid-window shrink
  // moves both together; scoping the dedup cache and the swap differently is
  // how a replayed entry gets suppressed by a prefix that is about to be
  // discarded (the hazard the paragraph above is about).
  if (baseline) return messages.slice(resolveCut(baseline, messages))
  return messages
}

// ---------------------------------------------------------------------------
// #7519 — per-append provenance: which of the tail's entries the replay
// DELIVERED, and which arrived live while it streamed
// ---------------------------------------------------------------------------

/**
 * The `historySeq` of the frame currently being dispatched, or `null` outside a
 * frame and for any frame that carried none — i.e. for a LIVE broadcast.
 *
 * A module-level current-frame slot rather than a parameter threaded through
 * every append, because the append sites are not a list this module can hold:
 * the two clients append session messages from ~22 places between them and the
 * shared dispatch table adds more. The #7524 doc one screen up spells out why a
 * per-call-site notification is the wrong shape — "correct only for the
 * mutations someone remembered to wire it to, and the next one lands silently"
 * — so the wiring is instead ONE observation point per client
 * ({@link noteReplayMessagesUpdate}, hooked into each `updateSession`) plus this
 * one frame scope, and a handler added tomorrow is covered without being told.
 *
 * Cleared by {@link endReplayFrame} in a `finally`, and that is load-bearing: a
 * seq left set past the dispatch would stamp REPLAYED on the very next
 * store-driven append, and the nearest such append is the optimistic user
 * bubble a person types mid-replay — the live racer this whole family of issues
 * exists to protect.
 */
let _currentFrameSeq: number | null = null

/**
 * Defensive cap on ONE window's provenance record, in the same shape as
 * {@link MAX_LIVE_REPLAY_LEDGERS} and for the same reason: the array grows by
 * one per append for as long as the window is open, and the module already
 * documents (at {@link _rebuildBaseline}) that a `history_replay_start` with no
 * matching end strands the window open.
 *
 * Comfortably above any real replay — the server's ring is capped at
 * `maxMessages` (default 1000) and overlapping replays deliver at most a couple
 * of those — so reaching it means something is wrong rather than something is
 * big. Over the cap the record is DROPPED rather than truncated: a truncated
 * array is positionally wrong, which is the one state this mechanism must never
 * be in, whereas dropping it degrades to the documented pre-#7519 behaviour.
 */
export const MAX_REPLAY_APPEND_PROVENANCE = 2048

/**
 * Read the frame's `historySeq`, which is the whole liveness discriminator: the
 * server stamps every replayed entry (`sendHistoryEntry`, ws-history.js) and a
 * live broadcast never carries one.
 *
 * One reader, here, so the two clients cannot drift on it — the reason
 * {@link beginReplayFrame} takes the raw frame rather than a boolean the caller
 * derived. `noteLivePromptDuringReplay`'s "the CALLER decides liveness" is the
 * older shape and stays as it is; it is asked about ONE message it already
 * holds, whereas this is asked about every append a frame happens to cause.
 */
function frameSeqOf(frame: unknown): number | null {
  if (typeof frame !== 'object' || frame === null) return null
  const seq = (frame as { historySeq?: unknown }).historySeq
  // The SAME validity rule `recordHistorySeq` applies, deliberately: a value it
  // would refuse to advance the cursor with must not be trusted to order the
  // transcript either, and two different notions of "a valid seq" in one module
  // is a drift waiting to happen. An invalid one falls to `null`, i.e. LIVE,
  // which is the conservative direction — a mis-classified replayed entry sorts
  // late, while a mis-classified LIVE one would be hoisted into history and
  // that is the racer these issues exist to protect.
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return null
  return seq
}

/**
 * Open the provenance scope for one dispatched wire frame (#7519). Pass the RAW
 * frame; the discriminator is read here so both clients read it identically.
 *
 * MUST be paired with {@link endReplayFrame} in a `finally` — see
 * `_currentFrameSeq` for what a leaked scope mislabels.
 */
export function beginReplayFrame(frame: unknown): void {
  _currentFrameSeq = frameSeqOf(frame)
}

/** Close the provenance scope opened by {@link beginReplayFrame}. */
export function endReplayFrame(): void {
  _currentFrameSeq = null
}

/**
 * Observe one mutation of a session's `messages` and record the provenance of
 * anything it APPENDED (#7519).
 *
 * Hooked into each client's `updateSession` — the single funnel every session
 * message write already goes through, including the shared dispatch table's,
 * which reaches it via the store adapter. A no-op (one Map lookup) for a session
 * with no replay window open, which is every session almost all of the time.
 *
 * Three shapes, and only the third loses the record:
 *
 *   - APPENDED at the end (the ordinary case, whatever produced it) — the new
 *     entries are recorded against the frame currently in scope.
 *   - the recorded run is still the array's tail, nothing added — a patch in
 *     place (`tool_result`, `finalizeThinkingStreams`) or a REMOVAL that landed
 *     in the prefix. Kept: `sendInterrupt` dropping every queued bubble
 *     mid-window is exactly this, and it is #7543's own shape, so giving up
 *     here would give up the case the record exists to decide.
 *   - anything else — a reorder, an insert, a removal from inside the recorded
 *     run, a filtered append. The parallel array can no longer be aligned with
 *     the tail, so it is dropped and the swap reverts to its pre-#7519
 *     behaviour for the rest of the window.
 *
 * THE DEGRADATION THAT ACTUALLY BITES, named rather than left inside "anything
 * else" (#7577, found reviewing #7574). `sendMessage` appends the user's bubble
 * AND a `{ id: 'thinking' }` placeholder in one update (`connection.ts:3550`
 * dashboard, `:1710` app), and every `message` frame — every replayed history
 * entry included — STRIPS that placeholder while appending
 * (`ss.messages.filter((m) => m.id !== 'thinking' || …)`). So a user typing
 * mid-replay makes the next replayed entry a remove-then-append: the third shape
 * above, on the exact path — the optimistic bubble racing a replay — that this
 * whole family of issues exists to protect. Measured through the real dashboard
 * handler: `['h-2','racer','u-1','h-1']` against a truth of
 * `['h-1','h-2','racer','u-1']`, i.e. the #7519 artifact verbatim, and identical
 * to pre-#7519 (nothing lost, nothing duplicated, nothing moved).
 *
 * The same strip landing while the record is still EMPTY is quieter and not the
 * same shape: branch 2 is vacuous at `n === 0`, so the record is KEPT and the
 * append it could not classify is simply never recorded — an under-count, which
 * `resolveCut`'s `Math.min` and the swap's exact-alignment gate make safe. Both
 * are pinned (`KNOWN LIMIT: a user typing mid-replay …`, `KNOWN LIMIT: a strip
 * while the record is still EMPTY …`, plus one per client handler suite).
 *
 * Not repaired here because the repair is not the cheap thing it looks like:
 * telling a remove-then-append apart from a genuine reorder is a diff engine
 * over the record, and its wrong answer is a positionally DRIFTED provenance
 * array — the one state #7556 rules out. #7577 carries it, with both shapes and
 * that constraint.
 *
 * A third source of un-provenanced appends, recorded rather than degraded: the
 * "Sync Full History" JSONL slice (`handleRequestFullHistory`,
 * conversation-handlers.js) emits `fullHistory: true` and then bare `message`
 * frames with NO `historySeq` — `getFullHistoryAsync`'s JSONL entries carry no
 * `_seq` by construction. Alone that is benign and identical to `main`: every
 * append classifies LIVE, the live half keeps arrival order. Overlapped with a
 * seq-STAMPED replay it is not: the stamped half sorts in front of history it
 * does not order (`['r-1','r-2','j-1','j-2']` where `main` gives
 * `['j-1','j-2','r-1','r-2']`). Narrow — it needs Sync Full History to overlap a
 * `switch_session`/`subscribe_sessions` replay — and arguably ill-defined on
 * `main` too, so it is documented rather than guarded.
 *
 * The check is the cheap ANCHOR — the append point must still sit where an
 * untouched run would put it — and not the whole run, deliberately: the full
 * positional verification runs once at the swap ({@link provenanceStart}), where
 * it is the guard, rather than once per append, where it would be O(n) per
 * frame. Anything this admits is caught there and degrades to array order.
 *
 * "Anything this admits is caught there" is a claim with a history: it was FALSE
 * at `n === 0`, where the anchor used to be skipped entirely, and the review of
 * #7574 built the counterexample (a mid-array insert recorded a prefix entry as
 * an append, and the swap returned an order neither the walk nor array order
 * produces). It is true now because the empty-record case anchors on `before`'s
 * own last entry — see the two anchors below, which are deliberately different
 * per branch.
 */
export function noteReplayMessagesUpdate(
  sessionId: string | null | undefined,
  before: readonly unknown[],
  after: readonly unknown[],
): void {
  if (!sessionId) return
  const replayWindow = _replayWindowOpen.get(sessionId)
  if (!replayWindow) return
  const baseline = replayWindow.baseline
  const appends = baseline.appends
  if (appends === null) return
  const n = appends.length
  // The record IS `before`'s own tail, by construction and by every path above.
  // If it cannot be, this update is not one that can be reasoned about
  // positionally at all, and a record that is not the tail is the drifted array
  // #7556 rules out — so it goes rather than being argued with.
  if (n > before.length) {
    baseline.appends = null
    return
  }
  const recordAnchorId = n === 0 ? null : (appends[n - 1] as ReplayAppend).id
  // Branch 1's anchor — the position the append happened AT must be unmoved.
  // With entries recorded that is the record's last id. With an EMPTY record
  // there is no recorded id to check it with, and this used to accept
  // UNCONDITIONALLY (#7574 review, finding 2): a mid-array INSERT then took the
  // append branch and recorded the shifted last element of `before` — a PREFIX
  // entry — as an append, carrying the inserting frame's seq. `provenanceStart`
  // passes on that record (the ids really do line up), the over-count pulls the
  // cut below the walk, and the swap returns a prefix entry sorted to the end by
  // a fabricated seq: an order NEITHER the walk nor array order produces, which
  // is worse than any degradation and is exactly what the paragraph above
  // promises cannot happen. Measured on the reviewer's reproduction:
  // `['r-1','r-2','p3']` where `main` and the walk both give `['r-1','r-2']`.
  //
  // So an empty record anchors on `before`'s own last entry instead, and an
  // id-less anchor is a REFUSAL rather than a pass — no anchor at all is
  // accepted only when there is genuinely nothing to anchor on (an empty
  // `before`, which by the guard above implies an empty record).
  const appendAnchorId = recordAnchorId ?? idOf(before[before.length - 1] ?? null)
  const appendPointUnmoved =
    before.length === 0 ||
    (appendAnchorId !== null && idOf(after[before.length - 1] ?? null) === appendAnchorId)
  if (after.length >= before.length && appendPointUnmoved) {
    for (let i = before.length; i < after.length; i++) {
      const id = idOf(after[i])
      // The same bail as `snapshotPrefix`, for the same reason: a hole would
      // compare EQUAL to any other hole in the alignment check and license a
      // re-order nothing verified.
      if (id === null) {
        baseline.appends = null
        return
      }
      appends.push({ id, seq: _currentFrameSeq })
      if (appends.length > MAX_REPLAY_APPEND_PROVENANCE) {
        baseline.appends = null
        // Loud, and exactly once per window by construction (the record is gone
        // after this). Benign on its own — the swap falls back to array order —
        // but it can only be reached by a window that never closed, which is
        // not benign at all.
        console.warn(
          `[replay-reconcile] append-provenance cap of ${MAX_REPLAY_APPEND_PROVENANCE} exceeded ` +
            `for session "${sessionId}" (#7519) — the replay swap falls back to array order for ` +
            `this window. A window this long-lived is itself the bug to chase.`,
        )
        return
      }
    }
    return
  }
  // Branch 2 — nothing was appended and the record still describes the tail. An
  // EMPTY record describes the tail of ANY array vacuously (there are no entries
  // to disagree), which is why this stays unconditional at `n === 0` and does
  // NOT borrow branch 1's anchor: the whole-prefix removal #7543 is made of
  // (`messages` emptied while the record is still empty) arrives here, and
  // anchoring it would give up the case the record exists to decide. The cost is
  // that an append this update also made goes UNRECORDED rather than dropping
  // the record — an under-count, which `resolveCut`'s `Math.min` and the swap's
  // exact-alignment gate already make safe, and which is pinned as such.
  if (n === 0 || idOf(after[after.length - 1] ?? null) === recordAnchorId) return
  baseline.appends = null
}

/**
 * The provenance recorded for a session's open (or just-closed-and-not-yet-
 * swapped) window — testing / diagnostics. `null` when there is no record, or
 * when one was dropped as un-alignable.
 */
export function getReplayAppendProvenance(
  sessionId: string | null | undefined,
): readonly { id: string; seq: number | null }[] | null {
  if (!sessionId) return null
  const baseline = _replayWindowOpen.get(sessionId)?.baseline ?? _rebuildBaseline.get(sessionId)
  const appends = baseline?.appends
  return appends ? appends.map((a) => ({ ...a })) : null
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
  const baseline = _rebuildBaseline.get(sessionId) as RebuildBaseline
  _rebuildBaseline.delete(sessionId)
  // Slice off the pre-replay prefix → exactly the replayed (+ any racing live)
  // tail, in array order. The cut is re-derived from the prefix's ids against
  // THIS array (#7524), so a removal that landed anywhere inside the window
  // moves it instead of shifting the whole tail. A prefix still wholly present
  // and nothing appended yields [] (a session that genuinely had no replayed
  // entries, e.g. server-side trim to empty).
  const cut = resolveCut(baseline, messages)
  const tail = messages.slice(cut)
  // #7519 — order the tail by PROVENANCE when the record aligns with it exactly
  // (`cut === start` is that: the kept tail and the recorded appends are the
  // same run). An under-counted record leaves `start` past the cut and the tail
  // is returned in array order, which is precisely the pre-#7519 behaviour.
  const start = provenanceStart(baseline, messages)
  if (start !== null && start === cut && baseline.appends !== null) {
    return { swappedMessages: orderByProvenance(tail, baseline.appends) }
  }
  return { swappedMessages: tail }
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
  // Last (or unmatched) end — the whole record goes, its baseline with it
  // (#7492; the baseline carries `openLen` AND `prefixIds` since #7524).
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
