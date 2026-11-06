import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { WsServer } from '../src/ws-server.js'
import { SessionManager } from '../src/session-manager.js'
import { PairingManager } from '../src/pairing.js'
import { BaseSession } from '../src/base-session.js'
import { waitFor } from './test-helpers.js'
import { DeclaredStatusInputSchema, ServerSessionListEntrySchema } from '@chroxy/protocol'

// Real authentication, sockets, normalizer and recipient scoping. No target
// subscription or visit is needed for the operator's attention signal.
describe('inactive session decision delivery', () => {
  it('delivers only bounded decision metadata across visible sessions and replays lifetimes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inactive-decision-'))
    const manager = new SessionManager({ skipPreflight: true, stateFilePath: join(dir, 'state.json') })
    for (const id of ['a', 'b']) {
      const session = new BaseSession({ cwd: dir, skillsDir: dir, repoSkillsDir: null })
      session.destroy = () => { session._destroyPendingBackgroundShells(); session.removeAllListeners() }
      manager._sessions.set(id, { session, name: id, cwd: dir, provider: 'claude-sdk', createdAt: 1 })
      manager._wireSessionEvents(id, session)
    }
    const server = new WsServer({ port: 0, apiToken: 'test-primary', sessionManager: manager, defaultSessionId: 'a', pairingManager: new PairingManager(), authRequired: true, noEncrypt: true })
    const sockets = []
    try {
      server._webTaskManager.detectFeatures = async () => ({ remote: false, teleport: false })
      server.start('127.0.0.1')
      await once(server.httpServer, 'listening')
      const port = server.httpServer.address().port
      const pairing = server._pairingManager
      const boundA = pairing.validatePairing(pairing.generateBoundPairing('a').pairingId).sessionToken
      const boundB = pairing.validatePairing(pairing.generateBoundPairing('b').pairingId).sessionToken
      const unbound = pairing.validatePairing(pairing.currentPairingId).sessionToken
      async function connect(token) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`)
        sockets.push(ws)
        const messages = []
        ws.on('message', (data) => messages.push(JSON.parse(data.toString())))
        await once(ws, 'open')
        if (token) {
          ws.send(JSON.stringify({ type: 'auth', token, protocolVersion: 3 }))
          await waitFor(() => messages.find((m) => m.type === 'session_list'), { timeoutMs: 2000 })
        }
        return { ws, messages }
      }
      const [primary, peer, a, b, unauth] = await Promise.all([connect('test-primary'), connect(unbound), connect(boundA), connect(boundB), connect(null)])
      assert.deepEqual(a.messages.find((m) => m.type === 'session_list').sessions.map((s) => s.sessionId), ['a'])
      assert.deepEqual(b.messages.find((m) => m.type === 'session_list').sessions.map((s) => s.sessionId), ['b'])
      for (const c of [primary, peer]) {
        c.ws.send(JSON.stringify({ type: 'switch_session', sessionId: 'a' }))
        await waitFor(() => c.messages.find((m) => m.type === 'session_switched' && m.sessionId === 'a'), { timeoutMs: 2000 })
      }
      for (const c of [primary, peer, a, b, unauth]) c.messages.length = 0
      manager.setDeclaredStatus('b', { state: 'blocked', summary: 'Ready for review', decision: 'Choose a target' }, 'api')
      await waitFor(() => primary.messages.find((m) => m.type === 'session_status' && m.sessionId === 'b'), { timeoutMs: 2000 })
      for (const c of [primary, peer, a, b]) {
        c.ws.send(JSON.stringify({ type: 'ping' }))
        await waitFor(() => c.messages.find((m) => m.type === 'pong'), { timeoutMs: 2000 })
      }
      for (const c of [primary, peer, b]) {
        assert.equal(c.messages.filter((m) => m.type === 'session_status' && m.sessionId === 'b').length, 1)
        assert.equal(c.messages.filter((m) => m.type === 'activity_delta' && m.sessionId === 'b' && m.entry.id === 'decision:session').length, 1)
      }
      for (const c of [a, unauth]) assert.equal(c.messages.some((m) => m.sessionId === 'b'), false, 'other-session binding and unauthenticated clients receive no target metadata')
      const original = primary.messages.find((m) => m.type === 'activity_delta').entry.startedAt
      const invalid = { type: 'activity_delta', sessionId: 'b', schemaVersion: 1, op: 'started', entry: { id: 'decision:session', kind: 'decision', label: 'x'.repeat(281), status: 'blocked', startedAt: 1 } }
      manager.emit('session_event', { sessionId: 'b', event: 'activity_delta', data: invalid })
      manager.emit('session_event', { sessionId: 'b', event: 'session_status', data: { declaredStatus: { state: 'idle', summary: 'x'.repeat(281), source: 'api', updatedAt: 1 } } })
      manager.getSession('b').session.emit('message', { type: 'response', content: 'Scoped response' })
      manager.getSession('b').session._activity.onToolStart({ toolUseId: 'private-tool', tool: 'Scoped tool' })
      await waitFor(() => b.messages.find((m) => m.type === 'activity_delta' && m.entry.id === 'private-tool'), { timeoutMs: 2000 })
      for (const c of [primary, peer, a]) assert.equal(c.messages.some((m) => m.content === 'Scoped response' || m.entry?.id === 'private-tool' || m.entry?.label.length > 280 || m.declaredStatus?.summary.length > 280), false)
      const fresh = await connect('test-primary')
      const pending = fresh.messages.find((m) => m.type === 'session_list').sessions.find((s) => s.sessionId === 'b')
      assert.equal(pending.decisionActivity.startedAt, original)
      assert.equal(pending.declaredStatus.decision, 'Choose a target')
      assert.equal(ServerSessionListEntrySchema.safeParse(pending).success, true)
      assert.equal(DeclaredStatusInputSchema.safeParse({ state: 'idle', summary: 'x', decisionActivity: pending.decisionActivity }).success, false)
      manager.setDeclaredStatus('b', { state: 'idle', summary: 'Reviewed', decision: 'none' }, 'api')
      await waitFor(() => primary.messages.find((m) => m.type === 'activity_delta' && m.op === 'ended'), { timeoutMs: 2000 })
      await waitFor(() => b.messages.find((m) => m.type === 'activity_delta' && m.op === 'ended'), { timeoutMs: 2000 })
      for (const c of [a, unauth]) assert.equal(c.messages.some((m) => m.sessionId === 'b'), false, 'clear retains the same recipient scope')
      const end = primary.messages.find((m) => m.type === 'activity_delta' && m.op === 'ended').entry.endedAt
      const cleared = await connect('test-primary')
      const row = cleared.messages.find((m) => m.type === 'session_list').sessions.find((s) => s.sessionId === 'b')
      assert.deepEqual(row.decisionActivity, { endedAt: end }, 'cleared roster retains fence without inventing an entry')
      for (const c of [primary, peer]) assert.equal(c.messages.some((m) => m.type === 'session_switched' && m.sessionId === 'b'), false)
    } finally {
      for (const ws of sockets) ws.terminate()
      server.close()
      server._pairingManager.destroy()
      manager.destroyAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
