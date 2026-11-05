import { describe, it, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager, withRetainedPermissionOutcomes } from '../src/session-manager.js'
import { BaseSession } from '../src/base-session.js'
import { registerProvider } from '../src/providers.js'
import { resolveReplayPlan } from '../src/ws-history.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * #8259 -- a turn the daemon went down under is marked interrupted from an
 * EXPLICIT in-flight flag, never from the shape of the history.
 *
 * The flag is BaseSession's `_isBusy` edge (a turn dispatched to the provider,
 * a queued follow-up when it flushes; cleared at every turn end), persisted with
 * the session state. A first cut read "last user_input with no later result" off
 * the history and was wrong for a queued follow-up (the first turn's result
 * masked it), a persisted error ({type:'message', messageType:'error'}), an
 * evaluator-held draft (never dispatched) and a cap-evicted prompt.
 */

class FakeTurnSession extends BaseSession {
  static get capabilities() { return {} }
  constructor(opts = {}) { super({ cwd: '/tmp', ...opts }) }
  start() { this._processReady = true }
  interrupt() {}
  destroy() { super.destroy?.() }
  setModel() {}
  setPermissionMode() {}
  sendMessage(prompt, attachments, sendOptions = {}) {
    if (this._isBusy) {
      this.enqueueOutgoingMessage({ prompt, attachments, sendOptions })
      return
    }
    this._isBusy = true
  }

  /**
   * A subprocess provider (codex, gemini) emits its terminal result and keeps the turn
   * busy until the child process closes: the outcome is out, the process is alive.
   */
  emitResultKeepBusy() {
    this.emit('result', { cost: 0.01, duration: 5 })
  }

  /** Turn end: the provider emits its result, then BaseSession clears busy and flushes the queue. */
  completeTurn() {
    this.emit('result', { cost: 0.01, duration: 5 })
    this._isBusy = false
    this.dequeueNextOutgoing()
  }
}
declareUnknownCustomization(FakeTurnSession)
registerProvider('fake-turn-8259', FakeTurnSession)

const dir = mkdtempSync(join(tmpdir(), 'chroxy-8259-'))
after(() => rmSync(dir, { recursive: true, force: true }))
let n = 0

