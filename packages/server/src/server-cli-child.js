/**
 * Child process entry point for supervised mode.
 *
 * Spawned by supervisor.js via fork(). Runs the CLI server with tunnel=none
 * (supervisor owns the tunnel) and sends IPC messages back.
 *
 * IPC messages sent: { type: 'ready' } when WsServer is listening
 * IPC messages received: { type: 'shutdown' } for graceful cleanup
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { mergeConfig } from './config.js'

const CONFIG_FILE = join(homedir(), '.chroxy', 'config.json')

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
  await startCliServer(config)

  // Notify supervisor that we're ready
  if (process.send) {
    process.send({ type: 'ready' })
  }
}

// Listen for shutdown from supervisor
if (process.send) {
  process.on('message', async (msg) => {
    if (msg.type === 'shutdown') {
      console.log('[child] Shutdown requested by supervisor')
      process.exit(0)
    }
  })
}

main().catch((err) => {
  console.error('[child] Fatal error:', err)
  process.exit(1)
})
