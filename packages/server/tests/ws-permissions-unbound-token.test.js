import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createPermissionHandler } from '../src/ws-permissions.js'

/**
 * Security regression test (swarm-audit finding).
 *
 * The HTTP `POST /permission-response` fallback authenticates via the broad
 * `_validateBearerAuth` (which accepts pairing-issued tokens), then looks up the
 * token's bound session. A BOUND pairing token is binding-checked by the resolver
 * (can only answer its own session). But an UNBOUND pairing token — e.g. one a
 * device obtained by scanning the auto-refreshing linking-mode QR, which is issued
 * PRE host-approval — resolved to `callerBoundSessionId=null`, which the resolver
 * treats as unrestricted, letting it answer ANY session's permission.
 *
 * The fix rejects unbound pairing tokens at this endpoint with a 403. The primary
 * API token (not a pairing token) and bound pairing tokens are unaffected.
 */

function makeReq(body, headers = {}) {
  const emitter = new EventEmitter()
  emitter.method = 'POST'
  emitter.headers = headers
  emitter.socket = { remoteAddress: '127.0.0.1' }
  process.nextTick(() => {
    emitter.emit('data', Buffer.from(body))
    emitter.emit('end')
  })
  emitter.destroy = mock.fn()
  emitter.setEncoding = mock.fn()
  emitter.pause = mock.fn()
  return emitter
}

function makeRes() {
  const listeners = {}
  return {
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code },
    end(b) { this.body = b },
    on(event, cb) { listeners[event] = cb; return this },
    emit(event, ...args) { if (listeners[event]) listeners[event](...args) },
  }
}

describe('HTTP /permission-response rejects unbound pairing tokens (swarm-audit security fix)', () => {
  let handler
  let pairingTokens // token -> boundSessionId | null

  beforeEach(() => {
    pairingTokens = new Map()
    const pairingManager = {
      // True for any token this PairingManager issued (bound OR unbound); false
      // for the primary API token — exactly how the real isSessionTokenValid behaves.
      isSessionTokenValid: (t) => pairingTokens.has(t),
      getSessionIdForToken: (t) => (pairingTokens.has(t) ? pairingTokens.get(t) : null),
    }
    handler = createPermissionHandler({
      sendFn: mock.fn(),
      broadcastFn: mock.fn(),
      validateBearerAuth: mock.fn(() => true),
      pendingPermissions: new Map(),
      permissionSessionMap: new Map(),
      getSessionManager: () => ({ getSession: () => null }),
      pairingManager,
    })
  })

  afterEach(() => {
    handler?.destroy()
  })

  async function respond(token) {
    const req = makeReq(
      JSON.stringify({ requestId: 'perm-1', decision: 'allow' }),
      { authorization: `Bearer ${token}` },
    )
    const res = makeRes()
    handler.handlePermissionResponseHttp(req, res)
    await new Promise((r) => setImmediate(r))
    return res
  }

  it('rejects an UNBOUND pairing token with 403 (closes the linking-mode-QR cross-session gap)', async () => {
    pairingTokens.set('unbound-linking-token', null) // valid pairing token, no bound session
    const res = await respond('unbound-linking-token')
    assert.equal(res.statusCode, 403)
    assert.match(String(res.body), /unbound token/)
  })

  it('does NOT reject the primary API token (it is not a pairing token)', async () => {
    // Not in pairingTokens → isSessionTokenValid=false → not a pairing token → the
    // unbound guard is skipped; it proceeds (and 404s on the unknown requestId).
    const res = await respond('primary-api-token')
    assert.doesNotMatch(String(res.body ?? ''), /unbound token/)
  })

  it('does NOT reject a BOUND pairing token at the unbound guard (resolver binding-checks it)', async () => {
    pairingTokens.set('bound-token', 'sess-X')
    const res = await respond('bound-token')
    assert.doesNotMatch(String(res.body ?? ''), /unbound token/)
  })
})
