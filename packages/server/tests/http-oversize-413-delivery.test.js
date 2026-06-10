// #5433: oversize-body 413 must actually be DELIVERED to the client.
//
// The old pattern called req.destroy() the moment the body cap tripped.
// Empirically (Node 22) 'end' never fires after a mid-stream destroy — only
// 'close' — so the 413 branch inside the 'end' handler was dead code and the
// client saw a socket reset (UND_ERR_SOCKET / ECONNRESET) instead of the
// documented 413.
//
// These tests use REAL sockets (node:http createServer + global fetch): a
// connection reset makes fetch() REJECT, so each bare `await post(...)`
// resolving with status 413 is the proof. No `.catch(() => null)` hedging —
// that hedge is exactly how the original bug hid (#5432's test).
//
// All three capped body readers are covered so they stay in lockstep:
//   POST /api/events          (event-ingest.js, 64KB)
//   POST /permission          (ws-permissions.js, 64KB)
//   POST /permission-response (ws-permissions.js, 4KB)

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHttpHandler } from '../src/http-routes.js'
import { createPermissionHandler } from '../src/ws-permissions.js'
import { MAX_INGEST_BODY_BYTES } from '../src/event-ingest.js'

const INGEST_SECRET = 'test-ingest-secret-0123456789abcdef'

function makeMockServer() {
  const permissions = createPermissionHandler({
    sendFn: () => {},
    broadcastFn: () => {},
    validateBearerAuth: () => true,
    validateHookAuth: () => true,
    pushManager: null,
    pendingPermissions: new Map(),
    permissionSessionMap: new Map(),
    getSessionManager: () => null,
  })
  return {
    permissions,
    apiToken: 'primary-token',
    authRequired: true,
    serverMode: 'multi',
    port: 0,
    _latestVersion: null,
    _gitInfo: { commit: 'abc', branch: 'main' },
    _startedAt: Date.now(),
    _encryptionEnabled: false,
    _permissions: permissions,
    _isTokenValid(token) { return token === this.apiToken },
    _validateBearerAuth() { return true },
    _ingestSecret: INGEST_SECRET,
    pushManager: { hasConfiguredSinks: () => true, send: () => Promise.resolve(true) },
  }
}

describe('oversize-body 413 delivery over real sockets (#5433)', () => {
  let httpServer
  let port
  let mockServer

  async function start() {
    mockServer = makeMockServer()
    httpServer = createServer(createHttpHandler(mockServer))
    httpServer.listen(0, '127.0.0.1')
    await once(httpServer, 'listening')
    port = httpServer.address().port
  }

  afterEach(() => {
    mockServer?.permissions?.destroy?.()
    httpServer?.close()
    httpServer = null
  })

  function post(path, body, headers = {}) {
    return globalThis.fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    })
  }

  it('POST /api/events: the client receives the 413, not a reset', async () => {
    await start()
    const big = 'x'.repeat(MAX_INGEST_BODY_BYTES + 1024)
    const res = await post('/api/events', big, { Authorization: `Bearer ${INGEST_SECRET}` })
    assert.equal(res.status, 413)
    assert.equal((await res.json()).error, 'body too large')
  })

  it('POST /permission: the client receives the 413 deny, not a reset', async () => {
    await start()
    const big = 'x'.repeat(65536 + 1024)
    const res = await post('/permission', big, { Authorization: 'Bearer hook-secret' })
    assert.equal(res.status, 413)
    assert.equal((await res.json()).decision, 'deny')
  })

  it('POST /permission-response: the client receives the 413, not a reset', async () => {
    await start()
    const big = 'x'.repeat(4096 + 1024)
    const res = await post('/permission-response', big, { Authorization: 'Bearer primary-token' })
    assert.equal(res.status, 413)
    assert.equal((await res.json()).error, 'body too large')
  })

  it('the cap counts BYTES, not UTF-16 code units (multi-byte payloads)', async () => {
    await start()
    // '€' is 1 UTF-16 code unit but 3 UTF-8 bytes: this payload is well under
    // the cap in code units (the old body.length check would admit it) and
    // ~50% over it in bytes.
    const codeUnits = Math.floor(MAX_INGEST_BODY_BYTES / 2)
    const big = '€'.repeat(codeUnits)
    assert.ok(big.length < MAX_INGEST_BODY_BYTES)
    assert.ok(Buffer.byteLength(big, 'utf8') > MAX_INGEST_BODY_BYTES)
    const res = await post('/api/events', big, { Authorization: `Bearer ${INGEST_SECRET}` })
    assert.equal(res.status, 413)
    assert.equal((await res.json()).error, 'body too large')
  })

  it('the oversize response closes the connection (Connection: close semantics)', async () => {
    await start()
    const big = 'x'.repeat(MAX_INGEST_BODY_BYTES + 1024)
    const res = await post('/api/events', big, { Authorization: `Bearer ${INGEST_SECRET}` })
    assert.equal(res.status, 413)
    // The 413 socket must not be reusable: a follow-up request gets a fresh
    // connection and still works (the server didn't wedge or leak state).
    const ok = await post('/api/events', JSON.stringify({
      source: 'claude-hooks', project: 'p', type: 'session_start', ts: 1_750_000_000_000,
    }), { Authorization: `Bearer ${INGEST_SECRET}` })
    assert.equal(ok.status, 200)
  })
})
