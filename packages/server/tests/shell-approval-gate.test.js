import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ShellApprovalStore } from '../src/shell-approval-store.js'
import { sessionHandlers } from '../src/handlers/session-handlers.js'
import { WsServer } from '../src/ws-server.js'
import { nsCtx, makeSessionIndexCtx, createSpy, createMockSession, createMockSessionManager, waitFor } from './test-helpers.js'

function makeWs() {
  const messages = []
  return { readyState: 1, send: (raw) => messages.push(JSON.parse(raw)), _messages: messages }
}

function primaryClient() {
  return { id: 'client-x', authenticated: true, isPrimaryToken: true, deviceInfo: { deviceName: 'Mac' }, subscribedSessionIds: new Set(), boundSessionId: null, authToken: 'tok' }
}

function gateCtx({ requireApproval, store, createSession, enabled = true }) {
  const flat = {
    ...makeSessionIndexCtx(),
    // Mirror the real transport: forward to ws.send so ws._messages observes
    // what the handler sent (the handler sends via ctx.transport.send).
    send: createSpy((w, m) => { if (w && typeof w.send === 'function' && w.readyState === 1) w.send(JSON.stringify(m)) }),
    broadcastSessionList: createSpy(),
    sendSessionInfo: createSpy(),
    config: { userShell: { enabled, requireApproval } },
    sessionManager: {
      listSessions: () => [],
      getSession: () => ({ name: 'shell', cwd: '/tmp', session: { resumeSessionId: null } }),
      createSession,
      getSessionPreset: () => null,
      firstSessionId: null,
    },
  }
  if (store !== undefined) flat.shellApprovalStore = store
  return nsCtx(flat)
}

// ── The create-side gate (#6277) ─────────────────────────────────────────────
describe('user-shell approval gate (#6277)', () => {
  it('HOLDS a user-shell spawn when requireApproval is on (no create; shell_pending_approval)', () => {
    const store = new ShellApprovalStore()
    const createSession = createSpy(() => 'sess-1')
    const ws = makeWs()
    sessionHandlers.create_session(ws, primaryClient(), { provider: 'user-shell' }, gateCtx({ requireApproval: true, store, createSession }))
    assert.equal(createSession.callCount, 0, 'must NOT create while pending')
    assert.equal(store.size, 1, 'a pending approval is held')
    const pending = ws._messages.find((m) => m.type === 'shell_pending_approval')
    assert.ok(pending, 'requester is told it is pending')
    assert.ok(typeof pending.approvalId === 'string' && pending.approvalId.length > 0)
  })

  it('proceeds synchronously when requireApproval is off (backward-compat)', () => {
    const createSession = createSpy(() => 'sess-1')
    sessionHandlers.create_session(makeWs(), primaryClient(), { provider: 'user-shell' }, gateCtx({ requireApproval: false, store: new ShellApprovalStore(), createSession }))
    assert.equal(createSession.callCount, 1, 'creates immediately when approval is not required')
  })

  it('fail-closed: requireApproval on but no store → rejected, not created', () => {
    const createSession = createSpy(() => 'sess-1')
    const ws = makeWs()
    sessionHandlers.create_session(ws, primaryClient(), { provider: 'user-shell' }, gateCtx({ requireApproval: true, store: undefined, createSession }))
    assert.equal(createSession.callCount, 0)
    assert.ok(ws._messages.some((m) => m.type === 'session_error'), 'sends a session_error, never silently allows')
  })

  it('does NOT hold when user-shell is disabled (no doomed approval; create rejects upstream)', () => {
    const store = new ShellApprovalStore()
    const createSession = createSpy(() => 'sess-1')
    sessionHandlers.create_session(makeWs(), primaryClient(), { provider: 'user-shell' }, gateCtx({ enabled: false, requireApproval: true, store, createSession }))
    assert.equal(store.size, 0, 'a disabled shell is never held — it is rejected upstream by createSession')
  })

  it('does NOT gate a non-user-shell provider', () => {
    const store = new ShellApprovalStore()
    const createSession = createSpy(() => 'sess-1')
    sessionHandlers.create_session(makeWs(), primaryClient(), { provider: 'claude-sdk' }, gateCtx({ requireApproval: true, store, createSession }))
    assert.equal(createSession.callCount, 1)
    assert.equal(store.size, 0)
  })
})

