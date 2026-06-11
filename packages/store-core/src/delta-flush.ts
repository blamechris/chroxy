/**
 * Adaptive client-side delta-flush interval (#5516, epic #5514).
 *
 * The client batches incoming `stream_delta` tokens and flushes them to the
 * store (the render trigger) on a timer. Before #5516 that timer was a fixed
 * 100ms — which, stacked on the server's 50ms coalescing window, added up to
 * ~150ms of token-batching latency even on a LAN where RTT is single-digit ms.
 *
 * Now the interval ADAPTS to the smoothed (EWMA) round-trip time:
 *
 *   - Good link (low RTT): flush fast — there's no transport latency to hide
 *     behind, so a tight interval makes streaming feel live. We floor at 16ms
 *     ("one frame") on a clearly-cheap link and 33ms ("two frames") otherwise.
 *   - Poor link (high RTT): the transport already dominates perceived latency,
 *     so flushing faster just burns CPU re-rendering for no felt benefit. We
 *     scale back toward the old 100ms so big batches amortize the render cost.
 *
 * The memoization landed first (step 1 of #5516) so a faster flush only
 * re-renders the tail bubble — without it, a 16ms flush would re-parse the
 * whole transcript 60×/sec.
 *
 * Pure + dependency-free so the app and dashboard share identical behavior and
 * it's trivially unit-testable. Both call sites keep a constant override (the
 * raw setTimeout(..., N) is replaced by setTimeout(..., resolveDeltaFlushMs())
 * with the override threaded through) so tests can pin the interval.
 */

/** Tightest flush on a clearly-cheap (low-RTT) link — one 60fps frame. */
export const DELTA_FLUSH_MIN_MS = 16
/** Default floor when RTT is unknown or merely "good" — two frames. */
export const DELTA_FLUSH_FLOOR_MS = 33
/** Ceiling — the legacy fixed interval, used when the link is poor. */
export const DELTA_FLUSH_MAX_MS = 100

/** At/below this EWMA RTT the link is "cheap": flush at DELTA_FLUSH_MIN_MS. */
export const DELTA_FLUSH_CHEAP_RTT_MS = 60
/** At/above this EWMA RTT the link is "poor": flush at DELTA_FLUSH_MAX_MS. */
export const DELTA_FLUSH_POOR_RTT_MS = 400

/**
 * Resolve the delta-flush interval (ms) for the current smoothed RTT.
 *
 * @param ewmaRtt - EWMA-smoothed round-trip time in ms, or null when no
 *   ping/pong has completed yet (treated as "good but unknown" → floor).
 * @returns flush interval in ms, in [DELTA_FLUSH_MIN_MS, DELTA_FLUSH_MAX_MS].
 *
 * Shape:
 *   - rtt <= CHEAP            → MIN (16ms)
 *   - CHEAP < rtt < POOR      → linear ramp FLOOR (33ms) → MAX (100ms)
 *   - rtt >= POOR             → MAX (100ms)
 *   - rtt null / non-finite   → FLOOR (33ms)
 */
export function resolveDeltaFlushMs(ewmaRtt: number | null | undefined): number {
  if (ewmaRtt == null || !Number.isFinite(ewmaRtt)) return DELTA_FLUSH_FLOOR_MS
  if (ewmaRtt <= DELTA_FLUSH_CHEAP_RTT_MS) return DELTA_FLUSH_MIN_MS
  if (ewmaRtt >= DELTA_FLUSH_POOR_RTT_MS) return DELTA_FLUSH_MAX_MS
  // Linear ramp toward MAX across the open band (CHEAP, POOR): rising just
  // above CHEAP starts at FLOOR and climbs to MAX as RTT approaches POOR. (At
  // exactly CHEAP the earlier branch already returned MIN, so the ramp's lower
  // endpoint is approached from above, not hit.)
  const t = (ewmaRtt - DELTA_FLUSH_CHEAP_RTT_MS) / (DELTA_FLUSH_POOR_RTT_MS - DELTA_FLUSH_CHEAP_RTT_MS)
  return Math.round(DELTA_FLUSH_FLOOR_MS + t * (DELTA_FLUSH_MAX_MS - DELTA_FLUSH_FLOOR_MS))
}

