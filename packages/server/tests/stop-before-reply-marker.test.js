import { describe, it, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable, Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BaseSession } from '../src/base-session.js'
import { SdkSession } from '../src/sdk-session.js'
import { CliSession } from '../src/cli-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { SessionManager, withRetainedPermissionOutcomes } from '../src/session-manager.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { JsonlSubprocessSession } from '../src/jsonl-subprocess-session.js'
import { createAcpSessionClass } from '../src/acp-session.js'
import * as codexMod from '../src/codex-app-server-session.js'
import * as byokMod from '../src/byok-session.js'
import * as anthropicSdk from '@anthropic-ai/sdk'
import { registerProvider } from '../src/providers.js'
import { sendHistoryEntry } from '../src/ws-history.js'
import { handleSessionMessage } from '../src/ws-message-handlers.js'
import { nsCtx } from './test-helpers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * #9241 -- a Stop that arrives through the `interrupt` message before the turn produced
 * any assistant output leaves one quiet, replayable marker: a `result` with
 * `turnOutcome: 'stopped_before_output'`. A Stop after output stays unmarked
 * (#8461), and so does a Stop nobody at a keyboard asked for (the scheduler's and
 * orchestration's `interrupt()` never call `markStopRequested`), and so does a turn that
 * ended for any reason but the Stop: only a provider's own stop path says `stopRequested`..
 */

const MARK = 'stopped_before_output'
// What a provider's own stop path sends: the explicit word that the turn ended BECAUSE of the Stop.
const STOP = { stopRequested: true }

let _tmp
function tmp() {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'stop-before-reply-'))
  return _tmp
}
after(() => { if (_tmp) rmSync(_tmp, { recursive: true, force: true }) })
let counter = 0
const stateFile = () => join(tmp(), `state-${++counter}.json`)

/** Collect the terminal events a session emits, in order. */
function watch(session) {
  const seen = []
  for (const name of ['result', 'stopped']) session.on(name, (d) => seen.push({ name, data: d }))
  return {
    seen,
    markers: () => seen.filter((e) => e.name === 'result' && e.data?.turnOutcome === MARK).map((e) => e.data),
    order: () => seen.map((e) => (e.name === 'result' ? `result:${e.data?.turnOutcome ?? '-'}` : 'stopped')),
  }
}

function baseTurn() {
  const s = new BaseSession()
  s.on('error', () => {})
  const w = watch(s)
  s._isBusy = true
  return { s, w }
}

