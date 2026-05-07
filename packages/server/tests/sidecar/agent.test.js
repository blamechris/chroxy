import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import WebSocket from 'ws'
import { PodAgent, LineLimitTransform, DEFAULT_MAX_LINE_BYTES } from '../../sidecar/agent.js'

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

      // Push 5 events into a buffer of size 3; oldest 2 should be evicted.
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
        const ws1Msgs = []
        ws1.on('message', (d) => { try { ws1Msgs.push(JSON.parse(d.toString())) } catch {} })
        ws1.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 20))
        const sid1 = ws1Msgs.find((m) => m.type === 'session_started').sessionId
        ws1.close()
        await new Promise((r) => setTimeout(r, 30))

        assert.equal(capAgent._sessions.size, 1, 'one idle session after first spawn')

        // Session 2 — connect, spawn, then disconnect (goes idle).
        const ws2 = connect(capPort, TOKEN)
        await waitOpen(ws2)
        const ws2Msgs = []
        ws2.on('message', (d) => { try { ws2Msgs.push(JSON.parse(d.toString())) } catch {} })
        ws2.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 20))
        const sid2 = ws2Msgs.find((m) => m.type === 'session_started').sessionId
        ws2.close()
        await new Promise((r) => setTimeout(r, 30))

        assert.equal(capAgent._sessions.size, 2, 'two idle sessions before cap eviction')

        // Session 3 — spawning this must evict the oldest idle session (session 1).
        const ws3 = connect(capPort, TOKEN)
        await waitOpen(ws3)
        const ws3Msgs = []
        ws3.on('message', (d) => { try { ws3Msgs.push(JSON.parse(d.toString())) } catch {} })
        ws3.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))
        await new Promise((r) => setTimeout(r, 20))

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
