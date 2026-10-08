import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
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
