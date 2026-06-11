/**
 * `chroxy pair-discord` CLI (#5513, epic #5509).
 *
 * Host-triggered post of an approval-gated pairing link to the configured
 * Discord webhook channel. Hits the daemon's POST /pair-discord, which mints a
 * fresh gated id (redeeming it needs host approval — the channel grants
 * nothing) and posts only the chroxy:// link. Exits non-zero on any failure.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { postPairDiscord, formatPairDiscordResult, runPairDiscordCmd } from '../src/cli/pair-discord-cmd.js'

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
  }
}

describe('pair-discord CLI (#5513)', () => {
  it('POSTs to /pair-discord with the connection-info token', async () => {
    let calledUrl = null
    let calledMethod = null
    let calledAuth = null
    const result = await postPairDiscord({
      readConnectionInfo: () => ({ pid: 1, httpUrl: 'http://127.0.0.1:8765', wsUrl: 'wss://x.tld', apiToken: 'tok' }),
      fetchFn: async (url, opts) => {
        calledUrl = url
        calledMethod = opts.method
        calledAuth = opts.headers.Authorization
        return mockResponse(200, { posted: true, expiresInSeconds: 60 })
      },
    })
    assert.ok(calledUrl.endsWith('/pair-discord'))
    assert.equal(calledMethod, 'POST')
    assert.equal(calledAuth, 'Bearer tok')
    assert.equal(result.ok, true)
    assert.equal(result.expiresInSeconds, 60)
  })

  it('reports not-running when no connection info exists', async () => {
    const result = await postPairDiscord({
      readConnectionInfo: () => null,
      fetchFn: async () => { throw new Error('should not be called') },
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not_running')
  })

  it('maps a 409 not_configured into a legible reason', async () => {
    const result = await postPairDiscord({
      readConnectionInfo: () => ({ pid: 1, httpUrl: 'http://127.0.0.1:8765', apiToken: 'tok' }),
      fetchFn: async () => mockResponse(409, { posted: false, reason: 'not_configured' }),
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not_configured')
  })

  it('maps a 502 post_failed into a legible reason', async () => {
    const result = await postPairDiscord({
      readConnectionInfo: () => ({ pid: 1, httpUrl: 'http://127.0.0.1:8765', apiToken: 'tok' }),
      fetchFn: async () => mockResponse(502, { posted: false, reason: 'post_failed' }),
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'post_failed')
  })

  it('formatPairDiscordResult renders a success line with the TTL', () => {
    const line = formatPairDiscordResult({ ok: true, expiresInSeconds: 60 })
    assert.match(line, /60s/)
    assert.match(line, /approv/i)
  })

  it('runPairDiscordCmd writes the success line and returns the result', async () => {
    const writes = []
    const result = await runPairDiscordCmd({}, {
      readConnectionInfo: () => ({ pid: 1, httpUrl: 'http://127.0.0.1:8765', apiToken: 'tok' }),
      fetchFn: async () => mockResponse(200, { posted: true, expiresInSeconds: 60 }),
      write: (s) => writes.push(s),
      writeErr: () => {},
    })
    assert.equal(result.ok, true)
    assert.ok(writes.some((w) => /60s/.test(w)))
  })

  it('runPairDiscordCmd writes a clear error when the webhook is not configured', async () => {
    const errs = []
    const result = await runPairDiscordCmd({}, {
      readConnectionInfo: () => ({ pid: 1, httpUrl: 'http://127.0.0.1:8765', apiToken: 'tok' }),
      fetchFn: async () => mockResponse(409, { posted: false, reason: 'not_configured' }),
      write: () => {},
      writeErr: (s) => errs.push(s),
    })
    assert.equal(result.ok, false)
    assert.ok(errs.some((e) => /webhook|configur/i.test(e)))
  })
})
