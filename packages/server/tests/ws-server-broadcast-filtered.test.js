import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WsServer } from '../src/ws-server.js'
import { createMockSessionManager } from './test-helpers.js'

/**
 * #7722 — `WsServer.broadcastFiltered(message, filter)` is the seam the
 * models-overlay hot-reload uses to address a roster at one provider's clients
 * instead of every client. Its caller's test uses a FAKE wsServer, which proves
 * the callback HANDS OVER a filter but nothing about whether the real method
 * applies it. Without the cases below, changing the body to
 * `this._broadcast(message)` — dropping the filter, a plausible casualty of any
 * refactor of the `_broadcast` signature — leaves the entire server suite green
 * while every client receives every provider's roster again.
 *
 * Driven through the REAL WsServer and its REAL WsBroadcaster, with fake sockets
 * in the clients map. No listening socket, so no port and no teardown race.
 */

function fakeWs() {
  return { readyState: 1, bufferedAmount: 0, close() {} }
}
function fakeClient(id, activeSessionId, ws) {
  return { id, authenticated: true, activeSessionId, subscribedSessionIds: new Set(), _ws: ws, deviceInfo: null, protocolVersion: null, _backpressureDrops: 0 }
}

describe('#7722 WsServer.broadcastFiltered', () => {
  let server
  let sent

  beforeEach(() => {
    server = new WsServer({ noEncrypt: true, sessionManager: createMockSessionManager() })
    sent = []
    // Capture at the SEND boundary — below broadcastFiltered and below the
    // broadcaster's own filter application, so what lands here is what a socket
    // would actually have received.
    server._broadcaster._sendFn = (ws, message) => { sent.push({ ws, message }) }
    for (const [id, sid] of [['c-codex', 's-codex'], ['c-claude', 's-claude'], ['c-unbound', null]]) {
      const ws = fakeWs()
      server.clients.set(ws, fakeClient(id, sid, ws))
    }
  })
  afterEach(() => { server = null; sent = [] })

  const idsThatReceived = () => sent.map(({ ws }) => server?.clients?.get(ws)?.id).filter(Boolean)

  it('delivers ONLY to clients the filter accepts', () => {
    server.broadcastFiltered({ type: 'available_models', models: [], defaultModel: null, provider: 'codex' },
      (client) => client.activeSessionId === 's-codex')
    assert.equal(sent.length, 1, 'exactly one client received it')
    assert.deepEqual(idsThatReceived(), ['c-codex'])
  })

  it('a filter that accepts nobody sends nothing (and does not throw)', () => {
    server.broadcastFiltered({ type: 'available_models', models: [], defaultModel: null, provider: 'nobody' }, () => false)
    assert.deepEqual(sent, [])
  })

  it('a filter accepting several delivers to each exactly once', () => {
    server.broadcastFiltered({ type: 'available_models', models: [], defaultModel: null, provider: null },
      (client) => client.activeSessionId !== 's-codex')
    assert.deepEqual(idsThatReceived().sort(), ['c-claude', 'c-unbound'])
  })

  it('the filter receives the real CLIENT object, with activeSessionId on it', () => {
    // The routing predicate reads `client.activeSessionId`. This pins that the
    // argument really is the client (not the socket, not a wrapper), so the
    // sibling routing test's `{ activeSessionId }` fake is a faithful stand-in.
    const seen = []
    server.broadcastFiltered({ type: 'available_models', models: [], defaultModel: null, provider: null }, (client) => {
      seen.push({ hasId: typeof client?.id === 'string', activeSessionId: client?.activeSessionId })
      return false
    })
    assert.equal(seen.length, 3, 'the filter was consulted once per authenticated, open client')
    assert.ok(seen.every((s) => s.hasId), 'the filter argument is the client object')
    assert.deepEqual(seen.map((s) => s.activeSessionId).sort((a, b) => String(a).localeCompare(String(b))),
      [null, 's-claude', 's-codex'])
  })

  it('skips an unauthenticated client and a closing socket before consulting the filter', () => {
    const deadWs = fakeWs()
    deadWs.readyState = 3
    server.clients.set(deadWs, fakeClient('c-closing', 's-codex', deadWs))
    const unauthWs = fakeWs()
    const unauth = fakeClient('c-unauth', 's-codex', unauthWs)
    unauth.authenticated = false
    server.clients.set(unauthWs, unauth)

    const consulted = []
    server.broadcastFiltered({ type: 'available_models', models: [], defaultModel: null, provider: 'codex' }, (client) => {
      consulted.push(client.id)
      return client.activeSessionId === 's-codex'
    })
    assert.ok(!consulted.includes('c-closing'), 'a closing socket is never offered to the filter')
    assert.ok(!consulted.includes('c-unauth'), 'an unauthenticated client is never offered to the filter')
    assert.deepEqual(idsThatReceived(), ['c-codex'], 'and neither receives the message')
  })

  it('a THROWING filter is isolated — later clients still receive the message', () => {
    // The docblock claims broadcastFiltered adds no semantics because the
    // broadcaster already isolates a throwing filter. That claim is only worth
    // making if it is asserted through the public method.
    server.broadcastFiltered({ type: 'available_models', models: [], defaultModel: null, provider: null }, (client) => {
      if (client.id === 'c-codex') throw new Error('filter blew up')
      return true
    })
    assert.deepEqual(idsThatReceived().sort(), ['c-claude', 'c-unbound'],
      'the throwing client is skipped and the broadcast continues')
  })
})
