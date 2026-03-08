import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { waitForTunnel } from '../src/tunnel-check.js'

/**
 * waitForTunnel unit tests (#1722)
 *
 * fetch is mocked via globalThis.fetch.
 * setTimeout is NOT mocked — tests use interval:0 to avoid real delays.
 */

afterEach(() => {
  mock.restoreAll()
})

function okFetch() {
  return mock.fn(async () => ({ ok: true }))
}

function notOkFetch() {
  return mock.fn(async () => ({ ok: false }))
}

function failThenOk(failCount) {
  let calls = 0
  return mock.fn(async () => {
    calls++
    if (calls <= failCount) throw new Error('ECONNREFUSED')
    return { ok: true }
  })
}

describe('waitForTunnel', () => {
  it('resolves immediately when fetch returns ok on first attempt', async () => {
    globalThis.fetch = okFetch()
    await assert.doesNotReject(() =>
      waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 3, interval: 0 })
    )
    assert.equal(globalThis.fetch.mock.calls.length, 1)
  })

  it('retries after fetch throws and resolves when ok', async () => {
    globalThis.fetch = failThenOk(2)
    await waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 5, interval: 0 })
    assert.equal(globalThis.fetch.mock.calls.length, 3)
  })

  it('resolves (no throw) after all attempts fail', async () => {
    globalThis.fetch = mock.fn(async () => { throw new Error('Network error') })
    await assert.doesNotReject(() =>
      waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 2, interval: 0 })
    )
    assert.equal(globalThis.fetch.mock.calls.length, 2)
  })

  it('resolves (no throw) when all responses are non-ok', async () => {
    globalThis.fetch = notOkFetch()
    await assert.doesNotReject(() =>
      waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 2, interval: 0 })
    )
    assert.equal(globalThis.fetch.mock.calls.length, 2)
  })

  it('uses the provided URL in every fetch call', async () => {
    const url = 'https://my-tunnel.trycloudflare.com'
    globalThis.fetch = okFetch()
    await waitForTunnel(url, { maxAttempts: 1, interval: 0 })
    assert.equal(globalThis.fetch.mock.calls[0].arguments[0], url)
  })

  it('stops after first ok response, does not over-fetch', async () => {
    globalThis.fetch = failThenOk(1)
    await waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 10, interval: 0 })
    // Fails on attempt 1, ok on attempt 2 — should stop there
    assert.equal(globalThis.fetch.mock.calls.length, 2)
  })
})
