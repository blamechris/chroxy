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
import { mergeConfig } from './config.js'

const CONFIG_FILE = join(homedir(), '.chroxy', 'config.json')

// Module-level references for drain handler access
let _sessionManager = null
let _wsServer = null

async function main() {
  // Load config (same as cli.js start command)
  let fileConfig = {}
  if (existsSync(CONFIG_FILE)) {
    fileConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  }

  const defaults = {
    port: 8765,
    tmuxSession: 'claude-code',
    shell: process.env.SHELL || '/bin/zsh',
    resume: false,
    noAuth: false,
  }

  const config = mergeConfig({ fileConfig, defaults })

  // Force tunnel=none — supervisor owns the tunnel
  config.tunnel = 'none'

  // Set environment variables for backward compatibility
  if (config.apiToken) process.env.API_TOKEN = config.apiToken
  if (config.port) process.env.PORT = String(config.port)
  if (config.tmuxSession) process.env.TMUX_SESSION = config.tmuxSession
  if (config.shell) process.env.SHELL_CMD = config.shell

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
 * 1. Set draining flag on WsServer (reject new input)
 * 2. Broadcast server_status to connected clients
 * 3. Wait for all sessions to idle
 * 4. Serialize session state to disk
 * 5. Send drain_complete back to supervisor
 */
async function handleDrain(timeout) {
  console.log(`[child] Drain requested (timeout: ${timeout}ms)`)

  // Broadcast restarting status to connected clients
  if (_wsServer) {
    _wsServer._draining = true
    _wsServer.broadcastStatus('Server restarting...')
  }

  // Wait for busy sessions to idle
  if (_sessionManager) {
    const deadline = Date.now() + timeout - 2000 // Leave 2s buffer for serialization
    while (!_sessionManager.allIdle() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
    }

    if (!_sessionManager.allIdle()) {
      console.log('[child] Drain timeout reached with sessions still busy, proceeding anyway')
    }

    // Serialize session state
    try {
      _sessionManager.serializeState()
    } catch (err) {
      console.error(`[child] Failed to serialize state: ${err.message}`)
    }
  }

  // Ack drain complete
  if (process.send) {
    process.send({ type: 'drain_complete' })
  }
}

// Listen for IPC messages from supervisor
if (process.send) {
  process.on('message', async (msg) => {
    if (msg.type === 'shutdown') {
      console.log('[child] Shutdown requested by supervisor')
      process.exit(0)
    }

    if (msg.type === 'drain') {
      const timeout = msg.timeout || 30000
      await handleDrain(timeout)
    }
  })
}

main().catch((err) => {
  console.error('[child] Fatal error:', err)
  process.exit(1)
})
