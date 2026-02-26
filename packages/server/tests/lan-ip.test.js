import { describe, it, after, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'

// Mock networkInterfaces before importing getLanIp
const mockNetworkInterfaces = mock.method(os, 'networkInterfaces')

// Dynamic import so the mock is in place
const { getLanIp } = await import('../src/lan-ip.js')

// Restore original os.networkInterfaces after all tests complete
after(() => mockNetworkInterfaces.mock.restore())

function iface(address, family = 'IPv4', internal = false) {
  return { address, family, internal }
}

describe('getLanIp', () => {
  beforeEach(() => {
    mockNetworkInterfaces.mock.resetCalls()
  })

  it('returns non-VPN interface when both VPN and WiFi are present', () => {
    mockNetworkInterfaces.mock.mockImplementation(() => ({
      utun0: [iface('10.0.0.1')],
      en0: [iface('192.168.1.42')],
    }))
    assert.equal(getLanIp(), '192.168.1.42')
  })

  it('prefers non-VPN even when VPN appears first', () => {
    mockNetworkInterfaces.mock.mockImplementation(() => ({
      wg0: [iface('10.10.0.1')],
      tun0: [iface('10.8.0.1')],
      en1: [iface('192.168.0.5')],
    }))
    assert.equal(getLanIp(), '192.168.0.5')
  })

  it('falls back to VPN address when no non-VPN interface exists', () => {
    mockNetworkInterfaces.mock.mockImplementation(() => ({
      utun0: [iface('10.0.0.1')],
      tun1: [iface('10.8.0.2')],
    }))
    assert.equal(getLanIp(), '10.0.0.1')
  })

  it('returns null when no non-internal interfaces exist', () => {
    mockNetworkInterfaces.mock.mockImplementation(() => ({
      lo0: [iface('127.0.0.1', 'IPv4', true)],
    }))
    assert.equal(getLanIp(), null)
  })

  it('returns null when no interfaces exist', () => {
    mockNetworkInterfaces.mock.mockImplementation(() => ({}))
    assert.equal(getLanIp(), null)
  })

  it('skips IPv6 addresses', () => {
    mockNetworkInterfaces.mock.mockImplementation(() => ({
      en0: [iface('fe80::1', 'IPv6'), iface('192.168.1.10')],
    }))
    assert.equal(getLanIp(), '192.168.1.10')
  })

  it('handles case-insensitive VPN interface names', () => {
    mockNetworkInterfaces.mock.mockImplementation(() => ({
      UTUN0: [iface('10.0.0.1')],
      Tailscale0: [iface('100.64.0.1')],
      en0: [iface('192.168.1.99')],
    }))
    assert.equal(getLanIp(), '192.168.1.99')
  })

  describe('filters all VPN prefixes', () => {
    const vpnPrefixes = [
      ['utun0', '10.0.0.1'],
      ['tun0', '10.8.0.1'],
      ['tap0', '10.9.0.1'],
      ['tailscale0', '100.64.0.1'],
      ['ts0', '100.64.0.2'],
      ['wg0', '10.10.0.1'],
    ]

    for (const [name, addr] of vpnPrefixes) {
      it(`filters ${name}`, () => {
        mockNetworkInterfaces.mock.mockImplementation(() => ({
          [name]: [iface(addr)],
          eth0: [iface('192.168.1.1')],
        }))
        assert.equal(getLanIp(), '192.168.1.1')
      })

      it(`falls back to ${name} when it's the only option`, () => {
        mockNetworkInterfaces.mock.mockImplementation(() => ({
          [name]: [iface(addr)],
        }))
        assert.equal(getLanIp(), addr)
      })
    }
  })
})
