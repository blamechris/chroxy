import { createLogger } from './logger.js'

const log = createLogger('container-liveness')

/**
 * #7601 — how often the proactive poll inspects each live containerized session's
 * container. The reactive #7599 paths already catch a vanish that happens
 * DURING a turn (SDK query reject) or that closes a live exec child (CLI); this
 * poll is the ONLY thing that catches an IDLE session whose container was stopped
 * EXTERNALLY (a plain `docker stop`, which emits no chroxy event), and it is what
 * gives a no-long-lived-process session (docker-byok, #7600) any idle
 * detection at all. 30s balances "surface before the user's
 * next turn" against the cost of one `docker inspect` per distinct container.
 */
export const DEFAULT_LIVENESS_INTERVAL_MS = 30_000

/**
 * #7620 — describe an out-of-contract verdict for the log WITHOUT trusting it.
 *
 * The verdict comes from the very injection seam the guard below exists to
 * distrust, so a bare `JSON.stringify` is not safe: it THROWS on a circular
 * object (the raw `docker inspect` blob a mis-implemented seam is most likely to
 * forward) and on a BigInt. That throw would escape the per-target try into the
 * tick's outer catch — replacing the diagnostic that justifies warning at all
 * with a generic line, AND releasing the `_ticking` latch while other
 * containers' inspects are still in flight, so the next tick re-inspects them.
 * Total by construction: every branch returns a string and none can throw.
 */
function describeVerdict(verdict) {
  try {
    return JSON.stringify(verdict) ?? String(verdict)
  } catch {
    return `[unserialisable ${typeof verdict}]`
  }
}

/**
 * ContainerLivenessMonitor — a periodic, unref'd `docker inspect` poll over the
 * live containerized sessions, surfacing CONTAINER_VANISHED (#7599) on any whose
 * container has been stopped or removed underneath it.
 *
 * Deliberately docker-agnostic: it takes an `enumerate` fn (the live targets)
 * and an `inspect` fn (containerId → 'running' | 'gone' | 'unknown'), so the
 * SessionManager owns lifecycle without depending on a Docker backend, and the
 * daemon-down guard lives with the injected inspect (see inspectContainerLiveness).
 *
 * Batching: multiple sessions in one container environment share a containerId,
 * so the tick inspects each DISTINCT container once and fans the verdict to every
 * session bound to it. An env with no sessions contributes no target and is never
 * inspected (the #7601 negative control).
 */
export class ContainerLivenessMonitor {
  /**
   * @param {object} opts
   * @param {() => Array<{sessionId: string, containerId: string, session: object}>} opts.enumerate
   *   live containerized poll targets (session exposes notifyContainerVanished + holds a containerId)
   * @param {(containerId: string) => Promise<'running'|'gone'|'unknown'>} opts.inspect
   * @param {(target: {sessionId: string, containerId: string, session: object}) => any} [opts.onRecovered]
   *   #7602 — called once per RECOVERY EDGE (see _tick). Optional: without it the
   *   poll only clears the latch, exactly as in #7601.
   * @param {number} [opts.intervalMs]
   * @param {object} [opts.logger]
   */
  constructor({ enumerate, inspect, onRecovered = null, intervalMs = DEFAULT_LIVENESS_INTERVAL_MS, logger = log } = {}) {
    this._enumerate = enumerate
    this._inspect = inspect
    this._onRecovered = onRecovered
    this._intervalMs = intervalMs
    this._log = logger
    this._timer = null
    // Skip a tick if the prior one is still awaiting inspects (each inspect can
    // block up to the docker exec/inspect timeout), so a slow Docker daemon can't
    // stack overlapping ticks.
    this._ticking = false
  }

