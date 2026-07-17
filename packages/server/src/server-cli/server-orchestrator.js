// ServerOrchestrator (#5368 slice d) — extracted from server-cli.js's
// startCliServer.
//
// Owns the process lifecycle: the `shuttingDown` latch, the graceful
// `shutdown(signal)` teardown sequence, and the SIGINT / SIGTERM / SIGHUP /
// uncaughtException / unhandledRejection registrations (the last two via the
// #5369 `onFatal` factory that calls `emergencyCleanupSync`). This is the
// silent-failure-prone surface — a missed teardown step orphans processes / hangs
// exit, and a broken crash handler suppresses Node's default crash-exit — so the
// sequence is moved verbatim.
//
// Two injection details matter:
//   - `getWorktreeReapTimer` is a GETTER, not a value: the timer is assigned
//     inside an async `import().then()` in startCliServer, so it may still be
//     null when this orchestrator is constructed. The original shutdown closure
//     read it at shutdown time — reproduce that with a lazy getter so a
//     late-resolved timer still gets cleared.
//   - `emergencyCleanupSync` is injected because it lives in server-cli.js
//     (importing it here would be circular). `exit` / `exitDelayMs` are injected
//     so tests can drive shutdown + onFatal without killing the test process.

import { removeConnectionInfo as defaultRemoveConnectionInfo } from '../connection-info.js'
import { getSharedPool as defaultGetSharedPool, isPoolEnabled as defaultIsPoolEnabled } from '../docker-byok-pool.js'

export class ServerOrchestrator {
  constructor({
    wsServer,
    sessionManager,
    tunnel,
    mdnsService,
    bonjourInstance,
    tokenManager,
    pairingManager,
    pushManager = null,
    billingCanaryMonitor = null,
    orchestrationManager = null,
    modelsOverlayWatcher = null,
    getWorktreeReapTimer,
    emergencyCleanupSync,
    removeConnectionInfo = defaultRemoveConnectionInfo,
    isPoolEnabled = defaultIsPoolEnabled,
    getSharedPool = defaultGetSharedPool,
    logger,
    exit = (code) => process.exit(code),
    exitDelayMs = 100,
  }) {
    this._wsServer = wsServer
    this._sessionManager = sessionManager
    this._tunnel = tunnel
    this._mdnsService = mdnsService
    this._bonjourInstance = bonjourInstance
    this._tokenManager = tokenManager
    this._pairingManager = pairingManager
    this._pushManager = pushManager
    this._billingCanaryMonitor = billingCanaryMonitor
    // #6691 (E-4): the orchestration engine (null when the feature is off).
    // Disposed on shutdown: unhooks its SessionManager listeners (permission
    // gate + turn driver) and flushes the run ledger's pending snapshot writes.
    this._orchestrationManager = orchestrationManager
    // #5932: the models.json overlay fs-watcher handle (or null when watching
    // couldn't be established). Closed on shutdown so the watch doesn't outlive
    // the daemon.
    this._modelsOverlayWatcher = modelsOverlayWatcher || null
    this._getWorktreeReapTimer = typeof getWorktreeReapTimer === 'function' ? getWorktreeReapTimer : () => null
    this._emergencyCleanupSync = emergencyCleanupSync
    this._removeConnectionInfo = removeConnectionInfo
    this._isPoolEnabled = isPoolEnabled
    this._getSharedPool = getSharedPool
    this._log = logger
    this._exit = exit
    this._exitDelayMs = exitDelayMs

    // Idempotent: a second SIGINT/SIGTERM (or a crash arriving mid-shutdown)
    // returns immediately. Without this, the second call ran serializeState()
    // against an already-empty `_sessions` Map and wrote 0 sessions to disk,
    // erasing the user's restored state across upgrade/quit cycles (#3697).
    this._shuttingDown = false
  }