// ── The host-local approval listener (#6277 — tunnel isolation) ───────────────
// The load-bearing security property: the approval API runs on a SEPARATE
// 127.0.0.1-only listener that the Cloudflare tunnel never forwards. A loopback
// check on the MAIN port would be defeated (cloudflared makes tunnel traffic
// arrive as 127.0.0.1), so a leaked-token attacker over the tunnel could approve
// their own held shell. These tests pin that the route is NOT on the main port.
describe('host-local approval listener (#6277)', () => {
  let server
  let mainPort
  let approvalPort
  let tmpDir
  let prevConfigDir
  const createCalls = []

  before(async () => {
    prevConfigDir = process.env.CHROXY_CONFIG_DIR
    tmpDir = mkdtempSync(join(tmpdir(), 'shell-approval-'))
    process.env.CHROXY_CONFIG_DIR = tmpDir
    const { manager } = createMockSessionManager()
    manager.createSession = (opts) => { createCalls.push(opts); return 'sess-approved' }
    manager.getSession = () => ({ name: 'shell', cwd: '/tmp', session: { resumeSessionId: null } })
    manager.getSessionPreset = () => null
    server = new WsServer({
      port: 0,
      apiToken: 'tok',
      authRequired: true,
      cliSession: createMockSession(),
      sessionManager: manager,
      config: { userShell: { enabled: true, requireApproval: true } },
    })
    server.start('127.0.0.1')
    await new Promise((resolve, reject) => {
      server.httpServer.once('listening', resolve)
      server.httpServer.once('error', reject)
    })
    mainPort = server.httpServer.address().port
    await waitFor(() => server._shellApprovalPort != null, { timeoutMs: 5000 })
    approvalPort = server._shellApprovalPort
  })

  after(() => {
    try { server.close() } catch { /* already down */ }
    if (prevConfigDir === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = prevConfigDir
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('binds a SEPARATE loopback port, not the main port', () => {
    assert.ok(approvalPort, 'approval listener bound')
    assert.notEqual(approvalPort, mainPort, 'approval port differs from the tunnel-exposed main port')
  })

  it('does NOT serve /api/shell/approve on the MAIN (tunnel-exposed) port', async () => {
    const { approvalId } = server._shellApprovalStore.createPendingApproval({ clientId: 'c1', createSessionOptions: { provider: 'user-shell' }, tokenClass: 'primary' })
    const res = await fetch(`http://127.0.0.1:${mainPort}/api/shell/approve?id=${approvalId}`, { method: 'POST', headers: { authorization: 'Bearer tok' } })
    assert.notEqual(res.status, 200, 'approval MUST NOT be reachable on the main port the tunnel forwards')
    assert.equal(server._shellApprovalStore.size, 1, 'the held approval is untouched by the main-port hit')
  })

  it('approves a held spawn over the loopback port with the primary token (deferred create runs once)', async () => {
    createCalls.length = 0
    const { approvalId } = server._shellApprovalStore.createPendingApproval({ clientId: 'c-gone', createSessionOptions: { provider: 'user-shell', cwd: '/tmp' }, tokenClass: 'primary' })
    const res = await fetch(`http://127.0.0.1:${approvalPort}/api/shell/approve?id=${approvalId}`, { method: 'POST', headers: { authorization: 'Bearer tok' } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.sessionId, 'sess-approved')
    assert.equal(createCalls.length, 1, 'the deferred create runs exactly once on approval')
  })

  it('rejects approval without the primary token (403)', async () => {
    const { approvalId } = server._shellApprovalStore.createPendingApproval({ clientId: 'c1', createSessionOptions: {}, tokenClass: 'primary' })
    const res = await fetch(`http://127.0.0.1:${approvalPort}/api/shell/approve?id=${approvalId}`, { method: 'POST' })
    assert.equal(res.status, 403)
  })

  it('404 on an unknown id, 400 on a missing id', async () => {
    const unknown = await fetch(`http://127.0.0.1:${approvalPort}/api/shell/approve?id=nope`, { method: 'POST', headers: { authorization: 'Bearer tok' } })
    assert.equal(unknown.status, 404)
    const missing = await fetch(`http://127.0.0.1:${approvalPort}/api/shell/approve`, { method: 'POST', headers: { authorization: 'Bearer tok' } })
    assert.equal(missing.status, 400)
  })

  it('lists pending approvals over the loopback port', async () => {
    const res = await fetch(`http://127.0.0.1:${approvalPort}/api/shell/pending`, { headers: { authorization: 'Bearer tok' } })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body.pending))
  })
})
