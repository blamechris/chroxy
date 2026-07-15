import { describe, it, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliSession } from '../src/cli-session.js'
import { isWindows } from '../src/platform.js'
import { SessionStatePersistence } from '../src/session-state-persistence.js'

/**
 * Tests for CliSession lifecycle: process management, respawn,
 * model switching, sendMessage, interrupt, and destroy.
 *
 * We do NOT call start() in most tests — instead we manipulate
 * internal state to test behaviors in isolation without spawning
 * real child processes.
 *
 * #4700: every test routes through a per-test temp `stateFilePath` so a
 * future regression that gives CliSession a persistence path can never
 * contaminate `~/.chroxy/session-state.json`. CliSession does not
 * currently accept `stateFilePath` directly (the persistence layer lives
 * on SessionManager / SessionStatePersistence), so the value is stashed
 * on the instance as `_testStateFilePath` and ignored by the constructor
 * — purely a belt-and-braces guard so the moment someone wires a write
 * path on the session this hook already exists. Mirrors the temp-state
 * discipline pinned in session-manager.test.js (#429, #2314).
 */

// Module-level temp dir for tests that don't manage their own. Each call
// returns a unique file path so concurrent describe blocks don't share
// state. The `after` hook below tears the whole dir down.
let _globalTmpDir
function tmpStateFile() {
  if (!_globalTmpDir) _globalTmpDir = mkdtempSync(join(tmpdir(), 'cli-session-test-'))
  return join(_globalTmpDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

after(() => {
  if (_globalTmpDir) rmSync(_globalTmpDir, { recursive: true, force: true })
})

// #6027: sendMessage arms _resultTimeout/_hardTimeout/_streamStallTimeout, but
// most tests clear only _resultTimeout (or none), leaking _hardTimeout/
// _streamStallTimeout and keeping the suite alive without --test-force-exit.
// Track every constructed session and destroy() it after each test — destroy()
// clears all of them and is idempotent (tests already call it twice safely).
const _createdSessions = []
afterEach(() => {
  for (const s of _createdSessions) {
    // Null the mock child first: destroy() otherwise arms a 3s forceKillTimer
    // cleared only by a real child's 'close' event, which the mock never emits
    // — a (self-clearing, non-hanging) timer we'd rather not add in a teardown.
    s._child = null
    try { const r = s.destroy(); if (r && typeof r.catch === 'function') r.catch(() => {}) } catch {}
  }
  _createdSessions.length = 0
})

function createSession(opts = {}) {
  const stateFilePath = opts.stateFilePath || tmpStateFile()
  // CliSession ignores unknown keys via destructuring today, so passing
  // `stateFilePath` is a harmless no-op now AND auto-protects the suite
  // the moment someone wires a persistence path on the session class —
  // the destructured value will point at the per-test temp file instead
  // of `~/.chroxy/session-state.json`. The path is also stashed on the
  // instance so individual tests can assert on it.
  const session = new CliSession({ cwd: '/tmp', stateFilePath, ...opts })
  session._testStateFilePath = stateFilePath
  _createdSessions.push(session)
  return session
}

// Simulate a session that's ready (post-start) without actually spawning
function createReadySession(opts = {}) {
  const session = createSession(opts)
  session._processReady = true
  session._child = createMockChild()
  return session
}

function createMockChild() {
  const child = new EventEmitter()
  child.stdin = new Writable({ write(chunk, enc, cb) { cb() } })
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 12345
  child.kill = mock.fn(() => true)
  child.killed = false
  return child
}

describe('CliSession constructor', () => {
  it('sets defaults from options', () => {
    const session = createSession({ cwd: '/home/user', model: 'opus' })
    assert.equal(session.cwd, '/home/user')
    assert.equal(session.model, 'opus')
    assert.equal(session.permissionMode, 'approve')
    assert.equal(session._isBusy, false)
    assert.equal(session._processReady, false)
  })

  it('generates a per-session hookSecret as a 64-char hex string', () => {
    const session = createSession()
    assert.equal(typeof session._hookSecret, 'string')
    assert.equal(session._hookSecret.length, 64)
    assert.ok(/^[0-9a-f]+$/.test(session._hookSecret), 'hookSecret should be lowercase hex')
  })

  it('generates unique hookSecrets for each session', () => {
    const s1 = createSession()
    const s2 = createSession()
    assert.notEqual(s1._hookSecret, s2._hookSecret)
  })

  it('creates hook manager when port is provided', () => {
    const session = createSession({ port: 8765 })
    assert.ok(session._hookManager)
    assert.equal(typeof session._hookManager.register, 'function')
    session._hookManager.destroy()
  })

  it('does not create hook manager without port', () => {
    const session = createSession()
    assert.equal(session._hookManager, null)
  })
})

describe('CliSession.sendMessage', () => {
  // #5936 (epic #5935): a send-while-busy follow-up now QUEUES into the shared
  // outgoing queue (flushed FIFO on the turn-complete `result`) instead of
  // rejecting with "Already processing a message".
  it('queues when busy (emits message_queued, no error)', () => {
    const session = createReadySession()
    session._isBusy = true
    const errors = []
    const queued = []
    session.on('error', (e) => errors.push(e))
    session.on('message_queued', (e) => queued.push(e))
    session.sendMessage('hello')
    assert.equal(errors.length, 0)
    assert.equal(queued.length, 1)
    assert.equal(queued[0].text, 'hello')
    assert.equal(session._outgoingQueue.length, 1)
  })

  it('queues message when process not ready', () => {
    const session = createSession()
    session._processReady = false
    session.sendMessage('queued message')
    assert.equal(session._pendingQueue.length, 1)
    assert.deepStrictEqual(session._pendingQueue[0], { prompt: 'queued message', attachments: undefined, options: {} })
    assert.equal(session._isBusy, false)
  })

  it('writes NDJSON to stdin and sets busy state', () => {
    const session = createReadySession()
    const written = []
    session._child.stdin = new Writable({
      write(chunk, enc, cb) { written.push(chunk.toString()); cb() },
    })

    session.sendMessage('test prompt')

    assert.equal(session._isBusy, true)
    // messageId format is `msg-{6-hex-bootPrefix}-{counter}` (#3700) —
    // the prefix is random per BaseSession instance so assert the
    // shape rather than the literal value.
    assert.match(session._currentMessageId, /^msg-[0-9a-f]{6}-1$/)
    assert.equal(written.length, 1)
    const parsed = JSON.parse(written[0].trim())
    assert.equal(parsed.type, 'user')
    assert.equal(parsed.message.content[0].text, 'test prompt')
    // Clean up timer
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null
  })

  it('sets result timeout on send', () => {
    const session = createReadySession()
    session.sendMessage('test')
    assert.ok(session._resultTimeout)
    // Clean up to prevent test hanging
    clearTimeout(session._resultTimeout)
    session._resultTimeout = null
    session._isBusy = false
  })
})

describe('CliSession._clearMessageState', () => {
  it('resets busy state and clears result timeout', () => {
    const session = createReadySession()
    session._isBusy = true
    session._currentMessageId = 'msg-1'
    session._resultTimeout = setTimeout(() => {}, 10000)
    session._currentCtx = { hasStreamStarted: false, didStreamText: false }

    session._clearMessageState()

    assert.equal(session._isBusy, false)
    assert.equal(session._currentMessageId, null)
    assert.equal(session._currentCtx, null)
    assert.equal(session._resultTimeout, null)
  })

  it('emits agent_completed for all tracked agents', () => {
    const session = createReadySession()
    session._isBusy = true
    session._currentCtx = { hasStreamStarted: false, didStreamText: false }
    session._activeAgents.set('agent-1', { toolUseId: 'agent-1' })
    session._activeAgents.set('agent-2', { toolUseId: 'agent-2' })

    const completed = []
    session.on('agent_completed', (data) => completed.push(data))
    session._clearMessageState()

    assert.equal(completed.length, 2)
    assert.equal(session._activeAgents.size, 0)
  })

  it('resets stale _inPlanMode when ExitPlanMode never arrived', () => {
    const session = createReadySession()
    session._isBusy = true
    session._inPlanMode = true
    session._planAllowedPrompts = null // ExitPlanMode never set this
    session._currentCtx = { hasStreamStarted: false, didStreamText: false }

    session._clearMessageState()
    assert.equal(session._inPlanMode, false)
  })

  it('preserves _inPlanMode when ExitPlanMode has fired', () => {
    const session = createReadySession()
    session._isBusy = true
    session._inPlanMode = true
    session._planAllowedPrompts = [{ tool: 'Bash', prompt: 'run tests' }]
    session._currentCtx = { hasStreamStarted: false, didStreamText: false }

    session._clearMessageState()
    // _inPlanMode stays true because plan_ready emit + reset happens
    // in the result handler, before _clearMessageState is called.
    // If we reach here with _planAllowedPrompts non-null, it means
    // the result handler path hasn't run yet — preserve the flag.
    assert.equal(session._inPlanMode, true)
  })
})

describe('CliSession._scheduleRespawn', () => {
  let session

  afterEach(() => {
    if (session) {
      session._destroying = true
      if (session._respawnTimer) {
        clearTimeout(session._respawnTimer)
        session._respawnTimer = null
      }
    }
  })

  it('schedules respawn with increasing delay', () => {
    session = createSession()
    session._respawnCount = 0
    session._scheduleRespawn()
    assert.equal(session._respawnCount, 1)
    assert.ok(session._respawnTimer)
  })

  it('gives up after 5 attempts', () => {
    session = createSession()
    session._respawnCount = 5
    const errors = []
    session.on('error', (e) => errors.push(e))
    session._scheduleRespawn()
    assert.equal(session._respawnCount, 6)
    assert.equal(session._respawnTimer, null)
    assert.equal(errors.length, 1)
    assert.ok(errors[0].message.includes('5 attempts'))
  })

  it('does not schedule when destroying', () => {
    session = createSession()
    session._destroying = true
    session._scheduleRespawn()
    assert.equal(session._respawnTimer, null)
  })
})

describe('CliSession.interrupt', () => {
  it('sends SIGINT to child process', () => {
    const session = createReadySession()
    session._isBusy = true
    session.interrupt()
    assert.equal(session._child.kill.mock.calls.length, 1)
    assert.equal(session._child.kill.mock.calls[0].arguments[0], 'SIGINT')
    // Cleanup safety timer to prevent test hanging
    clearTimeout(session._interruptTimer)
    session._interruptTimer = null
  })

  it('sends SIGINT even when not busy (unconditional)', () => {
    const session = createReadySession()
    session._isBusy = false
    session.interrupt()
    // interrupt() sends SIGINT regardless of busy state (only checks _child)
    assert.equal(session._child.kill.mock.calls.length, 1)
    clearTimeout(session._interruptTimer)
    session._interruptTimer = null
  })

  it('does nothing when no child process', () => {
    const session = createSession()
    session._isBusy = true
    session._child = null
    // Should not throw
    session.interrupt()
  })
})

describe('CliSession._handleChildClose (interrupt-recovery)', () => {
  it('emits stream_end + result + error in order when interrupted mid-turn, so dashboard clears Stop button', () => {
    const session = createReadySession()
    session._isBusy = true
    session._currentMessageId = 'msg_42'
    session._currentCtx = { hasStreamStarted: true }
    session._sessionId = 'sess_abc'

    const events = []
    session.on('stream_end', (p) => events.push({ name: 'stream_end', payload: p }))
    session.on('result', (p) => events.push({ name: 'result', payload: p }))
    session.on('error', (p) => events.push({ name: 'error', payload: p }))

    session._handleChildClose(130)

    // Cleanup respawn timer scheduled by _handleChildClose
    clearTimeout(session._respawnTimer)
    session._respawnTimer = null

    assert.deepEqual(events.map((e) => e.name), ['stream_end', 'result', 'error'])
    assert.equal(events[0].payload.messageId, 'msg_42')
    // The `result` emit is the load-bearing change: event-normalizer fans it
    // out to `agent_idle`, which is what the dashboard listens for to clear
    // `streamingMessageId` / `isIdle`. Without it, Stop stays visible and
    // "Thinking…" never goes away.
    assert.equal(events[1].payload.sessionId, 'sess_abc')
    assert.equal(events[1].payload.cost, null, 'cost: null skips session-manager cost accounting')
    assert.equal(events[1].payload.usage, null)
    assert.match(events[2].payload.message, /exited unexpectedly/)
  })

  it('does NOT emit result when not busy (no turn to terminate)', () => {
    const session = createReadySession()
    session._isBusy = false

    const events = []
    session.on('stream_end', () => events.push('stream_end'))
    session.on('result', () => events.push('result'))
    session.on('error', () => events.push('error'))

    session._handleChildClose(0)
    clearTimeout(session._respawnTimer)
    session._respawnTimer = null

    assert.deepEqual(events, ['error'], 'only the supervisor-restart error fires when no turn is in flight')
  })

  it('does NOT emit stream_end if the stream had not started yet (tool ran before any text)', () => {
    const session = createReadySession()
    session._isBusy = true
    session._currentMessageId = 'msg_x'
    session._currentCtx = { hasStreamStarted: false }
    session._sessionId = 'sess_x'

    const events = []
    session.on('stream_end', () => events.push('stream_end'))
    session.on('result', () => events.push('result'))
    session.on('error', () => events.push('error'))

    session._handleChildClose(0)
    clearTimeout(session._respawnTimer)
    session._respawnTimer = null

    // Still emits result — that's the key — so the dashboard's Stop clears
    // even when the stream never started.
    assert.deepEqual(events, ['result', 'error'])
  })

  it('skips all emits when _destroying (session being torn down — no respawn, no result)', () => {
    const session = createReadySession()
    session._isBusy = true
    session._currentMessageId = 'msg_x'
    session._destroying = true

    const events = []
    session.on('stream_end', () => events.push('stream_end'))
    session.on('result', () => events.push('result'))
    session.on('error', () => events.push('error'))

    session._handleChildClose(0)

    assert.deepEqual(events, [], 'destroy path is silent — caller owns the teardown UX')
  })
})

describe('CliSession._handleHardTimeout (#4470: missing result emit)', () => {
  it('emits stream_end + result + error so dashboard clears Stop on hard-cap timeout', () => {
    const session = createReadySession({ hardTimeoutMs: 60_000 })
    session._isBusy = true
    session._currentMessageId = 'msg_ht'
    session._currentCtx = { hasStreamStarted: true }
    session._sessionId = 'sess_ht'

    const events = []
    session.on('stream_end', (p) => events.push({ name: 'stream_end', payload: p }))
    session.on('result', (p) => events.push({ name: 'result', payload: p }))
    session.on('error', (p) => events.push({ name: 'error', payload: p }))

    session._handleHardTimeout()

    assert.deepEqual(events.map((e) => e.name), ['stream_end', 'result', 'error'])
    assert.equal(events[0].payload.messageId, 'msg_ht')
    assert.equal(events[1].payload.sessionId, 'sess_ht')
    assert.equal(events[1].payload.duration, session._hardTimeoutMs, 'duration carries the elapsed cap')
    assert.equal(events[1].payload.cost, null)
    assert.match(events[2].payload.message, /timed out/)
  })

  it('no-ops when not busy (timer fired against an idle session)', () => {
    const session = createReadySession()
    session._isBusy = false

    const events = []
    session.on('stream_end', () => events.push('stream_end'))
    session.on('result', () => events.push('result'))
    session.on('error', () => events.push('error'))

    session._handleHardTimeout()
    assert.deepEqual(events, [])
  })

  it('fires permission_expired for pending permission ids before clearing state', () => {
    const session = createReadySession()
    session._isBusy = true
    session._currentMessageId = 'msg_pe'
    session._currentCtx = { hasStreamStarted: false }
    session._pendingPermissionIds.add('req-1')
    session._pendingPermissionIds.add('req-2')

    const expired = []
    session.on('permission_expired', (p) => expired.push(p.requestId))
    session.on('error', () => {})

    session._handleHardTimeout()

    assert.deepEqual(expired.sort(), ['req-1', 'req-2'])
    assert.equal(session._pendingPermissionIds.size, 0)
  })
})

describe('CliSession._killAndRespawn (#4471: panic-button drops dashboard recovery)', () => {
  it('emits stream_end + result BEFORE setting _respawning, so dashboard clears Stop', () => {
    const session = createReadySession()
    session._isBusy = true
    session._currentMessageId = 'msg_kr'
    session._currentCtx = { hasStreamStarted: true }
    session._sessionId = 'sess_kr'
    session._destroying = true // suppress respawn (no real spawn in unit test)

    const oldChild = session._child
    const events = []
    let respawningAtResult = null
    session.on('stream_end', (p) => events.push({ name: 'stream_end', payload: p }))
    session.on('result', (p) => {
      events.push({ name: 'result', payload: p })
      respawningAtResult = session._respawning
    })

    session._killAndRespawn()

    // Drain the closure-scoped forceKillTimer: emitting 'close' on the
    // mock child invokes the respawn() callback which clears the timer.
    oldChild.emit('close', 0)

    assert.deepEqual(events.map((e) => e.name), ['stream_end', 'result'])
    assert.equal(events[0].payload.messageId, 'msg_kr')
    assert.equal(events[1].payload.sessionId, 'sess_kr')
    assert.equal(respawningAtResult, false, 'result emit must precede _respawning=true so subsequent close-handler does not duplicate')
  })

  it('no-ops emit when not busy (setModel called from idle)', () => {
    const session = createReadySession()
    session._isBusy = false
    session._destroying = true // suppress respawn

    const oldChild = session._child
    const events = []
    session.on('stream_end', () => events.push('stream_end'))
    session.on('result', () => events.push('result'))

    session._killAndRespawn()
    oldChild.emit('close', 0)

    assert.deepEqual(events, [])
  })

  // #4474: the production wiring attaches `_handleChildClose` as a child
  // listener (see _spawnPersistentProcess at cli-session.js:311). When
  // _killAndRespawn fires, the oldChild carries BOTH listeners: the
  // production one (which would re-emit result if the `_respawning` guard
  // were ever dropped) and the closure-scoped respawn() callback.
  //
  // Crucially: we do NOT set _destroying. The `_destroying` check in
  // _handleChildClose precedes the `_respawning` check (cli-session.js:
  // 1117-1118), so using `_destroying` as a respawn-suppression hatch
  // would mask the `_respawning` guard the comment claims to pin (#4480).
  // Instead we stub `start()` to a no-op so the closure respawn()
  // callback doesn't actually spawn a child in the unit test.
  it('does NOT double-emit result when the production close listener also fires (#4474)', () => {
    const session = createReadySession()
    session._isBusy = true
    session._currentMessageId = 'msg_dl'
    session._currentCtx = { hasStreamStarted: true }
    session._sessionId = 'sess_dl'
    // Stub spawn so the closure respawn() callback inside _killAndRespawn
    // doesn't actually try to spawn a real `claude` process.
    session.start = () => {}

    const oldChild = session._child
    // Mirror _spawnPersistentProcess's wiring — this is what makes the
    // _respawning guard at cli-session.js:1118 load-bearing.
    oldChild.on('close', (code) => session._handleChildClose(code))

    const results = []
    const errors = []
    session.on('result', (p) => results.push(p))
    session.on('error', (p) => errors.push(p))

    session._killAndRespawn()
    // Now emit 'close' — BOTH listeners fire on oldChild:
    //   (a) the manually-attached _handleChildClose → sees _respawning=true,
    //       short-circuits at the guard (the line we want to pin).
    //   (b) the closure respawn() callback → calls our stubbed start().
    // The _emitInterruptedTurnResult emit happens once at the TOP of
    // _killAndRespawn (before _respawning=true).
    oldChild.emit('close', 0)

    assert.equal(results.length, 1, 'exactly one result must fire — _emitInterruptedTurnResult at the top of _killAndRespawn')
    // This is the assertion that BITES on a `_respawning` guard regression:
    // the inherited _handleChildClose emits `error: "Claude process exited
    // unexpectedly..."` AFTER the _respawning check. If the guard were
    // dropped, this error would fire from the manually-attached listener.
    // The closure respawn() path never emits this error.
    assert.equal(errors.length, 0, '_handleChildClose must NOT emit the "exited unexpectedly" error during an intentional respawn — pins the _respawning guard at cli-session.js:1118')
  })
})

describe('CliSession._handleStreamStall (#4467: stream-stall recovery)', () => {
  it('emits stream_end + result + error{code:stream_stall} so dashboard can offer retry', () => {
    const session = createReadySession({ streamStallTimeoutMs: 60_000 })
    session._isBusy = true
    session._currentMessageId = 'msg_ss'
    session._currentCtx = { hasStreamStarted: true }
    session._sessionId = 'sess_ss'

    const events = []
    session.on('stream_end', (p) => events.push({ name: 'stream_end', payload: p }))
    session.on('result', (p) => events.push({ name: 'result', payload: p }))
    session.on('error', (p) => events.push({ name: 'error', payload: p }))

    session._handleStreamStall()

    assert.deepEqual(events.map((e) => e.name), ['stream_end', 'result', 'error'])
    assert.equal(events[1].payload.sessionId, 'sess_ss')
    assert.equal(events[1].payload.duration, session._streamStallTimeoutMs)
    assert.equal(events[2].payload.code, 'stream_stall', 'error MUST carry code:stream_stall so dashboard can distinguish from generic errors')
    assert.match(events[2].payload.message, /stalled/i)
  })

  it('no-ops when not busy (timer fired against an idle session)', () => {
    const session = createReadySession()
    session._isBusy = false

    const events = []
    session.on('stream_end', () => events.push('stream_end'))
    session.on('result', () => events.push('result'))
    session.on('error', () => events.push('error'))

    session._handleStreamStall()
    assert.deepEqual(events, [])
  })

  it('_armResultTimeout arms the stall timer when streamStallTimeoutMs > 0', () => {
    const session = createReadySession({ streamStallTimeoutMs: 60_000 })
    session._armResultTimeout()
    assert.ok(session._streamStallTimeout, 'stall timer must be armed')
    // Cleanup all three timers
    clearTimeout(session._resultTimeout)
    clearTimeout(session._hardTimeout)
    clearTimeout(session._streamStallTimeout)
  })

  it('_armResultTimeout does NOT arm the stall timer when streamStallTimeoutMs is 0 (disabled)', () => {
    const session = createReadySession({ streamStallTimeoutMs: 0 })
    session._armResultTimeout()
    assert.equal(session._streamStallTimeout, null, 'stall timer must remain disarmed when configured to 0')
    clearTimeout(session._resultTimeout)
    clearTimeout(session._hardTimeout)
  })

  it('_armResultTimeout resets the stall timer on subsequent activity (timer reference changes)', () => {
    const session = createReadySession({ streamStallTimeoutMs: 60_000 })
    session._armResultTimeout()
    const firstTimer = session._streamStallTimeout
    session._armResultTimeout()
    const secondTimer = session._streamStallTimeout
    assert.notStrictEqual(firstTimer, secondTimer, 'arming again must replace the timer handle, proving the silence window restarts')
    clearTimeout(session._resultTimeout)
    clearTimeout(session._hardTimeout)
    clearTimeout(session._streamStallTimeout)
  })

  it('notifyPermissionPending clears the stall timer (waiting on the user is not a stall)', () => {
    const session = createReadySession({ streamStallTimeoutMs: 60_000 })
    session._isBusy = true
    session._armResultTimeout()
    assert.ok(session._streamStallTimeout)

    session.notifyPermissionPending('req-stall-1')
    assert.equal(session._streamStallTimeout, null, 'stall timer must clear when a permission prompt is outstanding')
    assert.equal(session._resultTimeoutPaused, true)
  })
})

describe('CliSession.destroy', () => {
  it('sets destroying flag and nulls child', () => {
    const session = createReadySession()
    const child = session._child
    session.destroy()
    assert.equal(session._destroying, true)
    // destroy() sets _child = null after calling stdin.end()
    assert.equal(session._child, null)
  })

  it('clears all timers', () => {
    const session = createReadySession()
    session._respawnTimer = setTimeout(() => {}, 10000)
    session._resultTimeout = setTimeout(() => {}, 10000)
    session._interruptTimer = setTimeout(() => {}, 10000)

    session.destroy()

    assert.equal(session._respawnTimer, null)
    assert.equal(session._resultTimeout, null)
    assert.equal(session._interruptTimer, null)
  })

  it('emits agent_completed for tracked agents', () => {
    const session = createReadySession()
    session._activeAgents.set('a1', { toolUseId: 'a1' })
    const completed = []
    session.on('agent_completed', (d) => completed.push(d))

    session.destroy()
    assert.equal(completed.length, 1)
    assert.equal(completed[0].toolUseId, 'a1')
  })

  it('is safe to call multiple times', () => {
    const session = createReadySession()
    session.destroy()
    session.destroy() // should not throw
  })
})

describe('CliSession.respondToQuestion', () => {
  it('writes answer to stdin when waiting', () => {
    const session = createReadySession()
    const written = []
    session._child.stdin = new Writable({
      write(chunk, enc, cb) { written.push(chunk.toString()); cb() },
    })
    session._waitingForAnswer = true

    session.respondToQuestion('My answer')
    assert.equal(session._waitingForAnswer, false)
    assert.equal(written.length, 1)
    const parsed = JSON.parse(written[0].trim())
    assert.equal(parsed.type, 'user')
    assert.equal(parsed.message.content[0].text, 'My answer')
  })

  it('ignores when not waiting', () => {
    const session = createReadySession()
    const written = []
    session._child.stdin = new Writable({
      write(chunk, enc, cb) { written.push(chunk.toString()); cb() },
    })
    session._waitingForAnswer = false
    session.respondToQuestion('Ignored')
    assert.equal(written.length, 0)
  })
})

describe('CliSession properties', () => {
  it('isRunning reflects busy state', () => {
    const session = createSession()
    assert.equal(session.isRunning, false)
    session._isBusy = true
    assert.equal(session.isRunning, true)
  })

  it('isReady requires both processReady and not busy', () => {
    const session = createSession()
    assert.equal(session.isReady, false)
    session._processReady = true
    assert.equal(session.isReady, true)
    session._isBusy = true
    assert.equal(session.isReady, false)
  })

  it('sessionId returns internal ID', () => {
    const session = createSession()
    assert.equal(session.sessionId, null)
    session._sessionId = 'test-123'
    assert.equal(session.sessionId, 'test-123')
  })
})

// #4306 — thinking-keyword escalation is implemented in SdkSession only.
// CliSession runs `claude -p` (non-interactive, stream-json) and declares
// `thinkingLevel: false` in its capabilities (cli-session.js:90); the
// dashboard hides the dropdown for this provider, and there is no
// per-turn maxThinkingTokens hook in the stream-json wire. Re-asserting
// the structural no-op so future refactors do not accidentally bolt a
// keyword handler onto the CLI provider without also wiring a budget
// control to honour it. (Otherwise the dashboard's highlight gate —
// see #4306 Part 2 — and the keyword would silently disagree.)
describe('CliSession — thinking keyword is a structural no-op (#4306)', () => {
  it('declares thinkingLevel: false in static capabilities', () => {
    assert.equal(CliSession.capabilities.thinkingLevel, false,
      'cli-session has no per-turn thinking budget hook; keyword escalation must remain a no-op')
  })

  it('does not expose setThinkingLevel on session instances', () => {
    const session = createSession()
    assert.equal(typeof session.setThinkingLevel, 'undefined',
      'no setThinkingLevel method means handleSetThinkingLevel returns "not supported" and the keyword cannot escalate either way')
  })
})

describe('CliSession agent tracking', () => {
  it('tracks Task tool as agent_spawned', () => {
    const session = createReadySession()
    session._isBusy = true
    session._messageCounter = 1
    session._currentMessageId = 'msg-1'
    session._currentCtx = {
      hasStreamStarted: false, didStreamText: false,
      currentContentBlockType: null, currentToolName: null,
      currentToolUseId: null, toolInputChunks: '', toolInputBytes: 0, toolInputOverflow: false,
    }

    const spawned = []
    session.on('agent_spawned', (d) => spawned.push(d))

    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Task', id: 'toolu_task1' },
      },
    })

    // Provide description via input_json_delta
    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"description":"Run tests"}' },
      },
    })
    session._handleEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].toolUseId, 'toolu_task1')
    assert.ok(spawned[0].description.includes('Run tests'))
    assert.ok(session._activeAgents.has('toolu_task1'))
  })

  it('truncates agent description to 200 chars', () => {
    const session = createReadySession()
    session._isBusy = true
    session._messageCounter = 1
    session._currentMessageId = 'msg-1'
    session._currentCtx = {
      hasStreamStarted: false, didStreamText: false,
      currentContentBlockType: null, currentToolName: null,
      currentToolUseId: null, toolInputChunks: '', toolInputBytes: 0, toolInputOverflow: false,
    }

    const spawned = []
    session.on('agent_spawned', (d) => spawned.push(d))

    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Task', id: 'toolu_task2' },
      },
    })

    const longDesc = 'x'.repeat(300)
    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ description: longDesc }) },
      },
    })
    session._handleEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    assert.equal(spawned.length, 1)
    assert.ok(spawned[0].description.length <= 200) // truncated to 200 chars
  })
})

