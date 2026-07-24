// TunnelLifecycleHandler (#5368 slice c) — extracted from server-cli.js's
// startCliServer.
//
// Owns the Cloudflare tunnel lifecycle: create + start (with emergency cleanup
// on a start throw), wire the lifecycle events, the `tunnel_recovered` re-verify
// + QR re-render, the `waitForTunnel` routability wait (with the warming/ready
// status broadcasts and emergency cleanup on failure), the success QR display,
// and the post-display pairing-id extension (#2599).
//
// All function deps are INJECTED rather than imported: `emergencyCleanup`,
// `wireTunnelEvents`, and `buildTunnel*Status` live in server-cli.js, so
// importing them here would be circular; `createTunnel` / `waitForTunnel` are
// injected so a test can drive the start-failure path (the design's key payoff:
// "a tunnel.start() throw calls emergencyCleanup without opening a real tunnel")
// and the success path without real network. Only the pure constants are
// imported.
//
// createAndStart() returns { ok, tunnel }: on a startup failure it runs the full
// emergency cleanup and returns ok:false (the caller sets process.exitCode and
// returns — preserving startCliServer's original early-exit), and on success it
// returns the live tunnel handle for shutdown to stop.

import { QUICK_TUNNEL_DNS_SETTLE_MS } from '../tunnel-check.js'
import { TUNNEL_STATUS_MIN_PROTOCOL_VERSION } from '../ws-server.js'

export class TunnelLifecycleHandler {
  /**
   * @param {{
   *   createTunnel: Function, emergencyCleanup: Function, wireTunnelEvents: Function,
   *   waitForTunnel: Function, buildTunnelWarmingStatus: Function, buildTunnelReadyStatus: Function,
   *   config: { port: number, tunnelArg: { mode: string }, tunnelConfig?: object, tunnelName?: string|null, tunnelHostname?: string|null, binaryProvenance?: object|null },
   *   wsServer: object, startupDisplay: object, pairingManager: (object|null),
   *   cleanupRefs: { mdnsService?: object, bonjourInstance?: object, tokenManager?: object, sessionManager: object },
   *   logger: object,
   * }} deps
   */
  constructor({
    createTunnel, emergencyCleanup, wireTunnelEvents, waitForTunnel,
    buildTunnelWarmingStatus, buildTunnelReadyStatus,
    config, wsServer, startupDisplay, pairingManager, cleanupRefs, logger,
  }) {
    this._createTunnel = createTunnel
    this._emergencyCleanup = emergencyCleanup
    this._wireTunnelEvents = wireTunnelEvents
    this._waitForTunnel = waitForTunnel
    this._buildTunnelWarmingStatus = buildTunnelWarmingStatus
    this._buildTunnelReadyStatus = buildTunnelReadyStatus
    this._config = config
    this._wsServer = wsServer
    this._startupDisplay = startupDisplay
    this._pairingManager = pairingManager || null
    this._cleanupRefs = cleanupRefs || {}
    this._log = logger
  }

  // The emergency-cleanup bag — everything started so far, so a startup abort
  // leaves no orphan processes or armed timers holding the event loop alive.
  _cleanupBag(tunnel) {
    const { mdnsService, bonjourInstance, tokenManager, sessionManager } = this._cleanupRefs
    return {
      tunnel,
      wsServer: this._wsServer,
      mdnsService,
      bonjourInstance,
      tokenManager,
      pairingManager: this._pairingManager,
      sessionManager,
    }
  }

