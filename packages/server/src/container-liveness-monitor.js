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
   * @param {number} [opts.intervalMs]
   * @param {object} [opts.logger]
   */
  constructor({ enumerate, inspect, intervalMs = DEFAULT_LIVENESS_INTERVAL_MS, logger = log } = {}) {
    this._enumerate = enumerate
    this._inspect = inspect
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
        if (list) list.push(t.session)
        else byContainer.set(t.containerId, [t.session])
      }

      await Promise.all([...byContainer.entries()].map(async ([containerId, sessions]) => {
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
        for (const session of sessions) {
          try {
            if (status === 'gone') session.notifyContainerVanished?.()
            else session.clearContainerVanished?.()
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
