/**
 * Shared client connect-flow orchestration (#5556 sub-item 4, epic #5556).
 *
 * The app (`packages/app/src/store/connection.ts`) and the dashboard
 * (`packages/dashboard/src/store/connection.ts`) hand-maintained two parallel
 * `connect()` orchestrations: same constants, same recursion, same decision
 * tree — only the *effects* (which store the phase is written to, the give-up
 * UX, the pairing/device-id wiring) legitimately differ. That left ~120
 * lockstep lines that had to be edited in two places forever (the #5594 backoff
 * ladder, #5555 restart detection, the #3624 reconnect dedup were each ported by
 * hand and drifted in their guard placement).
 *
 * This module owns the ALGORITHM — the attempt counting, the RETRY_DELAYS delay
 * ladder, the probe → restart → connect decision tree, and the per-socket
 * reconnect-schedule dedup. Each client supplies the *effects* as callbacks
 * (probe the host, open the socket, write the phase, schedule a timer, surface a
 * give-up). The clients keep their store writes + platform glue in those
 * callbacks; the orchestration stops being copy-pasted.
 *
 * Mirrors the `createDeltaFlusher` template (#5588): pure, dependency-free,
 * injectable scheduler so store-core's own tests run on a deterministic fake and
 * the client call sites work with jest/vitest fake timers (which patch the
 * globals) out of the box.
 *
 * ## Two cooperating pieces
 *
 * 1. `runConnectAttempt` — the pre-WebSocket orchestration for ONE connect
 *    attempt: probe the host, branch on the result (ok / restarting / failed),
 *    and either open the socket, schedule the next retry, or give up. Recurses
 *    through the client's `connect()` for retries (the client owns the recursion
 *    entry point so each retry re-runs its full store setup).
 *
 * 2. `createReconnectScheduler` — the per-socket close/error reconnect
 *    scheduler: a single-arm dedup flag (#3624) wrapping the shared RETRY_DELAYS
 *    backoff ladder (#5594). The client invokes it from `onclose`/`onerror`
 *    after its own platform guards.
 *
 * ## #5597 / #5537 seam — `resolveEndpoint(attempt)`
 *
 * Endpoint selection is a PER-ATTEMPT callback, not a closure-captured constant.
 * Each client's `resolveEndpoint(attempt)` re-reads the CURRENT endpoint from
 * its authoritative store every attempt (#5597): the app re-derives the tunnel
 * URL from the saved connection (so a rotated `tunnel_url_changed` push / a URL
 * persisted from a prior session is picked up on the next retry); the dashboard
 * re-reads the active registry entry's `wsUrl` + token. The app additionally
 * threads `attempt` into {@link selectReconnectEndpoint} for the #5537 LAN→tunnel
 * fast fallback (a dead `ws://` LAN host fails over to the tunnel after
 * {@link LAN_FALLBACK_THRESHOLD} attempts instead of burning the whole budget).
 */

/** Bounded initial-connect retry budget — initial attempt + this many retries. */
export const CONNECT_MAX_RETRIES = 5

/**
 * #5698 — how many post-connect reconnect rungs to climb before the ladder gives
 * up and the client shows a terminal "server appears down" state (instead of
 * spinning forever). The ladder caps its delay at the last RETRY_DELAYS rung
 * (8s), so 10 rungs (0–9) ≈ 1+2+3+5+8·6 ≈ 59s of trying before going terminal —
 * long enough to ride out a normal restart, short enough not to spin
 * indefinitely. A user-initiated reconnect resets the counter, so the cap is not
 * permanent.
 */
export const RECONNECT_MAX_RUNG = 10

/**
 * Backoff ladder (ms) for both the pre-WS health-check retries and the
 * post-connect close/error reconnects. Climbed by attempt index, capped at the
 * last rung. Shared so the app and dashboard escalate identically. (#5594)
 */
export const CONNECT_RETRY_DELAYS: readonly number[] = [1000, 2000, 3000, 5000, 8000]

/**
 * Pick the backoff delay for a given attempt/rung index, clamping past the end
 * of the ladder to the final rung. The raw (un-jittered) value — the caller
 * applies `withJitter` so tests can pin `Math.random` and assert exact delays.
 */
