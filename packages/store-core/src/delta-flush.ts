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
  // Linear ramp from FLOOR (at CHEAP) to MAX (at POOR).
  const t = (ewmaRtt - DELTA_FLUSH_CHEAP_RTT_MS) / (DELTA_FLUSH_POOR_RTT_MS - DELTA_FLUSH_CHEAP_RTT_MS)
  return Math.round(DELTA_FLUSH_FLOOR_MS + t * (DELTA_FLUSH_MAX_MS - DELTA_FLUSH_FLOOR_MS))
}
