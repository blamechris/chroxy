import { describe, it, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setupForwarding } from '../src/ws-forwarding.js'
import { EventNormalizer } from '../src/event-normalizer.js'
import { SdkSession } from '../src/sdk-session.js'
import { JsonlSubprocessSession } from '../src/jsonl-subprocess-session.js'
import { waitFor } from './test-helpers.js'

// #8502 (F1 of the #8500 delta review). A turn that ends with a `result` sent a
// `session_list` that still said `isBusy: true` for that session: claude-sdk
// emits `result` and only then clears busy (_clearMessageState), and the
// forwarder built the list synchronously inside the emit. `agent_idle` reaches
// viewers only, so a client that was NOT viewing the session (another dashboard
// tab, the mobile session list) re-derived the session as busy from that list
// and kept it that way.
//
// These drive a REAL SdkSession (fake query) through the REAL forwarder and the
// REAL normalizer, with a `listSessions` that reads the live `session.isRunning`
// exactly as session-manager.js does, and judge what a client that sees ONLY
// global broadcasts ends up believing.

const SID = 'sess-8502'

let _tmp
function tmpStateFile() {
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'turn-end-session-list-test-'))
  return join(_tmp, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}
after(() => {
  if (_tmp) rmSync(_tmp, { recursive: true, force: true })
})

/** The events a SessionManager proxies to `session_event` that these tests need. */
const FORWARDED = [
  'stream_start', 'stream_delta', 'stream_end', 'message', 'tool_start', 'tool_result',
  'result', 'stopped', 'error', 'conversation_id', 'ready', 'busy_cleared',
]

/**
 * A forwarder wired to what two clients would receive: `viewer` (everything,
 * in order) and `global` (only broadcasts, i.e. a client NOT viewing SID).
 */
function wire(session) {
  const viewer = []
  const global = []
  const sm = new EventEmitter()
  sm.getSession = () => null
  sm.listSessions = () => [{ sessionId: SID, isBusy: session.isRunning }]
  sm.getSessionContext = () => Promise.resolve(null)
  const normalizer = new EventNormalizer()
  const devPreview = new EventEmitter()
  devPreview.handleToolResult = () => {}
  devPreview.closeSession = () => {}
  setupForwarding({
    normalizer,
    sessionManager: sm,
    cliSession: null,
    devPreview,
    checkpointManager: new EventEmitter(),
    pushManager: null,
    permissionSessionMap: new Map(),
    questionSessionMap: new Map(),
    broadcast: (msg) => { viewer.push(msg); global.push(msg) },
    broadcastToSession: (_sid, msg) => viewer.push(msg),
  })
  for (const ev of FORWARDED) {
    session.on(ev, (data) => sm.emit('session_event', { sessionId: SID, event: ev, data }))
  }
  return { viewer, global, normalizer, sm }
}

/**
 * What a client that only sees GLOBAL frames last believes about SID: a
 * `session_activity` ping, or SID's row in a `session_list` (which the clients
 * re-derive `isIdle` from). null = it was told nothing.
 */
function lastBusyClaim(global) {
  let last = null
  for (const f of global) {
    if (f.type === 'session_activity' && f.sessionId === SID) last = f.isBusy
    else if (f.type === 'session_list') {
      const row = (f.sessions || []).find((x) => x.sessionId === SID)
      if (row) last = row.isBusy
    }
  }
  return last
}

/**
 * SID's rows in the lists published AFTER the turn end announced idle (the first
 * `session_activity` ping with isBusy false). A list sent earlier, at stream or
 * conversation start, says busy and must not stand in for the one the turn end
 * owes: with that list deleted outright, `lastBusyClaim` falls back to the ping.
 */
function rowsAfterIdlePing(global) {
  const at = global.findIndex((f) => f.type === 'session_activity' && f.isBusy === false)
  assert.ok(at >= 0, 'precondition: the turn end announced idle')
  return global.slice(at)
    .filter((f) => f.type === 'session_list')
    .map((f) => f.sessions.find((x) => x.sessionId === SID))
    .filter(Boolean)
}

