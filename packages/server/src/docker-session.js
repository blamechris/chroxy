import { spawn, execFile } from 'child_process'
import { createInterface } from 'readline'
import { CliSession } from './cli-session.js'
import { createLogger } from './logger.js'

const log = createLogger('docker-session')

/**
 * Classify a Docker error into a structured error with a specific code.
 *
 * Returns an object with `code` and `message` fields so callers can surface
 * actionable errors to clients instead of raw spawn/exec messages.
 *
 * @param {Error} err - The error from execFile or spawn
 * @param {string} [stderrText] - Optional stderr output to include in classification
 * @returns {{ code: string, message: string }}
 */
export function classifyDockerError(err, stderrText = '') {
  const msg = (err.message || '').toLowerCase()
  const stderr = (stderrText || err.stderr || '').toLowerCase()
  const combined = msg + ' ' + stderr

  if (
    combined.includes('cannot connect to the docker daemon') ||
    combined.includes('is the docker daemon running') ||
    (combined.includes('connection refused') && combined.includes('docker'))
  ) {
    return { code: 'docker_not_running', message: 'Docker is not running. Start Docker Desktop and try again.' }
  }
  if (
    combined.includes('no such image') ||
    combined.includes('manifest unknown') ||
    (combined.includes('not found') && combined.includes('image'))
  ) {
    return { code: 'docker_image_not_found', message: 'Docker image not found. Run: docker pull <image>' }
  }
  if (
    combined.includes('permission denied') ||
    combined.includes('access denied')
  ) {
    return { code: 'docker_permission_denied', message: 'Permission denied connecting to Docker. Check your Docker group membership.' }
  }
  return { code: 'docker_error', message: err.message }
}

/**
 * Env vars explicitly forwarded into the Docker container.
 * Only vars needed for Claude Code operation — never forward the full host env.
 *
 * This list is broader than DockerSdkSession's allowlist because CliSession
 * uses an external permission hook (HTTP callback to the host), which requires
 * CHROXY_PORT, CHROXY_HOOK_SECRET, and CHROXY_PERMISSION_MODE. The CLI process
 * also needs CLAUDE_HEADLESS and CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING
 * for headless stream-json mode.
 *
 * See also: FORWARDED_ENV_KEYS in docker-sdk-session.js
 */
const FORWARDED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CHROXY_PORT',
  'CHROXY_HOOK_SECRET',
  'CHROXY_PERMISSION_MODE',
  'CLAUDE_HEADLESS',
  'HOME',
  'PATH',
]

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
   * Start the container asynchronously, then call super.start() which invokes
   * _spawnPersistentProcess() with the built Claude args.
   */
  start() {
    if (this._containerId) {
      super.start()
      return
    }

    // Start container async to avoid blocking the event loop
    this._startContainer((err) => {
      if (err) {
        this.emit('error', { code: err.code || 'docker_error', message: `Failed to start Docker container: ${err.message}` })
        // Self-destruct so SessionManager doesn't keep a phantom entry
        this.destroy()
        return
      }
      super.start()
    })
  }

  /**
   * Launch a long-lived container with security constraints.
   * The container runs `sleep infinity` so it stays alive across
   * multiple `docker exec` invocations (e.g. model switches / respawns).
   *
   * Uses async execFile to avoid blocking the event loop during image pull.
   */
  _startContainer(callback) {
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

    // Pass ANTHROPIC_API_KEY to the container so Claude can authenticate
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (apiKey) {
      args.push('--env', `ANTHROPIC_API_KEY=${apiKey}`)
    }

    // On Linux, host.docker.internal is not available by default
    if (process.platform === 'linux') {
      args.push('--add-host', 'host.docker.internal:host-gateway')
    }

    args.push(this._image, 'sleep', 'infinity')

    log.info(`Starting container (image: ${this._image}, memory: ${this._memoryLimit}, cpus: ${this._cpuLimit})`)

    execFile('docker', args, { encoding: 'utf-8', timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) {
        const classified = classifyDockerError(err, stderr)
        log.warn(`Docker start failed [${classified.code}]: ${classified.message}`)
        const error = new Error(classified.message)
        error.code = classified.code
        callback(error)
        return
      }
      this._containerId = stdout.trim()
      log.info(`Container started: ${this._containerId.slice(0, 12)}`)
      callback(null)
    })
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

    // Forward only allowed env vars — never leak host secrets
    for (const key of FORWARDED_ENV_KEYS) {
      const val = env[key]
      if (val !== undefined) {
        dockerArgs.push('--env', `${key}=${val}`)
      }
    }
    // Always forward CHROXY_HOST if set
    if (env.CHROXY_HOST) {
      dockerArgs.push('--env', `CHROXY_HOST=${env.CHROXY_HOST}`)
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
      const classified = classifyDockerError(err)
      log.warn(`Docker exec failed [${classified.code}]: ${classified.message}`)
      this.emit('error', { code: classified.code, message: classified.message })
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

    // Dequeue the next pending message if not already busy.
    // sendMessage() sets _isBusy, so the loop sends at most one message.
    // Remaining items stay in the queue and are drained one-by-one via
    // _clearMessageState() after each result.
    while (this._pendingQueue.length > 0 && !this._isBusy) {
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
      execFile('docker', ['rm', '-f', containerId], { stdio: 'ignore' }, (err) => {
        if (err) log.warn(`Failed to remove container ${containerId.slice(0, 12)}: ${err.message}`)
      })
    }
  }
}
