import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { waitForTunnel } from '../src/tunnel-check.js'
import {
  buildTunnelWarmingStatus,
  buildTunnelReadyStatus,
} from '../src/server-cli.js'

/**
 * Tests for the `tunnel_warming` server_status broadcast contract (#2836).
 *
 * Two things are asserted here:
 *
 * 1. `buildTunnelWarmingStatus` / `buildTunnelReadyStatus` — the exact
 *    same helpers server-cli.js uses at the broadcast site. Asserting
 *    them directly pins the wire shape (no duplicate local helper that
 *    could drift from production). Refactoring the broadcast call site
 *    will therefore fail these tests.
 *
 * 2. The loop semantics: `waitForTunnel` invokes `onAttempt` once per
 *    attempt until the tunnel is routable or maxAttempts is exhausted.
 *    Wiring `buildTunnelWarmingStatus` into onAttempt produces the
 *    per-attempt progress broadcasts the dashboard consumes.
 */

afterEach(() => {
  mock.restoreAll()
})

describe('buildTunnelWarmingStatus (production helper)', () => {
  it('returns the attempt-progress payload shape when counters are present', () => {
    const msg = buildTunnelWarmingStatus({
      tunnelMode: 'quick',
      tunnelUrl: 'https://example.trycloudflare.com',
      attempt: 3,
      maxAttempts: 20,
    })
    assert.equal(msg.type, 'server_status')
    assert.equal(msg.phase, 'tunnel_warming')
    assert.equal(msg.tunnelMode, 'quick')
    assert.equal(msg.tunnelUrl, 'https://example.trycloudflare.com')
    assert.equal(msg.attempt, 3)
    assert.equal(msg.maxAttempts, 20)
    assert.match(msg.message, /warming/i)
    assert.match(msg.message, /3\/20/)
  })

  it('omits attempt counters in the initial pre-poll broadcast', () => {
    const msg = buildTunnelWarmingStatus({
      tunnelMode: 'quick',
      tunnelUrl: 'https://example.trycloudflare.com',
    })
    assert.equal(msg.phase, 'tunnel_warming')
    assert.equal(msg.attempt, undefined)
    assert.equal(msg.maxAttempts, undefined)
    assert.match(msg.message, /warming/i)
    // No (N/M) suffix when there's no counter.
    assert.doesNotMatch(msg.message, /\d+\/\d+/)
  })

  it('does not leak stray fields beyond the documented contract', () => {
    const msg = buildTunnelWarmingStatus({
      tunnelMode: 'named',
      tunnelUrl: 'https://stable.example.com',
      attempt: 1,
      maxAttempts: 20,
    })
    // Whitelist the exact field set the dashboard handler & banner consume.
    const allowed = new Set([
      'type',
      'phase',
      'tunnelMode',
      'tunnelUrl',
      'attempt',
      'maxAttempts',
      'message',
    ])
    for (const key of Object.keys(msg)) {
      assert.ok(allowed.has(key), `unexpected field on broadcast: ${key}`)
    }
  })
})

describe('buildTunnelReadyStatus (production helper)', () => {
  it('produces the terminal ready payload', () => {
    const msg = buildTunnelReadyStatus({ tunnelUrl: 'https://example.trycloudflare.com' })
    assert.equal(msg.type, 'server_status')
    assert.equal(msg.phase, 'ready')
    assert.equal(msg.tunnelUrl, 'https://example.trycloudflare.com')
    assert.match(msg.message, /ready/i)
  })
})

describe('tunnel_warming broadcast sequencing via waitForTunnel.onAttempt', () => {
  it('builds one warming broadcast per attempt until the tunnel routes', async () => {
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
          buildTunnelWarmingStatus({
            tunnelMode: 'quick',
            tunnelUrl: 'https://example.trycloudflare.com',
            attempt,
            maxAttempts,
          }),
        )
      },
    })

    assert.equal(broadcasts.length, 3, 'one broadcast per attempt until ok')
    assert.deepEqual(broadcasts.map((b) => b.attempt), [1, 2, 3])
    for (const b of broadcasts) {
      assert.equal(b.type, 'server_status')
      assert.equal(b.phase, 'tunnel_warming')
    }
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
