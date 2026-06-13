/**
 * Tests for the shared connect-flow orchestration (#5556 sub-item 4).
 *
 * Ported from the app's connect() + reconnect-backoff suites so the SAME
 * orchestration coverage now runs against the shared flow once, instead of
 * being hand-maintained twice. The clients keep thin tests for their callback
 * implementations (store writes, give-up UX); the algorithm — probe → restart →
 * retry/give-up decision tree and the RETRY_DELAYS backoff ladder — is tested
 * here.
 *
 * Uses a deterministic fake scheduler (records armed callbacks, fired by hand —
 * no real time, no fake-timer global patching), mirroring the createDeltaFlusher
 * suite. Jitter is stubbed to the identity so each rung delay is exactly
 * RETRY_DELAYS[N].
 */
import { describe, it, expect, vi } from 'vitest'
import {
  runConnectAttempt,
  createReconnectScheduler,
  retryDelayForAttempt,
  selectReconnectEndpoint,
  CONNECT_MAX_RETRIES,
  CONNECT_RETRY_DELAYS,
  LAN_FALLBACK_THRESHOLD,
  type ConnectFlowScheduler,
  type ProbeResult,
  type ConnectEndpoint,
} from './connect-flow'

const RETRY_DELAYS = CONNECT_RETRY_DELAYS
/** Jitter stub — identity, so each rung delay is exactly RETRY_DELAYS[N]. */
const noJitter = (ms: number) => ms

const ENDPOINT: ConnectEndpoint = { url: 'wss://example.com', token: 'tok' }

