import { spawn, execFileSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { BaseTunnelAdapter } from './base.js'
import { createLogger, redactSensitive } from '../logger.js'
import { cloudflaredInstallHint } from '../platform.js'
import { resolveBinary as defaultResolveBinary } from '../utils/resolve-binary.js'
import { verifyBinary as defaultVerifyBinary } from '../utils/verify-binary.js'
import { verifyProvenance as defaultVerifyProvenance, PROVENANCE_STATUS } from '../utils/verify-provenance.js'

const log = createLogger('tunnel')

// Well-known cloudflared install locations (mirrors doctor.js) so provenance can
// resolve the SAME absolute path the spawn will use even under a minimal PATH.
const CLOUDFLARED_CANDIDATES = [
  '/opt/homebrew/bin/cloudflared',
  '/usr/local/bin/cloudflared',
  join(homedir(), '.local/bin/cloudflared'),
]

/**
 * Thrown when the opt-in provenance gate (#6858) refuses to spawn `cloudflared`
 * because its pinned SHA-256 changed in place (block mode) or it failed the
 * macOS signature gate. Never thrown when the gate is off (the default).
 */
export class TunnelBinaryProvenanceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TunnelBinaryProvenanceError'
    this.code = 'TUNNEL_BINARY_PROVENANCE'
  }
}

// #5328 (WP-5.6): how much of cloudflared's recent output to retain so a
// startup failure can quote the REAL reason in its error, not just an exit code.
const CLOUDFLARED_OUTPUT_TAIL_CAP = 2000

/**
 * Redact + trim a raw cloudflared output tail for inclusion in a start-failure
 * rejection. Centralized so the named AND quick paths redact identically — a
 * token split across two `data` chunks survives a per-chunk redact, so the
 * whole accumulated tail is redacted once here (#5366 review). Returns '' when
 * the tail is empty.
 */
function redactedTail(rawTail) {
  return redactSensitive(rawTail || '').trim()
}

/**
 * Cloudflare tunnel adapter.
 *
 * Quick mode: spawns `cloudflared tunnel --url` — random URL, no account needed.
 * Named mode: spawns `cloudflared tunnel run <name>` — stable URL via DNS CNAME.
 */
