import { describe, it, expect } from 'vitest'
import { parsePairingUrl, isPairingUrl } from './pairing'

describe('parsePairingUrl', () => {
  it('infers ws:// for a LAN chroxy URL (explicit port)', () => {
    const r = parsePairingUrl('chroxy://192.168.1.5:8765?pair=ABC123')
    expect(r).toEqual({ wsUrl: 'ws://192.168.1.5:8765/ws', pairingId: 'ABC123' })
  })

  it('infers wss:// for a tunnel chroxy URL (no port)', () => {
    const r = parsePairingUrl('chroxy://my-tunnel.trycloudflare.com?pair=XYZ')
    expect(r).toEqual({ wsUrl: 'wss://my-tunnel.trycloudflare.com/ws', pairingId: 'XYZ' })
  })

  it('handles a LAN hostname with a port', () => {
    const r = parsePairingUrl('chroxy://macbook.local:8765?pair=p1')
    expect(r?.wsUrl).toBe('ws://macbook.local:8765/ws')
  })

  it('handles an IPv6 LAN literal (port present ⇒ ws)', () => {
    const r = parsePairingUrl('chroxy://[fe80::1]:8765?pair=p1')
    expect(r?.wsUrl).toBe('ws://[fe80::1]:8765/ws')
  })

  it('parses the legacy ?token= flow', () => {
    const r = parsePairingUrl('chroxy://192.168.1.5:8765?token=secret')
    expect(r).toEqual({ wsUrl: 'ws://192.168.1.5:8765/ws', token: 'secret' })
  })

  it('keeps an explicit ws:// scheme (override for paste)', () => {
    const r = parsePairingUrl('ws://10.0.0.2:9000?pair=p1')
    expect(r?.wsUrl).toBe('ws://10.0.0.2:9000/ws')
  })

  it('keeps an explicit wss:// scheme even with a port (custom-proxy override)', () => {
    const r = parsePairingUrl('wss://proxy.example.com:8443?pair=p1')
    expect(r?.wsUrl).toBe('wss://proxy.example.com:8443/ws')
  })

  it('returns null for a URL with neither pair nor token', () => {
    expect(parsePairingUrl('chroxy://192.168.1.5:8765')).toBeNull()
  })

  it('returns null for a non-connection URL', () => {
    expect(parsePairingUrl('https://example.com?pair=x')).toBeNull()
    expect(parsePairingUrl('not a url')).toBeNull()
    expect(parsePairingUrl('')).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    const r = parsePairingUrl('  chroxy://192.168.1.5:8765?pair=ABC  ')
    expect(r?.pairingId).toBe('ABC')
  })
})

describe('isPairingUrl', () => {
  it('is true only for a URL carrying ?pair=', () => {
    expect(isPairingUrl('chroxy://192.168.1.5:8765?pair=ABC')).toBe(true)
    expect(isPairingUrl('chroxy://192.168.1.5:8765?token=tok')).toBe(false)
    expect(isPairingUrl('wss://host/ws')).toBe(false)
    expect(isPairingUrl('garbage')).toBe(false)
  })
})
