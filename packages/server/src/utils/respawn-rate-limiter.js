// utils/respawn-rate-limiter.js (#5349) — a rolling-window cap on session
// respawns, shared by CliSession and ClaudeTuiSession.
//
// Both providers already bound CONSECUTIVE respawns via `_respawnCount` (max 5
// with backoff), but that counter resets to 0 on every warmup that survives
// (system.init / first output). So a session that dies a few seconds AFTER each
// successful warmup flaps forever — the consecutive cap never trips. This adds
// a SECOND, independent cap: at most `maxPerWindow` respawns per rolling
// `windowMs`, regardless of warmup success, so a persistently-flapping backend
// eventually gives up.
//
// Clock: `now` is injectable for tests and defaults to Date.now. Wall-clock can
// jump BACKWARD (NTP correction / VM suspend), which would break head-pruning
// (it assumes `_times` is non-decreasing). So record() clamps each timestamp to
// be >= the previous one: a backward step is treated as "no time passed", which
// keeps `_times` sorted and the prune correct, and is the conservative
// direction (it can only make the window advance slower, never falsely flag a
// healthy session).

const DEFAULT_MAX_PER_WINDOW = 10
const DEFAULT_WINDOW_MS = 5 * 60 * 1000

export class RespawnRateLimiter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxPerWindow=10] respawns allowed per window
   * @param {number} [opts.windowMs=300000] rolling window length in ms
   * @param {() => number} [opts.now=Date.now] clock source (injectable for tests)
   */
  constructor({ maxPerWindow = DEFAULT_MAX_PER_WINDOW, windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
    this.maxPerWindow = maxPerWindow
    this.windowMs = windowMs
    this._now = now
    this._times = []
  }

  /**
   * Record a respawn attempt. Returns true if still within the cap (caller may
   * proceed), false if the cap is exceeded (caller should give up).
   * @returns {boolean}
   */
  record() {
    // Clamp to be non-decreasing so a backward clock step can't leave `_times`
    // out of order (which would defeat the head-prune below and grow the array
    // unboundedly).
    const last = this._times.length ? this._times[this._times.length - 1] : -Infinity
    const t = Math.max(this._now(), last)
    this._times.push(t)
    const cutoff = t - this.windowMs
    while (this._times.length && this._times[0] < cutoff) this._times.shift()
    return this._times.length <= this.maxPerWindow
  }

  /** Number of respawns currently inside the window (after the last record). */
  get count() { return this._times.length }

  /** Forget all recorded respawns (e.g. on a clean, intentional restart). */
  reset() { this._times = [] }
}
