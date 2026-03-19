import { spawn, execFileSync } from 'child_process'
import { BaseTunnelAdapter } from './base.js'
import { createLogger } from '../logger.js'

const log = createLogger('tunnel')

/**
 * Cloudflare tunnel adapter.
 *
 * Quick mode: spawns `cloudflared tunnel --url` — random URL, no account needed.
 * Named mode: spawns `cloudflared tunnel run <name>` — stable URL via DNS CNAME.
 */
export class CloudflareTunnelAdapter extends BaseTunnelAdapter {
  constructor({ port, mode = 'quick', config = {}, tunnelName, tunnelHostname }) {
    super({ port, mode, config })
    // Support both config object keys and legacy top-level constructor args
    this.tunnelName = config.tunnelName ?? tunnelName ?? null
    this.tunnelHostname = config.tunnelHostname ?? tunnelHostname ?? null
  }

  static get name() {
    return 'cloudflare'
  }

  static get capabilities() {
    return {
      modes: ['quick', 'named'],
      stableUrl: false,
      binaryName: 'cloudflared',
      setupRequired: false,
      installHint: 'brew install cloudflared',
    }
  }

  static checkBinary() {
    try {
      const output = execFileSync('cloudflared', ['--version'], { encoding: 'utf-8', stdio: 'pipe' })
      const match = output.match(/cloudflared version (\S+)/)
      return {
        available: true,
        version: match ? match[1] : 'unknown',
        hint: null,
      }
    } catch {
      return {
        available: false,
        version: null,
        hint: 'Install with: brew install cloudflared',
      }
    }
  }

  get hasStableUrl() {
    return this.mode === 'named'
  }

  /** Override point for test injection */
  _spawnCloudflared(argv, spawnOpts) {
    return spawn('cloudflared', argv, spawnOpts)
  }

  async _startTunnel() {
    if (this.mode === 'named') {
      return this._startNamedTunnel()
    }
    return this._startQuickTunnel()
  }

  /**
   * Start a Named Tunnel. URL is known from config (no regex parsing needed).
   * Requires: cloudflared login, tunnel created, DNS route configured.
   */
  async _startNamedTunnel() {
    if (!this.tunnelName) {
      throw new Error('Named tunnel requires tunnelName config. Run: chroxy tunnel setup')
    }
    if (!this.tunnelHostname) {
      throw new Error('Named tunnel requires tunnelHostname config. Run: chroxy tunnel setup')
    }

    return new Promise((resolve, reject) => {
      const argv = [
        'tunnel', 'run',
        '--url', `http://localhost:${this.port}`,
        this.tunnelName,
      ]
      const spawnOpts = {
        stdio: ['ignore', 'pipe', 'pipe'],
      }
      const proc = this._spawnCloudflared(argv, spawnOpts)

      this.process = proc
      let resolved = false

      const httpUrl = `https://${this.tunnelHostname}`
      const wsUrl = `wss://${this.tunnelHostname}`

      const handleOutput = (data) => {
        const text = data.toString()
        if (!resolved && /[Rr]egistered.*connection|[Cc]onnection.*registered|Serving tunnel/i.test(text)) {
          resolved = true
          this.url = httpUrl

          log.info(`Named tunnel established: HTTP=${httpUrl} WebSocket=${wsUrl}`)

          resolve({ httpUrl, wsUrl })
        }
      }

      proc.stdout.on('data', handleOutput)
      proc.stderr.on('data', handleOutput)

      proc.on('error', (err) => {
        if (!resolved) {
          reject(new Error(`Failed to start cloudflared: ${err.message}. Install with: brew install cloudflared`))
        }
      })

      proc.on('close', (code, signal) => {
        if (!resolved) {
          reject(new Error(`cloudflared exited with code ${code} before establishing tunnel`))
        } else {
          void this._handleUnexpectedExit(code, signal).catch((err) => {
            log.error(`Error while handling unexpected cloudflared exit: ${err.stack || err.message || err}`)
          })
        }
        this.process = null
        // For named tunnels, keep the URL (it never changes)
        if (this.mode !== 'named') {
          this.url = null
        }
      })

      const timeoutHandle = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.intentionalShutdown = true
          proc.kill()
          reject(new Error('Tunnel timed out after 30s. Is cloudflared installed and logged in? (brew install cloudflared)'))
        }
      }, 30_000)

      proc.once('close', () => {
        clearTimeout(timeoutHandle)
      })
    })
  }

  /** Start a Quick Tunnel (random URL, no account needed) */
  async _startQuickTunnel() {
    return new Promise((resolve, reject) => {
      const argv = [
        'tunnel', '--url', `http://localhost:${this.port}`, '--no-autoupdate',
      ]
      const spawnOpts = {
        stdio: ['ignore', 'pipe', 'pipe'],
      }
      const proc = this._spawnCloudflared(argv, spawnOpts)

      this.process = proc
      let resolved = false

      const handleOutput = (data) => {
        const text = data.toString()
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
        if (match && !resolved) {
          resolved = true
          this.url = match[0]
          const wsUrl = this.url.replace('https://', 'wss://')

          log.info(`Cloudflare tunnel established: HTTP=${this.url} WebSocket=${wsUrl}`)

          resolve({ httpUrl: this.url, wsUrl })
        }
      }

      proc.stdout.on('data', handleOutput)
      proc.stderr.on('data', handleOutput)

      proc.on('error', (err) => {
        if (!resolved) {
          reject(new Error(`Failed to start cloudflared: ${err.message}. Install with: brew install cloudflared`))
        }
      })

      proc.on('close', (code, signal) => {
        if (!resolved) {
          reject(new Error(`cloudflared exited with code ${code} before establishing tunnel`))
        } else {
          void this._handleUnexpectedExit(code, signal).catch((err) => {
            log.error(`Error while handling unexpected cloudflared exit: ${err.stack || err.message || err}`)
          })
        }
        this.process = null
        this.url = null
      })

      const timeoutHandle = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.intentionalShutdown = true
          proc.kill()
          reject(new Error('Tunnel timed out after 30s. Is cloudflared installed? (brew install cloudflared)'))
        }
      }, 30_000)

      proc.once('close', () => {
        clearTimeout(timeoutHandle)
      })
    })
  }
}
