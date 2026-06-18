/**
 * Shared client connection RUNTIME — heartbeat, handshake timeout, and the
 * reconnect-backoff counter (#6035, follow-on to the connect-flow extraction in
 * #5556).
 *
 * The app (`packages/app/src/store/message-handler.ts`) and the dashboard
 * (`packages/dashboard/src/store/message-handler.ts`) independently maintained
 * two parallel copies of the transport-timing layer: the same
 * `startHeartbeat`/`stopHeartbeat` ping loop, the same `armHandshakeTimer`/
 * `clearHandshakeTimer` window timer, and the same `nextReconnectAttempt`/
 * `resetReconnectAttempt` backoff counter, behind the same
 * `HEARTBEAT_INTERVAL_MS`/`PONG_TIMEOUT_MS`/`HANDSHAKE_TIMEOUT_MS` constants.
 * The dashboard file header literally said it was "Ported from" the app file,
 * and #5962/#5979 (app) and #5963 (dashboard) implemented the SAME handshake
 * timeout twice "for parity". This module owns that timing machinery once.
 *
 * Mirrors the `createDeltaFlusher` / `connect-flow` template: pure,
 * dependency-free, with an injectable scheduler (defaulting to the global
 * `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`) so jest/vitest fake
 * timers work at the client call sites and store-core's own unit tests run on a
 * deterministic fake.
 *
 * ## What is shared vs. what stays at the call site
 *
 * SHARED (this module): the timer mechanics — when to ping, when to give up on a
 * pong, when the handshake window expires, and the backoff-rung counter. These
 * are byte-identical between the two clients and have no UI surface.
 *
 * INJECTED (per client, via the options): the genuinely platform-specific
 * effects —
 *   - `wsSend(socket, payload)`: each client encrypts/sends differently
 *     (the E2E envelope is per-client state).
 *   - `onPongQuality(latencyMs, quality)`: the app writes to its
 *     `useConnectionLifecycleStore`; the dashboard writes `getStore().setState`.
 *   - `rttSmoother`: the EWMA smoother instance is OWNED by the call site
 *     (the delta-flusher also reads `rttSmoother.value`), so it is passed in
 *     rather than created here — the controller folds pong RTTs into it but
 *     never owns it.
 *
 * Behavior is intentionally identical to the pre-extraction copies; this is a
 * de-dup refactor, not a behavior change.
 */

import { RttSmoother } from './delta-flush'
import { splitRtt } from './latency-stats'

// ---------------------------------------------------------------------------
// Constants (single-sourced; both clients re-export these)
// ---------------------------------------------------------------------------

/**
 * Heartbeat cadence. Exported because the app's AppState resume handler uses the
 * real heartbeat interval as its "was the app backgrounded long enough for the
 * socket to have silently died?" threshold rather than a separate magic number
 * (#5633).
 */
export const HEARTBEAT_INTERVAL_MS = 15_000

/** How long to wait for a `pong` before declaring the socket dead. */
export const PONG_TIMEOUT_MS = 5_000

/**
 * Client-side handshake timeout (#5721 / #5962 / #5963). The heartbeat does NOT
 * start until `auth_ok` is processed, so the handshake window (socket OPEN +
 * `auth`/`pair` sent, awaiting `auth_ok`/`key_exchange_ok`) has zero liveness
 * coverage: a server that opens the socket but never completes the handshake
 * leaves the client wedged until the transport drops on its own. A ~10s timer —
 * comfortably below the ~20s worst-case heartbeat detection once connected —
 * hands off to the normal reconnect ladder ("Handshake failed — reconnecting")
 * instead of a silent stall.
 */
export const HANDSHAKE_TIMEOUT_MS = 10_000

/**
 * Throttle for the dev latency readout so a streaming turn can't spam the
 * console (#5515, epic #5514). Re-exported so the delta-flush path's
 * `recordLatencySamples` shares the same window (the two paths gate on one
 * `lastLatencyLogAt` cursor at the call site).
 */
export const LATENCY_LOG_INTERVAL_MS = 3_000

// ---------------------------------------------------------------------------
// Scheduler surface (matches connect-flow's ConnectFlowScheduler, plus interval)
// ---------------------------------------------------------------------------

/**
 * Minimal timer surface the heartbeat schedules on. Defaults to the global
 * timer functions, so jest/vitest fake timers (which patch the globals) work at
 * the client call sites with no extra wiring; store-core's own unit tests inject
 * a deterministic fake instead.
 */
export interface HeartbeatScheduler {
  setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval: (handle: ReturnType<typeof setInterval>) => void
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void
}

