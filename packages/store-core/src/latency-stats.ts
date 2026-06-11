/**
 * Latency instrumentation primitives (#5515, epic #5514).
 *
 * Shared by the app and dashboard message handlers so both measure
 * token-to-render and RTT-split identically. No dependencies — a bounded ring
 * buffer plus a pure RTT-split function.
 *
 * Clock discipline (read before touching the math):
 *
 *   - Token-to-render is measured ENTIRELY on the client clock: we record the
 *     local recv time when a `stream_delta` arrives and the local render time
 *     after `flushPendingDeltas`. Both are the same (monotonic-ish) client
 *     clock, so the difference is a true elapsed duration. The server's
 *     wall-clock `serverTs` is NOT subtracted here — cross-machine subtraction
 *     is poisoned by clock skew.
 *
 *   - RTT split DOES use `serverTs`, but only to POSITION the split inside an
 *     interval the client measured locally ([pingSentAt, pongRecvAt]). We clamp
 *     serverTs into that window, so even an arbitrarily skewed server clock can
 *     only move the uplink/downlink boundary between 0 and the full RTT — it can
 *     never produce a negative half or one larger than the (locally measured,
 *     skew-free) RTT. The halves are therefore best-effort estimates, documented
 *     as approximate, derived from the RTT-split method rather than raw clock
 *     subtraction (which the #5414 monotonic-clock work made us careful about).
 */

/** A bounded ring buffer that yields p50/p95 over the last `capacity` samples. */
export class RollingPercentiles {
  private readonly buf: number[]
  private readonly capacity: number
  private head = 0
  private size = 0

  constructor(capacity = 200) {
    this.capacity = Math.max(1, Math.floor(capacity))
    this.buf = new Array(this.capacity)
  }

  /** Number of samples currently retained (≤ capacity). */
  get count(): number {
    return this.size
  }

  /** Record a sample. Non-finite or negative values are ignored. */
  add(sample: number): void {
    if (!Number.isFinite(sample) || sample < 0) return
    this.buf[this.head] = sample
    this.head = (this.head + 1) % this.capacity
    if (this.size < this.capacity) this.size++
  }

  /**
   * p50/p95 over the retained window via nearest-rank on a sorted copy.
   * Returns `null` percentiles when empty. O(n log n) per call — only invoked
   * from a throttled readout, never the hot path.
   */
  summary(): { count: number; p50: number | null; p95: number | null } {
    if (this.size === 0) return { count: 0, p50: null, p95: null }
    const sorted = this.buf.slice(0, this.size).sort((a, b) => a - b)
    const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
    return { count: this.size, p50: pick(0.5), p95: pick(0.95) }
  }
}

export interface RttSplitInput {
  /** Local clock ms when the client sent the ping. */
  pingSentAt: number
  /** Local clock ms when the client received the pong. */
  pongRecvAt: number
  /** Server wall-clock ms stamped on the pong (`serverTs`), if present. */
  serverTs: number | undefined
}

export interface RttSplit {
  /** Round-trip time, measured purely on the local clock (skew-free). */
  rttMs: number
  /** Estimated uplink (ping→server). `null` when serverTs is absent/RTT≤0. */
  uplinkMs: number | null
  /** Estimated downlink (server→pong). `null` when serverTs is absent/RTT≤0. */
  downlinkMs: number | null
}

/**
 * Split a ping/pong RTT into approximate uplink/downlink halves using the
 * server-stamped `serverTs` to position the split. See the clock-discipline
 * note at the top of the file: the RTT itself is locally measured (skew-free);
 * serverTs only positions the boundary and is clamped into the local window so
 * skew can never produce a nonsensical half.
 */
export function splitRtt(input: RttSplitInput): RttSplit {
  const rttMs = input.pongRecvAt - input.pingSentAt
  if (!(rttMs > 0) || typeof input.serverTs !== 'number' || !Number.isFinite(input.serverTs)) {
    return { rttMs: Math.max(0, rttMs), uplinkMs: null, downlinkMs: null }
  }
  // Position serverTs within [pingSentAt, pongRecvAt], clamped for skew safety.
  const clamped = Math.min(input.pongRecvAt, Math.max(input.pingSentAt, input.serverTs))
  const uplinkMs = clamped - input.pingSentAt
  const downlinkMs = rttMs - uplinkMs
  return { rttMs, uplinkMs, downlinkMs }
}