describe('BaseSession: when a user Stop leaves the marker (#9241)', () => {
  it('mints one result then stopped for a user Stop with no output', () => {
    const { s, w } = baseTurn()
    s.markStopRequested()
    s.emit('stopped', STOP)
    assert.deepEqual(w.order(), [`result:${MARK}`, 'stopped'])
    const r = w.markers()[0]
    assert.equal(r.cost, null)
    assert.equal(r.interrupted, true)
    assert.equal(typeof r.timestamp, 'number', 'stamped once, so live frame and history agree')
  })

  it('a lone stream_start (claude-tui opens an empty slot) and system messages are not output', () => {
    const { s, w } = baseTurn()
    s.emit('stream_start', { messageId: 'm' })
    s.emit('message', { type: 'system', subtype: 'status', content: 'compacting' })
    s.emit('stream_delta', { messageId: 'm', delta: '' })
    s.emit('turn_state', { active: true })
    s.markStopRequested()
    s.emit('stopped', STOP)
    assert.equal(w.markers().length, 1)
  })

  const OUTPUT = {
    'stream text': ['stream_delta', { messageId: 'm', delta: 'Hel' }],
    'thinking text': ['stream_delta', { messageId: 'm', delta: 'hmm', thinking: true }],
    'a tool start': ['tool_start', { messageId: 'm', toolUseId: 't', tool: 'Bash', input: {} }],
    'an assistant message': ['message', { type: 'response', content: 'hi' }],
    'a question': ['user_question', { toolUseId: 'q', questions: [] }],
    'a permission request': ['permission_request', { requestId: 'p', tool: 'Bash' }],
    'an event nothing classifies (fail-safe)': ['brand_new_event_9241', { x: 1 }],
  }
  for (const [label, [event, payload]] of Object.entries(OUTPUT)) {
    it(`no marker when ${label} came before the Stop`, () => {
      const { s, w } = baseTurn()
      s.emit(event, payload)
      s.markStopRequested()
      s.emit('stopped', STOP)
      assert.deepEqual(w.order(), ['stopped'])
    })
  }

  it('output that lands BETWEEN the Stop and the abort suppresses the marker (decided at turn end)', () => {
    const { s, w } = baseTurn()
    s.markStopRequested()
    s.emit('stream_delta', { messageId: 'm', delta: 'late token' })
    s.emit('stopped', STOP)
    assert.deepEqual(w.order(), ['stopped'])
  })

  it('a prompt already open when Stop lands counts as output (hook-routed permissions skip emit)', () => {
    const { s, w } = baseTurn()
    s._pendingPermissionIds.add('hook-req')
    s.markStopRequested()
    s.emit('stopped', STOP)
    assert.deepEqual(w.order(), ['stopped'])
  })

  it('an interrupt() that did not come through the interrupt message (markStopRequested never called) leaves no marker', () => {
    const { s, w } = baseTurn()
    s._noteTurnStopRequested() // what the scheduler's / orchestration's interrupt() does
    s.emit('stopped', STOP)
    assert.deepEqual(w.order(), ['stopped'])
  })

  it('a double Stop yields one marker', () => {
    const { s, w } = baseTurn()
    s.markStopRequested()
    s.markStopRequested()
    s.emit('stopped', STOP)
    s.emit('stopped', STOP)
    assert.equal(w.markers().length, 1)
  })

  it('a session being destroyed mints nothing', () => {
    const { s, w } = baseTurn()
    s.markStopRequested()
    s._destroying = true
    s.emit('stopped', STOP)
    assert.deepEqual(w.order(), ['stopped'])
  })

  it('a Stop with no turn running is a no-op and does not leak into the next turn', () => {
    const s = new BaseSession()
    s.on('error', () => {})
    const w = watch(s)
    s.markStopRequested() // idle
    s._isBusy = true
    s.emit('stopped', STOP)
    assert.deepEqual(w.order(), ['stopped'], 'the idle Stop armed nothing')
  })

  it('a Stop on a turn that completed normally does not leak into the next turn', () => {
    const { s, w } = baseTurn()
    s.markStopRequested()
    s.emit('result', { cost: 0.01, duration: 5 }) // finished on its own
    s._isBusy = false
    s._isBusy = true // next turn
    s.emit('stopped', STOP) // a stopped nobody asked for
    assert.equal(w.markers().length, 0)
  })

  it('a Stop that races a normal completion mints nothing after the completed result', () => {
    const { s, w } = baseTurn()
    s.markStopRequested()
    s.emit('result', { cost: 0.01, duration: 5 })
    s.emit('stopped', STOP)
    assert.equal(w.markers().length, 0)
  })

  it('the next turn gets its own marker after one was minted', () => {
    const { s, w } = baseTurn()
    s.markStopRequested()
    s.emit('stopped', STOP)
    s._isBusy = false
    s._isBusy = true
    s.markStopRequested()
    s.emit('stopped', STOP)
    assert.equal(w.markers().length, 2)
  })

  it('a result the provider minted as stopped AND flagged as the Stop is substituted, not duplicated', () => {
    const { s, w } = baseTurn()
    s._noteTurnStopRequested()
    s.markStopRequested()
    s.emit('result', { cost: null, duration: 5, usage: null, turnOutcome: 'stopped', interrupted: true, stopRequested: true })
    s.emit('stopped', STOP) // the quiet ack the strip path already sent, and a late duplicate
    assert.deepEqual(w.order(), [`result:${MARK}`, 'stopped'])
  })

  it('the strip path ALONE no longer mints: a stopped result without stopRequested (e.g. an error that raced the abort) stays quiet', () => {
    const { s, w } = baseTurn()
    s._noteTurnStopRequested()
    s.markStopRequested()
    s.emit('result', { cost: null, duration: 5, usage: null, turnOutcome: 'stopped', interrupted: true })
    assert.deepEqual(w.order(), ['result:-', 'stopped'], 'chip stripped and acknowledged as before, no marker')
  })

  it('a provider-minted stopped result with output before the Stop stays quiet (#8461)', () => {
    const { s, w } = baseTurn()
    s.emit('stream_delta', { messageId: 'm', delta: 'x' })
    s._noteTurnStopRequested()
    s.markStopRequested()
    s.emit('result', { cost: null, duration: 5, usage: null, turnOutcome: 'stopped', interrupted: true, stopRequested: true })
    assert.deepEqual(w.order(), ['result:-', 'stopped'])
  })

  it('a provider-minted stopped result for an interrupt() that did not come through the message is quiet too', () => {
    const { s, w } = baseTurn()
    s._noteTurnStopRequested()
    s.emit('result', { cost: null, duration: 5, usage: null, turnOutcome: 'stopped', interrupted: true })
    assert.equal(w.markers().length, 0)
  })
})

