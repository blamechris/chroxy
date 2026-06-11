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