describe('CliSession plan mode', () => {
  function setupWithCtx() {
    const session = createReadySession()
    session._isBusy = true
    session._messageCounter = 1
    session._currentMessageId = 'msg-1'
    session._currentCtx = {
      hasStreamStarted: false, didStreamText: false,
      currentContentBlockType: null, currentToolName: null,
      currentToolUseId: null, toolInputChunks: '', toolInputBytes: 0, toolInputOverflow: false,
    }
    return session
  }

  it('detects EnterPlanMode tool', () => {
    const session = setupWithCtx()
    const events = []
    session.on('plan_started', (d) => events.push(d))

    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'EnterPlanMode', id: 'toolu_plan1' },
      },
    })
    session._handleEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    assert.equal(session._inPlanMode, true)
    assert.equal(events.length, 1)
  })

  it('detects ExitPlanMode tool and emits plan_ready on result', () => {
    const session = setupWithCtx()
    session._inPlanMode = true
    const events = []
    session.on('plan_ready', (d) => events.push(d))

    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'ExitPlanMode', id: 'toolu_exit1' },
      },
    })

    const input = JSON.stringify({ allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] })
    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: input },
      },
    })
    session._handleEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    // plan_ready fires when the result event arrives (end of turn)
    assert.equal(events.length, 0)
    assert.ok(session._planAllowedPrompts)

    // Simulate result event
    session._handleEvent({
      type: 'result',
      session_id: 'test-session',
      total_cost_usd: 0.01,
      duration_ms: 1000,
      usage: {},
    })

    assert.equal(events.length, 1)
    assert.ok(events[0].allowedPrompts)
    assert.equal(events[0].allowedPrompts.length, 1)
    assert.equal(session._inPlanMode, false)
  })

  it('resets stale plan mode on interrupt (EnterPlanMode without ExitPlanMode)', () => {
    const session = setupWithCtx()
    const events = []
    session.on('plan_started', (d) => events.push(d))

    // EnterPlanMode fires
    session._handleEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'EnterPlanMode', id: 'toolu_plan2' },
      },
    })
    session._handleEvent({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    })

    assert.equal(session._inPlanMode, true)
    assert.equal(events.length, 1)

    // Simulate interrupt — _clearMessageState called without ExitPlanMode
    session._clearMessageState()

    // Plan mode should be reset (stale — ExitPlanMode never arrived)
    assert.equal(session._inPlanMode, false)
  })
})

