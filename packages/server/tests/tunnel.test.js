import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Backward-compatibility shim test.
 * Verifies that the old import path still works.
 */
describe('tunnel.js backward-compat shim', () => {
  it('exports TunnelManager from old path', async () => {
    const { TunnelManager } = await import('../src/tunnel.js')
    assert.ok(TunnelManager, 'TunnelManager should be exported')
    assert.equal(typeof TunnelManager, 'function', 'TunnelManager should be a class')
  })

  it('TunnelManager is the CloudflareTunnelAdapter', async () => {
    const { TunnelManager } = await import('../src/tunnel.js')
    const { CloudflareTunnelAdapter } = await import('../src/tunnel/cloudflare.js')
    assert.equal(TunnelManager, CloudflareTunnelAdapter, 'TunnelManager should be CloudflareTunnelAdapter')
  })
})
