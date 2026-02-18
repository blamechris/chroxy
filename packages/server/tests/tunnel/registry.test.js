import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Import from the index to test the full registration chain
// But we also need to test the raw registry functions
import { registerTunnel, getTunnel, listTunnels, parseTunnelArg } from '../../src/tunnel/registry.js'

// Dummy adapter for registration tests
class DummyAdapter {
  static get name() { return 'dummy' }
  static get capabilities() {
    return { modes: ['default'], stableUrl: false, binaryName: 'dummy-bin', setupRequired: false, installHint: 'install dummy' }
  }
}

describe('Tunnel Registry', () => {
  describe('registerTunnel / getTunnel', () => {
    it('registers and retrieves an adapter', () => {
      registerTunnel('dummy-test', DummyAdapter)
      const result = getTunnel('dummy-test')
      assert.equal(result, DummyAdapter)
    })

    it('throws on empty name', () => {
      assert.throws(() => registerTunnel('', DummyAdapter), /non-empty string/)
    })

    it('throws on non-function adapter', () => {
      assert.throws(() => registerTunnel('bad', 'not a class'), /must be a class/)
    })

    it('throws on unknown provider', () => {
      assert.throws(() => getTunnel('nonexistent'), /Unknown tunnel provider/)
    })

    it('error message lists available providers', () => {
      registerTunnel('listed-provider', DummyAdapter)
      try {
        getTunnel('unknown-xyz')
        assert.fail('Should have thrown')
      } catch (err) {
        assert.ok(err.message.includes('listed-provider'))
      }
    })
  })

  describe('listTunnels', () => {
    it('returns registered adapters with capabilities', () => {
      registerTunnel('list-test-provider', DummyAdapter)
      const list = listTunnels()
      const entry = list.find(t => t.name === 'list-test-provider')
      assert.ok(entry, 'Should find registered adapter in list')
      assert.deepEqual(entry.capabilities.modes, ['default'])
    })
  })

  describe('built-in cloudflare registration', () => {
    it('cloudflare is pre-registered via index.js import', async () => {
      // Importing index.js triggers the registerTunnel('cloudflare', ...) call
      await import('../../src/tunnel/index.js')
      const Adapter = getTunnel('cloudflare')
      assert.ok(Adapter, 'cloudflare adapter should be registered')
      assert.deepEqual(Adapter.capabilities.modes, ['quick', 'named'])
    })
  })

  describe('parseTunnelArg', () => {
    it('returns null for "none"', () => {
      assert.equal(parseTunnelArg('none'), null)
    })

    it('returns null for empty string', () => {
      assert.equal(parseTunnelArg(''), null)
    })

    it('returns null for undefined', () => {
      assert.equal(parseTunnelArg(undefined), null)
    })

    it('maps "quick" to cloudflare:quick', () => {
      const result = parseTunnelArg('quick')
      assert.deepEqual(result, { provider: 'cloudflare', mode: 'quick' })
    })

    it('maps "named" to cloudflare:named', () => {
      const result = parseTunnelArg('named')
      assert.deepEqual(result, { provider: 'cloudflare', mode: 'named' })
    })

    it('maps "cloudflare" to cloudflare:quick', () => {
      const result = parseTunnelArg('cloudflare')
      assert.deepEqual(result, { provider: 'cloudflare', mode: 'quick' })
    })

    it('parses "cloudflare:quick" explicitly', () => {
      const result = parseTunnelArg('cloudflare:quick')
      assert.deepEqual(result, { provider: 'cloudflare', mode: 'quick' })
    })

    it('parses "cloudflare:named" explicitly', () => {
      const result = parseTunnelArg('cloudflare:named')
      assert.deepEqual(result, { provider: 'cloudflare', mode: 'named' })
    })

    it('parses unknown provider "ngrok" with default mode', () => {
      const result = parseTunnelArg('ngrok')
      assert.deepEqual(result, { provider: 'ngrok', mode: 'default' })
    })

    it('parses "ngrok:custom" with explicit mode', () => {
      const result = parseTunnelArg('ngrok:custom')
      assert.deepEqual(result, { provider: 'ngrok', mode: 'custom' })
    })

    it('parses "tailscale:funnel" with explicit mode', () => {
      const result = parseTunnelArg('tailscale:funnel')
      assert.deepEqual(result, { provider: 'tailscale', mode: 'funnel' })
    })
  })
})