describe('#988 — _killAndRespawn extraction', () => {
  it('has _killAndRespawn as a prototype method', () => {
    assert.equal(typeof CliSession.prototype._killAndRespawn, 'function',
      '_killAndRespawn should be extracted as a shared method')
  })

  // #5374 hoisted the busy/no-op guard into BaseSession.setModel/setPermissionMode,
  // which fire the _onModelChanged / _onPermissionModeChanged hooks; CliSession's
  // respawn logic moved into those hooks (it no longer overrides the setters).
  it('_onModelChanged uses _killAndRespawn instead of inline kill logic', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, '../src/cli-session.js'), 'utf-8')
    const setModelBlock = source.match(/_onModelChanged\(\)\s*\{[\s\S]*?^  \}/m)
    assert.ok(setModelBlock, '_onModelChanged hook should exist')
    assert.ok(setModelBlock[0].includes('_killAndRespawn'),
      '_onModelChanged should delegate to _killAndRespawn')
    assert.ok(!setModelBlock[0].includes('forceKillTimer'),
      '_onModelChanged should not contain inline kill logic (forceKillTimer)')
  })

  it('_onPermissionModeChanged uses _killAndRespawn instead of inline kill logic', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, '../src/cli-session.js'), 'utf-8')
    const setPermBlock = source.match(/_onPermissionModeChanged\(mode\)\s*\{[\s\S]*?^  \}/m)
    assert.ok(setPermBlock, '_onPermissionModeChanged hook should exist')
    assert.ok(setPermBlock[0].includes('_killAndRespawn'),
      '_onPermissionModeChanged should delegate to _killAndRespawn')
    assert.ok(!setPermBlock[0].includes('forceKillTimer'),
      '_onPermissionModeChanged should not contain inline kill logic (forceKillTimer)')
  })
})

