/**
 * #7968 end to end: the daemon's REAL permission-floor verdict, from BOTH
 * pipelines, reaching agent-control over a real E2E-encrypted WsServer.
 *
 * Nothing here stamps `floored` by hand. Every verdict below is computed by
 * the daemon's own code:
 *   - in-process pipeline: a real PermissionManager (session cwd) ->
 *     wirePermissionManager -> the same session->manager `session_event`
 *     forwarding SessionManager installs -> the real EventNormalizer ->
 *     encrypted broadcast;
 *   - hook-routed pipeline: a real `POST /permission` on the WsServer,
 *     authenticated with a per-session hook secret, whose broadcast computes
 *     the verdict from the OWNING session's cwd;
 *   - reconnect: the real resendPendingPermissions path, replayed to a fresh
 *     client inside its handshake and flushed through the pre-ready buffer.
 *
 * The fixtures are the ones permission-floor.md names: a write under
 * `.git/hooks`, and a read of `.env`. Each refusal has a positive control
 * (an ordinary Write in the same session, allowed and applied), so a refusal
 * can never be a connection that simply failed to observe anything.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WsServer as _WsServer } from '../../src/ws-server.js'
import { PermissionManager, wirePermissionManager } from '../../src/permission-manager.js'
import { AgentControlClient } from '../../src/agent-control/client.js'
import { createMockSessionManager } from '../test-helpers.js'

class EncryptedWsServer extends _WsServer {
  constructor(opts = {}) {
    super({ localhostBypass: false, ...opts })
  }
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }
const TOKEN = 'fixture-token-only'
const HOOK_SECRET = 'fixture-hook-secret-e2e'

async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
  await once(server.httpServer, 'listening')
  return server.httpServer.address().port
}

async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** POST /permission as Claude Code's hook would. Resolves with the held HTTP decision. */
function postHookPermission(port, toolName, toolInput) {
  const body = JSON.stringify({ tool_name: toolName, tool_input: toolInput })
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/permission',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${HOOK_SECRET}` },
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) } catch (err) { reject(err) }
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

/**
 * One owned session wired the way the daemon wires an in-process provider:
 * a real PermissionManager on the session's cwd, `wirePermissionManager` onto
 * the session, and SessionManager's own transient-event forwarding.
 */
function inProcessFixture(sessionId, cwd) {
  const { manager, sessionsMap } = createMockSessionManager([{ id: sessionId, name: 'Owned', cwd, provider: 'claude-sdk' }])
  // resendPendingPermissions walks `sessionManager._sessions`, as on a real manager.
  manager._sessions = sessionsMap
  const session = sessionsMap.get(sessionId).session
  const pm = new PermissionManager({ log: silentLog, cwd })
  wirePermissionManager(session, pm)
  session.respondToPermission = (requestId, decision) => pm.respondToPermission(requestId, decision)
  for (const event of ['permission_request', 'permission_resolved', 'permission_expired']) {
    session.on(event, (data) => manager.emit('session_event', { sessionId, event, data }))
  }
  return { manager, pm }
}