const lists = (frames) => frames.filter((f) => f.type === 'session_list')
const settle = () => new Promise((resolve) => setImmediate(resolve))

// A fake query: an async iterable over `script` (message objects are yielded,
// functions are awaited) carrying the Query methods the session touches.
function fakeQuery(script) {
  const gen = (async function* () {
    for (const step of script) {
      if (typeof step === 'function') { await step(); continue }
      yield step
    }
  })()
  return { [Symbol.asyncIterator]() { return gen }, interrupt: async () => {}, close: () => {}, stopTask: async () => {} }
}

const init = { type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'claude-x', tools: [] }
const okResult = {
  type: 'result', subtype: 'success', session_id: 'sdk-1', is_error: false,
  duration_ms: 10, num_turns: 1, total_cost_usd: 0.25, usage: {},
}
const abortedResult = {
  type: 'result', subtype: 'error_during_execution', session_id: 'sdk-1', is_error: true,
  terminal_reason: 'aborted_streaming', duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage: {},
}

describe('#8502 the turn-end session_list is built after the provider cleared busy', () => {
  let session
  let net
  afterEach(() => {
    net?.normalizer.destroy()
    session?.destroy()
    session = null
    net = null
  })

  async function run(script) {
    session = new SdkSession({ cwd: '/tmp', stateFilePath: tmpStateFile() })
    session._fetchSupportedModels = () => {}
    net = wire(session)
    session._callQuery = () => fakeQuery(script)
    await session.sendMessage('go')
    await settle()
    return net
  }

  it('a plain completed claude-sdk turn: a client that is not viewing the session ends idle', async () => {
    const { global } = await run([init, okResult])
    assert.equal(session.isRunning, false, 'precondition: the turn is over and the session is idle')
    const rows = rowsAfterIdlePing(global)
    assert.ok(rows.length > 0, 'a session list was published after the turn ended')
    assert.equal(rows.at(-1).isBusy, false, 'and it reports the session idle')
    assert.equal(lastBusyClaim(global), false, 'the last busy-bearing global frame says idle')
  })

  it('a Stop answered with an aborted_* result: a client that is not viewing the session ends idle', async () => {
    const { global } = await run([init, () => session.interrupt(), abortedResult])
    assert.equal(session.isRunning, false)
    assert.equal(rowsAfterIdlePing(global).at(-1)?.isBusy, false, 'the list after the Stop reports idle')
    assert.equal(lastBusyClaim(global), false)
  })

  it('a Stop answered with a thrown AbortError: a client that is not viewing the session ends idle', async () => {
    const { global } = await run([
      init,
      async () => {
        session.interrupt()
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      },
    ])
    assert.equal(session.isRunning, false)
    assert.equal(rowsAfterIdlePing(global).at(-1)?.isBusy, false, 'the list after the Stop reports idle')
    assert.equal(lastBusyClaim(global), false)
  })

  it('result and stopped in one turn end publish ONE list, not one each', async () => {
    const { global } = await run([init, () => session.interrupt(), abortedResult])
    const at = global.findIndex((f) => f.type === 'session_activity' && f.isBusy === false)
    assert.ok(at >= 0, 'precondition: the turn end announced idle')
    assert.equal(lists(global.slice(at)).length, 1, 'one turn end, one list')
  })

  it('the viewer still gets result, agent_idle and the quiet confirmation, and the result keeps its cost', async () => {
    const { viewer, global } = await run([init, () => session.interrupt(), abortedResult])
    const types = viewer.map((f) => f.type)
    for (const t of ['result', 'agent_idle', 'session_stopped']) assert.ok(types.includes(t), `viewer gets ${t}`)
    const ping = global.find((f) => f.type === 'session_activity' && f.isBusy === false)
    assert.equal(ping.lastCost, 0, 'the sidebar ping carries the result\'s cost')
  })

  it('an ordinary turn keeps cost semantics: the idle ping carries the cost', async () => {
    const { global } = await run([init, okResult])
    const ping = global.find((f) => f.type === 'session_activity' && f.isBusy === false)
    assert.ok(ping, 'the turn end announced idle')
    assert.equal(ping.lastCost, 0.25)
  })
})

