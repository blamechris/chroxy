import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { waitForTunnel } from '../src/tunnel-check.js'

/**
 * waitForTunnel unit tests (#1722)
 *
 * fetch is mocked via mock.method(globalThis, 'fetch', impl) so that
 * mock.restoreAll() correctly reinstates the original implementation.
 * setTimeout is NOT mocked — tests use interval:0 to avoid real delays.
 */

afterEach(() => {
  mock.restoreAll()
})

describe('waitForTunnel', () => {
  it('resolves immediately when fetch returns ok on first attempt', async () => {
    mock.method(globalThis, 'fetch', async () => ({ ok: true }))
    await assert.doesNotReject(() =>
      waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 3, interval: 0 })
    )
    assert.equal(globalThis.fetch.mock.calls.length, 1)
  })

  it('retries after fetch throws and resolves when ok', async () => {
    let calls = 0
    mock.method(globalThis, 'fetch', async () => {
      calls++
      if (calls <= 2) throw new Error('ECONNREFUSED')
      return { ok: true }
    })
    await waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 5, interval: 0 })
    assert.equal(globalThis.fetch.mock.calls.length, 3)
  })

  it('resolves (no throw) after all attempts fail', async () => {
    mock.method(globalThis, 'fetch', async () => { throw new Error('Network error') })
    await assert.doesNotReject(() =>
      waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 2, interval: 0 })
    )
    assert.equal(globalThis.fetch.mock.calls.length, 2)
  })

  it('resolves (no throw) when all responses are non-ok', async () => {
    mock.method(globalThis, 'fetch', async () => ({ ok: false }))
    await assert.doesNotReject(() =>
      waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 2, interval: 0 })
    )
    assert.equal(globalThis.fetch.mock.calls.length, 2)
  })

  it('uses the provided URL in every fetch call', async () => {
    const url = 'https://my-tunnel.trycloudflare.com'
    mock.method(globalThis, 'fetch', async () => ({ ok: true }))
    await waitForTunnel(url, { maxAttempts: 1, interval: 0 })
    assert.equal(globalThis.fetch.mock.calls[0].arguments[0], url)
  })

  it('stops after first ok response, does not over-fetch', async () => {
    let calls = 0
    mock.method(globalThis, 'fetch', async () => {
      calls++
      if (calls <= 1) throw new Error('ECONNREFUSED')
      return { ok: true }
    })
    await waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 10, interval: 0 })
    // Fails on attempt 1, ok on attempt 2 — should stop there
    assert.equal(globalThis.fetch.mock.calls.length, 2)
  })
})