describe('interrupted turn after a restart (#8259)', () => {
  const managers = []
  afterEach(() => { for (const m of managers.splice(0)) m.destroyAll() })

  function start(stateFilePath, maxHistory) {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath, ...(maxHistory ? { maxHistory } : {}) })
    managers.push(mgr)
    return mgr
  }
  function boot(maxHistory) {
    const stateFilePath = join(dir, `state-${++n}.json`)
    const mgr = start(stateFilePath, maxHistory)
    const sid = mgr.createSession({ cwd: '/tmp', provider: 'fake-turn-8259' })
    return { mgr, sid, stateFilePath, session: mgr._sessions.get(sid).session }
  }
  /** What a restart does: persist, then a NEW manager restores from the file. */
  function restart(ctx, maxHistory) {
    ctx.mgr._flushPersist()
    const mgr = start(ctx.stateFilePath, maxHistory)
    const sid = mgr.restoreState()
    assert.ok(sid, 'restored')
    return { ...ctx, mgr, sid, session: mgr._sessions.get(sid).session }
  }
  const markers = (mgr, sid) => mgr.getHistory(sid).filter((e) => e.type === 'result' && e.turnOutcome === 'interrupted')
  const prompt = (mgr, sid, text) => mgr.recordUserInput(sid, text, `m-${text}`)

  it('marks a turn that was dispatched and had not ended', () => {
    const ctx = boot()
    prompt(ctx.mgr, ctx.sid, 'tell a story')
    ctx.session.sendMessage('tell a story')
    const after = restart(ctx)
    assert.equal(markers(after.mgr, after.sid).length, 1)
  })

  it('marks a queued follow-up that was flushed and cut off, though the first turn ended', async () => {
    const ctx = boot()
    prompt(ctx.mgr, ctx.sid, 'A')
    ctx.session.sendMessage('A')
    prompt(ctx.mgr, ctx.sid, 'B')
    ctx.session.sendMessage('B') // queued behind A
    ctx.session.completeTurn() // A's result lands; B is flushed and dispatched on the next tick
    await new Promise((resolve) => process.nextTick(resolve))
    assert.equal(ctx.session.turnActive, true, 'B is running')
    const after = restart(ctx)
    assert.equal(markers(after.mgr, after.sid).length, 1, "A's result does not mask B")
  })

  it('does not mark a turn that ended', () => {
    const ctx = boot()
    prompt(ctx.mgr, ctx.sid, 'A')
    ctx.session.sendMessage('A')
    ctx.session.completeTurn()
    const after = restart(ctx)
    assert.equal(markers(after.mgr, after.sid).length, 0)
  })

  it('does not mark a turn that already failed and settled (a persisted error is a message entry)', () => {
    const ctx = boot()
    prompt(ctx.mgr, ctx.sid, 'A')
    ctx.session.sendMessage('A')
    ctx.session.emit('error', { message: 'provider fell over' })
    ctx.session._isBusy = false
    const entries = ctx.mgr.getHistory(ctx.sid)
    assert.ok(entries.some((e) => e.type === 'message' && e.messageType === 'error'), 'the premise: errors persist in this shape')
    const after = restart(ctx)
    assert.equal(markers(after.mgr, after.sid).length, 0)
  })

  it('does not mark an evaluator-held draft (recorded, never dispatched)', () => {
    const ctx = boot()
    prompt(ctx.mgr, ctx.sid, 'a draft the evaluator held')
    const after = restart(ctx)
    assert.equal(markers(after.mgr, after.sid).length, 0)
  })

  it('marks an in-flight turn whose prompt the history cap evicted', () => {
    const ctx = boot(3)
    prompt(ctx.mgr, ctx.sid, 'the prompt')
    ctx.session.sendMessage('the prompt')
    for (let i = 0; i < 6; i++) {
      ctx.mgr._history.recordHistory(ctx.sid, 'message', { type: 'response', content: `partial ${i}`, timestamp: Date.now() })
    }
    assert.ok(!ctx.mgr.getHistory(ctx.sid).some((e) => e.messageType === 'user_input'), 'the premise: the prompt is gone')
    const after = restart(ctx, 3)
    assert.equal(markers(after.mgr, after.sid).length, 1)
  })

  it('does not mark a turn whose result was emitted while the provider process stayed busy', () => {
    const ctx = boot()
    prompt(ctx.mgr, ctx.sid, 'A')
    ctx.session.sendMessage('A')
    ctx.session.emitResultKeepBusy()
    assert.equal(ctx.session.turnActive, true, 'the premise: the child has not closed yet')
    const after = restart(ctx)
    assert.equal(markers(after.mgr, after.sid).length, 0)
  })

  it('does not mark a turn the user stopped (stopped is terminal)', () => {
    const ctx = boot()
    prompt(ctx.mgr, ctx.sid, 'A')
    ctx.session.sendMessage('A')
    ctx.session.emit('stopped')
    const after = restart(ctx)
    assert.equal(markers(after.mgr, after.sid).length, 0)
  })

  it('writes the in-flight flag to the state FILE at each edge, with no manual flush', () => {
    const ctx = boot()
    const flag = () => JSON.parse(readFileSync(ctx.stateFilePath, 'utf-8')).sessions[0].turnInFlight === true
    ctx.session.sendMessage('A')
    assert.equal(flag(), true, 'set on dispatch')
    ctx.session.completeTurn()
    assert.equal(flag(), false, 'cleared when the turn ends')
  })

  it('writes the flag when busy flips even with no outcome event (the busy edge flushes by itself)', () => {
    const ctx = boot()
    const flag = () => JSON.parse(readFileSync(ctx.stateFilePath, 'utf-8')).sessions[0].turnInFlight === true
    ctx.session.sendMessage('A')
    ctx.session._isBusy = false
    assert.equal(flag(), false)
  })

  it('does not rewrite the state file when a session being destroyed drops busy (teardown guard)', () => {
    const ctx = boot()
    ctx.session.sendMessage('A')
    const before = readFileSync(ctx.stateFilePath, 'utf-8')
    ctx.mgr._destroying = true // what destroyAll sets before it tears the sessions down
    ctx.session._isBusy = false
    assert.equal(ctx.mgr._sessions.get(ctx.sid).turnInFlight, true, 'the flag is not cleared by a teardown flip')
    assert.equal(readFileSync(ctx.stateFilePath, 'utf-8'), before)
    ctx.mgr._destroying = false
    ctx.mgr.destroyAll()
    const afterDestroy = readFileSync(ctx.stateFilePath, 'utf-8')
    ctx.session._isBusy = true
    ctx.session._isBusy = false
    assert.equal(readFileSync(ctx.stateFilePath, 'utf-8'), afterDestroy, 'nothing is written once the manager is destroyed')
  })

  it('is idempotent across two restarts', () => {
    const ctx = boot()
    prompt(ctx.mgr, ctx.sid, 'A')
    ctx.session.sendMessage('A')
    const once = restart(ctx)
    const twice = restart(once)
    assert.equal(markers(twice.mgr, twice.sid).length, 1)
  })

  /** A crash: a NEW manager restores from the file as it stands, with no final flush. */
  function crash(ctx) {
    const mgr = start(ctx.stateFilePath)
    const sid = mgr.restoreState()
    assert.ok(sid, 'restored')
    return { ...ctx, mgr, sid, session: mgr._sessions.get(sid).session }
  }
  const record = (ctx, count) => {
    for (let i = 0; i < count; i++) {
      ctx.mgr._history.recordHistory(ctx.sid, 'message', { type: 'response', content: `partial ${i}`, timestamp: Date.now() })
    }
  }
  const stateSession = (ctx) => JSON.parse(readFileSync(ctx.stateFilePath, 'utf-8')).sessions[0]

  it('numbers the marker above every seq the crashed process issued, however far persistence lagged', () => {
    const ctx = boot()
    prompt(ctx.mgr, ctx.sid, 'A')
    ctx.session.sendMessage('A')
    record(ctx, 2500) // a long streaming turn: the debounced write never ran
    const highest = ctx.mgr._history.getLastIssuedSeq(ctx.sid)
    assert.ok(stateSession(ctx).historyLastSeq < highest, 'the premise: the file lags what clients saw')
    const after = crash(ctx)
    const history = after.mgr.getHistory(after.sid)
    const marker = history.find((e) => e.turnOutcome === 'interrupted')
    assert.ok(marker._seq > highest, `marker seq ${marker._seq} is above the highest issued ${highest}`)
    // a client holding the crashed process's newest cursor still gets a delta that has it
    const plan = resolveReplayPlan(after.mgr, history, after.sid, highest, after.mgr.getLatestHistorySeq(after.sid))
    assert.equal(plan.fullHistory, false)
    assert.ok(history.slice(plan.startOffset).some((e) => e.turnOutcome === 'interrupted'), 'the marker is delivered')
  })

  it('extends and persists the reservation before the next seq is issued', () => {
    const ctx = boot()
    prompt(ctx.mgr, ctx.sid, 'A')
    const first = stateSession(ctx).seqReservedThrough
    assert.ok(first > 0, 'the first entry reserved a range')
    record(ctx, 1500)
    const second = stateSession(ctx).seqReservedThrough
    assert.ok(second > first, 'the reservation moved on')
    assert.ok(second >= ctx.mgr._history.getLastIssuedSeq(ctx.sid) - 1000, 'it never trails what was issued by more than the step')
  })

  it('adopts a persisted reservation far above the fallback gap (restoreSeqReservation is load-bearing)', () => {
    const ctx = boot()
    prompt(ctx.mgr, ctx.sid, 'A')
    ctx.session.sendMessage('A')
    ctx.mgr._flushPersist()
    const state = JSON.parse(readFileSync(ctx.stateFilePath, 'utf-8'))
    state.sessions[0].seqReservedThrough = 500000
    state.sessions[0].turnInFlight = true
    writeFileSync(ctx.stateFilePath, JSON.stringify(state))
    const after = crash(ctx)
    const history = after.mgr.getHistory(after.sid)
    const marker = history.find((e) => e.turnOutcome === 'interrupted')
    assert.ok(marker, 'marked')
    // the best-effort gap would land near 100000; only the adopted reservation reaches past 500000
    assert.ok(marker._seq > 500000, `marker seq ${marker._seq} is above the reservation`)
    const plan = resolveReplayPlan(after.mgr, history, after.sid, 499999, after.mgr.getLatestHistorySeq(after.sid))
    assert.equal(plan.fullHistory, false, 'the cursor is honoured')
    assert.ok(history.slice(plan.startOffset).some((e) => e.turnOutcome === 'interrupted'), 'cursor 499999 receives the marker')
  })

  it('restores a state file with no reservation (falls back to the gap)', () => {
    const ctx = boot()
    prompt(ctx.mgr, ctx.sid, 'A')
    ctx.session.sendMessage('A')
    ctx.mgr._flushPersist()
    const state = JSON.parse(readFileSync(ctx.stateFilePath, 'utf-8'))
    for (const sess of state.sessions) delete sess.seqReservedThrough
    writeFileSync(ctx.stateFilePath, JSON.stringify(state))
    const after = crash(ctx)
    const marker = after.mgr.getHistory(after.sid).find((e) => e.turnOutcome === 'interrupted')
    assert.ok(marker, 'still marked')
    assert.ok(marker._seq > state.sessions[0].historyLastSeq, 'numbered past the persisted seq')
  })
})

describe('Sync Full History keeps the interrupted marker (#8259)', () => {
  it('folds the marker into a provider-transcript rebuild, once, in timestamp order', () => {
    const transcript = [
      { type: 'message', messageType: 'user_input', content: 'q', timestamp: 100 },
      { type: 'message', messageType: 'response', content: 'partial', timestamp: 200 },
    ]
    const ring = [
      { type: 'result', turnOutcome: 'interrupted', timestamp: 250, _seq: 90 },
      { type: 'result', turnOutcome: 'interrupted', timestamp: 250, _seq: 91 },
    ]
    const merged = withRetainedPermissionOutcomes(transcript, ring, false)
    assert.deepEqual(merged.map((e) => e.turnOutcome ?? e.messageType), ['user_input', 'response', 'interrupted'])
    assert.equal(merged[2]._seq, undefined, 'no ring seq leaks onto a JSONL slice')
  })

  it('does not fold in an ordinary completed result', () => {
    const transcript = [{ type: 'message', messageType: 'user_input', content: 'q', timestamp: 100 }]
    assert.equal(withRetainedPermissionOutcomes(transcript, [{ type: 'result', timestamp: 150 }], false), transcript)
  })
})