/** Default EWMA weight for a new RTT sample (higher = more responsive). */
export const DEFAULT_RTT_EWMA_ALPHA = 0.3

/**
 * Stateful EWMA (exponentially-weighted moving average) smoother for round-trip
 * time. Extracted from the app/dashboard heartbeat handlers (#5556, epic #5514)
 * so both clients share one implementation instead of hand-copied accumulators.
 *
 * Behavior (bit-for-bit identical to the prior inlined copies):
 *   - The first sample bootstraps the average to its raw value.
 *   - Each later sample folds in as `α·rtt + (1-α)·prev`.
 *   - `value` is `null` until the first sample, matching the
 *     `ewmaRtt: number | null` field both clients fed into
 *     `resolveDeltaFlushMs` (null → flush floor).
 *   - `reset()` returns to the un-sampled (`null`) state — the clients call
 *     this on disconnect (in `stopHeartbeat`), so a reconnect re-bootstraps.
 */
export class RttSmoother {
  private _value: number | null = null
  private readonly _alpha: number

  /**
   * @param alpha - EWMA weight for new samples in (0, 1]. Defaults to
   *   {@link DEFAULT_RTT_EWMA_ALPHA} (0.3).
   */
  constructor(alpha: number = DEFAULT_RTT_EWMA_ALPHA) {
    this._alpha = alpha
  }

  /** The current smoothed RTT in ms, or `null` if no sample has arrived yet. */
  get value(): number | null {
    return this._value
  }

  /**
   * Fold a new RTT measurement into the average and return the updated value.
   * The first call initializes the average to `rttMs` exactly.
   */
  update(rttMs: number): number {
    this._value =
      this._value === null ? rttMs : this._alpha * rttMs + (1 - this._alpha) * this._value
    return this._value
  }

  /** Clear the average back to the un-sampled (`null`) state. */
  reset(): void {
    this._value = null
  }
}

// ---------------------------------------------------------------------------
// Delta flusher (#5556, epic #5514)
//
// Both clients hand-copied the WIRING around the already-shared pure math
// (`resolveDeltaFlushMs` above): a `pendingDeltas` accumulator Map, a single
// coalescing-window `setTimeout`, an override hook for tests, and the
// schedule / flush-now / clear / dispose idioms. Only the inner store mutation
// (the "apply this batch to the store" body) legitimately differs between the
// app (session-only) and the dashboard (session + flat-`messages` fallback).
//
// `createDeltaFlusher` OWNS the accumulator + timer + override; each client
// supplies just `getEwmaRtt` (so the window resolves off its own RttSmoother)
// and `applyDeltas` (its store mutation). Disconnect/teardown that used to call
// the client's `clearDeltaBuffers` now goes through the flusher's `clear()`;
// forced pre-state-change flushes (stream_end / result / permission split) go
// through `flushNow()`.
// ---------------------------------------------------------------------------

// One accumulated delta is `{ sessionId, delta }` — the same shape the
// stream-delta hot path writes. Reuse the canonical `PendingDelta` from the
// handlers barrel rather than redeclaring it, so the accumulator value type is
// shared with `sharedStreamDelta` (#5556).
import type { PendingDelta } from './handlers'
export type { PendingDelta }

/**
 * Minimal timer surface the flusher schedules on. Defaults to the global
 * `setTimeout`/`clearTimeout`, so jest/vitest fake timers (which patch the
 * globals) work at the client call sites with no extra wiring; store-core's
 * own unit tests inject a deterministic fake instead.
 */
export interface DeltaFlushScheduler {
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void
}

export interface CreateDeltaFlusherOptions {
  /**
   * Returns the current EWMA-smoothed RTT (ms), or `null` when no ping/pong has
   * completed yet. Fed into {@link resolveDeltaFlushMs} to size the coalescing
   * window. Read lazily on each schedule so the interval tracks live RTT.
   */
  getEwmaRtt: () => number | null
  /**
   * Apply one coalesced batch to the store. Receives a SNAPSHOT of the
   * accumulator (already detached and cleared on the flusher's side), so the
   * client is free to iterate it without racing further appends. This is the
   * only platform-specific piece — the app writes session state only, the
   * dashboard also has a flat-`messages` fallback. Any post-flush bookkeeping
   * the client needs (e.g. latency sampling keyed off `updates.keys()`) belongs
   * inside this closure.
   */
  applyDeltas: (updates: Map<string, PendingDelta>) => void
  /** Timer surface; defaults to the global `setTimeout`/`clearTimeout`. */
  scheduler?: DeltaFlushScheduler
}

