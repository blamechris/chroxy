import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBindHost, isLoopbackHost } from '../src/bind-host.js'

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

  it('does not treat 0.0.0.0, LAN IPs, or undefined as loopback', () => {
    assert.equal(isLoopbackHost('0.0.0.0'), false)
    assert.equal(isLoopbackHost('192.168.1.10'), false)
    assert.equal(isLoopbackHost('10.0.0.5'), false)
    assert.equal(isLoopbackHost(undefined), false)
    assert.equal(isLoopbackHost(''), false)
    assert.equal(isLoopbackHost(null), false)
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
