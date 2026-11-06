/**
 * #9033 — the served dashboard page says whether the daemon requires auth, via the
 * existing <meta name="chroxy-config"> payload, so a `--no-auth` dashboard can connect
 * without a `?token=`. The flag is the only new field and carries no credential.
 */
import { describe, it, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpHandler } from '../src/http-routes.js'

const INDEX = '<!doctype html><html><head><title>c</title></head><body></body></html>'

describe('dashboard chroxy-config authRequired (#9033)', () => {
  let dist
  let httpServer
  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'chroxy-dash-auth-'))
    writeFileSync(join(dist, 'index.html'), INDEX)
  })
  afterEach(() => {
    httpServer?.close()
    httpServer = null
    rmSync(dist, { recursive: true, force: true })
  })

  async function configFor(authRequired) {
    const mock = {
      apiToken: 't', authRequired, serverMode: 'multi', port: 0,
      _encryptionEnabled: false,
      _authenticateDashboardRequest: () => true,
    }
    httpServer = createServer(createHttpHandler(mock, { dashboardDist: dist }))
    httpServer.listen(0, '127.0.0.1')
    await once(httpServer, 'listening')
    const res = await globalThis.fetch(`http://127.0.0.1:${httpServer.address().port}/dashboard`)
    const html = await res.text()
    const m = html.match(/<meta name="chroxy-config" content='([^']*)'>/)
    assert.ok(m, 'config meta present')
    return JSON.parse(m[1])
  }

  it('reports authRequired: false when the daemon runs with --no-auth', async () => {
    assert.equal((await configFor(false)).authRequired, false)
  })

  it('reports authRequired: true when auth is on', async () => {
    assert.equal((await configFor(true)).authRequired, true)
  })

  it('treats an undefined flag as auth required (fail closed)', async () => {
    assert.equal((await configFor(undefined)).authRequired, true)
  })
})
