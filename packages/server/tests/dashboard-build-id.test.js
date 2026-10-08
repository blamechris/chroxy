/**
 * #8268 — the dashboard build id: a hash of the built index.html that the daemon
 * (a) injects into the HTML it serves and (b) sends in auth_ok, so a long-lived page
 * can tell it is running a bundle from before an update.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpHandler } from '../src/http-routes.js'
import { dashboardBuildIdOf, getDashboardBuildId } from '../src/dashboard-build.js'
import { WsServer } from '../src/ws-server.js'

const INDEX_A = '<!doctype html><html><head><title>c</title><script type="module" src="/dashboard/assets/index-AAAA1111.js"></script></head><body></body></html>'
const INDEX_B = INDEX_A.replace('AAAA1111', 'BBBB2222')

describe('dashboard build id (#8268)', () => {
  let dist
  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'chroxy-dash-build-'))
    mkdirSync(join(dist, 'assets'))
  })
  afterEach(() => { rmSync(dist, { recursive: true, force: true }) })

  it('is stable for identical content and differs when an asset reference changes', () => {
    assert.equal(dashboardBuildIdOf(INDEX_A), dashboardBuildIdOf(INDEX_A))
    assert.notEqual(dashboardBuildIdOf(INDEX_A), dashboardBuildIdOf(INDEX_B))
    assert.match(dashboardBuildIdOf(INDEX_A), /^[0-9a-f]{16}$/)
  })

  it('reads the id of the index.html on disk and follows a rebuild without a restart', () => {
    writeFileSync(join(dist, 'index.html'), INDEX_A)
    const first = getDashboardBuildId(dist)
    assert.equal(first, dashboardBuildIdOf(INDEX_A))
    // Same size on purpose: only the mtime tells the cache the file changed.
    writeFileSync(join(dist, 'index.html'), INDEX_B)
    const future = new Date(Date.now() + 5000)
    utimesSync(join(dist, 'index.html'), future, future)
    assert.equal(getDashboardBuildId(dist), dashboardBuildIdOf(INDEX_B))
  })

  it('is null (cannot say) when no dashboard is built', () => {
    assert.equal(getDashboardBuildId(join(dist, 'nope')), null)
  })

  describe('served HTML', () => {
    let httpServer
    afterEach(() => { httpServer?.close(); httpServer = null })

    async function serve() {
      const mock = {
        apiToken: 't', authRequired: false, serverMode: 'multi', port: 0,
        _encryptionEnabled: false,
        _authenticateDashboardRequest: () => true,
      }
      httpServer = createServer(createHttpHandler(mock, { dashboardDist: dist }))
      httpServer.listen(0, '127.0.0.1')
      await once(httpServer, 'listening')
      return httpServer.address().port
    }

    it('injects the build id of the pristine file as <meta name="chroxy-build">', async () => {
      writeFileSync(join(dist, 'index.html'), INDEX_A)
      const port = await serve()
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/dashboard`)
      const html = await res.text()
      const m = html.match(/<meta name="chroxy-build" content="([0-9a-f]+)">/)
      assert.ok(m, 'build meta present')
      // The id is of the file on disk, not of the per-request config-injected copy,
      // so it equals what auth_ok will send for the same file.
      assert.equal(m[1], getDashboardBuildId(dist))
      assert.equal(m[1], dashboardBuildIdOf(INDEX_A))
    })
  })
})

describe('WsServer hands the build id to the post-auth sender (#8268)', () => {
  // ws-history reads `ctx.dashboardBuildId` per auth_ok. The sender is unit-tested with a
  // hand-built ctx, so this pins the other half: the real server's post-auth ctx carries the field,
  // as a live getter (a rebuilt dist is seen without a restart) that returns what the
  // module on disk returns. In a checkout with no built dist both are null; where one is
  // built they are the same hash.
  it('exposes dashboardBuildId on the post-auth ctx as a getter that tracks getDashboardBuildId()', () => {
    const server = new WsServer({ port: 0, apiToken: 't', authRequired: false, noEncrypt: true })
    const desc = Object.getOwnPropertyDescriptor(server._historyCtx, 'dashboardBuildId')
    assert.ok(desc, 'ctx declares dashboardBuildId')
    assert.equal(typeof desc.get, 'function', 'it is a live getter, not a value frozen at startup')
    assert.equal(server._historyCtx.dashboardBuildId, getDashboardBuildId())
  })
})