const DEFAULT_SCHEDULER: HeartbeatScheduler = {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (handle) => clearInterval(handle),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

/**
 * The minimal WebSocket surface the heartbeat touches. Both `WebSocket` (DOM)
 * and React Native's `WebSocket` satisfy this; declared structurally so the
 * shared module pulls in neither lib.dom nor react-native types.
 */
export interface HeartbeatSocket {
  readonly readyState: number
  send(data: string): void
  close(): void
}

/** Connection-quality bucket derived from smoothed RTT. */
export type ConnectionQuality = 'good' | 'fair' | 'poor'

/**
 * Map a smoothed RTT (ms) to the quality bucket. Single-sourced so the two
 * clients can't drift their thresholds.
 */
export function rttQuality(smoothedMs: number): ConnectionQuality {
  return smoothedMs < 200 ? 'good' : smoothedMs < 500 ? 'fair' : 'poor'
}

export interface CreateHeartbeatControllerOptions<S extends HeartbeatSocket = HeartbeatSocket> {
  /**
   * Send a frame on the socket. Each client owns its encryption envelope, so
   * the send is injected rather than performed here. Typed over the client's
   * concrete socket `S` (the app/dashboard pass their real `WebSocket`), so
   * their existing `wsSend(socket: WebSocket, …)` slots in without a cast.
   */
  wsSend: (socket: S, payload: Record<string, unknown>) => void
  /**
   * The EWMA RTT smoother instance OWNED by the call site (the delta-flusher
   * also reads `rttSmoother.value`). The controller folds pong RTTs into it and
   * resets it on `stopHeartbeat`, but does not own it.
   */
  rttSmoother: RttSmoother
  /**
   * Write the measured latency + quality to the client's store. The app writes
   * `useConnectionLifecycleStore`; the dashboard writes `getStore().setState`.
   */
  onPongQuality: (latencyMs: number, quality: ConnectionQuality) => void
  /**
   * The OPEN ready-state constant for this client's WebSocket (`WebSocket.OPEN`
   * — 1 on both DOM and RN, but injected so the module never references a global
   * `WebSocket`). Defaults to 1.
   */
  openReadyState?: number
  /** `Date.now`-compatible clock; defaults to `Date.now`. Injected for tests. */
  now?: () => number
  /** Timer surface; defaults to the global timers. */
  scheduler?: HeartbeatScheduler
  /**
   * Optional dev hook called with a formatted latency-split line when a pong
   * arrives and the throttle window has elapsed. The call site owns the
   * `lastLatencyLogAt` cursor (shared with the delta-flush path) and the actual
   * `console.log`. Omit to skip the split entirely.
   */
  onLatencyLog?: (line: string, pongRecvAt: number) => void
}

/**
 * The heartbeat + handshake controller. Returned by
 * {@link createHeartbeatController}. One per store module (module-level
 * singleton at each call site, matching the pre-extraction shape).
 */
export interface HeartbeatController<S extends HeartbeatSocket = HeartbeatSocket> {
  /**
   * Start the heartbeat on `socket`: ping every {@link HEARTBEAT_INTERVAL_MS},
   * and if no pong clears the pong-timeout within {@link PONG_TIMEOUT_MS}, close
   * the dead socket. Idempotent — clears any prior heartbeat first.
   */
  startHeartbeat: (socket: S) => void
  /** Stop the heartbeat, clear the pong-timeout, and reset the RTT smoother. */
  stopHeartbeat: () => void
  /**
   * Arm the handshake-window timer; `onTimeout` fires once after
   * {@link HANDSHAKE_TIMEOUT_MS}. Clears any prior timer first (single-instance,
   * mirroring startHeartbeat) so a reconnect that re-enters onopen can never
   * leak a second pending timer.
   */
  armHandshakeTimer: (onTimeout: () => void) => void
  /** Cancel the handshake-window timer if armed. */
  clearHandshakeTimer: () => void
  /**
   * Handle an incoming `pong`: clear the pong-timeout, measure RTT, fold it into
   * the smoother, and report quality via `onPongQuality`. `serverTs` is the
   * server's optional wall-clock stamp used for the dev latency split.
   */
  handlePong: (serverTs?: number) => void
  /** Test/teardown hook: whether the heartbeat interval is currently armed. */
  readonly isHeartbeatRunning: boolean
  /** Test/teardown hook: whether the handshake timer is currently armed. */
  readonly isHandshakeArmed: boolean
}

/**
 * Build the per-store heartbeat + handshake controller. The logic is a verbatim
 * lift of the two clients' identical `startHeartbeat`/`stopHeartbeat`/
 * `armHandshakeTimer`/`clearHandshakeTimer`/`_onPong` copies, with the
 * platform-specific effects (send, quality write, dev log) injected.
 */
export function createHeartbeatController<S extends HeartbeatSocket = HeartbeatSocket>(
  options: CreateHeartbeatControllerOptions<S>,
): HeartbeatController<S> {
  const {
    wsSend,
    rttSmoother,
    onPongQuality,
    openReadyState = 1,
    now = () => Date.now(),
    scheduler = DEFAULT_SCHEDULER,
    onLatencyLog,
  } = options

  let heartbeatInterval: ReturnType<typeof setInterval> | null = null
  let pongTimeout: ReturnType<typeof setTimeout> | null = null
  let handshakeTimeout: ReturnType<typeof setTimeout> | null = null
  let lastPingSentAt = 0

  function stopHeartbeat(): void {
    if (heartbeatInterval) {
      scheduler.clearInterval(heartbeatInterval)
      heartbeatInterval = null
    }
    if (pongTimeout) {
      scheduler.clearTimeout(pongTimeout)
      pongTimeout = null
    }
    lastPingSentAt = 0
    rttSmoother.reset() // Reset smoothed RTT on disconnect
  }

  function startHeartbeat(socket: S): void {
    stopHeartbeat()
    heartbeatInterval = scheduler.setInterval(() => {
      if (socket.readyState !== openReadyState) {
        stopHeartbeat()
        return
      }
      try {
        lastPingSentAt = now()
        wsSend(socket, { type: 'ping' })
      } catch {
        stopHeartbeat()
        return
      }
      pongTimeout = scheduler.setTimeout(() => {
        console.warn('[ws] Heartbeat pong timeout — closing dead connection')
        stopHeartbeat()
        try {
          socket.close()
        } catch {
          /* close() may throw on an already-dead socket — ignore */
        }
      }, PONG_TIMEOUT_MS)
    }, HEARTBEAT_INTERVAL_MS)
  }

  function armHandshakeTimer(onTimeout: () => void): void {
    clearHandshakeTimer()
    // Null the handle when the timer FIRES (not just on clear) so isHandshakeArmed
    // reflects reality post-fire and no obsolete handle lingers (#6065 review).
    // External behavior is unchanged: onTimeout still runs once at the same time.
    handshakeTimeout = scheduler.setTimeout(() => {
      handshakeTimeout = null
      onTimeout()
    }, HANDSHAKE_TIMEOUT_MS)
  }

  function clearHandshakeTimer(): void {
    if (handshakeTimeout) {
      scheduler.clearTimeout(handshakeTimeout)
      handshakeTimeout = null
    }
  }

  function handlePong(serverTs?: number): void {
    if (pongTimeout) {
      scheduler.clearTimeout(pongTimeout)
      pongTimeout = null
    }
    // Measure RTT and update connection quality using EWMA for stability.
    if (lastPingSentAt > 0) {
      const pongRecvAt = now()
      const rttMs = pongRecvAt - lastPingSentAt
      // EWMA: smoothed = alpha * new + (1 - alpha) * prev (first sample bootstraps).
      const smoothed = Math.round(rttSmoother.update(rttMs))
      onPongQuality(smoothed, rttQuality(smoothed))

      // #5515 (epic #5514): split this RTT into approximate uplink/downlink
      // halves using the server-stamped serverTs, positioned within the
      // locally-measured [ping,pong] interval (skew-clamped). Dev-only, throttled
      // by the same window as token-to-render (the call site owns the cursor).
      if (onLatencyLog) {
        const split = splitRtt({ pingSentAt: lastPingSentAt, pongRecvAt, serverTs })
        if (split.uplinkMs !== null) {
          onLatencyLog(
            `[latency] rtt=${split.rttMs}ms split≈ up ${split.uplinkMs}ms / down ${split.downlinkMs}ms (approx, clock-skew)`,
            pongRecvAt,
          )
        }
      }
      lastPingSentAt = 0
    }
  }

  return {
    startHeartbeat,
    stopHeartbeat,
    armHandshakeTimer,
    clearHandshakeTimer,
    handlePong,
    get isHeartbeatRunning() {
      return heartbeatInterval !== null
    },
    get isHandshakeArmed() {
      return handshakeTimeout !== null
    },
  }
}

// ---------------------------------------------------------------------------
// Reconnect-backoff counter
// ---------------------------------------------------------------------------

/**
 * The consecutive close/error-path reconnect counter, used to index the
 * {@link CONNECT_RETRY_DELAYS} backoff ladder so a flapping tunnel escalates its
 * retry spacing (1s → 2s → 3s → 5s → 8s) instead of hammering the handshake at a
 * fixed delay (#5555.5 / #5594). Reset to 0 on `auth_ok` (a *successful*
 * connect — proof the link is healthy), NOT on mere socket-open, so a socket
 * that opens but never authenticates keeps climbing the ladder.
 *
 * Returned by {@link createReconnectCounter} — create ONE per store module. The
 * `next` method is the `nextRung` the shared `createReconnectScheduler` (in
 * connect-flow) consumes.
 */
export interface ReconnectCounter {
  /** Advance the backoff ladder, returning the PRE-increment attempt index. */
  next: () => number
  /** Reset the ladder — called from the `auth_ok` handler on a clean connect. */
  reset: () => void
  /** Current attempt index (read-only; the next `next()` will return this). */
  readonly attempt: number
}

/** Build a reconnect-backoff counter starting at attempt 0. */
export function createReconnectCounter(): ReconnectCounter {
  let attempt = 0
  return {
    next() {
      return attempt++
    },
    reset() {
      attempt = 0
    },
    get attempt() {
      return attempt
    },
  }
}