describe('_killAndRespawn behavioral tests (#1009)', () => {
  it('setModel kills old child and respawns after close', async () => {
    const session = createReadySession({ model: 'sonnet' })
    const oldChild = session._child
    // #6643: null the mock pid so killProcessTree takes its deterministic
    // no-pid fallback (a direct kill) on Windows instead of shelling out to
    // `taskkill /PID <mock>` against a real bystander process on a local run.
    oldChild.pid = null

    // Stub start() to prevent actual process spawning
    let startCalled = false
    session.start = () => { startCalled = true }

    // Trigger model change → _killAndRespawn
    session.setModel('opus')

    // _respawning should be set before kill (not _destroying — that's only for permanent teardown)
    assert.equal(session._respawning, true)
    assert.equal(session._destroying, false)
    assert.equal(session._processReady, false)
    assert.equal(session._child, null, 'Old child should be detached')
    assert.equal(oldChild.kill.mock.calls.length, 1, 'kill() should be called on old child')
    // #6643 — respawn routes through killProcessTree: POSIX still sends a
    // graceful SIGTERM; on Windows the pid-less mock falls back to a direct kill.
    if (!isWindows) assert.equal(oldChild.kill.mock.calls[0].arguments[0], 'SIGTERM')

    // start() not called yet (waiting for close)
    assert.equal(startCalled, false)

    // Simulate old child closing
    oldChild.emit('close', 0)

    // Now start() should have been called
    assert.equal(startCalled, true)
    assert.equal(session._respawning, false)
    assert.equal(session._destroying, false)
    assert.equal(session._respawnCount, 0)
  })

  it('setPermissionMode kills old child and respawns after close', async () => {
    const session = createReadySession({ permissionMode: 'approve' })
    const oldChild = session._child

    let startCalled = false
    session.start = () => { startCalled = true }

    session.setPermissionMode('auto')

    assert.equal(session._respawning, true)
    assert.equal(session._destroying, false)
    assert.equal(session.permissionMode, 'auto')
    assert.equal(oldChild.kill.mock.calls.length, 1)

    oldChild.emit('close', 0)

    assert.equal(startCalled, true)
    assert.equal(session._respawning, false)
    assert.equal(session._destroying, false)
  })

  it('_killAndRespawn clears timers before killing', () => {
    const session = createReadySession({ model: 'sonnet' })
    const oldChild = session._child

    // Set up timers that should be cleared
    session._interruptTimer = setTimeout(() => {}, 100000)
    session._respawnTimer = setTimeout(() => {}, 100000)

    session.start = () => {}
    session.setModel('opus')

    assert.equal(session._interruptTimer, null)
    assert.equal(session._respawnTimer, null)

    // Emit close to clean up the forceKillTimer created by _killAndRespawn
    oldChild.emit('close', 0)
  })

  it('_killAndRespawn starts immediately when no child exists', () => {
    const session = createSession({ model: 'sonnet' })
    session._processReady = true
    session._child = null // no child process

    let startCalled = false
    session.start = () => { startCalled = true }

    session.setModel('opus')

    // Should call start() immediately (no child to kill)
    assert.equal(startCalled, true)
    assert.equal(session._respawning, false)
    assert.equal(session._destroying, false)
  })

  it('setModel ignores change when busy', () => {
    const session = createReadySession({ model: 'sonnet' })
    session._isBusy = true

    let startCalled = false
    session.start = () => { startCalled = true }

    session.setModel('opus')

    // Should be a no-op — model unchanged, no kill
    assert.equal(session.model, 'sonnet')
    assert.equal(session._child.kill.mock.calls.length, 0)
    assert.equal(startCalled, false)
  })

  it('setModel ignores change when model is the same', () => {
    const session = createReadySession({ model: 'claude-sonnet-4-6' })

    let startCalled = false
    session.start = () => { startCalled = true }

    session.setModel('sonnet') // resolves to same full ID

    assert.equal(session._child.kill.mock.calls.length, 0)
    assert.equal(startCalled, false)
  })
})

