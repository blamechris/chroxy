/**
 * #5555 (sub-item 7) — `tunnel_url_changed` client push + auth_bootstrap
 * tunnelUrl re-advertisement.
 *
 * Quick-tunnel recovery rotates the public URL. Before this, the
 * `tunnel_url_changed` event dead-ended server-side and users discovered the
 * dead URL via failed reconnects. The server now:
 *   1. tracks the current public URL (`setTunnelUrl` / `tunnelUrl` getter),
 *   2. broadcasts a `tunnel_url_changed` frame to ALL authenticated clients on
 *      a rotation (`broadcastTunnelUrlChanged`),
 *   3. folds the live URL into the auth_bootstrap burst so a reconnecting
 *      client always re-learns it.
 *
 * These tests drive the WsServer's broadcast surface directly with fake clients
 * in the map (no real socket / tunnel), so no network is touched.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { WsServer } from '../src/ws-server.js'
import { createMockSession } from './test-helpers.js'

function makeServer() {
  return new WsServer({
    port: 0,
    apiToken: 'test-token',
    cliSession: createMockSession(),
    authRequired: false,
    noEncrypt: true,
  })
}

/** Inject a fake authenticated client straight into the clients map + capture sends. */
function addFakeClient(server, { id, authenticated = true, boundSessionId = null } = {}) {
  const sent = []
  const ws = { readyState: 1, bufferedAmount: 0, send(data) { sent.push(JSON.parse(data)) }, close() {} }
  server.clients.set(ws, {
    id,
    authenticated,
    boundSessionId,
    activeSessionId: null,
    subscribedSessionIds: new Set(),
    deviceInfo: null,
    protocolVersion: null,
    _backpressureDrops: 0,
  })
  return { ws, sent }
}

describe('WsServer tunnel URL tracking (#5555)', () => {
  let server
  beforeEach(() => { server = makeServer() })

  it('tunnelUrl is null until set, then reflects setTunnelUrl', () => {
    assert.equal(server.tunnelUrl, null)
    server.setTunnelUrl('wss://abc.trycloudflare.com')
    assert.equal(server.tunnelUrl, 'wss://abc.trycloudflare.com')
    // Empty / falsy clears back to null.
    server.setTunnelUrl('')
    assert.equal(server.tunnelUrl, null)
  })
})

describe('WsServer.broadcastTunnelUrlChanged (#5555)', () => {
  let server
  beforeEach(() => { server = makeServer() })

  it('pushes tunnel_url_changed to every authenticated client (bound included)', () => {
    const a = addFakeClient(server, { id: 'host', boundSessionId: null })
    const b = addFakeClient(server, { id: 'bound', boundSessionId: 'sess-1' })

    server.broadcastTunnelUrlChanged('wss://new.trycloudflare.com', 'wss://old.trycloudflare.com')

    // The tunnel URL is connection metadata (the QR shares it), not a secret —
    // so a pairing-bound client receives it too.
    for (const sent of [a.sent, b.sent]) {
      const frame = sent.find((m) => m.type === 'tunnel_url_changed')
      assert.ok(frame, 'each authenticated client got the frame')
      assert.equal(frame.url, 'wss://new.trycloudflare.com')
      assert.equal(frame.previousUrl, 'wss://old.trycloudflare.com')
    }
  })

  it('records the new URL on the server so auth_bootstrap re-advertises it', () => {
    addFakeClient(server, { id: 'host' })
    assert.equal(server.tunnelUrl, null)
    server.broadcastTunnelUrlChanged('wss://new.trycloudflare.com')
    assert.equal(server.tunnelUrl, 'wss://new.trycloudflare.com')
  })

  it('omits previousUrl when not provided', () => {
    const a = addFakeClient(server, { id: 'host' })
    server.broadcastTunnelUrlChanged('wss://new.trycloudflare.com')
    const frame = a.sent.find((m) => m.type === 'tunnel_url_changed')
    assert.ok(frame)
    assert.equal('previousUrl' in frame, false)
  })

  it('is a no-op for a falsy URL (no push, no state change)', () => {
    const a = addFakeClient(server, { id: 'host' })
    server.broadcastTunnelUrlChanged('')
    assert.equal(a.sent.some((m) => m.type === 'tunnel_url_changed'), false)
    assert.equal(server.tunnelUrl, null)
  })

  it('does not push to unauthenticated clients', () => {
    const pending = addFakeClient(server, { id: 'pending', authenticated: false })
    server.broadcastTunnelUrlChanged('wss://new.trycloudflare.com')
    assert.equal(pending.sent.some((m) => m.type === 'tunnel_url_changed'), false)
  })
})
