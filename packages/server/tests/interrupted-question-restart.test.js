import { describe, it, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionManager } from '../src/session-manager.js'
import { SdkSession } from '../src/sdk-session.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { PermissionManager } from '../src/permission-manager.js'
import { buildToolStartData } from '../src/claude-stream-parser.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { resolveReplayPlan, sendHistoryEntry } from '../src/ws-history.js'

/**
 * #8336 — a question cut off by a restart has to be MARKED for the provider
 * that actually produced it.
 *
 * The first cut of this fix matched a `user_question` to its swept tool on the
 * question's own `toolUseId`. That holds for the CLI and TUI, but the SDK and
 * BYOK route the answer on a chroxy-minted `ask-<nonce>-<n>-<ms>` id
 * (PermissionManager) while their `tool_start` keeps the PROVIDER's id, so the
 * two never matched and the SDK case in the issue stayed "(resolved)". The
 * earlier tests wrote the same id on both entries by hand, which is why they
 * could not see it. These feed the real PermissionManager, the real SDK
 * `canUseTool` / Auto hook wiring and the real `tool_start` builder.
 */

const ASK_INPUT = {
  questions: [{ question: 'Which shape?', options: [{ label: 'Round' }, { label: 'Square' }] }],
}

/** Record session events exactly as session-manager.js does for its proxied events. */
function recorder(session, history, sid) {
  session.on('tool_start', (d) => history.recordHistory(sid, 'tool_start', d))
  session.on('user_question', (d) => history.recordHistory(sid, 'user_question', d))
}

/** Persist, restore with the sweep (session-manager.js), and replay past `cursor`. */
function restartAndReplay(history, sid, cursor) {
  const persisted = JSON.parse(JSON.stringify(history.getHistory(sid).map((e) => history.truncateEntry(e))))
  const after = new SessionMessageHistory({ maxHistory: 50 })
  after.setHistory(sid, SessionMessageHistory.sweepUnresolvedToolStarts(persisted))
  const restored = after.getHistory(sid)
  const plan = resolveReplayPlan(
    { getLatestHistorySeq: (id) => after.getLatestSeq(id), getOldestHistorySeq: (id) => after.getOldestSeq(id) },
    restored, sid, cursor, after.getLatestSeq(sid),
  )
  const frames = []
  for (const entry of restored.slice(plan.startOffset)) {
    sendHistoryEntry((_ws, payload) => frames.push(payload), null, sid, entry)
  }
  return { plan, frames }
}

function assertCutOffQuestionIsMarked(frames, providerId) {
  const questions = frames.filter((f) => f.type === 'user_question')
  assert.ok(questions.length >= 1, 'the question is replayed')
  assert.ok(questions.every((q) => q.interrupted === true), 'every replayed copy says it was cut off')
  assert.ok(questions.every((q) => q.toolUseId !== providerId), 'the question id is chroxy\'s, not the provider\'s (the premise)')
  assert.ok(questions.every((q) => /^ask-/.test(q.toolUseId)), 'ask-<nonce> id')
}

