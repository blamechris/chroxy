import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WsServer } from '../src/ws-server.js'
import { sendPostAuthInfo } from '../src/ws-history.js'
import { createMockSession, createSpy } from './test-helpers.js'

// #8331 — who is TOLD about a waiting daemon update: strict-primary, unbound
// clients only, both on auth and on every later change.

const STATUS = { running: 'a'.repeat(40), pending: null, lastDeploy: null, postponedUntil: null, requestPending: false }

const clients = {
  primary: { isPrimaryToken: true, boundSessionId: null },
  pairing: { isPrimaryToken: false, boundSessionId: null },
  noClass: { boundSessionId: null },
  boundPairing: { isPrimaryToken: false, boundSessionId: 's1' },
  boundPrimary: { isPrimaryToken: true, boundSessionId: 's1' },
}
const delivered = (calls, client) => calls.filter(({ filter }) => filter(client)).map(({ msg }) => msg)

describe('daemon_update_status broadcast (WsServer)', () => {
  let server
  afterEach(() => { try { server?.close() } catch { /* already closed */ } server = null })

  function mkServer(daemonUpdate) {
    server = new WsServer({ port: 0, apiToken: 't', cliSession: createMockSession(), noEncrypt: true, daemonUpdate })
    const calls = []
    server._broadcast = (msg, filter) => calls.push({ msg, filter })
    return calls
  }

  it('a change reaches strict-primary unbound clients and NO ONE else', () => {
    const updates = new EventEmitter()
    const calls = mkServer(updates)
    updates.emit('change', STATUS)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].msg.type, 'daemon_update_status')
    assert.equal(calls[0].msg.running, STATUS.running)
    assert.equal(delivered(calls, clients.primary).length, 1, 'primary')
    for (const name of ['pairing', 'noClass', 'boundPairing', 'boundPrimary']) {
      assert.equal(delivered(calls, clients[name]).length, 0, `${name} must not receive it`)
    }
  })

  it('close() unsubscribes and closes the module (no leaked watcher)', () => {
    const updates = new EventEmitter()
    updates.close = createSpy()
    const calls = mkServer(updates)
    updates.emit('change', STATUS)
    assert.equal(calls.length, 1, 'positive control: the subscription is live')
    server.close()
    server = null
    updates.emit('change', STATUS)
    assert.equal(calls.length, 1, 'a closed server does not broadcast')
    assert.equal(updates.close.calls.length, 1)
  })

  it('a server with no module wired is unaffected', () => {
    const calls = mkServer(null)
    assert.deepEqual(calls, [])
  })
})

describe('daemon_update_status on auth (sendPostAuthInfo)', () => {
  function run(clientFields, daemonUpdate) {
    const sends = []
    const ws = { readyState: 1, send: () => {}, close: createSpy() }
    const ctx = {
      clients: new Map(),
      sessionManager: null, cliSession: null, defaultSessionId: null,
      serverMode: 'multi', serverVersion: '0.2.0', latestVersion: '0.2.0', gitInfo: { commit: 'abc1234' },
      encryptionEnabled: false, localhostBypass: false, keyExchangeTimeoutMs: 5000,
      protocolVersion: 3, minProtocolVersion: 1,
      webTaskManager: { getFeatureStatus: () => ({ available: false, remote: false, teleport: false }) },
      send: (_ws, msg) => sends.push(msg),
      broadcast: createSpy(), getConnectedClientList: createSpy(() => []),
      permissions: { resendPendingPermissions: createSpy() },
      daemonUpdate,
    }
    ctx.clients.set(ws, { id: 'c', socketIp: '10.0.0.1', activeSessionId: null, encryptionPending: false, postAuthQueue: null, ...clientFields })
    sendPostAuthInfo(ctx, ws)
    return sends.filter((m) => m.type === 'daemon_update_status')
  }
  const module = { getStatus: () => STATUS }

  it('a strict-primary unbound client gets it', () => {
    const got = run(clients.primary, module)
    assert.equal(got.length, 1)
    assert.equal(got[0].running, STATUS.running)
  })

  it('pairing, class-less, bound-pairing and bound-primary clients get nothing', () => {
    for (const name of ['pairing', 'noClass', 'boundPairing', 'boundPrimary']) {
      assert.equal(run(clients[name], module).length, 0, name)
    }
  })

  it('no module, or a module that throws, never breaks the handshake', () => {
    assert.equal(run(clients.primary, null).length, 0)
    assert.equal(run(clients.primary, { getStatus: () => { throw new Error('boom') } }).length, 0)
  })
})
