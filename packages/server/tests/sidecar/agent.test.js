import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import WebSocket from 'ws'
import { PodAgent, LineLimitTransform, DEFAULT_MAX_LINE_BYTES, DEFAULT_STDIN_DRAIN_TIMEOUT_MS } from '../../sidecar/agent.js'

const TOKEN = 'test-secret-token-abc123'
const WRONG_TOKEN = 'wrong-token'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Start an agent on a random port and resolve the chosen port. */
async function startAgent(opts = {}) {
  const agent = new PodAgent({ token: TOKEN, ...opts })
  const port = await agent.listen(0, '127.0.0.1')
  return { agent, port }
}

/** Create a WebSocket that connects with valid auth by default. */
function connect(port, token = TOKEN) {
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  return new WebSocket(`ws://127.0.0.1:${port}`, { headers })
}

/**
 * Wait for a WS to open.
 */
function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
}

/**
 * Collect all JSON messages until the socket closes, then resolve with
 * { messages, closeCode }.  Registers listeners immediately (before any await)
 * so frames sent on connection are never missed.
 *
 * @param {WebSocket} ws   Already-created WebSocket (not yet opened is fine)
 * @param {number} timeoutMs
 */
function collectUntilClose(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const messages = []
    const timer = setTimeout(
      () => reject(new Error(`timeout after ${timeoutMs}ms`)),
      timeoutMs,
    )
    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())) } catch { /* skip non-JSON */ }
    })
    ws.on('close', (code) => { clearTimeout(timer); resolve({ messages, closeCode: code }) })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

/**
 * Wait for the next N messages after open, then return them.
 * Listeners are set up before calling this, so call it promptly after open.
 */
function waitForMessages(ws, count, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const messages = []
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${count} messages (got ${messages.length})`)),
      timeoutMs,
    )
    function onMsg(data) {
      try { messages.push(JSON.parse(data.toString())) } catch { /* skip */ }
      if (messages.length >= count) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        ws.off('close', onClose)
        resolve(messages)
      }
    }
    function onClose() {
      clearTimeout(timer)
      ws.off('message', onMsg)
      resolve(messages) // return whatever we have
    }
    ws.on('message', onMsg)
    ws.on('close', onClose)
  })
}

/**
 * Wait for the next `session_started` frame and resolve with its sessionId.
 * Attach BEFORE sending `spawn` so the frame is never missed.  Other message
 * listeners (e.g. message-buffer arrays in cap-eviction tests) can coexist
 * because this helper always detaches itself before settling — on success,
 * timeout, socket error, or socket close.
 */
function waitForSessionStarted(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer)
      ws.off('message', onMsg)
      ws.off('error', onError)
      ws.off('close', onClose)
    }
    function onMsg(data) {
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.type !== 'session_started') return
      cleanup()
      resolve(msg.sessionId)
    }
    function onError(err) {
      cleanup()
      reject(new Error(`socket error while waiting for session_started: ${err && err.message}`))
    }
    function onClose(code) {
      cleanup()
      reject(new Error(`socket closed (${code}) before session_started arrived`))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timeout waiting for session_started frame'))
    }, timeoutMs)
    ws.on('message', onMsg)
    ws.on('error', onError)
    ws.on('close', onClose)
  })
}

/**
 * Like waitForMessages but skips `session_started` frames and returns N
 * non-session_started frames.  Use in spawn tests that don't care about the
 * session_started acknowledgement.
 */
function waitForDataMessages(ws, count, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const messages = []
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${count} data messages (got ${messages.length})`)),
      timeoutMs,
    )
    function onMsg(data) {
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.type === 'session_started') return
      messages.push(msg)
      if (messages.length >= count) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        ws.off('close', onClose)
        resolve(messages)
      }
    }
    function onClose() {
      clearTimeout(timer)
      ws.off('message', onMsg)
      resolve(messages)
    }
    ws.on('message', onMsg)
    ws.on('close', onClose)
  })
}

// ---------------------------------------------------------------------------
// Mock spawn helper
// ---------------------------------------------------------------------------

/**
 * Returns { child, controller, spawnFn }.
 *
 * child.stdout / child.stderr are PassThrough streams so readline and the
 * 'data' event work exactly as they would with a real child process.
 * controller.writeStdout(line) pushes a newline-terminated NDJSON line.
 * controller.writeStderr(chunk) pushes raw text on stderr.
 * controller.exit(code) emits the 'close' event with the given code.
 *
 * child.kill is a spy that records every signal it was called with so tests
 * can assert SIGTERM / SIGKILL behaviour deterministically.
 */