describe('CliSession._buildChildEnv', () => {
  it('strips ANTHROPIC_API_KEY from child env', () => {
    const savedKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-test-key-12345'
    try {
      const session = createSession()
      const env = session._buildChildEnv()
      assert.equal(env.ANTHROPIC_API_KEY, undefined,
        'ANTHROPIC_API_KEY must be absent from child env')
    } finally {
      if (savedKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = savedKey
      }
    }
  })

  it('always includes CI and CLAUDE_HEADLESS vars', () => {
    const session = createSession()
    const env = session._buildChildEnv()
    assert.equal(env.CI, '1')
    assert.equal(env.CLAUDE_HEADLESS, '1')
    assert.equal(env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING, '1')
  })

  it('includes CHROXY_PORT when port is set', () => {
    const session = createSession({ port: 8765 })
    session._hookManager?.destroy()
    const env = session._buildChildEnv()
    assert.equal(env.CHROXY_PORT, '8765')
  })

  it('omits CHROXY_PORT when port is not set', () => {
    const session = createSession()
    const env = session._buildChildEnv()
    assert.equal(env.CHROXY_PORT, undefined)
  })

  it('sets CHROXY_PERMISSION_MODE from session', () => {
    const session = createSession({ permissionMode: 'auto' })
    const env = session._buildChildEnv()
    assert.equal(env.CHROXY_PERMISSION_MODE, 'auto')
  })

  it('never passes CHROXY_TOKEN (primary API token) to child env', () => {
    const session = createSession({ apiToken: 'tok-abc123' })
    const env = session._buildChildEnv()
    assert.ok(!Object.prototype.hasOwnProperty.call(env, 'CHROXY_TOKEN'),
      'CHROXY_TOKEN must not appear in child env — use CHROXY_HOOK_SECRET instead')
  })

  it('includes CHROXY_HOOK_SECRET when port is set', () => {
    const session = createSession({ port: 8765 })
    session._hookManager?.destroy()
    const env = session._buildChildEnv()
    assert.ok(typeof env.CHROXY_HOOK_SECRET === 'string', 'CHROXY_HOOK_SECRET should be a string')
    assert.ok(env.CHROXY_HOOK_SECRET.length >= 64, 'CHROXY_HOOK_SECRET should be at least 64 hex chars (32 bytes)')
  })

  it('omits CHROXY_HOOK_SECRET when port is not set', () => {
    const session = createSession()
    const env = session._buildChildEnv()
    assert.ok(!Object.prototype.hasOwnProperty.call(env, 'CHROXY_HOOK_SECRET'),
      'CHROXY_HOOK_SECRET should not appear when no port is configured')
  })

  it('CHROXY_HOOK_SECRET matches the session _hookSecret', () => {
    const session = createSession({ port: 8765 })
    session._hookManager?.destroy()
    const env = session._buildChildEnv()
    assert.equal(env.CHROXY_HOOK_SECRET, session._hookSecret)
  })

  it('forwards arbitrary process.env keys to child env', () => {
    const savedVal = process.env.CHROXY_TEST_PASSTHROUGH
    process.env.CHROXY_TEST_PASSTHROUGH = 'passthrough-value'
    try {
      const session = createSession()
      const env = session._buildChildEnv()
      assert.equal(env.CHROXY_TEST_PASSTHROUGH, 'passthrough-value',
        'arbitrary env vars should pass through to child')
    } finally {
      if (savedVal === undefined) {
        delete process.env.CHROXY_TEST_PASSTHROUGH
      } else {
        process.env.CHROXY_TEST_PASSTHROUGH = savedVal
      }
    }
  })
})

