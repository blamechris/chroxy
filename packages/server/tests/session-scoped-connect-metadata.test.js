import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { createMockSessionManager, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'
import { fileHandlers } from '../src/handlers/file-handlers.js'
import { skillsHandlers } from '../src/handlers/skills-handlers.js'
import { canSeePeer } from '../src/environments/authority.js'

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  return { ws, messages }
}

describe('what a session-scoped connection is told on connect', () => {
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
    const { manager } = createMockSessionManager([
      { id: 'session-1', name: 'One', cwd: '/tmp/project-1' },
      { id: 'session-2', name: 'Two', cwd: '/tmp/project-2' },
    ], {
      defaultCwd: '/home/owner/everything',
      getMonthlyBudgetStatus: () => ({ month: '2026-11', spentUsd: 12.5, budgetUsd: 100, percent: 12.5, warning: false, exceeded: false, turnsBilled: 3 }),
    })
    server = new WsServer({ port: 0, apiToken: 'primary-tok', sessionManager: manager, authRequired: true, pairingManager: pm })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    return server.httpServer.address().port
  }

  async function authed(port, token, deviceName) {
    const c = await connect(port)
    sockets.push(c.ws)
    c.ws.send(JSON.stringify({ type: 'auth', token, deviceInfo: { deviceName, deviceType: 'phone', platform: 'ios', deviceId: deviceName } }))
    c.authOk = await waitFor(() => c.messages.find((m) => m.type === 'auth_ok'), { label: 'auth_ok' })
    return c
  }

  const scopedToken = (sid) => pm.validatePairing(pm.generateBoundPairing(sid).pairingId).sessionToken
  const settle = () => new Promise((r) => setTimeout(r, 120))

  it('omits the host default directory, and keeps it for an unscoped connection', async () => {
    const port = await start()
    const guest = await authed(port, scopedToken('session-1'), 'guest')
    const owner = await authed(port, 'primary-tok', 'owner')
    assert.equal(guest.authOk.defaultCwd, null)
    assert.equal(owner.authOk.defaultCwd, '/home/owner/everything')
  })

  it('lists only the peers on its own session', async () => {
    const port = await start()
    await authed(port, 'primary-tok', 'owner')
    await authed(port, scopedToken('session-2'), 'other-guest')
    await authed(port, scopedToken('session-1'), 'peer-guest')
    const guest = await authed(port, scopedToken('session-1'), 'guest')
    const names = guest.authOk.connectedClients.map((c) => c.deviceName).sort()
    assert.deepEqual(names, ['guest', 'peer-guest'])
    // The unscoped connection still hears about everyone.
    const ownerView = (await authed(port, 'primary-tok', 'owner-2')).authOk.connectedClients.map((c) => c.deviceName)
    assert.ok(ownerView.includes('other-guest') && ownerView.includes('guest') && ownerView.includes('owner'))
  })

  it('hears of arrivals on its own session only', async () => {
    const port = await start()
    const guest = await authed(port, scopedToken('session-1'), 'guest')
    await authed(port, 'primary-tok', 'owner-late')
    await authed(port, scopedToken('session-2'), 'other-late')
    await authed(port, scopedToken('session-1'), 'peer-late')
    await settle()
    const joined = guest.messages.filter((m) => m.type === 'client_joined').map((m) => m.client.deviceName)
    assert.deepEqual(joined, ['peer-late'])
  })

  it('is not sent the host-wide monthly spend meter, on connect or as it changes', async () => {
    const port = await start()
    const guest = await authed(port, scopedToken('session-1'), 'guest')
    const owner = await authed(port, 'primary-tok', 'owner')
    await settle()
    assert.equal(guest.messages.some((m) => m.type === 'monthly_budget'), false)
    assert.equal(owner.messages.some((m) => m.type === 'monthly_budget'), true, 'control: an unscoped connection gets it')
    guest.messages.length = 0
    owner.messages.length = 0
    server.sessionManager.emit('session_event', {
      sessionId: 'session-1',
      event: 'monthly_budget',
      data: { month: '2026-11', spentUsd: 13, budgetUsd: 100, percent: 13, warning: false, exceeded: false, turnsBilled: 4 },
    })
    await waitFor(() => owner.messages.find((m) => m.type === 'monthly_budget'), { label: 'owner meter update' })
    assert.equal(guest.messages.some((m) => m.type === 'monthly_budget'), false)
  })

  it('is sent no provider list or user-level catalogs in the connect bootstrap', async () => {
    const port = await start()
    const guest = await authed(port, scopedToken('session-1'), 'guest')
    const owner = await authed(port, 'primary-tok', 'owner')
    const gBoot = await waitFor(() => guest.messages.find((m) => m.type === 'auth_bootstrap'), { label: 'guest bootstrap' })
    const oBoot = await waitFor(() => owner.messages.find((m) => m.type === 'auth_bootstrap'), { label: 'owner bootstrap' })
    assert.deepEqual(gBoot.providers, [])
    assert.ok(oBoot.providers.length > 0, 'control: an unscoped connection gets the provider list')
  })
})

describe('peer visibility rule', () => {
  it('shows an unscoped recipient everyone, a scoped one only its own session\'s peers', () => {
    assert.equal(canSeePeer({}, { boundSessionId: 'a' }), true)
    assert.equal(canSeePeer({ boundSessionId: 'a' }, { boundSessionId: 'a' }), true)
    assert.equal(canSeePeer({ boundSessionId: 'a' }, { boundSessionId: 'b' }), false)
    assert.equal(canSeePeer({ boundSessionId: 'a' }, {}), false)
    assert.equal(canSeePeer({ boundSessionId: '' }, {}), false)
    assert.equal(canSeePeer({ boundSessionId: '' }, { boundSessionId: '' }), false, 'an empty binding names no session')
  })
})

describe('catalog requests from a session-scoped connection with no resolvable session', () => {
  function ctxNoSession() {
    const sent = []
    return {
      sent,
      sessions: { sessionManager: { getSession: () => null } },
      transport: { send: (_ws, m) => sent.push(m) },
      services: { fileOps: { listSlashCommands: () => sent.push({ type: 'host-slash-catalog' }), listAgents: () => sent.push({ type: 'host-agent-catalog' }) } },
      runtime: {},
    }
  }
  const guest = { id: 'g', boundSessionId: 'gone' }

  it('slash commands: empty', () => {
    const ctx = ctxNoSession()
    fileHandlers.list_slash_commands({}, guest, {}, ctx)
    assert.deepEqual(ctx.sent, [{ type: 'slash_commands', commands: [] }])
  })

  it('agents: empty', () => {
    const ctx = ctxNoSession()
    fileHandlers.list_agents({}, guest, {}, ctx)
    assert.deepEqual(ctx.sent, [{ type: 'agent_list', agents: [] }])
  })

  it('skills: empty', () => {
    const ctx = ctxNoSession()
    skillsHandlers.list_skills({}, guest, {}, ctx)
    assert.deepEqual(ctx.sent, [{ type: 'skills_list', skills: [] }])
  })

  it('an unscoped connection is still served the host catalog', () => {
    const ctx = ctxNoSession()
    fileHandlers.list_slash_commands({}, { id: 'o' }, {}, ctx)
    assert.deepEqual(ctx.sent, [{ type: 'host-slash-catalog' }])
  })
})