/**
 * A scheduled, coalescing delta flusher. Returned by {@link createDeltaFlusher}.
 *
 * The `pendingDeltas` Map is exposed (not private) because the shared
 * `sharedStreamDelta` hot path writes directly into the client's accumulator;
 * the client passes `flusher.pendingDeltas` straight through to it, then calls
 * `flusher.schedule()` from its `scheduleFlush` hook.
 */
export interface DeltaFlusher {
  /** The live accumulator. Mutated in place by the stream-delta hot path. */
  readonly pendingDeltas: Map<string, PendingDelta>
  /**
   * Arm the coalescing-window timer if it isn't already armed. The window is
   * the override (when `setIntervalOverride(ms)` is set), else
   * `resolveDeltaFlushMs(getEwmaRtt())`. A no-op while a flush is already
   * pending — first-arm-wins, so a burst of deltas shares one window.
   */
  schedule: () => void
  /**
   * Cancel any pending timer and flush the accumulator immediately (synchronous
   * `applyDeltas`). Safe to call with an empty accumulator (no-op apply). Used
   * before any state change that must observe the fully-applied transcript
   * (stream_end, result, permission boundary split).
   */
  flushNow: () => void
  /**
   * Cancel any pending timer and DROP the accumulator without applying it.
   * This is the teardown path (disconnect) — the buffered deltas belong to a
   * connection that's going away.
   */
  clear: () => void
  /**
   * Pin the coalescing window to a constant (tests), or `null` to restore the
   * adaptive `resolveDeltaFlushMs` behavior.
   */
  setIntervalOverride: (ms: number | null) => void
  /** Resolve the window the next `schedule()` would use, in ms (for tests). */
  currentIntervalMs: () => number
  /** Tear down: cancel the timer and drop the accumulator. Alias of `clear()`. */
  dispose: () => void
}

const DEFAULT_SCHEDULER: DeltaFlushScheduler = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

/**
 * Build a delta flusher that owns the accumulator + coalescing timer, leaving
 * the client only its store-mutation closure. See the block comment above and
 * {@link CreateDeltaFlusherOptions}.
 */
export function createDeltaFlusher(options: CreateDeltaFlusherOptions): DeltaFlusher {
  const { getEwmaRtt, applyDeltas, scheduler = DEFAULT_SCHEDULER } = options

  const pendingDeltas = new Map<string, PendingDelta>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let overrideMs: number | null = null

  function currentIntervalMs(): number {
    return overrideMs != null ? overrideMs : resolveDeltaFlushMs(getEwmaRtt())
  }

  /** Snapshot + clear the accumulator, then apply. Shared by both flush paths. */
  function drain(): void {
    if (pendingDeltas.size === 0) return
    const updates = new Map(pendingDeltas)
    pendingDeltas.clear()
    applyDeltas(updates)
  }

  function flushNow(): void {
    if (timer != null) {
      scheduler.clearTimeout(timer)
      timer = null
    }
    drain()
  }

  function schedule(): void {
    if (timer != null) return
    timer = scheduler.setTimeout(() => {
      // The timer reference is consumed; null it BEFORE applying so a
      // re-entrant schedule() from within applyDeltas re-arms cleanly.
      timer = null
      drain()
    }, currentIntervalMs())
  }

  function clear(): void {
    if (timer != null) {
      scheduler.clearTimeout(timer)
      timer = null
    }
    pendingDeltas.clear()
  }

  function setIntervalOverride(ms: number | null): void {
    overrideMs = ms
  }

  return {
    pendingDeltas,
    schedule,
    flushNow,
    clear,
    setIntervalOverride,
    currentIntervalMs,
    dispose: clear,
  }
}
