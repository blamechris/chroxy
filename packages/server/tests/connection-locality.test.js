import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isLocalOrLanPeer } from '../src/connection-locality.js'

function req({ remoteAddress, headers = {} } = {}) {
  return { socket: { remoteAddress }, headers }
}

describe('isLocalOrLanPeer (#5516)', () => {
  it('treats a direct loopback peer as local', () => {
    assert.equal(isLocalOrLanPeer(req({ remoteAddress: '127.0.0.1' })), true)
    assert.equal(isLocalOrLanPeer(req({ remoteAddress: '::1' })), true)
    assert.equal(isLocalOrLanPeer(req({ remoteAddress: '::ffff:127.0.0.1' })), true)
  })

  it('treats a direct RFC1918 LAN peer as local', () => {
    assert.equal(isLocalOrLanPeer(req({ remoteAddress: '192.168.1.50' })), true)
    assert.equal(isLocalOrLanPeer(req({ remoteAddress: '10.0.0.4' })), true)
    assert.equal(isLocalOrLanPeer(req({ remoteAddress: '172.16.5.9' })), true)
  })

  it('treats a tunnel connection (loopback peer + proxy header) as REMOTE', () => {
    // cloudflared connects from loopback but stamps the real client IP.
    assert.equal(
      isLocalOrLanPeer(req({ remoteAddress: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.7' } })),
      false,
    )
    assert.equal(
      isLocalOrLanPeer(req({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.7' } })),
      false,
    )
  })

  it('a spoofed proxy header can only make a connection look REMOTE (deflate stays on)', () => {
    // An attacker can add headers but cannot change the kernel socket peer.
    // Worst case: a LAN peer is treated as remote and keeps deflate. Safe.
    assert.equal(
      isLocalOrLanPeer(req({ remoteAddress: '192.168.1.50', headers: { 'x-forwarded-for': '8.8.8.8' } })),
      false,
    )
  })

  it('treats a genuinely public socket peer as remote', () => {
    // Note: a direct connection from a public IP only happens when the daemon
    // is bound to a public interface (rare). Reserved doc ranges like
    // 203.0.113.0/24 are flagged private by the SSRF guard, which is fine for
    // this transport hint — they're never real remote clients anyway.
    assert.equal(isLocalOrLanPeer(req({ remoteAddress: '8.8.8.8' })), false)
    assert.equal(isLocalOrLanPeer(req({ remoteAddress: '1.1.1.1' })), false)
  })

  it('is safe (remote) when the socket address is missing', () => {
    assert.equal(isLocalOrLanPeer(req({ remoteAddress: undefined })), false)
    assert.equal(isLocalOrLanPeer({}), false)
    assert.equal(isLocalOrLanPeer(undefined), false)
  })
})