  /**
   * Build + start the tunnel, wait for it to be routable, and display the QR.
   * @returns {Promise<{ ok: boolean, tunnel?: object }>}
   */
  async createAndStart() {
    const { port, tunnelArg, tunnelConfig, tunnelName, tunnelHostname, binaryProvenance } = this._config
    const wsServer = this._wsServer
    const startupDisplay = this._startupDisplay
    const pairingManager = this._pairingManager
    const log = this._log

    // #5368c (Copilot review on #5402): modeLabel is deterministic from the
    // tunnel mode, so compute it up-front instead of after waitForTunnel (as
    // the original did). The tunnel_recovered handler references it and can fire
    // DURING the initial waitForTunnel after an early flap — with the late
    // declaration that hit a TDZ ReferenceError and silently skipped the QR
    // re-render (caught by the handler's try/catch). Same value either way; this
    // just closes the window so a recovery-during-startup actually re-renders.
    const modeLabel = `cloudflare:${tunnelArg.mode}`

    // 4. Start the tunnel
    const tunnel = this._createTunnel({
      port,
      mode: tunnelArg.mode,
      tunnelConfig,
      tunnelName: tunnelName || null,
      tunnelHostname: tunnelHostname || null,
      binaryProvenance: binaryProvenance || null,
    })
    let wsUrl, httpUrl
    try {
      ({ wsUrl, httpUrl } = await tunnel.start())
    } catch (startErr) {
      const message = `Tunnel start failed: ${startErr.message}`
      log.error(message)
      try { wsServer.broadcastError('tunnel', message, false) } catch {}
      console.error(`\n  ✗ ${message}\n`)
      await this._emergencyCleanup(this._cleanupBag(tunnel))
      return { ok: false, tunnel }
    }
    startupDisplay.currentWsUrl = wsUrl
    // #5555 (sub-item 7): seed the WsServer's current public URL so the
    // auth_bootstrap burst can carry it to (re)connecting clients.
    wsServer.setTunnelUrl(wsUrl)

    // 5. Wire up tunnel lifecycle events (before waitForTunnel to catch early failures)
    this._wireTunnelEvents(tunnel, wsServer)

    // Newest-recovery-wins guard (audit P2-11): waitForTunnel can take ~90s, so
    // a second tunnel_recovered firing during a prior re-verify would overlap —
    // two loops racing on `currentWsUrl` and double-broadcasting the rotated URL.
    // Each handler claims a generation; after its (long) await it bails if a
    // newer recovery has since superseded it.
    let recoveryGeneration = 0

    tunnel.on('tunnel_recovered', async ({ httpUrl: newHttpUrl, wsUrl: newWsUrl, attempt }) => {
      // #5314 (WP-1.4) — async event listener: waitForTunnel THROWS on a routine
      // DNS-settle failure, and an unhandled rejection here would hit server-cli's
      // unhandledRejection handler → process.exit(1), crashing the whole server on
      // a recoverable tunnel hiccup. Contain it: log and wait for the next
      // tunnel_recovered retry.
      const myGeneration = ++recoveryGeneration
      try {
        log.info(`Tunnel recovered after ${attempt} attempt(s)`)

        // Re-verify the new tunnel URL
        await this._waitForTunnel(newHttpUrl, {
          initialDelay: tunnelArg.mode === 'quick' ? QUICK_TUNNEL_DNS_SETTLE_MS : 0,
        })

        // A newer tunnel_recovered started while we were re-verifying — let it
        // own the URL/QR update so the two don't race or double-broadcast.
        if (myGeneration !== recoveryGeneration) {
          log.info(`Stale tunnel_recovered (generation ${myGeneration}, newest ${recoveryGeneration}) — superseded, skipping`)
          return
        }

        // Only display new QR code if URL actually changed
        if (newWsUrl !== startupDisplay.currentWsUrl) {
          const previousWsUrl = startupDisplay.currentWsUrl
          startupDisplay.currentWsUrl = newWsUrl
          if (pairingManager) pairingManager.refresh()
          await startupDisplay.displayQr(newWsUrl, newHttpUrl, modeLabel)
          wsServer.broadcastStatus(`Tunnel reconnected with new URL: ${newWsUrl}`)
          // #5555 (sub-item 7): push the rotated URL to every connected client
          // so their reconnect path dials the new endpoint instead of the dead
          // one. Best-effort for tunnel-connected clients (their socket rode
          // the now-dead old tunnel); LAN clients keep their socket and get it
          // immediately. Also records the URL on the WsServer so reconnecting
          // clients re-learn it via auth_bootstrap.
          wsServer.broadcastTunnelUrlChanged(newWsUrl, previousWsUrl)
        } else {
          log.info(`Tunnel URL unchanged: ${newWsUrl}`)
          wsServer.broadcastStatus('Tunnel connection recovered')
        }
      } catch (err) {
        log.error(`tunnel_recovered handler failed (will retry on next recovery): ${err?.message || err}`)
      }
    })

    // 6. Wait for tunnel to be fully routable (DNS propagation)
    // UX landmine #4: waitForTunnel now throws TUNNEL_NOT_ROUTABLE
    // instead of silently proceeding with a broken QR.
    // #2836: phase 'tunnel_warming' is the current wire name. The
    // previous name 'tunnel_verifying' is still accepted by the dashboard
    // handler for backward compatibility with in-flight clients.
    //
    // #2849: gate on protocolVersion >= 2. v1 dashboards render unknown
    // `server_status` payloads as chat messages because they only read
    // `msg.message` (falls through to the legacy plain-status branch).
    // The structured phase field is a v2 addition.
    wsServer.broadcastMinProtocolVersion(TUNNEL_STATUS_MIN_PROTOCOL_VERSION, this._buildTunnelWarmingStatus({ tunnelMode: tunnelArg.mode, tunnelUrl: httpUrl }))
    try {
      await this._waitForTunnel(httpUrl, {
        initialDelay: tunnelArg.mode === 'quick' ? QUICK_TUNNEL_DNS_SETTLE_MS : 0,
        onAttempt: (attempt, maxAttempts) => {
          wsServer.broadcastMinProtocolVersion(
            TUNNEL_STATUS_MIN_PROTOCOL_VERSION,
            this._buildTunnelWarmingStatus({
              tunnelMode: tunnelArg.mode,
              tunnelUrl: httpUrl,
              attempt,
              maxAttempts,
            }),
          )
        },
      })
    } catch (tunnelErr) {
      log.error(tunnelErr.message)
      try { wsServer.broadcastError('tunnel', tunnelErr.message, false) } catch {}
      console.error(`\n  ✗ ${tunnelErr.message}\n`)
      // Clean up everything that's been started so we don't leave
      // orphan processes or armed timers holding the event loop alive.
      await this._emergencyCleanup(this._cleanupBag(tunnel))
      return { ok: false, tunnel }
    }
    wsServer.broadcastMinProtocolVersion(TUNNEL_STATUS_MIN_PROTOCOL_VERSION, this._buildTunnelReadyStatus({ tunnelUrl: httpUrl, tunnelMode: tunnelArg.mode }))

    // 7. Generate connection info (modeLabel computed up-front; see above)
    startupDisplay.currentTunnelMode = modeLabel
    await startupDisplay.displayQr(wsUrl, httpUrl, modeLabel)

    // Extend the pairing ID validity after first QR display to give the user
    // time to scan. Without this, slow tunnel setup (60-80s) can consume most
    // of the default 60s TTL, causing rotation before the user can scan (#2599).
    if (pairingManager) pairingManager.extendCurrentId()

    return { ok: true, tunnel }
  }
}