export function retryDelayForAttempt(
  attempt: number,
  ladder: readonly number[] = CONNECT_RETRY_DELAYS,
): number {
  const idx = Math.min(Math.max(attempt, 0), ladder.length - 1)
  // `?? 0` satisfies `noUncheckedIndexedAccess` (dashboard tsconfig); idx is
  // always in-bounds for a non-empty ladder, so the fallback is unreachable.
  return ladder[idx] ?? 0
}

// ---------------------------------------------------------------------------
// Scheduler surface (matches createDeltaFlusher's DeltaFlushScheduler)
// ---------------------------------------------------------------------------

/**
 * Minimal timer surface the flow schedules on. Defaults to the global
 * `setTimeout`/`clearTimeout`, so jest/vitest fake timers (which patch the
 * globals) work at the client call sites with no extra wiring; store-core's own
 * unit tests inject a deterministic fake instead.
 */
export interface ConnectFlowScheduler {
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void
}

const DEFAULT_SCHEDULER: ConnectFlowScheduler = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

/** Default jitter: add 0–50% of the delay (matches store-core `withJitter`). */
function defaultJitter(delayMs: number): number {
  return delayMs + Math.floor(Math.random() * delayMs * 0.5)
}

// ---------------------------------------------------------------------------
// runConnectAttempt — the pre-WebSocket health-check / restart / retry tree
// ---------------------------------------------------------------------------

/** Result of the client's host probe (the HTTP `/health` GET). */
export type ProbeResult =
  | { kind: 'ok' }
  | { kind: 'restarting'; restartEtaMs: number | null }
  | { kind: 'failed'; reason: string }
  // #6023: the supervisor exhausted its restart budget and is serving a
  // terminal `{ status: 'down', reason: 'supervisor_gave_up' }` health response
  // (#6022/#6130). The daemon is NOT coming back on its own — stop the ladder
  // immediately and latch the terminal `server_down` state, rather than spinning
  // the full retry budget against a host that has explicitly given up.
  | { kind: 'terminal_down'; reason: string }

/**
 * The endpoint to connect to for a given attempt. Returned by
 * `resolveEndpoint(attempt)` — the #5597/#5537 seam. Each client re-resolves the
 * live endpoint here per attempt (rotated tunnel URL / LAN→tunnel fallback)
 * rather than returning a closure-captured constant.
 */
export interface ConnectEndpoint {
  url: string
  token: string
}

/** How many attempts stay pinned to a dead LAN URL before the #5537 fallback
 * switches to the tunnel. Attempts `0..(LAN_FALLBACK_THRESHOLD-1)` retry LAN;
 * attempt `LAN_FALLBACK_THRESHOLD` (and beyond) switch to the tunnel. Two LAN
 * retries cover a brief wifi blip (the link came back) without burning the rest
 * of the health-check budget hammering a dead LAN URL when it didn't. */
export const LAN_FALLBACK_THRESHOLD = 2

export interface SelectReconnectEndpointInput {
  /** The URL this connect/reconnect was dialing. */
  lastUrl: string
  /** Zero-based attempt index — the app threads the inner health-check ladder's
   * `_retryCount` here (the rung that hammers the dead LAN URL). */
  attempt: number
  /** The tunnel (TLS) fallback for this connection, or null if none exists. */
  tunnelUrl: string | null
  /** True when `lastUrl` is a plaintext `ws://` LAN socket. Injected by the
   * caller (each client owns its `isLanWsUrl` predicate). */
  lastUrlIsLan: boolean
  /** Override the fallback threshold (defaults to {@link LAN_FALLBACK_THRESHOLD}). */
  threshold?: number
}

/**
 * #5537 — pick the URL to dial for a given attempt, with LAN→tunnel fast
 * fallback.
 *
 * When the connect was on a `ws://` LAN URL and a tunnel fallback exists, the
 * first `threshold` attempts stay on the LAN URL (so a momentary wifi blip
 * recovers in place), then every later attempt switches to the tunnel — instead
 * of burning the whole health-check retry budget hammering a dead LAN URL while
 * the daemon is still reachable over the tunnel.
 *
 * Pure: no store reads, no network. The caller resolves `lastUrl` / `tunnelUrl`
 * / `lastUrlIsLan` from its own authoritative state and supplies the attempt
 * index from the ladder, so this stays unit-testable and shared. Returns
 * `lastUrl` unchanged for every non-LAN case (tunnel drops, LAN-only records
 * with no tunnel) — the reverse direction (tunnel→LAN) is out of scope (#5537).
 */
