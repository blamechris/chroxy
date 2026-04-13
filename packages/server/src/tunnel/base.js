import { EventEmitter } from 'events'
import { createLogger } from '../logger.js'
import { metrics } from '../metrics.js'

const log = createLogger('tunnel')

/**
 * Base class for tunnel adapters.
 *
 * Provides shared recovery logic (backoff loop, event emission, URL change
 * detection). Subclasses implement provider-specific tunnel spawning.
 *
 * Events: tunnel_lost, tunnel_recovering, tunnel_recovered,
 *         tunnel_url_changed, tunnel_failed
 */
export class BaseTunnelAdapter extends EventEmitter {
  constructor({ port, mode = 'default', config = {} }) {
    super()
    this.port = port
    this.mode = mode
    this.config = config
    this.process = null
    this.url = null
    this.intentionalShutdown = false
    this.recoveryAttempt = 0
    // Initial "fast" recovery schedule. After this many attempts we
    // emit `tunnel_recovery_exhausted_round` so the consumer can surface
    // a "having trouble" notification to the user — but we keep
    // retrying indefinitely, never give up. Pre-audit the loop bailed
    // out after maxRecoveryAttempts and the process sat port-bound
    // but unreachable forever (Skeptic, 2026-04-11 audit). The
    // supervisor restarts the child, not the tunnel.
    this.maxRecoveryAttempts = 3
    this.recoveryBackoffs = [3000, 6000, 12000]
    // Unbounded long-tail retry: after the initial round, keep trying
    // with exponential backoff capped at 60s. A tunnel outage is often
    // transient (Cloudflare rollover, flaky wifi on the user's dev
    // machine); giving up permanently is almost always worse than
    // waiting one more minute.
    this.maxRetryBackoffMs = 60_000
  }

  /** Provider name — subclass must override */
  static get name() {
    throw new Error('Subclass must implement static get name()')
  }

  /**
   * Provider capabilities — subclass must override.
   * @returns {{ modes: string[], stableUrl: boolean, binaryName: string, setupRequired: boolean, installHint: string }}
   */
  static get capabilities() {
    throw new Error('Subclass must implement static get capabilities()')
  }

  /**
   * Check if the tunnel binary is available.
   * @returns {{ available: boolean, version: string|null, hint: string|null }}
   */
  static checkBinary() {
    return { available: false, version: null, hint: null }
  }

  /**
   * Interactive setup for this tunnel provider (no-op by default).
   * @param {object} _config
   */
  static async setup(_config) {
    // No-op — subclass can override for interactive setup
  }

  /** Whether this adapter's URLs survive restarts */
  get hasStableUrl() {
    return false
  }

  /** Start the tunnel and return { httpUrl, wsUrl } */
  async start() {
    this.intentionalShutdown = false
    this.recoveryAttempt = 0
    return this._startTunnel()
  }

  /**
   * Provider-specific tunnel start — subclass must implement.
   * Must set this.process and this.url, and wire up the 'close' handler
   * to call this._handleUnexpectedExit().
   * @returns {Promise<{ httpUrl: string, wsUrl: string }>}
   */
  async _startTunnel() {
    throw new Error('Subclass must implement _startTunnel()')
  }

  /** Stop the tunnel */
  async stop() {
    this.intentionalShutdown = true
    // Cancel any in-flight recovery sleep so the loop exits immediately
    // instead of waiting up to 60s for the backoff timer to fire.
    if (this._recoveryAbort) {
      this._recoveryAbort.abort()
      this._recoveryAbort = null
    }
    if (this.process) {
      this.process.kill()
      this.process = null
      this.url = null
      log.info('Tunnel closed')
    }
  }

  /**
   * Compute the backoff delay for a given recovery attempt number.
   * First `recoveryBackoffs.length` attempts use the fast schedule
   * (3s/6s/12s). After that, exponential backoff from the last fast
   * value, capped at `maxRetryBackoffMs`.
   *
   * Exported for tests.
   */
  _backoffForAttempt(attempt1Indexed) {
    if (attempt1Indexed <= this.recoveryBackoffs.length) {
      return this.recoveryBackoffs[attempt1Indexed - 1]
    }
    // After the fast round, double each additional attempt starting
    // from the last fast value, capped at maxRetryBackoffMs.
    const extra = attempt1Indexed - this.recoveryBackoffs.length
    const lastFast = this.recoveryBackoffs[this.recoveryBackoffs.length - 1]
    const computed = lastFast * Math.pow(2, extra)
    return Math.min(computed, this.maxRetryBackoffMs)
  }