/** Deterministic scheduler: records armed callbacks; fired by hand. */
function makeFakeScheduler() {
  const armed: { cb: () => void; ms: number }[] = []
  const scheduler: ConnectFlowScheduler = {
    setTimeout: (cb, ms) => {
      armed.push({ cb, ms })
      return armed.length as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: () => {},
  }
  return {
    scheduler,
    /** The ms of the most recently armed timer. */
    lastDelay: () => armed[armed.length - 1]?.ms,
    count: () => armed.length,
    /** Fire all armed callbacks in order (clearing the queue). */
    fireAll: () => {
      const pending = armed.splice(0)
      for (const { cb } of pending) cb()
    },
  }
}

// ---------------------------------------------------------------------------
// retryDelayForAttempt — ladder math
// ---------------------------------------------------------------------------

describe('retryDelayForAttempt', () => {
  it('returns the rung at the given index', () => {
    expect(retryDelayForAttempt(0)).toBe(1000)
    expect(retryDelayForAttempt(1)).toBe(2000)
    expect(retryDelayForAttempt(2)).toBe(3000)
    expect(retryDelayForAttempt(3)).toBe(5000)
    expect(retryDelayForAttempt(4)).toBe(8000)
  })

  it('clamps past the end of the ladder to the final rung', () => {
    expect(retryDelayForAttempt(5)).toBe(8000)
    expect(retryDelayForAttempt(99)).toBe(8000)
  })

  it('clamps a negative index to the first rung', () => {
    expect(retryDelayForAttempt(-1)).toBe(1000)
  })

  it('honors a custom ladder', () => {
    expect(retryDelayForAttempt(1, [10, 20, 30])).toBe(20)
    expect(retryDelayForAttempt(9, [10, 20, 30])).toBe(30)
  })
})

// ---------------------------------------------------------------------------
// runConnectAttempt — probe → branch decision tree
// ---------------------------------------------------------------------------

describe('runConnectAttempt — success path', () => {
  it('opens the socket on an ok probe', async () => {
    const openSocket = vi.fn()
    await runConnectAttempt({
      attempt: 0,
      resolveEndpoint: () => ENDPOINT,
      probe: async () => ({ kind: 'ok' }),
      isStale: () => false,
      openSocket,
      onRestarting: vi.fn(),
      onProbeFailed: vi.fn(),
      onRestartGaveUp: vi.fn(),
      onProbeGaveUp: vi.fn(),
      scheduleRetry: vi.fn(),
      jitter: noJitter,
    })
    expect(openSocket).toHaveBeenCalledTimes(1)
    expect(openSocket).toHaveBeenCalledWith(ENDPOINT)
  })

  it('aborts silently when resolveEndpoint returns null (superseded)', async () => {
    const probe = vi.fn()
    const openSocket = vi.fn()
    await runConnectAttempt({
      attempt: 0,
      resolveEndpoint: () => null,
      probe: probe as unknown as (e: ConnectEndpoint) => Promise<ProbeResult>,
      isStale: () => false,
      openSocket,
      onRestarting: vi.fn(),
      onProbeFailed: vi.fn(),
      onRestartGaveUp: vi.fn(),
      onProbeGaveUp: vi.fn(),
      scheduleRetry: vi.fn(),
      jitter: noJitter,
    })
    expect(probe).not.toHaveBeenCalled()
    expect(openSocket).not.toHaveBeenCalled()
  })

  it('does NOT open the socket when the attempt went stale during the probe', async () => {
    const openSocket = vi.fn()
    await runConnectAttempt({
      attempt: 0,
      resolveEndpoint: () => ENDPOINT,
      probe: async () => ({ kind: 'ok' }),
      isStale: () => true,
      openSocket,
      onRestarting: vi.fn(),
      onProbeFailed: vi.fn(),
      onRestartGaveUp: vi.fn(),
      onProbeGaveUp: vi.fn(),
      scheduleRetry: vi.fn(),
      jitter: noJitter,
    })
    expect(openSocket).not.toHaveBeenCalled()
  })
})

describe('runConnectAttempt — restarting path', () => {
  it('signals restarting and schedules the next retry on the ladder', async () => {
    const onRestarting = vi.fn()
    const scheduleRetry = vi.fn()
    await runConnectAttempt({
      attempt: 0,
      resolveEndpoint: () => ENDPOINT,
      probe: async () => ({ kind: 'restarting', restartEtaMs: 5000 }),
      isStale: () => false,
      openSocket: vi.fn(),
      onRestarting,
      onProbeFailed: vi.fn(),
      onRestartGaveUp: vi.fn(),
      onProbeGaveUp: vi.fn(),
      scheduleRetry,
      jitter: noJitter,
    })
    expect(onRestarting).toHaveBeenCalledWith({ restartEtaMs: 5000 })
    expect(scheduleRetry).toHaveBeenCalledWith(1, RETRY_DELAYS[0])
  })

  it('passes a null restartEtaMs straight through', async () => {
    const onRestarting = vi.fn()
    await runConnectAttempt({
      attempt: 2,
      resolveEndpoint: () => ENDPOINT,
      probe: async () => ({ kind: 'restarting', restartEtaMs: null }),
      isStale: () => false,
      openSocket: vi.fn(),
      onRestarting,
      onProbeFailed: vi.fn(),
      onRestartGaveUp: vi.fn(),
      onProbeGaveUp: vi.fn(),
      scheduleRetry: vi.fn(),
      jitter: noJitter,
    })
    expect(onRestarting).toHaveBeenCalledWith({ restartEtaMs: null })
  })

  it('gives up (restart timed out) once retries are exhausted', async () => {
    const onRestartGaveUp = vi.fn()
    const scheduleRetry = vi.fn()
    await runConnectAttempt({
      attempt: CONNECT_MAX_RETRIES,
      resolveEndpoint: () => ENDPOINT,
      probe: async () => ({ kind: 'restarting', restartEtaMs: null }),
      isStale: () => false,
      openSocket: vi.fn(),
      onRestarting: vi.fn(),
      onProbeFailed: vi.fn(),
      onRestartGaveUp,
      onProbeGaveUp: vi.fn(),
      scheduleRetry,
      jitter: noJitter,
    })
    expect(scheduleRetry).not.toHaveBeenCalled()
    expect(onRestartGaveUp).toHaveBeenCalledTimes(1)
  })

  it('clamps the restart-retry delay at the final rung past the ladder end', async () => {
    const scheduleRetry = vi.fn()
    // attempt 4 is < MAX_RETRIES(5), so it retries; delay clamps to RETRY_DELAYS[4].
    await runConnectAttempt({
      attempt: 4,
      resolveEndpoint: () => ENDPOINT,
      probe: async () => ({ kind: 'restarting', restartEtaMs: null }),
      isStale: () => false,
      openSocket: vi.fn(),
      onRestarting: vi.fn(),
      onProbeFailed: vi.fn(),
      onRestartGaveUp: vi.fn(),
      onProbeGaveUp: vi.fn(),
      scheduleRetry,
      jitter: noJitter,
    })
    expect(scheduleRetry).toHaveBeenCalledWith(5, RETRY_DELAYS[4])
  })
})

describe('runConnectAttempt — failed path', () => {
  it('surfaces the reason and schedules a retry below the budget', async () => {
    const onProbeFailed = vi.fn()
    const scheduleRetry = vi.fn()
    await runConnectAttempt({
      attempt: 1,
      resolveEndpoint: () => ENDPOINT,
      probe: async () => ({ kind: 'failed', reason: 'Could not reach server — check your network' }),
      isStale: () => false,
      openSocket: vi.fn(),
      onRestarting: vi.fn(),
      onProbeFailed,
      onRestartGaveUp: vi.fn(),
      onProbeGaveUp: vi.fn(),
      scheduleRetry,
      jitter: noJitter,
    })
    expect(onProbeFailed).toHaveBeenCalledWith('Could not reach server — check your network')
    expect(scheduleRetry).toHaveBeenCalledWith(2, RETRY_DELAYS[1])
  })

  it('gives up (could not reach) once retries are exhausted', async () => {
    const onProbeGaveUp = vi.fn()
    const scheduleRetry = vi.fn()
    await runConnectAttempt({
      attempt: CONNECT_MAX_RETRIES,
      resolveEndpoint: () => ENDPOINT,
      probe: async () => ({ kind: 'failed', reason: 'boom' }),
      isStale: () => false,
      openSocket: vi.fn(),
      onRestarting: vi.fn(),
      onProbeFailed: vi.fn(),
      onRestartGaveUp: vi.fn(),
      onProbeGaveUp,
      scheduleRetry,
      jitter: noJitter,
    })
    expect(scheduleRetry).not.toHaveBeenCalled()
    expect(onProbeGaveUp).toHaveBeenCalledTimes(1)
  })

  it('treats a probe REJECTION as a failed probe (safety net)', async () => {
    const onProbeFailed = vi.fn()
    const scheduleRetry = vi.fn()
    await runConnectAttempt({
      attempt: 0,
      resolveEndpoint: () => ENDPOINT,
      probe: async () => { throw new Error('unexpected') },
      isStale: () => false,
      openSocket: vi.fn(),
      onRestarting: vi.fn(),
      onProbeFailed,
      onRestartGaveUp: vi.fn(),
      onProbeGaveUp: vi.fn(),
      scheduleRetry,
      jitter: noJitter,
    })
    expect(onProbeFailed).toHaveBeenCalledTimes(1)
    expect(scheduleRetry).toHaveBeenCalledWith(1, RETRY_DELAYS[0])
  })

  it('writes nothing when the attempt went stale during a failed probe', async () => {
    const onProbeFailed = vi.fn()
    const scheduleRetry = vi.fn()
    await runConnectAttempt({
      attempt: 0,
      resolveEndpoint: () => ENDPOINT,
      probe: async () => ({ kind: 'failed', reason: 'boom' }),
      isStale: () => true,
      openSocket: vi.fn(),
      onRestarting: vi.fn(),
      onProbeFailed,
      onRestartGaveUp: vi.fn(),
      onProbeGaveUp: vi.fn(),
      scheduleRetry,
      jitter: noJitter,
    })
    expect(onProbeFailed).not.toHaveBeenCalled()
    expect(scheduleRetry).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// createReconnectScheduler — per-socket close/error reconnect (#3624 + #5594)
// ---------------------------------------------------------------------------

describe('createReconnectScheduler', () => {
  it('arms a reconnect at the next rung and fires it', () => {
    const fake = makeFakeScheduler()
    const reconnect = vi.fn()
    let rung = 0
    const s = createReconnectScheduler({
      nextRung: () => rung++,
      reconnect,
      isStale: () => false,
      scheduler: fake.scheduler,
      jitter: noJitter,
    })

    expect(s.schedule()).toBe(true)
    expect(s.scheduled).toBe(true)
    expect(fake.lastDelay()).toBe(RETRY_DELAYS[0])
    expect(reconnect).not.toHaveBeenCalled()

    fake.fireAll()
    expect(reconnect).toHaveBeenCalledTimes(1)
  })

  it('dedups a paired error → close drop (single-arm, first-arm-wins)', () => {
    const fake = makeFakeScheduler()
    let rung = 0
    const s = createReconnectScheduler({
      nextRung: () => rung++,
      reconnect: vi.fn(),
      isStale: () => false,
      scheduler: fake.scheduler,
      jitter: noJitter,
    })

    expect(s.schedule()).toBe(true)
    // Second call (the paired event) is a dedup no-op — no new timer, no rung advance.
    expect(s.schedule()).toBe(false)
    expect(fake.count()).toBe(1)
    expect(rung).toBe(1) // advanced exactly once
  })

  it('climbs the ladder across separate sockets (counter is shared, dedup is per-socket)', () => {
    const fake = makeFakeScheduler()
    let rung = 0
    const nextRung = () => rung++
    const mk = () =>
      createReconnectScheduler({
        nextRung,
        reconnect: vi.fn(),
        isStale: () => false,
        scheduler: fake.scheduler,
        jitter: noJitter,
      })

    mk().schedule()
    expect(fake.lastDelay()).toBe(RETRY_DELAYS[0])
    mk().schedule()
    expect(fake.lastDelay()).toBe(RETRY_DELAYS[1])
    mk().schedule()
    expect(fake.lastDelay()).toBe(RETRY_DELAYS[2])
  })

  it('caps at the final rung once the ladder is exhausted', () => {
    const fake = makeFakeScheduler()
    let rung = 6 // already past the ladder
    const s = createReconnectScheduler({
      nextRung: () => rung++,
      reconnect: vi.fn(),
      isStale: () => false,
      scheduler: fake.scheduler,
      jitter: noJitter,
    })
    s.schedule()
    expect(fake.lastDelay()).toBe(RETRY_DELAYS[RETRY_DELAYS.length - 1])
  })

  it('skips the reconnect when the attempt went stale before the timer fired', () => {
    const fake = makeFakeScheduler()
    const reconnect = vi.fn()
    let stale = false
    const s = createReconnectScheduler({
      nextRung: () => 0,
      reconnect,
      isStale: () => stale,
      scheduler: fake.scheduler,
      jitter: noJitter,
    })
    s.schedule()
    stale = true // superseded while the timer was pending
    fake.fireAll()
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('applies jitter to the rung delay', () => {
    const fake = makeFakeScheduler()
    const s = createReconnectScheduler({
      nextRung: () => 0,
      reconnect: vi.fn(),
      isStale: () => false,
      scheduler: fake.scheduler,
      jitter: (ms) => ms + 250,
    })
    s.schedule()
    expect(fake.lastDelay()).toBe(RETRY_DELAYS[0] + 250)
  })

  // #5698 — ladder cap: once the rung reaches maxRung the scheduler gives up
  // (terminal) instead of arming another retry forever.
  it('gives up at maxRung instead of arming a retry (#5698)', () => {
    const fake = makeFakeScheduler()
    const reconnect = vi.fn()
    const onGaveUp = vi.fn()
    let rung = 0
    const s = createReconnectScheduler({
      nextRung: () => rung++,
      reconnect,
      isStale: () => false,
      scheduler: fake.scheduler,
      jitter: noJitter,
      maxRung: 3,
      onGaveUp,
    })

    // Rungs 0,1,2 arm retries as usual.
    expect(s.schedule()).toBe(true)  // rung 0
    fake.fireAll()
    // Re-create per socket (the client builds a fresh scheduler each connect),
    // but here we reuse one and reset its arm by simulating fresh sockets:
    const mk = () => createReconnectScheduler({
      nextRung: () => rung++, reconnect, isStale: () => false,
      scheduler: fake.scheduler, jitter: noJitter, maxRung: 3, onGaveUp,
    })
    expect(mk().schedule()).toBe(true)  // rung 1
    expect(mk().schedule()).toBe(true)  // rung 2
    // rung 3 >= maxRung 3 → give up.
    expect(mk().schedule()).toBe(false)
    expect(onGaveUp).toHaveBeenCalledTimes(1)
    expect(reconnect).toHaveBeenCalledTimes(1) // only the rung-0 timer fired
  })

  it('does not re-arm or re-fire onGaveUp on a paired event after giving up (#5698)', () => {
    const fake = makeFakeScheduler()
    const onGaveUp = vi.fn()
    const s = createReconnectScheduler({
      nextRung: () => 5, // already at/over the cap
      reconnect: vi.fn(),
      isStale: () => false,
      scheduler: fake.scheduler,
      jitter: noJitter,
      maxRung: 3,
      onGaveUp,
    })
    expect(s.schedule()).toBe(false) // gave up
    expect(s.scheduled).toBe(true)   // marked so a paired event is a no-op
    expect(s.schedule()).toBe(false) // paired event: dedup no-op
    expect(onGaveUp).toHaveBeenCalledTimes(1) // fired exactly once
    expect(fake.count()).toBe(0)     // no timer ever armed
  })

  it('never gives up when maxRung is omitted (legacy behavior)', () => {
    const fake = makeFakeScheduler()
    const onGaveUp = vi.fn()
    let rung = 100 // way past any ladder
    const mk = () => createReconnectScheduler({
      nextRung: () => rung++, reconnect: vi.fn(), isStale: () => false,
      scheduler: fake.scheduler, jitter: noJitter, onGaveUp,
    })
    expect(mk().schedule()).toBe(true)
    expect(mk().schedule()).toBe(true)
    expect(onGaveUp).not.toHaveBeenCalled()
  })

})

// ---------------------------------------------------------------------------
// selectReconnectEndpoint — LAN→tunnel fast fallback (#5537)
// ---------------------------------------------------------------------------

describe('selectReconnectEndpoint (#5537 LAN→tunnel fallback)', () => {
  const LAN = 'ws://192.168.1.50:8080'
  const TUNNEL = 'wss://abc.trycloudflare.com'

  it('stays on the LAN URL for the first threshold attempts', () => {
    for (const attempt of [0, 1]) {
      expect(
        selectReconnectEndpoint({ lastUrl: LAN, attempt, tunnelUrl: TUNNEL, lastUrlIsLan: true }),
      ).toBe(LAN)
    }
  })

  it('switches to the tunnel at and beyond the threshold', () => {
    for (const attempt of [2, 3, 5, 99]) {
      expect(
        selectReconnectEndpoint({ lastUrl: LAN, attempt, tunnelUrl: TUNNEL, lastUrlIsLan: true }),
      ).toBe(TUNNEL)
    }
  })

  it('honors a custom threshold', () => {
    expect(
      selectReconnectEndpoint({ lastUrl: LAN, attempt: 0, tunnelUrl: TUNNEL, lastUrlIsLan: true, threshold: 1 }),
    ).toBe(LAN)
    expect(
      selectReconnectEndpoint({ lastUrl: LAN, attempt: 1, tunnelUrl: TUNNEL, lastUrlIsLan: true, threshold: 1 }),
    ).toBe(TUNNEL)
  })

  it('keeps retrying the LAN URL when no tunnel fallback exists', () => {
    for (const attempt of [0, 1, 2, 5]) {
      expect(
        selectReconnectEndpoint({ lastUrl: LAN, attempt, tunnelUrl: null, lastUrlIsLan: true }),
      ).toBe(LAN)
    }
  })

  it('never touches a non-LAN (tunnel) drop — out of scope (#5537)', () => {
    for (const attempt of [0, 2, 5]) {
      expect(
        selectReconnectEndpoint({ lastUrl: TUNNEL, attempt, tunnelUrl: TUNNEL, lastUrlIsLan: false }),
      ).toBe(TUNNEL)
    }
  })

  it('LAN_FALLBACK_THRESHOLD is the documented default (2)', () => {
    expect(LAN_FALLBACK_THRESHOLD).toBe(2)
    // The default (no `threshold`) matches passing the constant explicitly.
    const args = { lastUrl: LAN, tunnelUrl: TUNNEL, lastUrlIsLan: true } as const
    expect(selectReconnectEndpoint({ ...args, attempt: 1 })).toBe(LAN)
    expect(selectReconnectEndpoint({ ...args, attempt: LAN_FALLBACK_THRESHOLD })).toBe(TUNNEL)
  })
})