export function selectReconnectEndpoint(input: SelectReconnectEndpointInput): string {
  const { lastUrl, attempt, tunnelUrl, lastUrlIsLan } = input
  const threshold = input.threshold ?? LAN_FALLBACK_THRESHOLD
  // Only LAN drops with a real tunnel fallback are eligible. A tunnel drop, or a
  // LAN-only record (no tunnel), keeps retrying the same URL.
  if (!lastUrlIsLan || !tunnelUrl) return lastUrl
  // Stay on LAN for the first `threshold` attempts; switch to the tunnel after.
  return attempt >= threshold ? tunnelUrl : lastUrl
}

export interface RunConnectAttemptOptions {
  /** Zero-based attempt index (0 = initial connect, 1.. = retries). */
  attempt: number
  /** Retry budget — initial attempt + this many retries. */
  maxRetries?: number
  /** Backoff ladder (ms). Defaults to {@link CONNECT_RETRY_DELAYS}. */
  retryDelays?: readonly number[]

  /**
   * #5597/#5537 seam — resolve the endpoint (url + token) for THIS attempt.
   * Read once at the top of the attempt; clients re-resolve the live endpoint
   * here (rotated tunnel URL / LAN→tunnel fallback) per retry. Return `null` to
   * abort the attempt silently (the caller bumped the attempt id out from under
   * us — a superseded connect).
   */
  resolveEndpoint: (attempt: number) => ConnectEndpoint | null

  /**
   * Probe the host (the HTTP `/health` GET with the 5s abort). Resolves to the
   * branch the flow should take. MUST honor the stale-attempt guard itself
   * (resolve to a value the caller ignores, or simply let `isStale()` short the
   * post-probe handling) — the flow re-checks `isStale()` after the probe.
   */
  probe: (endpoint: ConnectEndpoint) => Promise<ProbeResult>

  /**
   * True when this attempt has been superseded by a newer top-level connect
   * (the attempt-id guard). Checked after the probe and before every effect so
   * a stale attempt writes no state.
   */
  isStale: () => boolean

  /** Open the WebSocket for `endpoint` — the success path. */
  openSocket: (endpoint: ConnectEndpoint) => void

  /**
   * The host is restarting (supervisor standby). Write the `server_restarting`
   * phase + restart metadata. Called before the retry/give-up decision.
   */
  onRestarting: (info: { restartEtaMs: number | null }) => void

  /** A probe failure (not restarting). Surface the mapped error reason. */
  onProbeFailed: (reason: string) => void

  /**
   * #6023: the host served a terminal-down health signal (supervisor gave up).
   * Write the sticky `server_down` phase + the "server appears down" copy and
   * STOP — no retry is scheduled, since the daemon has explicitly given up.
   * Optional: a caller that omits it falls back to treating the signal as a
   * failed probe — it climbs the connect-retry ladder and ends at
   * `onProbeGaveUp` (terminal `disconnected`), i.e. pre-#6023 behavior. (Both
   * shipping clients wire it; the fallback exists for tests / future callers.)
   */
  onTerminalDown?: (info: { reason: string }) => void

  /**
   * Retries are exhausted because the host is still restarting. Write the
   * terminal `disconnected` phase + the "restart timed out" copy/UX.
   */
  onRestartGaveUp: () => void

  /**
   * Retries are exhausted because the host was unreachable. Write the terminal
   * `disconnected` phase + the "could not reach server" copy/UX.
   */
  onProbeGaveUp: () => void

  /**
   * Recurse into the client's own `connect()` for the next retry. The client
   * owns this so each retry re-runs its full per-connect store setup (the same
   * recursion the hand-written flow used). `attempt` is the NEXT attempt index.
   * The client's `scheduleRetry` owns the retry timer (its own `setTimeout`), so
   * the flow itself never schedules — that's why there's no `scheduler` opt
   * here (unlike {@link CreateReconnectSchedulerOptions}, which arms its own
   * timer and therefore takes one).
   */
  scheduleRetry: (nextAttempt: number, delayMs: number) => void