// ---------------------------------------------------------------------------
// #3225: `_skillsPrepended` deferral + reset on respawn.
//
// Two behaviours pinned here:
//   1. The flag flips to true ONLY after stdin.write() succeeds. A throwing
//      write must leave it false so the next sendMessage retry re-injects.
//   2. _killAndRespawn() resets the flag — the respawned child is a fresh
//      conversation, and the prepend bucket rides on the FIRST user message
//      of the new process.
// ---------------------------------------------------------------------------

describe('CliSession _skillsPrepended deferral (#3225)', () => {
  it('_killAndRespawn resets _skillsPrepended to false', () => {
    const session = createReadySession({ model: 'sonnet' })
    session._skillsPrepended = true

    // Stub start() so we don't actually respawn a real process.
    session.start = () => {}
    // Bypass setModel guards so we can directly trigger the kill path.
    session._killAndRespawn()

    assert.equal(session._skillsPrepended, false,
      'a respawn produces a fresh conversation; the prepend bucket must ride the next first message')
  })

  it('flag stays falsy when stdin.write throws (skills not committed to wire)', async () => {
    const session = createReadySession()
    // Make stdin.write throw to simulate EPIPE on a dead child.
    session._child.stdin = new Writable({
      write(_chunk, _enc, cb) { cb() }
    })
    session._child.stdin.write = () => {
      throw new Error('EPIPE')
    }

    assert.ok(!session._skillsPrepended, 'starts falsy (uninitialized or false)')

    const errors = []
    session.on('error', (e) => errors.push(e))
    await session.sendMessage('hi')

    assert.ok(!session._skillsPrepended,
      'flag must stay falsy when the write fails — skills text never reached the child')
    assert.ok(errors.length >= 1, 'sendMessage should have surfaced the EPIPE error')
  })
})

// ---------------------------------------------------------------------------
// #3735: mid-turn auto-mode panic-button must kill the in-flight `claude -p`
// process and respawn cleanly.
//
// PR #3730 changed BaseSession.setPermissionMode so that `'auto'` overrides
// the `_isBusy` guard (panic-button semantics, #3729). For SdkSession this is
// covered in sdk-session.test.js; for CliSession the cascade is different —
// the override succeeds AND _killAndRespawn() runs, dropping the in-flight
// turn. The PR description acknowledges this as "destructive but workable";
// this test pins that destructive behavior so a future "skip respawn while
// busy" defensive change can't silently regress the panic button.
// ---------------------------------------------------------------------------
describe('CliSession setPermissionMode panic-button mid-turn (#3735)', () => {
  // #3966: every test in this block stubs `start()` to avoid spawning a real
  // child, but the panic path arms long-fuse soft/hard inactivity timers
  // (`_resultTimeout`, `_hardTimeout`) that would otherwise keep the event
  // loop alive past the test and trip the test runner's leak detector. Track
  // every session we create so the after-hook can clear whatever the panic
  // flow left armed, regardless of which branch the test exercised.
  const sessions = []

  afterEach(() => {
    while (sessions.length > 0) {
      const session = sessions.pop()
      if (session._resultTimeout) {
        clearTimeout(session._resultTimeout)
        session._resultTimeout = null
      }
      if (session._hardTimeout) {
        clearTimeout(session._hardTimeout)
        session._hardTimeout = null
      }
      if (session._interruptTimer) {
        clearTimeout(session._interruptTimer)
        session._interruptTimer = null
      }
      if (session._respawnTimer) {
        clearTimeout(session._respawnTimer)
        session._respawnTimer = null
      }
      session._isBusy = false
    }
  })

  it('mid-turn flip to auto kills the in-flight process and respawns', () => {
    const session = createReadySession({ permissionMode: 'approve' })
    sessions.push(session)
    const oldChild = session._child
    // #6643: null the mock pid so killProcessTree takes its deterministic
    // no-pid fallback on Windows (see the setModel respawn test).
    oldChild.pid = null

    // Simulate the user being mid-turn: claude -p is running, _isBusy=true,
    // a messageId+ctx are set, and the result timer is armed.
    session._isBusy = true
    session._currentMessageId = 'msg-abc-1'
    session._currentCtx = { hasStreamStarted: true, didStreamText: true }
    // #3966: unref the test-armed timers so even if a future bug skips the
    // afterEach cleanup, these long-fuse setTimeouts can't hold the event
    // loop open past test completion.
    session._resultTimeout = setTimeout(() => {}, 100000).unref()
    session._hardTimeout = setTimeout(() => {}, 100000).unref()

    // Stub start() so we don't actually spawn a real claude process after kill.
    let startCalled = 0
    session.start = () => { startCalled++ }

    // Panic-button: flip to auto while busy. BaseSession.setPermissionMode
    // lets 'auto' through despite _isBusy=true, so CliSession should call
    // _killAndRespawn().
    session.setPermissionMode('auto')

    // permissionMode flipped (BaseSession override applied).
    assert.equal(session.permissionMode, 'auto')
    // _killAndRespawn ran: respawning flag set, child detached, SIGTERM sent.
    assert.equal(session._respawning, true)
    assert.equal(session._processReady, false)
    assert.equal(session._child, null, 'old child detached during respawn')
    assert.equal(oldChild.kill.mock.calls.length, 1, 'kill sent to in-flight process')
    // #6643 — see killProcessTree note above; POSIX still uses a graceful SIGTERM.
    if (!isWindows) assert.equal(oldChild.kill.mock.calls[0].arguments[0], 'SIGTERM')

    // start() is deferred until the old child's 'close' event fires.
    assert.equal(startCalled, 0, 'start() waits for old child to close')

    // Simulate the killed claude process exiting — respawn should fire.
    oldChild.emit('close', 143) // 128 + SIGTERM(15)

    assert.equal(startCalled, 1, 'respawn calls start() once after old child closes')
    assert.equal(session._respawning, false, 'respawning flag cleared after restart')
    assert.equal(session._respawnCount, 0, 'respawnCount reset so backoff is fresh')
    assert.equal(session._destroying, false, 'session is NOT destroyed — only the turn died')
  })

  // #3966: explicit contract — the panic kill+respawn flow must release the
  // soft + hard inactivity timers that were armed for the dropped turn.
  // Without this, the timers keep ticking against a stale messageId and
  // either trip `_handleHardTimeout` against a now-irrelevant turn or leak
  // into the next test as a phantom timer.
  it('panic kill+respawn clears the armed soft + hard inactivity timers', () => {
    const session = createReadySession({ permissionMode: 'approve' })
    sessions.push(session)
    const oldChild = session._child

    // Spy on clearTimeout to prove both timer handles get released.
    const cleared = new Set()
    const originalClearTimeout = global.clearTimeout
    global.clearTimeout = (handle) => {
      if (handle) cleared.add(handle)
      return originalClearTimeout(handle)
    }

    try {
      session._isBusy = true
      session._currentMessageId = 'msg-panic-clear'
      session._currentCtx = { hasStreamStarted: true, didStreamText: true }
      const resultHandle = setTimeout(() => {}, 100000).unref()
      const hardHandle = setTimeout(() => {}, 100000).unref()
      session._resultTimeout = resultHandle
      session._hardTimeout = hardHandle

      session.start = () => {}

      session.setPermissionMode('auto')
      oldChild.emit('close', 143)

      // The kill+respawn must release BOTH the soft warning and hard cap so
      // they don't fire against the dropped turn or linger into the next.
      assert.equal(session._resultTimeout, null,
        '_resultTimeout must be nulled after panic kill+respawn')
      assert.equal(session._hardTimeout, null,
        '_hardTimeout must be nulled after panic kill+respawn')
      assert.ok(cleared.has(resultHandle),
        'clearTimeout must be called on the armed _resultTimeout handle')
      assert.ok(cleared.has(hardHandle),
        'clearTimeout must be called on the armed _hardTimeout handle')
    } finally {
      global.clearTimeout = originalClearTimeout
    }
  })

  it('non-auto mode flip while busy is a no-op (does NOT kill the process)', () => {
    // Complement to the panic-button test: prove that the destructive
    // behavior is gated specifically on 'auto'. Flipping to 'plan' or
    // 'acceptEdits' mid-turn must still be rejected by the busy guard so
    // semantics don't change partway through a turn.
    const session = createReadySession({ permissionMode: 'approve' })
    sessions.push(session)
    const oldChild = session._child
    session._isBusy = true

    let startCalled = 0
    session.start = () => { startCalled++ }

    session.setPermissionMode('plan')

    assert.equal(session.permissionMode, 'approve', 'plan flip rejected mid-turn')
    assert.equal(oldChild.kill.mock.calls.length, 0, 'no kill on rejected flip')
    assert.equal(startCalled, 0, 'no respawn on rejected flip')
    assert.equal(session._respawning, false)
  })
})