  /**
   * Start the poll. No-op if already running or if the required fns are missing
   * (so a deployment that never wired a Docker inspect simply never polls).
   */
  start() {
    if (this._timer) return
    if (typeof this._enumerate !== 'function' || typeof this._inspect !== 'function') return
    this._timer = setInterval(() => { this._tick() }, this._intervalMs)
    // Never keep the event loop (and thus the daemon process) alive for a poll.
    if (typeof this._timer.unref === 'function') this._timer.unref()
    this._log.info(`Container liveness poll enabled (every ${this._intervalMs}ms)`)
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  destroy() {
    this.stop()
  }

  /**
   * One poll pass. Enumerate live containerized sessions, inspect each distinct
   * container once, and surface CONTAINER_VANISHED on the sessions whose
   * container is gone (or clear the latch on the ones whose container is running
   * again). Every failure is contained: one bad inspect or one throwing session
   * must not abort the whole pass or wedge the interval.
   *
   * #7602 — the RECOVERY EDGE. `clearContainerVanished()` returns true only when
   * it actually flipped the latch, i.e. exactly on the gone→running transition of
   * a session that HAD vanished. `onRecovered` is invoked on that edge and only
   * there, which is what keeps the re-attach from re-running on every healthy
   * tick of a session that never vanished (30s apart, that would re-resolve the
   * environment binding of every idle containerized session forever). A provider
   * whose `clearContainerVanished` returns nothing — an older stub, or one that
   * predates the boolean — yields NO edge, so the failure direction is "no
   * reconnect attempted", never "reconnect attempted spuriously". #7620 holds
   * that same direction for a broken INSPECT seam: only 'running' reaches the
   * clear/recovery branch, and an unrecognised verdict no-ops like 'unknown'.
   */
  async _tick() {
    if (this._ticking) return
    this._ticking = true
    try {
      const targets = this._enumerate() || []
      if (targets.length === 0) return // negative control: nothing to poll

      // Batch by containerId: one inspect per DISTINCT container, fanned to every
      // session bound to it (env-backed sessions share a container).
      const byContainer = new Map()
      for (const t of targets) {
        if (!t || !t.containerId || !t.session) continue
        const list = byContainer.get(t.containerId)
        // #7602: the whole TARGET is carried, not just the session — the
        // recovery edge hands `sessionId` to onRecovered, which is what the
        // SessionManager needs to find the entry's `environmentId`.
        if (list) list.push(t)
        else byContainer.set(t.containerId, [t])
      }

      await Promise.all([...byContainer.entries()].map(async ([containerId, targets]) => {
        let status
        try {
          status = await this._inspect(containerId)
        } catch (err) {
          // The inspect fn owns the gone/unknown classification; a throw here is
          // unexpected. Treat it as 'unknown' — never surface a vanish on an
          // inspect that failed in a way we didn't classify.
          this._log.warn(`container-liveness inspect threw for ${String(containerId).slice(0, 12)}: ${err?.message || err}`)
          status = 'unknown'
        }
        if (status === 'unknown') return // transient (daemon down / timeout) — leave the latch as-is
        // #7620 — the fan-out is CLOSED over the three-value contract. `inspect`
        // is an INJECTION SEAM, so 'running' is tested explicitly here and every
        // unrecognised verdict degrades to the SAME no-op as 'unknown' rather
        // than falling through to the clear/recovery branch below. A broken seam
        // must fail in the "no reconnect attempted" direction, exactly as a
        // provider whose clearContainerVanished returns nothing does — not clear
        // a vanish latch and trigger a re-attach. Warned once per CONTAINER (the
        // verdict is a property of the container, not of each bound session)
        // because an unrecognised verdict means the seam itself is broken.
        if (status !== 'running' && status !== 'gone') {
          this._log.warn(`container-liveness: unrecognised verdict ${describeVerdict(status)} for ${String(containerId).slice(0, 12)} — treating as unknown`)
          return
        }
        for (const target of targets) {
          const session = target.session
          try {
            if (status === 'gone') {
              session.notifyContainerVanished?.()
              continue
            }
            // #7602: only a genuine gone→running transition is a recovery edge.
            // A throwing re-attach is contained by this loop's own catch below,
            // like every other per-session call here — it must not abort the
            // fan-out to the other sessions sharing this container.
            if (session.clearContainerVanished?.() !== true) continue
            if (this._onRecovered) await this._onRecovered(target)
          } catch (err) {
            this._log.warn(`container-liveness surface failed: ${err?.message || err}`)
          }
        }
      }))
    } catch (err) {
      this._log.warn(`container-liveness tick failed: ${err?.message || err}`)
    } finally {
      this._ticking = false
    }
  }
}