  /** Jitter fn; defaults to store-core's `withJitter` (0–50%). */
  jitter?: (delayMs: number) => number
}

/**
 * Run one connect attempt's pre-WebSocket orchestration: probe → branch →
 * (open socket | schedule retry | give up). The probe failure/restart branches
 * climb the same {@link CONNECT_RETRY_DELAYS} ladder by attempt index.
 *
 * This is the body that lived inline in each client's `connect()` between the
 * store setup and `_connectWebSocket()`. The client wires its effects through
 * the callbacks; the decision tree (which branch, when to retry, when to give
 * up, what delay) lives here once.
 *
 * Returns the Promise of the probe chain so callers/tests can await it.
 */
export function runConnectAttempt(options: RunConnectAttemptOptions): Promise<void> {
  const {
    attempt,
    maxRetries = CONNECT_MAX_RETRIES,
    retryDelays = CONNECT_RETRY_DELAYS,
    resolveEndpoint,
    probe,
    isStale,
    openSocket,
    onRestarting,
    onProbeFailed,
    onRestartGaveUp,
    onProbeGaveUp,
    onTerminalDown,
    scheduleRetry,
    jitter = defaultJitter,
  } = options

  const endpoint = resolveEndpoint(attempt)
  // Superseded before we even probed — the caller already moved on.
  if (endpoint === null) return Promise.resolve()

  function delayFor(rung: number): number {
    return jitter(retryDelayForAttempt(rung, retryDelays))
  }

  return probe(endpoint).then(
    (result) => {
      if (isStale()) return

      if (result.kind === 'ok') {
        openSocket(endpoint)
        return
      }

      // #6023: the supervisor gave up — terminal, no retry. Latch server_down.
      // A client that didn't wire onTerminalDown falls through to treat it like a
      // failed probe (climbs the ladder), preserving legacy behavior.
      if (result.kind === 'terminal_down') {
        if (onTerminalDown) {
          onTerminalDown({ reason: result.reason })
          return
        }
        onProbeFailed(result.reason)
        if (attempt < maxRetries) {
          scheduleRetry(attempt + 1, delayFor(attempt))
        } else {
          onProbeGaveUp()
        }
        return
      }

      if (result.kind === 'restarting') {
        onRestarting({ restartEtaMs: result.restartEtaMs })
        if (attempt < maxRetries) {
          // Restart retry historically clamped with Math.min(attempt, len-1).
          scheduleRetry(attempt + 1, delayFor(attempt))
        } else {
          onRestartGaveUp()
        }
        return
      }

      // result.kind === 'failed'
      onProbeFailed(result.reason)
      if (attempt < maxRetries) {
        scheduleRetry(attempt + 1, delayFor(attempt))
      } else {
        onProbeGaveUp()
      }
    },
    // The probe rejected outright (not resolved to a 'failed' ProbeResult). The
    // clients map this through getHealthCheckErrorMessage inside `probe` and
    // resolve to a 'failed' result, so this rejection path is a safety net only
    // — treat it as a failed probe with a generic reason.
    () => {
      if (isStale()) return
      onProbeFailed('Could not reach server')
      if (attempt < maxRetries) {
        scheduleRetry(attempt + 1, delayFor(attempt))
      } else {
        onProbeGaveUp()
      }
    },
  )
}

// ---------------------------------------------------------------------------
// createReconnectScheduler — the per-socket close/error reconnect scheduler
// ---------------------------------------------------------------------------