describe('#7968 end to end: agent-control against the daemon\'s real floor verdict', () => {
  let server
  let clients = []
  let pms = []
  let cwd

  afterEach(async () => {
    for (const c of clients) { try { await c.close() } catch { /* already closed */ } }
    clients = []
    for (const pm of pms) { try { pm.destroy() } catch { /* already destroyed */ } }
    pms = []
    if (server) { try { server.close() } catch { /* already closed */ } server = null }
    if (cwd) { rmSync(cwd, { recursive: true, force: true }); cwd = null }
  })

  async function connect(port, ownedSessions, requestTimeoutMs = 1500) {
    const client = new AgentControlClient({ url: `ws://127.0.0.1:${port}`, token: TOKEN, connectTimeoutMs: 2500, requestTimeoutMs, silent: true, ownedSessions })
    clients.push(client)
    await client.connect()
    return client
  }

  it('in-process pipeline: a .git/hooks write and a .env read arrive floored:true and allow is refused; an ordinary Write arrives floored:false and allow is applied', async () => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-ac-floor-')))
    const sessionId = 'owned-inproc'
    const { manager, pm } = inProcessFixture(sessionId, cwd)
    pms.push(pm)
    server = new EncryptedWsServer({ port: 0, apiToken: TOKEN, sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    const client = await connect(port, new Set([sessionId]))
    await client.getEvents(sessionId) // subscribe

    const outcomes = []
    const track = (p) => p.then((r) => { outcomes.push(r); return r })
    const hook = track(pm.handlePermission('Write', { file_path: join(cwd, '.git', 'hooks', 'pre-commit'), content: '#!/bin/sh\n' }, undefined, 'approve'))
    const env = track(pm.handlePermission('Read', { file_path: join(cwd, '.env') }, undefined, 'approve'))
    const ordinary = track(pm.handlePermission('Write', { file_path: join(cwd, 'src', 'a.js'), content: 'x' }, undefined, 'approve'))

    const pending = [...pm._lastPermissionData.values()]
    assert.equal(pending.length, 3)
    const idFor = (fragment) => pending.find((p) => JSON.stringify(p.input).includes(fragment)).requestId
    const hookId = idFor('pre-commit')
    const envId = idFor('.env')
    const ordinaryId = idFor('a.js')
    await waitFor(() => [hookId, envId, ordinaryId].every((id) => client._observedPermissions.has(id)), 'all three requests observed')

    assert.equal(client._observedPermissions.get(hookId).floored, true, 'the daemon must mark a .git/hooks write floored')
    assert.equal(client._observedPermissions.get(envId).floored, true, 'the daemon must mark a .env read floored')
    assert.equal(client._observedPermissions.get(ordinaryId).floored, false, 'the daemon must mark an ordinary write NOT floored')

    for (const id of [hookId, envId]) {
      const refused = await client.respondPermission(sessionId, id, 'allow')
      assert.equal(refused.status, 'rejected', JSON.stringify(refused))
      assert.equal(refused.reason, 'floored')
      assert.ok(pm._pendingPermissions.has(id), 'a refused allow must leave the prompt pending for a human')
    }

    const allowed = await client.respondPermission(sessionId, ordinaryId, 'allow')
    assert.equal(allowed.status, 'resolved', JSON.stringify(allowed))
    assert.equal((await ordinary).behavior, 'allow', 'an ordinary owned prompt must be approvable end to end')

    // deny is never floor-gated: the planner may still refuse a floored prompt.
    const denied = await client.respondPermission(sessionId, hookId, 'deny')
    assert.equal(denied.status, 'resolved', JSON.stringify(denied))
    assert.equal((await hook).behavior, 'deny')
    assert.equal(outcomes.filter((o) => o.behavior === 'allow').length, 1, 'exactly one allow (the ordinary write) may ever reach the provider')

    pm.respondToPermission(envId, 'deny') // the "human" clears the last prompt
    await env
  })

  it('in-process pipeline: mcp_spawn arrives floored:false and is still refused not_delegable', async () => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-ac-floor-')))
    const sessionId = 'owned-mcp'
    const { manager, pm } = inProcessFixture(sessionId, cwd)
    pms.push(pm)
    server = new EncryptedWsServer({ port: 0, apiToken: TOKEN, sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)
    const client = await connect(port, new Set([sessionId]))
    await client.getEvents(sessionId)

    const trust = pm.requestMcpTrust({ name: 'fixture-mcp', command: '/usr/bin/true', args: [] })
    const [requestId] = [...pm._lastPermissionData.keys()]
    await waitFor(() => client._observedPermissions.has(requestId), 'mcp_spawn request observed')
    const observed = client._observedPermissions.get(requestId)
    assert.equal(observed.tool, 'mcp_spawn')
    assert.equal(observed.floored, false, 'mcp_spawn carries no path field, so the path floor says false — which is exactly why it needs its own gate')

    const refused = await client.respondPermission(sessionId, requestId, 'allow')
    assert.equal(refused.reason, 'not_delegable', JSON.stringify(refused))
    assert.ok(pm._pendingPermissions.has(requestId), 'the trust prompt must stay pending for a human')
    pm.respondToPermission(requestId, 'deny')
    assert.equal(await trust, false)
  })

  it('reconnect: a floored prompt pending across a reconnect is replayed floored:true inside the new handshake, and allow is still refused', async () => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-ac-floor-')))
    const sessionId = 'owned-resend'
    const { manager, pm } = inProcessFixture(sessionId, cwd)
    pms.push(pm)
    server = new EncryptedWsServer({ port: 0, apiToken: TOKEN, sessionManager: manager, authRequired: true })
    const port = await startServerAndGetPort(server)

    const pendingDecision = pm.handlePermission('Write', { file_path: join(cwd, '.git', 'hooks', 'pre-commit'), content: '#!/bin/sh\n' }, undefined, 'approve')
    const [requestId] = [...pm._lastPermissionData.keys()]

    // A fresh connection (what ClientManager does after a drop): it has never
    // seen this request live, so the only copy it can observe is the resend.
    const client = await connect(port, new Set([sessionId]))
    assert.ok(client._observedPermissions.has(requestId), 'the resend must be observed by the handshake flush')
    assert.equal(client._observedPermissions.get(requestId).floored, true, 'the resend must replay the creation verdict, never re-derive or drop it')
    const refused = await client.respondPermission(sessionId, requestId, 'allow')
    assert.equal(refused.reason, 'floored', JSON.stringify(refused))

    pm.respondToPermission(requestId, 'deny')
    assert.equal((await pendingDecision).behavior, 'deny')
  })

  it('hook-routed pipeline: POST /permission for a .git/hooks write arrives floored:true and allow is refused; an ordinary Write arrives floored:false and allow is applied', async () => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-ac-floor-')))
    const sessionId = 'owned-hook'
    const { manager, sessionsMap } = createMockSessionManager([{ id: sessionId, name: 'Owned (hook)', cwd, provider: 'claude-tui' }])
    const hookSession = sessionsMap.get(sessionId).session
    hookSession._hookSecret = HOOK_SECRET
    // A hook-routed provider (CliSession / ClaudeTuiSession) has no in-process
    // PermissionManager and no respondToPermission — the resolver answers it
    // from the HTTP-held pendingPermissions store. The mock's spy would
    // otherwise divert every answer into the in-process branch.
    delete hookSession.respondToPermission
    server = new EncryptedWsServer({ port: 0, apiToken: TOKEN, sessionManager: manager, authRequired: true })
    // The live registration path: SessionManager emits session_created, and
    // WsServer records the session's hook secret against its id.
    manager.emit('session_created', { sessionId })
    const port = await startServerAndGetPort(server)
    const client = await connect(port, new Set([sessionId]), 400)
    await client.getEvents(sessionId)

    const floorHttp = postHookPermission(port, 'Write', { file_path: join(cwd, '.git', 'hooks', 'pre-commit'), content: '#!/bin/sh\n' })
    const ordinaryHttp = postHookPermission(port, 'Write', { file_path: join(cwd, 'src', 'a.js'), content: 'x' })
    const byTarget = (fragment) => [...server._pendingPermissions.entries()]
      .find(([, p]) => JSON.stringify(p.data?.input ?? {}).includes(fragment))?.[0]
    await waitFor(() => byTarget('pre-commit') && byTarget('a.js'), 'both hook requests pending on the daemon')
    const floorId = byTarget('pre-commit')
    const ordinaryId = byTarget('a.js')
    await waitFor(() => client._observedPermissions.has(floorId) && client._observedPermissions.has(ordinaryId), 'both hook requests observed')

    assert.equal(client._observedPermissions.get(floorId).sessionId, sessionId, 'the hook broadcast must carry the OWNING session')
    assert.equal(client._observedPermissions.get(floorId).floored, true)
    assert.equal(client._observedPermissions.get(ordinaryId).floored, false)

    const refused = await client.respondPermission(sessionId, floorId, 'allow')
    assert.equal(refused.reason, 'floored', JSON.stringify(refused))
    assert.ok(server._pendingPermissions.has(floorId), 'the hook prompt must stay pending for a human')

    // The decision REACHES the hook (the held HTTP response carries it) — that
    // is the end-to-end effect. The status agent-control reports is a
    // characterization of today's daemon: a WS permission_response that
    // resolves a SESSION-MAPPED hook-routed prompt broadcasts no
    // permission_resolved (settings-handlers.js only broadcasts for the
    // unmapped legacy case), so the planner can only report `uncertain`. That
    // is fail-safe (never "not applied", never a retry), and it is filed as a
    // daemon follow-up; when that lands these two assertions flip to
    // 'resolved' and must be updated.
    const allowed = await client.respondPermission(sessionId, ordinaryId, 'allow')
    assert.deepEqual((await ordinaryHttp).body, { decision: 'allow' }, 'an ordinary owned hook prompt must be approvable end to end')
    assert.equal(allowed.status, 'uncertain', JSON.stringify(allowed))
    assert.equal(allowed.ackTimedOut, true)

    const denied = await client.respondPermission(sessionId, floorId, 'deny')
    assert.deepEqual((await floorHttp).body, { decision: 'deny' }, 'deny is never floor-gated')
    assert.equal(denied.status, 'uncertain', JSON.stringify(denied))
  })
})