  async shutdown(signal) {
    const log = this._log
    if (this._shuttingDown) {
      log.info(`[${signal}] Shutdown already in progress, ignoring duplicate signal`)
      return
    }
    this._shuttingDown = true
    log.info(`[${signal}] Shutting down...`)
    // Notify connected clients (ETA 0 = not coming back unless supervised)
    this._wsServer.broadcastShutdown('shutdown', 0)
    if (this._mdnsService) {
      try { this._mdnsService.stop?.() } catch {}
    }
    if (this._bonjourInstance) {
      try { this._bonjourInstance.destroy?.() } catch {}
    }
    if (this._tokenManager) this._tokenManager.destroy()
    if (this._pairingManager) this._pairingManager.destroy()
    // #5413: stop the Discord sink's heartbeat. It's unref'd so it wouldn't
    // block exit, but clearing it avoids a refresh PATCH racing shutdown.
    if (this._pushManager) {
      try { this._pushManager.destroy?.() } catch {}
    }
    // #5326 (WP-5.4): stop the periodic worktree reaper. It's unref'd so it
    // wouldn't block exit, but clearing it avoids a sweep racing shutdown.
    const worktreeReapTimer = this._getWorktreeReapTimer()
    if (worktreeReapTimer) clearInterval(worktreeReapTimer)
    // #5932: stop watching ~/.chroxy/models.json so the fs-watch doesn't outlive
    // the daemon. Best-effort — close() never throws but guard anyway.
    if (this._modelsOverlayWatcher) {
      try { this._modelsOverlayWatcher.close?.() } catch {}
    }
    // #5821: stop the billing-canary recompute timer. It's unref'd so it
    // wouldn't block exit, but clearing it avoids a recompute racing shutdown.
    if (this._billingCanaryMonitor) {
      try { this._billingCanaryMonitor.stop() } catch {}
    }
    // #6691 (E-4): tear down the orchestration engine BEFORE destroying the
    // sessions it may own — dispose unhooks its listeners and flushes the run
    // ledger, so the subsequent destroyAll can't race a debounced snapshot write.
    if (this._orchestrationManager) {
      try { this._orchestrationManager.dispose() } catch (err) {
        log.warn(`Orchestration engine dispose failed: ${err?.message || err}`)
      }
    }
    // Persist sessions before destroying (enables restore on restart)
    try { this._sessionManager.serializeState() } catch (err) {
      log.error(`Failed to serialize session state: ${err?.message || err}`)
    }
    this._sessionManager.destroyAll()
    // #5042: drain the docker-byok across-session pool so the `sleep
    // infinity` containers it holds don't outlive the server. Default-OFF
    // (`isPoolEnabled` returns false unless `CHROXY_DOCKER_BYOK_POOL=1`),
    // so this is a no-op for the common path. When the flag is on, the
    // pool's `docker rm -f` calls run in parallel and we let them settle
    // before `process.exit(0)` strands them.
    if (this._isPoolEnabled(process.env)) {
      try {
        const pool = this._getSharedPool(process.env)
        if (pool) await pool.shutdown()
      } catch (err) {
        log.error(`Failed to drain docker-byok pool: ${err?.message || err}`)
      }
    }
    this._wsServer.close()
    if (this._tunnel) await this._tunnel.stop()
    this._removeConnectionInfo()
    this._exit(0)
  }

  // #5369: uncaughtException and unhandledRejection share an identical body —
  // one handler taking a `kind` log label. The "during shutdown" branch still
  // just logs + schedules exit (otherwise installing these handlers would
  // suppress Node's default crash-exit and a stuck shutdown — e.g. a hung
  // tunnel.stop() — could leave the process alive forever).
  _onFatal(kind, err) {
    const log = this._log
    if (this._shuttingDown) {
      log.error(`${kind} during shutdown: ${err?.stack || err}`)
      setTimeout(() => this._exit(1), this._exitDelayMs)
      return
    }
    this._shuttingDown = true
    log.error(`${kind}: ${err?.stack || err}`)
    this._emergencyCleanupSync({ kind, tunnel: this._tunnel, wsServer: this._wsServer, sessionManager: this._sessionManager })
    setTimeout(() => this._exit(1), this._exitDelayMs)
  }

  /** Register the signal + crash handlers on `process`. */
  install() {
    process.on('SIGINT', () => { this.shutdown('SIGINT').catch(() => this._exit(1)) })
    process.on('SIGTERM', () => { this.shutdown('SIGTERM').catch(() => this._exit(1)) })
    // #5336: a PTY-owning daemon receives SIGHUP when its controlling terminal
    // closes. Node's default SIGHUP action is to terminate the process, which
    // skips the shutdown() state flush — so the user's session state is lost on
    // terminal close. Chroxy has no config-reload semantics, so route SIGHUP
    // through the same graceful shutdown as SIGINT/SIGTERM.
    process.on('SIGHUP', () => { this.shutdown('SIGHUP').catch(() => this._exit(1)) })
    process.on('uncaughtException', this._onFatal.bind(this, 'Uncaught exception'))
    process.on('unhandledRejection', this._onFatal.bind(this, 'Unhandled rejection'))
  }
}
