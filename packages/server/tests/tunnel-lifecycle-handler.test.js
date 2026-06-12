// #5368 slice (c): unit tests for TunnelLifecycleHandler — the tunnel lifecycle
// extracted from startCliServer. The design's headline payoff: assert that a
// `tunnel.start()` throw runs the full emergencyCleanup WITHOUT opening a real
// tunnel — impossible to test while the logic was inline in the god function.
// All function deps are injected, so no real network / cloudflared is touched.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { TunnelLifecycleHandler } from '../src/server-cli/tunnel-lifecycle-handler.js'

function makeFakeTunnel({ startImpl } = {}) {
  const tunnel = new EventEmitter()
  tunnel.start = startImpl || (async () => ({ wsUrl: 'wss://t.example', httpUrl: 'https://t.example' }))
  return tunnel
}

function makeStartupDisplay() {
  return {
    currentWsUrl: null,
    currentTunnelMode: 'none',
    displayQr: function (...a) { (this.calls ||= []).push(a) },
  }
}

function makeWsServer() {
  return {
    broadcasts: [],
    statuses: [],
    errors: [],
    // #5555 (sub-item 7): capture tunnel-url state + the rotation push.
    tunnelUrl: null,
    urlChangedPushes: [],
    broadcastMinProtocolVersion(v, payload) { this.broadcasts.push({ v, payload }) },
    broadcastStatus(s) { this.statuses.push(s) },
    broadcastError(...a) { this.errors.push(a) },
    setTunnelUrl(url) { this.tunnelUrl = url },
    broadcastTunnelUrlChanged(url, previousUrl) { this.urlChangedPushes.push({ url, previousUrl }) },
  }
}

function build(overrides = {}) {
  const events = { cleanup: [], wired: [], wait: [] }
  const tunnel = overrides.tunnel || makeFakeTunnel()
  const wsServer = overrides.wsServer || makeWsServer()
  const startupDisplay = overrides.startupDisplay || makeStartupDisplay()
  const pairingManager = overrides.pairingManager !== undefined ? overrides.pairingManager
    : { refreshed: 0, extended: 0, refresh() { this.refreshed++ }, extendCurrentId() { this.extended++ } }
  const sessionManager = {}
  const handler = new TunnelLifecycleHandler({
    createTunnel: () => tunnel,
    emergencyCleanup: async (bag) => { events.cleanup.push(bag) },
    wireTunnelEvents: (t, ws) => { events.wired.push({ t, ws }) },
    waitForTunnel: overrides.waitForTunnel || (async (url, opts) => { events.wait.push({ url, opts }) }),
    buildTunnelWarmingStatus: (x) => ({ kind: 'warming', ...x }),
    buildTunnelReadyStatus: (x) => ({ kind: 'ready', ...x }),
    config: { port: 8765, tunnelArg: { mode: 'quick' }, tunnelConfig: {}, tunnelName: null, tunnelHostname: null },
    wsServer,
    startupDisplay,
    pairingManager,
    cleanupRefs: { mdnsService: { m: 1 }, bonjourInstance: { b: 1 }, tokenManager: { t: 1 }, sessionManager },
    logger: { info() {}, warn() {}, error() {} },
  })
  return { handler, tunnel, wsServer, startupDisplay, pairingManager, sessionManager, events }
}

// The failure paths console.error — silence it to keep test output clean.
let origConsoleError
beforeEach(() => { origConsoleError = console.error; console.error = () => {} })
afterEach(() => { console.error = origConsoleError })

describe('TunnelLifecycleHandler — start failure (the headline payoff)', () => {
  it('a tunnel.start() throw runs emergencyCleanup with the full bag and returns ok:false', async () => {
    const tunnel = makeFakeTunnel({ startImpl: async () => { throw new Error('cloudflared died') } })
    const { handler, wsServer, startupDisplay, sessionManager, events } = build({ tunnel })

    const result = await handler.createAndStart()

    assert.equal(result.ok, false)
    assert.equal(result.tunnel, tunnel, 'returns the created tunnel even on failure')
    assert.equal(events.cleanup.length, 1, 'emergencyCleanup called exactly once')
    const bag = events.cleanup[0]
    assert.equal(bag.tunnel, tunnel)
    assert.equal(bag.wsServer, wsServer)
    assert.equal(bag.sessionManager, sessionManager)
    assert.ok(bag.mdnsService && bag.bonjourInstance && bag.tokenManager, 'full cleanup bag passed')
    assert.equal(events.wait.length, 0, 'waitForTunnel never reached (no real tunnel opened)')
    assert.equal(startupDisplay.calls, undefined, 'no QR displayed on failure')
    assert.ok(wsServer.errors.length >= 1, 'broadcastError fired')
  })
})

describe('TunnelLifecycleHandler — waitForTunnel failure', () => {
  it('runs emergencyCleanup and returns ok:false when routability check throws', async () => {
    const { handler, events, startupDisplay } = build({
      waitForTunnel: async () => { throw new Error('TUNNEL_NOT_ROUTABLE') },
    })
    const result = await handler.createAndStart()
    assert.equal(result.ok, false)
    assert.equal(events.cleanup.length, 1)
    // start succeeded so currentWsUrl was set, but no success QR (only the
    // recovered path could render, which didn't fire here).
    assert.equal(startupDisplay.currentWsUrl, 'wss://t.example')
    assert.equal(startupDisplay.calls, undefined)
  })
})