describe('BaseSession: the provider must say the turn ended because of the Stop (#9241)', () => {
  it('a plain `stopped` with no stopRequested word mints nothing, whatever armed it (fail-safe)', () => {
    const { s, w } = baseTurn()
    s.markStopRequested()
    s.emit('stopped', {})
    assert.deepEqual(w.order(), ['stopped'])
  })

  it('an outcome-less interrupted result with no stopRequested word (a watchdog) mints nothing', () => {
    const { s, w } = baseTurn()
    s.markStopRequested()
    s.emit('result', { cost: null, duration: 1, usage: null, interrupted: true })
    s.emit('stopped', STOP) // the child that then closes
    assert.equal(w.markers().length, 0)
  })

  it('stopRequested is internal: it never reaches a listener on the result or the stopped event', () => {
    const { s, w } = baseTurn()
    s.markStopRequested()
    s.emit('stopped', { ...STOP, code: 0 })
    for (const e of w.seen) assert.equal('stopRequested' in e.data, false, e.name)
    const s2 = new BaseSession()
    s2.on('error', () => {})
    const w2 = watch(s2)
    s2._isBusy = true
    s2.markStopRequested()
    s2.emit('result', { cost: null, duration: 1, usage: null, interrupted: true, stopRequested: true })
    assert.equal(w2.markers().length, 1)
    assert.equal('stopRequested' in w2.seen[0].data, false)
  })

  it('an error after the Stop is output: the stopped that follows mints nothing', () => {
    const { s, w } = baseTurn()
    s.markStopRequested()
    s.emit('error', { message: 'Stream stalled' })
    s.emit('stopped', STOP)
    assert.equal(w.markers().length, 0)
  })

  it('the raw PTY mirror and a resize are the screen, not a reply: they do not suppress the marker', () => {
    const { s, w } = baseTurn()
    s.emit('terminal_output', { data: '> hello\r\n' })
    s.emit('terminal_resize', { cols: 100, rows: 30 })
    s.markStopRequested()
    s.emit('stopped', STOP)
    assert.equal(w.markers().length, 1)
  })

  it('a hook-routed prompt that was answered BEFORE the Stop still counts as output', () => {
    const { s, w } = baseTurn()
    s.notifyPermissionPending('hook-req-1')
    s.notifyPermissionResolved('hook-req-1')
    assert.equal(s.getPendingPermissionCount(), 0, 'premise: nothing is pending at Stop time')
    s.markStopRequested()
    s.emit('stopped', STOP)
    assert.deepEqual(w.order(), ['stopped'])
  })

  it('the neutral wording does not care who sent the interrupt: an agent-control-style client mints the same marker', async () => {
    // chroxy_interrupt_session sends the same `interrupt` frame over a bearer-authenticated,
    // non-principal connection. No client classification: it takes the same handler path.
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 3, stateFilePath: stateFile() })
    const session = new BaseSession()
    session.on('error', () => {})
    session.interrupt = () => { session.emit('stopped', STOP); session._isBusy = false }
    mgr._sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
    mgr._wireSessionEvents('s1', session)
    const ctx = nsCtx({
      sessionManager: { getSession: (id) => mgr.getSession(id), recordUserInterrupt: (id) => mgr.recordUserInterrupt(id), getHistoryCount: () => 0, listSessions: () => [] },
      send: mock.fn(), broadcast: mock.fn(), broadcastToSession: mock.fn(),
      permissionSessionMap: new Map(), questionSessionMap: new Map(), pendingPermissions: new Map(), clients: new Map(),
    })
    const agentClient = { id: 'agent-1', activeSessionId: 's1', authKind: 'bearer', isAgentControl: true }
    session._isBusy = true
    await handleSessionMessage({}, agentClient, { type: 'interrupt', sessionId: 's1' }, ctx)
    assert.equal(mgr.getHistory('s1').filter((e) => e.type === 'result' && e.turnOutcome === MARK).length, 1)
  })
})

