import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { WsServer as _WsServer } from '../src/ws-server.js'
import WebSocket from 'ws'

/**
 * #7895 — `ws-server.js`'s `setupForwarding({ ... })` call must thread
 * `defaultProvider` through to `ws-forwarding.js`, or the two `available_models`
 * send sites there (`models_updated` forward + the legacy single-session path)
 * silently fall back to `resolveRosterProvider`'s own `DEFAULT_PROVIDER`
 * constant regardless of what THIS daemon was actually started with
 * (`--provider` / `config.provider`) — reproducing the exact "wrong tag,
 * discarded by the client" bug this issue fixes, just one level up.
 *
 * #7932: this wiring now goes through `resolveDaemonDefaultProvider(config)`
 * (`./providers.js`) rather than the inline `config.provider || DEFAULT_PROVIDER`
 * expression — see that function's docstring for why five textually-identical
 * copies of the same expression were collapsed to one. The source pin below is
 * updated for the new call shape, and a real end-to-end test is added alongside
 * it: a `WsServer` CAN be constructed, started and driven over a live socket in
 * this suite (`ws-server-broadcast.test.js` does exactly that for other
 * broadcasts), so the wiring is no longer proven by source text alone.
 */
describe('ws-server.js setupForwarding wiring (#7895)', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/ws-server.js', import.meta.url)), 'utf-8')

  it('setupForwarding({...}) passes defaultProvider: resolveDaemonDefaultProvider(this.config)', () => {
    const wiring = /defaultProvider:\s*resolveDaemonDefaultProvider\(this\.config\)/
    assert.ok(wiring.test(src), 'setupForwarding(...) must pass defaultProvider: resolveDaemonDefaultProvider(this.config)')
  })

  it('imports resolveDaemonDefaultProvider so the wiring above cannot reference an undefined name', () => {
    const importLine = /import\s*\{[^}]*\bresolveDaemonDefaultProvider\b[^}]*\}\s*from\s*['"]\.\/providers\.js['"]/
    assert.ok(importLine.test(src), 'ws-server.js must import resolveDaemonDefaultProvider from ./providers.js')
  })
})

// ---------------------------------------------------------------------------
// Real end-to-end coverage: construct a WsServer, drive a models_updated
// session event through it over a live socket, and assert the delivered
// available_models roster is tagged with THIS daemon's config.provider — not
// resolveRosterProvider's internal DEFAULT_PROVIDER fallback. Mirrors the
// harness ws-server-broadcast.test.js already uses for other broadcasts.
// ---------------------------------------------------------------------------

class WsServer extends _WsServer {
  constructor(opts = {}) {
    super({ noEncrypt: true, ...opts })
  }
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
  )
  return Promise.race([promise, timer])
}

async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
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

async function createClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []

  ws.on('message', (data) => {
    try {
      messages.push(JSON.parse(data.toString()))
    } catch {
      // ignore parse errors
    }
  })

  await withTimeout(
    new Promise((resolve, reject) => {
      function onOpen() { ws.removeListener('error', onError); resolve() }
      function onError(err) { ws.removeListener('open', onOpen); reject(err) }
      ws.once('open', onOpen)
      ws.once('error', onError)
    }),
    2000,
    'Connection timeout'
  )

  await withTimeout(
    (async () => {
      while (!messages.find((m) => m.type === 'auth_ok')) {
        await new Promise((r) => setTimeout(r, 10))
      }
    })(),
    2000,
    'Auth timeout'
  )

  return { ws, messages }
}

async function waitForMessageMatch(messages, predicate, timeout = 2000, label = 'message match') {
  await withTimeout(
    (async () => {
      while (!messages.find(predicate)) {
        await new Promise((r) => setTimeout(r, 10))
      }
    })(),
    timeout,
    `Timeout waiting for ${label}`
  )
  return messages.find(predicate)
}

describe('ws-server.js setupForwarding wiring (#7895) — end-to-end', () => {
  let server

  afterEach(() => {
    if (server) {
      server.close()
      server = null
    }
  })

  it('tags a live models_updated roster (no session provider) with THIS daemon\'s config.provider, not the internal DEFAULT_PROVIDER fallback', async () => {
    // A session with NO `provider` field on its entry — the exact "session not
    // found / provider unresolved" case resolveRosterProvider's second
    // parameter (defaultProvider) exists for. If setupForwarding ever drops
    // the defaultProvider wire, this roster falls back to
    // resolveRosterProvider's own DEFAULT_PROVIDER constant ('claude-tui')
    // instead of the daemon's configured 'claude-sdk', and the assertion below
    // catches it on a real socket rather than a source grep.
    const manager = new EventEmitter()
    manager.getSession = (id) => (id === 'sess-1' ? { name: 'sess-1', cwd: '/tmp' } : undefined)
    manager.listSessions = () => []
    manager.getHistory = () => []
    manager.getOldestHistorySeq = () => null
    manager.getLatestHistorySeq = () => 0
    manager.getFullHistoryAsync = async () => ({ entries: [], source: 'ring', truncated: false })
    manager.isBudgetPaused = () => false
    manager.getSessionContext = async () => null
    Object.defineProperty(manager, 'firstSessionId', { get: () => null })

    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: manager,
      authRequired: false,
      config: { provider: 'claude-sdk' },
    })
    const port = await startServerAndGetPort(server)
    const { ws, messages } = await createClient(port)
    messages.length = 0

    manager.emit('session_event', {
      sessionId: 'sess-1',
      event: 'models_updated',
      data: { models: [{ id: 'stub-model', fullId: 'stub-model', label: 'Stub Model' }] },
    })

    const rosterMsg = await waitForMessageMatch(
      messages,
      (m) => m.type === 'available_models',
      2000,
      'available_models'
    )
    assert.ok(rosterMsg, 'client should receive an available_models roster')
    assert.equal(rosterMsg.provider, 'claude-sdk', 'roster must be tagged with config.provider, not DEFAULT_PROVIDER')

    ws.close()
  })
})
