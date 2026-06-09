// #5368 slice (b): unit tests for StartupDisplay — the connection-display logic
// extracted from startCliServer. Exercises buildPairingUrl, displayQr (console
// + connection-info side-car), the current-URL/mode state, and the QR re-render
// listeners (pairing_refreshed / token_rotated) with fakes — impossible while it
// was a closure inside the god function. writeConnectionInfo is injected so no
// ~/.chroxy write happens (the test sandbox guard would block it).

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { StartupDisplay, maskToken } from '../src/server-cli/startup-display.js'

function makeFakePairingManager() {
  const pm = new EventEmitter()
  pm.wsUrl = null
  pm.refreshed = 0
  pm.setWsUrl = (u) => { pm.wsUrl = u }
  Object.defineProperty(pm, 'currentPairingUrl', {
    get() { return this.wsUrl ? `chroxy://pair?ws=${encodeURIComponent(this.wsUrl)}` : null },
  })
  pm.refresh = () => { pm.refreshed++ }
  return pm
}

function makeDisplay({ pairingManager, tokenManager, apiToken = 'tok_abcdefgh1234', showToken = false } = {}) {
  const writes = []
  const logs = []
  const display = new StartupDisplay({
    pairingManager,
    tokenManager,
    apiToken,
    showToken,
    logger: { info: (m) => logs.push(m) },
    writeConnectionInfo: (info) => writes.push(info),
  })
  return { display, writes, logs }
}

// Capture console.log + process.stdout.write for displayQr assertions.
function captureConsole(fn) {
  const out = []
  const origLog = console.log
  const origWrite = process.stdout.write
  console.log = (...a) => out.push(a.join(' '))
  process.stdout.write = (s) => { out.push(String(s)); return true }
  return Promise.resolve(fn()).finally(() => {
    console.log = origLog
    process.stdout.write = origWrite
  }).then(() => out)
}

describe('maskToken', () => {
  it('masks long tokens and passes through short ones', () => {
    assert.equal(maskToken('abcdefgh1234'), 'abcd...1234')
    assert.equal(maskToken('abc'), 'abc')
    assert.equal(maskToken('abcdefgh'), 'abcdefgh')
    assert.equal(maskToken(''), '')
    assert.equal(maskToken(null), '')
  })
})

describe('StartupDisplay — buildPairingUrl', () => {
  it('returns null when pairing is disabled (no-auth)', () => {
    const { display } = makeDisplay({ pairingManager: null })
    assert.equal(display.buildPairingUrl('wss://x'), null)
  })

  it('sets the ws url on the pairing manager and returns the pairing url', () => {
    const pm = makeFakePairingManager()
    const { display } = makeDisplay({ pairingManager: pm })
    const url = display.buildPairingUrl('wss://host:1/')
    assert.equal(pm.wsUrl, 'wss://host:1/')
    assert.ok(url.startsWith('chroxy://pair?ws='))
  })
})

describe('StartupDisplay — currentWsUrl / currentTunnelMode state', () => {
  it('defaults to (null, none) and is settable', () => {
    const { display } = makeDisplay({ pairingManager: makeFakePairingManager() })
    assert.equal(display.currentWsUrl, null)
    assert.equal(display.currentTunnelMode, 'none')
    display.currentWsUrl = 'wss://x'
    display.currentTunnelMode = 'cloudflare:quick'
    assert.equal(display.currentWsUrl, 'wss://x')
    assert.equal(display.currentTunnelMode, 'cloudflare:quick')
  })
})

describe('StartupDisplay — displayQr', () => {
  it('writes the connection-info side-car with the pairing url and does NOT mutate state', async () => {
    const pm = makeFakePairingManager()
    const { display, writes } = makeDisplay({ pairingManager: pm })
    await captureConsole(() => display.displayQr('wss://host:1', 'https://host:1', 'cloudflare:quick'))
    assert.equal(writes.length, 1)
    assert.equal(writes[0].wsUrl, 'wss://host:1')
    assert.equal(writes[0].tunnelMode, 'cloudflare:quick')
    assert.ok(writes[0].connectionUrl.startsWith('chroxy://pair?ws='))
    // Pure presentation — the caller owns the current-URL state.
    assert.equal(display.currentWsUrl, null)
    assert.equal(display.currentTunnelMode, 'none')
  })

  it('masks the token by default and shows it with showToken', async () => {
    const pm = makeFakePairingManager()
    const masked = makeDisplay({ pairingManager: pm, apiToken: 'tok_abcdefgh1234', showToken: false })
    const outMasked = await captureConsole(() => masked.display.displayQr('wss://h', 'https://h', 'none'))
    assert.ok(outMasked.join('\n').includes('tok_...1234'))
    assert.ok(!outMasked.join('\n').includes('tok_abcdefgh1234'))

    const shown = makeDisplay({ pairingManager: pm, apiToken: 'tok_abcdefgh1234', showToken: true })
    const outShown = await captureConsole(() => shown.display.displayQr('wss://h', 'https://h', 'none'))
    assert.ok(outShown.join('\n').includes('tok_abcdefgh1234'))
  })

  it('no-auth (no pairing manager): no QR rendered but side-car still written with a token url', async () => {
    const { display, writes } = makeDisplay({ pairingManager: null })
    const out = await captureConsole(() => display.displayQr('ws://localhost:8765', 'http://localhost:8765', 'none'))
    assert.equal(writes.length, 1)
    assert.ok(writes[0].connectionUrl.startsWith('chroxy://localhost:8765?token='))
    assert.ok(!out.join('\n').includes('Scan this QR code'), 'no QR block without a pairing url')
  })
})

describe('StartupDisplay — wireReRenderListeners', () => {
  let pm, tm, fakes
  beforeEach(() => {
    pm = makeFakePairingManager()
    tm = new EventEmitter()
    fakes = makeDisplay({ pairingManager: pm, tokenManager: tm })
    fakes.display.wireReRenderListeners()
  })

  it('pairing_refreshed re-renders the QR for the current url', async () => {
    fakes.display.currentWsUrl = 'wss://host:1'
    fakes.display.currentTunnelMode = 'cloudflare:quick'
    await captureConsole(async () => { pm.emit('pairing_refreshed'); await Promise.resolve() })
    assert.ok(fakes.writes.length >= 1, 'displayQr ran (side-car written)')
    assert.ok(fakes.logs.some((m) => m.includes('QR code refreshed')))
  })

  it('pairing_refreshed is a no-op before any url is set', async () => {
    await captureConsole(async () => { pm.emit('pairing_refreshed'); await Promise.resolve() })
    assert.equal(fakes.writes.length, 0)
  })

  it('token_rotated refreshes the pairing id (delegating QR re-render to pairing_refreshed)', async () => {
    fakes.display.currentWsUrl = 'wss://host:1'
    await captureConsole(async () => { tm.emit('token_rotated'); await Promise.resolve() })
    assert.equal(pm.refreshed, 1, 'pairing refresh requested (its pairing_refreshed handles the redraw)')
    assert.ok(fakes.logs.some((m) => m.includes('API token rotated')))
  })

  it('token_rotated WITHOUT a pairing manager re-renders directly', async () => {
    const tm2 = new EventEmitter()
    const f = makeDisplay({ pairingManager: null, tokenManager: tm2 })
    f.display.wireReRenderListeners()
    f.display.currentWsUrl = 'ws://localhost:8765'
    await captureConsole(async () => { tm2.emit('token_rotated'); await Promise.resolve() })
    assert.ok(f.writes.length >= 1, 'displayQr ran directly since no pairing_refreshed will fire')
  })
})