describe('claude-sdk (#9241)', () => {
  let session
  beforeEach(() => {
    session = new SdkSession({ cwd: '/tmp', stateFilePath: stateFile() })
    session._fetchSupportedModels = () => {}
  })
  afterEach(() => { session.destroy() })

  const init = { type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'claude-x', tools: [] }
  const abortedResult = {
    type: 'result', subtype: 'error_during_execution', session_id: 'sdk-1', is_error: true,
    terminal_reason: 'aborted_streaming', duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage: {},
  }
  function fakeQuery(script) {
    const gen = (async function* () {
      for (const step of script) {
        if (typeof step === 'function') { await step(); continue }
        yield step
      }
    })()
    return { [Symbol.asyncIterator]() { return gen }, interrupt: async () => {}, close: () => {}, stopTask: async () => {} }
  }
  async function run(script) {
    session._callQuery = () => fakeQuery(script)
    const w = watch(session)
    await session.sendMessage('go')
    return w
  }
  const userStop = () => { session.markStopRequested(); session.interrupt() }
  const abort = () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }) }

  it('an abort that mints NO result (the catch branch) leaves exactly one marker, then stopped', async () => {
    const w = await run([init, userStop, abort])
    assert.deepEqual(w.order(), [`result:${MARK}`, 'stopped'])
  })

  it('a normal result carrying aborted_* is substituted for the marker; one stopped follows', async () => {
    const w = await run([init, userStop, abortedResult])
    assert.deepEqual(w.order(), [`result:${MARK}`, 'stopped'])
  })

  it('a Stop after assistant output renders nothing (#8461)', async () => {
    session._callQuery = () => fakeQuery([init, () => session.emit('stream_delta', { messageId: 'm', delta: 'hi' }), userStop, abort])
    const w = watch(session)
    await session.sendMessage('go')
    assert.deepEqual(w.order(), ['stopped'])
  })

  it('the scheduler-style interrupt() (no markStopRequested) leaves no marker', async () => {
    const w = await run([init, () => session.interrupt(), abort])
    assert.deepEqual(w.order(), ['stopped'])
  })

  it('an error that is not the abort, landing after the Stop, leaves no marker', async () => {
    const w = await run([init, userStop, () => { throw new Error('upstream exploded') }])
    assert.equal(w.markers().length, 0)
  })

  it('a Stop pressed with no query to abort does not leak a marker into the next turn', async () => {
    session.markStopRequested() // idle: nothing running
    const w = await run([init, abortedResult]) // an abort nobody asked for
    assert.deepEqual(w.order(), ['result:stopped'])
  })
})

describe('claude-cli: ordering (#9241)', () => {
  function cliSession() {
    const session = new CliSession({ cwd: '/tmp' })
    session._processReady = true
    const child = new EventEmitter()
    child.stdin = new Writable({ write(_c, _e, cb) { cb() } })
    child.stdout = new Readable({ read() {} })
    child.stderr = new Readable({ read() {} })
    child.pid = 12345
    child.kill = () => {}
    child.killed = false
    session._child = child
    session.on('error', () => {})
    session._isBusy = true
    session._currentMessageId = 'm-1'
    return session
  }

  it('child exit after a user Stop: ONE marker, on the interrupted result (message state is cleared first), then stopped', () => {
    const session = cliSession()
    const w = watch(session)
    session.markStopRequested()
    session._intentionalStop = true
    session._handleChildClose(0)
    assert.deepEqual(w.order(), [`result:${MARK}`, 'stopped'])
    assert.equal(w.markers()[0].interrupted, true)
  })

  it('child exit after output: no marker', () => {
    const session = cliSession()
    const w = watch(session)
    session.emit('stream_delta', { messageId: 'm-1', delta: 'x' })
    session.markStopRequested()
    session._intentionalStop = true
    session._handleChildClose(0)
    assert.deepEqual(w.order(), ['result:-', 'stopped'])
  })

  it('the REAL 5 s safety timer (child ignored SIGINT) carries no stop signal: no marker, and a child that closes later cannot mint one after the fact', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const session = cliSession()
    const w = watch(session)
    session.markStopRequested()
    session.interrupt()
    t.mock.timers.tick(5000)
    assert.equal(w.markers().length, 0, 'the child may still be running: this is not the Stop certified')
    assert.deepEqual(w.order(), ['result:-'], 'the turn is ended, unmarked')
    session._handleChildClose(0) // the child finally goes, flagged intentional
    assert.equal(w.markers().length, 0, 'the settled latch does not let a late close mint')
  })

  it('a late child answer after the safety timer is accepted as ordinary output, not a second marker', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const session = cliSession()
    const w = watch(session)
    session.markStopRequested()
    session.interrupt()
    t.mock.timers.tick(5000)
    session.emit('stream_delta', { messageId: 'm-1', delta: 'I kept running after SIGINT.' })
    assert.equal(w.markers().length, 0)
  })

  it('an interrupted result nobody at a keyboard asked for (crash, watchdog) leaves no marker', () => {
    const session = cliSession()
    const w = watch(session)
    session._emitInterruptedTurnResult(0, 'process_exit')
    assert.equal(w.markers().length, 0)
  })

  it('the stall watchdog firing after a Stop is a failure, not a Stop: no marker, then the error', () => {
    const session = cliSession()
    const w = watch(session)
    const errors = []
    session.on('error', (e) => errors.push(e))
    session.markStopRequested()
    session._emitInterruptedTurnResult(0, 'stream_stall') // the watchdog's own result shape
    session.emit('error', { message: 'Claude stopped responding' })
    session._intentionalStop = true
    session._handleChildClose(0) // the child the watchdog killed, still flagged as stopped
    assert.equal(w.markers().length, 0)
    assert.equal(errors.length, 1)
  })
})

