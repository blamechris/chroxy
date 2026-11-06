import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BOUND_OUTGOING_ALLOWED,
  BOUND_OUTGOING_DENIED,
  BOUND_OUTGOING_REDACTED,
  BOUND_OUTGOING_SCHEMALESS_ALLOWED,
  BOUND_OUTGOING_SCHEMALESS_DENIED,
  NOT_CLIENT_FRAMES,
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

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// Names the source hands to a send/broadcast style call as `type: '...'`.
function emittedTypes() {
  const found = new Set()
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name)
      if (e.isDirectory()) walk(f)
      else if (e.name.endsWith('.js')) {
        const src = readFileSync(f, 'utf8')
        const re = /(?:send|sendFn|_send|broadcast|_broadcast|broadcastToSession|_broadcastToSession|broadcastMinProtocolVersion|sendMessage|emit)\s*\([^;]{0,400}?\btype:\s*'([a-z_]+)'/gs
        for (const m of src.matchAll(re)) found.add(m[1])
      }
    }
  }
  walk(SRC)
  return found
}

describe('frames with no outbound schema', () => {
  const emitted = emittedTypes()
  const schemaless = [...BOUND_OUTGOING_SCHEMALESS_ALLOWED, ...BOUND_OUTGOING_SCHEMALESS_DENIED]

  it('every type the source emits is classified (a new frame must be decided)', () => {
    const known = new Set([...schemaTypes, ...schemaless, ...NOT_CLIENT_FRAMES])
    const unclassified = [...emitted].filter((t) => !known.has(t)).sort()
    assert.deepEqual(unclassified, [], 'classify each new frame in src/outgoing-policy.js')
  })

  it('every classified schema-less name is really emitted by the source (no stale entries)', () => {
    const stale = [...schemaless, ...NOT_CLIENT_FRAMES].filter((t) => !emitted.has(t))
    assert.deepEqual(stale, [])
  })

  it('no name is in two lists', () => {
    const all = [...schemaless, ...NOT_CLIENT_FRAMES, ...BOUND_OUTGOING_ALLOWED, ...BOUND_OUTGOING_DENIED, ...BOUND_OUTGOING_REDACTED]
    assert.equal(new Set(all).size, all.length)
  })

  it('a frame carrying the daemon credential is never delivered', () => {
    assert.equal(frameForBoundClient({ type: 'token_rotated', token: 'primary-secret' }), null)
    assert.equal(frameForBoundClient({ type: 'pairing_refreshed' }), null)
  })

  it('the connection-ending notice and the token-less revoke notice still reach a session-scoped connection', () => {
    for (const reason of ['revoked', 'expired', 'evicted', 'invalid']) {
      assert.deepEqual(frameForBoundClient({ type: 'credential_invalidated', reason }), { type: 'credential_invalidated', reason })
    }
    // The revoke notice passes with any token removed; a scheduled rotation never does.
    assert.deepEqual(
      frameForBoundClient({ type: 'token_rotated', token: 'primary-secret', newToken: 'x', expiresAt: 5, reason: 'revoke', extra: 1 }),
      { type: 'token_rotated', reason: 'revoke' },
    )
    assert.equal(frameForBoundClient({ type: 'token_rotated', expiresAt: 5, reason: 'scheduled' }), null)
    assert.equal(frameForBoundClient({ type: 'token_rotated', token: 'primary-secret', expiresAt: 5 }), null)
  })

  it('delivery is deny-by-default: an unclassified or untyped frame is dropped', () => {
    assert.equal(frameForBoundClient({ type: 'some_future_frame', data: 1 }), null)
    assert.equal(frameForBoundClient({ data: 1 }), null)
    assert.equal(frameForBoundClient(null), null)
    assert.equal(frameForBoundClient({ type: '__proto__' }), null)
  })

  it('classified session frames still arrive', () => {
    for (const t of ['session_switched', 'history_replay_start', 'status', 'stream_delta', 'permission_request']) {
      const m = { type: t, sessionId: 's' }
      assert.equal(frameForBoundClient(m), m, t)
    }
  })
})

describe('session_status (agent-declared status)', () => {
  it('is classified as a session-scoped frame (allowed)', () => {
    assert.ok(BOUND_OUTGOING_ALLOWED.includes('session_status'))
    const m = { type: 'session_status', sessionId: 'session-1', declaredStatus: { state: 'working' } }
    assert.equal(frameForBoundClient(m), m)
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

  it('removes the host-wide fields from auth_ok', () => {
    const out = frameForBoundClient({ type: 'auth_ok', clientId: 'c', billingCanary: { warnings: [{ sessionId: 'other' }] }, webFeatures: { remote: true }, exposure: { lan: true } })
    for (const k of ['billingCanary', 'webFeatures', 'exposure']) assert.equal(k in out, false, k)
    assert.equal(out.clientId, 'c')
  })

  it('redacts auth_bootstrap itself: no providers, project-level catalog entries only', () => {
    const out = frameForBoundClient({
      type: 'auth_bootstrap',
      providers: [{ name: 'claude-sdk', auth: { ready: true } }],
      defaultProvider: 'claude-sdk',
      slashCommands: [{ name: 'a', source: 'project' }, { name: 'b', source: 'user' }, { name: 'c', source: 'builtin' }],
      agents: [{ name: 'x', source: 'user' }, { name: 'y', source: 'project' }],
    })
    assert.deepEqual(out.providers, [])
    assert.deepEqual(out.slashCommands.map((c) => c.name), ['a', 'c'])
    assert.deepEqual(out.agents.map((c) => c.name), ['y'])
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

  it('a direct frame tagged with another session is not delivered', async () => {
    const port = await start()
    const scoped = pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
    const guest = await authed(port, scoped)
    const clientWs = [...server.clients.entries()].find(([, c]) => c.boundSessionId === 'session-1')[0]
    server._send(clientWs, { type: 'stream_delta', sessionId: 'session-2', delta: 'other session text' })
    server._send(clientWs, { type: 'stream_delta', sessionId: 'session-1', delta: 'own session text' })
    server._send(clientWs, { type: 'token_rotated', token: 'primary-secret' })
    await waitFor(() => guest.messages.find((m) => m.delta === 'own session text'), { label: 'own delta' })
    const all = JSON.stringify(guest.messages)
    assert.equal(all.includes('other session text'), false)
    assert.equal(all.includes('primary-secret'), false)
  })

  it('session_status is delivered for the bound session and withheld for another', async () => {
    const port = await start()
    const scoped = pm.validatePairing(pm.generateBoundPairing('session-1').pairingId).sessionToken
    const guest = await authed(port, scoped)
    const clientWs = [...server.clients.entries()].find(([, c]) => c.boundSessionId === 'session-1')[0]
    server._send(clientWs, { type: 'session_status', sessionId: 'session-2', declaredStatus: { state: 'other session status' } })
    server._send(clientWs, { type: 'session_status', sessionId: 'session-1', declaredStatus: { state: 'own session status' } })
    await waitFor(() => guest.messages.find((m) => m.type === 'session_status'), { label: 'own status' })
    const all = JSON.stringify(guest.messages)
    assert.ok(all.includes('own session status'))
    assert.equal(all.includes('other session status'), false)
  })
})
