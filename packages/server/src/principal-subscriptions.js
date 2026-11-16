/**
 * Per-client subscriptions to the principal event journal: replay, live fence, held
 * live buffer (docs/security/agent-principals.md section 7.2; #9118).
 *
 * DELIVERY PATH. A subscription is delivered by a DEDICATED DIRECT SEND per subscription
 * (this module calls the server's `send` for the one socket), not through the broadcaster:
 *   - fence, hold and release order are inherently per-subscription state, which a
 *     broadcast fan-out cannot carry;
 *   - the broadcast path would need the principal on the ClientManager index
 *     (`subscribe`, `setActiveSession`, `autoSubscribeOtherClients`), which would make it a
 *     recipient of every ordinary session broadcast's recipient set. Contract section 3.1
 *     item 7 says a principal receives NO ordinary session broadcast, so S2 pinned that
 *     index closed and `PRINCIPAL_BROADCAST_ALLOWED` stays EMPTY here. Nothing about the
 *     index changes in S3;
 *   - every frame still goes through `_send` -> `frameForPrincipal`, which re-checks the
 *     grant for the frame's session on every send and rebuilds the frame from the
 *     whitelist of `PRINCIPAL_OUTGOING_ALLOWED`, so a grant revoked mid-subscription
 *     withholds the next frame, and deny-by-default holds for these types as for any other.
 *
 * ORDER, per session:  principal_subscribed (all sessions, once) -> replayed events
 * (`replay: true`) from the cursor up to `headSeq` as it was at subscribe time ->
 * `principal_live_fence { journalSeq: headSeq }` -> the live events that arrived while replaying,
 * held and released in seq order -> live events as they happen.
 *
 * Replay runs in batches with a yield between them, so live traffic really does arrive
 * mid-replay. The held buffer is capped (500 events or 1 MiB); on overflow the
 * subscription ENDS with a `principal_gap { ended: true }` and the client subscribes again
 * from its last cursor. A slow socket (past the backpressure threshold) ends it the same
 * way instead of buffering without bound. An event evicted from the journal between
 * `headSeq` and the fence is reported as a gap by the same read that finds it missing.
 */
import { createLogger } from './logger.js'

const log = createLogger('principal-subscriptions')

export const REPLAY_BATCH = 50
export const HELD_MAX_EVENTS = 500
export const HELD_MAX_BYTES = 1024 * 1024
export const DRAIN_WAIT_MS = 20
export const DRAIN_MAX_WAITS = 250

const defaultYield = () => new Promise((resolve) => setImmediate(resolve))
const defaultSleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.() })

export class PrincipalSubscriptions {
  /**
   * @param {object} opts
   * @param {import('./principal-journal.js').PrincipalJournal} opts.journal
   * @param {(ws: object, frame: object) => unknown} opts.send  the server's `_send`
   * @param {(client: object, sessionId: string) => boolean} [opts.maySee]  the grant, re-checked per batch
   * @param {number} [opts.backpressureBytes]
   * @param {number} [opts.replayBatch]
   * @param {number} [opts.heldMaxEvents]
   * @param {number} [opts.heldMaxBytes]
   * @param {() => Promise<void>} [opts.yieldFn]  awaited between replay batches
   * @param {(ms: number) => Promise<void>} [opts.sleepFn]
   */
  constructor({
    journal, send, maySee = () => true, backpressureBytes = 1024 * 1024, replayBatch = REPLAY_BATCH,
    heldMaxEvents = HELD_MAX_EVENTS, heldMaxBytes = HELD_MAX_BYTES, yieldFn = defaultYield, sleepFn = defaultSleep,
  }) {
    this._journal = journal
    this._send = send
    this._maySee = maySee
    this._backpressureBytes = backpressureBytes
    this._replayBatch = replayBatch
    this._heldMaxEvents = heldMaxEvents
    this._heldMaxBytes = heldMaxBytes
    /** The await between replay batches. A test seam: a hook here runs mid-replay. */
    this.yieldFn = yieldFn
    this._sleep = sleepFn
    /** @type {Map<object, Map<string, object>>} client -> sessionId -> subscription */
    this._byClient = new Map()
  }