describe('interrupted question after a restart, real provider wiring (#8336)', () => {
  // A failed assertion must not leave a pending question's 5-minute timer
  // holding the runner open (that reads as a hang, not a red test).
  const sessions = []
  const managers = []
  afterEach(() => {
    for (const s of sessions.splice(0)) { s._permissions.clearAll(); s.destroy() }
    for (const m of managers.splice(0)) m.clearAll()
  })

  it('PermissionManager records the provider id beside its own ask- id', () => {
    const pm = new PermissionManager({})
    managers.push(pm)
    const events = []
    pm.on('user_question', (d) => events.push(d))
    const p = pm.handlePermission('AskUserQuestion', ASK_INPUT, null, 'approve', undefined, 'toolu_ask1')
    assert.equal(events.length, 1)
    assert.match(events[0].toolUseId, /^ask-/)
    assert.equal(events[0].sourceToolUseId, 'toolu_ask1')
    pm.respondToQuestion('Round')
    return p
  })

  it('SDK, canUseTool: the cut-off question is marked and survives a cursor past it', async () => {
    const s = new SdkSession({ cwd: '/tmp', permissionMode: 'approve' })
    sessions.push(s)
    s._processReady = true
    const captured = []
    let release
    const held = new Promise((r) => { release = r })
    s._callQuery = (args) => {
      captured.push(args)
      return (async function* () { await held; yield { type: 'result', session_id: 'x', total_cost_usd: 0, duration_ms: 0, usage: {} } })()
    }
    const turn = s.sendMessage('ask me')
    await new Promise((r) => setImmediate(r))
    assert.equal(typeof captured[0].options.canUseTool, 'function')

    const history = new SessionMessageHistory({ maxHistory: 50 })
    const sid = 'sdk1'
    recorder(s, history, sid)
    // The SDK announces the tool through the shared builder, then asks permission with the SAME id.
    s.emit('tool_start', buildToolStartData('m1', { id: 'toolu_ask1', name: 'AskUserQuestion' }))
    const pending = captured[0].options.canUseTool('AskUserQuestion', ASK_INPUT, {
      signal: new AbortController().signal, suggestions: [], toolUseID: 'toolu_ask1',
    })
    // An unrelated tool finishes after the question: the question now sits BEHIND the cursor.
    s.emit('tool_start', buildToolStartData('m1', { id: 'toolu_bash', name: 'Bash' }))
    history.recordHistory(sid, 'tool_result', { toolUseId: 'toolu_bash', result: 'ok' })
    const cursor = history.getLatestSeq(sid)

    const { plan, frames } = restartAndReplay(history, sid, cursor)
    assert.equal(plan.fullHistory, false, 'delta replay: the cursor is honoured')
    assertCutOffQuestionIsMarked(frames, 'toolu_ask1')

    s.respondToQuestion('Round')
    await pending
    release()
    await turn
  })

  it('SDK, Auto-mode PreToolUse hook: same', async () => {
    const s = new SdkSession({ cwd: '/tmp', permissionMode: 'auto' })
    sessions.push(s)
    s._processReady = true
    const captured = []
    let release
    const held = new Promise((r) => { release = r })
    s._callQuery = (args) => {
      captured.push(args)
      return (async function* () { await held; yield { type: 'result', session_id: 'x', total_cost_usd: 0, duration_ms: 0, usage: {} } })()
    }
    const turn = s.sendMessage('ask me')
    await new Promise((r) => setImmediate(r))
    const hook = captured[0].options.hooks.PreToolUse[0].hooks[0]

    const history = new SessionMessageHistory({ maxHistory: 50 })
    const sid = 'sdk-auto'
    recorder(s, history, sid)
    s.emit('tool_start', buildToolStartData('m1', { id: 'toolu_auto1', name: 'AskUserQuestion' }))
    const pending = hook(
      { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: ASK_INPUT },
      'toolu_auto1', { signal: new AbortController().signal },
    )
    const { frames } = restartAndReplay(history, sid, 0)
    assertCutOffQuestionIsMarked(frames, 'toolu_auto1')

    s.respondToQuestion('Round')
    await pending
    release()
    await turn
  })

  it('BYOK: the gate passes the block id through', async () => {
    const s = new ClaudeByokSession({ cwd: '/tmp' })
    sessions.push(s)
    const history = new SessionMessageHistory({ maxHistory: 50 })
    const sid = 'byok1'
    recorder(s, history, sid)
    // BYOK announces the tool under the content block's id (byok-session.js `toolId`).
    s.emit('tool_start', { messageId: 'toolu_byok1', toolUseId: 'toolu_byok1', tool: 'AskUserQuestion', input: null })
    const pending = s._gateToolBlock({
      block: { id: 'toolu_byok1', name: 'AskUserQuestion', input: ASK_INPUT }, messageId: 'm1',
    })
    const { frames } = restartAndReplay(history, sid, 0)
    assertCutOffQuestionIsMarked(frames, 'toolu_byok1')

    s.respondToQuestion('Round')
    await pending
  })

  it('an ANSWERED SDK question is left alone', async () => {
    const pm = new PermissionManager({})
    managers.push(pm)
    const history = new SessionMessageHistory({ maxHistory: 50 })
    const sid = 'sdk-answered'
    pm.on('user_question', (d) => history.recordHistory(sid, 'user_question', d))
    history.recordHistory(sid, 'tool_start', buildToolStartData('m1', { id: 'toolu_done', name: 'AskUserQuestion' }))
    const p = pm.handlePermission('AskUserQuestion', ASK_INPUT, null, 'approve', undefined, 'toolu_done')
    pm.respondToQuestion('Round')
    await p
    history.recordHistory(sid, 'tool_result', { toolUseId: 'toolu_done', result: 'Round' })
    const { frames } = restartAndReplay(history, sid, 0)
    assert.equal(frames.filter((f) => f.type === 'user_question' && f.interrupted).length, 0)
    assert.equal(frames.filter((f) => f.type === 'user_question').length, 1)
  })
})

/**
 * Round 3 on #8360 -- the restart must keep the history's numbering, not restart
 * it at 1, and must not grow the buffer. These go through the REAL SessionManager
 * (serializeState -> state file -> restoreState), because the fix is in how those
 * two halves agree on a field, which a hand-built `setHistory` call cannot see.
 */