describe('#8502 the turn-end list is scoped to one synchronous turn end', () => {
  it('is built in a microtask, and a later turn end gets its own list', async () => {
    const stub = Object.assign(new EventEmitter(), { isRunning: true })
    const net = wire(stub)
    const sm = net.sm
    const emit = (event, data = {}) => sm.emit('session_event', { sessionId: SID, event, data })
    emit('stream_start', { messageId: 'm1' })
    const before = lists(net.global).length
    // The provider shape: emit first, clear busy after, in one call stack.
    emit('result', { cost: null, duration: 0, usage: null, sessionId: 'c1' })
    stub.isRunning = false
    await Promise.resolve()
    const afterFirst = lists(net.global).slice(before)
    assert.equal(afterFirst.length, 1, 'built once the call stack unwound, before any macrotask')
    assert.equal(afterFirst[0].sessions[0].isBusy, false)

    // A second turn end a microtask later must not be swallowed by the first.
    stub.isRunning = true
    emit('stream_start', { messageId: 'm2' })
    const mid = lists(net.global).length
    emit('stopped', {})
    stub.isRunning = false
    await Promise.resolve()
    const afterSecond = lists(net.global).slice(mid)
    assert.equal(afterSecond.length, 1, 'the second turn end published its own list')
    assert.equal(afterSecond[0].sessions[0].isBusy, false)
    net.normalizer.destroy()
  })
})

// The jsonl-subprocess family (codex exec, gemini): `result` is emitted when the
// JSONL line is parsed, but the child is still exiting and `_isBusy` clears in
// its `close` handler, a LATER event-loop turn. A list built in a microtask after
// the `result` still says busy, so the session must refresh its list again once
// the close handler has cleared busy.
describe('#8502 jsonl-subprocess providers: the list is refreshed once the child closed', () => {
  const SAVED_ENV = process.env.TEST_API_KEY
  let session
  let net
  let shim
  afterEach(() => {
    net?.normalizer.destroy()
    session?.destroy()
    session = null
    net = null
    if (SAVED_ENV !== undefined) process.env.TEST_API_KEY = SAVED_ENV
    else delete process.env.TEST_API_KEY
  })

  it('a completed turn: a client that is not viewing the session ends idle', async () => {
    process.env.TEST_API_KEY = 'value'
    shim = join(mkdtempSync(join(tmpdir(), 'turn-end-shim-')), 'shim.mjs')
    // Print the result line, then linger so the parent observes a result while the
    // child is still alive (busy) before it exits.
    writeFileSync(shim, [
      `process.stdout.write(JSON.stringify({ type: 'done' }) + '\\n')`,
      'setTimeout(() => process.exit(0), 80)',
    ].join('\n'))
    class P extends JsonlSubprocessSession {
      static get binaryCandidates() { return [process.execPath] }
      static get resolvedBinary() { return process.execPath }
      static get apiKeyEnv() { return 'TEST_API_KEY' }
      static get providerName() { return 'fake' }
      static get displayLabel() { return 'Fake' }
      static get messageIdPrefix() { return 'fake' }
      _buildArgs() { return [shim] }
      _buildChildEnv() { return process.env }
      _processJsonlLine(event, ctx) {
        if (event.type === 'done') {
          ctx.didEmitResult = true
          this.emit('result', { cost: null, duration: null, usage: null, sessionId: null })
        }
      }
    }
    session = new P({ cwd: '/tmp' })
    session._processReady = true
    net = wire(session)
    await session.sendMessage('hi')
    await waitFor(() => session.isRunning === false, { label: 'child closed' })
    await settle()
    assert.equal(rowsAfterIdlePing(net.global).at(-1)?.isBusy, false, 'a list after the child closed reports idle')
    assert.equal(lastBusyClaim(net.global), false)
    rmSync(join(shim, '..'), { recursive: true, force: true })
  })
})