describe('claude-tui: a provider that mints its own stopped result (#9241)', () => {
  let skillsDir
  let sinkBase
  let session
  let w

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-9241-skills-'))
    sinkBase = mkdtempSync(join(tmpdir(), 'chroxy-tui-9241-sink-'))
  })
  afterEach(async () => {
    mock.timers.reset()
    if (session) { try { await session.destroy() } catch { /* ignore */ } session = null }
    rmSync(skillsDir, { recursive: true, force: true })
    rmSync(sinkBase, { recursive: true, force: true })
  })

  function turnSession(onWrite) {
    const loginProbeRunner = async () => ({ status: 0, stdout: '{"loggedIn":true}', stderr: '' })
    session = new ClaudeTuiSession({
      cwd: '/tmp', skillsDir, repoSkillsDir: null, loginProbeRunner, resultTimeoutMs: 5000, hardTimeoutMs: 5000,
    })
    session._processReady = true
    session._sessionId = 'sess-9241'
    session._sinkDir = join(sinkBase, 's-test')
    mkdirSync(session._sinkDir, { recursive: true, mode: 0o700 })
    session._waitForPrompt = async () => true
    session._writePtyTextThrottled = async () => { onWrite(session); return true }
    session._term = { write: () => {}, kill: () => {}, pid: 4242 }
    session.on('error', () => {})
    w = watch(session)
    return session
  }
  async function run() {
    mock.timers.reset()
    return session.sendMessage('hello')
  }

  it('the turn start opens an empty stream slot; a user Stop before any text leaves one marker', async () => {
    turnSession((s) => { s.markStopRequested(); s.interrupt() })
    await run()
    assert.deepEqual(w.order(), [`result:${MARK}`, 'stopped'])
    assert.equal(w.markers().length, 1)
  })

  it('the PTY mirror (prompt echo) and a resize at turn start are the screen: the Stop still leaves the marker', async () => {
    turnSession((s) => {
      s.emit('terminal_output', { data: '> hello\r\n' })
      s.emit('terminal_resize', { cols: 100, rows: 30 })
      s.markStopRequested()
      s.interrupt()
    })
    await run()
    assert.equal(w.markers().length, 1)
  })

  // The first assistant line on the screen (Claude Code prints U+23FA before assistant text
  // and tool lines) is the only early sign of a text-only reply: no PreToolUse hook fires and
  // the text reaches emit() at the Stop hook. These drive the REAL PTY byte path
  // (_appendToOutputTail) after the prompt write, then a real Stop.
  describe('assistant text on the screen counts as output (the glyph watch)', () => {
    const stopAfter = (chunks, { afterMs = 100 } = {}) => (s) => {
      setTimeout(() => {
        for (const c of chunks) s._appendToOutputTail(c)
        s.markStopRequested()
        s.interrupt()
      }, afterMs)
    }

    it('a text-only reply streaming in the terminal, then Stop: NO marker (the Codex reproduction)', async () => {
      turnSession((s) => stopAfter(['\u23FA Here is the first part of my reply.\r\n'])(s))
      await run()
      assert.equal(session._turnOutputSeen, true)
      assert.equal(w.markers().length, 0)
    })

    it('spinner / status chunks and a resize without the glyph stay quiet: the Stop is marked', async () => {
      turnSession((s) => {
        stopAfter(['\u273B Thinking\u2026 (esc to interrupt)', '> hello', '\u001b[2K\u001b[1G'])(s)
        setTimeout(() => s.emit('terminal_resize', { cols: 100, rows: 30 }), 50)
      })
      await run()
      assert.equal(w.markers().length, 1)
    })

    it('the glyph arriving in a LATER chunk still counts', async () => {
      turnSession((s) => stopAfter(['\u273B Thinking\u2026', '\u001b[1m\u23FA\u001b[0m Hello'])(s))
      await run()
      assert.equal(w.markers().length, 0)
    })

    it('a glyph in the echo of the prompt itself (before the write finished) does not count', async () => {
      turnSession((s) => {
        s._appendToOutputTail('> please explain \u23FA\r\n') // typed during the write: not armed yet
        stopAfter(['\u273B Thinking\u2026'])(s)
      })
      await run()
      assert.equal(w.markers().length, 1)
    })
  })

  it('a Stop after the model streamed text leaves none', async () => {
    turnSession((s) => {
      s.emit('stream_delta', { messageId: 'm', delta: 'partial' })
      s.markStopRequested()
      s.interrupt()
    })
    await run()
    assert.equal(w.markers().length, 0)
    assert.deepEqual(w.order(), ['result:-', 'stopped'])
  })

  it('interrupt() alone (scheduler) leaves none', async () => {
    turnSession((s) => { s.interrupt() })
    await run()
    assert.equal(w.markers().length, 0)
  })
})

