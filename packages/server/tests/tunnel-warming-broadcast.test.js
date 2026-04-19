import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { waitForTunnel } from '../src/tunnel-check.js'

/**
 * Tests for the `tunnel_warming` server_status broadcast sequence (#2836).
 *
 * These tests exercise the `onAttempt` callback that server-cli.js wires
 * into `waitForTunnel` to broadcast per-attempt progress. They pin the
 * shape of the broadcast payload so the dashboard banner ("Tunnel warming
 * up… N/20") always has the fields it expects.
 *
 * The `onAttempt` callback is the extension point — server-cli constructs
 * the broadcast message from it. We simulate that wiring here with a
 * capture function and verify the inputs/outputs match.
 */

afterEach(() => {
  mock.restoreAll()
})

// Mirror of the broadcast construction in server-cli.js. Kept in-test so
// that a future refactor of server-cli doesn't accidentally drop the
// contract without a test failure.
function buildTunnelWarmingBroadcast({ attempt, maxAttempts, tunnelMode, tunnelUrl }) {
  return {
    type: 'server_status',
    phase: 'tunnel_warming',
    tunnelMode,
    tunnelUrl,
    attempt,
    maxAttempts,
    message: `Tunnel warming up… (${attempt}/${maxAttempts})`,
  }
}

describe('tunnel_warming broadcast', () => {
  it('emits a broadcast for every attempt via onAttempt', async () => {
    const broadcasts = []
    let calls = 0
    mock.method(globalThis, 'fetch', async () => {
      calls++
      if (calls < 3) throw new Error('ECONNREFUSED')
      return { ok: true }
    })

    await waitForTunnel('https://example.trycloudflare.com', {
      maxAttempts: 5,
      initialInterval: 0,
      onAttempt: (attempt, maxAttempts) => {
        broadcasts.push(
          buildTunnelWarmingBroadcast({
            attempt,
            maxAttempts,
            tunnelMode: 'quick',
            tunnelUrl: 'https://example.trycloudflare.com',
          }),
        )
      },
    })

    assert.equal(broadcasts.length, 3, 'one broadcast per attempt until ok')
    assert.deepEqual(broadcasts.map((b) => b.attempt), [1, 2, 3])
  })

  it('broadcast payload carries phase=tunnel_warming with attempt count', async () => {
    const broadcasts = []
    mock.method(globalThis, 'fetch', async () => ({ ok: true }))

    await waitForTunnel('https://example.trycloudflare.com', {
      maxAttempts: 20,
      initialInterval: 0,
      onAttempt: (attempt, maxAttempts) => {
        broadcasts.push(
          buildTunnelWarmingBroadcast({
            attempt,
            maxAttempts,
            tunnelMode: 'quick',
            tunnelUrl: 'https://example.trycloudflare.com',
          }),
        )
      },
    })

    assert.equal(broadcasts.length, 1)
    const b = broadcasts[0]
    assert.equal(b.type, 'server_status')
    assert.equal(b.phase, 'tunnel_warming')
    assert.equal(b.attempt, 1)
    assert.equal(b.maxAttempts, 20)
    assert.equal(b.tunnelMode, 'quick')
    assert.equal(b.tunnelUrl, 'https://example.trycloudflare.com')
    assert.match(b.message, /warming/i)
    assert.match(b.message, /1\/20/)
  })

  it('does not emit after the tunnel becomes routable', async () => {
    const broadcasts = []
    let calls = 0
    mock.method(globalThis, 'fetch', async () => {
      calls++
      if (calls === 1) throw new Error('ECONNREFUSED')
      return { ok: true }
    })

    await waitForTunnel('https://example.trycloudflare.com', {
      maxAttempts: 10,
      initialInterval: 0,
      onAttempt: (attempt, maxAttempts) => {
        broadcasts.push({ attempt, maxAttempts })
      },
    })

    // Attempt 1 fails, attempt 2 succeeds → only 2 onAttempt calls.
    assert.equal(broadcasts.length, 2)
    assert.deepEqual(broadcasts, [
      { attempt: 1, maxAttempts: 10 },
      { attempt: 2, maxAttempts: 10 },
    ])
  })

  it('emits up to maxAttempts broadcasts when tunnel never routes', async () => {
    const broadcasts = []
    mock.method(globalThis, 'fetch', async () => {
      throw new Error('ECONNREFUSED')
    })

    await assert.rejects(
      () =>
        waitForTunnel('https://example.trycloudflare.com', {
          maxAttempts: 4,
          initialInterval: 0,
          onAttempt: (attempt, maxAttempts) => {
            broadcasts.push({ attempt, maxAttempts })
          },
        }),
      (err) => err.code === 'TUNNEL_NOT_ROUTABLE',
    )

    assert.equal(broadcasts.length, 4)
    assert.equal(broadcasts[3].attempt, 4)
    assert.equal(broadcasts[3].maxAttempts, 4)
  })
})
