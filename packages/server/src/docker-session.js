import { spawn, execFileSync } from 'child_process'
import { createInterface } from 'readline'
import { CliSession } from './cli-session.js'
import { createLogger } from './logger.js'

const log = createLogger('docker-session')

/**
 * DockerSession runs Claude Code inside an isolated Docker container.
 *
 * Extends CliSession and overrides only `_spawnPersistentProcess()` so that
 * the child process is `docker exec -i <container> claude ...` instead of a
 * bare `claude ...` subprocess. All upstream event handling, respawn logic,
 * stdin/stdout piping, and lifecycle management from CliSession apply
 * unchanged — only the spawn mechanism differs.
 *
 * Container lifecycle:
 *   start()   → _startContainer() → long-lived `docker run … sleep infinity`
 *   spawn     → `docker exec -i <id> claude …`  (one per respawn)
 *   destroy() → `docker rm -f <id>`
 *
 * Permission hook routing:
 *   The container process must reach the host's HTTP server.  On macOS/Windows
 *   `host.docker.internal` resolves automatically; on Linux we add
 *   `--add-host host.docker.internal:host-gateway` to the run args.
 */
export class DockerSession extends CliSession {
  static get capabilities() {
    return { ...CliSession.capabilities, containerized: true }
  }

  constructor(opts = {}) {
    super(opts)
    this._containerId = null
    this._image = opts.image || 'node:22-slim'
    this._memoryLimit = opts.memoryLimit || '2g'
    this._cpuLimit = opts.cpuLimit || '2'
  }

  /**
   * Start the container, then call super.start() which invokes
   * _spawnPersistentProcess() with the built Claude args.
   */
  start() {
    if (!this._containerId) {
      this._startContainer()
    }
    super.start()
  }

  /**
   * Launch a long-lived container with security constraints.
   * The container runs `sleep infinity` so it stays alive across
   * multiple `docker exec` invocations (e.g. model switches / respawns).
   */
  _startContainer() {
    const args = [
      'run', '-d', '--init', '--rm',
      '--memory', this._memoryLimit,
      '--cpus', this._cpuLimit,
      '--pids-limit', '512',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '-v', `${this.cwd || process.cwd()}:/workspace`,
      '-w', '/workspace',
    ]

    // On Linux, host.docker.internal is not available by default
    if (process.platform === 'linux') {
      args.push('--add-host', 'host.docker.internal:host-gateway')
    }

    args.push(this._image, 'sleep', 'infinity')

    log.info(`Starting container (image: ${this._image}, memory: ${this._memoryLimit}, cpus: ${this._cpuLimit})`)

    try {
      const result = execFileSync('docker', args, { encoding: 'utf-8' })
      this._containerId = result.trim()
      log.info(`Container started: ${this._containerId.slice(0, 12)}`)
    } catch (err) {
      const msg = err.stderr ? err.stderr.toString().trim() : err.message
      throw new Error(`Failed to start Docker container: ${msg}`)
    }
  }

  /**
   * Build the Claude CLI args. Mirrors CliSession.start() arg construction
   * without calling super.start() (we call this from _spawnPersistentProcess).
   */
  _buildClaudeArgs() {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]

    if (this.model) {
      args.push('--model', this.model)
    }

    if (this.permissionMode === 'auto') {
      args.push('--permission-mode', 'bypassPermissions')
    } else if (this.permissionMode === 'plan') {
      args.push('--permission-mode', 'plan')
    }

    if (this.allowedTools && this.allowedTools.length > 0) {
      args.push('--allowedTools', this.allowedTools.join(','))
    }

    return args
  }

  /**
   * Override CliSession._spawnPersistentProcess to use `docker exec -i`
   * instead of spawning `claude` directly.
   *
   * The returned child process has the same stdio interface as a bare spawn
   * so all CliSession readline/event wiring works unchanged — we just swap
   * the underlying process handle.
   */
  _spawnPersistentProcess(claudeArgs) {
    this._cleanupReadlines()
    this._processReady = false

    if (!this._containerId) {
      this.emit('error', { message: 'Docker container not started — cannot exec' })
      return
    }

    const env = this._buildChildEnv()

    // Route permission hook to host.docker.internal so the container process
    // can reach the HTTP endpoint running on the host.
    if (env.CHROXY_PORT) {
      env.CHROXY_HOST = 'host.docker.internal'
    }

    const dockerArgs = ['exec', '-i', '--workdir', '/workspace']

    // Forward env vars into the container
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) {
        dockerArgs.push('--env', `${k}=${v}`)
      }
    }

    dockerArgs.push(this._containerId, 'claude', ...claudeArgs)

    log.info(`Exec into container ${this._containerId.slice(0, 12)} (model: ${this.model || 'default'})`)

    const child = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this._child = child

    // Absorb EPIPE errors on stdin
    child.stdin.on('error', (err) => {
      log.warn(`stdin error (ignored): ${err.message}`)
    })

    // Read stdout line by line — each line is a JSON object
    const rl = createInterface({ input: child.stdout })
    this._rl = rl

    rl.on('line', (line) => {
      if (!line.trim()) return
      let data
      try {
        data = JSON.parse(line)
      } catch {
        return
      }
      this._handleEvent(data)
    })

    // Log stderr for debugging
    const stderrRL = createInterface({ input: child.stderr })
    this._stderrRL = stderrRL
    stderrRL.on('line', (line) => {
      if (line.trim()) {
        log.info(`stderr: ${line}`)
      }
    })

    child.on('error', (err) => {
      this._cleanupReadlines()
      this._processReady = false
      this._child = null
      this.emit('error', { message: `Failed to exec into container: ${err.message}` })
      this._scheduleRespawn()
    })

    child.on('close', (code) => {
      this._cleanupReadlines()
      this._processReady = false
      this._child = null

      if (this._destroying) return
      if (this._respawning) return

      if (this._isBusy && this._currentMessageId) {
        if (this._currentCtx?.hasStreamStarted) {
          this.emit('stream_end', { messageId: this._currentMessageId })
        }
        this._clearMessageState()
      }

      log.info(`Container exec exited (code ${code}), scheduling respawn`)
      this.emit('error', { message: 'Claude process exited unexpectedly, restarting...' })
      this._scheduleRespawn()
    })

    this._processReady = true
    log.info('Container exec started, ready for messages')
    this.emit('ready', { sessionId: null, model: this.model, tools: [] })

    // Drain any queued messages that arrived during respawn
    if (this._pendingQueue.length > 0) {
      const pending = this._pendingQueue.shift()
      log.info(`Dequeuing pending message (${this._pendingQueue.length} remaining)`)
      this.sendMessage(pending.prompt, pending.attachments, pending.options || {})
    }
  }

  /**
   * Destroy the session: stop the exec process, remove the container,
   * then call super.destroy() to clean up CliSession state.
   */
  destroy() {
    const containerId = this._containerId
    this._containerId = null

    super.destroy()

    if (containerId) {
      log.info(`Removing container ${containerId.slice(0, 12)}`)
      try {
        execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' })
      } catch (err) {
        log.warn(`Failed to remove container ${containerId.slice(0, 12)}: ${err.message}`)
      }
    }
  }
}
