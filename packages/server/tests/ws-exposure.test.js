/**
 * #5460 — auth_ok exposure emission (#5356 visibility layer, shipped in #5459).
 *
 * Three seams, covered bottom-up:
 *   1. The WsServer `exposure` getter: null until start() records a bound
 *      host, then `{ lanBind, bindHost, quickTunnel }` with lanBind derived
 *      from isLoopbackHost and quickTunnel from setQuickTunnelActive().
 *   2. The sendPostAuthInfo glue: the auth_ok payload carries `exposure`
 *      only when ctx.exposure is non-null (older ctx shapes and never-started
 *      harnesses omit the field entirely — clients treat that as "unknown").
 *   3. End to end: a real client connecting to a started server sees the
 *      exposure snapshot on the auth_ok wire, and setQuickTunnelActive(true)
 *      flips quickTunnel for the next handshake.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { sendPostAuthInfo } from '../src/ws-history.js'
import { createMockSession, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'

// Default noEncrypt: true (avoids key-exchange timeouts) and silence the
// log listener WsServer.start() registers so log_entry broadcasts don't
// interfere with message assertions — same wrapper as ws-server-auth.test.js.
class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
  start(...args) {
    super.start(...args)
    setLogListener(null)
  }
}

async function startServerAndGetPort(server, host = '127.0.0.1') {
  server.start(host)
  const httpServer = server.httpServer
  await new Promise((resolve, reject) => {
    function onListening() {
      httpServer.removeListener('error', onError)
      resolve()
    }
    function onError(err) {
      httpServer.removeListener('listening', onListening)
      reject(err)
    }
    httpServer.once('listening', onListening)
    httpServer.once('error', onError)
  })
  return server.httpServer.address().port
}

/** Connect a client and wait for its auth_ok (authRequired: false servers). */
async function connectAndGetAuthOk(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (data) => {
    try { messages.push(JSON.parse(data.toString())) } catch { /* non-JSON frame */ }
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 2000)
    ws.once('open', () => { clearTimeout(timer); resolve() })
    ws.once('error', (err) => { clearTimeout(timer); reject(err) })
  })
  const authOk = await waitFor(
    () => messages.find(m => m.type === 'auth_ok'),
    { timeoutMs: 2000, label: 'auth_ok' },
  )
  ws.close()
  return authOk
}

// ── exposure getter ────────────────────────────────────────────────────────

describe('WsServer exposure getter (#5356)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('is null before start() has bound a socket', () => {
    server = new WsServer({ port: 0, apiToken: 'tok', cliSession: createMockSession() })
    assert.equal(server.exposure, null)
  })

  it('reports lanBind: false for a loopback bind after start()', async () => {
    server = new WsServer({ port: 0, apiToken: 'tok', cliSession: createMockSession(), authRequired: false })
    await startServerAndGetPort(server, '127.0.0.1')

    assert.deepEqual(server.exposure, {
      lanBind: false,
      bindHost: '127.0.0.1',
      quickTunnel: false,
    })
  })

  it('reports lanBind: true for non-loopback bind hosts', () => {
    // Simulate the host record start() makes (`this._boundHost = host ?? '0.0.0.0'`)
    // without actually binding all interfaces in a test (macOS firewall prompts).
    server = new WsServer({ port: 0, apiToken: 'tok', cliSession: createMockSession() })

    server._boundHost = '0.0.0.0'
    assert.deepEqual(server.exposure, { lanBind: true, bindHost: '0.0.0.0', quickTunnel: false })

    server._boundHost = '192.168.1.10'
    assert.deepEqual(server.exposure, { lanBind: true, bindHost: '192.168.1.10', quickTunnel: false })
  })

  it('setQuickTunnelActive flips quickTunnel in the snapshot (coerced to boolean)', async () => {
    server = new WsServer({ port: 0, apiToken: 'tok', cliSession: createMockSession(), authRequired: false })
    await startServerAndGetPort(server, '127.0.0.1')

    server.setQuickTunnelActive(true)
    assert.equal(server.exposure.quickTunnel, true)

    server.setQuickTunnelActive(false)
    assert.equal(server.exposure.quickTunnel, false)

    server.setQuickTunnelActive('truthy string')
    assert.equal(server.exposure.quickTunnel, true, 'truthy input must coerce to boolean true')
  })
})

