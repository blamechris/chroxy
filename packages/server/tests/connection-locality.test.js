import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isLocalOrLanPeer, isLoopbackPeer } from '../src/connection-locality.js'

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

describe('isLoopbackPeer (#8324)', () => {
  it('accepts a direct loopback peer only', () => {
    assert.equal(isLoopbackPeer(req({ remoteAddress: '127.0.0.1' })), true)
    assert.equal(isLoopbackPeer(req({ remoteAddress: '::1' })), true)
    assert.equal(isLoopbackPeer(req({ remoteAddress: '::ffff:127.0.0.1' })), true)
  })

  it('refuses a LAN peer (unlike isLocalOrLanPeer)', () => {
    assert.equal(isLoopbackPeer(req({ remoteAddress: '192.168.1.50' })), false)
    assert.equal(isLoopbackPeer(req({ remoteAddress: '10.0.0.4' })), false)
  })

  it('refuses a tunnelled request: loopback socket plus a proxy header', () => {
    assert.equal(isLoopbackPeer(req({ remoteAddress: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.7' } })), false)
    assert.equal(isLoopbackPeer(req({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.7' } })), false)
    // PRESENCE, not truthiness: an empty value still means a proxy is in front.
    assert.equal(isLoopbackPeer(req({ remoteAddress: '127.0.0.1', headers: { 'cf-connecting-ip': '' } })), false)
  })

  it('fails closed when the socket address is missing', () => {
    assert.equal(isLoopbackPeer(req({ remoteAddress: undefined })), false)
    assert.equal(isLoopbackPeer({}), false)
    assert.equal(isLoopbackPeer(undefined), false)
  })
})

describe('isLoopbackPeer strict parsing (#8324 review)', () => {
  it('accepts exactly 127.0.0.0/8, ::1 and mapped 127.x', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '127.255.255.254', '::1', '::ffff:127.0.0.1', '::FFFF:127.9.9.9']) {
      assert.equal(isLoopbackPeer(req({ remoteAddress: ip })), true, ip)
    }
  })

  it('rejects neighbours that a prefix test would let through', () => {
    for (const ip of ['::ffff:7f00:1:2', '::ffff:7f00:1', '::2', '::', '128.0.0.1', '126.255.255.255', '::ffff:10.0.0.1',
      '::ffff:128.0.0.1', '127.0.0', '127.0.0.1.5', '127.0.0.256', '1270.0.0.1', 'localhost', '::ffff:127.0.0.1.2', '0:0:0:0:0:0:0:1:1']) {
      assert.equal(isLoopbackPeer(req({ remoteAddress: ip })), false, ip)
    }
  })

  it('rejects every proxy-family header by NAME, with no visitor-IP header present', () => {
    // Cloudflare can strip cf-connecting-ip / x-forwarded-for with a managed
    // transform; the rest of the family still marks the request as tunnelled.
    for (const h of ['cf-ray', 'cf-visitor', 'cf-ipcountry', 'cdn-loop', 'forwarded', 'x-forwarded-proto',
      'x-forwarded-host', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']) {
      assert.equal(isLoopbackPeer(req({ remoteAddress: '127.0.0.1', headers: { [h]: '1' } })), false, h)
      assert.equal(isLoopbackPeer(req({ remoteAddress: '127.0.0.1', headers: { [h]: '' } })), false, `${h} (empty)`)
    }
    assert.equal(isLoopbackPeer(req({ remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:8765', authorization: 'Bearer x', 'user-agent': 'node' } })), true,
      'ordinary headers do not disqualify')
  })

  it('isLocalOrLanPeer is unchanged: cf-ray alone does not make it remote', () => {
    assert.equal(isLocalOrLanPeer(req({ remoteAddress: '127.0.0.1', headers: { 'cf-ray': 'x' } })), true)
  })
})
