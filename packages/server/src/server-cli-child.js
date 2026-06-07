/**
 * Child process entry point for supervised mode.
 *
 * Spawned by supervisor.js via fork(). Runs the CLI server with tunnel=none
 * (supervisor owns the tunnel) and sends IPC messages back.
 *
 * IPC messages sent:
 *   { type: 'ready' }          — WsServer is listening
 *   { type: 'drain_complete' } — All sessions idle, state serialized
 *
 * IPC messages received:
 *   { type: 'shutdown' }       — Immediate graceful shutdown
 *   { type: 'drain', timeout } — Drain in-flight work, serialize state, then ack
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { pathToFileURL } from 'url'
import { mergeConfig } from './config.js'
import { createLogger } from './logger.js'

const log = createLogger('child')

const CONFIG_FILE = join(homedir(), '.chroxy', 'config.json')

// Module-level references for drain handler access
let _sessionManager = null
let _wsServer = null

// Guards the flush/exit sequence so a crash arriving during an IPC shutdown
// (or vice-versa) doesn't double-run it.
let _shuttingDown = false

/**
 * Persist + tear down before the child exits. Mirrors the foreground handler in
 * server-cli.js (#3697): broadcast the shutdown, serialize session state to disk
 * BEFORE destroying anything (losing the user's restored state on stop/crash is
 * worse than risking a partial write), then destroyAll() (idempotent — it
 * serializes again and sets _destroying so late persists no-op) and close the WS.
 *
 * Exported (no process.exit) so it can be unit-tested with fakes. #5308 / WP-0.2.
 *
 * @param {object|null} sessionManager
 * @param {object|null} wsServer
 * @param {string} reason — broadcastShutdown reason ('shutdown' | 'crash')
 * @param {object} [logger]
 */
export function flushAndDestroy(sessionManager, wsServer, reason, logger = log) {
  try { if (wsServer) wsServer.broadcastShutdown(reason, 0) } catch {}
  try {
    if (sessionManager) sessionManager.serializeState()
  } catch (err) {
    logger.error(`Failed to serialize session state before ${reason}: ${err?.stack || err}`)
  }
  try { if (sessionManager) sessionManager.destroyAll() } catch {}
  try { if (wsServer) wsServer.close() } catch {}
}

// Flush state, then exit. Idempotent via _shuttingDown. The 100ms defer lets the
// broadcastShutdown frame + socket close flush before the process goes away.
function gracefulExit(code, reason) {
  // Idempotent: the first call already armed the exit timer below, so a second
  // path firing during the 100ms window (e.g. a crash mid-shutdown) just returns
  // — the in-flight timer guarantees the process exits.
  if (_shuttingDown) return
  _shuttingDown = true
  flushAndDestroy(_sessionManager, _wsServer, reason, log)
  // 100ms defer lets the broadcastShutdown frame + socket close flush first.
  setTimeout(() => process.exit(code), 100)
}

async function main() {
  // Load config (same as cli.js start command)
  let fileConfig = {}
  if (existsSync(CONFIG_FILE)) {
    fileConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  }

  const defaults = {
    port: 8765,
    noAuth: false,
  }

  const config = mergeConfig({ fileConfig, defaults })

  // Force tunnel=none — supervisor owns the tunnel
  config.tunnel = 'none'

  // Set environment variables for backward compatibility
  if (config.apiToken) process.env.API_TOKEN = config.apiToken
  if (config.port) process.env.PORT = String(config.port)

  const { startCliServer } = await import('./server-cli.js')
  const refs = await startCliServer(config)

  // Capture references for drain handler
  if (refs) {
    _sessionManager = refs.sessionManager || null
    _wsServer = refs.wsServer || null
  }

  // Notify supervisor that we're ready
  if (process.send) {
    process.send({ type: 'ready' })
  }
}

/**
 * Handle drain request from supervisor.
 * 1. Broadcast server_shutdown to connected clients (reason + ETA)
 * 2. Set draining flag on WsServer (reject new input)
 * 3. Wait for all sessions to idle
 * 4. Serialize session state to disk
 * 5. Send drain_complete back to supervisor
 */
async function handleDrain(timeout) {
  log.info(`Drain requested (timeout: ${timeout}ms)`)

  // Broadcast structured shutdown event before draining
  // ETA: drain timeout (~30s) + ~5s for child startup
  if (_wsServer) {
    _wsServer.broadcastShutdown('restart', timeout + 5000)
    _wsServer.setDraining(true)
  }

  // Wait for busy sessions to idle
  if (_sessionManager) {
    const deadline = Date.now() + timeout - 2000 // Leave 2s buffer for serialization
    while (!_sessionManager.allIdle() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
    }

    if (!_sessionManager.allIdle()) {
      log.warn('Drain timeout reached with sessions still busy, proceeding anyway')
    }

    // Serialize session state
    try {
      _sessionManager.serializeState()
    } catch (err) {
      log.error(`Failed to serialize state: ${err.message}`)
    }
  }

  // Ack drain complete
  if (process.send) {
    process.send({ type: 'drain_complete' })
  }
}

// Only wire process-global handlers + run main() when this file is the forked
// entry point. When imported (e.g. unit tests of flushAndDestroy) these side
// effects must NOT fire — registering crash handlers or starting the server on
// import would corrupt the test runner. #5308 / WP-0.2.
const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) {
  // Listen for IPC messages from supervisor
  if (process.send) {
    process.on('message', async (msg) => {
      if (msg.type === 'shutdown') {
        // #5308 (WP-0.2) — the supervisor's stop path sends this IPC and only
        // escalates to an OS SIGTERM at the 5s force-kill fallback, so the
        // child's OS-signal flush handler never runs first. A bare process.exit(0)
        // here therefore lost ALL session state on every supervised stop/restart
        // (the #3697 data-loss class on the supervised hot path). Flush first.
        log.info('Shutdown requested by supervisor')
        gracefulExit(0, 'shutdown')
        return
      }

      if (msg.type === 'drain') {
        const timeout = msg.timeout || 30000
        await handleDrain(timeout)
      }
    })
  }

  // #5308 (WP-0.2) — crash handlers previously called destroyAll() (which does
  // serialize internally) but omitted the explicit pre-destroy serializeState the
  // foreground handler runs. gracefulExit() now serializes BEFORE destroyAll for
  // parity with server-cli.js, isolating a serialize failure from teardown.
  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err?.stack || err}`)
    gracefulExit(1, 'crash')
  })

  process.on('unhandledRejection', (err) => {
    log.error(`Unhandled rejection: ${err?.stack || err}`)
    gracefulExit(1, 'crash')
  })

  main().catch((err) => {
    log.error(`Fatal error: ${err?.stack || err}`)
    process.exit(1)
  })
}
