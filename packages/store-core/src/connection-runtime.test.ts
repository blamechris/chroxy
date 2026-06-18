/**
 * #6035 — unit tests for the shared connection runtime (heartbeat + handshake
 * timeout + reconnect-backoff counter) lifted from the app/dashboard
 * message-handlers. Uses vitest fake timers; the controller's default scheduler
 * is the global timers, so fake timers drive it without any injection (matching
 * how the client call sites run under jest/vitest fake timers).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  createHeartbeatController,
  createReconnectCounter,
  rttQuality,
  HEARTBEAT_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  type HeartbeatSocket,
} from './connection-runtime'
import { RttSmoother } from './delta-flush'

class FakeSocket implements HeartbeatSocket {
  readyState = 1 // OPEN
  sent: Array<Record<string, unknown>> = []
  closed = 0
  sendThrows = false
  send(data: string): void {
    if (this.sendThrows) throw new Error('send failed')
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.closed += 1
    this.readyState = 3 // CLOSED
  }
}

function makeController(overrides: Partial<Parameters<typeof createHeartbeatController>[0]> = {}) {
  const socket = new FakeSocket()
  const smoother = new RttSmoother()
  const quality: Array<{ latencyMs: number; quality: string }> = []
  const wsSend = vi.fn((s: HeartbeatSocket, payload: Record<string, unknown>) => {
    s.send(JSON.stringify(payload))
  })
  const controller = createHeartbeatController({
    wsSend,
    rttSmoother: smoother,
    onPongQuality: (latencyMs, q) => quality.push({ latencyMs, quality: q }),
    ...overrides,
  })
  return { controller, socket, smoother, quality, wsSend }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('createHeartbeatController — heartbeat', () => {
  it('sends a ping every HEARTBEAT_INTERVAL_MS while the socket is OPEN', () => {
    const { controller, socket, wsSend } = makeController()
    controller.startHeartbeat(socket)
    expect(controller.isHeartbeatRunning).toBe(true)

    expect(wsSend).not.toHaveBeenCalled() // nothing before the first interval
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    expect(wsSend).toHaveBeenCalledTimes(1)
    expect(socket.sent[0]).toEqual({ type: 'ping' })

    // Answer the ping so the pong-timeout reaper doesn't close the socket before
    // the next interval, then the second ping fires.
    controller.handlePong()
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    expect(wsSend).toHaveBeenCalledTimes(2)
  })

  it('closes the socket if no pong clears the pong-timeout within PONG_TIMEOUT_MS', () => {
    const { controller, socket } = makeController()
    controller.startHeartbeat(socket)
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS) // ping sent, pong-timeout armed
    expect(socket.closed).toBe(0)

    vi.advanceTimersByTime(PONG_TIMEOUT_MS) // pong never arrived
    expect(socket.closed).toBe(1)
    expect(controller.isHeartbeatRunning).toBe(false) // stopped on reap
  })

  it('does NOT close the socket when a pong arrives before the timeout', () => {
    const { controller, socket } = makeController()
    controller.startHeartbeat(socket)
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS) // ping + pong-timeout armed
    controller.handlePong() // pong clears the timeout
    vi.advanceTimersByTime(PONG_TIMEOUT_MS + 1_000)
    expect(socket.closed).toBe(0)
    expect(controller.isHeartbeatRunning).toBe(true)
  })

  it('stops itself (no ping, no close) when the socket is no longer OPEN', () => {
    const { controller, socket, wsSend } = makeController()
    controller.startHeartbeat(socket)
    socket.readyState = 3 // CLOSED out from under the heartbeat
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    expect(wsSend).not.toHaveBeenCalled()
    expect(socket.closed).toBe(0)
    expect(controller.isHeartbeatRunning).toBe(false)
  })

  it('stops itself if wsSend throws', () => {
    const { controller, socket } = makeController()
    socket.sendThrows = true
    controller.startHeartbeat(socket)
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    expect(controller.isHeartbeatRunning).toBe(false)
  })

  it('startHeartbeat is idempotent — a second call replaces the first interval', () => {
    const { controller, socket, wsSend } = makeController()
    controller.startHeartbeat(socket)
    controller.startHeartbeat(socket) // clears + re-arms
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    expect(wsSend).toHaveBeenCalledTimes(1) // exactly one interval, not two
  })

  it('stopHeartbeat clears the interval, the pong-timeout, and resets the smoother', () => {
    const { controller, socket, smoother } = makeController()
    controller.startHeartbeat(socket)
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS) // pong-timeout armed
    controller.handlePong() // seed the smoother

    controller.stopHeartbeat()
    expect(controller.isHeartbeatRunning).toBe(false)
    expect(smoother.value).toBeNull() // reset

    // No ping or close after stop, even past both windows.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS + PONG_TIMEOUT_MS)
    expect(socket.closed).toBe(0)
  })
})

describe('createHeartbeatController — handlePong / quality', () => {
  it('measures RTT into the smoother and reports a quality bucket', () => {
    let t = 0
    const { controller, socket, quality, smoother } = makeController({ now: () => t })
    controller.startHeartbeat(socket)
    t = 1_000
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS) // ping sent at t=1000
    t = 1_050 // pong 50ms later
    controller.handlePong()
    expect(smoother.value).toBe(50)
    expect(quality).toEqual([{ latencyMs: 50, quality: 'good' }])
  })

  it('does nothing on a pong with no outstanding ping', () => {
    const { controller, quality, smoother } = makeController()
    controller.handlePong() // lastPingSentAt is 0
    expect(quality).toEqual([])
    expect(smoother.value).toBeNull()
  })

  it('emits a throttled latency-split line when serverTs is present', () => {
    let t = 0
    const lines: string[] = []
    const { controller, socket } = makeController({
      now: () => t,
      onLatencyLog: (line) => lines.push(line),
    })
    controller.startHeartbeat(socket)
    t = 1_000
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS) // ping at t=1000
    t = 1_100
    controller.handlePong(1_040) // serverTs mid-interval → split available
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[latency] rtt=100ms')
  })

  it('omits the latency split when serverTs is absent', () => {
    let t = 0
    const lines: string[] = []
    const { controller, socket } = makeController({
      now: () => t,
      onLatencyLog: (line) => lines.push(line),
    })
    controller.startHeartbeat(socket)
    t = 1_000
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    t = 1_100
    controller.handlePong() // no serverTs
    expect(lines).toHaveLength(0)
  })
})

describe('createHeartbeatController — handshake timer', () => {
  it('fires onTimeout exactly once after HANDSHAKE_TIMEOUT_MS', () => {
    const { controller } = makeController()
    const onTimeout = vi.fn()
    controller.armHandshakeTimer(onTimeout)
    expect(controller.isHandshakeArmed).toBe(true)

    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS - 1)
    expect(onTimeout).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    // After firing, the timer is no longer armed and holds no stale handle
    // (#6065 review).
    expect(controller.isHandshakeArmed).toBe(false)

    // No second fire ever.
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS * 2)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('clearHandshakeTimer cancels a pending timer — it never fires', () => {
    const { controller } = makeController()
    const onTimeout = vi.fn()
    controller.armHandshakeTimer(onTimeout)
    controller.clearHandshakeTimer()
    expect(controller.isHandshakeArmed).toBe(false)
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS * 2)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('re-arming clears the prior timer (no double fire from a reconnect re-entering onopen)', () => {
    const { controller } = makeController()
    const first = vi.fn()
    const second = vi.fn()
    controller.armHandshakeTimer(first)
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS / 2)
    controller.armHandshakeTimer(second) // replaces `first`
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('clearHandshakeTimer is a no-op when nothing is armed', () => {
    const { controller } = makeController()
    expect(() => controller.clearHandshakeTimer()).not.toThrow()
    expect(controller.isHandshakeArmed).toBe(false)
  })
})

describe('rttQuality', () => {
  it('buckets by smoothed RTT', () => {
    expect(rttQuality(0)).toBe('good')
    expect(rttQuality(199)).toBe('good')
    expect(rttQuality(200)).toBe('fair')
    expect(rttQuality(499)).toBe('fair')
    expect(rttQuality(500)).toBe('poor')
    expect(rttQuality(5_000)).toBe('poor')
  })
})

describe('createReconnectCounter', () => {
  it('advances the backoff ladder, returning the pre-increment index', () => {
    const counter = createReconnectCounter()
    expect(counter.attempt).toBe(0)
    expect(counter.next()).toBe(0)
    expect(counter.next()).toBe(1)
    expect(counter.next()).toBe(2)
    expect(counter.attempt).toBe(3)
  })

  it('reset returns the ladder to 0', () => {
    const counter = createReconnectCounter()
    counter.next()
    counter.next()
    expect(counter.attempt).toBe(2)
    counter.reset()
    expect(counter.attempt).toBe(0)
    expect(counter.next()).toBe(0)
  })
})
