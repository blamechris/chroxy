import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import {
  BOUND_OUTGOING_ALLOWED,
  BOUND_OUTGOING_DENIED,
  BOUND_OUTGOING_REDACTED,
  frameForBoundClient,
} from '../src/outgoing-policy.js'
import { SCHEMA_BACKED_OUTBOUND_TYPES } from '../src/ws-outbound-schemas.js'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { createMockSessionManager, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'

const lists = { denied: BOUND_OUTGOING_DENIED, redacted: BOUND_OUTGOING_REDACTED, allowed: BOUND_OUTGOING_ALLOWED }
const schemaTypes = new Set(SCHEMA_BACKED_OUTBOUND_TYPES)

describe('outgoing frame classification', () => {
  it('every schema-backed frame type is classified (a new frame must be decided)', () => {
    const classified = new Set([...BOUND_OUTGOING_DENIED, ...BOUND_OUTGOING_REDACTED, ...BOUND_OUTGOING_ALLOWED])
    const missing = SCHEMA_BACKED_OUTBOUND_TYPES.filter((t) => !classified.has(t))
    assert.deepEqual(missing, [], 'classify each new server frame in src/outgoing-policy.js')
  })

  it('every classified name is a real frame type (no stale entries)', () => {
    for (const [name, list] of Object.entries(lists)) {
      const stale = list.filter((t) => !schemaTypes.has(t))
      assert.deepEqual(stale, [], `${name} lists names that are not frame types`)
    }
  })

  it('no type is in two lists', () => {
    const seen = new Map()
    for (const [name, list] of Object.entries(lists)) {
      for (const t of list) {
        assert.equal(seen.has(t), false, `${t} is in ${seen.get(t)} and ${name}`)
        seen.set(t, name)
      }
    }
  })

  it('host-wide frames stay unavailable (independent of the lists)', () => {
    for (const t of ['notification_prefs', 'byok_credentials_status', 'billing_canary', 'credentials_status', 'monthly_budget', 'host_status_snapshot', 'web_task_list', 'environment_list']) {
      assert.equal(frameForBoundClient({ type: t }), null, t)
    }
  })
})

describe('frameForBoundClient', () => {
  it('removes an authorization URL from every server entry and touches nothing else', () => {
    const msg = {
      type: 'mcp_servers',
      sessionId: 's',
      servers: [
        { name: 'a', status: 'oauth-required', authUrl: 'https://idp.example/authorize?state=abc' },
        { name: 'b', status: 'connected' },
      ],
    }
    const out = frameForBoundClient(msg)
    assert.equal(JSON.stringify(out).includes('state=abc'), false)
    assert.equal(JSON.stringify(out).includes('authUrl'), false)
    assert.deepEqual(out.servers.map((s) => s.name), ['a', 'b'])
    assert.equal(out.servers[0].status, 'oauth-required')
    assert.ok('authUrl' in msg.servers[0], 'the original frame is not modified (other recipients still get it)')
  })

  it('removes the billing snapshot from auth_ok', () => {
    const out = frameForBoundClient({ type: 'auth_ok', clientId: 'c', billingCanary: { warnings: [{ sessionId: 'other' }] } })
    assert.equal('billingCanary' in out, false)
    assert.equal(out.clientId, 'c')
  })

  it('passes a session-scoped frame through unchanged', () => {
    const msg = { type: 'stream_delta', sessionId: 's', delta: 'x' }
    assert.equal(frameForBoundClient(msg), msg)
  })
})

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

describe('what a session-scoped connection is sent, over a real socket', () => {
  let server
  let pm
  const sockets = []
  afterEach(() => {
    for (const s of sockets.splice(0)) s.close()
    if (server) { server.close(); server = null }
    if (pm) { pm.destroy(); pm = null }
  })

  async function start() {
    pm = new PairingManager({ wsUrl: 'wss://example.com' })
    const { manager } = createMockSessionManager([{ id: 'session-1', name: 'One', cwd: '/tmp/p1' }])
    server = new WsServer({
      port: 0, apiToken: 'primary-tok', sessionManager: manager, authRequired: true, pairingManager: pm,
    })
    server.setBillingCanaryProvider(() => ({ warnings: [{ code: 'x', sessionId: 'other-session', spendUsd: 99 }] }))
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    return server.httpServer.address().port
  }

  async function authed(port, token) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []
    ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    sockets.push(ws)
    ws.send(JSON.stringify({ type: 'auth', token }))
    await waitFor(() => messages.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
    return { ws, messages }
  }

  it('is sent no host-wide broadcast, and is sent the redacted form of the rest', async () => {
    const port = await start()
    const scoped = pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
    const guest = await authed(port, scoped)
    const owner = await authed(port, 'primary-tok')

    server._broadcast({ type: 'notification_prefs', prefs: { devices: { 'ExponentPushToken[abc]': {} } } })
    server._broadcast({ type: 'byok_credentials_status', providers: [] })
    server._broadcast({ type: 'billing_canary', warnings: [{ sessionId: 'other-session' }] })
    server._broadcast({ type: 'mcp_servers', sessionId: 'session-1', servers: [{ name: 'm', status: 'oauth-required', authUrl: 'https://idp.example/a?state=zzz' }] })
    await waitFor(() => owner.messages.find((m) => m.type === 'mcp_servers'), { label: 'owner mcp_servers' })
    await waitFor(() => guest.messages.find((m) => m.type === 'mcp_servers'), { label: 'guest mcp_servers' })

    for (const t of ['notification_prefs', 'byok_credentials_status', 'billing_canary']) {
      assert.equal(owner.messages.some((m) => m.type === t), true, `control: an unscoped connection receives ${t}`)
      assert.equal(guest.messages.some((m) => m.type === t), false, `a session-scoped connection must not receive ${t}`)
    }
    assert.equal(JSON.stringify(guest.messages).includes('state=zzz'), false, 'no usable authorization URL reaches it')
    assert.ok(JSON.stringify(owner.messages).includes('state=zzz'), 'control: the unscoped connection still gets the URL')
    const authOk = guest.messages.find((m) => m.type === 'auth_ok')
    assert.equal('billingCanary' in authOk, false)
    const ownerAuthOk = owner.messages.find((m) => m.type === 'auth_ok')
    assert.equal('billingCanary' in ownerAuthOk, true, 'control: the unscoped connection gets the snapshot')
  })

  it('is not sent an authorization URL in the replay a new subscriber gets', async () => {
    const port = await start()
    const entry = server.sessionManager.getSession('session-1')
    entry.session.getMcpServersSnapshot = () => ({ type: 'mcp_servers', servers: [{ name: 'm', status: 'oauth-required', authUrl: 'https://idp.example/a?state=replay' }] })
    const scoped = pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
    const guest = await authed(port, scoped)
    await waitFor(() => guest.messages.find((m) => m.type === 'mcp_servers'), { label: 'replayed snapshot' })
    assert.equal(JSON.stringify(guest.messages).includes('state=replay'), false)
    const owner = await authed(port, 'primary-tok')
    await waitFor(() => owner.messages.find((m) => m.type === 'mcp_servers'), { label: 'owner replayed snapshot' })
    assert.ok(JSON.stringify(owner.messages).includes('state=replay'))
  })
})