export class CloudflareTunnelAdapter extends BaseTunnelAdapter {
  constructor({
    port, mode = 'quick', config = {}, tunnelName, tunnelHostname,
    // #6858 test seams — injected so the provenance gate is exercisable without a
    // real cloudflared / ledger file. Production falls through to the real ones.
    resolveBinary = defaultResolveBinary,
    verifyBinary = defaultVerifyBinary,
    verifyProvenance = defaultVerifyProvenance,
  } = {}) {
    super({ port, mode, config })
    // Support both config object keys and legacy top-level constructor args
    this.tunnelName = config.tunnelName ?? tunnelName ?? null
    this.tunnelHostname = config.tunnelHostname ?? tunnelHostname ?? null
    this._resolveBinary = resolveBinary
    this._verifyBinary = verifyBinary
    this._verifyProvenance = verifyProvenance
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
      installHint: cloudflaredInstallHint(),
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
        hint: `Install with: ${cloudflaredInstallHint()}`,
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

  /**
   * #6858: opt-in pre-spawn provenance gate for `cloudflared`. `cloudflared` is
   * spawned by bare name (resolved off PATH) with the operator's network, so it
   * shares the provider binaries' supply-chain surface — this folds it into the
   * SAME pin ledger + signature gate.
   *
   * No-op unless `config.binaryProvenance` opted in (mode warn/block or the
   * signature gate). A binary that can't be resolved is left to the normal spawn
   * ENOENT path (provenance must not mask "cloudflared not installed"). Fail-safe:
   * a block-mode hash mismatch or a failed signature gate THROWS
   * TunnelBinaryProvenanceError before any spawn; a warn-mode issue logs and
   * proceeds.
   */
  _verifyCloudflaredProvenance() {
    const prov = this.config && this.config.binaryProvenance
    const enabled = prov
      && (prov.mode === 'warn' || prov.mode === 'block' || prov.signatureGate === true)
    if (!enabled) return

    const resolved = this._resolveBinary('cloudflared', CLOUDFLARED_CANDIDATES)
    // Only gate a binary that actually resolves to a real, healthy file — a
    // missing/quarantined cloudflared is surfaced by the spawn / doctor path, not
    // here (provenance is about "is this the binary I pinned", not "does it exist").
    const health = this._verifyBinary(resolved)
    if (!health.ok) return

    const verdict = this._verifyProvenance({
      resolvedPath: health.path,
      mode: prov.mode || 'off',
      signatureGate: prov.signatureGate === true,
      ledger: prov.ledger || null,
    })
    if (verdict.blocked) {
      throw new TunnelBinaryProvenanceError(
        `Refusing to spawn cloudflared: "${verdict.path}" ${verdict.message || 'failed provenance verification'}`
        + `${verdict.remediation ? ` — ${verdict.remediation}` : ''}`,
      )
    }
    if (
      verdict.status === PROVENANCE_STATUS.HASH_MISMATCH
      || verdict.status === PROVENANCE_STATUS.SIGNATURE_INVALID
      || verdict.status === PROVENANCE_STATUS.UNREADABLE
    ) {
      log.warn(`cloudflared provenance ${verdict.status}: ${verdict.message || ''} (allowed — mode=${prov.mode})`)
    }
  }

  async _startTunnel() {
    // #6858: gate the binary before either start path spawns it.
    this._verifyCloudflaredProvenance()
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
      // Per-attempt cold-start timeout flag. Must NOT reuse the instance-wide
      // `intentionalShutdown` kill switch: a 30s cold-start timeout is exactly
      // the transient failure the `start()` retry loop exists to absorb, but
      // setting `intentionalShutdown` makes that loop give up (base.js:95) AND
      // suppresses every future recovery. Scope the suppression to this one
      // process so the retry budget and post-success recovery both survive.
      let timedOut = false

      const httpUrl = `https://${this.tunnelHostname}`
      const wsUrl = `wss://${this.tunnelHostname}`

      // #5328 (WP-5.6): retain a capped tail of cloudflared's startup output.
      // handleOutput otherwise inspects each chunk only for the success pattern
      // and discards it — so a startup failure surfaced only "exited with code
      // N" with no hint of WHY (credentials missing, tunnel not found, DNS
      // route absent). The tail is redacted at EMIT time (in the reject sites),
      // not per-chunk: a token split across two `data` events would survive a
      // per-chunk redact (neither half matches the pattern) and leak a fragment
      // into the error — so we accumulate raw and redact the whole tail once
      // (#5366 review). We stop accumulating after `resolved` so a long-lived,
      // chatty named tunnel doesn't run redaction for its whole lifetime.
      let outputTailRaw = ''
      const handleOutput = (data) => {
        if (resolved) return
        const text = data.toString()
        outputTailRaw = (outputTailRaw + text).slice(-CLOUDFLARED_OUTPUT_TAIL_CAP)
        if (/[Rr]egistered.*connection|[Cc]onnection.*registered|Serving tunnel/i.test(text)) {
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
          reject(new Error(`Failed to start cloudflared: ${err.message}. Install with: ${cloudflaredInstallHint()}`))
        }
      })

      proc.on('close', (code, signal) => {
        if (!resolved) {
          const tail = redactedTail(outputTailRaw)
          reject(new Error(`cloudflared exited with code ${code} before establishing tunnel${tail ? `. Last output: ${tail}` : ''}`))
        } else if (!timedOut) {
          // A cold-start timeout already rejected and killed the process; the
          // `start()` retry loop owns the retry decision, so don't treat that
          // kill as a mid-session outage to recover from.
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
          timedOut = true
          proc.kill()
          const tail = redactedTail(outputTailRaw)
          reject(new Error(`Tunnel timed out after 30s. Is cloudflared installed and logged in? (${cloudflaredInstallHint()})${tail ? `. Last output: ${tail}` : ''}`))
        }
      }, 30_000)
      // Don't let the 30s start-timeout timer pin the event loop on success —
      // it's only cleared on `proc.close`, but a healthy tunnel never closes.
      timeoutHandle.unref?.()

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
      // Per-attempt cold-start timeout flag — see _startNamedTunnel for why this
      // must not reuse the instance-wide `intentionalShutdown` kill switch.
      let timedOut = false
      // Retain a redacted output tail so a start failure surfaces WHY (the most
      // common failure mode), matching the named path (#5328/#5366). Accumulate
      // raw + redact the whole tail once at emit time; stop after `resolved`.
      let outputTailRaw = ''

      const handleOutput = (data) => {
        const text = data.toString()
        if (!resolved) {
          outputTailRaw = (outputTailRaw + text).slice(-CLOUDFLARED_OUTPUT_TAIL_CAP)
        }
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
        if (match && !resolved) {
          resolved = true
          this.url = match[0]
          const wsUrl = this.url.replace('https://', 'wss://')

          log.info(`Cloudflare tunnel established: HTTP=${this.url} WebSocket=${wsUrl}`)
          // #5356 (visibility layer): a quick tunnel publishes the server on a
          // public trycloudflare.com URL. Every endpoint stays bearer-token
          // gated, but anyone who learns the URL can fingerprint the server
          // via /health and attempt auth/pairing — make that visible once.
          log.warn(
            `Quick tunnel is publicly reachable at ${this.url} — endpoints are bearer-token gated, ` +
            'but anyone with this URL can fingerprint the server via /health and attempt auth. ' +
            'Use --tunnel none to disable remote access, or --tunnel named for a stable domain you control.'
          )

          resolve({ httpUrl: this.url, wsUrl })
        }
      }

      proc.stdout.on('data', handleOutput)
      proc.stderr.on('data', handleOutput)

      proc.on('error', (err) => {
        if (!resolved) {
          reject(new Error(`Failed to start cloudflared: ${err.message}. Install with: ${cloudflaredInstallHint()}`))
        }
      })

      proc.on('close', (code, signal) => {
        if (!resolved) {
          const tail = redactedTail(outputTailRaw)
          reject(new Error(`cloudflared exited with code ${code} before establishing tunnel${tail ? `. Last output: ${tail}` : ''}`))
        } else if (!timedOut) {
          // A cold-start timeout already rejected and killed the process; the
          // `start()` retry loop owns the retry decision, so don't treat that
          // kill as a mid-session outage to recover from.
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
          timedOut = true
          proc.kill()
          const tail = redactedTail(outputTailRaw)
          reject(new Error(`Tunnel timed out after 30s. Is cloudflared installed? (${cloudflaredInstallHint()})${tail ? `. Last output: ${tail}` : ''}`))
        }
      }, 30_000)
      // Don't let the 30s start-timeout timer pin the event loop on success.
      timeoutHandle.unref?.()

      proc.once('close', () => {
        clearTimeout(timeoutHandle)
      })
    })
  }
}
