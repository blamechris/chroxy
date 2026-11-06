import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpHandler } from '../src/http-routes.js'
import { WsServer } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession } from '../src/base-session.js'

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'declared-http-'))
  const manager = new SessionManager({ skipPreflight: true, stateFilePath: join(dir, 'state.json') })
  for (const id of ['s1', 's2']) {
    const session = new BaseSession({ cwd: dir, skillsDir: dir, repoSkillsDir: null })
    session.destroy = () => { session._destroyPendingBackgroundShells(); session.removeAllListeners() }
    manager._sessions.set(id, { session, name: id, cwd: dir, provider: 'claude-sdk' })
  }
  const pairing = new PairingManager()
  const bound = pairing.validatePairing(pairing.generateBoundPairing('s1').pairingId).sessionToken
  const unbound = pairing.validatePairing(pairing.currentPairingId).sessionToken
  // Exercise real production bearer validation; the HTTP route, not a mock,
  // supplies the additional write-class/session-scoping restriction.
  const server = Object.assign(Object.create(WsServer.prototype), {
    sessionManager: manager, authRequired: true, apiToken: 'test-primary', _pairingManager: pairing,
    _ingestSecret: 'test-ingest', config: {},
  })
  const http = createServer(createHttpHandler(server))
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const base = `http://127.0.0.1:${http.address().port}`
  const request = (path, token, data = { state: 'running', summary: 'Testing status' }) => fetch(`${base}${path}`, {
    method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: typeof data === 'string' ? data : JSON.stringify(data),
  })
  return { manager, request, bound, unbound, async close() { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); pairing.destroy(); manager.destroyAll(); rmSync(dir, { recursive: true, force: true }) } }
}

describe('declared status bearer authority', () => {
  it('accepts primary and same-session bound tokens, rejects wrong class and cross-session writes', async () => {
    const f = await fixture()
    try {
      for (const token of ['test-primary', f.bound]) {
        const response = await f.request('/api/sessions/s1/status', token)
        assert.equal(response.status, 200, 'primary and same-session bearer must work')
        assert.equal((await response.json()).declaredStatus.source, 'api')
      }
      for (const token of [undefined, 'wrong-token', 'test-ingest', 'test-hook', f.unbound]) {
        assert.equal((await f.request('/api/sessions/s1/status', token)).status, 403, 'wrong token class must not write declared status')
      }
      const cross = await f.request('/api/sessions/s2/status', f.bound)
      assert.equal(cross.status, 403, 'bound token must not write a sibling session')
      assert.equal((await cross.json()).code, 'SESSION_TOKEN_MISMATCH')
      assert.equal(f.manager.getSession('s2').declaredStatus, undefined)
    } finally { await f.close() }
  })
  it('returns bounded validation failures without changing session state', async () => {
    const f = await fixture()
    try {
      for (const data of ['{', 'null', '{}', { state: 'bad', summary: 'x' }, { state: 'done', summary: 'x'.repeat(281) }, { state: 'idle', summary: 'x', source: 'hook' }]) {
        assert.equal((await f.request('/api/sessions/s1/status', 'test-primary', data)).status, 400)
      }
      assert.equal((await f.request('/api/sessions/missing/status', 'test-primary')).status, 404)
      assert.equal((await f.request('/api/sessions/%zz/status', 'test-primary')).status, 404)
      assert.equal((await f.request('/api/sessions/s1/status', 'test-primary', 'x'.repeat(5000))).status, 413)
      assert.equal(f.manager.getSession('s1').declaredStatus, undefined)
    } finally { await f.close() }
  })
  it('keeps ingest status writes behind ingest authority and validates exact target', async () => {
    const f = await fixture()
    try {
      const event = { source: 'test-hook', sessionId: 's1', type: 'status', data: { state: 'blocked', summary: 'Waiting for target', decision: 'Choose target' }, ts: Date.now() }
      assert.equal((await f.request('/api/events', 'test-primary', event)).status, 401)
      assert.equal((await f.request('/api/events', f.bound, event)).status, 401)
      assert.equal((await f.request('/api/events', 'test-ingest', event)).status, 200)
      assert.equal(f.manager.getSession('s1').declaredStatus.source, 'hook')
      assert.equal((await f.request('/api/events', 'test-ingest', { ...event, sessionId: 'missing' })).status, 404)
      const { sessionId: _id, ...noTarget } = event
      assert.equal((await f.request('/api/events', 'test-ingest', noTarget)).status, 400)
      assert.equal((await f.request('/api/events', 'test-ingest', { ...event, data: { state: 'nonsense', summary: 'x' } })).status, 400)
    } finally { await f.close() }
  })
})