// ---- the handler seam: only handleInterrupt arms the marker -------------------

describe('the interrupt handler arms the marker (#9241)', () => {
  function rig() {
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 3, stateFilePath: stateFile() })
    const session = new BaseSession()
    session.on('error', () => {})
    session.interrupt = () => { session.emit('stopped', STOP); session._isBusy = false }
    mgr._sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
    mgr._wireSessionEvents('s1', session)
    const ctx = nsCtx({
      sessionManager: {
        getSession: (id) => mgr.getSession(id),
        recordUserInterrupt: (id) => mgr.recordUserInterrupt(id),
        getHistoryCount: () => 0,
        listSessions: () => [],
      },
      send: mock.fn(),
      broadcast: mock.fn(),
      broadcastToSession: mock.fn(),
      permissionSessionMap: new Map(),
      questionSessionMap: new Map(),
      pendingPermissions: new Map(),
      clients: new Map(),
    })
    return { mgr, session, ctx, client: { id: 'c1', activeSessionId: 's1' } }
  }
  const stop = (r) => handleSessionMessage({}, r.client, { type: 'interrupt' }, r.ctx)
  const marks = (r) => r.mgr.getHistory('s1').filter((e) => e.type === 'result' && e.turnOutcome === MARK)

  it('a user interrupt message before any output records the marker', async () => {
    const r = rig()
    r.session._isBusy = true
    await stop(r)
    assert.equal(marks(r).length, 1)
  })

  it('a user interrupt message after output records none', async () => {
    const r = rig()
    r.session._isBusy = true
    r.session.emit('stream_delta', { messageId: 'm', delta: 'x' })
    await stop(r)
    assert.equal(marks(r).length, 0)
  })

  it('CONTROL: the same interrupt() without the handler (scheduler / orchestration) records none', () => {
    const r = rig()
    r.session._isBusy = true
    r.session.interrupt()
    assert.equal(marks(r).length, 0)
  })
})

// ---- history: recorded, replayed, restored, rebuilt --------------------------------

class FakeStopSession extends BaseSession {
  static get capabilities() { return {} }
  constructor(opts = {}) { super({ cwd: '/tmp', ...opts }) }
  start() { this._processReady = true }
  interrupt() {}
  destroy() { super.destroy?.() }
  setModel() {}
  setPermissionMode() {}
  sendMessage() { this._isBusy = true }
}
declareUnknownCustomization(FakeStopSession)
registerProvider('fake-stop-9241', FakeStopSession)

describe('the marker is replayable history (#9241)', () => {
  const managers = []
  afterEach(() => { for (const m of managers.splice(0)) m.destroyAll() })

  function boot() {
    const stateFilePath = stateFile()
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath })
    managers.push(mgr)
    const sid = mgr.createSession({ cwd: '/tmp', provider: 'fake-stop-9241' })
    return { mgr, sid, stateFilePath, session: mgr._sessions.get(sid).session }
  }
  const markers = (mgr, sid) => mgr.getHistory(sid).filter((e) => e.type === 'result' && e.turnOutcome === MARK)

  function stopBeforeReply(ctx) {
    ctx.mgr.recordUserInput(ctx.sid, 'go', 'm-go')
    ctx.session.sendMessage('go')
    ctx.session.markStopRequested()
    ctx.session.emit('stopped', STOP)
    ctx.session._isBusy = false
  }

  it('records one marker in history and replays it as a result frame flagged replayed with a seq', () => {
    const ctx = boot()
    stopBeforeReply(ctx)
    const [entry] = markers(ctx.mgr, ctx.sid)
    assert.ok(entry, 'recorded')
    assert.equal(typeof entry._seq, 'number')
    const frames = []
    sendHistoryEntry((_ws, p) => frames.push(p), null, ctx.sid, entry, null)
    const f = frames.find((p) => p.type === 'result')
    assert.equal(f.turnOutcome, MARK)
    assert.equal(f.replayed, true)
    assert.equal(f.historySeq, entry._seq)
    assert.equal(f.timestamp, entry.timestamp)
  })

  it('survives a restart from the state file exactly once', () => {
    const ctx = boot()
    stopBeforeReply(ctx)
    ctx.mgr._flushPersist()
    const mgr = new SessionManager({ skipPreflight: true, maxSessions: 5, defaultCwd: '/tmp', stateFilePath: ctx.stateFilePath })
    managers.push(mgr)
    const sid = mgr.restoreState()
    assert.ok(sid)
    assert.equal(markers(mgr, sid).length, 1)
  })

  it('a Stop after output records no marker', () => {
    const ctx = boot()
    ctx.mgr.recordUserInput(ctx.sid, 'go', 'm-go')
    ctx.session.sendMessage('go')
    ctx.session.emit('stream_delta', { messageId: 'm', delta: 'hi' })
    ctx.session.markStopRequested()
    ctx.session.emit('stopped', STOP)
    assert.equal(markers(ctx.mgr, ctx.sid).length, 0)
  })

  it('a JSONL full-history rebuild folds the marker back in, once, in timestamp order', () => {
    const transcript = [
      { type: 'message', messageType: 'user_input', content: 'q', timestamp: 100 },
    ]
    const ring = [
      { type: 'result', turnOutcome: MARK, timestamp: 150, _seq: 7 },
      { type: 'result', turnOutcome: MARK, timestamp: 150, _seq: 8 },
    ]
    const merged = withRetainedPermissionOutcomes(transcript, ring, false)
    assert.deepEqual(merged.map((e) => e.turnOutcome ?? e.messageType), ['user_input', MARK])
    assert.equal(merged[1]._seq, undefined)
  })
})