  /** How many live subscriptions exist (any state but ended). */
  get size() {
    let n = 0
    for (const subs of this._byClient.values()) n += subs.size
    return n
  }

  /**
   * Subscribe `client` (on `ws`) to each session. Every id has ALREADY been checked
   * against the grant by the caller (all-or-nothing); a re-subscribe replaces the earlier
   * subscription for that session silently.
   * @param {{ ws: object, client: object, requestId: string, sessions: { sessionId: string, cursor?: object|null }[] }} req
   */
  subscribe({ ws, client, requestId, sessions }) {
    const subs = []
    const infos = []
    for (const { sessionId, cursor } of sessions) {
      this._drop(client, sessionId, false)
      const res = this._journal.resolveCursor(sessionId, cursor ?? null)
      const sub = {
        ws, client, requestId, sessionId, journalId: res.journalId, state: 'replay',
        after: res.afterSeq, snapshotHead: res.headSeq, held: [], heldBytes: 0, unlisten: null,
      }
      sub.unlisten = this._journal.onAppend(sessionId, (evt) => this._onJournal(sub, evt))
      this._register(sub)
      subs.push(sub)
      infos.push({
        sessionId, journalId: res.journalId, headSeq: res.headSeq,
        ...(res.gap ? { gap: res.gap } : {}),
      })
    }
    this._send(ws, { type: 'principal_subscribed', requestId, sessions: infos })
    for (const sub of subs) {
      this._pump(sub).catch((err) => {
        log.warn(`principal replay failed: ${err?.message || err}`)
        this._end(sub, 'backpressure')
      })
    }
  }

  /** Stop a client's subscriptions (all of them, or the listed sessions). No frame is sent. */
  unsubscribe(client, sessionIds = null) {
    const subs = this._byClient.get(client)
    if (!subs) return
    for (const id of [...subs.keys()]) {
      if (sessionIds === null || sessionIds.includes(id)) this._drop(client, id, false)
    }
  }

  /** The client is gone (disconnect, revoke, expiry). */
  removeClient(client) {
    this.unsubscribe(client, null)
  }

  _register(sub) {
    let subs = this._byClient.get(sub.client)
    if (!subs) {
      subs = new Map()
      this._byClient.set(sub.client, subs)
    }
    subs.set(sub.sessionId, sub)
  }

  /** Forget one subscription. `sendEnd` is false for a silent stop. */
  _drop(client, sessionId, _sendEnd) {
    const subs = this._byClient.get(client)
    const sub = subs?.get(sessionId)
    if (!sub) return
    sub.state = 'ended'
    sub.held = []
    sub.heldBytes = 0
    try { sub.unlisten?.() } catch { /* ignore */ }
    subs.delete(sessionId)
    if (subs.size === 0) this._byClient.delete(client)
  }

  /** End a subscription and tell the client why (it must subscribe again). */
  _end(sub, reason, range = {}) {
    if (sub.state === 'ended') return
    const { ws, client, sessionId } = sub
    const frame = {
      type: 'principal_gap', requestId: sub.requestId, sessionId, journalId: sub.journalId, reason, ended: true,
      ...(range.fromSeq !== undefined ? { fromSeq: range.fromSeq } : {}),
      ...(range.toSeq !== undefined ? { toSeq: range.toSeq } : {}),
    }
    this._drop(client, sessionId, false)
    try { this._send(ws, frame) } catch { /* the socket is going away */ }
  }

  _sendGap(sub, gap) {
    this._send(sub.ws, {
      type: 'principal_gap', requestId: sub.requestId, sessionId: sub.sessionId, journalId: sub.journalId,
      reason: gap.reason,
      ...(gap.fromSeq !== undefined ? { fromSeq: gap.fromSeq } : {}),
      ...(gap.toSeq !== undefined ? { toSeq: gap.toSeq } : {}),
      ended: false,
    })
  }

