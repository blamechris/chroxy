import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseTunnelArg, createTunnel, CloudflareTunnelAdapter } from '../../src/tunnel/index.js'

describe('tunnel/index — parseTunnelArg', () => {
  it('returns null for "none"', () => {
    assert.equal(parseTunnelArg('none'), null)
  })

  it('returns null for empty string', () => {
    assert.equal(parseTunnelArg(''), null)
  })

  it('returns null for undefined', () => {
    assert.equal(parseTunnelArg(undefined), null)
  })

  it('maps "quick" to { mode: "quick" }', () => {
    assert.deepEqual(parseTunnelArg('quick'), { mode: 'quick' })
  })

  it('maps "named" to { mode: "named" }', () => {
    assert.deepEqual(parseTunnelArg('named'), { mode: 'named' })
  })

  it('maps "cloudflare" to { mode: "quick" }', () => {
    assert.deepEqual(parseTunnelArg('cloudflare'), { mode: 'quick' })
  })

  it('parses "cloudflare:quick" explicitly', () => {
    assert.deepEqual(parseTunnelArg('cloudflare:quick'), { mode: 'quick' })
  })

  it('parses "cloudflare:named" explicitly', () => {
    assert.deepEqual(parseTunnelArg('cloudflare:named'), { mode: 'named' })
  })

  it('throws on trailing colon "cloudflare:"', () => {
    assert.throws(() => parseTunnelArg('cloudflare:'), /Invalid tunnel format/)
  })

  it('throws on unknown value', () => {
    assert.throws(() => parseTunnelArg('ngrok'), /Unknown tunnel value/)
  })
})

describe('tunnel/index — createTunnel', () => {
  it('returns a CloudflareTunnelAdapter instance in quick mode', () => {
    const tunnel = createTunnel({ port: 3000, mode: 'quick' })
    assert.ok(tunnel instanceof CloudflareTunnelAdapter)
    assert.equal(tunnel.port, 3000)
    assert.equal(tunnel.mode, 'quick')
  })

  it('returns a CloudflareTunnelAdapter instance in named mode', () => {
    const tunnel = createTunnel({
      port: 4000,
      mode: 'named',
      tunnelName: 'my-tunnel',
      tunnelHostname: 'chroxy.example.com',
    })
    assert.ok(tunnel instanceof CloudflareTunnelAdapter)
    assert.equal(tunnel.mode, 'named')
    assert.equal(tunnel.tunnelName, 'my-tunnel')
    assert.equal(tunnel.tunnelHostname, 'chroxy.example.com')
  })
})