// ---------------------------------------------------------------------------
// #4700 — Session-state persistence roundtrip.
//
// CliSession does not own a `saveSessionState()` / `restoreSessionState()`
// pair directly — the persistence layer lives on `SessionManager` /
// `SessionStatePersistence`, which serializes session metadata (model,
// permissionMode, sessionId, …) to JSON. The roundtrip tested here is
// the JSON shape contract on each side of that boundary:
//
//   1. Snapshot the session metadata SessionManager would persist.
//   2. JSON-stringify it to a temp `stateFilePath` (atomic write contract).
//   3. Parse it back.
//   4. Reconstruct a fresh CliSession with the restored opts.
//   5. Assert every persisted field round-tripped exactly.
//
// The audit (#4700) flagged this as the missing layer: SessionManager-level
// restore tests already cover the persistence path end-to-end (see
// session-manager.test.js), but a regression on the CLI side — a field
// that survives restore in shape but no longer hydrates into the
// constructor — would only show up in integration tests, not at the
// unit layer.
//
// The corrupt-file + mismatched-id branches mirror the same patterns
// covered in session-manager.test.js for symmetry. The Map-serialization
// branch pins the JSON gotcha that #4687 surfaced for the analogous
// claude-tui-session `_pendingUserAnswers` field: a naive
// `JSON.stringify(new Map(…))` silently emits `{}` and loses every
// entry — the canonical workaround is `[...map.entries()]`. The test
// fails on any future CLI code that tries to persist a Map field
// directly.
// ---------------------------------------------------------------------------

