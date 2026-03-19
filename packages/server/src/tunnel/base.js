import { EventEmitter } from 'events'
import { createLogger } from '../logger.js'

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
    this.maxRecoveryAttempts = 3
    this.recoveryBackoffs = [3000, 6000, 12000]
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
    if (this.process) {
      this.process.kill()
      this.process = null
      this.url = null
      log.info('Tunnel closed')
    }
  }

  /**
   * Handle unexpected process exit with recovery loop.
   * Called by subclass close handlers when the tunnel process exits unexpectedly.
   */
  async _handleUnexpectedExit(code, signal) {
    if (this.intentionalShutdown) {
      log.info(`Process exited cleanly (code ${code})`)
      return
    }

    const exitReason = signal ? `signal ${signal}` : `code ${code}`
    log.warn(`Process exited unexpectedly (${exitReason})`)
    this.emit('tunnel_lost', { code, signal })

    const oldUrl = this.url

    while (this.recoveryAttempt < this.maxRecoveryAttempts && !this.intentionalShutdown) {
      const backoff = this.recoveryBackoffs[this.recoveryAttempt]
      this.recoveryAttempt++

      log.info(
        `Attempting recovery ${this.recoveryAttempt}/${this.maxRecoveryAttempts} in ${backoff}ms...`
      )
      this.emit('tunnel_recovering', {
        attempt: this.recoveryAttempt,
        delayMs: backoff,
      })

      await new Promise((r) => setTimeout(r, backoff))

      if (this.intentionalShutdown) return

      try {
        const { httpUrl, wsUrl } = await this._startTunnel()
        log.info('Recovery successful')
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
    }

    if (!this.intentionalShutdown && this.recoveryAttempt >= this.maxRecoveryAttempts) {
      log.error(
        `Recovery failed after ${this.maxRecoveryAttempts} attempts`
      )
      this.emit('tunnel_failed', {
        message: `Tunnel recovery failed after ${this.maxRecoveryAttempts} attempts`,
        lastExitCode: code,
        lastSignal: signal,
      })
    }
  }
}