export interface CreateReconnectSchedulerOptions {
  /**
   * Advance the shared backoff ladder, returning the PRE-increment rung index
   * (matches `nextReconnectAttempt()`). The counter is module-level in each
   * client and resets on `auth_ok`, so a flapping link escalates. (#5594)
   */
  nextRung: () => number
  /**
   * Reconnect now — recurse into the client's `connect()`. The client resolves
   * the freshest endpoint here (#5597): the dashboard re-reads the registry
   * entry's `wsUrl` + token; the app re-derives the URL from the saved
   * connection (and the inner health-check ladder then owns the #5537 LAN→tunnel
   * fallback). Guarded by the stale-attempt check before the call.
   */
  reconnect: () => void
  /** True when this socket's attempt has been superseded — skip the reconnect. */
  isStale: () => boolean
  /** Backoff ladder (ms). Defaults to {@link CONNECT_RETRY_DELAYS}. */
  retryDelays?: readonly number[]
  /** Timer surface; defaults to the global `setTimeout`/`clearTimeout`. */
  scheduler?: ConnectFlowScheduler
  /** Jitter fn; defaults to store-core's `withJitter` (0–50%). */
  jitter?: (delayMs: number) => number
  /**
   * Maximum rung before the ladder gives up (#5698). When `nextRung()` returns a
   * value `>= maxRung`, the scheduler does NOT arm another retry — it invokes
   * `onGaveUp()` once for this socket and stops, so the client can show a
   * terminal "server appears down" state with a manual-reconnect affordance
   * instead of spinning the reconnect ladder forever. Omit (or `Infinity`) for
   * the legacy never-give-up behavior. A fresh socket from a manual `connect()`
   * gets a new scheduler with a reset counter, so giving up is not permanent.
   */
  maxRung?: number
  /**
   * Called once (per socket) when the ladder reaches `maxRung` instead of arming
   * another retry. The client transitions to its terminal `server_down` phase
   * here. Must be idempotent. No-op when `maxRung` is omitted.
   */
  onGaveUp?: () => void
}

/**
 * A per-socket reconnect scheduler. Returned by
 * {@link createReconnectScheduler} — create ONE per opened socket (the dedup
 * flag is socket-scoped, so a new socket's failure mid-reconnect still arms its
 * own timer; see #3624).
 */
export interface ReconnectScheduler {
  /**
   * Arm a reconnect if not already armed for this socket. First-arm-wins, so a
   * paired `error → close` (or `close → error`) drop schedules exactly ONE
   * retry. Advances the ladder by one rung and fires `reconnect()` after the
   * (jittered) delay, unless the attempt went stale in the meantime.
   *
   * @returns `true` if this call armed the timer, `false` if it was a dedup
   *   no-op (already armed). The client uses the return to gate its own
   *   first-write-wins phase/error writes (the app's `if (!reconnectScheduled)`
   *   branch).
   */
  schedule: () => boolean
  /** Whether a reconnect is already armed for this socket. */
  readonly scheduled: boolean
}

/**
 * Build a per-socket reconnect scheduler. The caller invokes `schedule()` from
 * `onclose`/`onerror` AFTER its own platform guards (the app guards in the
 * callers; the dashboard historically guarded inside scheduleReconnect — both
 * now guard before this call, see the PR write-up). The scheduler owns the
 * single-arm dedup + the ladder advance + the jittered delay.
 */
export function createReconnectScheduler(
  options: CreateReconnectSchedulerOptions,
): ReconnectScheduler {
  const {
    nextRung,
    reconnect,
    isStale,
    retryDelays = CONNECT_RETRY_DELAYS,
    scheduler = DEFAULT_SCHEDULER,
    jitter = defaultJitter,
    maxRung,
    onGaveUp,
  } = options

  let scheduled = false

  function schedule(): boolean {
    if (scheduled) return false
    const rung = nextRung()
    // #5698: cap the ladder. Once the rung reaches maxRung, stop arming retries
    // and hand off to the terminal handler instead of spinning forever. NOTE: no
    // timer is armed here — `scheduled = true` is purely a terminal/dedup LATCH
    // (NOT "a reconnect is pending"), so a paired close/error or any later event
    // on this dead socket short-circuits at the `if (scheduled) return` guard
    // above and `onGaveUp` fires exactly once. A manual connect() builds a fresh
    // socket + scheduler with a reset counter, so the latch is per-socket.
    if (maxRung != null && rung >= maxRung) {
      scheduled = true // terminal latch; intentionally no timer (see note above)
      if (onGaveUp) onGaveUp()
      return false
    }
    scheduled = true
    const delayMs = jitter(retryDelayForAttempt(rung, retryDelays))
    scheduler.setTimeout(() => {
      if (isStale()) return
      reconnect()
    }, delayMs)
    return true
  }

  return {
    schedule,
    get scheduled() {
      return scheduled
    },
  }
}