  _backedUp(sub) {
    return (sub.ws?.bufferedAmount ?? 0) > this._backpressureBytes
  }

  /** A journal event for `sub`: held while replaying, sent when live. */
  _onJournal(sub, evt) {
    if (sub.state === 'ended') return
    if (evt.kind === 'reset') {
      this._end(sub, evt.reason)
      return
    }
    if (evt.kind === 'removed') {
      this._end(sub, 'removed')
      return
    }
    // A new journal id is a new journal: this subscription's id and cursor mean nothing to it.
    if (evt.journalId !== sub.journalId) {
      this._end(sub, 'restart_loss')
      return
    }
    if (sub.state === 'replay') {
      sub.held.push(evt.entry)
      sub.heldBytes += Buffer.byteLength(JSON.stringify(evt.entry), 'utf8')
      if (sub.held.length > this._heldMaxEvents || sub.heldBytes > this._heldMaxBytes) {
        this._end(sub, 'held_overflow', { fromSeq: sub.after + 1 })
      }
      return
    }
    this._sendLive(sub, evt.entry)
  }

  /** Put one journal entry on the wire (an object literal, so the frame roster scanner sees the type). */
  _emitEvent(sub, entry, replay) {
    this._send(sub.ws, {
      type: 'principal_event',
      requestId: sub.requestId,
      sessionId: sub.sessionId,
      journalId: sub.journalId,
      // `journalSeq`, not `seq`: the transport stamps its own `seq` on every frame
      journalSeq: entry.seq,
      ts: entry.ts,
      eventType: entry.type,
      data: entry.data,
      ...(entry.truncated === true ? { truncated: true } : {}),
      ...(replay ? { replay: true } : {}),
    })
  }

  _sendLive(sub, entry) {
    if (sub.state === 'ended') return
    if (!this._maySee(sub.client, sub.sessionId)) {
      this._end(sub, 'scope')
      return
    }
    if (this._backedUp(sub)) {
      this._end(sub, 'backpressure')
      return
    }
    this._emitEvent(sub, entry, false)
  }

  async _pump(sub) {
    while (sub.state === 'replay') {
      if (!this._maySee(sub.client, sub.sessionId)) {
        this._end(sub, 'scope')
        return
      }
      const read = this._journal.readFrom(sub.sessionId, sub.after, this._replayBatch, sub.snapshotHead)
      if (read.journalId !== sub.journalId) {
        this._end(sub, 'restart_loss') // never leave a replay hung on a journal that is gone
        return
      }
      if (read.gap) this._sendGap(sub, read.gap)
      for (const entry of read.events) this._emitEvent(sub, entry, true)
      const progressed = read.lastSeq > sub.after
      sub.after = read.lastSeq
      if (sub.after >= sub.snapshotHead) break
      if (!progressed) {
        // Nothing to serve and no reason given: report what cannot be served, then fence.
        this._sendGap(sub, { reason: 'evicted', fromSeq: sub.after + 1, toSeq: sub.snapshotHead })
        break
      }
      await this.yieldFn()
      if (sub.state !== 'replay') return
      for (let waits = 0; this._backedUp(sub); waits++) {
        if (waits >= DRAIN_MAX_WAITS) {
          this._end(sub, 'backpressure')
          return
        }
        await this._sleep(DRAIN_WAIT_MS)
        if (sub.state !== 'replay') return
      }
    }
    if (sub.state !== 'replay') return
    this._send(sub.ws, {
      type: 'principal_live_fence', requestId: sub.requestId, sessionId: sub.sessionId,
      journalId: sub.journalId, journalSeq: sub.snapshotHead,
    })
    sub.state = 'live'
    const held = sub.held
    sub.held = []
    sub.heldBytes = 0
    for (const entry of held) {
      if (sub.state !== 'live') return
      // Everything held arrived after `snapshotHead`; nothing at or below it is repeated.
      if (entry.seq > sub.snapshotHead) this._sendLive(sub, entry)
    }
  }
}