function createMockSpawn() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()

  child.killSignals = []
  child.kill = (signal) => {
    child.killSignals.push(signal)
    return true
  }

  const controller = {
    writeStdout(line) { child.stdout.write(line + '\n') },
    writeStderr(chunk) { child.stderr.write(chunk) },
    exit(code = 0) { child.emit('close', code) },
  }

  const spawnFn = (_cmd, _args, _opts) => child

  return { child, controller, spawnFn }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PodAgent', () => {
  describe('/healthz', () => {
    let agent, port

    before(async () => {
      ;({ agent, port } = await startAgent())
    })
    after(() => agent.close())

    it('returns 200 with ok:true and version', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.ok, true)
      assert.equal(typeof body.version, 'string')
    })

    it('works without Authorization header', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      assert.equal(res.status, 200)
    })
  })

  describe('WS auth', () => {
    let agent, port

    before(async () => {
      ;({ agent, port } = await startAgent())
    })
    after(() => agent.close())

    it('rejects upgrade with no token (401)', async () => {
      const ws = connect(port, null)
      const [, res] = await once(ws, 'unexpected-response')
      assert.equal(res.statusCode, 401)
    })

    it('rejects upgrade with wrong token (401)', async () => {
      const ws = connect(port, WRONG_TOKEN)
      const [, res] = await once(ws, 'unexpected-response')
      assert.equal(res.statusCode, 401)
    })

    it('accepts upgrade with correct token', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)
      ws.close()
    })
  })

  describe('WS auth — no token configured', () => {
    let agent, port

    before(async () => {
      // token: null simulates CHROXY_AGENT_TOKEN not being set
      ;({ agent, port } = await startAgent({ token: null }))
    })
    after(() => agent.close())

    it('rejects all upgrades when no token is configured', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      const [, res] = await once(ws, 'unexpected-response')
      assert.equal(res.statusCode, 401)
    })
  })

  describe('second concurrent connection', () => {
    let agent, port, ws1

    before(async () => {
      ;({ agent, port } = await startAgent())
      ws1 = connect(port, TOKEN)
      await waitOpen(ws1)
    })
    after(async () => {
      ws1.close()
      await agent.close()
    })

    it('second connection receives error frame then closes', async () => {
      const ws2 = connect(port, TOKEN)

      // Set up listeners BEFORE awaiting open — the server sends the error frame
      // and close handshake immediately on connection, so by the time the 'open'
      // event resolves those frames are already in the receive buffer.
      const resultPromise = collectUntilClose(ws2)

      const { messages, closeCode } = await resultPromise

      assert.equal(closeCode, 1008)
      assert.ok(messages.length >= 1, `expected error frame (got ${messages.length} messages)`)
      assert.equal(messages[0].type, 'error')
      assert.match(messages[0].message, /already connected/)
    })

    it('first connection is unaffected by second connection attempt', () => {
      assert.equal(ws1.readyState, WebSocket.OPEN)
    })
  })

  // #3473 — the duplicate-connection reject path must route through _send so
  // it shares the readyState short-circuit and synchronous-send try/catch
  // with every other reject/error path. Uses a fresh agent (not the one in
  // the suite above) so we can install a spy on _send before any connection.
  describe('second concurrent connection routes through _send (#3473)', () => {
    let agent, port, ws1, sendSpy

    before(async () => {
      ;({ agent, port } = await startAgent())
      sendSpy = mock.method(agent, '_send')
      ws1 = connect(port, TOKEN)
      await waitOpen(ws1)
    })
    after(async () => {
      mock.restoreAll()
      ws1.close()
      await agent.close()
    })

    it('invokes _send with the error frame for the duplicate connection', async () => {
      const ws2 = connect(port, TOKEN)
      const resultPromise = collectUntilClose(ws2)
      await resultPromise

      const errorCalls = sendSpy.mock.calls.filter((call) => {
        const frame = call.arguments[1]
        return frame && frame.type === 'error' && /already connected/.test(frame.message)
      })
      assert.ok(
        errorCalls.length >= 1,
        `expected _send to be invoked with the duplicate-connection error frame (got ${sendSpy.mock.calls.length} total calls)`,
      )
      // The third arg is the close-after-flush callback — must be a function so
      // _send's readyState short-circuit / catch path still triggers the close.
      assert.equal(typeof errorCalls[0].arguments[2], 'function')
    })
  })

  describe('spawn', () => {
    let agent, port, controller

    beforeEach(async () => {
      const mock = createMockSpawn()
      controller = mock.controller
      ;({ agent, port } = await startAgent({ spawnFn: mock.spawnFn }))
    })

    afterEach(() => agent.close())

    it('forwards stdout NDJSON lines as event frames', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      // Wait for 2 data messages: sentinel stderr (seq=1) + event from child stdout.
      const msgsPromise = waitForDataMessages(ws, 2)

      ws.send(JSON.stringify({
        type: 'spawn',
        cmd: 'claude',
        args: ['--help'],
        env: {},
        cwd: '/workspace',
      }))

      const payload = { type: 'assistant', content: 'hello' }
      // Push stdout after a tick so the spawn handler has set up readline
      setTimeout(() => controller.writeStdout(JSON.stringify(payload)), 10)

      const msgs = await msgsPromise
      // Find the event frame — it arrives after the sentinel.
      const eventFrame = msgs.find((m) => m.type === 'event')
      assert.ok(eventFrame, `expected an event frame, got ${JSON.stringify(msgs)}`)
      assert.deepEqual(eventFrame.payload, payload)

      ws.close()
    })

    it('forwards stderr as stderr frames', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      // Wait for 2 data messages: sentinel (seq=1) + child stderr.
      const msgsPromise = waitForDataMessages(ws, 2)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))

      setTimeout(() => controller.writeStderr('error: something went wrong\n'), 10)

      const msgs = await msgsPromise
      assert.ok(msgs.length >= 2, `expected at least 2 data frames, got ${JSON.stringify(msgs)}`)
      // First data frame is always the sentinel.
      assert.equal(msgs[0].type, 'stderr')
      assert.match(msgs[0].data, /^\[chroxy-pod-agent\] spawn/, 'first stderr frame must be the sentinel')
      // Second is the real child stderr.
      assert.equal(msgs[1].type, 'stderr')
      assert.equal(msgs[1].data, 'error: something went wrong\n')

      ws.close()
    })

    it('sends exit frame and closes WS when process exits', async () => {
      const ws = connect(port, TOKEN)

      // Register listeners before open to avoid missing the exit frame + close.
      const donePromise = collectUntilClose(ws)

      await waitOpen(ws)
      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))

      setTimeout(() => controller.exit(0), 10)

      const { messages, closeCode } = await donePromise
      const exitFrames = messages.filter((m) => m.type === 'exit')
      assert.ok(exitFrames.length >= 1, `expected exit frame (got ${JSON.stringify(messages)})`)
      assert.equal(exitFrames[0].code, 0)
      assert.equal(closeCode, 1000)
    })

    it('returns error frame when cmd is missing', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      const msgsPromise = waitForMessages(ws, 1)
      ws.send(JSON.stringify({ type: 'spawn' }))

      const msgs = await msgsPromise
      assert.ok(msgs.length >= 1)
      assert.equal(msgs[0].type, 'error')
      assert.match(msgs[0].message, /cmd is required/)

      ws.close()
    })

    // ── sentinel tests (#3344) ──────────────────────────────────────────────

    it('emits sentinel stderr frame as first data frame on every spawn', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      // The sentinel is the very first data frame (seq=1), emitted before any
      // child output.  waitForDataMessages skips session_started, so msgs[0]
      // must be the sentinel.
      const msgsPromise = waitForDataMessages(ws, 1)
      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: ['--help'] }))

      const msgs = await msgsPromise
      assert.equal(msgs[0].type, 'stderr', 'sentinel must be a stderr frame')
      assert.match(
        msgs[0].data,
        /^\[chroxy-pod-agent\] spawn cmd=claude/,
        `sentinel data must start with [chroxy-pod-agent] spawn cmd=claude, got: ${JSON.stringify(msgs[0].data)}`,
      )
      assert.ok(
        msgs[0].data.includes('"--help"'),
        `sentinel must include args, got: ${JSON.stringify(msgs[0].data)}`,
      )
      assert.ok(
        msgs[0].data.includes('sessionId='),
        `sentinel must include sessionId=, got: ${JSON.stringify(msgs[0].data)}`,
      )

      ws.close()
    })

    it('sentinel arrives before child stderr', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      // Collect sentinel + real child stderr.
      const msgsPromise = waitForDataMessages(ws, 2)
      ws.send(JSON.stringify({ type: 'spawn', cmd: 'node', args: ['-e', ''] }))
      // Child stderr arrives 20 ms after spawn — well after the synchronous sentinel.
      setTimeout(() => controller.writeStderr('real-child-stderr\n'), 20)

      const msgs = await msgsPromise
      assert.equal(msgs[0].type, 'stderr')
      assert.match(msgs[0].data, /^\[chroxy-pod-agent\] spawn/, 'first data frame must be sentinel')
      assert.equal(msgs[1].type, 'stderr')
      assert.equal(msgs[1].data, 'real-child-stderr\n', 'second data frame must be real child stderr')

      ws.close()
    })

    it('sentinel includes correct cmd, args, and matching sessionId', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      // waitForMessages(ws, 2) gets session_started + sentinel together.
      const msgsPromise = waitForMessages(ws, 2)
      ws.send(JSON.stringify({ type: 'spawn', cmd: 'node', args: ['-e', 'process.exit(0)'] }))

      const msgs = await msgsPromise
      const started = msgs.find((m) => m.type === 'session_started')
      const sentinel = msgs.find((m) => m.type === 'stderr')

      assert.ok(started, 'session_started must be present')
      assert.ok(sentinel, 'sentinel stderr must be present')

      // Sentinel must contain the spawned cmd, the args, and the same sessionId.
      assert.ok(sentinel.data.includes('cmd=node'), `sentinel must show cmd=node, got ${sentinel.data}`)
      assert.ok(sentinel.data.includes('process.exit(0)'), `sentinel must include args, got ${sentinel.data}`)
      assert.ok(
        sentinel.data.includes(`sessionId=${started.sessionId}`),
        `sentinel sessionId must match session_started.sessionId (${started.sessionId}), got ${sentinel.data}`,
      )

      ws.close()
    })

    it('sentinel carries seq=1 — it is the first sequenced output frame', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      const msgsPromise = waitForDataMessages(ws, 1)
      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))

      const msgs = await msgsPromise
      assert.equal(msgs[0].seq, 1, `sentinel must carry seq=1, got seq=${msgs[0].seq}`)

      ws.close()
    })

    // ── sentinel args truncation tests (#3393) ──────────────────────────────

    it('sentinel shows all args when args.length <= 3', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      const msgsPromise = waitForDataMessages(ws, 1)
      ws.send(JSON.stringify({ type: 'spawn', cmd: 'node', args: ['-e', 'process.exit(0)', '--flag'] }))

      const msgs = await msgsPromise
      const sentinelData = msgs[0].data
      // All 3 args must appear — no truncation summary.
      assert.ok(sentinelData.includes('"-e"'), `sentinel must include first arg, got: ${sentinelData}`)
      assert.ok(sentinelData.includes('"process.exit(0)"'), `sentinel must include second arg, got: ${sentinelData}`)
      assert.ok(sentinelData.includes('"--flag"'), `sentinel must include third arg, got: ${sentinelData}`)
      assert.ok(!sentinelData.includes('more]'), `sentinel must NOT include truncation summary for 3 args, got: ${sentinelData}`)

      ws.close()
    })

    it('sentinel truncates args beyond 3 — first 3 shown, remainder summarised (#3393)', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      const msgsPromise = waitForDataMessages(ws, 1)
      // 5 args: first 3 shown, last 2 replaced with "...[2 more]"
      ws.send(JSON.stringify({
        type: 'spawn',
        cmd: 'node',
        args: ['arg1', 'arg2', 'arg3', 'secret-flag', 'secret-value'],
      }))

      const msgs = await msgsPromise
      const sentinelData = msgs[0].data
      assert.ok(sentinelData.includes('"arg1"'), `first arg must be present, got: ${sentinelData}`)
      assert.ok(sentinelData.includes('"arg2"'), `second arg must be present, got: ${sentinelData}`)
      assert.ok(sentinelData.includes('"arg3"'), `third arg must be present, got: ${sentinelData}`)
      assert.ok(!sentinelData.includes('"secret-flag"'), `fourth arg must be elided, got: ${sentinelData}`)
      assert.ok(!sentinelData.includes('"secret-value"'), `fifth arg must be elided, got: ${sentinelData}`)
      assert.ok(sentinelData.includes('...[2 more]'), `sentinel must include truncation summary, got: ${sentinelData}`)

      ws.close()
    })

    it('sentinel truncation summary reflects the correct count of elided args (#3393)', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      const msgsPromise = waitForDataMessages(ws, 1)
      // 7 args: 3 shown, 4 elided
      ws.send(JSON.stringify({
        type: 'spawn',
        cmd: 'node',
        args: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      }))

      const msgs = await msgsPromise
      const sentinelData = msgs[0].data
      assert.ok(sentinelData.includes('...[4 more]'), `sentinel must report 4 elided args, got: ${sentinelData}`)

      ws.close()
    })
  })

  describe('ping/pong', () => {
    let agent, port

    before(async () => {
      ;({ agent, port } = await startAgent())
    })
    after(() => agent.close())

    it('responds to JSON ping with pong', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      const msgsPromise = waitForMessages(ws, 1)
      ws.send(JSON.stringify({ type: 'ping' }))
      const msgs = await msgsPromise
      assert.ok(msgs.length >= 1)
      assert.equal(msgs[0].type, 'pong')

      ws.close()
    })
  })

  describe('unknown message type', () => {
    let agent, port

    before(async () => {
      ;({ agent, port } = await startAgent())
    })
    after(() => agent.close())

    it('returns error frame for unknown message type', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      const msgsPromise = waitForMessages(ws, 1)
      ws.send(JSON.stringify({ type: 'completely_unknown' }))

      const msgs = await msgsPromise
      assert.ok(msgs.length >= 1)
      assert.equal(msgs[0].type, 'error')
      assert.match(msgs[0].message, /unknown message type/)

      ws.close()
    })
  })

  describe('orphan child cleanup on WS disconnect', () => {
    let agent, port, child, controller

    beforeEach(async () => {
      const mock = createMockSpawn()
      child = mock.child
      controller = mock.controller
      // Short grace so the SIGKILL escalation completes within the test budget.
      ;({ agent, port } = await startAgent({ spawnFn: mock.spawnFn, killGraceMs: 25 }))
    })

    afterEach(() => agent.close())

    it('child is NOT killed when client closes WS mid-spawn (session persists for resume)', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      // Yield so _handleSpawn has run and the session is registered.
      await new Promise((r) => setTimeout(r, 10))

      ws.close()
      // Wait for the close event to propagate server-side.
      await new Promise((r) => setTimeout(r, 30))

      // With resume semantics, the child should NOT be killed on WS disconnect —
      // it stays alive so a reconnecting client can resume the session.
      assert.equal(
        child.killSignals.length, 0,
        `child should not be killed on WS disconnect (got ${JSON.stringify(child.killSignals)})`,
      )
    })

    it('agent.close() kills any in-flight child', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 10))

      await agent.close()

      assert.ok(
        child.killSignals.includes('SIGTERM'),
        `expected SIGTERM on agent.close(), got ${JSON.stringify(child.killSignals)}`,
      )
    })

    it('child is not killed when it exits naturally before disconnect', async () => {
      const ws = connect(port, TOKEN)
      const donePromise = collectUntilClose(ws)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 10))

      // Natural exit — agent should send 'exit' frame and close WS without
      // ever calling kill().
      controller.exit(0)

      const { messages } = await donePromise
      assert.ok(messages.some((m) => m.type === 'exit' && m.code === 0))
      assert.equal(child.killSignals.length, 0, `child should not have been killed, got ${JSON.stringify(child.killSignals)}`)
    })
  })

  describe('child env sanitization', () => {
    let agent, port, capturedEnv

    beforeEach(async () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => true
      const spawnFn = (_cmd, _args, opts) => {
        capturedEnv = opts.env
        return child
      }
      ;({ agent, port } = await startAgent({ spawnFn }))
    })

    afterEach(() => agent.close())

    it('strips CHROXY_AGENT_TOKEN from the spawned child env', async () => {
      // Force the agent process to advertise a token in its env so we can
      // assert it is removed before forwarding to the child.
      const originalToken = process.env.CHROXY_AGENT_TOKEN
      process.env.CHROXY_AGENT_TOKEN = 'agent-only-secret-must-not-leak'

      try {
        const ws = connect(port, TOKEN)
        await waitOpen(ws)

        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 20))

        assert.ok(capturedEnv, 'spawn should have been called with env')
        assert.equal(
          capturedEnv.CHROXY_AGENT_TOKEN,
          undefined,
          'CHROXY_AGENT_TOKEN must NOT be forwarded to the child',
        )

        ws.close()
      } finally {
        if (originalToken === undefined) delete process.env.CHROXY_AGENT_TOKEN
        else process.env.CHROXY_AGENT_TOKEN = originalToken
      }
    })

    it('per-spawn env values still take effect', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({
        type: 'spawn',
        cmd: 'claude',
        args: [],
        env: { MY_CUSTOM_VAR: 'hello' },
      }))
      await new Promise((r) => setTimeout(r, 20))

      assert.ok(capturedEnv, 'spawn should have been called with env')
      assert.equal(capturedEnv.MY_CUSTOM_VAR, 'hello', 'per-spawn env must be forwarded')

      ws.close()
    })
  })

  describe('async spawn errors', () => {
    let agent, port, child

    beforeEach(async () => {
      child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => true
      const spawnFn = () => child
      ;({ agent, port } = await startAgent({ spawnFn }))
    })

    afterEach(() => agent.close())

    it('forwards async spawn errors as error frames without crashing', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      // Wait for 2 data messages: sentinel (seq=1) + async error frame.
      const msgsPromise = waitForDataMessages(ws, 2)
      ws.send(JSON.stringify({ type: 'spawn', cmd: 'nonexistent-bin', args: [] }))

      // Simulate the async ENOENT-style error Node would emit a tick after spawn.
      setTimeout(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })), 10)

      const msgs = await msgsPromise
      // Find the error frame — sentinel arrives before it.
      const errFrame = msgs.find((m) => m.type === 'error')
      assert.ok(errFrame, `expected an error frame, got ${JSON.stringify(msgs)}`)
      assert.match(errFrame.message, /spawn failed/)
      assert.match(errFrame.message, /ENOENT/)

      ws.close()
    })
  })

  describe('multi-spawn guard', () => {
    let agent, port, controller

    beforeEach(async () => {
      const mock = createMockSpawn()
      controller = mock.controller
      ;({ agent, port } = await startAgent({ spawnFn: mock.spawnFn }))
    })

    afterEach(() => agent.close())

    it('rejects a second spawn frame on the same connection', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      // First spawn — wait for sentinel + event (skip session_started).
      const firstAck = waitForDataMessages(ws, 2)
      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      setTimeout(() => controller.writeStdout(JSON.stringify({ type: 'assistant' })), 10)
      const firstMsgs = await firstAck
      // Find the event frame (sentinel is first).
      const firstEvent = firstMsgs.find((m) => m.type === 'event')
      assert.ok(firstEvent, `expected an event frame in first spawn ack, got ${JSON.stringify(firstMsgs)}`)

      // Second spawn — must be rejected with an error frame, first child untouched.
      const secondAck = waitForDataMessages(ws, 1)
      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      const secondMsgs = await secondAck
      assert.equal(secondMsgs[0].type, 'error')
      assert.match(secondMsgs[0].message, /child already running/)

      ws.close()
    })
  })

  // ---------------------------------------------------------------------------
  // session_started and seq numbering (#3321)
  // ---------------------------------------------------------------------------

  describe('session_started and seq numbering', () => {
    let agent, port, controller

    beforeEach(async () => {
      const mock = createMockSpawn()
      controller = mock.controller
      ;({ agent, port } = await startAgent({ spawnFn: mock.spawnFn }))
    })

    afterEach(() => agent.close())

    it('sends session_started frame immediately after spawn is accepted', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      const msgsPromise = waitForMessages(ws, 1)
      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))

      const msgs = await msgsPromise
      assert.equal(msgs[0].type, 'session_started')
      assert.ok(typeof msgs[0].sessionId === 'string' && msgs[0].sessionId.length > 0,
        'session_started must carry a non-empty sessionId')

      ws.close()
    })

    it('adds seq to event, stderr, and exit frames', async () => {
      const ws = connect(port, TOKEN)
      const donePromise = collectUntilClose(ws)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 10))

      controller.writeStdout(JSON.stringify({ type: 'assistant' }))
      controller.writeStderr('err\n')
      await new Promise((r) => setTimeout(r, 10))
      controller.exit(0)

      const { messages } = await donePromise
      const data = messages.filter((m) => m.type !== 'session_started')
      for (const frame of data) {
        assert.ok(typeof frame.seq === 'number' && frame.seq > 0,
          `frame ${frame.type} should have a positive seq, got ${frame.seq}`)
      }
      // seq values must be monotonically increasing across all data frames.
      const seqs = data.map((m) => m.seq)
      for (let i = 1; i < seqs.length; i++) {
        assert.ok(seqs[i] > seqs[i - 1], `seq must increase: ${seqs[i - 1]} -> ${seqs[i]}`)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // resume (#3321)
  // ---------------------------------------------------------------------------

  describe('resume', () => {
    let agent, port, controller

    beforeEach(async () => {
      const mock = createMockSpawn()
      controller = mock.controller
      ;({ agent, port } = await startAgent({ spawnFn: mock.spawnFn }))
    })

    afterEach(() => agent.close())

    it('replays buffered events with seq > lastSeq on resume', async () => {
      // ── First connection: spawn and get some frames ───────────────────────
      const ws1 = connect(port, TOKEN)
      await waitOpen(ws1)

      // Collect all frames from ws1
      const ws1Msgs = []
      ws1.on('message', (d) => {
        try { ws1Msgs.push(JSON.parse(d.toString())) } catch {}
      })

      ws1.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 10))

      // Emit 3 stdout events
      controller.writeStdout(JSON.stringify({ type: 'a' }))
      controller.writeStdout(JSON.stringify({ type: 'b' }))
      controller.writeStdout(JSON.stringify({ type: 'c' }))
      await new Promise((r) => setTimeout(r, 20))

      // Extract sessionId and seq from what ws1 received
      const startedFrame = ws1Msgs.find((m) => m.type === 'session_started')
      assert.ok(startedFrame, 'must have received session_started')
      const sessionId = startedFrame.sessionId

      const eventFrames = ws1Msgs.filter((m) => m.type === 'event')
      assert.ok(eventFrames.length >= 2, `expected at least 2 event frames, got ${eventFrames.length}`)

      // Pretend the client has seen the first 2 frames but missed the 3rd.
      const resumeAfterSeq = eventFrames[1].seq

      // ── Disconnect ws1 ────────────────────────────────────────────────────
      ws1.close()
      await new Promise((r) => setTimeout(r, 20))

      // ── Second connection: resume ─────────────────────────────────────────
      const ws2 = connect(port, TOKEN)
      await waitOpen(ws2)

      const ws2Msgs = []
      ws2.on('message', (d) => {
        try { ws2Msgs.push(JSON.parse(d.toString())) } catch {}
      })

      ws2.send(JSON.stringify({ type: 'resume', sessionId, lastSeq: resumeAfterSeq }))
      await new Promise((r) => setTimeout(r, 20))

      // Should have replayed only frames with seq > resumeAfterSeq
      const replayed = ws2Msgs.filter((m) => m.seq !== undefined)
      assert.ok(replayed.every((m) => m.seq > resumeAfterSeq),
        `all replayed frames must have seq > ${resumeAfterSeq}, got ${JSON.stringify(replayed.map((m) => m.seq))}`)
      assert.ok(replayed.length >= 1, 'must have replayed at least one frame')

      // The resume MUST be acknowledged by an explicit `resumed` frame after
      // the replay (#3348). Without it, clients cannot reset their per-blip
      // retry budget and `maxRetries` becomes a session-lifetime budget.
      const resumed = ws2Msgs.find((m) => m.type === 'resumed')
      assert.ok(resumed, `expected a resumed frame after replay, got ${JSON.stringify(ws2Msgs)}`)
      assert.equal(resumed.sessionId, sessionId)
      assert.equal(resumed.lastSeq, resumeAfterSeq)
      assert.ok(typeof resumed.replayedCount === 'number' && resumed.replayedCount >= 1,
        `resumed.replayedCount should be a positive number, got ${resumed.replayedCount}`)

      ws2.close()
    })

    it('emits resumed even when nothing was replayed (lastSeq up-to-date)', async () => {
      const ws1 = connect(port, TOKEN)
      await waitOpen(ws1)

      const ws1Msgs = []
      ws1.on('message', (d) => {
        try { ws1Msgs.push(JSON.parse(d.toString())) } catch {}
      })

      ws1.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 10))

      controller.writeStdout(JSON.stringify({ type: 'a' }))
      await new Promise((r) => setTimeout(r, 20))

      const sessionId = ws1Msgs.find((m) => m.type === 'session_started').sessionId
      const lastSeq = Math.max(...ws1Msgs.filter((m) => typeof m.seq === 'number').map((m) => m.seq))

      ws1.close()
      await new Promise((r) => setTimeout(r, 20))

      const ws2 = connect(port, TOKEN)
      await waitOpen(ws2)

      const ws2Msgs = []
      ws2.on('message', (d) => {
        try { ws2Msgs.push(JSON.parse(d.toString())) } catch {}
      })

      // Resume already at the latest seq — replayedCount must be 0 but the
      // resumed frame is still required so the client can ack the success.
      ws2.send(JSON.stringify({ type: 'resume', sessionId, lastSeq }))
      await new Promise((r) => setTimeout(r, 20))

      const resumed = ws2Msgs.find((m) => m.type === 'resumed')
      assert.ok(resumed, 'resumed frame must be sent even when nothing replayed')
      assert.equal(resumed.replayedCount, 0)

      ws2.close()
    })

    it('sends session_lost(unknown_session) when sessionId is unknown', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      const msgsPromise = waitForMessages(ws, 1)
      ws.send(JSON.stringify({ type: 'resume', sessionId: 'does-not-exist', lastSeq: 0 }))

      const msgs = await msgsPromise
      assert.equal(msgs[0].type, 'session_lost')
      assert.equal(msgs[0].sessionId, 'does-not-exist')
      assert.equal(msgs[0].reason, 'unknown_session')

      ws.close()
    })

    it('rejects resume when session already has an active client', async () => {
      // First: spawn a session and keep the connection open.
      const ws1 = connect(port, TOKEN)
      await waitOpen(ws1)

      const ws1Msgs = []
      ws1.on('message', (d) => {
        try { ws1Msgs.push(JSON.parse(d.toString())) } catch {}
      })

      ws1.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 10))

      const startedFrame = ws1Msgs.find((m) => m.type === 'session_started')
      assert.ok(startedFrame)
      assert.ok(startedFrame.sessionId)

      // ws1 is still open. Try to resume from a second connection — should be
      // rejected because ws1 is the active client (enforced by the single-client
      // policy in _handleResume).
      // However, the second concurrent connection is rejected at _handleConnection
      // level first ("another client is already connected").
      const ws2 = connect(port, TOKEN)
      const ws2Result = collectUntilClose(ws2)

      const { messages, closeCode } = await ws2Result
      assert.equal(closeCode, 1008)
      assert.ok(messages.some((m) => m.type === 'error' && /already connected/.test(m.message)))

      ws1.close()
    })
  })

  // ---------------------------------------------------------------------------
  // buffer overflow (#3321)
  // ---------------------------------------------------------------------------

  describe('buffer overflow', () => {
    let agent, port, controller

    beforeEach(async () => {
      const mock = createMockSpawn()
      controller = mock.controller
      // Small buffer so the overflow test runs quickly.
      ;({ agent, port } = await startAgent({ spawnFn: mock.spawnFn, bufferSize: 3 }))
    })

    afterEach(() => agent.close())

    it('emits session_lost(buffer_overflow) when resume lastSeq predates the buffer (#3347)', async () => {
      const ws1 = connect(port, TOKEN)
      await waitOpen(ws1)

      const ws1Msgs = []
      ws1.on('message', (d) => {
        try { ws1Msgs.push(JSON.parse(d.toString())) } catch {}
      })

      ws1.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 10))

      // Push 5 events into a buffer of size 3; sentinel (seq=1) + oldest 2
      // events (seq=2, seq=3) are evicted — 3 frames total, leaving seq=4,5,6.
      for (let i = 0; i < 5; i++) {
        controller.writeStdout(JSON.stringify({ idx: i }))
      }
      await new Promise((r) => setTimeout(r, 30))

      const allEvents = ws1Msgs.filter((m) => m.type === 'event')
      assert.ok(allEvents.length === 5, `ws1 should see all 5 events live (got ${allEvents.length})`)

      // Disconnect then reconnect with lastSeq=0 (asking for full replay).
      // Per #3347 this used to silently replay only what was still buffered;
      // the corrected behaviour is to surface a session_lost(buffer_overflow)
      // so the client never sees a partial NDJSON stream.
      const sessionId = ws1Msgs.find((m) => m.type === 'session_started').sessionId
      ws1.close()
      await new Promise((r) => setTimeout(r, 20))

      const ws2 = connect(port, TOKEN)
      const ws2Done = collectUntilClose(ws2)
      await waitOpen(ws2)

      ws2.send(JSON.stringify({ type: 'resume', sessionId, lastSeq: 0 }))

      const { messages, closeCode } = await ws2Done

      // No event frames must be replayed when the gap is detected — the
      // client's NDJSON stream cannot be safely continued.
      const replayedEvents = messages.filter((m) => m.type === 'event')
      assert.equal(replayedEvents.length, 0,
        `must NOT replay any events on a stale-resume gap, got ${JSON.stringify(replayedEvents)}`)

      const lost = messages.find((m) => m.type === 'session_lost')
      assert.ok(lost, `expected session_lost frame, got ${JSON.stringify(messages)}`)
      assert.equal(lost.sessionId, sessionId)
      assert.equal(lost.reason, 'buffer_overflow',
        'session_lost reason must be buffer_overflow on resume gap')
      assert.equal(closeCode, 1008, 'WS must be closed with code 1008 on resume gap')
    })

    it('successful resume after partial drain still emits resumed', async () => {
      // Consume a few frames live, then resume with lastSeq inside the window —
      // verifies the gap check does not trip when the buffer still covers
      // (lastSeq, head].
      const ws1 = connect(port, TOKEN)
      await waitOpen(ws1)

      const ws1Msgs = []
      ws1.on('message', (d) => {
        try { ws1Msgs.push(JSON.parse(d.toString())) } catch {}
      })

      ws1.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 10))

      // Push exactly bufferSize - 1 events. The sentinel occupies seq=1, so
      // the 2 events are seq=2 and seq=3. With bufferSize=3 the buffer holds
      // all 3 frames (sentinel + 2 events) — no eviction occurs.
      for (let i = 0; i < 2; i++) {
        controller.writeStdout(JSON.stringify({ idx: i }))
      }
      await new Promise((r) => setTimeout(r, 20))

      const sessionId = ws1Msgs.find((m) => m.type === 'session_started').sessionId
      ws1.close()
      await new Promise((r) => setTimeout(r, 20))

      const ws2 = connect(port, TOKEN)
      await waitOpen(ws2)

      const ws2Msgs = []
      ws2.on('message', (d) => {
        try { ws2Msgs.push(JSON.parse(d.toString())) } catch {}
      })

      // lastSeq=0 with no eviction (buffer starts at seq=1) must succeed and
      // replay all 3 buffered frames (sentinel + 2 events).
      ws2.send(JSON.stringify({ type: 'resume', sessionId, lastSeq: 0 }))
      await new Promise((r) => setTimeout(r, 20))

      const replayed = ws2Msgs.filter((m) => m.type === 'event')
      assert.equal(replayed.length, 2, 'all 2 buffered events must replay when no gap')

      const resumed = ws2Msgs.find((m) => m.type === 'resumed')
      assert.ok(resumed, 'resumed frame required on successful resume')
      // sentinel (seq=1) + 2 events (seq=2, seq=3) = 3 replayed frames total.
      assert.equal(resumed.replayedCount, 3)

      ws2.close()
    })
  })

  // ---------------------------------------------------------------------------
  // LineLimitTransform unit tests (#3327)
  // ---------------------------------------------------------------------------

  describe('LineLimitTransform', () => {
    /** Pipe all chunks through a LineLimitTransform and collect output. */
    function collect(transform, chunks) {
      return new Promise((resolve, reject) => {
        const out = []
        let oversized = false
        transform.on('oversized_line', () => { oversized = true })
        transform.on('data', (chunk) => out.push(chunk))
        transform.on('end', () => resolve({ output: Buffer.concat(out).toString(), oversized }))
        transform.on('error', reject)
        for (const chunk of chunks) {
          transform.write(Buffer.from(chunk))
        }
        transform.end()
      })
    }

    it('passes normal short lines through unchanged', async () => {
      const t = new LineLimitTransform({ maxBytes: 100 })
      const line = JSON.stringify({ type: 'assistant', content: 'hello' }) + '\n'
      const { output, oversized } = await collect(t, [line])
      assert.equal(output, line)
      assert.equal(oversized, false)
    })

    it('passes multiple short lines through unchanged', async () => {
      const t = new LineLimitTransform({ maxBytes: 100 })
      const line1 = 'first\n'
      const line2 = 'second\n'
      const { output, oversized } = await collect(t, [line1, line2])
      assert.equal(output, line1 + line2)
      assert.equal(oversized, false)
    })

    it('resets line counter after each newline', async () => {
      const t = new LineLimitTransform({ maxBytes: 10 })
      // Each individual line is 9 bytes (under cap); total bytes would exceed
      // cap but that should not matter — counter resets on newline.
      const { output, oversized } = await collect(t, ['123456789\n', '123456789\n'])
      assert.equal(oversized, false)
      assert.ok(output.includes('123456789\n'))
    })

    it('fires oversized_line and stops passing data when a line exceeds maxBytes', async () => {
      const t = new LineLimitTransform({ maxBytes: 10 })
      // 11 bytes with no newline → should trip the guard
      const bigChunk = 'A'.repeat(11)
      const { oversized } = await collect(t, [bigChunk])
      assert.equal(oversized, true)
    })

    it('fires oversized_line across multiple chunks accumulating one big line', async () => {
      const t = new LineLimitTransform({ maxBytes: 10 })
      // Spread the big line across 3 chunks, each < cap, no newlines
      const { oversized } = await collect(t, ['AAAA', 'AAAA', 'AAAA'])
      assert.equal(oversized, true)
    })

    it('does not fire oversized_line when line is exactly maxBytes', async () => {
      const t = new LineLimitTransform({ maxBytes: 10 })
      const exactly = 'A'.repeat(10) + '\n'
      const { oversized } = await collect(t, [exactly])
      assert.equal(oversized, false)
    })

    it('fires oversized_line when line is maxBytes + 1', async () => {
      const t = new LineLimitTransform({ maxBytes: 10 })
      const oneOver = 'A'.repeat(11) + '\n'
      const { oversized } = await collect(t, [oneOver])
      assert.equal(oversized, true)
    })

    // CRLF regression tests (#3381) ----------------------------------------

    it('does not fire oversized_line for a CRLF line of exactly maxBytes content bytes (#3381)', async () => {
      // Before the fix, CR was counted as a content byte — a CRLF line of
      // exactly maxBytes pushed _pending to maxBytes+1 before the LF could
      // reset it, causing a false oversized_line.
      const t = new LineLimitTransform({ maxBytes: 10 })
      const crlfLine = 'A'.repeat(10) + '\r\n'
      const { oversized } = await collect(t, [crlfLine])
      assert.equal(oversized, false)
    })

    it('fires oversized_line when CRLF line content exceeds maxBytes (#3381)', async () => {
      // 11 content bytes + CRLF must still trip the guard.
      const t = new LineLimitTransform({ maxBytes: 10 })
      const crlfOver = 'A'.repeat(11) + '\r\n'
      const { oversized } = await collect(t, [crlfOver])
      assert.equal(oversized, true)
    })

    it('drops all data after the oversized_line event fires (second write is suppressed)', async () => {
      const t = new LineLimitTransform({ maxBytes: 5 })
      const received = []
      let oversizedCount = 0
      t.on('oversized_line', () => { oversizedCount += 1 })
      t.on('data', (chunk) => received.push(chunk.toString()))

      t.write(Buffer.from('AAAAAA'))  // trips the guard (6 > 5)
      t.write(Buffer.from('should-be-dropped\n'))
      t.end()

      await new Promise((r) => t.once('end', r))
      assert.equal(oversizedCount, 1, 'oversized_line must fire exactly once')
      // The second write must have been dropped
      const full = received.join('')
      assert.ok(!full.includes('should-be-dropped'), 'post-trip data must be dropped')
    })
  })

  // ---------------------------------------------------------------------------
  // NDJSON line buffer cap integration tests (#3327)
  // ---------------------------------------------------------------------------

  describe('NDJSON line buffer cap', () => {
    it('DEFAULT_MAX_LINE_BYTES is a positive finite number', () => {
      assert.ok(Number.isFinite(DEFAULT_MAX_LINE_BYTES) && DEFAULT_MAX_LINE_BYTES > 0,
        `DEFAULT_MAX_LINE_BYTES should be a positive finite number, got ${DEFAULT_MAX_LINE_BYTES}`)
    })

    it('emits error frame with code line_too_long when stdout line exceeds cap', async () => {
      const mock = createMockSpawn()
      const { agent, port } = await startAgent({
        spawnFn: mock.spawnFn,
        // Use a tiny cap so we can trigger it without huge allocations.
        maxLineBytes: 16,
      })

      try {
        const ws = connect(port, TOKEN)
        const donePromise = collectUntilClose(ws, 3000)

        await waitOpen(ws)
        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))

        // Wait for session_started then push an oversized line (no newline).
        await new Promise((r) => setTimeout(r, 10))
        // 17 bytes, no newline — exceeds the 16-byte cap.
        mock.child.stdout.write(Buffer.from('A'.repeat(17)))

        const { messages } = await donePromise
        const errFrame = messages.find((m) => m.type === 'error' && m.code === 'line_too_long')
        assert.ok(errFrame, `expected error frame with code=line_too_long, got ${JSON.stringify(messages)}`)
        assert.match(errFrame.message, /exceeded max length/)
      } finally {
        await agent.close()
      }
    })

    it('kills the child when the line cap is exceeded', async () => {
      const mock = createMockSpawn()
      const { agent, port } = await startAgent({
        spawnFn: mock.spawnFn,
        maxLineBytes: 16,
        killGraceMs: 25,
      })

      try {
        const ws = connect(port, TOKEN)
        const donePromise = collectUntilClose(ws, 3000)

        await waitOpen(ws)
        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 10))

        mock.child.stdout.write(Buffer.from('B'.repeat(17)))

        await donePromise

        assert.ok(
          mock.child.killSignals.includes('SIGTERM'),
          `child must be SIGTERM-killed on line_too_long, got ${JSON.stringify(mock.child.killSignals)}`,
        )
      } finally {
        await agent.close()
      }
    })

    it('closes the WS cleanly after emitting the error frame', async () => {
      const mock = createMockSpawn()
      const { agent, port } = await startAgent({
        spawnFn: mock.spawnFn,
        maxLineBytes: 16,
      })

      try {
        const ws = connect(port, TOKEN)
        const donePromise = collectUntilClose(ws, 3000)

        await waitOpen(ws)
        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 10))

        mock.child.stdout.write(Buffer.from('C'.repeat(17)))

        const { closeCode } = await donePromise
        assert.equal(closeCode, 1008, `WS should close with code 1008 after line_too_long, got ${closeCode}`)
      } finally {
        await agent.close()
      }
    })

    it('normal lines still work when cap is set (happy path)', async () => {
      const mock = createMockSpawn()
      const { agent, port } = await startAgent({
        spawnFn: mock.spawnFn,
        maxLineBytes: 64,
      })

      try {
        const ws = connect(port, TOKEN)
        await waitOpen(ws)

        const msgsPromise = waitForDataMessages(ws, 2)

        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        const payload = { type: 'assistant', content: 'hi' }
        setTimeout(() => mock.controller.writeStdout(JSON.stringify(payload)), 10)

        const msgs = await msgsPromise
        // Skip the sentinel stderr frame from #3344 — find the event frame.
        const eventMsg = msgs.find((m) => m.type === 'event')
        assert.ok(eventMsg, `expected an 'event' frame, got: ${JSON.stringify(msgs.map((m) => m.type))}`)
        assert.deepEqual(eventMsg.payload, payload)

        ws.close()
      } finally {
        await agent.close()
      }
    })

    it('invalid maxLineBytes falls back to 1 MiB default', async () => {
      // Verify that passing a non-positive value falls back to FALLBACK_MAX_LINE_BYTES.
      const agent = new PodAgent({ token: TOKEN, maxLineBytes: -1 })
      assert.equal(agent._maxLineBytes, 1024 * 1024)
      await agent.close()
    })

    it('no exit frame is emitted after oversized-line error (regression: #3380)', async () => {
      // When the oversized-line guard trips, child.on('close') fires shortly
      // after SIGTERM.  The bug was that _emitSessionFrame(exit) ran anyway,
      // producing: error(line_too_long) → exit(code=-15) → close(1008).
      // The exit frame between the error and close contradicts the protocol
      // and could confuse K8sBackend.  After the fix the sequence must be:
      //   error(line_too_long) → close(1008)  [no exit frame]
      const mock = createMockSpawn()
      const { agent, port } = await startAgent({
        spawnFn: mock.spawnFn,
        maxLineBytes: 16,
        killGraceMs: 25,
      })

      try {
        const ws = connect(port, TOKEN)
        const donePromise = collectUntilClose(ws, 3000)

        await waitOpen(ws)
        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 10))

        // Trigger the line cap.
        mock.child.stdout.write(Buffer.from('X'.repeat(17)))

        // Let the child 'close' event fire (simulates SIGTERM completing).
        await new Promise((r) => setTimeout(r, 30))
        mock.child.emit('close', -15)

        const { messages, closeCode } = await donePromise

        const errFrame = messages.find((m) => m.type === 'error' && m.code === 'line_too_long')
        assert.ok(errFrame, `expected error frame with code=line_too_long, got: ${JSON.stringify(messages)}`)

        const exitFrame = messages.find((m) => m.type === 'exit')
        assert.equal(exitFrame, undefined,
          `spurious exit frame must not follow line_too_long error, got: ${JSON.stringify(messages)}`)

        assert.equal(closeCode, 1008,
          `WS must close with 1008 after line_too_long, got ${closeCode}`)
      } finally {
        await agent.close()
      }
    })

    it('closes WS only after ws.send callback fires for line_too_long error (#3399)', async () => {
      // Regression: previously the agent scheduled ws.close() on a fixed 50ms
      // timer after _emitSessionFrame, which could race with ws.send() flushing
      // the frame on a busy event loop and drop the frame on the floor.  After
      // the fix, close() must run inside the ws.send completion callback so
      // the order is: send → send-callback-fires → close.  Verified directly
      // by patching the session's activeWs with an instrumented fake whose
      // send() defers its callback by one macrotask.
      const mock = createMockSpawn()
      const { agent, port } = await startAgent({
        spawnFn: mock.spawnFn,
        maxLineBytes: 16,
        killGraceMs: 25,
      })

      try {
        const ws = connect(port, TOKEN)
        const realMsgs = []
        ws.on('message', (d) => { try { realMsgs.push(JSON.parse(d.toString())) } catch {} })
        await waitOpen(ws)
        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))

        // Wait for session_started so we know the session exists.
        await new Promise((r) => setTimeout(r, 20))
        const started = realMsgs.find((m) => m.type === 'session_started')
        assert.ok(started, `expected session_started, got: ${JSON.stringify(realMsgs)}`)
        const sessionId = started.sessionId

        // Replace the session's activeWs with an instrumented fake that defers
        // its send callback by one macrotask and records every operation.
        // This widens the race window — without the fix, close() would run
        // before sendCb fires and the assertion below would fail.
        const callLog = []
        const fakeWs = {
          readyState: 1,
          send(data, cb) {
            const frame = JSON.parse(data)
            callLog.push({ op: 'send', type: frame.type, code: frame.code })
            if (cb) {
              setTimeout(() => { callLog.push({ op: 'send_cb_fired' }); cb() }, 5)
            }
          },
          close(code, reason) { callLog.push({ op: 'close', code, reason }) },
          terminate() {},
        }
        const session = agent._sessions.get(sessionId)
        assert.ok(session, 'expected session in _sessions')
        session.activeWs = fakeWs

        // Trigger the line cap.  The fake now drives the close-after-send
        // path entirely, so we can deterministically assert ordering.
        mock.child.stdout.write(Buffer.from('Z'.repeat(17)))

        // Wait long enough for the deferred send cb (5ms) plus close to run.
        await new Promise((r) => setTimeout(r, 30))

        const sendIdx = callLog.findIndex((e) => e.op === 'send' && e.code === 'line_too_long')
        const cbIdx = callLog.findIndex((e) => e.op === 'send_cb_fired')
        const closeIdx = callLog.findIndex((e) => e.op === 'close' && e.code === 1008)

        assert.ok(sendIdx !== -1, `expected send(line_too_long); log=${JSON.stringify(callLog)}`)
        assert.ok(cbIdx !== -1, `expected send callback to fire; log=${JSON.stringify(callLog)}`)
        assert.ok(closeIdx !== -1, `expected close(1008); log=${JSON.stringify(callLog)}`)
        assert.ok(
          sendIdx < cbIdx,
          `send must precede send_cb_fired (idx ${sendIdx} vs ${cbIdx}); log=${JSON.stringify(callLog)}`,
        )
        assert.ok(
          cbIdx < closeIdx,
          `close(1008) must run after send callback fires (cbIdx ${cbIdx} vs closeIdx ${closeIdx}); log=${JSON.stringify(callLog)}`,
        )

        try { ws.close() } catch {}
      } finally {
        await agent.close()
      }
    })

    it('still closes WS even when ws.send throws synchronously (#3399)', async () => {
      // If ws.send throws (e.g. socket already half-closed), the callback
      // would never fire under naive `ws.send(json, cb)` usage.  The agent's
      // _send wrapper invokes the callback in the catch path so the close-
      // after-send sequence still progresses and the session is cleaned up.
      const mock = createMockSpawn()
      const { agent, port } = await startAgent({
        spawnFn: mock.spawnFn,
        maxLineBytes: 16,
        killGraceMs: 25,
      })

      try {
        const ws = connect(port, TOKEN)
        const realMsgs = []
        ws.on('message', (d) => { try { realMsgs.push(JSON.parse(d.toString())) } catch {} })
        await waitOpen(ws)
        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 20))
        const started = realMsgs.find((m) => m.type === 'session_started')
        assert.ok(started, `expected session_started, got: ${JSON.stringify(realMsgs)}`)
        const sessionId = started.sessionId

        const callLog = []
        const fakeWs = {
          readyState: 1,
          send() { callLog.push({ op: 'send_threw' }); throw new Error('socket already closed') },
          close(code) { callLog.push({ op: 'close', code }) },
          terminate() {},
        }
        const session = agent._sessions.get(sessionId)
        session.activeWs = fakeWs

        mock.child.stdout.write(Buffer.from('Q'.repeat(17)))
        await new Promise((r) => setTimeout(r, 20))

        // Even though send threw, the close-after-flush callback must still
        // run so the session is evicted and the WS is closed.
        assert.ok(
          callLog.some((e) => e.op === 'close' && e.code === 1008),
          `close(1008) must run even when send throws; log=${JSON.stringify(callLog)}`,
        )
        assert.ok(
          !agent._sessions.has(sessionId),
          'session should be deleted after line_too_long cleanup',
        )

        try { ws.close() } catch {}
      } finally {
        await agent.close()
      }
    })
  })

  // stdin forwarding (#3329)
  // ---------------------------------------------------------------------------

  describe('stdin forwarding', () => {
    let agent, port, child, capturedStdin

    beforeEach(async () => {
      // Create a mock child with a writable stdin PassThrough so we can assert
      // what the agent writes into it.
      child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new PassThrough()
      child.killSignals = []
      child.kill = (signal) => { child.killSignals.push(signal); return true }

      capturedStdin = []
      child.stdin.on('data', (chunk) => capturedStdin.push(chunk.toString()))

      const spawnFn = (_cmd, _args, _opts) => child
      ;({ agent, port } = await startAgent({ spawnFn }))
    })

    afterEach(() => agent.close())

    it('forwards stdin frame data to child.stdin', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 20))

      ws.send(JSON.stringify({ type: 'stdin', data: '{"prompt":"hello"}\n' }))
      await new Promise((r) => setTimeout(r, 20))

      assert.ok(capturedStdin.length > 0, 'expected at least one stdin chunk')
      assert.ok(
        capturedStdin.join('').includes('{"prompt":"hello"}\n'),
        `expected stdin data forwarded, got: ${JSON.stringify(capturedStdin)}`,
      )

      ws.close()
    })

    it('forwards multiple stdin frames in order', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 20))

      ws.send(JSON.stringify({ type: 'stdin', data: 'line1\n' }))
      ws.send(JSON.stringify({ type: 'stdin', data: 'line2\n' }))
      ws.send(JSON.stringify({ type: 'stdin', data: 'line3\n' }))
      await new Promise((r) => setTimeout(r, 30))

      const received = capturedStdin.join('')
      const idx1 = received.indexOf('line1\n')
      const idx2 = received.indexOf('line2\n')
      const idx3 = received.indexOf('line3\n')
      assert.ok(idx1 >= 0, `expected line1 in stdin, got: ${received}`)
      assert.ok(idx2 >= 0, `expected line2 in stdin, got: ${received}`)
      assert.ok(idx3 >= 0, `expected line3 in stdin, got: ${received}`)
      assert.ok(idx1 < idx2, `expected line1 before line2, got offsets ${idx1} ${idx2}`)
      assert.ok(idx2 < idx3, `expected line2 before line3, got offsets ${idx2} ${idx3}`)

      ws.close()
    })

    it('stdin_end closes child.stdin', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 20))

      let stdinEnded = false
      child.stdin.once('finish', () => { stdinEnded = true })

      ws.send(JSON.stringify({ type: 'stdin', data: 'some input\n' }))
      ws.send(JSON.stringify({ type: 'stdin_end' }))
      await new Promise((r) => setTimeout(r, 30))

      assert.ok(stdinEnded, 'child.stdin should have ended after stdin_end frame')
      assert.ok(child.stdin.writableEnded, 'child.stdin.writableEnded should be true')

      ws.close()
    })

    it('stdin frame before spawn returns error', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      const msgsPromise = waitForMessages(ws, 1)
      ws.send(JSON.stringify({ type: 'stdin', data: 'hello\n' }))

      const msgs = await msgsPromise
      assert.equal(msgs[0].type, 'error')
      assert.match(msgs[0].message, /no active session/)

      ws.close()
    })

    it('stdin_end before spawn returns error', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      const msgsPromise = waitForMessages(ws, 1)
      ws.send(JSON.stringify({ type: 'stdin_end' }))

      const msgs = await msgsPromise
      assert.equal(msgs[0].type, 'error')
      assert.match(msgs[0].message, /no active session/)

      ws.close()
    })

    it('stdin frame with non-string data returns error', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 20))

      const msgsPromise = waitForDataMessages(ws, 1)
      ws.send(JSON.stringify({ type: 'stdin', data: 42 }))

      const msgs = await msgsPromise
      assert.equal(msgs[0].type, 'error')
      assert.match(msgs[0].message, /data must be a string/)

      ws.close()
    })
  })

  // ---------------------------------------------------------------------------
  // stdin backpressure (#3396)
  //
  // child.stdin.write() returns false when the writable's internal buffer hits
  // highWaterMark.  The agent must pause WS message delivery and resume on
  // 'drain' so a fast client cannot grow the stdin buffer without bound.
  // ---------------------------------------------------------------------------

  describe('stdin backpressure', () => {
    let agent, port, child, fakeStdin

    beforeEach(async () => {
      child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()

      // Fake stdin that lets the test control write() return value and emit
      // 'drain' deterministically.  Behaves like a Writable for the agent's
      // purposes (write returns bool, once('drain', cb) attaches a listener).
      fakeStdin = new EventEmitter()
      fakeStdin.writes = []
      fakeStdin.nextWriteOk = true
      fakeStdin.write = (data) => {
        fakeStdin.writes.push(data)
        return fakeStdin.nextWriteOk
      }
      fakeStdin.end = () => { fakeStdin.ended = true }
      child.stdin = fakeStdin

      child.killSignals = []
      child.kill = (signal) => { child.killSignals.push(signal); return true }

      const spawnFn = (_cmd, _args, _opts) => child
      ;({ agent, port } = await startAgent({ spawnFn }))
    })

    afterEach(() => agent.close())

    it('pauses ws and resumes on drain when stdin.write returns false', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 20))

      // Locate the server-side ws so we can assert pause/resume on it. The
      // test client's WebSocket is the *connecting* end; the agent receives
      // the upgraded socket via its own WebSocketServer.  We patch the
      // agent's _activeWs.pause/resume to record calls.
      const serverWs = agent._activeWs
      assert.ok(serverWs, 'expected agent to have an active WS')
      const calls = []
      const origPause = serverWs.pause.bind(serverWs)
      const origResume = serverWs.resume.bind(serverWs)
      serverWs.pause = () => { calls.push('pause'); return origPause() }
      serverWs.resume = () => { calls.push('resume'); return origResume() }

      // First write returns false → agent should pause and arm a drain listener.
      fakeStdin.nextWriteOk = false
      ws.send(JSON.stringify({ type: 'stdin', data: 'first chunk\n' }))
      await new Promise((r) => setTimeout(r, 30))

      assert.equal(fakeStdin.writes.length, 1, 'first write should reach stdin')
      assert.deepEqual(calls, ['pause'], 'ws should be paused after write returned false')
      const session = agent._sessions.get(serverWs._sessionId)
      assert.ok(session._stdinDraining, 'session should be flagged as draining')

      // Drain emits → agent resumes the WS and clears the flag.
      fakeStdin.emit('drain')
      await new Promise((r) => setTimeout(r, 20))

      assert.deepEqual(calls, ['pause', 'resume'], 'ws should resume on drain')
      assert.equal(session._stdinDraining, false, 'draining flag should clear on drain')

      ws.close()
    })

    it('does not register a second drain listener while already draining', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 20))

      const serverWs = agent._activeWs
      let pauseCount = 0
      const origPause = serverWs.pause.bind(serverWs)
      serverWs.pause = () => { pauseCount += 1; return origPause() }

      // Both writes return false. The first arms the drain listener and
      // pauses the WS; the second must not pause again or stack drain
      // listeners (would leak handlers and trigger spurious resume() calls).
      fakeStdin.nextWriteOk = false
      ws.send(JSON.stringify({ type: 'stdin', data: 'a\n' }))
      ws.send(JSON.stringify({ type: 'stdin', data: 'b\n' }))
      await new Promise((r) => setTimeout(r, 30))

      assert.equal(fakeStdin.writes.length, 2, 'both writes should reach stdin')
      assert.equal(pauseCount, 1, 'ws.pause should be called only once while draining')
      assert.equal(fakeStdin.listenerCount('drain'), 1, 'only one drain listener should be armed')

      ws.close()
    })

    it('write returning true keeps ws flowing without pause', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 20))

      const serverWs = agent._activeWs
      let pauseCalls = 0
      const origPause = serverWs.pause.bind(serverWs)
      serverWs.pause = () => { pauseCalls += 1; return origPause() }

      fakeStdin.nextWriteOk = true
      ws.send(JSON.stringify({ type: 'stdin', data: 'happy\n' }))
      await new Promise((r) => setTimeout(r, 20))

      assert.equal(fakeStdin.writes.length, 1)
      assert.equal(pauseCalls, 0, 'ws.pause should not be called when write returns true')
      const session = agent._sessions.get(serverWs._sessionId)
      assert.equal(session._stdinDraining, false)

      ws.close()
    })

    it('disconnect during draining does not call resume on stale ws', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 20))

      const serverWs = agent._activeWs
      let resumeCalls = 0
      serverWs.resume = () => { resumeCalls += 1 }

      // Trigger the backpressure path.
      fakeStdin.nextWriteOk = false
      ws.send(JSON.stringify({ type: 'stdin', data: 'x\n' }))
      await new Promise((r) => setTimeout(r, 20))

      const session = agent._sessions.get(serverWs._sessionId)
      assert.ok(session._stdinDraining)

      // Detach the WS as the cleanup path would on disconnect.
      session.activeWs = null

      // Drain fires after the WS is gone — the listener must clear the flag
      // but skip resume() on the now-null activeWs.
      fakeStdin.emit('drain')
      await new Promise((r) => setTimeout(r, 10))

      assert.equal(resumeCalls, 0, 'resume must not run when activeWs is null')
      assert.equal(session._stdinDraining, false, 'draining flag should clear even without ws')

      ws.close()
    })
  })

  // ---------------------------------------------------------------------------
  // Stdin drain stall detection — wedged child guard (#3476)
  //
  // PR #3475 introduced cooperative backpressure that calls ws.pause() when
  // child.stdin.write() returns false and resumes on the next 'drain' event.
  // A wedged child (accepts input but never reads from stdin) never emits
  // 'drain' — without a timeout the WS stays paused indefinitely.
  //
  // The agent arms a per-session timer when _stdinDraining flips true. If
  // 'drain' does not arrive within CHROXY_AGENT_STDIN_DRAIN_TIMEOUT_MS the
  // session emits a stdin_drain_stalled error frame, kills the child, and
  // closes the WS with code 1011.
  // ---------------------------------------------------------------------------

  describe('stdin drain stall detection', () => {
    /**
     * Reusable deterministic fake clock — same shape as the one used by the
     * idle-resume TTL describe block below. Hoisted here so we don't need
     * forward references across describe scopes.
     */
    function makeFakeClock() {
      let now = 0
      const pending = []
      function fakeSetTimeout(fn, delay) {
        const handle = { _fn: fn, _at: now + delay, _cancelled: false, unref() {} }
        pending.push(handle)
        return handle
      }
      function fakeClearTimeout(handle) {
        if (handle) handle._cancelled = true
      }
      function advance(ms) {
        now += ms
        const due = pending
          .filter((h) => !h._cancelled && h._at <= now)
          .sort((a, b) => a._at - b._at)
        for (const h of due) {
          h._cancelled = true
          h._fn()
        }
      }
      return { fakeSetTimeout, fakeClearTimeout, advance }
    }

    function makeFakeChild() {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      const fakeStdin = new EventEmitter()
      fakeStdin.writes = []
      fakeStdin.nextWriteOk = true
      fakeStdin.writableEnded = false
      fakeStdin.write = (data) => {
        fakeStdin.writes.push(data)
        return fakeStdin.nextWriteOk
      }
      fakeStdin.end = () => { fakeStdin.writableEnded = true; fakeStdin.ended = true }
      child.stdin = fakeStdin
      child.killSignals = []
      child.kill = (signal) => { child.killSignals.push(signal); return true }
      return { child, fakeStdin }
    }

    it('emits stdin_drain_stalled error frame after timeout when no drain arrives', async () => {
      const clock = makeFakeClock()
      const TIMEOUT_MS = 1000
      const STDIN_CLOSE_MS = 25
      const KILL_GRACE_MS = 25
      const { child, fakeStdin } = makeFakeChild()
      const { agent, port } = await startAgent({
        spawnFn: () => child,
        stdinDrainTimeoutMs: TIMEOUT_MS,
        stdinCloseGraceMs: STDIN_CLOSE_MS,
        killGraceMs: KILL_GRACE_MS,
        setTimeoutFn: clock.fakeSetTimeout,
        clearTimeoutFn: clock.fakeClearTimeout,
      })

      try {
        const ws = connect(port, TOKEN)
        const collected = collectUntilClose(ws, 3000)
        await waitOpen(ws)

        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 20))

        // Trigger backpressure path — write returns false so drain timer arms.
        fakeStdin.nextWriteOk = false
        ws.send(JSON.stringify({ type: 'stdin', data: 'wedge\n' }))
        await new Promise((r) => setTimeout(r, 20))

        const session = agent._sessions.get(agent._activeWs._sessionId)
        assert.ok(session._stdinDraining, 'session must be flagged as draining')
        assert.ok(session._stdinDrainTimer, 'drain timer must be armed once draining')

        // Advance partway through — nothing fires yet.
        clock.advance(TIMEOUT_MS - 1)
        assert.equal(child.killSignals.length, 0, 'child must not be killed before timeout')

        // Cross the drain timeout boundary — _handleStdinDrainStalled fires
        // synchronously: error frame is queued on ws.send, child.stdin.end()
        // is called, and the SIGTERM grace timer is armed on the fake clock.
        clock.advance(2)

        // SIGTERM is scheduled inside _killChild via the fake clock — advance
        // past the stdin-close grace so SIGTERM lands deterministically.
        clock.advance(STDIN_CLOSE_MS + 1)

        const { messages, closeCode } = await collected

        const errFrame = messages.find((m) => m.type === 'error' && m.code === 'stdin_drain_stalled')
        assert.ok(
          errFrame,
          `expected error frame with code=stdin_drain_stalled, got ${JSON.stringify(messages)}`,
        )
        assert.match(errFrame.message, /did not drain/)
        assert.ok(typeof errFrame.seq === 'number', 'session-scoped error must carry a seq')

        assert.equal(closeCode, 1011, `WS should close with 1011, got ${closeCode}`)
        assert.ok(
          child.killSignals.includes('SIGTERM'),
          `child must be SIGTERM-killed on drain stall, got ${JSON.stringify(child.killSignals)}`,
        )
        assert.equal(agent._sessions.size, 0, 'session must be removed after drain stall')
      } finally {
        await agent.close()
      }
    })

    it('drain event before timeout cancels the drain timer cleanly', async () => {
      const clock = makeFakeClock()
      const TIMEOUT_MS = 1000
      const { child, fakeStdin } = makeFakeChild()
      const { agent, port } = await startAgent({
        spawnFn: () => child,
        stdinDrainTimeoutMs: TIMEOUT_MS,
        setTimeoutFn: clock.fakeSetTimeout,
        clearTimeoutFn: clock.fakeClearTimeout,
      })

      try {
        const ws = connect(port, TOKEN)
        await waitOpen(ws)
        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 20))

        fakeStdin.nextWriteOk = false
        ws.send(JSON.stringify({ type: 'stdin', data: 'a\n' }))
        await new Promise((r) => setTimeout(r, 20))

        const session = agent._sessions.get(agent._activeWs._sessionId)
        assert.ok(session._stdinDrainTimer, 'drain timer must be armed')

        // Drain arrives before the timeout — timer must be cancelled.
        fakeStdin.emit('drain')
        await new Promise((r) => setTimeout(r, 10))

        assert.equal(session._stdinDrainTimer, null, 'drain timer must be cleared on drain')
        assert.equal(session._stdinDraining, false, 'draining flag must clear on drain')

        // Advance past the original timeout — must not fire because cancelled.
        clock.advance(TIMEOUT_MS + 100)
        assert.equal(
          child.killSignals.length,
          0,
          `child must NOT be killed after drain cancelled the timer, got ${JSON.stringify(child.killSignals)}`,
        )
        assert.equal(agent._sessions.size, 1, 'session must still be alive')

        ws.close()
      } finally {
        await agent.close()
      }
    })

    it('does not arm a second drain timer while one is already running', async () => {
      const clock = makeFakeClock()
      const TIMEOUT_MS = 1000
      const { child, fakeStdin } = makeFakeChild()
      const { agent, port } = await startAgent({
        spawnFn: () => child,
        stdinDrainTimeoutMs: TIMEOUT_MS,
        setTimeoutFn: clock.fakeSetTimeout,
        clearTimeoutFn: clock.fakeClearTimeout,
      })

      try {
        const ws = connect(port, TOKEN)
        await waitOpen(ws)
        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 20))

        fakeStdin.nextWriteOk = false
        ws.send(JSON.stringify({ type: 'stdin', data: 'a\n' }))
        ws.send(JSON.stringify({ type: 'stdin', data: 'b\n' }))
        await new Promise((r) => setTimeout(r, 20))

        const session = agent._sessions.get(agent._activeWs._sessionId)
        const initialHandle = session._stdinDrainTimer
        assert.ok(initialHandle, 'first backpressured write must arm a drain timer')

        // The session-level guard means re-entering the backpressure branch is
        // already prevented by _stdinDraining; verify the drain-timer field
        // identity has not been replaced.
        assert.strictEqual(
          session._stdinDrainTimer,
          initialHandle,
          'second backpressured write must not replace the drain timer handle',
        )

        // Mirror the sibling backpressure assertion (#3509): the once-listener
        // for 'drain' must remain at exactly one. If a refactor of
        // _armStdinDrainTimer ever drops the _stdinDraining guard around the
        // listener registration, this catches the leak immediately.
        assert.equal(
          fakeStdin.listenerCount('drain'),
          1,
          'second backpressured write must not stack a duplicate drain listener',
        )

        ws.close()
      } finally {
        await agent.close()
      }
    })

    it('agent.close() cancels pending drain timers', async () => {
      const clock = makeFakeClock()
      const TIMEOUT_MS = 1000
      const { child, fakeStdin } = makeFakeChild()
      const { agent, port } = await startAgent({
        spawnFn: () => child,
        stdinDrainTimeoutMs: TIMEOUT_MS,
        killGraceMs: 25,
        setTimeoutFn: clock.fakeSetTimeout,
        clearTimeoutFn: clock.fakeClearTimeout,
      })

      const ws = connect(port, TOKEN)
      await waitOpen(ws)
      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 20))

      fakeStdin.nextWriteOk = false
      ws.send(JSON.stringify({ type: 'stdin', data: 'x\n' }))
      await new Promise((r) => setTimeout(r, 20))

      // Snapshot the live drain-timer handle BEFORE close — agent.close()
      // clears _sessions, after which there is no way to read it back.
      const session = agent._sessions.get(agent._activeWs._sessionId)
      const drainTimer = session._stdinDrainTimer
      assert.ok(drainTimer, 'backpressured write must arm a drain timer before close')
      assert.equal(drainTimer._cancelled, false, 'timer must be live before close')

      await agent.close()

      // The actual cancellation invariant: agent.close() must call
      // _cancelStdinDrainTimer (which routes through the fake clearTimeout
      // and flips _cancelled to true). If line 331 of agent.js ever loses
      // the _cancelStdinDrainTimer(session) call, this assertion fails.
      assert.equal(
        drainTimer._cancelled,
        true,
        'agent.close() must cancel pending drain timers (drainTimer._cancelled stayed false)',
      )

      // Belt-and-braces: advancing past the original timeout must not run a
      // stale callback — clock.advance filters out _cancelled handles.
      const sessionsBeforeAdvance = agent._sessions.size
      assert.doesNotThrow(() => clock.advance(TIMEOUT_MS + 100))
      assert.equal(agent._sessions.size, sessionsBeforeAdvance, 'no session should reappear after close')
    })

    it('child close after stdin_drain_stalled does not emit exit/close 1000 (#3513)', async () => {
      // Regression: previously the child 'close' handler would fire after
      // _handleStdinDrainStalled killed the child, racing with the terminal
      // error path. Clients could observe exit + close(1000) instead of the
      // intended stdin_drain_stalled error + close(1011).
      //
      // After the fix, _handleStdinDrainStalled sets session._terminalErrorSent
      // before kill, and the child 'close' handler returns early when the flag
      // is set — mirroring the existing _oversized guard.
      //
      // To exercise the race deterministically we instrument session.activeWs
      // with a fake whose send() defers its callback by a macrotask (mirroring
      // the line_too_long #3399 test). That widens the window so the child
      // 'close' fires BEFORE the error frame's send callback runs the
      // close(1011) — which is precisely the scenario where the unguarded
      // close handler would emit exit + close(1000).
      const clock = makeFakeClock()
      const TIMEOUT_MS = 1000
      const STDIN_CLOSE_MS = 25
      const KILL_GRACE_MS = 25
      const { child, fakeStdin } = makeFakeChild()
      const { agent, port } = await startAgent({
        spawnFn: () => child,
        stdinDrainTimeoutMs: TIMEOUT_MS,
        stdinCloseGraceMs: STDIN_CLOSE_MS,
        killGraceMs: KILL_GRACE_MS,
        setTimeoutFn: clock.fakeSetTimeout,
        clearTimeoutFn: clock.fakeClearTimeout,
      })

      try {
        const ws = connect(port, TOKEN)
        await waitOpen(ws)

        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 20))

        // Replace session.activeWs with an instrumented fake that defers send
        // callbacks. Forces the close-after-flush callback to run AFTER the
        // child 'close' event, which is the race the guard must protect.
        const callLog = []
        const fakeWs = {
          readyState: 1,
          send(data, cb) {
            const frame = JSON.parse(data)
            callLog.push({ op: 'send', type: frame.type, code: frame.code })
            if (cb) {
              setTimeout(() => { callLog.push({ op: 'send_cb_fired', code: frame.code }); cb() }, 30)
            }
          },
          close(code, reason) { callLog.push({ op: 'close', code, reason }) },
          pause() {},
          resume() {},
          terminate() {},
        }
        const session = agent._sessions.get(agent._activeWs._sessionId)
        session.activeWs = fakeWs

        // Trigger backpressure path so the drain timer arms.
        fakeStdin.nextWriteOk = false
        ws.send(JSON.stringify({ type: 'stdin', data: 'wedge\n' }))
        await new Promise((r) => setTimeout(r, 20))

        // Cross the drain timeout — _handleStdinDrainStalled fires synchronously
        // on the fake clock: queues the error frame on fake send (cb deferred
        // 30ms), then arms the SIGTERM timer.
        clock.advance(TIMEOUT_MS + 1)
        // Advance past stdin-close grace so SIGTERM lands and child._chroxyKilled
        // is set. The fake child won't emit 'close' on its own here, so we emit
        // it manually below to simulate the race window.
        clock.advance(STDIN_CLOSE_MS + 1)

        // Fire child 'close' BEFORE the deferred send_cb (still pending for
        // ~30ms). Without the _terminalErrorSent guard this would call
        // _emitSessionFrame(exit) and close(1000) on the fake ws.
        child.emit('close', -15)

        // Now wait for the deferred error-frame send callback to fire and
        // run the close(1011) path.
        await new Promise((r) => setTimeout(r, 60))

        // The error frame must be present.
        const errSend = callLog.find((e) => e.op === 'send' && e.code === 'stdin_drain_stalled')
        assert.ok(errSend, `expected send(stdin_drain_stalled), log=${JSON.stringify(callLog)}`)

        // No exit frame must be sent on the fake ws — the close handler must
        // return early because _terminalErrorSent is set.
        const exitSend = callLog.find((e) => e.op === 'send' && e.type === 'exit')
        assert.equal(
          exitSend,
          undefined,
          `child 'close' must not emit exit after stdin_drain_stalled, log=${JSON.stringify(callLog)}`,
        )

        // The only close on the fake ws must be 1011 — not 1000.
        const closeOps = callLog.filter((e) => e.op === 'close')
        assert.ok(closeOps.length >= 1, `expected at least one close call, log=${JSON.stringify(callLog)}`)
        for (const c of closeOps) {
          assert.equal(
            c.code,
            1011,
            `every close must use 1011 (not 1000), got ${c.code}, log=${JSON.stringify(callLog)}`,
          )
        }

        try { ws.close() } catch {}
      } finally {
        await agent.close()
      }
    })

    it('env var override: valid CHROXY_AGENT_STDIN_DRAIN_TIMEOUT_MS is respected', () => {
      // Constructor-arg test exercises the same validation pathway as the
      // env-var parser (both flow through Number.isFinite + > 0 checks
      // against FALLBACK_STDIN_DRAIN_TIMEOUT_MS).
      const agent = new PodAgent({ token: TOKEN, stdinDrainTimeoutMs: 5000 })
      assert.equal(agent._stdinDrainTimeoutMs, 5000)
      agent.close()
    })

    it('env var override: invalid (NaN/<=0) falls back to 30s default', () => {
      for (const bad of [NaN, 0, -1, -1000]) {
        const agent = new PodAgent({ token: TOKEN, stdinDrainTimeoutMs: bad })
        assert.equal(
          agent._stdinDrainTimeoutMs,
          30_000,
          `expected fallback to 30000ms for ${bad}, got ${agent._stdinDrainTimeoutMs}`,
        )
        agent.close()
      }
    })

    it('env var override: missing falls back to 30s default', () => {
      // Constructor with no override uses module-level DEFAULT.
      const agent = new PodAgent({ token: TOKEN })
      assert.equal(agent._stdinDrainTimeoutMs, 30_000)
      agent.close()
    })

    it('exported DEFAULT_STDIN_DRAIN_TIMEOUT_MS is positive finite', () => {
      assert.ok(
        Number.isFinite(DEFAULT_STDIN_DRAIN_TIMEOUT_MS) && DEFAULT_STDIN_DRAIN_TIMEOUT_MS > 0,
        `DEFAULT_STDIN_DRAIN_TIMEOUT_MS must be positive finite, got ${DEFAULT_STDIN_DRAIN_TIMEOUT_MS}`,
      )
    })

    // -------------------------------------------------------------------------
    // Drain timer cancellation invariant on every kill path (#3514)
    //
    // _killChild itself does not cancel the per-session drain timer (it only
    // takes a child handle, not a session). Each kill caller must therefore
    // cancel _stdinDrainTimer synchronously before tearing the session down,
    // otherwise the timer can fire post-teardown and re-enter
    // _handleStdinDrainStalled with a stale child reference.
    //
    // These tests assert that — after each kill path runs — advancing the
    // fake clock past the original drain timeout produces NO additional kill
    // signals, NO re-entry into the drain-stalled handler, and NO change to
    // the session map. The cancellation invariant is what we test, not the
    // tear-down side effects (those are covered by other suites).
    // -------------------------------------------------------------------------

    describe('drain timer cancelled on every kill path (#3514)', () => {
      /**
       * Spawn a session and arm the drain timer directly via the internal
       * helper. We avoid driving the backpressure path through ws.send()
       * here because it pauses the WS — once paused, the agent cannot
       * process subsequent frames (including close), which breaks tests
       * that need to simulate a clean disconnect to drive idle TTL or
       * session-cap eviction. Calling _armStdinDrainTimer directly arms
       * the same timer the production code arms; the kill paths under
       * test do not care HOW the timer was armed, only THAT it was.
       */
      async function setupDrainArmed({ stdinDrainTimeoutMs = 1000, ...extraOpts } = {}) {
        const clock = makeFakeClock()
        const { child, fakeStdin } = makeFakeChild()
        const { agent, port } = await startAgent({
          spawnFn: () => child,
          stdinDrainTimeoutMs,
          stdinCloseGraceMs: 25,
          killGraceMs: 25,
          setTimeoutFn: clock.fakeSetTimeout,
          clearTimeoutFn: clock.fakeClearTimeout,
          ...extraOpts,
        })
        const ws = connect(port, TOKEN)
        await waitOpen(ws)
        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 20))

        const session = agent._sessions.get(agent._activeWs._sessionId)
        assert.ok(session, 'session must be registered after spawn')

        // Arm the drain timer directly (mirrors what _handleStdin does on
        // a backpressured write, minus the ws.pause() that would block
        // close-frame propagation).
        session._stdinDraining = true
        agent._armStdinDrainTimer(session)
        assert.ok(session._stdinDrainTimer, 'drain timer must be armed before kill path')

        return { agent, port, ws, child, fakeStdin, session, clock, stdinDrainTimeoutMs }
      }

      it('idle TTL eviction cancels the drain timer before _killChild', async () => {
        const RESUME_MS = 50
        const { agent, ws, session, clock, stdinDrainTimeoutMs } = await setupDrainArmed({
          resumeTimeoutMs: RESUME_MS,
        })

        // Capture the drain timer handle BEFORE eviction so we can assert
        // `_cancelled = true` independently of `session._stdinDrainTimer`
        // being nulled.
        const drainHandle = session._stdinDrainTimer

        // Disconnect the WS and wait for the agent-side close to fire
        // _cleanupConnection (which arms the idle TTL timer). The WS close
        // handshake is asynchronous so we wait on the client-side 'close'
        // event then poll briefly for the server-side state update.
        const clientClosed = once(ws, 'close')
        ws.close()
        await clientClosed
        for (let i = 0; i < 50 && session.activeWs !== null; i++) {
          await new Promise((r) => setTimeout(r, 10))
        }
        assert.equal(session.activeWs, null, 'activeWs must be cleared after disconnect')

        // Fire the idle TTL timer.
        clock.advance(RESUME_MS + 1)

        assert.equal(
          session._stdinDrainTimer,
          null,
          'idle TTL eviction must cancel _stdinDrainTimer synchronously',
        )
        assert.ok(
          drainHandle._cancelled,
          'drain timer handle must have been clearTimeout-cancelled by eviction',
        )
        assert.equal(agent._sessions.size, 0, 'session removed by idle eviction')

        // Advancing well past the original drain deadline must not re-enter
        // _handleStdinDrainStalled — the timer is cancelled so its callback
        // cannot run. (Other timers from _killChild's SIGTERM/SIGKILL grace
        // are expected to fire here; the invariant is the drain timer.)
        clock.advance(stdinDrainTimeoutMs + 1000)
        assert.equal(
          session._stdinDrainTimer,
          null,
          'drain timer must remain null after fake clock advances past original deadline',
        )

        await agent.close()
      })

      it('session-cap eviction cancels the drain timer before _killChild', async () => {
        // maxSessions=1 so the second spawn evicts the first session.
        const clock = makeFakeClock()
        const { child: firstChild } = makeFakeChild()
        const { child: secondChild } = makeFakeChild()
        const spawns = [firstChild, secondChild]
        const { agent, port } = await startAgent({
          maxSessions: 1,
          stdinDrainTimeoutMs: 1000,
          stdinCloseGraceMs: 25,
          killGraceMs: 25,
          setTimeoutFn: clock.fakeSetTimeout,
          clearTimeoutFn: clock.fakeClearTimeout,
          spawnFn: () => spawns.shift(),
        })

        try {
          // First connection: spawn → arm drain timer directly → disconnect
          // (so the session goes idle and becomes the eviction target for
          // the cap). We arm the drain timer via _armStdinDrainTimer rather
          // than ws.send(stdin) so the WS is not paused — a paused WS would
          // refuse to process the subsequent close frame.
          const ws1 = connect(port, TOKEN)
          await waitOpen(ws1)
          ws1.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
          await new Promise((r) => setTimeout(r, 20))

          const firstSessionId = agent._activeWs._sessionId
          const firstSession = agent._sessions.get(firstSessionId)
          firstSession._stdinDraining = true
          agent._armStdinDrainTimer(firstSession)
          assert.ok(firstSession._stdinDrainTimer, 'drain timer armed on first session')
          const drainHandle = firstSession._stdinDrainTimer

          // Wait for the WS close to propagate to the agent so the first
          // session is treated as idle (activeWs == null) by the cap
          // enforcer's "prefer idle sessions" branch.
          const ws1Closed = once(ws1, 'close')
          ws1.close()
          await ws1Closed
          for (let i = 0; i < 50 && firstSession.activeWs !== null; i++) {
            await new Promise((r) => setTimeout(r, 10))
          }
          assert.equal(firstSession.activeWs, null, 'first session must be idle before cap eviction')

          // Second connection: spawn — _enforceSessionCap must evict the
          // first idle session and that path must cancel the drain timer.
          const ws2 = connect(port, TOKEN)
          await waitOpen(ws2)
          ws2.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
          // Poll for the eviction to run (spawn -> enforceSessionCap ->
          // evictSession runs synchronously, but we still need to give the
          // server-side message handler time to dispatch).
          for (let i = 0; i < 50 && agent._sessions.has(firstSessionId); i++) {
            await new Promise((r) => setTimeout(r, 10))
          }

          assert.equal(
            firstSession._stdinDrainTimer,
            null,
            'session-cap eviction must cancel _stdinDrainTimer synchronously',
          )
          assert.ok(
            drainHandle._cancelled,
            'drain timer handle must be clearTimeout-cancelled by cap eviction',
          )
          assert.ok(
            !agent._sessions.has(firstSessionId),
            'first session removed by cap eviction',
          )

          // Advance past the original drain timeout — _handleStdinDrainStalled
          // must not re-enter (timer is cancelled, callback cannot fire).
          clock.advance(1000 + 1000)
          assert.equal(
            firstSession._stdinDrainTimer,
            null,
            'drain timer must remain null after fake clock advances past original deadline',
          )

          ws2.close()
        } finally {
          await agent.close()
        }
      })

      it('oversized-line kill path cancels the drain timer before _killChild', async () => {
        // Use a real PassThrough for stdout so the LineLimitTransform fires;
        // override stdin with a fake writable so we can force backpressure
        // and arm the drain timer first.
        const clock = makeFakeClock()
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        const fakeStdin = new EventEmitter()
        fakeStdin.nextWriteOk = false
        fakeStdin.writableEnded = false
        fakeStdin.write = () => fakeStdin.nextWriteOk
        fakeStdin.end = () => { fakeStdin.writableEnded = true }
        child.stdin = fakeStdin
        child.killSignals = []
        child.kill = (signal) => { child.killSignals.push(signal); return true }

        const { agent, port } = await startAgent({
          spawnFn: () => child,
          stdinDrainTimeoutMs: 1000,
          stdinCloseGraceMs: 25,
          killGraceMs: 25,
          maxLineBytes: 16,
          setTimeoutFn: clock.fakeSetTimeout,
          clearTimeoutFn: clock.fakeClearTimeout,
        })

        try {
          const ws = connect(port, TOKEN)
          await waitOpen(ws)
          ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
          await new Promise((r) => setTimeout(r, 20))

          ws.send(JSON.stringify({ type: 'stdin', data: 'wedge\n' }))
          await new Promise((r) => setTimeout(r, 20))

          const session = agent._sessions.get(agent._activeWs._sessionId)
          assert.ok(session._stdinDrainTimer, 'drain timer must be armed before oversized line')
          const drainHandle = session._stdinDrainTimer

          // Trigger oversized_line — kill path runs synchronously and
          // cancels the drain timer BEFORE _killChild (this PR's fix).
          child.stdout.write(Buffer.from('A'.repeat(17)))

          // The cancel must happen synchronously — no awaits between the
          // write and this assertion. (LineLimitTransform emits
          // 'oversized_line' synchronously inside _transform.)
          assert.equal(
            session._stdinDrainTimer,
            null,
            'oversized-line kill path must cancel _stdinDrainTimer synchronously (not just in ws.send callback)',
          )
          assert.ok(
            drainHandle._cancelled,
            'drain timer handle must be clearTimeout-cancelled by oversized-line kill path',
          )

          // Advance past the original drain deadline — _handleStdinDrainStalled
          // must not re-enter (timer is cancelled).
          clock.advance(1000 + 1000)
          assert.equal(
            session._stdinDrainTimer,
            null,
            'drain timer must remain null after fake clock advances past original deadline',
          )

          ws.close()
        } finally {
          await agent.close()
        }
      })

      it("child 'error' (async spawn failure) cancels the drain timer synchronously", async () => {
        const { agent, child, session, clock, stdinDrainTimeoutMs } = await setupDrainArmed()
        const drainHandle = session._stdinDrainTimer

        // Simulate an async spawn failure — child emits 'error' (e.g. ENOENT
        // arriving after the synchronous spawn returned).
        child.emit('error', new Error('ENOENT: no such file'))

        // The cancel must happen synchronously, not only inside the
        // post-flush ws.send callback.
        assert.equal(
          session._stdinDrainTimer,
          null,
          "child 'error' handler must cancel _stdinDrainTimer synchronously",
        )
        assert.ok(
          drainHandle._cancelled,
          "drain timer handle must be clearTimeout-cancelled by child 'error'",
        )

        // Advance past the original drain deadline — _handleStdinDrainStalled
        // must not re-enter (callback can no longer run).
        clock.advance(stdinDrainTimeoutMs + 1000)
        assert.equal(
          session._stdinDrainTimer,
          null,
          'drain timer must remain null after fake clock advances past original deadline',
        )

        await agent.close()
      })

      it("child 'close' (natural exit) cancels the drain timer synchronously", async () => {
        const { agent, child, session, clock, stdinDrainTimeoutMs } = await setupDrainArmed()
        const drainHandle = session._stdinDrainTimer

        // Child exits naturally before the drain timeout fires.
        child.emit('close', 0)

        assert.equal(
          session._stdinDrainTimer,
          null,
          "child 'close' handler must cancel _stdinDrainTimer synchronously",
        )
        assert.ok(
          drainHandle._cancelled,
          "drain timer handle must be clearTimeout-cancelled by child 'close'",
        )

        // Advance past the original drain deadline — _handleStdinDrainStalled
        // must not re-enter (callback can no longer run).
        clock.advance(stdinDrainTimeoutMs + 1000)
        assert.equal(
          session._stdinDrainTimer,
          null,
          'drain timer must remain null after fake clock advances past original deadline',
        )

        await agent.close()
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Idle-resume TTL eviction (#3349)
  // ---------------------------------------------------------------------------

  describe('idle-resume TTL eviction', () => {
    /**
     * Deterministic fake timer: exposes `advance(ms)` to fire pending callbacks
     * without actually waiting.  Returned handles have a no-op `.unref()` so the
     * idempotent guard in _startIdleTimer works normally.
     */
    function makeFakeClock() {
      let now = 0
      const pending = []

      function fakeSetTimeout(fn, delay) {
        const handle = { _fn: fn, _at: now + delay, _cancelled: false, unref() {} }
        pending.push(handle)
        return handle
      }

      function fakeClearTimeout(handle) {
        if (handle) handle._cancelled = true
      }

      function advance(ms) {
        now += ms
        // Fire all callbacks that have become due (sorted earliest-first for
        // deterministic ordering when multiple timers share the same deadline).
        const due = pending
          .filter((h) => !h._cancelled && h._at <= now)
          .sort((a, b) => a._at - b._at)
        for (const h of due) {
          h._cancelled = true
          h._fn()
        }
      }

      return { fakeSetTimeout, fakeClearTimeout, advance }
    }

    it('idle timer fires after TTL and kills the child + drops session', async () => {
      const clock = makeFakeClock()
      const TTL = 200
      const mock2 = createMockSpawn()
      const child2 = mock2.child
      const { agent: ttlAgent, port: ttlPort } = await startAgent({
        spawnFn: mock2.spawnFn,
        killGraceMs: 25,
        resumeTimeoutMs: TTL,
        setTimeoutFn: clock.fakeSetTimeout,
        clearTimeoutFn: clock.fakeClearTimeout,
      })

      try {
        const ws = connect(ttlPort, TOKEN)
        await waitOpen(ws)

        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 20))

        // Disconnect — should arm the idle timer.
        ws.close()
        await new Promise((r) => setTimeout(r, 30))

        // Verify session is still in the map (timer hasn't fired yet).
        assert.equal(ttlAgent._sessions.size, 1, 'session must still exist before TTL expires')

        // Advance clock past the TTL.
        clock.advance(TTL + 1)

        // Timer callback is synchronous — session should be gone immediately.
        assert.equal(ttlAgent._sessions.size, 0, 'session must be evicted after TTL expires')
        assert.ok(
          child2.killSignals.includes('SIGTERM'),
          `child must be killed on TTL eviction, got ${JSON.stringify(child2.killSignals)}`,
        )
      } finally {
        await ttlAgent.close()
      }
    })

    it('resume before TTL cancels the idle timer', async () => {
      const clock = makeFakeClock()
      const TTL = 500
      const mock2 = createMockSpawn()
      const { agent: ttlAgent, port: ttlPort } = await startAgent({
        spawnFn: mock2.spawnFn,
        killGraceMs: 25,
        resumeTimeoutMs: TTL,
        setTimeoutFn: clock.fakeSetTimeout,
        clearTimeoutFn: clock.fakeClearTimeout,
      })

      try {
        const ws1 = connect(ttlPort, TOKEN)
        await waitOpen(ws1)

        const ws1Msgs = []
        ws1.on('message', (d) => {
          try { ws1Msgs.push(JSON.parse(d.toString())) } catch {}
        })

        ws1.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 20))

        const sessionId = ws1Msgs.find((m) => m.type === 'session_started').sessionId

        // Disconnect — idle timer is now armed.
        ws1.close()
        await new Promise((r) => setTimeout(r, 30))

        // Advance time partially (within TTL window).
        clock.advance(TTL / 2)

        // Resume — must cancel the timer.
        const ws2 = connect(ttlPort, TOKEN)
        await waitOpen(ws2)
        const ws2Msgs = []
        ws2.on('message', (d) => {
          try { ws2Msgs.push(JSON.parse(d.toString())) } catch {}
        })
        ws2.send(JSON.stringify({ type: 'resume', sessionId, lastSeq: 0 }))
        await new Promise((r) => setTimeout(r, 20))

        // Confirm resumed.
        const resumed = ws2Msgs.find((m) => m.type === 'resumed')
        assert.ok(resumed, 'resumed frame must be received')

        // Session must have no idle timer after cancel.
        const session = ttlAgent._sessions.get(sessionId)
        assert.ok(session, 'session must still exist after resume')
        assert.equal(session.idleTimer, null, 'idleTimer must be null after cancel')

        // Advance past original TTL — timer was cancelled so session stays.
        clock.advance(TTL)
        assert.equal(ttlAgent._sessions.size, 1, 'session must NOT be evicted when timer was cancelled')

        ws2.close()
      } finally {
        await ttlAgent.close()
      }
    })

    it('agent.close() cancels idle timers and kills children', async () => {
      const clock = makeFakeClock()
      const TTL = 500
      const mock2 = createMockSpawn()
      const child2 = mock2.child
      const { agent: ttlAgent, port: ttlPort } = await startAgent({
        spawnFn: mock2.spawnFn,
        killGraceMs: 25,
        resumeTimeoutMs: TTL,
        setTimeoutFn: clock.fakeSetTimeout,
        clearTimeoutFn: clock.fakeClearTimeout,
      })

      const ws = connect(ttlPort, TOKEN)
      await waitOpen(ws)
      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 20))

      // Disconnect — idle timer is armed.
      ws.close()
      await new Promise((r) => setTimeout(r, 30))

      assert.equal(ttlAgent._sessions.size, 1)

      // Close the agent — must cancel the idle timer and kill children.
      await ttlAgent.close()

      assert.equal(ttlAgent._sessions.size, 0, 'sessions must be cleared on close')
      assert.ok(
        child2.killSignals.includes('SIGTERM'),
        `child must be killed on close, got ${JSON.stringify(child2.killSignals)}`,
      )

      // Advancing the clock after close must not throw or re-run eviction.
      assert.doesNotThrow(() => clock.advance(TTL + 1))
    })

    it('session_lost(unknown_session) is delivered to a late resume after TTL eviction', async () => {
      const clock = makeFakeClock()
      const TTL = 100
      const mock2 = createMockSpawn()
      const { agent: ttlAgent, port: ttlPort } = await startAgent({
        spawnFn: mock2.spawnFn,
        killGraceMs: 25,
        resumeTimeoutMs: TTL,
        setTimeoutFn: clock.fakeSetTimeout,
        clearTimeoutFn: clock.fakeClearTimeout,
      })

      try {
        const ws1 = connect(ttlPort, TOKEN)
        await waitOpen(ws1)
        const ws1Msgs = []
        ws1.on('message', (d) => { try { ws1Msgs.push(JSON.parse(d.toString())) } catch {} })
        ws1.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 20))

        const sessionId = ws1Msgs.find((m) => m.type === 'session_started').sessionId
        ws1.close()
        await new Promise((r) => setTimeout(r, 30))

        // Advance past TTL — session is evicted.
        clock.advance(TTL + 1)
        assert.equal(ttlAgent._sessions.size, 0, 'session must be gone after TTL')

        // Late resume should get session_lost(unknown_session).
        const ws2 = connect(ttlPort, TOKEN)
        await waitOpen(ws2)
        const ws2Msgs = []
        ws2.on('message', (d) => { try { ws2Msgs.push(JSON.parse(d.toString())) } catch {} })

        ws2.send(JSON.stringify({ type: 'resume', sessionId, lastSeq: 0 }))
        await new Promise((r) => setTimeout(r, 20))

        const lost = ws2Msgs.find((m) => m.type === 'session_lost')
        assert.ok(lost, `expected session_lost frame, got ${JSON.stringify(ws2Msgs)}`)
        assert.equal(lost.sessionId, sessionId)
        assert.equal(lost.reason, 'unknown_session',
          'evicted sessions look the same as unknown ones to clients')

        ws2.close()
      } finally {
        await ttlAgent.close()
      }
    })

    it('closes child.stdin before SIGTERM on idle TTL eviction (#3397)', async () => {
      // The polite way to terminate a CLI child is to close its stdin first
      // (so it sees EOF and can exit cleanly) before falling back to signals.
      // Build a mock child with a real PassThrough stdin so we can assert on
      // both `stdin.writableEnded` and the `kill` call ordering.
      //
      // The fake clock governs both the idle TTL and the stdin-close grace,
      // so the critical ordering (stdin EOF → grace → SIGTERM) is asserted
      // deterministically — no wall-clock sleeps gate that observation.
      // A spawn-hook promise replaces the post-spawn sleep that previous
      // versions relied on for ordering.
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new PassThrough()
      child.kill = (signal) => {
        // Snapshot stdin state at the moment SIGTERM is delivered so the test
        // can assert ordering precisely.
        child._sigtermStdinEnded = child.stdin.writableEnded
        child.killSignals = child.killSignals || []
        child.killSignals.push(signal)
        return true
      }
      child.killSignals = []

      const clock = makeFakeClock()
      const TTL = 200
      const STDIN_CLOSE_MS = 30
      let spawnResolve
      const spawnedPromise = new Promise((resolve) => { spawnResolve = resolve })
      const { agent: ttlAgent, port: ttlPort } = await startAgent({
        spawnFn: (_cmd, _args, _opts) => {
          spawnResolve()
          return child
        },
        killGraceMs: 25,
        stdinCloseGraceMs: STDIN_CLOSE_MS,
        resumeTimeoutMs: TTL,
        setTimeoutFn: clock.fakeSetTimeout,
        clearTimeoutFn: clock.fakeClearTimeout,
      })

      try {
        const ws = connect(ttlPort, TOKEN)
        await waitOpen(ws)

        ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))

        // Wait deterministically for the spawn hook to fire — confirms the
        // child is registered before we disconnect and arm the idle timer.
        await spawnedPromise

        // Disconnect — arms the idle eviction timer. The 30ms wait gives the
        // server's WS 'close' handler time to run and arm the idle timer; the
        // critical ordering (stdin-then-SIGTERM) is asserted via the fake
        // clock below, not via wall-clock sleeps.
        ws.close()
        await new Promise((r) => setTimeout(r, 30))

        // Sanity: stdin is open before eviction fires.
        assert.equal(child.stdin.writableEnded, false, 'stdin must be open before eviction')

        const stdinEndedPromise = new Promise((resolve) => {
          child.stdin.once('finish', resolve)
        })

        // Trigger eviction by advancing the fake clock past TTL.
        clock.advance(TTL + 1)

        // stdin must be closed synchronously by _killChild — the polite EOF
        // happens BEFORE the SIGTERM grace timer schedules the signal.
        await stdinEndedPromise
        assert.equal(child.stdin.writableEnded, true, 'stdin must be ended after eviction')

        // No signals yet — SIGTERM is deferred until stdinCloseGraceMs elapses
        // on the (fake) clock. This replaces the previous wall-clock wait,
        // which was the flaky path under CI load.
        assert.equal(
          child.killSignals.length,
          0,
          `no kill signals must be sent before stdin grace elapses, got ${JSON.stringify(child.killSignals)}`,
        )

        // Advance the fake clock past the stdin-close grace and confirm
        // SIGTERM fires AFTER the stdin pipe was already ended.
        clock.advance(STDIN_CLOSE_MS + 1)
        assert.ok(
          child.killSignals.includes('SIGTERM'),
          `SIGTERM must fire after stdin grace, got ${JSON.stringify(child.killSignals)}`,
        )
        assert.equal(
          child._sigtermStdinEnded,
          true,
          'stdin must already be ended at the moment SIGTERM is delivered',
        )
      } finally {
        await ttlAgent.close()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // stdin-close grace configuration (#3470)
  // ---------------------------------------------------------------------------

  describe('stdinCloseGraceMs configuration', () => {
    // The agent.js module reads CHROXY_AGENT_STDIN_CLOSE_GRACE_MS at module
    // load. Re-import via a cache-busting query string so each scenario can
    // observe the parsed value through a fresh module instance.
    async function loadAgentWith(envValue) {
      const original = process.env.CHROXY_AGENT_STDIN_CLOSE_GRACE_MS
      if (envValue === undefined) {
        delete process.env.CHROXY_AGENT_STDIN_CLOSE_GRACE_MS
      } else {
        process.env.CHROXY_AGENT_STDIN_CLOSE_GRACE_MS = envValue
      }
      try {
        const mod = await import(`../../sidecar/agent.js?stdinGrace=${Date.now()}-${Math.random()}`)
        return mod
      } finally {
        if (original === undefined) delete process.env.CHROXY_AGENT_STDIN_CLOSE_GRACE_MS
        else process.env.CHROXY_AGENT_STDIN_CLOSE_GRACE_MS = original
      }
    }

    it('invalid stdinCloseGraceMs falls back to 500 ms default', async () => {
      // Mirrors the FALLBACK_MAX_LINE_BYTES pattern (#3470 acceptance: invalid
      // value at the constructor level snaps back to the documented default).
      const agent = new PodAgent({ token: TOKEN, stdinCloseGraceMs: -1 })
      assert.equal(agent._stdinCloseGraceMs, 500)
      await agent.close()
    })

    it('NaN stdinCloseGraceMs falls back to 500 ms default', async () => {
      const agent = new PodAgent({ token: TOKEN, stdinCloseGraceMs: Number.NaN })
      assert.equal(agent._stdinCloseGraceMs, 500)
      await agent.close()
    })

    it('CHROXY_AGENT_STDIN_CLOSE_GRACE_MS env var sets the constructor default', async () => {
      const { PodAgent: FreshPodAgent } = await loadAgentWith('1234')
      const agent = new FreshPodAgent({ token: TOKEN })
      assert.equal(agent._stdinCloseGraceMs, 1234,
        'env-var value must flow through DEFAULT_STDIN_CLOSE_GRACE_MS into the constructor default')
      await agent.close()
    })

    it('invalid CHROXY_AGENT_STDIN_CLOSE_GRACE_MS falls back to 500 ms', async () => {
      const { PodAgent: FreshPodAgent } = await loadAgentWith('not-a-number')
      const agent = new FreshPodAgent({ token: TOKEN })
      assert.equal(agent._stdinCloseGraceMs, 500,
        'NaN env var must fall back to FALLBACK_STDIN_CLOSE_GRACE_MS (500)')
      await agent.close()
    })

    it('negative CHROXY_AGENT_STDIN_CLOSE_GRACE_MS falls back to 500 ms', async () => {
      const { PodAgent: FreshPodAgent } = await loadAgentWith('-100')
      const agent = new FreshPodAgent({ token: TOKEN })
      assert.equal(agent._stdinCloseGraceMs, 500,
        'negative env var must fall back to FALLBACK_STDIN_CLOSE_GRACE_MS (500)')
      await agent.close()
    })

    it('unset CHROXY_AGENT_STDIN_CLOSE_GRACE_MS keeps 500 ms default', async () => {
      const { PodAgent: FreshPodAgent } = await loadAgentWith(undefined)
      const agent = new FreshPodAgent({ token: TOKEN })
      assert.equal(agent._stdinCloseGraceMs, 500,
        'unset env var must keep the FALLBACK_STDIN_CLOSE_GRACE_MS default (500)')
      await agent.close()
    })

    it('zero CHROXY_AGENT_STDIN_CLOSE_GRACE_MS is allowed (synchronous SIGTERM)', async () => {
      // 0 is a legitimate operator override — _killChild still closes the
      // child's stdin (polite EOF) when present, but skips the grace timer
      // and fires SIGTERM synchronously instead of after a delay.
      const { PodAgent: FreshPodAgent } = await loadAgentWith('0')
      const agent = new FreshPodAgent({ token: TOKEN })
      assert.equal(agent._stdinCloseGraceMs, 0,
        '0 must be honoured (allowed; non-negative validation, not strictly positive)')
      await agent.close()
    })

    it('explicit constructor stdinCloseGraceMs overrides env var', async () => {
      const { PodAgent: FreshPodAgent } = await loadAgentWith('1234')
      const agent = new FreshPodAgent({ token: TOKEN, stdinCloseGraceMs: 42 })
      assert.equal(agent._stdinCloseGraceMs, 42,
        'explicit constructor option must win over CHROXY_AGENT_STDIN_CLOSE_GRACE_MS')
      await agent.close()
    })
  })

  // ---------------------------------------------------------------------------
  // Max-sessions cap (#3349)
  // ---------------------------------------------------------------------------

  describe('max-sessions cap', () => {
    it('oldest idle session is evicted when cap is reached', async () => {
      // Use a cap of 2 to keep the test short.
      const children = []
      const spawnFn = (_cmd, _args, _opts) => {
        const mock = createMockSpawn()
        children.push(mock.child)
        return mock.child
      }

      const { agent: capAgent, port: capPort } = await startAgent({
        spawnFn,
        maxSessions: 2,
        resumeTimeoutMs: 60_000,  // long TTL so idle timer doesn't race
      })

      try {
        // Session 1 — connect, spawn, then disconnect (goes idle).
        const ws1 = connect(capPort, TOKEN)
        await waitOpen(ws1)
        const sid1Promise = waitForSessionStarted(ws1)
        ws1.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        const sid1 = await sid1Promise
        ws1.close()
        await new Promise((r) => setTimeout(r, 30))

        assert.equal(capAgent._sessions.size, 1, 'one idle session after first spawn')

        // Session 2 — connect, spawn, then disconnect (goes idle).
        const ws2 = connect(capPort, TOKEN)
        await waitOpen(ws2)
        const sid2Promise = waitForSessionStarted(ws2)
        ws2.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        const sid2 = await sid2Promise
        ws2.close()
        await new Promise((r) => setTimeout(r, 30))

        assert.equal(capAgent._sessions.size, 2, 'two idle sessions before cap eviction')

        // Session 3 — spawning this must evict the oldest idle session (session 1).
        const ws3 = connect(capPort, TOKEN)
        await waitOpen(ws3)
        const sid3Promise = waitForSessionStarted(ws3)
        ws3.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await sid3Promise

        // After spawn 3: cap evicted session 1, so map has [sid2, sid3].
        assert.equal(capAgent._sessions.size, 2, 'session count stays at cap after eviction')
        assert.ok(!capAgent._sessions.has(sid1), 'oldest session (sid1) must be evicted')
        assert.ok(capAgent._sessions.has(sid2), 'newer idle session (sid2) must survive')

        // children[0] is the child for session 1 — must have been SIGTERMed.
        assert.ok(
          children[0].killSignals.includes('SIGTERM'),
          `evicted child must be SIGTERMed, got ${JSON.stringify(children[0].killSignals)}`,
        )

        ws3.close()
      } finally {
        await capAgent.close()
      }
    })

    it('failed synchronous spawn does not evict an existing session (#3392)', async () => {
      // Arrange: one idle session already in the map at the cap limit.
      // The second spawn throws synchronously -- _enforceSessionCap must NOT
      // have run before the throw, so the existing session must survive.
      let spawnCallCount = 0
      const mockChild = new EventEmitter()
      mockChild.stdout = new PassThrough()
      mockChild.stderr = new PassThrough()
      mockChild.kill = () => true

      const spawnFn = (_cmd, _args, _opts) => {
        spawnCallCount += 1
        if (spawnCallCount === 1) {
          // First call succeeds -- establishes the existing session.
          return mockChild
        }
        // Second call fails synchronously (e.g. binary not found).
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      }

      const { agent: capAgent, port: capPort } = await startAgent({
        spawnFn,
        maxSessions: 1,          // cap of 1 -- any new spawn at the limit would evict
        resumeTimeoutMs: 60_000, // long TTL so idle timer does not race
      })

      try {
        // Session 1 -- connect, spawn, then disconnect (goes idle).
        const ws1 = connect(capPort, TOKEN)
        await waitOpen(ws1)
        const sid1Promise = waitForSessionStarted(ws1)
        ws1.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        const sid1 = await sid1Promise
        ws1.close()
        await new Promise((r) => setTimeout(r, 30))

        assert.equal(capAgent._sessions.size, 1, 'one idle session before the failing spawn')

        // Session 2 -- spawn throws synchronously. With the old (buggy) ordering
        // the cap enforcer would have evicted sid1 before discovering the spawn
        // fails, leaving _sessions empty. With the fix eviction must not happen.
        const ws2 = connect(capPort, TOKEN)
        await waitOpen(ws2)
        const ws2Msgs = []
        ws2.on('message', (d) => { try { ws2Msgs.push(JSON.parse(d.toString())) } catch {} })

        ws2.send(JSON.stringify({ type: 'spawn', cmd: 'missing-bin', args: [] }))
        await new Promise((r) => setTimeout(r, 30))

        // The client must receive an error frame describing the spawn failure.
        const errFrame = ws2Msgs.find((m) => m.type === 'error')
        assert.ok(errFrame, 'expected an error frame for the failed spawn')
        assert.match(errFrame.message, /spawn failed/)

        // The original session must still be alive -- no eviction occurred.
        assert.equal(capAgent._sessions.size, 1, 'session count must not decrease after failed spawn')
        assert.ok(capAgent._sessions.has(sid1), 'original session must survive a failed spawn')

        ws2.close()
      } finally {
        await capAgent.close()
      }
    })

    it('falls back to evicting oldest active session when all sessions are active', async () => {
      // Cap=2. Spawn A and B sequentially (each over its own WS connection so
      // the single-connection policy is satisfied), then simulate both sessions
      // being "active" by patching their activeWs to a mock WS with a close
      // spy. Spawning C triggers the fallback path in _enforceSessionCap: no
      // idle sessions → evict globally oldest by lastActiveAt → session A is
      // evicted with ws.close(1001).
      const children = []
      const spawnFn = (_cmd, _args, _opts) => {
        const mock = createMockSpawn()
        children.push(mock.child)
        return mock.child
      }

      const { agent: capAgent, port: capPort } = await startAgent({
        spawnFn,
        maxSessions: 2,
        resumeTimeoutMs: 999_999,  // long TTL so idle timers don't race
      })

      try {
        // --- Session A ---
        const ws1 = connect(capPort, TOKEN)
        await waitOpen(ws1)
        const sidAPromise = waitForSessionStarted(ws1)
        ws1.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        const sidA = await sidAPromise
        ws1.close()
        await new Promise((r) => setTimeout(r, 30))

        // --- Session B (spawned after A so its lastActiveAt is naturally newer) ---
        const ws2 = connect(capPort, TOKEN)
        await waitOpen(ws2)
        const sidBPromise = waitForSessionStarted(ws2)
        ws2.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        const sidB = await sidBPromise
        ws2.close()
        await new Promise((r) => setTimeout(r, 30))

        assert.equal(capAgent._sessions.size, 2, 'two sessions present before patching')

        // Simulate both sessions being actively connected: cancel idle timers,
        // then set activeWs to a mock WS so _enforceSessionCap sees no idle
        // sessions and must fall back to the oldest-active eviction path.
        const closeCallsA = []
        const fakeWsA = { close(code, reason) { closeCallsA.push({ code, reason }) } }
        const closeCallsB = []
        const fakeWsB = { close(code, reason) { closeCallsB.push({ code, reason }) } }

        const sessionA = capAgent._sessions.get(sidA)
        const sessionB = capAgent._sessions.get(sidB)

        capAgent._cancelIdleTimer(sessionA)
        capAgent._cancelIdleTimer(sessionB)
        sessionA.activeWs = fakeWsA
        sessionB.activeWs = fakeWsB

        // Pin timestamps: A is definitively older than B. Without this the two
        // spawns may happen within the same millisecond on fast machines.
        sessionA.lastActiveAt = 1000
        sessionB.lastActiveAt = 2000

        // --- Session C: cap enforced, must evict session A (oldest active) ---
        const ws3 = connect(capPort, TOKEN)
        await waitOpen(ws3)
        const sidCPromise = waitForSessionStarted(ws3)
        ws3.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await sidCPromise

        // Session count must stay at the cap.
        assert.equal(capAgent._sessions.size, 2, 'session count stays at cap after eviction')

        // Session A (oldest) must be gone; session B (newer) must survive.
        assert.ok(!capAgent._sessions.has(sidA), 'oldest active session (A) must be evicted')
        assert.ok(capAgent._sessions.has(sidB), 'newer active session (B) must survive')

        // Session A's child must have been SIGTERMed.
        assert.ok(
          children[0].killSignals.includes('SIGTERM'),
          `evicted child must be SIGTERMed, got ${JSON.stringify(children[0].killSignals)}`,
        )

        // Session A's fake WS must have been closed with code 1001.
        assert.equal(closeCallsA.length, 1, 'evicted session WS must receive exactly one close call')
        assert.equal(closeCallsA[0].code, 1001, 'evicted WS must be closed with code 1001')

        // Session B's fake WS must NOT have been closed (it was not evicted).
        assert.equal(closeCallsB.length, 0, 'surviving session WS must not be closed')
      } finally {
        await capAgent.close()
      }
    })

    it('sends session_lost(evicted_by_cap) frame BEFORE ws.close when evicting an active session (#3390)', async () => {
      // Cap=2. Sessions A and B are both active (live WS attached). Spawning C
      // triggers the fallback path: no idle sessions → oldest-active eviction.
      // fakeWsA records each send/close call in insertion order so we can
      // assert that session_lost arrives BEFORE the close handshake.
      const children = []
      const spawnFn = (_cmd, _args, _opts) => {
        const mock = createMockSpawn()
        children.push(mock.child)
        return mock.child
      }

      const { agent: capAgent, port: capPort } = await startAgent({
        spawnFn,
        maxSessions: 2,
        resumeTimeoutMs: 999_999,
      })

      try {
        // --- Session A (will be the oldest) ---
        const ws1 = connect(capPort, TOKEN)
        await waitOpen(ws1)
        const sidAPromise = waitForSessionStarted(ws1)
        ws1.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        const sidA = await sidAPromise
        ws1.close()
        await new Promise((r) => setTimeout(r, 30))

        // --- Session B (newer) ---
        const ws2 = connect(capPort, TOKEN)
        await waitOpen(ws2)
        const sidBPromise = waitForSessionStarted(ws2)
        ws2.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        const sidB = await sidBPromise
        ws2.close()
        await new Promise((r) => setTimeout(r, 30))

        // Patch both sessions with fake WS instances so the cap enforcer sees
        // no idle sessions and must fall back to evicting the oldest active one.
        const callLog = []
        const fakeWsA = {
          readyState: 1,  // WebSocket.OPEN
          // Mirror the real ws.send(data, cb) shape so the callback-driven
          // close-after-flush logic in _send / _evictSession progresses (#3399).
          send(data, cb) {
            callLog.push({ op: 'send', frame: JSON.parse(data) })
            if (cb) cb()
          },
          close(code, reason) { callLog.push({ op: 'close', code, reason }) },
        }
        const fakeWsB = {
          readyState: 1,
          send(_data, cb) { if (cb) cb() },
          close() {},
        }

        const sessionA = capAgent._sessions.get(sidA)
        const sessionB = capAgent._sessions.get(sidB)
        capAgent._cancelIdleTimer(sessionA)
        capAgent._cancelIdleTimer(sessionB)
        sessionA.activeWs = fakeWsA
        sessionB.activeWs = fakeWsB
        sessionA.lastActiveAt = 1000  // older → evicted
        sessionB.lastActiveAt = 2000  // newer → survives

        // --- Session C: triggers cap → A is evicted ---
        const ws3 = connect(capPort, TOKEN)
        await waitOpen(ws3)
        const sidCPromise = waitForSessionStarted(ws3)
        ws3.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await sidCPromise

        // Verify frame ordering: session_lost must precede ws.close(1001).
        const sendIdx = callLog.findIndex((e) => e.op === 'send' && e.frame.type === 'session_lost')
        const closeIdx = callLog.findIndex((e) => e.op === 'close' && e.code === 1001)

        assert.ok(
          sendIdx !== -1,
          `session_lost frame must be sent to evicted WS; log=${JSON.stringify(callLog)}`,
        )
        assert.ok(
          closeIdx !== -1,
          `evicted WS must be closed with code 1001; log=${JSON.stringify(callLog)}`,
        )
        assert.ok(
          sendIdx < closeIdx,
          `session_lost (idx ${sendIdx}) must precede ws.close(1001) (idx ${closeIdx})`,
        )

        const lostFrame = callLog[sendIdx].frame
        assert.equal(lostFrame.type, 'session_lost')
        assert.equal(lostFrame.sessionId, sidA, 'session_lost must carry the evicted sessionId')
        assert.equal(lostFrame.reason, 'evicted_by_cap', 'reason must be evicted_by_cap')

        ws3.close()
      } finally {
        await capAgent.close()
      }
    })
  })

  // spawn stdin option (#3329)
  // ---------------------------------------------------------------------------

  describe('spawn stdin option', () => {
    let agent, port, capturedOpts

    beforeEach(async () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new PassThrough()
      child.kill = () => true

      const spawnFn = (_cmd, _args, opts) => {
        capturedOpts = opts
        return child
      }
      ;({ agent, port } = await startAgent({ spawnFn }))
    })

    afterEach(() => agent.close())

    it('defaults to pipe when spawn frame omits stdin field', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
      await new Promise((r) => setTimeout(r, 20))

      assert.ok(capturedOpts, 'spawn should have been called')
      assert.equal(capturedOpts.stdio[0], 'pipe', 'default stdin mode must be "pipe"')

      ws.close()
    })

    it('passes pipe to Node spawn when stdin: pipe is explicit', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [], stdin: 'pipe' }))
      await new Promise((r) => setTimeout(r, 20))

      assert.ok(capturedOpts, 'spawn should have been called')
      assert.equal(capturedOpts.stdio[0], 'pipe', 'explicit stdin: pipe must be forwarded')

      ws.close()
    })

    it('passes ignore to Node spawn when stdin: ignore is requested', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [], stdin: 'ignore' }))
      await new Promise((r) => setTimeout(r, 20))

      assert.ok(capturedOpts, 'spawn should have been called')
      assert.equal(capturedOpts.stdio[0], 'ignore', 'stdin stdio entry must be "ignore"')

      ws.close()
    })

    it('silently drops stdin frame when child.stdin is null (ignore mode)', async () => {
      // Rebuild with a child that has no stdin to simulate the ignore case.
      await agent.close()
      const noStdinChild = new EventEmitter()
      noStdinChild.stdout = new PassThrough()
      noStdinChild.stderr = new PassThrough()
      noStdinChild.stdin = null
      noStdinChild.kill = () => true
      const spawnFn2 = (_cmd, _args, opts) => {
        capturedOpts = opts
        return noStdinChild
      }
      ;({ agent, port } = await startAgent({ spawnFn: spawnFn2 }))

      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [], stdin: 'ignore' }))
      await new Promise((r) => setTimeout(r, 20))

      // Send stdin frame -- should be silently dropped (no error frame).
      let gotError = false
      ws.on('message', (d) => {
        try {
          const msg = JSON.parse(d.toString())
          if (msg.type === 'error') gotError = true
        } catch {}
      })

      ws.send(JSON.stringify({ type: 'stdin', data: 'test\n' }))
      await new Promise((r) => setTimeout(r, 50))

      assert.equal(gotError, false, 'must not send error frame for stdin on no-stdin child')

      ws.close()
    })
  })
})
