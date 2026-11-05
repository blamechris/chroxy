import { describe, it, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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

  it('is idempotent across two restarts', () => {
    const ctx = boot()
    prompt(ctx.mgr, ctx.sid, 'A')
    ctx.session.sendMessage('A')
    const once = restart(ctx)
    const twice = restart(once)
    assert.equal(markers(twice.mgr, twice.sid).length, 1)
  })

  it('delivers the marker to a client whose cursor outran the persisted seq (crash window)', () => {
    const ctx = boot()
    prompt(ctx.mgr, ctx.sid, 'A')
    ctx.session.sendMessage('A')
    const persistedLast = ctx.mgr._history.getLastIssuedSeq(ctx.sid)
    // entries recorded after the last write: a client applied them, the file never saw them
    const clientCursor = persistedLast + 4
    const after = restart(ctx)
    const history = after.mgr.getHistory(after.sid)
    const plan = resolveReplayPlan(after.mgr, history, after.sid, clientCursor, after.mgr.getLatestHistorySeq(after.sid))
    assert.equal(plan.fullHistory, false)
    assert.ok(history.slice(plan.startOffset).some((e) => e.turnOutcome === 'interrupted'), 'the client receives the marker')
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