// ---- providers whose stop path is not a `result` --------------------------------------

describe('codex app-server: turn/completed {interrupted} is its stop path (#9241)', () => {
  const { CodexAppServerSession } = codexMod
  let cleanups = []
  afterEach(() => { for (const c of cleanups.splice(0)) c() })
  function codex() {
    const sk = mkdtempSync(join(tmpdir(), 'chroxy-cas-9241-'))
    cleanups.push(() => rmSync(sk, { recursive: true, force: true }))
    const s = new CodexAppServerSession({ cwd: '/tmp', skillsDir: sk, repoSkillsDir: null })
    s.on('error', () => {})
    const w = watch(s)
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    return { s, w }
  }
  const done = (s, status) => s._onNotification({ method: 'turn/completed', params: { turn: { id: 't1', status, durationMs: 1 } } })

  it('a Stop before output, answered by turn/completed{interrupted}: one marker, no chip, one stopped', async () => {
    const { s, w } = codex()
    s.markStopRequested()
    await s.interrupt()
    done(s, 'interrupted')
    assert.deepEqual(w.order(), [`result:${MARK}`, 'stopped'])
  })

  it('a Stop after output stays quiet (#8461): no outcome on the result, one stopped', async () => {
    const { s, w } = codex()
    s.emit('stream_delta', { messageId: 'm1', delta: 'partial' })
    s.markStopRequested()
    await s.interrupt()
    done(s, 'interrupted')
    assert.deepEqual(w.order(), ['result:-', 'stopped'])
  })

  it('a scheduler-style interrupt() (no markStopRequested) leaves no marker and no chip', async () => {
    const { s, w } = codex()
    await s.interrupt()
    done(s, 'interrupted')
    assert.deepEqual(w.order(), ['result:-', 'stopped'])
  })

  it('a turn that completed normally while a Stop was armed leaves nothing', async () => {
    const { s, w } = codex()
    s.markStopRequested()
    await s.interrupt()
    done(s, 'completed')
    assert.equal(w.markers().length, 0)
  })

  it('a timeout / failure converted to `stopped` while the Stop is armed is not a Stop', async () => {
    const { s, w } = codex()
    s.markStopRequested()
    await s.interrupt()
    s._failTurn('result timeout')
    assert.deepEqual(w.order(), ['stopped'])
  })
})

describe('acp: only a `cancelled` prompt resolution is a Stop (#9241)', () => {
  const cleanups = []
  afterEach(() => { for (const c of cleanups.splice(0)) c() })
  // The real interrupt() and _finishTurn(); only the transport is a stub (a connection
  // whose notify() records the session/cancel).
  function acp() {
    const sk = mkdtempSync(join(tmpdir(), 'chroxy-acp-9241-'))
    cleanups.push(() => rmSync(sk, { recursive: true, force: true }))
    const Klass = createAcpSessionClass({
      id: `fake-acp-9241-${Date.now()}-${Math.random().toString(36).slice(2)}`, label: 'Fake', command: process.execPath, args: [], env: {},
    })
    const s = new Klass({ cwd: tmpdir(), skillsDir: sk, repoSkillsDir: null, resultTimeoutMs: 5000 })
    const cancels = []
    s._connection = { agent: { notify: async (method) => { cancels.push(method) } } }
    s._sessionId = 'acp-sess'
    s.on('error', () => {})
    const w = watch(s)
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', didStreamStart: false }
    return { s, w, cancels }
  }

  it('a Stop answered with `cancelled`: session/cancel sent, one marker, then stopped', async () => {
    const { s, w, cancels } = acp()
    s.markStopRequested()
    await s.interrupt()
    assert.equal(cancels.length, 1, 'the real interrupt() notified the agent')
    s._finishTurn({ stopReason: 'cancelled' })
    assert.deepEqual(w.order(), [`result:${MARK}`, 'stopped'])
  })

  for (const stopReason of ['max_tokens', 'refusal', 'end_turn']) {
    it(`a Stop that lost the race to a \`${stopReason}\` is not a Stop: no marker`, async () => {
      const { s, w } = acp()
      s.markStopRequested()
      await s.interrupt()
      s._finishTurn({ stopReason })
      assert.equal(w.markers().length, 0)
    })
  }

  it('a timeout / failure converted to `stopped` while the Stop is armed mints nothing', async () => {
    const { s, w } = acp()
    s.markStopRequested()
    await s.interrupt()
    s._failTurn('result timeout')
    assert.deepEqual(w.order(), ['stopped'])
  })
})

