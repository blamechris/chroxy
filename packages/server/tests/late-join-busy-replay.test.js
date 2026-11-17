import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession } from '../src/base-session.js'
import { replayHistory } from '../src/ws-history.js'
import { conversationHandlers } from '../src/handlers/conversation-handlers.js'
import { nsCtx } from './test-helpers.js'

/**
 * #8599 -- a dashboard that joins (or switches to) a session that is running a
 * turn right now must not be told it is idle by the history replay. Real
 * SessionManager + real BaseSession + the real replay paths (`replayHistory`
 * for connect/switch, `request_full_history` for "Sync Full History"); nothing
 * stubs `isSessionBusy`.
 *
 * Every SessionManager here uses a temp stateFilePath (#4633).
 */
describe('late join of a busy session (#8599)', () => {
  let tmpRoot
  let skillsDir
  let seq = 0
  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'late-join-busy-'))
    skillsDir = join(tmpRoot, 'skills')
    mkdirSync(skillsDir, { recursive: true })
  })
  after(() => rmSync(tmpRoot, { recursive: true, force: true }))

  // Every manager built here is torn down so no timer outlives the file.
  const managers = []
  afterEach(() => {
    while (managers.length) {
      try { managers.pop().destroyAll() } catch { /* already torn down */ }
    }
  })

  const turns = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

  /** Real manager + session; history: two completed turns (second leaves an orphan tool_start), then a third in flight. */
  function build({ busy }) {
    const manager = new SessionManager({
      skipPreflight: true, maxSessions: 5,
      stateFilePath: join(tmpRoot, `state-${++seq}.json`),
    })
    const session = new BaseSession({ cwd: '/tmp', skillsDir, repoSkillsDir: null })
    manager._sessions.set('s1', { session, name: 'Work', cwd: '/repo', createdAt: Date.now() })
    manager._recordHistory('s1', 'message', { type: 'user_input', content: 'one', timestamp: 1 })
    manager._recordHistory('s1', 'message', { type: 'response', content: 'done one', messageId: 'r1', timestamp: 2 })
    manager._recordHistory('s1', 'result', { type: 'result', timestamp: 3 })
    manager._recordHistory('s1', 'message', { type: 'user_input', content: 'two', timestamp: 4 })
    manager._recordHistory('s1', 'tool_start', { messageId: 't1', toolUseId: 't1', tool: 'Bash', input: null, timestamp: 5 })
    manager._recordHistory('s1', 'result', { type: 'result', timestamp: 6 })
    manager._recordHistory('s1', 'message', { type: 'user_input', content: 'three', timestamp: 7 })
    if (busy) session._isBusy = true
    managers.push(manager)
    return { manager, session }
  }

  async function connectReplay({ busy, cursor, onSend }) {
    const { manager, session } = build({ busy })
    const sent = []
    const ws = { readyState: 1, bufferedAmount: 0, send() {}, close() {} }
    const rec = { id: 'late', activeSessionId: 's1', ...(cursor !== undefined ? { historyCursors: { s1: cursor } } : {}) }
    const ctx = {
      sessionManager: manager,
      clients: new Map([[ws, rec]]),
      send: (_ws, payload) => { sent.push(payload); onSend?.(payload, session) },
      permissions: null,
    }
    replayHistory(ctx, ws, 's1', cursor === undefined ? { forceFull: true } : {})
    await turns()
    return { sent, listed: manager.listSessions().find((s) => s.sessionId === 's1') }
  }

  /** `jsonl: true` serves a transcript-shaped slice (no result entries), as a resumed claude-family session does. */
  async function syncFullHistory({ busy, jsonl = false, onSend }) {
    const { manager, session } = build({ busy })
    if (jsonl) {
      manager.getFullHistoryAsync = async () => ({
        source: 'jsonl',
        truncated: false,
        entries: [
          { type: 'user_input', content: 'one', timestamp: 1 },
          { type: 'response', content: 'done one', timestamp: 2 },
          { type: 'tool_use', content: '{}', tool: 'Bash', timestamp: 3 },
        ],
      })
    }
    const sent = []
    const ws = { readyState: 1, bufferedAmount: 0, send() {}, close() {} }
    const ctx = nsCtx({
      send: (_t, msg) => { sent.push(msg); onSend?.(msg, session) },
      sessionManager: manager,
      reseedActiveAgents: () => {},
      resendPendingQuestions: () => {},
      resendPendingPermissions: () => {},
    })
    await conversationHandlers.request_full_history(ws, { id: 'late', activeSessionId: 's1' }, { type: 'request_full_history' }, ctx)
    await turns()
    return { sent, listed: manager.listSessions().find((s) => s.sessionId === 's1') }
  }

  it('a busy session: the roster says busy and the replay sends no agent_idle', async () => {
    const { sent, listed } = await connectReplay({ busy: true })
    assert.equal(listed.isBusy, true, 'precondition: the server knows the session is busy')
    assert.equal(sent.filter((m) => m.type === 'result').length, 2, 'positive control: the replay carried both prior results')
    assert.deepEqual(sent.filter((m) => m.type === 'agent_idle'), [], 'a replayed old result must not read as the live turn ending')
    assert.equal(sent[sent.length - 1].type, 'history_replay_end')
  })

  it('an idle session still gets agent_idle after each replayed result (orphan-tool cleanup)', async () => {
    const { sent, listed } = await connectReplay({ busy: false })
    assert.equal(listed.isBusy, false)
    const types = sent.map((m) => m.type)
    assert.equal(sent.filter((m) => m.type === 'agent_idle').length, 2)
    types.forEach((t, i) => { if (t === 'result') assert.equal(types[i + 1], 'agent_idle') })
  })

  it('a DELTA replay (cursor honoured) of a busy session sends no agent_idle; idle twin does', async () => {
    const busy = await connectReplay({ busy: true, cursor: 1 })
    const start = busy.sent.find((m) => m.type === 'history_replay_start')
    assert.equal(start.fullHistory, false, 'precondition: this really is a delta replay')
    assert.equal(busy.sent.filter((m) => m.type === 'result').length, 2, 'positive control: results are in the delta')
    assert.equal(busy.sent.filter((m) => m.type === 'agent_idle').length, 0)

    const idle = await connectReplay({ busy: false, cursor: 1 })
    assert.equal(idle.sent.find((m) => m.type === 'history_replay_start').fullHistory, false)
    assert.equal(idle.sent.filter((m) => m.type === 'agent_idle').length, 2)
  })

  it('busy is asked per result: a turn that starts mid-replay stops the synthesis from then on', async () => {
    // Flip to busy the moment the first agent_idle goes out.
    const { sent } = await connectReplay({
      busy: false,
      onSend: (payload, session) => { if (payload.type === 'agent_idle') session._isBusy = true },
    })
    const types = sent.map((m) => m.type)
    assert.equal(types.filter((t) => t === 'result').length, 2)
    assert.equal(types.filter((t) => t === 'agent_idle').length, 1, 'only the result seen while idle is followed by agent_idle')
    assert.equal(types[types.indexOf('result') + 1], 'agent_idle')
  })

  it('request_full_history ("Sync Full History") of a busy session sends no agent_idle; idle twin does', async () => {
    const busy = await syncFullHistory({ busy: true })
    assert.equal(busy.listed.isBusy, true)
    assert.equal(busy.sent.filter((m) => m.type === 'result').length, 2, 'positive control: results replayed')
    assert.equal(busy.sent.filter((m) => m.type === 'agent_idle').length, 0)
    assert.equal(busy.sent[busy.sent.length - 1].type, 'history_replay_end')

    const idle = await syncFullHistory({ busy: false })
    assert.equal(idle.sent.filter((m) => m.type === 'agent_idle').length, 2)
  })

  it('request_full_history JSONL source: a busy session gets no healing agent_idle; an idle one gets exactly one before history_replay_end', async () => {
    const busy = await syncFullHistory({ busy: true, jsonl: true })
    assert.equal(busy.listed.isBusy, true, 'precondition: the server knows the session is busy')
    assert.equal(busy.sent.filter((m) => m.type === 'message').length, 3, 'positive control: the JSONL slice was replayed')
    assert.equal(busy.sent.filter((m) => m.type === 'result').length, 0, 'positive control: a JSONL slice carries no result')
    assert.deepEqual(busy.sent.filter((m) => m.type === 'agent_idle'), [])
    assert.equal(busy.sent[busy.sent.length - 1].type, 'history_replay_end')

    const idle = await syncFullHistory({ busy: false, jsonl: true })
    assert.equal(idle.listed.isBusy, false)
    const types = idle.sent.map((m) => m.type)
    assert.equal(types.filter((t) => t === 'agent_idle').length, 1)
    assert.equal(types[types.indexOf('agent_idle') + 1], 'history_replay_end', 'the heal lands right before the end frame')
  })

  it('request_full_history: a turn that starts mid-replay stops the synthesis from then on', async () => {
    // Flip to busy the moment the first agent_idle goes out.
    const { sent } = await syncFullHistory({
      busy: false,
      onSend: (msg, session) => { if (msg.type === 'agent_idle') session._isBusy = true },
    })
    const types = sent.map((m) => m.type)
    assert.equal(types.filter((t) => t === 'result').length, 2)
    assert.equal(types.filter((t) => t === 'agent_idle').length, 1, 'only the result seen while idle is followed by agent_idle')
    assert.equal(types[types.indexOf('result') + 1], 'agent_idle')
  })
})
