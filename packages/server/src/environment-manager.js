import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'
import { execFile } from 'child_process'
import { existsSync, readFileSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { isWindows, writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'

const log = createLogger('environment-manager')

const DEFAULT_STATE_PATH = join(homedir(), '.chroxy', 'environments.json')
const DEFAULT_IMAGE = 'node:22-slim'
const DEFAULT_MEMORY_LIMIT = '2g'
const DEFAULT_CPU_LIMIT = '2'
const DEFAULT_CONTAINER_USER = 'chroxy'
const DEFAULT_CONTAINER_CLI_PATH = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'

const VALID_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/

/**
 * Manages persistent container environments that outlive individual sessions.
 *
 * Environments are long-lived Docker containers that multiple sessions can
 * connect to. The EnvironmentManager handles container creation, destruction,
 * persistence to disk, and reconnection after server restart.
 *
 * SessionManager uses EnvironmentManager to look up container details when
 * creating sessions with an environmentId.
 */
export class EnvironmentManager extends EventEmitter {
  constructor({ statePath, _execFile } = {}) {
    super()
    this._statePath = statePath || DEFAULT_STATE_PATH
    this._environments = new Map()
    // Injected for testing — falls back to real execFile
    this._execFile = _execFile || execFile
  }

  /**
   * Create a new persistent environment.
   *
   * Starts a Docker container with security constraints, creates a non-root
   * user, installs Claude Code CLI, and persists the environment to disk.
   *
   * When `devcontainer: true`, reads `.devcontainer/devcontainer.json` or
   * `.devcontainer.json` from `cwd` and merges supported fields (explicit
   * options always win).
   *
   * @param {Object} opts
   * @param {string} opts.name - Human-readable environment name
   * @param {string} opts.cwd - Host working directory to mount as /workspace
   * @param {string} [opts.image] - Docker image (default: node:22-slim)
   * @param {string} [opts.memoryLimit] - Memory limit (default: 2g)
   * @param {string} [opts.cpuLimit] - CPU limit (default: 2)
   * @param {string} [opts.containerUser] - Non-root user (default: chroxy)
   * @param {boolean} [opts.devcontainer] - Read devcontainer.json from cwd
   * @returns {Promise<Object>} The created environment object
   */
  async create({ name, cwd, image, memoryLimit, cpuLimit, containerUser, devcontainer } = {}) {
    if (!name?.trim()) throw new Error('Environment name is required')
    if (!cwd?.trim()) throw new Error('Environment cwd is required')

    // Merge devcontainer.json when requested (explicit opts win)
    let dcConfig = {}
    if (devcontainer) {
      dcConfig = this._parseDevContainer(cwd)
    }

    const user = containerUser || dcConfig.remoteUser || DEFAULT_CONTAINER_USER
    if (!VALID_USERNAME_RE.test(user)) {
      throw new Error(`Invalid containerUser "${user}" — must match POSIX username rules`)
    }

    const id = 'env-' + randomBytes(8).toString('hex')
    const resolvedImage = image || dcConfig.image || DEFAULT_IMAGE
    const resolvedMemory = memoryLimit || DEFAULT_MEMORY_LIMIT
    const resolvedCpu = cpuLimit || DEFAULT_CPU_LIMIT

    log.info(`Creating environment "${name}" (id: ${id}, image: ${resolvedImage})`)

    const containerId = await this._startContainer({
      cwd, image: resolvedImage, memoryLimit: resolvedMemory,
      cpuLimit: resolvedCpu,
      containerEnv: dcConfig.containerEnv,
      forwardPorts: dcConfig.forwardPorts,
      mounts: dcConfig.mounts,
    })

    let containerCliPath
    try {
      await this._setupContainer(containerId, user)
      containerCliPath = await this._discoverCliPath(containerId)

      if (dcConfig.postCreateCommand) {
        await this._runPostCreateCommand(containerId, dcConfig.postCreateCommand)
      }
    } catch (err) {
      // Clean up orphaned container before re-throwing
      log.warn(`Environment setup failed, removing container ${containerId.slice(0, 12)}: ${err.message}`)
      await this._removeContainer(containerId)
      throw err
    }

    const env = {
      id,
      name: name.trim(),
      cwd: cwd.trim(),
      image: resolvedImage,
      containerId,
      containerUser: user,
      containerCliPath,
      status: 'running',
      sessions: [],
      createdAt: new Date().toISOString(),
      memoryLimit: resolvedMemory,
      cpuLimit: resolvedCpu,
    }

    this._environments.set(id, env)
    this._persist()
    this.emit('environment_created', env)
    log.info(`Environment "${name}" created (container: ${containerId.slice(0, 12)})`)
    return env
  }

  /**
   * Destroy an environment and its container.
   * @param {string} envId - Environment ID
   */
  async destroy(envId) {
    const env = this._environments.get(envId)
    if (!env) throw new Error(`Environment not found: ${envId}`)

    log.info(`Destroying environment "${env.name}" (${envId})`)

    if (env.containerId && env.status === 'running') {
      await this._removeContainer(env.containerId)
    }

    this._environments.delete(envId)
    this._persist()
    this.emit('environment_destroyed', { id: envId, name: env.name })
    log.info(`Environment "${env.name}" destroyed`)
  }

  /**
   * List all environments.
   * @returns {Object[]} Array of environment objects
   */
  list() {
    return Array.from(this._environments.values())
  }

  /**
   * Get a single environment by ID.
   * @param {string} envId
   * @returns {Object|null}
   */
  get(envId) {
    return this._environments.get(envId) || null
  }

  /**
   * Get container details for session creation.
   * @param {string} envId
   * @returns {{ containerId: string, containerUser: string, containerCliPath: string }}
   */
  getContainerInfo(envId) {
    const env = this._environments.get(envId)
    if (!env) throw new Error(`Environment not found: ${envId}`)
    if (env.status !== 'running') throw new Error(`Environment "${env.name}" is not running (status: ${env.status})`)
    return {
      containerId: env.containerId,
      containerUser: env.containerUser,
      containerCliPath: env.containerCliPath,
    }
  }

  /**
   * Track a session connecting to an environment.
   * @param {string} envId
   * @param {string} sessionId
   */
  addSession(envId, sessionId) {
    const env = this._environments.get(envId)
    if (!env) return
    if (!env.sessions.includes(sessionId)) {
      env.sessions.push(sessionId)
      this._persist()
    }
  }

  /**
   * Track a session disconnecting from an environment.
   * @param {string} envId
   * @param {string} sessionId
   */
  removeSession(envId, sessionId) {
    const env = this._environments.get(envId)
    if (!env) return
    env.sessions = env.sessions.filter(s => s !== sessionId)
    this._persist()
  }

  /**
   * Reconnect to persisted environments on server restart.
   * Inspects each saved container and updates its status.
   */
  async reconnect() {
    this._restore()
    if (this._environments.size === 0) return

    log.info(`Reconnecting to ${this._environments.size} persisted environment(s)`)

    for (const env of this._environments.values()) {
      if (!env.containerId) {
        env.status = 'error'
        continue
      }
      try {
        const running = await this._inspectContainer(env.containerId)
        if (running) {
          env.status = 'running'
          log.info(`Environment "${env.name}" reconnected (container: ${env.containerId.slice(0, 12)})`)
        } else {
          env.status = 'stopped'
          log.warn(`Environment "${env.name}" container is stopped`)
        }
      } catch (err) {
        env.status = 'error'
        log.warn(`Environment "${env.name}" container inspect failed: ${err.message}`)
      }
      // Clear stale session references — sessions don't survive server restart
      env.sessions = []
    }

    this._persist()
    this.emit('environments_reconnected', this.list())
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Docker operations (async wrappers around execFile)
  // ──────────────────────────────────────────────────────────────────────────

  _startContainer({ cwd, image, memoryLimit, cpuLimit, containerEnv, forwardPorts, mounts }) {
    return new Promise((resolve, reject) => {
      const runArgs = [
        'run', '-d', '--init',
        '--memory', memoryLimit,
        '--cpus', cpuLimit,
        '--pids-limit', '512',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '-v', `${cwd}:/workspace`,
        '-w', '/workspace',
      ]

      const apiKey = process.env.ANTHROPIC_API_KEY
      if (apiKey) {
        runArgs.push('--env', `ANTHROPIC_API_KEY=${apiKey}`)
      }

      // DevContainer: extra environment variables
      if (containerEnv) {
        for (const [key, value] of Object.entries(containerEnv)) {
          runArgs.push('--env', `${key}=${value}`)
        }
      }

      // DevContainer: port forwards
      if (forwardPorts) {
        for (const port of forwardPorts) {
          runArgs.push('-p', `${port}:${port}`)
        }
      }

      // DevContainer: additional mounts
      if (mounts) {
        for (const mount of mounts) {
          runArgs.push('-v', mount)
        }
      }

      if (process.platform === 'linux') {
        runArgs.push('--add-host', 'host.docker.internal:host-gateway')
      }

      runArgs.push(image, 'sleep', 'infinity')

      this._execFile('docker', runArgs, { encoding: 'utf-8', timeout: 120_000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr ? stderr.trim() : err.message))
          return
        }
        resolve(stdout.trim())
      })
    })
  }

  _setupContainer(containerId, user) {
    return new Promise((resolve, reject) => {
      const setupCmd = [
        `useradd -m -s /bin/bash ${user}`,
        `chown ${user}:${user} /workspace`,
      ].join(' && ')

      this._execFile('docker', [
        'exec', containerId, 'bash', '-c', setupCmd,
      ], { encoding: 'utf-8', timeout: 10_000 }, (err) => {
        if (err) reject(new Error(`Failed to create container user: ${err.message}`))
        else resolve()
      })
    })
  }

  _installClaudeCode(containerId) {
    return new Promise((resolve, reject) => {
      this._execFile('docker', [
        'exec', containerId, 'npm', 'install', '-g', '@anthropic-ai/claude-code',
      ], { encoding: 'utf-8', timeout: 120_000 }, (err) => {
        if (err) reject(new Error(`Failed to install Claude Code: ${err.message}`))
        else resolve()
      })
    })
  }

  async _discoverCliPath(containerId) {
    await this._installClaudeCode(containerId)

    return new Promise((resolve) => {
      this._execFile('docker', [
        'exec', containerId, 'npm', 'prefix', '-g',
      ], { encoding: 'utf-8', timeout: 10_000 }, (err, stdout) => {
        if (!err && stdout?.trim()) {
          resolve(`${stdout.trim()}/lib/node_modules/@anthropic-ai/claude-code/cli.js`)
        } else {
          log.warn('Could not determine CLI path, using default')
          resolve(DEFAULT_CONTAINER_CLI_PATH)
        }
      })
    })
  }

  _removeContainer(containerId) {
    return new Promise((resolve) => {
      this._execFile('docker', ['rm', '-f', containerId], { stdio: 'ignore' }, (err) => {
        if (err) log.warn(`Failed to remove container ${containerId.slice(0, 12)}: ${err.message}`)
        resolve()
      })
    })
  }

  _inspectContainer(containerId) {
    return new Promise((resolve, reject) => {
      this._execFile('docker', [
        'inspect', '--format', '{{.State.Running}}', containerId,
      ], { encoding: 'utf-8', timeout: 10_000 }, (err, stdout) => {
        if (err) {
          reject(err)
          return
        }
        resolve(stdout.trim() === 'true')
      })
    })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DevContainer support
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Parse a devcontainer.json from the given cwd.
   *
   * Looks for `.devcontainer/devcontainer.json` first, then `.devcontainer.json`
   * at the project root. Returns an object with supported fields extracted.
   * Logs warnings for any unrecognized fields.
   *
   * @param {string} cwd - Project root to search
   * @returns {Object} Parsed config (empty object if no file found)
   */
  _parseDevContainer(cwd) {
    const candidates = [
      join(cwd, '.devcontainer', 'devcontainer.json'),
      join(cwd, '.devcontainer.json'),
    ]

    let filePath
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        filePath = candidate
        break
      }
    }

    if (!filePath) {
      log.info('No devcontainer.json found, using defaults')
      return {}
    }

    let raw
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch (err) {
      log.warn(`Failed to parse ${filePath}: ${err.message}`)
      return {}
    }

    log.info(`Parsed devcontainer.json from ${filePath}`)

    const SUPPORTED_FIELDS = new Set([
      'image', 'forwardPorts', 'containerEnv', 'mounts',
      'remoteUser', 'postCreateCommand',
    ])

    // Warn about unrecognized fields
    for (const key of Object.keys(raw)) {
      if (!SUPPORTED_FIELDS.has(key)) {
        log.warn(`devcontainer.json: unsupported field "${key}" (ignored)`)
      }
    }

    const config = {}

    if (typeof raw.image === 'string' && raw.image.trim()) {
      config.image = raw.image.trim()
    }

    if (typeof raw.remoteUser === 'string' && raw.remoteUser.trim()) {
      config.remoteUser = raw.remoteUser.trim()
    }

    if (typeof raw.postCreateCommand === 'string' && raw.postCreateCommand.trim()) {
      config.postCreateCommand = raw.postCreateCommand.trim()
    }

    if (raw.containerEnv && typeof raw.containerEnv === 'object' && !Array.isArray(raw.containerEnv)) {
      config.containerEnv = raw.containerEnv
    }

    if (Array.isArray(raw.forwardPorts)) {
      config.forwardPorts = raw.forwardPorts.filter(p => typeof p === 'number' || typeof p === 'string')
    }

    if (Array.isArray(raw.mounts)) {
      config.mounts = raw.mounts.filter(m => typeof m === 'string')
    }

    return config
  }

  /**
   * Run a postCreateCommand inside a container via `docker exec`.
   *
   * @param {string} containerId
   * @param {string} command
   */
  _runPostCreateCommand(containerId, command) {
    return new Promise((resolve, reject) => {
      log.info(`Running postCreateCommand: ${command}`)
      this._execFile('docker', [
        'exec', containerId, 'bash', '-c', command,
      ], { encoding: 'utf-8', timeout: 120_000 }, (err) => {
        if (err) reject(new Error(`postCreateCommand failed: ${err.message}`))
        else resolve()
      })
    })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Persistence
  // ──────────────────────────────────────────────────────────────────────────

  _persist() {
    try {
      const dir = dirname(this._statePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const data = {
        version: 1,
        environments: Array.from(this._environments.values()),
      }

      const tmpPath = this._statePath + '.tmp'
      writeFileRestricted(tmpPath, JSON.stringify(data, null, 2))
      if (isWindows) {
        try { unlinkSync(this._statePath) } catch (e) {
          if (e && e.code !== 'ENOENT') log.error(`Failed to remove existing state file: ${e.message}`)
        }
      }
      renameSync(tmpPath, this._statePath)
    } catch (err) {
      log.error(`Failed to persist environment state: ${err.message}`)
    }
  }

  _restore() {
    if (!existsSync(this._statePath)) return

    try {
      const data = JSON.parse(readFileSync(this._statePath, 'utf-8'))
      if (data.version !== 1 || !Array.isArray(data.environments)) {
        log.warn('Invalid environment state file, ignoring')
        return
      }
      for (const env of data.environments) {
        if (env.id) {
          this._environments.set(env.id, env)
        }
      }
      log.info(`Restored ${this._environments.size} environment(s) from disk`)
    } catch (err) {
      log.error(`Failed to restore environment state: ${err.message}`)
    }
  }
}
