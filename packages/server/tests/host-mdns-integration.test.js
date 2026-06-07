import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { maybeAdvertiseMdns } from '../src/server-cli.js'
import { resolveBindHost, isLoopbackHost } from '../src/bind-host.js'

/**
 * #5280 — integration coverage for the --host / mDNS wiring in server-cli.js.
 *
 * The pure resolver (bind-host.js) is unit-tested in bind-host.test.js. This
 * suite covers the *wiring*: that the resolved bind host actually drives a
 * loopback-only socket bind, and that the mDNS advertisement is suppressed on a
 * loopback bind (and when auth is off) but published otherwise — exercising the
 * exact maybeAdvertiseMdns() seam startCliServer() calls.
 *
 * A full startCliServer() boot is intentionally NOT used: it migrates tokens,
 * encrypts credentials, and writes config under the real ~/.chroxy tree, which
 * the #4633 test sandbox guard blocks, and it calls process.exit() on several
 * paths. Extracting maybeAdvertiseMdns lets us test the same code the CLI runs.
 */

const silentLog = { info: () => {}, debug: () => {}, warn: () => {} }

// A fake Bonjour instance that records publish() calls so we can assert the
// service shape without touching the network.
function makeFakeBonjour() {
  const published = []
  const instance = {
    publish: (opts) => {
      published.push(opts)
      return { stop: () => {} }
    },
    destroy: () => {},
  }
  return { instance, published, factory: () => instance }
}

describe('#5280 resolveBindHost drives a real socket bind', () => {
  function bindAndGetAddress(host) {
    return new Promise((resolve, reject) => {
      const server = http.createServer()
      server.on('error', reject)
      // port 0 → ephemeral port; host is the resolved bind address.
      server.listen(0, host, () => {
        const addr = server.address()
        server.close(() => resolve(addr))
      })
    })
  }

  it('config.host = 127.0.0.1 binds loopback only', async () => {
    const bindHost = resolveBindHost({ noAuth: false, host: '127.0.0.1' })
    assert.equal(bindHost, '127.0.0.1')
    const addr = await bindAndGetAddress(bindHost)
    assert.equal(addr.address, '127.0.0.1')
    assert.equal(isLoopbackHost(addr.address), true)
  })

  it('--no-auth forces a loopback bind regardless of host', async () => {
    const bindHost = resolveBindHost({ noAuth: true, host: undefined })
    assert.equal(bindHost, '127.0.0.1')
    const addr = await bindAndGetAddress(bindHost)
    assert.equal(isLoopbackHost(addr.address), true)
  })

  it('default (no host, auth on) binds all interfaces — not loopback', async () => {
    const bindHost = resolveBindHost({ noAuth: false, host: undefined })
    assert.equal(bindHost, undefined)
    const addr = await bindAndGetAddress(bindHost)
    // Node binds the unspecified address (0.0.0.0 or :: depending on stack).
    assert.ok(
      addr.address === '0.0.0.0' || addr.address === '::',
      `expected an unspecified bind address, got ${addr.address}`,
    )
    assert.equal(isLoopbackHost(addr.address), false)
  })
})

describe('#5280 maybeAdvertiseMdns suppresses mDNS on a loopback bind', () => {
  it('does not publish when bound to 127.0.0.1', async () => {
    const fake = makeFakeBonjour()
    const res = await maybeAdvertiseMdns({
      noAuth: false,
      bindHost: '127.0.0.1',
      port: 8765,
      version: '9.9.9',
      hasToken: true,
      log: silentLog,
      bonjourFactory: fake.factory,
    })
    assert.equal(fake.published.length, 0)
    assert.equal(res.mdnsService, null)
    assert.equal(res.bonjourInstance, null)
  })

  it('does not publish when bound to localhost', async () => {
    const fake = makeFakeBonjour()
    await maybeAdvertiseMdns({
      noAuth: false,
      bindHost: 'localhost',
      port: 8765,
      version: '9.9.9',
      hasToken: true,
      log: silentLog,
      bonjourFactory: fake.factory,
    })
    assert.equal(fake.published.length, 0)
  })

  it('does not publish when auth is off, even on a public bind', async () => {
    const fake = makeFakeBonjour()
    const res = await maybeAdvertiseMdns({
      noAuth: true,
      bindHost: '0.0.0.0',
      port: 8765,
      version: '9.9.9',
      hasToken: false,
      log: silentLog,
      bonjourFactory: fake.factory,
    })
    assert.equal(fake.published.length, 0)
    assert.equal(res.bonjourInstance, null)
  })
})

describe('#5280 maybeAdvertiseMdns publishes on a LAN-reachable bind', () => {
  it('publishes _chroxy._tcp on the default (undefined) bind', async () => {
    const fake = makeFakeBonjour()
    const res = await maybeAdvertiseMdns({
      noAuth: false,
      bindHost: undefined,
      port: 8765,
      version: '9.9.9',
      hasToken: true,
      log: silentLog,
      bonjourFactory: fake.factory,
    })
    assert.equal(fake.published.length, 1)
    const svc = fake.published[0]
    assert.equal(svc.type, 'chroxy')
    assert.equal(svc.port, 8765)
    assert.equal(svc.txt.version, '9.9.9')
    assert.equal(svc.txt.auth, 'token')
    assert.ok(svc.name.startsWith('Chroxy ('))
    assert.equal(res.bonjourInstance, fake.instance)
    assert.ok(res.mdnsService)
  })

  it('publishes on an explicit non-loopback host with auth = none when tokenless', async () => {
    const fake = makeFakeBonjour()
    await maybeAdvertiseMdns({
      noAuth: false,
      bindHost: '192.168.1.50',
      port: 9000,
      version: '1.0.0',
      hasToken: false,
      log: silentLog,
      bonjourFactory: fake.factory,
    })
    assert.equal(fake.published.length, 1)
    assert.equal(fake.published[0].txt.auth, 'none')
    assert.equal(fake.published[0].port, 9000)
  })

  it('degrades gracefully to no-advertisement when Bonjour throws', async () => {
    const res = await maybeAdvertiseMdns({
      noAuth: false,
      bindHost: '0.0.0.0',
      port: 8765,
      version: '9.9.9',
      hasToken: true,
      log: silentLog,
      bonjourFactory: () => { throw new Error('bonjour unavailable') },
    })
    assert.equal(res.mdnsService, null)
    assert.equal(res.bonjourInstance, null)
  })

  it('degrades gracefully even when a non-Error value is thrown', async () => {
    // The catch normalizes err via `err?.message || String(err)`, so a thrown
    // string / null must not turn the fallback into a TypeError crash.
    for (const thrown of ['plain string', null, undefined, 42]) {
      const res = await maybeAdvertiseMdns({
        noAuth: false,
        bindHost: '0.0.0.0',
        port: 8765,
        version: '9.9.9',
        hasToken: true,
        log: silentLog,
        bonjourFactory: () => { throw thrown },
      })
      assert.equal(res.mdnsService, null)
      assert.equal(res.bonjourInstance, null)
    }
  })
})
