import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBindHost, isLoopbackHost, formatHostForUrl, maybeWarnNonLoopbackBind } from '../src/bind-host.js'

describe('isLoopbackHost', () => {
  it('treats 127.0.0.1 and the 127.0.0.0/8 range as loopback', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true)
    assert.equal(isLoopbackHost('127.0.0.53'), true)
    assert.equal(isLoopbackHost('127.1.2.3'), true)
  })

  it('treats ::1 and localhost as loopback', () => {
    assert.equal(isLoopbackHost('::1'), true)
    assert.equal(isLoopbackHost('localhost'), true)
  })

  it('treats IPv4-mapped IPv6 loopback as loopback', () => {
    assert.equal(isLoopbackHost('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackHost('::ffff:7f00:1'), true)
  })

  it('matches localhost case-insensitively', () => {
    assert.equal(isLoopbackHost('LocalHost'), true)
    assert.equal(isLoopbackHost('LOCALHOST'), true)
  })

  it('does not treat a hostname starting with 127. as loopback', () => {
    // Only valid IPv4 literals in 127.0.0.0/8 count — not arbitrary hostnames.
    assert.equal(isLoopbackHost('127.example.com'), false)
    assert.equal(isLoopbackHost('127.0.0.1.nip.io'), false)
  })

  it('does not treat 0.0.0.0, LAN IPs, or undefined as loopback', () => {
    assert.equal(isLoopbackHost('0.0.0.0'), false)
    assert.equal(isLoopbackHost('192.168.1.10'), false)
    assert.equal(isLoopbackHost('10.0.0.5'), false)
    assert.equal(isLoopbackHost(undefined), false)
    assert.equal(isLoopbackHost(''), false)
    assert.equal(isLoopbackHost(null), false)
  })
})

describe('formatHostForUrl', () => {
  it('brackets IPv6 literals', () => {
    assert.equal(formatHostForUrl('::1'), '[::1]')
    assert.equal(formatHostForUrl('fd00::1'), '[fd00::1]')
  })

  it('leaves IPv4 and hostnames untouched', () => {
    assert.equal(formatHostForUrl('127.0.0.1'), '127.0.0.1')
    assert.equal(formatHostForUrl('192.168.1.10'), '192.168.1.10')
    assert.equal(formatHostForUrl('localhost'), 'localhost')
  })
})

describe('resolveBindHost', () => {
  it('forces loopback when auth is disabled, ignoring any host override', () => {
    assert.equal(resolveBindHost({ noAuth: true }), '127.0.0.1')
    assert.equal(resolveBindHost({ noAuth: true, host: '0.0.0.0' }), '127.0.0.1')
  })

  it('returns undefined (0.0.0.0 default) when auth is on and no host is set', () => {
    assert.equal(resolveBindHost({ noAuth: false }), undefined)
    assert.equal(resolveBindHost({ noAuth: false, host: '' }), undefined)
    assert.equal(resolveBindHost({}), undefined)
  })

  it('binds an explicit host with auth on', () => {
    assert.equal(resolveBindHost({ noAuth: false, host: '127.0.0.1' }), '127.0.0.1')
    assert.equal(resolveBindHost({ noAuth: false, host: '0.0.0.0' }), '0.0.0.0')
    assert.equal(resolveBindHost({ noAuth: false, host: '192.168.1.10' }), '192.168.1.10')
  })
})

// #5356 (visibility layer): one startup warning when binding non-loopback.
describe('maybeWarnNonLoopbackBind', () => {
  function captureLogger() {
    const warns = []
    return { warns, log: { warn: (msg) => warns.push(msg) } }
  }

  it('warns once for the default undefined bind (0.0.0.0)', () => {
    const { warns, log } = captureLogger()
    assert.equal(maybeWarnNonLoopbackBind({ bindHost: undefined, log }), true)
    assert.equal(warns.length, 1)
    assert.match(warns[0], /0\.0\.0\.0 \(all interfaces\)/)
  })

  it('warns for an explicit 0.0.0.0 or LAN bind, naming the bind address', () => {
    for (const bindHost of ['0.0.0.0', '192.168.1.10', '::']) {
      const { warns, log } = captureLogger()
      assert.equal(maybeWarnNonLoopbackBind({ bindHost, log }), true)
      assert.equal(warns.length, 1)
      assert.ok(warns[0].includes(bindHost), `warning names ${bindHost}: ${warns[0]}`)
    }
  })

  it('says LAN peers can reach auth/pairing endpoints and how to restrict', () => {
    const { warns, log } = captureLogger()
    maybeWarnNonLoopbackBind({ bindHost: undefined, log })
    assert.match(warns[0], /auth and pairing endpoints/)
    assert.match(warns[0], /--host 127\.0\.0\.1/)
    assert.match(warns[0], /CHROXY_HOST=127\.0\.0\.1/)
    assert.match(warns[0], /config\.json/)
  })

  it('stays silent for loopback binds', () => {
    for (const bindHost of ['127.0.0.1', '127.0.0.53', 'localhost', '::1']) {
      const { warns, log } = captureLogger()
      assert.equal(maybeWarnNonLoopbackBind({ bindHost, log }), false)
      assert.equal(warns.length, 0, `no warning for ${bindHost}`)
    }
  })
})
