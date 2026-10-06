import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { computeDaemonIdleState } from '../src/daemon-idle-state.js'
import { createHttpHandler } from '../src/http-routes.js'
import { WsServer } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { BaseSession } from '../src/base-session.js'

// #8324 — GET /api/daemon/idle, the probe the idle-only auto-deploy asks before
// it restarts the daily daemon. The verdict must be "idle" ONLY when nothing
// would be lost, and every inability to check must read as NOT idle.

function row(over = {}) {
  return {
    sessionId: 's1',
    name: 'main',
    isBusy: false,
    busyReason: null,
    backgroundShellCount: 0,
    ...over,
  }
}

function fakeManager(rows, sessionById = {}) {
  const sessions = new Map()
  for (const r of rows) {
    sessions.set(r.sessionId, {
      session: {
        getPendingPermissionCount: () => 0,
        getPendingQuestions: () => [],
        ...(sessionById[r.sessionId] || {}),
      },
    })
  }
  return {
    listSessions: () => rows,
    getSession: (id) => sessions.get(id) ?? null,
  }
}

describe('computeDaemonIdleState (#8324)', () => {
  it('is idle with no sessions and no hook permissions', () => {
    const out = computeDaemonIdleState({ sessionManager: fakeManager([]), getHookPendingPermissionCount: () => 0 })
    assert.equal(out.idle, true)
    assert.deepEqual(out.reasons, [])
    assert.deepEqual(out.sessions, [])
    assert.equal(out.hookPendingPermissions, 0)
  })

  it('is idle when sessions exist but none is busy or waiting on a human', () => {
    const out = computeDaemonIdleState({
      sessionManager: fakeManager([row(), row({ sessionId: 's2', name: 'two' })]),
      getHookPendingPermissionCount: () => 0,
    })
    assert.equal(out.idle, true)
    assert.equal(out.sessions.length, 2)
    assert.deepEqual(Object.keys(out.sessions[0]).sort(), [
      'backgroundShellCount', 'busyReason', 'isBusy', 'name', 'pendingPermissions', 'pendingQuestions', 'sessionId',
    ])
  })

  it('a mid-turn session is not idle and says why', () => {
    const out = computeDaemonIdleState({
      sessionManager: fakeManager([row({ isBusy: true, busyReason: 'turn' })]),
      getHookPendingPermissionCount: () => 0,
    })
    assert.equal(out.idle, false)
    assert.ok(out.reasons.includes('session "main" busy: turn'))
  })

  it('a session held busy by a background shell is not idle', () => {
    const out = computeDaemonIdleState({
      sessionManager: fakeManager([row({ isBusy: true, busyReason: 'background-shells', backgroundShellCount: 2 })]),
      getHookPendingPermissionCount: () => 0,
    })
    assert.equal(out.idle, false)
    assert.ok(out.reasons.includes('session "main" busy: background-shells'))
    assert.equal(out.sessions[0].backgroundShellCount, 2)
  })

  it('a pending permission makes it not idle', () => {
    const out = computeDaemonIdleState({
      sessionManager: fakeManager([row()], { s1: { getPendingPermissionCount: () => 1 } }),
      getHookPendingPermissionCount: () => 0,
    })
    assert.equal(out.idle, false)
    assert.equal(out.sessions[0].pendingPermissions, 1)
  })

  it('a pending AskUserQuestion makes it not idle', () => {
    const out = computeDaemonIdleState({
      sessionManager: fakeManager([row()], { s1: { getPendingQuestions: () => [{ toolUseId: 't', questions: [] }] } }),
      getHookPendingPermissionCount: () => 0,
    })
    assert.equal(out.idle, false)
    assert.equal(out.sessions[0].pendingQuestions, 1)
  })

  it('a hook-routed pending permission makes it not idle', () => {
    const out = computeDaemonIdleState({ sessionManager: fakeManager([row()]), getHookPendingPermissionCount: () => 2 })
    assert.equal(out.idle, false)
    assert.equal(out.hookPendingPermissions, 2)
  })

  it('FAIL SAFE: a missing session manager is not idle', () => {
    for (const sessionManager of [null, undefined, {}]) {
      const out = computeDaemonIdleState({ sessionManager })
      assert.equal(out.idle, false)
      assert.ok(out.reasons.length > 0)
    }
  })

  it('FAIL SAFE: listSessions() throwing is not idle', () => {
    const out = computeDaemonIdleState({
      sessionManager: { listSessions: () => { throw new Error('boom') } },
      getHookPendingPermissionCount: () => 0,
    })
    assert.equal(out.idle, false)
    assert.ok(out.reasons.some((r) => r.includes('boom')))
  })

  it('FAIL SAFE: an accessor throwing is not idle', () => {
    const out = computeDaemonIdleState({
      sessionManager: fakeManager([row()], { s1: { getPendingQuestions: () => { throw new Error('q-broke') } } }),
      getHookPendingPermissionCount: () => 0,
    })
    assert.equal(out.idle, false)
    assert.ok(out.reasons.some((r) => r.includes('q-broke')))
  })

  it('FAIL SAFE: a provider with no accessor (cannot say) is not idle', () => {
    const mgr = fakeManager([row()])
    mgr.getSession = () => ({ session: {} })
    const out = computeDaemonIdleState({ sessionManager: mgr, getHookPendingPermissionCount: () => 0 })
    assert.equal(out.idle, false)
  })

  it('FAIL SAFE: a row whose session vanished is not idle', () => {
    const mgr = fakeManager([row()])
    mgr.getSession = () => null
    const out = computeDaemonIdleState({ sessionManager: mgr, getHookPendingPermissionCount: () => 0 })
    assert.equal(out.idle, false)
  })

  it('FAIL SAFE: the hook-permission accessor throwing or returning junk is not idle', () => {
    for (const fn of [() => { throw new Error('hook-broke') }, () => NaN, () => -1, () => '0']) {
      const out = computeDaemonIdleState({ sessionManager: fakeManager([row()]), getHookPendingPermissionCount: fn })
      assert.equal(out.idle, false)
    }
  })
})

