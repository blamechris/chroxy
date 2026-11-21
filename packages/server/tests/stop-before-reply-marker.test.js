import { describe, it, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable, Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BaseSession } from '../src/base-session.js'
import { SdkSession } from '../src/sdk-session.js'
import { CliSession } from '../src/cli-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { SessionManager, withRetainedPermissionOutcomes } from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'
import { sendHistoryEntry } from '../src/ws-history.js'
import { handleSessionMessage } from '../src/ws-message-handlers.js'
import { nsCtx } from './test-helpers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * #9241 -- a Stop the USER presses before the turn produced any assistant output
 * leaves one quiet, replayable marker: a `result` with
 * `turnOutcome: 'stopped_before_output'`. A Stop after output stays unmarked
 * (#8461), and so does a Stop nobody at a keyboard asked for (the scheduler's and
 * orchestration's `interrupt()` never call `markUserStopRequested`).
 */

const MARK = 'stopped_before_output'

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
    s.markUserStopRequested()
    s.emit('stopped', {})
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
    s.markUserStopRequested()
    s.emit('stopped', {})
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
      s.markUserStopRequested()
      s.emit('stopped', {})
      assert.deepEqual(w.order(), ['stopped'])
    })
  }

  it('output that lands BETWEEN the Stop and the abort suppresses the marker (decided at turn end)', () => {
    const { s, w } = baseTurn()
    s.markUserStopRequested()
    s.emit('stream_delta', { messageId: 'm', delta: 'late token' })
    s.emit('stopped', {})
    assert.deepEqual(w.order(), ['stopped'])
  })

  it('a prompt already open when Stop lands counts as output (hook-routed permissions skip emit)', () => {
    const { s, w } = baseTurn()
    s._pendingPermissionIds.add('hook-req')
    s.markUserStopRequested()
    s.emit('stopped', {})
    assert.deepEqual(w.order(), ['stopped'])
  })

  it('a stop nobody at a keyboard asked for (interrupt() without markUserStopRequested) leaves no marker', () => {
    const { s, w } = baseTurn()
    s._noteTurnStopRequested() // what the scheduler's / orchestration's interrupt() does
    s.emit('stopped', {})
    assert.deepEqual(w.order(), ['stopped'])
  })

  it('a double Stop yields one marker', () => {
    const { s, w } = baseTurn()
    s.markUserStopRequested()
    s.markUserStopRequested()
    s.emit('stopped', {})
    s.emit('stopped', {})
    assert.equal(w.markers().length, 1)
  })

  it('a session being destroyed mints nothing', () => {
    const { s, w } = baseTurn()
    s.markUserStopRequested()
    s._destroying = true
    s.emit('stopped', {})
    assert.deepEqual(w.order(), ['stopped'])
  })

  it('a Stop with no turn running is a no-op and does not leak into the next turn', () => {
    const s = new BaseSession()
    s.on('error', () => {})
    const w = watch(s)
    s.markUserStopRequested() // idle
    s._isBusy = true
    s.emit('stopped', {})
    assert.deepEqual(w.order(), ['stopped'], 'the idle Stop armed nothing')
  })

  it('a Stop on a turn that completed normally does not leak into the next turn', () => {
    const { s, w } = baseTurn()
    s.markUserStopRequested()
    s.emit('result', { cost: 0.01, duration: 5 }) // finished on its own
    s._isBusy = false
    s._isBusy = true // next turn
    s.emit('stopped', {}) // a stopped nobody asked for
    assert.equal(w.markers().length, 0)
  })

  it('a Stop that races a normal completion mints nothing after the completed result', () => {
    const { s, w } = baseTurn()
    s.markUserStopRequested()
    s.emit('result', { cost: 0.01, duration: 5 })
    s.emit('stopped', {})
    assert.equal(w.markers().length, 0)
  })

  it('the next turn gets its own marker after one was minted', () => {
    const { s, w } = baseTurn()
    s.markUserStopRequested()
    s.emit('stopped', {})
    s._isBusy = false
    s._isBusy = true
    s.markUserStopRequested()
    s.emit('stopped', {})
    assert.equal(w.markers().length, 2)
  })

  it('a result the provider already minted as stopped (tui, byok) is substituted, not duplicated', () => {
    const { s, w } = baseTurn()
    s._noteTurnStopRequested()
    s.markUserStopRequested()
    s.emit('result', { cost: null, duration: 5, usage: null, turnOutcome: 'stopped', interrupted: true })
    s.emit('stopped', {}) // the quiet ack the strip path already sent, and a late duplicate
    assert.deepEqual(w.order(), [`result:${MARK}`, 'stopped'])
  })

  it('a provider-minted stopped result with output before the Stop stays quiet (#8461)', () => {
    const { s, w } = baseTurn()
    s.emit('stream_delta', { messageId: 'm', delta: 'x' })
    s._noteTurnStopRequested()
    s.markUserStopRequested()
    s.emit('result', { cost: null, duration: 5, usage: null, turnOutcome: 'stopped', interrupted: true })
    assert.deepEqual(w.order(), ['result:-', 'stopped'])
  })

  it('a provider-minted stopped result for a stop nobody at a keyboard asked for is quiet too', () => {
    const { s, w } = baseTurn()
    s._noteTurnStopRequested()
    s.emit('result', { cost: null, duration: 5, usage: null, turnOutcome: 'stopped', interrupted: true })
    assert.equal(w.markers().length, 0)
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
  const userStop = () => { session.markUserStopRequested(); session.interrupt() }
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

  it('the scheduler-style interrupt() (no markUserStopRequested) leaves no marker', async () => {
    const w = await run([init, () => session.interrupt(), abort])
    assert.deepEqual(w.order(), ['stopped'])
  })

  it('a Stop pressed with no query to abort does not leak a marker into the next turn', async () => {
    session.markUserStopRequested() // idle: nothing running
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
    session.markUserStopRequested()
    session._intentionalStop = true
    session._handleChildClose(0)
    assert.deepEqual(w.order(), [`result:${MARK}`, 'stopped'])
    assert.equal(w.markers()[0].interrupted, true)
  })

  it('child exit after output: no marker', () => {
    const session = cliSession()
    const w = watch(session)
    session.emit('stream_delta', { messageId: 'm-1', delta: 'x' })
    session.markUserStopRequested()
    session._intentionalStop = true
    session._handleChildClose(0)
    assert.deepEqual(w.order(), ['result:-', 'stopped'])
  })

  it('the 5 s safety timer path (child ignored SIGINT): one marker, no second one from a later stopped', () => {
    const session = cliSession()
    const w = watch(session)
    session.markUserStopRequested()
    session._emitInterruptedTurnResult(0, 'user_stop')
    session.emit('stopped', {})
    assert.equal(w.markers().length, 1)
  })

  it('an interrupted result nobody at a keyboard asked for (crash, watchdog) leaves no marker', () => {
    const session = cliSession()
    const w = watch(session)
    session._emitInterruptedTurnResult(0, 'process_exit')
    assert.equal(w.markers().length, 0)
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
    turnSession((s) => { s.markUserStopRequested(); s.interrupt() })
    await run()
    assert.deepEqual(w.order(), [`result:${MARK}`, 'stopped'])
    assert.equal(w.markers().length, 1)
  })

  it('a Stop after the model streamed text leaves none', async () => {
    turnSession((s) => {
      s.emit('stream_delta', { messageId: 'm', delta: 'partial' })
      s.markUserStopRequested()
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
    session.interrupt = () => { session.emit('stopped', {}); session._isBusy = false }
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
    ctx.session.markUserStopRequested()
    ctx.session.emit('stopped', {})
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
    ctx.session.markUserStopRequested()
    ctx.session.emit('stopped', {})
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
