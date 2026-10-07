import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { DaemonUpdateStatus, PENDING_FILE, POSTPONE_FILE } from '../src/daemon-update-status.js'
import { createMockSession, waitFor } from './test-helpers.js'
import { setLogListener } from '../src/logger.js'

// #8331 — the wiring through a REAL WsServer: the module reaches the post-auth
// burst (`_historyCtx.daemonUpdate`), the handler context
// (`_handlerCtx.services.daemonUpdate`) and the change broadcast, for the right
// clients only. The unit tests exercise each piece with fakes; this is the seam.

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

async function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const messages = []
  ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* not JSON */ } })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  ws.send(JSON.stringify({ type: 'auth', token }))
  await waitFor(() => messages.find((m) => m.type === 'auth_ok'), { timeoutMs: 3000, label: 'auth_ok' })
  return { ws, messages }
}
const of = (messages, type) => messages.filter((m) => m.type === type)

describe('daemon update status through a real WsServer', () => {
  let server, pm, daemonUpdate, dir
  const sockets = []
  afterEach(() => {
    for (const ws of sockets.splice(0)) { try { ws.close() } catch { /* closed */ } }
    try { server?.close() } catch { /* closed */ }
    try { pm?.destroy() } catch { /* destroyed */ }
    if (dir) rmSync(dir, { recursive: true, force: true })
    server = pm = daemonUpdate = dir = null
  })

  async function start() {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-update-wiring-'))
    const pending = { target: B, from: A, subject: 'feat: x', commitsAhead: 1, queuedAt: new Date().toISOString(), reason: 'busy' }
    writeFileSync(join(dir, PENDING_FILE), JSON.stringify(pending))
    daemonUpdate = new DaemonUpdateStatus({ dir, running: A, getIdleState: () => ({ idle: true, reasons: [], sessions: [] }), debounceMs: 10, pollMs: 50 })
    pm = new PairingManager({ wsUrl: 'wss://example.com' })
    server = new WsServer({ port: 0, apiToken: 'primary-tok', cliSession: createMockSession(), authRequired: true, pairingManager: pm, daemonUpdate })
    server.start('127.0.0.1')
    await new Promise((resolve, reject) => { server.httpServer.once('listening', resolve); server.httpServer.once('error', reject) })
    daemonUpdate.start()
    const port = server.httpServer.address().port
    const primary = await connect(port, 'primary-tok')
    const { sessionToken } = pm.validatePairing(pm.currentPairingId)
    assert.equal(pm.isSessionTokenValid(sessionToken), true, 'sanity: a real pairing session token')
    const paired = await connect(port, sessionToken)
    sockets.push(primary.ws, paired.ws)
    return { primary, paired }
  }

  it('a primary client receives daemon_update_status on auth; a pairing client does not', async () => {
    const { primary, paired } = await start()
    const got = await waitFor(() => of(primary.messages, 'daemon_update_status')[0], { timeoutMs: 3000, label: 'daemon_update_status' })
    assert.equal(got.running, A)
    assert.equal(got.pending.target, B)
    assert.equal(got.applying, false)
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(of(paired.messages, 'daemon_update_status'), [], 'the pairing client was told nothing')
  })

  it('daemon_update_action from the primary reaches the module (the postpone is written and acknowledged); from a pairing client it is refused and writes nothing', async () => {
    const { primary, paired } = await start()
    paired.ws.send(JSON.stringify({ type: 'daemon_update_action', action: 'postpone', target: B, requestId: 'p1' }))
    const refused = await waitFor(() => of(paired.messages, 'daemon_update_action_result')[0], { timeoutMs: 3000, label: 'refusal' })
    assert.equal(refused.code, 'NOT_AUTHORIZED')
    assert.equal(existsSync(join(dir, POSTPONE_FILE)), false, 'nothing written for the pairing client')

    primary.ws.send(JSON.stringify({ type: 'daemon_update_action', action: 'postpone', target: B, requestId: 'r1' }))
    const ok = await waitFor(() => of(primary.messages, 'daemon_update_action_result')[0], { timeoutMs: 3000, label: 'ack' })
    assert.deepEqual([ok.ok, ok.requestId], [true, 'r1'])
    assert.equal(existsSync(join(dir, POSTPONE_FILE)), true, 'the module wrote the postpone')
  })

  it('a change on disk is broadcast to the primary client only', async () => {
    const { primary, paired } = await start()
    await waitFor(() => of(primary.messages, 'daemon_update_status')[0], { timeoutMs: 3000, label: 'initial' })
    const before = of(primary.messages, 'daemon_update_status').length
    writeFileSync(join(dir, PENDING_FILE), JSON.stringify({ target: B, from: A, subject: 'feat: x', commitsAhead: 1, queuedAt: new Date().toISOString(), reason: 'applying', applyingSince: new Date().toISOString() }))
    const next = await waitFor(() => of(primary.messages, 'daemon_update_status').slice(before).find((m) => m.applying === true), { timeoutMs: 4000, label: 'applying broadcast' })
    assert.equal(next.pending.reason, 'applying')
    assert.deepEqual(of(paired.messages, 'daemon_update_status'), [])
  })

  it('closing the server closes the module (no leaked watcher or timers)', async () => {
    await start()
    server.close()
    server = null
    assert.equal(daemonUpdate._closed, true)
  })
})