describe('TunnelLifecycleHandler — success path', () => {
  it('wires events, broadcasts warming+ready, displays QR, extends pairing, returns ok:true', async () => {
    const { handler, tunnel, wsServer, startupDisplay, pairingManager, events } = build()
    const result = await handler.createAndStart()

    assert.equal(result.ok, true)
    assert.equal(result.tunnel, tunnel)
    assert.equal(events.cleanup.length, 0, 'no cleanup on success')
    assert.equal(events.wired.length, 1, 'wireTunnelEvents called')
    assert.equal(startupDisplay.currentWsUrl, 'wss://t.example')
    assert.equal(startupDisplay.currentTunnelMode, 'cloudflare:quick')
    assert.deepEqual(startupDisplay.calls, [['wss://t.example', 'https://t.example', 'cloudflare:quick']])
    assert.equal(pairingManager.extended, 1, 'extendCurrentId called (#2599)')
    const kinds = wsServer.broadcasts.map((b) => b.payload.kind)
    assert.ok(kinds.includes('warming') && kinds.includes('ready'), 'warming + ready status broadcast')
    // #5555 (sub-item 7): the WsServer is seeded with the initial tunnel URL so
    // the auth_bootstrap burst can advertise it; no rotation push on first start.
    assert.equal(wsServer.tunnelUrl, 'wss://t.example', 'initial tunnel URL seeded on the WsServer')
    assert.equal(wsServer.urlChangedPushes.length, 0, 'no url-changed push on first start')
  })
})

describe('TunnelLifecycleHandler — tunnel_recovered', () => {
  it('re-verifies + re-renders the QR when the URL changes', async () => {
    const { handler, tunnel, startupDisplay, pairingManager } = build()
    await handler.createAndStart()
    startupDisplay.calls.length = 0 // ignore the initial success QR

    tunnel.emit('tunnel_recovered', { httpUrl: 'https://new.example', wsUrl: 'wss://new.example', attempt: 2 })
    await new Promise((r) => setImmediate(r))

    assert.deepEqual(startupDisplay.calls, [['wss://new.example', 'https://new.example', 'cloudflare:quick']])
    assert.equal(startupDisplay.currentWsUrl, 'wss://new.example')
    assert.equal(pairingManager.refreshed, 1, 'pairing refreshed on a new url')
  })

  it('#5555: pushes tunnel_url_changed with old+new URLs when the URL rotates', async () => {
    const { handler, tunnel, wsServer } = build()
    await handler.createAndStart()
    assert.equal(wsServer.urlChangedPushes.length, 0)

    tunnel.emit('tunnel_recovered', { httpUrl: 'https://new.example', wsUrl: 'wss://new.example', attempt: 2 })
    await new Promise((r) => setImmediate(r))

    assert.deepEqual(wsServer.urlChangedPushes, [
      { url: 'wss://new.example', previousUrl: 'wss://t.example' },
    ], 'rotation push carries the new + previous wss URLs')
  })

  it('does NOT re-render when the URL is unchanged (status broadcast only)', async () => {
    const { handler, tunnel, wsServer, startupDisplay } = build()
    await handler.createAndStart()
    startupDisplay.calls.length = 0
    wsServer.statuses.length = 0

    tunnel.emit('tunnel_recovered', { httpUrl: 'https://t.example', wsUrl: 'wss://t.example', attempt: 1 })
    await new Promise((r) => setImmediate(r))

    assert.equal(startupDisplay.calls.length, 0, 'no QR re-render for an unchanged url')
    assert.ok(wsServer.statuses.some((s) => s.includes('recovered')), 'recovery status broadcast')
    // #5555 (sub-item 7): no rotation push when the URL did not actually change.
    assert.equal(wsServer.urlChangedPushes.length, 0, 'no url-changed push for an unchanged url')
  })

  it('a recovery DURING the initial waitForTunnel re-renders (modeLabel available — #5402 TDZ fix)', async () => {
    let firstWait = true
    const { handler, tunnel, startupDisplay } = build({
      waitForTunnel: async () => {
        if (firstWait) {
          firstWait = false
          // Simulate a flap+recovery while the initial routability wait is in
          // flight. Before the fix, modeLabel was declared AFTER this wait, so
          // the recovered handler hit a TDZ ReferenceError and silently skipped
          // the QR re-render (swallowed by its try/catch).
          tunnel.emit('tunnel_recovered', { httpUrl: 'https://recovered.example', wsUrl: 'wss://recovered.example', attempt: 1 })
          await new Promise((r) => setImmediate(r))
        }
      },
    })
    await handler.createAndStart()
    assert.ok(
      startupDisplay.calls.some((c) => c[0] === 'wss://recovered.example' && c[2] === 'cloudflare:quick'),
      'recovery-during-startup re-rendered the QR with modeLabel (would TDZ-throw and skip before the fix)'
    )
  })

  it('contains a waitForTunnel throw in the recovered handler (no crash)', async () => {
    let calls = 0
    const { handler, tunnel } = build({
      waitForTunnel: async () => { calls++; if (calls > 1) throw new Error('settle failed'); },
    })
    await handler.createAndStart() // first waitForTunnel ok
    await assert.doesNotReject(async () => {
      tunnel.emit('tunnel_recovered', { httpUrl: 'https://x', wsUrl: 'wss://x', attempt: 1 })
      await new Promise((r) => setImmediate(r))
    })
  })
})