describe('history sequence survives a restart (#8336)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-8336-'))
  const managers = []
  after(() => rmSync(dir, { recursive: true, force: true }))
  afterEach(() => { for (const m of managers.splice(0)) m.destroyAll() })

  let n = 0
  /** Start a manager over `session` (a persisted session record) and return it with its session id. */
  function boot(session, maxHistory) {
    const stateFile = join(dir, `state-${++n}.json`)
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      sessions: [{ name: 'S', cwd: '/tmp', model: null, permissionMode: 'approve', sdkSessionId: null, ...session }],
    }))
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: stateFile, maxHistory })
    managers.push(mgr)
    const sid = mgr.restoreState()
    assert.ok(sid, 'a session was restored')
    return { mgr, sid }
  }

  /** The frames a reconnecting client with `cursor` is sent, through the real planner and wire mapper. */
  function replayFrames(mgr, sid, cursor) {
    const history = mgr.getHistory(sid)
    const plan = resolveReplayPlan(mgr, history, sid, cursor, mgr.getLatestHistorySeq(sid))
    const frames = []
    for (const entry of history.slice(plan.startOffset)) {
      sendHistoryEntry((_ws, payload) => frames.push(payload), null, sid, entry)
    }
    return { plan, frames }
  }

  const Q = { question: 'Which shape?', options: [{ label: 'Round' }] }
  // The previous run's ring buffer at cap 4: seqs 5..8, last issued seq 8.
  const codexCase = () => ({
    historyLastSeq: 8,
    history: [
      { type: 'message', messageType: 'user_input', content: 'go', timestamp: 1 },
      { type: 'tool_start', toolUseId: 'Q', tool: 'AskUserQuestion', timestamp: 2 },
      { type: 'user_question', toolUseId: 'Q', questions: [Q], timestamp: 3 },
      { type: 'message', messageType: 'response', content: 'later', timestamp: 4 },
    ],
  })

  // Codex's blocking case, verbatim: cap 4, old cursor 6, six entries after the
  // sweep. Renumbering from 1 left the client's cursor 6 equal to the latest seq,
  // so the plan honoured it and sent NOTHING -- no interrupted mark.
  it('a trimmed history still delivers the correction to a client at cursor 6 (cap 4)', () => {
    const { mgr, sid } = boot(codexCase(), 4)
    assert.equal(mgr.getHistory(sid).length, 4, 'trimmed to the cap')
    const { plan, frames } = replayFrames(mgr, sid, 6)
    assert.equal(plan.fullHistory, false, 'the cursor is still honoured: nothing it holds was trimmed away')
    assert.ok(frames.length > 0, 'something is sent')
    const q = frames.filter((f) => f.type === 'user_question')
    assert.ok(q.length >= 1 && q.every((f) => f.interrupted === true), 'the interrupted question arrives')
    assert.ok(q.every((f) => f.historySeq > 6), 'past the cursor')
    assert.ok(frames.every((f) => f.sourceToolUseId === undefined))
  })

  it('every cursor the previous run could have issued receives the correction', () => {
    for (const cursor of [0, 1, 4, 5, 6, 7, 8]) {
      const { mgr, sid } = boot(codexCase(), 4)
      const { frames } = replayFrames(mgr, sid, cursor)
      const q = frames.filter((f) => f.type === 'user_question')
      assert.ok(q.length >= 1 && q.every((f) => f.interrupted === true), `cursor ${cursor}: marked question delivered`)
      managers.pop().destroyAll()
    }
  })

  it('numbering continues past the previous run: the tail is beyond its last seq', () => {
    const { mgr, sid } = boot(codexCase(), 50)
    const seqs = mgr.getHistory(sid).map((e) => e._seq)
    assert.equal(seqs[0], 5, 'first entry keeps the number it had')
    assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b))
    assert.ok(mgr.getLatestHistorySeq(sid) > 8, 'the tail copy is past the old last seq')
    // A turn after the restart is numbered past that too.
    mgr._history.recordHistory(sid, 'message', { type: 'user_input', content: 'next', timestamp: 9 })
    assert.equal(mgr.getHistory(sid).at(-1)._seq, mgr.getLatestHistorySeq(sid))
    assert.ok(mgr.getLatestHistorySeq(sid) >= 11)
  })

  it('the cursor-ahead-of-latest guard (#5555.3) still forces a full replay', () => {
    const { mgr, sid } = boot(codexCase(), 50)
    const latest = mgr.getLatestHistorySeq(sid)
    for (const cursor of [latest + 1, latest + 50]) {
      const { plan, frames } = replayFrames(mgr, sid, cursor)
      assert.equal(plan.fullHistory, true, `cursor ${cursor} > latest ${latest}`)
      assert.equal(frames.length, mgr.getHistory(sid).length)
    }
  })

  it('a cursor older than the oldest retained entry still falls back to a full replay', () => {
    const { mgr, sid } = boot(codexCase(), 4)
    // retained seqs are 7..10; a client that stopped at 4 would miss 5..6.
    const { plan } = replayFrames(mgr, sid, 4)
    assert.equal(plan.fullHistory, true)
  })

  it('a state file with no stored seq behaves as before (renumbered from 1, nothing breaks)', () => {
    const legacy = codexCase()
    delete legacy.historyLastSeq
    const { mgr, sid } = boot(legacy, 50)
    assert.equal(mgr.getHistory(sid)[0]._seq, 1)
    const { plan } = replayFrames(mgr, sid, 99)
    assert.equal(plan.fullHistory, true, 'a cursor from the old run is beyond the new latest')
    // And a contradictory field is ignored rather than trusted.
    const bad = codexCase()
    bad.historyLastSeq = 2
    const second = boot(bad, 50)
    assert.equal(second.mgr.getHistory(second.sid)[0]._seq, 1)
  })

  it('serializeState records the last issued seq so the next restart can continue it', () => {
    const { mgr, sid } = boot(codexCase(), 50)
    const saved = mgr.serializeState().sessions.find((s) => s.id === sid)
    assert.equal(saved.historyLastSeq, mgr.getLatestHistorySeq(sid))
    assert.ok(saved.history.every((e) => e._seq === undefined), '_seq itself is still never persisted')
  })

  // Codex nonblocking 1: the sweep's additions used to be written on top of an
  // already-full buffer and persisted, growing it on every restart that found a
  // pending question (6, 8, 10 ... at cap 4).
  it('repeated restarts with new pending questions in between never exceed the cap', () => {
    const cap = 4
    let { mgr, sid } = boot(codexCase(), cap)
    const lengths = []
    for (let restart = 0; restart < 6; restart++) {
      // New traffic after the restart: a fresh question left pending.
      const id = `Q${restart}`
      mgr._history.recordHistory(sid, 'tool_start', { messageId: `m${restart}`, toolUseId: id, tool: 'AskUserQuestion', input: null })
      mgr._history.recordHistory(sid, 'user_question', { toolUseId: id, questions: [Q] })
      const state = mgr.serializeState().sessions.find((s) => s.id === sid)
      assert.ok(state.history.length <= cap, `persisted ${state.history.length} > ${cap}`)
      mgr.destroyAll()
      managers.pop()
      ;({ mgr, sid } = boot({ history: state.history, historyLastSeq: state.historyLastSeq }, cap))
      lengths.push(mgr.getHistory(sid).length)
      // The newest question's verdict survives the trim and is delivered.
      const { frames } = replayFrames(mgr, sid, state.historyLastSeq)
      assert.ok(
        frames.some((f) => f.type === 'user_question' && f.toolUseId === id && f.interrupted === true),
        `restart ${restart}: the pending question is reported interrupted`,
      )
    }
    assert.ok(lengths.every((l) => l <= cap), `history lengths ${lengths}`)
  })

  it('a restore that trims says the history was truncated', () => {
    const { mgr, sid } = boot(codexCase(), 4)
    assert.equal(mgr.isHistoryTruncated(sid), true)
  })
})

