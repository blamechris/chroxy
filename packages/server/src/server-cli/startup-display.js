// StartupDisplay (#5368 slice b) — extracted from server-cli.js's startCliServer.
//
// Owns the CLI headless-mode connection display: the QR render + manual
// connect block + `writeConnectionInfo` side-car (displayQr), the
// ephemeral-pairing-URL builder (buildPairingUrl), the current-URL/mode display
// state shared across modes (tunnel / external / LAN), and the QR re-render
// listeners that fire when the pairing id auto-refreshes or the API token
// rotates.
//
// The tunnel-lifecycle code (still inline in startCliServer; slice c) drives
// this object: it sets `currentWsUrl` / `currentTunnelMode` and calls
// `displayQr()` at each mode's success point. displayQr deliberately does NOT
// mutate the current-URL state — the call sites do, because the tunnel path
// must set `currentWsUrl` EARLY (before the first displayQr) so a
// `tunnel_recovered` event arriving mid-startup has a value to diff against.
//
// Constructor-injection seams (pairingManager / tokenManager / apiToken /
// showToken / logger) make the QR/connection-info rendering unit-testable with
// fakes + captured console output — impossible while it was a closure inside the
// god function.

import QRCode from 'qrcode'
import { writeConnectionInfo as defaultWriteConnectionInfo } from '../connection-info.js'

// #2339: small display helper, also inlined in supervisor.js + covered by
// mask-token.test.js. Moved here with displayQr (its only server-cli caller).
export function maskToken(token) {
  if (!token) return ''
  if (token.length <= 8) return token
  return `${token.slice(0, 4)}...${token.slice(-4)}`
}

export class StartupDisplay {
  /**
   * @param {{
   *   pairingManager: ({ setWsUrl: Function, currentPairingUrl: string, refresh: Function, on: Function } | null),
   *   tokenManager: ({ on: Function } | null),
   *   apiToken: string,
   *   showToken: boolean,
   *   logger: { info: Function },
   *   writeConnectionInfo?: Function,
   * }} deps
   *   `writeConnectionInfo` is an optional injection seam (defaults to the real
   *   side-car writer) so tests can capture it without touching ~/.chroxy.
   */
  constructor({ pairingManager, tokenManager, apiToken, showToken, logger, writeConnectionInfo }) {
    this._pairingManager = pairingManager || null
    this._tokenManager = tokenManager || null
    this._apiToken = apiToken
    this._showToken = !!showToken
    this._log = logger
    this._writeConnectionInfo = writeConnectionInfo || defaultWriteConnectionInfo

    // Current WebSocket URL + mode label, tracked across all modes (tunnel,
    // external, LAN). Set by the mode branches in startCliServer and read by the
    // re-render listeners below.
    this._currentWsUrl = null
    this._currentTunnelMode = 'none'
  }

  get currentWsUrl() { return this._currentWsUrl }
  set currentWsUrl(v) { this._currentWsUrl = v }
  get currentTunnelMode() { return this._currentTunnelMode }
  set currentTunnelMode(v) { this._currentTunnelMode = v }

  /**
   * Build the QR connection URL using the ephemeral pairing id (never the
   * permanent token). Returns null when pairing is disabled (no-auth).
   */
  buildPairingUrl(wsUrlStr) {
    if (!this._pairingManager) return null
    this._pairingManager.setWsUrl(wsUrlStr)
    return this._pairingManager.currentPairingUrl
  }

  /**
   * Render the QR code + manual-connect block to the console and write the
   * connection-info side-car. Pure presentation: does NOT mutate
   * currentWsUrl/currentTunnelMode (the caller sets those — see class header).
   */
  async displayQr(wsUrlStr, httpUrlStr, modeLabel) {
    const pairingUrl = this.buildPairingUrl(wsUrlStr)
    if (pairingUrl) {
      console.log(`\n[✓] Server ready! (CLI headless mode, ${modeLabel})\n`)
      console.log('📱 Scan this QR code with the Chroxy app:\n')
      const qrText = await QRCode.toString(pairingUrl, { type: 'terminal', small: true })
      process.stdout.write(qrText)
      const displayToken = this._showToken ? this._apiToken : maskToken(this._apiToken)
      console.log(`\nOr connect manually:`)
      console.log(`   URL:   ${wsUrlStr}`)
      console.log(`   Token: ${displayToken}`)
      if (httpUrlStr) {
        if (this._showToken) {
          console.log(`   Dashboard: ${httpUrlStr}/dashboard?token=${this._apiToken}`)
        } else {
          console.log(`   Dashboard: ${httpUrlStr}/dashboard (use --show-token to see full URL)`)
        }
      }
    }

    this._writeConnectionInfo({
      wsUrl: wsUrlStr,
      httpUrl: httpUrlStr,
      apiToken: this._apiToken,
      connectionUrl: pairingUrl || `chroxy://${wsUrlStr.replace(/^wss?:\/\//, '')}?token=${this._apiToken}`,
      tunnelMode: modeLabel,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    })
  }

  /**
   * Wire the QR re-render listeners: redraw the terminal QR when the pairing id
   * auto-refreshes (keeps it scannable) and when the API token rotates. Call
   * once after the mode branches have set the initial currentWsUrl.
   */
  wireReRenderListeners() {
    // Re-render QR code when pairing auto-refreshes (keeps terminal QR scannable)
    if (this._pairingManager) {
      this._pairingManager.on('pairing_refreshed', async () => {
        if (!this._currentWsUrl) return
        const httpBase = this._currentWsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
        await this.displayQr(this._currentWsUrl, httpBase, this._currentTunnelMode)
        this._log.info('QR code refreshed with new pairing ID.')
      })
    }

    // Regenerate QR code and update connection info when token rotates
    if (this._tokenManager) {
      this._tokenManager.on('token_rotated', async () => {
        if (!this._currentWsUrl) return // no-auth or localhost-only — no QR to update

        // Refresh pairing ID when token rotates (old session tokens remain valid).
        // The pairing_refreshed listener handles QR re-render; only call displayQr
        // directly when pairingManager is absent (no pairing_refreshed will fire).
        if (this._pairingManager) {
          this._pairingManager.refresh()
        } else {
          const httpBase = this._currentWsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
          await this.displayQr(this._currentWsUrl, httpBase, this._currentTunnelMode)
        }
        this._log.info('API token rotated. QR code updated.')
      })
    }
  }
}