// ── sendPostAuthInfo emission / omission ───────────────────────────────────

describe('sendPostAuthInfo — auth_ok exposure field (#5356)', () => {
  function makeCtx(overrides = {}) {
    const sends = []
    const ctx = {
      clients: new Map(),
      sessionManager: null,
      cliSession: null,
      defaultSessionId: null,
      serverMode: 'multi',
      serverVersion: '0.9.0',
      latestVersion: '0.9.0',
      gitInfo: { commit: 'abc1234' },
      encryptionEnabled: false,
      localhostBypass: false,
      keyExchangeTimeoutMs: 5000,
      protocolVersion: 3,
      minProtocolVersion: 1,
      webTaskManager: { getFeatureStatus: () => ({ available: false, remote: false, teleport: false }) },
      send: (ws, msg) => sends.push(msg),
      broadcast: () => {},
      getConnectedClientList: () => [],
      permissions: { resendPendingPermissions: () => {} },
      ...overrides,
    }
    ctx._sends = sends
    return ctx
  }

  function makeWs(ctx) {
    const ws = { readyState: 1, send: () => {}, close: () => {} }
    ctx.clients.set(ws, { id: 'client-1', socketIp: '10.0.0.1', activeSessionId: null })
    return ws
  }

  it('includes the exposure snapshot in auth_ok when ctx.exposure is set', () => {
    const exposure = { lanBind: true, bindHost: '0.0.0.0', quickTunnel: true }
    const ctx = makeCtx({ exposure })
    const ws = makeWs(ctx)

    sendPostAuthInfo(ctx, ws)

    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.ok(authOk, 'auth_ok not sent')
    assert.deepEqual(authOk.exposure, exposure)
  })

  it('omits the field entirely when ctx.exposure is null (server never bound a socket)', () => {
    const ctx = makeCtx({ exposure: null })
    const ws = makeWs(ctx)

    sendPostAuthInfo(ctx, ws)

    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.ok(authOk, 'auth_ok not sent')
    assert.equal('exposure' in authOk, false, 'auth_ok must not carry an exposure key')
  })

  it('omits the field when ctx predates exposure entirely (no key on ctx)', () => {
    const ctx = makeCtx() // no exposure key at all — older ctx shape
    const ws = makeWs(ctx)

    sendPostAuthInfo(ctx, ws)

    const authOk = ctx._sends.find(m => m.type === 'auth_ok')
    assert.ok(authOk, 'auth_ok not sent')
    assert.equal('exposure' in authOk, false)
  })
})

// ── end-to-end: exposure on the auth_ok wire ───────────────────────────────

describe('auth_ok exposure over a real connection (#5459 / #5460)', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('carries the loopback exposure snapshot, then quickTunnel: true after setQuickTunnelActive', async () => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok',
      cliSession: createMockSession(),
      authRequired: false,
    })
    const port = await startServerAndGetPort(server, '127.0.0.1')

    const first = await connectAndGetAuthOk(port)
    assert.deepEqual(first.exposure, {
      lanBind: false,
      bindHost: '127.0.0.1',
      quickTunnel: false,
    })

    // server-cli flags the public quick tunnel before tunnel startup; the
    // next handshake must reflect it.
    server.setQuickTunnelActive(true)

    const second = await connectAndGetAuthOk(port)
    assert.deepEqual(second.exposure, {
      lanBind: false,
      bindHost: '127.0.0.1',
      quickTunnel: true,
    })
  })
})
