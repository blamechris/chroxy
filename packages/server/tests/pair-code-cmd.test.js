/**
 * `chroxy pair-code` CLI (#5512, epic #5509).
 *
 * Prints the host's current typeable pairing code once, with its remaining TTL and
 * ws URL, then exits — scriptable, no refresh loop. The code is read off the host's
 * own screen (physical presence), so the new device pairs with no extra approval.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fetchPairingCode, formatPairingCode } from '../src/cli/pair-code-cmd.js'

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
  }
}

describe('pair-code CLI (#5512)', () => {
  it('fetches the code from the daemon using the connection-info token', async () => {
    let calledUrl = null
    let calledAuth = null
    const result = await fetchPairingCode({
      readConnectionInfo: () => ({ pid: 1, httpUrl: 'http://127.0.0.1:8765', wsUrl: 'wss://x.tld', apiToken: 'tok' }),
      fetchFn: async (url, opts) => {
        calledUrl = url
        calledAuth = opts.headers.Authorization
        return mockResponse(200, { code: 'ABCD2345', url: 'chroxy://x.tld?pair=ABCD2345', expiresAtMs: Date.now() + 50_000, expiresInSeconds: 50 })
      },
    })
    assert.ok(calledUrl.endsWith('/pairing-code'))
    assert.equal(calledAuth, 'Bearer tok')
    assert.equal(result.ok, true)
    assert.equal(result.code, 'ABCD2345')
    assert.equal(result.expiresInSeconds, 50)
    assert.equal(result.wsUrl, 'wss://x.tld')
  })

  it('reports not-running when no connection info exists', async () => {
    const result = await fetchPairingCode({
      readConnectionInfo: () => null,
      fetchFn: async () => { throw new Error('should not be called') },
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not_running')
  })

  it('reports an error when the daemon returns non-200', async () => {
    const result = await fetchPairingCode({
      readConnectionInfo: () => ({ pid: 1, httpUrl: 'http://127.0.0.1:8765', apiToken: 'tok' }),
      fetchFn: async () => mockResponse(503, { error: 'Pairing code not available yet' }),
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'unavailable')
  })

  it('formatPairingCode renders code, ttl, and host on one line', () => {
    const line = formatPairingCode({ ok: true, code: 'ABCD2345', expiresInSeconds: 42, wsUrl: 'wss://x.tld' })
    assert.match(line, /ABCD2345/)
    assert.match(line, /expires in 42s/)
    assert.match(line, /wss:\/\/x\.tld/)
  })
})
