import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession } from '../src/base-session.js'
import { replayHistory } from '../src/ws-history.js'

/**
 * #8599 -- a dashboard that joins (or switches to) a session that is running a
 * turn right now must not be told it is idle by the history replay. Real
 * SessionManager + real BaseSession + the real `replayHistory`, with completed
 * turns already in the ring buffer; nothing stubs `isSessionBusy`.
 *
 * Every SessionManager here uses a temp stateFilePath (#4633).
 */
describe('late join of a busy session (#8599)', () => {
  let tmpRoot
  let skillsDir
  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'late-join-busy-'))
    skillsDir = join(tmpRoot, 'skills')
    mkdirSync(skillsDir, { recursive: true })
  })
  after(() => rmSync(tmpRoot, { recursive: true, force: true }))

  async function joinAndReplay({ busy }) {
    const manager = new SessionManager({
      skipPreflight: true, maxSessions: 5,
      stateFilePath: join(tmpRoot, `state-${Math.random().toString(36).slice(2)}.json`),
    })
    const session = new BaseSession({ cwd: '/tmp', skillsDir, repoSkillsDir: null })
    manager._sessions.set('s1', { session, name: 'Work', cwd: '/repo', createdAt: Date.now() })
    // Two completed turns, the second leaving an orphan tool_start behind.
    manager._recordHistory('s1', 'message', { type: 'user_input', content: 'one', timestamp: 1 })
    manager._recordHistory('s1', 'message', { type: 'response', content: 'done one', messageId: 'r1', timestamp: 2 })
    manager._recordHistory('s1', 'result', { type: 'result', timestamp: 3 })
    manager._recordHistory('s1', 'message', { type: 'user_input', content: 'two', timestamp: 4 })
    manager._recordHistory('s1', 'tool_start', { messageId: 't1', toolUseId: 't1', tool: 'Bash', input: null, timestamp: 5 })
    manager._recordHistory('s1', 'result', { type: 'result', timestamp: 6 })
    // The turn running right now.
    manager._recordHistory('s1', 'message', { type: 'user_input', content: 'three', timestamp: 7 })
    if (busy) session._isBusy = true

    const sent = []
    const ws = { readyState: 1, bufferedAmount: 0, send() {}, close() {} }
    const ctx = {
      sessionManager: manager,
      clients: new Map([[ws, { id: 'late', activeSessionId: 's1' }]]),
      send: (_ws, payload) => sent.push(payload),
      permissions: null,
    }
    replayHistory(ctx, ws, 's1', { forceFull: true })
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
    return { sent, listed: manager.listSessions().find((s) => s.sessionId === 's1') }
  }

  it('a busy session: the roster says busy and the replay sends no agent_idle', async () => {
    const { sent, listed } = await joinAndReplay({ busy: true })
    assert.equal(listed.isBusy, true, 'precondition: the server knows the session is busy')
    assert.equal(sent.filter((m) => m.type === 'result').length, 2, 'positive control: the replay carried both prior results')
    assert.deepEqual(sent.filter((m) => m.type === 'agent_idle'), [], 'a replayed old result must not read as the live turn ending')
    assert.equal(sent[sent.length - 1].type, 'history_replay_end')
  })

  it('an idle session still gets agent_idle after each replayed result (orphan-tool cleanup)', async () => {
    const { sent, listed } = await joinAndReplay({ busy: false })
    assert.equal(listed.isBusy, false)
    const types = sent.map((m) => m.type)
    assert.equal(sent.filter((m) => m.type === 'agent_idle').length, 2)
    types.forEach((t, i) => { if (t === 'result') assert.equal(types[i + 1], 'agent_idle') })
  })
})
