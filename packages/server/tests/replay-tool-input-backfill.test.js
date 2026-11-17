import { describe, it, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { BaseSession } from '../src/base-session.js'
import { registerProvider } from '../src/providers.js'
import { replayHistory, CAPABILITY_HISTORY_TOOL_INPUT_BACKFILL } from '../src/ws-history.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * #8415 -- the input the server learns for a tool_start AFTER recording it fills the
 * recorded entry in place (no new seq), so a delta replay never carried it to a client
 * that already held the card. A capable client at a cursor that covers the entry and
 * not the fill is now sent a reconcile-only `tool_input_backfill` frame.
 *
 * Every SessionManager here uses a temp stateFilePath (#4633).
 */

class FakeSession extends BaseSession {
  static get capabilities() { return {} }
  constructor(opts = {}) { super({ cwd: '/tmp', ...opts }) }
  start() { this._processReady = true }
  interrupt() {}
  destroy() { super.destroy?.() }
  setModel() {}
  setPermissionMode() {}
  sendMessage() {}
}
declareUnknownCustomization(FakeSession)
registerProvider('fake-backfill-8415', FakeSession)

const dir = mkdtempSync(join(tmpdir(), 'replay-backfill-'))
after(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const managers = []
afterEach(() => { for (const m of managers.splice(0)) m.destroyAll() })

function boot(stateFilePath = join(dir, `state-${++n}.json`)) {
  const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath })
  managers.push(mgr)
  const sid = mgr.createSession({ cwd: '/tmp', provider: 'fake-backfill-8415' })
  return { mgr, sid, stateFilePath }
}

const CAP = new Set([CAPABILITY_HISTORY_TOOL_INPUT_BACKFILL])
async function replay(mgr, sid, clientRecord = {}, opts) {
  const sent = []
  const ws = { readyState: 1, send() {}, close() {} }
  const ctx = {
    sessionManager: mgr,
    clients: new Map([[ws, { id: 'c1', activeSessionId: sid, clientCapabilities: CAP, ...clientRecord }]]),
    send: (_ws, payload) => sent.push(payload),
    permissions: null,
  }
  replayHistory(ctx, ws, sid, opts)
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
  return sent
}
const backfills = (sent) => sent.filter((m) => m.type === 'tool_input_backfill')
const INPUT = { command: 'ls -la' }

/** user_input (1), tool_start with a null input (2). Returns the tool_start seq. */
function recordRunningTool(mgr, sid, id = 'toolu_1') {
  mgr._recordHistory(sid, 'message', { type: 'user_input', content: 'go', timestamp: 1 })
  mgr._recordHistory(sid, 'tool_start', { messageId: id, toolUseId: id, tool: 'Bash', input: null })
  return mgr.getLatestHistorySeq(sid)
}

describe('tool_input_backfill on a delta replay (#8415)', () => {
  it('A1: a running tool (#8371) -- a capable client at the tool_start cursor gets exactly one frame', async () => {
    const { mgr, sid } = boot()
    const seq = recordRunningTool(mgr, sid)
    assert.equal(mgr._history.backfillToolInput(sid, 'toolu_1', INPUT), true)
    assert.equal(mgr.getLatestHistorySeq(sid), seq, 'no new entry')
    const sent = await replay(mgr, sid, { historyCursors: { [sid]: seq } })
    assert.equal(sent[0].fullHistory, false)
    const frames = backfills(sent)
    assert.deepEqual(frames, [{ type: 'tool_input_backfill', sessionId: sid, messageId: 'toolu_1', toolUseId: 'toolu_1', input: INPUT }])
    assert.equal(sent[0].type, 'history_replay_start')
    assert.equal(sent.indexOf(frames[0]) > 0 && sent.indexOf(frames[0]) < sent.length - 1, true, 'inside the replay')
    assert.equal(sent.at(-1).type, 'history_replay_end')
  })

  it('A1: a completed tool (#7346) -- the frame arrives alongside the replayed tool_result', async () => {
    const { mgr, sid } = boot()
    const seq = recordRunningTool(mgr, sid)
    mgr._recordHistory(sid, 'tool_result', { toolUseId: 'toolu_1', result: 'ok', input: INPUT })
    const sent = await replay(mgr, sid, { historyCursors: { [sid]: seq } })
    assert.equal(sent[0].fullHistory, false)
    assert.deepEqual(backfills(sent).map((f) => f.input), [INPUT])
    assert.ok(sent.some((m) => m.type === 'tool_result'), 'the result is replayed')
  })

  it('A7: the frame has no historySeq or timestamp, and latestSeq is the same as without it', async () => {
    const withFill = boot()
    const seq = recordRunningTool(withFill.mgr, withFill.sid)
    withFill.mgr._history.backfillToolInput(withFill.sid, 'toolu_1', INPUT)
    const without = boot()
    recordRunningTool(without.mgr, without.sid)
    const a = await replay(withFill.mgr, withFill.sid, { historyCursors: { [withFill.sid]: seq } })
    const b = await replay(without.mgr, without.sid, { historyCursors: { [without.sid]: seq } })
    const [frame] = backfills(a)
    assert.ok(frame)
    assert.equal('historySeq' in frame, false)
    assert.equal('timestamp' in frame, false)
    assert.equal(a.at(-1).latestSeq, b.at(-1).latestSeq)
    assert.equal(a[0].latestSeq, b[0].latestSeq)
  })

  it('A8: a client without the capability gets frames identical to a replay with no backfill', async () => {
    const withFill = boot()
    const seq = recordRunningTool(withFill.mgr, withFill.sid)
    withFill.mgr._history.backfillToolInput(withFill.sid, 'toolu_1', INPUT)
    const without = boot()
    recordRunningTool(without.mgr, without.sid)
    for (const caps of [new Set(), undefined]) {
      const a = await replay(withFill.mgr, withFill.sid, { clientCapabilities: caps, historyCursors: { [withFill.sid]: seq } })
      const b = await replay(without.mgr, without.sid, { clientCapabilities: caps, historyCursors: { [without.sid]: seq } })
      assert.equal(backfills(a).length, 0)
      const norm = (frames, sid) => JSON.stringify(frames).split(sid).join('SID')
      assert.equal(norm(a, withFill.sid), norm(b, without.sid))
    }
  })

  it('A9: a full replay (no cursor, cursor ahead, trim gap, forceFull) sends no frame', async () => {
    const { mgr, sid } = boot()
    const seq = recordRunningTool(mgr, sid)
    mgr._history.backfillToolInput(sid, 'toolu_1', INPUT)
    const cases = [
      [{}, undefined],
      [{ historyCursors: { [sid]: seq + 50 } }, undefined],
      [{ historyCursors: { [sid]: seq } }, { forceFull: true }],
    ]
    for (const [rec, opts] of cases) {
      const sent = await replay(mgr, sid, rec, opts)
      assert.equal(sent[0].fullHistory, true)
      assert.equal(backfills(sent).length, 0)
    }
    // trim gap: the oldest retained entry is past the cursor + 1
    const small = new SessionManager({ skipPreflight: true, maxSessions: 5, maxHistory: 3, defaultCwd: '/tmp', stateFilePath: join(dir, `state-${++n}.json`) })
    managers.push(small)
    const s2 = small.createSession({ cwd: '/tmp', provider: 'fake-backfill-8415' })
    small._recordHistory(s2, 'message', { type: 'user_input', content: 'go', timestamp: 1 })
    small._recordHistory(s2, 'tool_start', { messageId: 't', toolUseId: 't', tool: 'Bash', input: null })
    small._history.backfillToolInput(s2, 't', INPUT)
    for (let i = 0; i < 5; i++) small._recordHistory(s2, 'message', { type: 'user_input', content: `m${i}`, timestamp: 2 })
    const sent = await replay(small, s2, { historyCursors: { [s2]: 2 } })
    assert.equal(sent[0].fullHistory, true, 'trim gap forces a full replay')
    assert.equal(backfills(sent).length, 0)
  })

  it('A10: persisted state is byte-identical with and without a backfill marker', () => {
    const filled = boot()
    recordRunningTool(filled.mgr, filled.sid)
    filled.mgr._history.backfillToolInput(filled.sid, 'toolu_1', INPUT)
    const direct = boot()
    direct.mgr._recordHistory(direct.sid, 'message', { type: 'user_input', content: 'go', timestamp: 1 })
    direct.mgr._recordHistory(direct.sid, 'tool_start', { messageId: 'toolu_1', toolUseId: 'toolu_1', tool: 'Bash', input: INPUT })
    const persisted = (c) => {
      c.mgr._flushPersist()
      const state = JSON.parse(readFileSync(c.stateFilePath, 'utf8'))
      const [s] = state.sessions
      return JSON.stringify({ history: s.history.map(({ timestamp, ...rest }) => rest), last: s.historyLastSeq })
    }
    assert.equal(persisted(filled), persisted(direct))
  })

  it('A10: backfillToolInput consumes no seq, and a restore numbers exactly as it does without a backfill (#8336)', () => {
    const restored = (fill) => {
      const ctx = boot()
      const seq = recordRunningTool(ctx.mgr, ctx.sid)
      const before = ctx.mgr._history.getLastIssuedSeq(ctx.sid)
      if (fill) ctx.mgr._history.backfillToolInput(ctx.sid, 'toolu_1', INPUT)
      assert.equal(ctx.mgr._history.getLastIssuedSeq(ctx.sid), before, 'no seq consumed')
      assert.equal(before, seq)
      ctx.mgr._flushPersist()
      const mgr2 = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: ctx.stateFilePath })
      managers.push(mgr2)
      const sid2 = mgr2.restoreState()
      const last = mgr2._history.getLastIssuedSeq(sid2)
      assert.ok(last >= before, 'a restored client cursor is never ahead of the counter')
      mgr2._recordHistory(sid2, 'message', { type: 'user_input', content: 'next', timestamp: 3 })
      assert.equal(mgr2.getLatestHistorySeq(sid2), last + 1, 'contiguous')
      return last
    }
    assert.equal(restored(true), restored(false))
  })

  it('A11: no frame when the entry already had a plain-object input (claude-tui shape)', async () => {
    const { mgr, sid } = boot()
    mgr._recordHistory(sid, 'message', { type: 'user_input', content: 'go', timestamp: 1 })
    mgr._recordHistory(sid, 'tool_start', { messageId: 't1', toolUseId: 't1', tool: 'Bash', input: { a: 1 } })
    const seq = mgr.getLatestHistorySeq(sid)
    mgr._history.backfillToolInput(sid, 't1', { a: 2 })
    assert.equal(backfills(await replay(mgr, sid, { historyCursors: { [sid]: seq } })).length, 0)
  })

  it('A11: no frame for an entry past the cursor (it is in the slice, with its input), nor when the cursor is past the fill', async () => {
    const { mgr, sid } = boot()
    mgr._recordHistory(sid, 'message', { type: 'user_input', content: 'go', timestamp: 1 })
    mgr._recordHistory(sid, 'tool_start', { messageId: 't1', toolUseId: 't1', tool: 'Bash', input: null })
    mgr._history.backfillToolInput(sid, 't1', INPUT)
    const past = await replay(mgr, sid, { historyCursors: { [sid]: 1 } })
    assert.equal(past[0].fullHistory, false)
    assert.equal(backfills(past).length, 0)
    assert.equal(past.find((m) => m.type === 'tool_start').input.command, INPUT.command)
    // a later entry moves the fill's seq behind a cursor that has seen it
    mgr._recordHistory(sid, 'message', { type: 'user_input', content: 'later', timestamp: 2 })
    const after = await replay(mgr, sid, { historyCursors: { [sid]: mgr.getLatestHistorySeq(sid) } })
    assert.equal(after[0].fullHistory, false)
    assert.equal(backfills(after).length, 0, 'cursor > fillSeq')
  })

  it('A6: repeated reconnects at the same cursor send the same single frame', async () => {
    const { mgr, sid } = boot()
    const seq = recordRunningTool(mgr, sid)
    mgr._history.backfillToolInput(sid, 'toolu_1', INPUT)
    const first = backfills(await replay(mgr, sid, { historyCursors: { [sid]: seq } }))
    const second = backfills(await replay(mgr, sid, { historyCursors: { [sid]: seq } }))
    assert.equal(first.length, 1)
    assert.deepEqual(second, first)
  })

  it('A14: a replay of session X never carries a frame for session Y', async () => {
    const x = boot()
    const seqX = recordRunningTool(x.mgr, x.sid)
    const sidY = x.mgr.createSession({ cwd: '/tmp', provider: 'fake-backfill-8415' })
    recordRunningTool(x.mgr, sidY, 'toolu_y')
    x.mgr._history.backfillToolInput(sidY, 'toolu_y', { command: 'only-y' })
    const sent = await replay(x.mgr, x.sid, { historyCursors: { [x.sid]: seqX } })
    assert.equal(backfills(sent).length, 0)
    const y = await replay(x.mgr, sidY, { activeSessionId: sidY, historyCursors: { [sidY]: seqX } })
    assert.deepEqual(backfills(y).map((f) => [f.sessionId, f.messageId]), [[sidY, 'toolu_y']])
  })

  it('a re-fill updates the stored value and a non-object fill records nothing', () => {
    const h = new SessionMessageHistory()
    h.recordHistory('s', 'tool_start', { messageId: 'a', toolUseId: 'a', tool: 'Bash', input: null })
    h.backfillToolInput('s', 'a', 'not-an-object')
    assert.deepEqual(h.getToolInputBackfills('s', 1), [])
    h.backfillToolInput('s', 'a', INPUT)
    assert.equal(h.getToolInputBackfills('s', 1).length, 1)
  })
})