describe('CliSession state-persistence roundtrip (#4700)', () => {
  let tempDir
  let stateFile

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cli-roundtrip-'))
    stateFile = join(tempDir, 'session-state.json')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  // Snapshot the fields SessionManager.serializeState() would write for a
  // CliSession entry. As of #4887, CliSession exposes a `resumeSessionId`
  // getter (mirrored from `_sessionId`) and SessionManager.serializeState
  // persists it under `sdkSessionId` — the cross-provider name for the
  // resume token. The restore path forwards it back into the constructor
  // so the next start() passes `--resume <id>` and the model retains the
  // prior conversation. Keep in sync with session-manager.test.js.
  function snapshotForPersistence(session, { name, cwd }) {
    return {
      name,
      cwd,
      model: session.model,
      permissionMode: session.permissionMode,
      sdkSessionId: session.resumeSessionId,
    }
  }

  it('happy path: create → snapshot → write → read → restore → asserts metadata + resume id round-trip (#4887)', () => {
    // Step 1: build a session with non-default metadata so the restore
    // side has to actually hydrate every field.
    const original = createSession({
      model: 'claude-sonnet-4-6',
      permissionMode: 'auto',
    })
    // Simulate the session having booted and recorded a CLI session id.
    // #4887 — claude CLI supports `--resume`, so we now persist this id
    // under `sdkSessionId` and re-seed it on restore.
    original._sessionId = 'cli-session-abc-123'

    // Step 2: snapshot + write atomically.
    const state = {
      version: 1,
      timestamp: Date.now(),
      sessions: [snapshotForPersistence(original, { name: 'Restored', cwd: '/tmp' })],
    }
    writeFileSync(stateFile, JSON.stringify(state))
    assert.ok(existsSync(stateFile), 'state file must exist after write')

    // Step 3: destroy the original.
    original.destroy()

    // Step 4: read back and reconstruct (mirroring what SessionManager's
    // restoreState does: forward `sdkSessionId` as `resumeSessionId`).
    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.sessions.length, 1)
    const persisted = parsed.sessions[0]

    const restored = createSession({
      model: persisted.model,
      permissionMode: persisted.permissionMode,
      resumeSessionId: persisted.sdkSessionId,
    })

    // Step 5: every persisted field is back, including the resume id so
    // the next start() can pass `--resume` and avoid the #4887 cold-start.
    assert.equal(restored.model, 'claude-sonnet-4-6',
      'model must round-trip — dashboard renders this on the session header')
    assert.equal(restored.permissionMode, 'auto',
      'permissionMode must round-trip — controls every permission-hook prompt')
    assert.equal(persisted.sdkSessionId, 'cli-session-abc-123',
      'claude-cli MUST serialize sdkSessionId now that the provider supports --resume; #4887 depends on this id surviving the disk hop')
    assert.equal(restored._sessionId, 'cli-session-abc-123',
      'restored session must adopt the persisted resume id so start() passes --resume and the model re-attaches to the prior conversation')
    assert.equal(restored.resumeSessionId, 'cli-session-abc-123',
      'getter mirrors _sessionId — same source of truth')

    restored.destroy()
  })

  it('corrupt state file: production restoreState must return null silently, not throw', () => {
    // A truncated / hand-edited / partial-write state file must not take
    // the server down. Pin the PRODUCTION contract: drive the real
    // `SessionStatePersistence.restoreState()` (the entry point
    // `SessionManager.restoreState()` calls — see session-manager.js:1266)
    // and assert it returns `null` without throwing. The internal
    // try/catch in session-state-persistence.js:148-170 swallows the
    // SyntaxError, attempts .bak recovery, and falls back to null when
    // no backup exists — supervisor / dashboard depend on that silent
    // behaviour so a corrupt state file cannot block server boot.
    writeFileSync(stateFile, '{ this is not valid json')

    const persistence = new SessionStatePersistence({ stateFilePath: stateFile })
    let restored
    let threw = null
    try {
      restored = persistence.restoreState()
    } catch (err) {
      threw = err
    }

    assert.equal(threw, null,
      'restoreState() MUST NOT throw on corrupt JSON — supervisor depends on the silent-null contract; ' +
      'a throw here would crash the server on every restart after a partial write')
    assert.equal(restored, null,
      'restoreState() must return null on corrupt JSON so SessionManager treats it as "no prior state" and starts fresh')

    // Secondary assertion documenting the underlying mechanism: the raw
    // JSON.parse used inside restoreState() does throw a SyntaxError —
    // that's why restoreState() wraps it in try/catch. The corrupt file
    // was unlinked by restoreState's recovery path, so we re-write it
    // here to pin the raw behaviour.
    writeFileSync(stateFile, '{ this is not valid json')
    let rawThrew = null
    try { JSON.parse(readFileSync(stateFile, 'utf-8')) } catch (err) { rawThrew = err }
    assert.ok(rawThrew instanceof SyntaxError,
      'raw JSON.parse throws SyntaxError — restoreState() exists specifically to swallow this')

    // The fallback path: instantiate a fresh CliSession with no restored
    // opts. Must succeed — a corrupt state file cannot block new session
    // creation.
    const fresh = createSession()
    assert.equal(fresh._sessionId, null,
      'fresh session after corrupt-file restore must have no CLI session id')
    assert.equal(fresh.permissionMode, 'approve',
      'fresh session must start with the default permission mode — no carryover from corrupt state')
    fresh.destroy()
  })

  it('persisted resume id flows back into the new CliSession constructor (#4887)', () => {
    // #4887 — claude CLI supports `--resume <id>`, so when SessionManager
    // restores a CliSession after a server restart, the persisted
    // `sdkSessionId` MUST be forwarded as `resumeSessionId` and adopted
    // by the new instance. Without this, the next start() omits the
    // `--resume` flag and the model wakes up cold mid-conversation —
    // the regression #4887 was filed for.
    const state = {
      version: 1,
      timestamp: Date.now(),
      sessions: [{
        name: 'Restored',
        cwd: '/tmp',
        model: null,
        permissionMode: 'approve',
        sdkSessionId: 'cli-resume-9999',
      }],
    }
    writeFileSync(stateFile, JSON.stringify(state))

    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'))
    const persisted = parsed.sessions[0]

    const fresh = createSession({
      model: persisted.model,
      permissionMode: persisted.permissionMode,
      resumeSessionId: persisted.sdkSessionId,
    })

    assert.equal(fresh._sessionId, 'cli-resume-9999',
      'CliSession constructor MUST adopt the persisted resume id so start() can pass --resume and recover the prior transcript (#4887)')
    assert.equal(fresh.sessionId, 'cli-resume-9999',
      'public accessor reflects the adopted id')
    assert.equal(fresh.resumeSessionId, 'cli-resume-9999',
      'resumeSessionId getter mirrors _sessionId — single source of truth used by SessionManager.serializeState on the next persist tick')
    assert.equal(CliSession.capabilities.resume, true,
      'capability flag is true now that the provider wires --resume into the spawn argv (#4887)')

    fresh.destroy()
  })

  // #4700 — Map-serialization contract. PR #4687 changed
  // `_pendingUserAnswers` on claude-tui-session.js from a single field to
  // a Map keyed by toolUseId. This test pins the canonical JSON
  // workaround for ANY Map field that a future CliSession (or any
  // BaseSession descendant) might want to persist. The naive write
  // (`JSON.stringify(new Map(…))`) silently emits `{}` and loses every
  // entry — a regression that would not be caught by any existing
  // serialize/restore test because the Map's *type* is lost before the
  // disk hop, so the restored "Map" is an empty `{}` and round-trip
  // assertions pass on shape but fail in semantics.
  it('Map field serialization roundtrip: pins the entries-array contract (#4687 surface)', () => {
    // Build a Map with the same shape as `_pendingUserAnswers`: keyed by
    // tool_use_id, values are per-turn pending entries.
    const pending = new Map()
    pending.set('toolu_first', { questions: [{ question: 'Q1?' }], options: ['A', 'B'] })
    pending.set('toolu_second', { questions: [{ question: 'Q2?' }], options: ['Y', 'N'] })

    // The trap: naive Map serialization loses every entry. This
    // assertion documents the gotcha so a future contributor who writes
    // `JSON.stringify(session._someMap)` sees this test and remembers
    // to convert to an array first.
    assert.equal(JSON.stringify(pending), '{}',
      'NAIVE Map.toJSON is {} — every entry is silently lost. ' +
      'Any persistence of a Map field MUST use [...map.entries()] (see workaround below)')

    // The canonical workaround: serialize as an array of entries so the
    // restore side can feed `new Map(parsed)` and recover every key.
    const serialized = JSON.stringify([...pending.entries()])
    writeFileSync(stateFile, serialized)

    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'))
    const restored = new Map(parsed)

    assert.equal(restored.size, 2,
      'entries-array roundtrip must preserve every key')
    assert.ok(restored.has('toolu_first'),
      'first toolUseId key must survive — sibling pending answers from parallel AskUserQuestion blocks (#4668) depend on this')
    assert.ok(restored.has('toolu_second'),
      'second toolUseId key must survive — the bug #4687 fixed was the single-field overwrite')
    assert.deepEqual(restored.get('toolu_first').questions, [{ question: 'Q1?' }])
    assert.deepEqual(restored.get('toolu_second').options, ['Y', 'N'])

    // Symmetry assertion: the restored Map iterates in the same order
    // as the original. JSON arrays preserve insertion order, so this
    // pins the contract that "most-recent" fallback semantics (see
    // claude-tui-session.js `_lastPendingAnswerToolUseId`) survive a
    // restart.
    assert.deepEqual([...restored.keys()], ['toolu_first', 'toolu_second'],
      'Map insertion order must round-trip so "most-recent" semantics survive a restart')
  })
})

describe('CliSession.resolveAuth — billing class (#5630/#5629)', () => {
  // CliSession.resolveAuth() reads isProgrammaticCreditEra() at call time
  // (no injectable `now` — it always auths via the host pool). Per-era
  // classification is covered deterministically by billing-class.test.js
  // (the pure comparator); here we assert resolveAuth carries a VALID
  // era-gated billingClass + matching detail for the current wall-clock era.
  it('returns a billingClass that is subscription or programmatic-credit (never api-key)', () => {
    const auth = CliSession.resolveAuth()
    assert.ok(auth.billingClass === 'subscription' || auth.billingClass === 'programmatic-credit',
      `claude-cli is host-pool only; got ${auth.billingClass}`)
    assert.notEqual(auth.billingClass, 'api-key')
  })
  it('detail copy matches the billingClass (subscription vs credit pool)', () => {
    const auth = CliSession.resolveAuth()
    if (auth.billingClass === 'programmatic-credit') {
      assert.match(auth.detail, /programmatic credit pool/i)
    } else {
      assert.match(auth.detail, /subscription/i)
    }
    // Both eras keep the strip-before-spawn caveat.
    assert.match(auth.detail, /strips ANTHROPIC_API_KEY/i)
  })
})