describe('BaseSession.getPendingPermissionCount (#8324)', () => {
  it('counts hook-routed ids and in-process pending permissions together', () => {
    const s = new BaseSession()
    assert.equal(s.getPendingPermissionCount(), 0)
    s.notifyPermissionPending('hook-1')
    assert.equal(s.getPendingPermissionCount(), 1)
    s._pendingPermissions = new Map([['p1', {}], ['p2', {}]])
    assert.equal(s.getPendingPermissionCount(), 3)
    s.notifyPermissionResolved('hook-1')
    assert.equal(s.getPendingPermissionCount(), 2)
  })
})

describe('GET /api/daemon/idle route (#8324)', () => {
  let httpServer
  let pm
  afterEach(() => {
    httpServer?.close()
    httpServer = null
    pm?.destroy()
    pm = null
  })

  // The REAL auth methods, bound to a minimal stand-in, so the gate under test
  // is the shipped one rather than a mock that agrees with the test.
  function makeServer(overrides = {}) {
    pm = new PairingManager({ sessionTokenTtlMs: 60_000 })
    const server = {
      apiToken: 'test-token',
      authRequired: true,
      serverMode: 'multi',
      _startedAt: Date.parse('2026-10-06T00:00:00Z'),
      _gitInfo: { commit: 'abc', branch: 'main' },
      _pairingManager: pm,
      sessionManager: fakeManager([row()]),
      getHookPendingPermissionCount: () => 0,
      _isTokenValid(token) { return token === this.apiToken || pm.isSessionTokenValid(token) },
      ...overrides,
    }
    server._validatePrimaryBearerAuth = WsServer.prototype._validatePrimaryBearerAuth.bind(server)
    server._validateBearerAuth = WsServer.prototype._validateBearerAuth.bind(server)
    return server
  }

  async function start(server) {
    httpServer = createServer(createHttpHandler(server))
    httpServer.listen(0, '127.0.0.1')
    await once(httpServer, 'listening')
    return httpServer.address().port
  }

  const get = (port, headers = {}) => globalThis.fetch(`http://127.0.0.1:${port}/api/daemon/idle`, { headers })

  it('primary token over loopback: 200 with the documented shape', async () => {
    const port = await start(makeServer())
    const res = await get(port, { Authorization: 'Bearer test-token' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.idle, true)
    assert.deepEqual(body.reasons, [])
    assert.equal(body.sessions.length, 1)
    assert.equal(body.hookPendingPermissions, 0)
    assert.equal(typeof body.version, 'string')
    assert.equal(body.pid, process.pid)
    assert.equal(body.startedAt, '2026-10-06T00:00:00.000Z')
  })

  it('a busy session answers idle:false with the reason', async () => {
    const port = await start(makeServer({ sessionManager: fakeManager([row({ isBusy: true, busyReason: 'turn' })]) }))
    const body = await (await get(port, { Authorization: 'Bearer test-token' })).json()
    assert.equal(body.idle, false)
    assert.ok(body.reasons.includes('session "main" busy: turn'))
  })

  it('a pending permission or question answers idle:false', async () => {
    let port = await start(makeServer({
      sessionManager: fakeManager([row()], { s1: { getPendingPermissionCount: () => 1 } }),
    }))
    assert.equal((await (await get(port, { Authorization: 'Bearer test-token' })).json()).idle, false)
    httpServer.close()
    port = await start(makeServer({
      sessionManager: fakeManager([row()], { s1: { getPendingQuestions: () => [{ toolUseId: 't', questions: [] }] } }),
    }))
    assert.equal((await (await get(port, { Authorization: 'Bearer test-token' })).json()).idle, false)
  })

  it('a hook-routed pending permission answers idle:false', async () => {
    const port = await start(makeServer({ getHookPendingPermissionCount: () => 3 }))
    const body = await (await get(port, { Authorization: 'Bearer test-token' })).json()
    assert.equal(body.idle, false)
    assert.equal(body.hookPendingPermissions, 3)
  })

  it('FAIL SAFE: a throwing accessor still answers 200 with idle:false', async () => {
    const port = await start(makeServer({
      sessionManager: { listSessions: () => { throw new Error('manager exploded') } },
    }))
    const res = await get(port, { Authorization: 'Bearer test-token' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.idle, false)
    assert.ok(body.reasons.some((r) => r.startsWith('idle state unavailable')))
  })

  it('FAIL SAFE: the route-level guard answers idle:false when reading the manager itself throws', async () => {
    const server = makeServer()
    Object.defineProperty(server, 'sessionManager', { get() { throw new Error('getter exploded') } })
    const port = await start(server)
    const res = await get(port, { Authorization: 'Bearer test-token' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.idle, false)
    assert.ok(body.reasons.some((r) => r.includes('getter exploded')))
  })

  it('FAIL SAFE: a server with no hook-permission accessor answers idle:false', async () => {
    const port = await start(makeServer({ getHookPendingPermissionCount: undefined }))
    const body = await (await get(port, { Authorization: 'Bearer test-token' })).json()
    assert.equal(body.idle, false)
  })

  it('FAIL SAFE: no session manager answers idle:false', async () => {
    const port = await start(makeServer({ sessionManager: null }))
    const body = await (await get(port, { Authorization: 'Bearer test-token' })).json()
    assert.equal(body.idle, false)
  })

  it('rejects a pairing-bound token with primary_token_required', async () => {
    const server = makeServer()
    const { pairingId } = pm.generateBoundPairing('s1')
    const bound = pm.validatePairing(pairingId).sessionToken
    const port = await start(server)
    const res = await get(port, { Authorization: `Bearer ${bound}` })
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error, 'primary_token_required')
  })

  it('rejects a missing or wrong token (403, matching every other bearer route)', async () => {
    const port = await start(makeServer())
    assert.equal((await get(port)).status, 403)
    assert.equal((await get(port, { Authorization: 'Bearer nope' })).status, 403)
  })

  it('a loopback peer carrying cf-connecting-ip (the tunnel) is refused even with the right token', async () => {
    const port = await start(makeServer())
    const res = await get(port, { Authorization: 'Bearer test-token', 'cf-connecting-ip': '203.0.113.7' })
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error, 'forbidden')
  })

  it('a loopback peer carrying x-forwarded-for is refused even with the right token', async () => {
    const port = await start(makeServer())
    const res = await get(port, { Authorization: 'Bearer test-token', 'x-forwarded-for': '203.0.113.7' })
    assert.equal(res.status, 403)
  })

  it('the locality refusal reveals nothing about the token', async () => {
    const port = await start(makeServer())
    const good = await get(port, { Authorization: 'Bearer test-token', 'cf-connecting-ip': '1.2.3.4' })
    const bad = await get(port, { Authorization: 'Bearer wrong', 'cf-connecting-ip': '1.2.3.4' })
    assert.equal(good.status, bad.status)
    assert.deepEqual(await good.json(), await bad.json())
  })

  it('a non-loopback socket (LAN peer) is refused even with the right token', async () => {
    // Drive the handler directly: a real socket from this test is always loopback.
    const handler = createHttpHandler(makeServer())
    let status = null
    let body = ''
    const res = {
      writeHead(s) { status = s },
      setHeader() {},
      end(b) { body = b ?? '' },
    }
    const req = {
      method: 'GET',
      url: '/api/daemon/idle',
      headers: { authorization: 'Bearer test-token' },
      socket: { remoteAddress: '192.168.1.50' },
      on() {},
    }
    await handler(req, res)
    assert.equal(status, 403)
    assert.equal(JSON.parse(body).error, 'forbidden')
  })

  it('with auth disabled, locality still applies', async () => {
    const port = await start(makeServer({ authRequired: false }))
    assert.equal((await get(port)).status, 200)
    assert.equal((await get(port, { 'cf-connecting-ip': '1.2.3.4' })).status, 403)
  })
})
