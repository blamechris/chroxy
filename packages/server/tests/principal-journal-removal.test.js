/**
 * The journal follows the session's REMOVAL, whichever way it happens (#9118 review):
 * the user destroy, the idle timeout and the provider giving up all reach
 * `SessionManager._cleanupSessionMaps`, and the journal, its sidecar files and its
 * subscriptions go with it. A daemon shutdown (`destroyAll`) keeps every session for
 * the next start, so it keeps every journal too.
 *
 * A REAL SessionManager (fake provider, temp state file) under a REAL WsServer, with a real
 * principal subscribed over a socket.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { SessionManager } from '../src/session-manager.js'
import { registerProvider } from '../src/providers.js'
import { WsServer as _WsServer } from '../src/ws-server.js'
import { setLogListener } from '../src/logger.js'
import { PrincipalJournal } from '../src/principal-journal.js'
import { waitFor } from './test-helpers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'
import { tempPrincipalDir, testPrincipalStore, insertPrincipal } from './helpers/principal-store-fixture.js'

class RemovalProvider extends EventEmitter {
  constructor(opts) { super(); this.cwd = opts.cwd; this.model = null; this.permissionMode = 'approve'; this.isRunning = false; this.resumeSessionId = null }
  static get capabilities() { return {} }
  start() {}
  destroy() {}
  interrupt() {}
  sendMessage() {}
  setModel() {}
  setPermissionMode() {}
}
declareUnknownCustomization(RemovalProvider)
registerProvider('test-journal-removal', RemovalProvider)

class WsServer extends _WsServer {
  constructor(opts = {}) { super({ noEncrypt: true, ...opts }) }
  start(...args) { super.start(...args); setLogListener(null) }
}

describe('journal teardown follows canonical session removal', () => {
  let dir, sm, server, journal, ws
  const cleanups = []
  afterEach(() => {
    try { ws?.terminate() } catch { /* closed */ }
    try { server?.close() } catch { /* closed */ }
    try { sm?.destroyAll() } catch { /* closed */ }
    while (cleanups.length) cleanups.pop()()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = sm = server = journal = ws = null
  })

  async function boot() {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-journal-rm-'))
    sm = new SessionManager({ skipPreflight: true, maxSessions: 10, stateFilePath: join(dir, 'state.json'), providerType: 'test-journal-removal' })
    const id = sm.createSession({ cwd: '/tmp', provider: 'test-journal-removal' })
    const fixture = tempPrincipalDir()
    cleanups.push(fixture.cleanup)
    const store = testPrincipalStore(fixture.path)
    const { token } = insertPrincipal(store, { principalId: 'pr-1', label: 'sup', scope: 'observe', constraints: { sessionIds: [id] } })
    journal = new PrincipalJournal({ dir: join(dir, 'journal'), timers: { setTimeout: () => null, clearTimeout: () => {} } })
    server = new WsServer({ port: 0, apiToken: 'primary', sessionManager: sm, authRequired: true, principalStore: store, principalJournal: journal })
    server.start('127.0.0.1')
    await new Promise((resolve) => server.httpServer.once('listening', resolve))
    ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`)
    const messages = []
    ws.on('message', (d) => { try { messages.push(JSON.parse(d.toString())) } catch { /* ignore */ } })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(JSON.stringify({ type: 'auth', token }))
    await waitFor(() => messages.find((m) => m.type === 'auth_ok'))
    server._broadcastToSession(id, { type: 'message', messageType: 'response', content: 'hello' })
    ws.send(JSON.stringify({ type: 'principal_subscribe', requestId: 'r', sessionIds: [id] }))
    await waitFor(() => messages.find((m) => m.type === 'principal_live_fence'))
    journal.flush()
    // control: the journal, its files and the subscription exist before the removal
    assert.equal(journal._sessions.has(id), true)
    assert.equal(server._principalSubscriptions.size, 1)
    assert.equal(readdirSync(join(dir, 'journal')).length, 2)
    return { id, messages }
  }

  const gone = (id) => {
    assert.equal(journal._sessions.has(id), false, 'memory: the journal state is gone')
    assert.equal(journal._floors.has(id), false, 'memory: the floor tracker is gone')
    assert.equal(server._principalSubscriptions.size, 0, 'the subscription is gone')
    assert.deepEqual(readdirSync(join(dir, 'journal')), [], 'the sidecar files are deleted')
  }

  it('an idle timeout removes the journal, its subscription and its files', async () => {
    const { id } = await boot()
    sm._timeoutManager.emit('timeout', { sessionId: id, idleMs: 3_600_000 })
    assert.equal(sm._sessions.has(id), false)
    gone(id)
  })

  it('the subscriber is TOLD: an ended gap with reason removed reaches it', async () => {
    const { id, messages } = await boot()
    sm.destroySession(id)
    const gap = await waitFor(() => messages.find((m) => m.type === 'principal_gap'), { label: 'end notice' })
    assert.deepEqual({ reason: gap.reason, ended: gap.ended, sessionId: gap.sessionId }, { reason: 'removed', ended: true, sessionId: id })
  })

  it('a same-id restore retry (destroy, then create under the same id) journals under a NEW journalId; a late frame in between is rejected', async () => {
    const { id } = await boot()
    const first = journal.head(id).journalId
    sm.destroySession(id, { archive: false })
    server._broadcastToSession(id, { type: 'message', messageType: 'response', content: 'late stale frame' })
    assert.equal(journal._sessions.has(id), false, 'a frame for a session that is not live recreates nothing')
    const again = sm.createSession({ cwd: '/tmp', provider: 'test-journal-removal', preserveId: id })
    assert.equal(again, id, 'control: the same id came back')
    server._broadcastToSession(id, { type: 'message', messageType: 'response', content: 'new incarnation' })
    const head = journal.head(id)
    assert.notEqual(head.journalId, first)
    assert.equal(head.headSeq, 1)
    assert.equal(journal.incarnation(id) >= 1, true)
  })

  it('the provider giving up (respawn_exhausted) removes them too', async () => {
    const { id } = await boot()
    sm._sessions.get(id).session.emit('respawn_exhausted', { reason: 'gave up' })
    assert.equal(sm._sessions.has(id), false)
    gone(id)
  })

  it('a plain destroySession removes them, and a late session_destroyed broadcast does not bring them back', async () => {
    const { id } = await boot()
    sm.destroySession(id)
    server.broadcast({ type: 'session_destroyed', sessionId: id })
    journal.flush()
    gone(id)
  })

  it('a daemon shutdown (destroyAll, then server close) KEEPS the journal and its files', async () => {
    const { id } = await boot()
    sm.destroyAll()
    server.close()
    assert.equal(journal._sessions.has(id), true, 'the journal state is kept')
    const files = readdirSync(join(dir, 'journal'))
    assert.equal(files.length, 2, 'the sidecar files are kept')
    // and a restart over the same directory continues the same journal
    const again = new PrincipalJournal({ dir: join(dir, 'journal'), timers: { setTimeout: () => null, clearTimeout: () => {} } })
    assert.equal(again.head(id).journalId, journal.head(id).journalId)
    assert.ok(again.head(id).headSeq >= 1)
  })
})