describe('claude-byok: only an abort is the Stop (#9241)', () => {
  const { ClaudeByokSession } = byokMod
  const { APIUserAbortError } = anthropicSdk
  function byok(failWith) {
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    session.setPermissionMode('auto')
    session._client = {
      messages: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            // The Stop lands before the model has produced anything, then the stream rejects.
            session.markStopRequested()
            session.interrupt()
            throw failWith()
            // eslint-disable-next-line no-unreachable
            yield undefined
          },
          async finalMessage() { throw failWith() },
        }),
      },
    }
    session.on('error', () => {})
    return session
  }

  it('a genuine abort before any output: one marker, then stopped', async () => {
    const session = byok(() => new APIUserAbortError({ message: 'Request was aborted.' }))
    const w = watch(session)
    await session.start()
    await session.sendMessage('go')
    assert.deepEqual(w.order(), [`result:${MARK}`, 'stopped'])
    await session.destroy()
  })

  it('an upstream HTTP 500 racing the Stop is NOT the Stop: no marker', async () => {
    const session = byok(() => Object.assign(new Error('500 upstream exploded'), { status: 500 }))
    const w = watch(session)
    await session.start()
    await session.sendMessage('go')
    assert.equal(w.markers().length, 0)
    await session.destroy()
  })

  it('a Stop after the model streamed text stays quiet (#8461)', async () => {
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    session.setPermissionMode('auto')
    session._client = {
      messages: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half a rep' } }
            session.markStopRequested()
            session.interrupt()
            throw new APIUserAbortError({ message: 'Request was aborted.' })
          },
          async finalMessage() { throw new APIUserAbortError({ message: 'Request was aborted.' }) },
        }),
      },
    }
    session.on('error', () => {})
    const w = watch(session)
    await session.start()
    await session.sendMessage('go')
    assert.equal(w.markers().length, 0)
    await session.destroy()
  })
})

describe('jsonl subprocess (gemini, legacy codex): ONE terminal result for a silent Stop (#9241)', () => {
  const shim = () => {
    const p = join(tmp(), `jsonl-shim-${++counter}.mjs`)
    writeFileSync(p, '#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 20000)\n')
    chmodSync(p, 0o755)
    return p
  }

  it('through the real close callback and the history recorder: marker, stopped, and no fallback result', async () => {
    const shimPath = shim()
    class P extends JsonlSubprocessSession {
      static get binaryCandidates() { return [process.execPath] }
      static get resolvedBinary() { return process.execPath }
      static get apiKeyEnv() { return 'TEST_API_KEY' }
      static get providerName() { return 'fake' }
      static get displayLabel() { return 'Fake' }
      static get messageIdPrefix() { return 'fake' }
      _buildArgs(text) { return [shimPath, text] }
      _buildChildEnv() { return process.env }
      _processJsonlLine() {}
    }
    const savedKey = process.env.TEST_API_KEY
    process.env.TEST_API_KEY = 'value'
    const s = new P({ cwd: '/tmp' })
    try {
      s._processReady = true
      s.on('error', () => {})
      const w = watch(s)
      const history = new SessionMessageHistory({ maxHistory: 50 })
      s.on('result', (r) => history.recordHistory('s1', 'result', r))
      await s.sendMessage('go')
      s.markStopRequested()
      s.interrupt()
      const deadline = Date.now() + 10000
      while (!w.seen.some((e) => e.name === 'stopped') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      await new Promise((r) => setTimeout(r, 50))
      assert.deepEqual(w.order(), [`result:${MARK}`, 'stopped'], 'one result, then stopped')
      const results = history.getHistory('s1').filter((e) => e.type === 'result')
      assert.equal(results.length, 1, 'one terminal result in history')
      assert.equal(results[0].turnOutcome, MARK)
    } finally {
      s.destroy()
      if (savedKey === undefined) delete process.env.TEST_API_KEY
      else process.env.TEST_API_KEY = savedKey
    }
  })
})