  /**
   * Handle unexpected process exit with unbounded recovery loop.
   *
   * Keeps retrying until either the tunnel comes back OR the consumer
   * explicitly calls stop(). After the initial fast round
   * (recoveryBackoffs.length attempts) we emit
   * `tunnel_recovery_exhausted_round` so the consumer can surface a
   * "having trouble" notification, but the loop continues with
   * capped exponential backoff.
   *
   * The `tunnel_failed` event is retained for backward compatibility
   * but is only emitted at the round boundary alongside
   * `tunnel_recovery_exhausted_round`. Consumers that previously
   * listened for it and did nothing (server-cli.js, supervisor.js)
   * now see a round-exhausted signal instead of a hard giveup.
   *
   * 2026-04-11 audit (Skeptic, Task #2): pre-fix gave up after
   * maxRecoveryAttempts and left the process port-bound but
   * unreachable forever. Directly contradicted the "supervisor
   * auto-restart on crash" claim in MEMORY.md — the supervisor
   * restarts the child, not the tunnel.
   */
  async _handleUnexpectedExit(code, signal) {
    if (this.intentionalShutdown) {
      log.info(`Process exited cleanly (code ${code})`)
      return
    }

    const exitReason = signal ? `signal ${signal}` : `code ${code}`
    log.warn(`Process exited unexpectedly (${exitReason})`)
    metrics.inc('tunnel.flaps')
    this.emit('tunnel_lost', { code, signal })

    const oldUrl = this.url
    let roundExhaustedEmitted = false

    while (!this.intentionalShutdown) {
      this.recoveryAttempt++
      const backoff = this._backoffForAttempt(this.recoveryAttempt)

      log.info(
        `Attempting recovery ${this.recoveryAttempt}${this.recoveryAttempt <= this.maxRecoveryAttempts ? `/${this.maxRecoveryAttempts}` : ' (long-tail)'} in ${backoff}ms...`
      )
      this.emit('tunnel_recovering', {
        attempt: this.recoveryAttempt,
        delayMs: backoff,
      })

      // Cancellable sleep — stop() aborts this so we don't hold the
      // event loop alive for up to 60s during shutdown.
      this._recoveryAbort = new AbortController()
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, backoff)
          this._recoveryAbort.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('recovery aborted'))
          }, { once: true })
        })
      } catch {
        // Aborted by stop() — exit the loop
        return
      } finally {
        this._recoveryAbort = null
      }

      if (this.intentionalShutdown) return

      try {
        const { httpUrl, wsUrl } = await this._startTunnel()
        log.info(`Recovery successful after ${this.recoveryAttempt} attempts`)
        this.emit('tunnel_recovered', {
          httpUrl,
          wsUrl,
          attempt: this.recoveryAttempt,
        })
        this.recoveryAttempt = 0

        if (oldUrl && httpUrl !== oldUrl) {
          log.info(`URL changed from ${oldUrl} to ${httpUrl}`)
          this.emit('tunnel_url_changed', {
            oldUrl,
            newUrl: httpUrl,
          })
        }

        return
      } catch (err) {
        log.error(
          `Recovery attempt ${this.recoveryAttempt} failed: ${err.message}`
        )
      }

      // Once we've blown through the initial fast round, tell any
      // consumer (server-cli, supervisor, push notifications) that
      // we're now in the long-tail retry state. Emit ONCE per round
      // so we don't spam notifications.
      if (!roundExhaustedEmitted && this.recoveryAttempt >= this.maxRecoveryAttempts) {
        roundExhaustedEmitted = true
        log.warn(
          `Tunnel recovery still failing after ${this.maxRecoveryAttempts} fast attempts; continuing with long-tail retries (capped at ${this.maxRetryBackoffMs}ms)`
        )
        this.emit('tunnel_recovery_exhausted_round', {
          attempts: this.recoveryAttempt,
          nextBackoffMs: this._backoffForAttempt(this.recoveryAttempt + 1),
          lastExitCode: code,
          lastSignal: signal,
        })
        // Back-compat shim: the pre-audit code emitted `tunnel_failed`
        // here and stopped retrying. Consumers that registered a
        // tunnel_failed listener got a single "giveup" signal. We
        // keep the event name for backward compat (server-cli.js
        // surfaces a broadcastError from it) but the loop no longer
        // gives up — it just continues in the long-tail state.
        this.emit('tunnel_failed', {
          message: `Tunnel recovery still failing after ${this.maxRecoveryAttempts} attempts (retrying with long-tail backoff)`,
          lastExitCode: code,
          lastSignal: signal,
          recoveryOngoing: true,
        })
      }
    }
  }
}
