import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import WebSocket from 'ws'
import { PodAgent } from '../../sidecar/agent.js'

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
 */
function createMockSpawn() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()

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

      const msgsPromise = waitForMessages(ws, 1)

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
      assert.ok(msgs.length >= 1)
      assert.equal(msgs[0].type, 'event')
      assert.deepEqual(msgs[0].payload, payload)

      ws.close()
    })

    it('forwards stderr as stderr frames', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      const msgsPromise = waitForMessages(ws, 1)

      ws.send(JSON.stringify({ type: 'spawn', cmd: 'claude', args: [] }))

      setTimeout(() => controller.writeStderr('error: something went wrong\n'), 10)

      const msgs = await msgsPromise
      assert.ok(msgs.length >= 1)
      assert.equal(msgs[0].type, 'stderr')
      assert.equal(msgs[0].data, 'error: something went wrong\n')

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
      assert.ok(messages.length >= 1, `expected exit frame (got ${messages.length})`)
      assert.equal(messages[0].type, 'exit')
      assert.equal(messages[0].code, 0)
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

    it('returns error frame for unknown type', async () => {
      const ws = connect(port, TOKEN)
      await waitOpen(ws)

      const msgsPromise = waitForMessages(ws, 1)
      ws.send(JSON.stringify({ type: 'unknown_cmd' }))
      const msgs = await msgsPromise
      assert.ok(msgs.length >= 1)
      assert.equal(msgs[0].type, 'error')
      assert.match(msgs[0].message, /unknown message type/)

      ws.close()
    })
  })
})