describe('internal metadata and diagnostics (#8336)', () => {
  it('sendHistoryEntry does not put sourceToolUseId on the wire', () => {
    const frames = []
    sendHistoryEntry((_ws, p) => frames.push(p), null, 's1', {
      type: 'user_question', toolUseId: 'ask-1', sourceToolUseId: 'toolu_1', questions: [{ question: 'q' }], _seq: 3,
    })
    assert.equal(frames.length, 1)
    assert.equal('sourceToolUseId' in frames[0], false)
    assert.equal(frames[0].toolUseId, 'ask-1')
    assert.equal(frames[0].historySeq, 3)
  })

  it('PermissionManager warns once when a question has no provider tool-use id, and still asks', async () => {
    const warns = []
    const pm = new PermissionManager({ log: { info() {}, warn: (m) => warns.push(m) } })
    try {
      const events = []
      pm.on('user_question', (d) => events.push(d))
      const p = pm.handlePermission('AskUserQuestion', ASK_INPUT, null, 'approve')
      assert.equal(events.length, 1, 'the question is still raised')
      assert.equal(events[0].sourceToolUseId, undefined)
      assert.equal(warns.length, 1)
      assert.ok(warns[0].includes(events[0].toolUseId), 'names the question')
      pm.respondToQuestion('Round')
      await p
    } finally {
      // A failed assertion must not leave the question's timer holding the runner open.
      pm.clearAll()
      pm.destroy()
    }
  })

  it('PermissionManager does not warn when the provider id is supplied', async () => {
    const warns = []
    const pm = new PermissionManager({ log: { info() {}, warn: (m) => warns.push(m) } })
    try {
      const p = pm.handlePermission('AskUserQuestion', ASK_INPUT, null, 'approve', undefined, 'toolu_1')
      assert.deepEqual(warns, [])
      pm.respondToQuestion('Round')
      await p
    } finally {
      pm.clearAll()
      pm.destroy()
    }
  })
})
