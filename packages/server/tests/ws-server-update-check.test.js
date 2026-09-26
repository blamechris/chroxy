/**
 * Regression test for #7265: WsServer's background npm version check used to
 * be gated on `process.env.NODE_ENV !== 'test'`, but nothing in this repo's
 * harness or CI ever sets NODE_ENV=test — so the "skipped in test/CI" comment
 * was false and every WsServer construction in the suite fired a real
 * outbound HTTPS request to registry.npmjs.org (fetch is mocked here via
 * mock.method(globalThis, 'fetch', ...), same pattern as tunnel-check.test.js,
 * so mock.restoreAll() correctly reinstates the original implementation).
 *
 * tests/_setup.mjs now sets CHROXY_DISABLE_UPDATE_CHECK=1 for the whole
 * server suite, and ws-server.js gates the check on that switch instead.
 *
 * Each case imports ws-server.js as a FRESH ESM module instance (a
 * cache-busting `?case=` query on the specifier) so the two cases don't share
 * the module-level `_latestVersionCache` — without this, whichever case runs
 * first would populate the 1-hour cache and mask the second case's signal,
 * independent of whether the fix under test is present.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createMockSessionManager } from './test-helpers.js'

const WS_SERVER_URL = pathToFileURL(resolve(import.meta.dirname, '../src/ws-server.js')).href

// tests/_setup.mjs sets this for the whole suite; capture it so each test can
// restore the harness default afterwards.
const HARNESS_DEFAULT_SWITCH = process.env.CHROXY_DISABLE_UPDATE_CHECK

let server

afterEach(() => {
  if (server) {
    try { server.close() } catch { /* already closing */ }
    server = null
  }
  if (HARNESS_DEFAULT_SWITCH === undefined) {
    delete process.env.CHROXY_DISABLE_UPDATE_CHECK
  } else {
    process.env.CHROXY_DISABLE_UPDATE_CHECK = HARNESS_DEFAULT_SWITCH
  }
})

function makeSessionManager() {
  return createMockSessionManager().manager
}

// Give the fire-and-forget `.then()`/`.catch()` chain in the constructor a
// chance to resolve/reject before we assert on the fetch mock.
async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe('WsServer background version check (#7265)', () => {
  it('does not call fetch under the test harness default (CHROXY_DISABLE_UPDATE_CHECK=1)', async (t) => {
    assert.equal(
      process.env.CHROXY_DISABLE_UPDATE_CHECK,
      '1',
      'precondition: tests/_setup.mjs should have set the switch — if this fails, the harness default changed'
    )
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('fetch should not have been called under the test harness')
    })

    const { WsServer } = await import(WS_SERVER_URL + '?case=gated')
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: makeSessionManager(),
      authRequired: false,
    })

    await flushMicrotasks()

    assert.equal(fetchMock.mock.callCount(), 0, 'WsServer construction must not call fetch when the switch is set')
  })

  it('control: with the switch unset, construction DOES call fetch (proves the gate still exists)', async (t) => {
    delete process.env.CHROXY_DISABLE_UPDATE_CHECK

    let resolveFetch
    const fetchCalled = new Promise((res) => { resolveFetch = res })
    const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
      resolveFetch(url)
      // Reject so checkLatestVersion's catch{} swallows it cleanly — we only
      // care that the request was attempted, not that it succeeds.
      throw new Error('simulated network failure (test control)')
    })

    const { WsServer } = await import(WS_SERVER_URL + '?case=ungated')
    server = new WsServer({
      port: 0,
      apiToken: 'test-token',
      sessionManager: makeSessionManager(),
      authRequired: false,
    })

    const calledUrl = await Promise.race([
      fetchCalled,
      new Promise((_, reject) => setTimeout(() => reject(new Error('fetch was never called')), 2000)),
    ])

    assert.equal(fetchMock.mock.callCount(), 1, 'construction should call fetch exactly once when the switch is unset')
    assert.match(String(calledUrl), /registry\.npmjs\.org/, 'the request should target the npm registry')
  })
})
