import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpHandler } from '../src/http-routes.js'
import { WsServer } from '../src/ws-server.js'
import { PairingManager } from '../src/pairing.js'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession } from '../src/base-session.js'

// A declared-status write waits for its request body; a bearer that is revoked while
// the body is still arriving must not get the write applied.

async function fixture({ authRequired = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'declared-authority-'))
  const manager = new SessionManager({ skipPreflight: true, stateFilePath: join(dir, 'state.json') })
  const session = new BaseSession({ cwd: dir, skillsDir: dir, repoSkillsDir: null })
  session.destroy = () => { session._destroyPendingBackgroundShells(); session.removeAllListeners() }
  manager._sessions.set('s1', { session, name: 's1', cwd: dir, provider: 'claude-sdk' })
  const pairing = new PairingManager()
  const bound = pairing.validatePairing(pairing.generateBoundPairing('s1').pairingId).sessionToken
  const server = Object.assign(Object.create(WsServer.prototype), {
    sessionManager: manager, authRequired, apiToken: authRequired ? 'test-primary' : null, _pairingManager: pairing,
    _ingestSecret: 'test-ingest', config: {},
  })
  const http = createServer(createHttpHandler(server))
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const port = http.address().port

  /** POST the body in two parts; `between` runs after the first part and before the rest. */
  function slowPost(token, between) {
    const body = JSON.stringify({ state: 'running', summary: 'Testing status' })
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port, path: '/api/sessions/s1/status', method: 'POST',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', reject)
      req.write(body.slice(0, 10))
      setTimeout(async () => { await between(); req.end(body.slice(10)) }, 50)
    })
  }
  return {
    manager, pairing, bound, slowPost,
    async close() { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); pairing.destroy(); manager.destroyAll(); rmSync(dir, { recursive: true, force: true }) },
  }
}

describe('declared status write authority', () => {
  it('with auth off there is no bearer to re-check: the write is applied', async () => {
    const f = await fixture({ authRequired: false })
    try {
      assert.equal(await f.slowPost('', async () => {}), 200)
      assert.equal(f.manager.getSession('s1').declaredStatus?.summary, 'Testing status')
    } finally { await f.close() }
  })

  it('control: a live bound bearer writes the status', async () => {
    const f = await fixture()
    try {
      assert.equal(await f.slowPost(f.bound, async () => {}), 200)
      assert.equal(f.manager.getSession('s1').declaredStatus?.summary, 'Testing status')
    } finally { await f.close() }
  })

  it('a bound bearer revoked while the body is arriving writes nothing', async () => {
    const f = await fixture()
    try {
      const status = await f.slowPost(f.bound, async () => { f.pairing.revokeAllSessionTokens() })
      assert.equal(status, 403)
      assert.equal(f.manager.getSession('s1').declaredStatus, undefined)
    } finally { await f.close() }
  })
})
