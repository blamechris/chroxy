import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'
import { execFile } from 'child_process'
import { existsSync, readFileSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { dirname, join, resolve } from 'path'
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
const VALID_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

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
    // Per-environment mutex: Map<envId, Promise> — serializes operations
    this._locks = new Map()
    // Injected for testing — falls back to real execFile
    this._execFile = _execFile || execFile
  }

  /**
   * Acquire a per-environment mutex. Returns a release function.
   * All operations on the same envId serialize through this lock.
   * Operations on different envIds run in parallel.
   */
  async _acquireLock(envId) {
    while (this._locks.has(envId)) {
      await this._locks.get(envId)
    }
    let release
    const lock = new Promise(resolve => { release = resolve })
    this._locks.set(envId, lock)
    return () => {
      this._locks.delete(envId)
      release()
    }
  }

  /**
   * Create a new persistent environment.
   *
   * Starts a Docker container with security constraints, creates a non-root
   * user, installs Claude Code CLI, and persists the environment to disk.
   *
   * @param {Object} opts
   * @param {string} opts.name - Human-readable environment name
   * @param {string} opts.cwd - Host working directory to mount as /workspace
   * @param {string} [opts.image] - Docker image (default: node:22-slim)
   * @param {string} [opts.memoryLimit] - Memory limit (default: 2g)
   * @param {string} [opts.cpuLimit] - CPU limit (default: 2)
   * @param {string} [opts.containerUser] - Non-root user (default: chroxy)
   * @returns {Promise<Object>} The created environment object
   */
  async create({ name, cwd, image, memoryLimit, cpuLimit, containerUser, compose, primaryService, devcontainer } = {}) {
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
    const composeProject = compose ? `chroxy-${id}` : null

    if (compose) {
      return this._createComposeEnvironment({ id, name, cwd, user, compose, primaryService, composeProject })
    }

    const resolvedImage = image || dcConfig.image || DEFAULT_IMAGE
    const resolvedMemory = memoryLimit || DEFAULT_MEMORY_LIMIT
    const resolvedCpu = cpuLimit || DEFAULT_CPU_LIMIT

    log.info(`Creating environment "${name}" (id: ${id}, image: ${resolvedImage})`)

    // Validate devcontainer mounts and env before passing to Docker
    const validatedMounts = this._validateMounts(dcConfig.mounts, cwd)
    const validatedEnv = this._sanitizeContainerEnv(dcConfig.containerEnv)

    const containerId = await this._startContainer({
      envId: id, cwd, image: resolvedImage, memoryLimit: resolvedMemory,
      cpuLimit: resolvedCpu,
      containerEnv: validatedEnv,
      forwardPorts: dcConfig.forwardPorts,
      mounts: validatedMounts,
    })

    let containerCliPath
    try {
      await this._setupContainer(containerId, user)
      containerCliPath = await this._discoverCliPath(containerId)
      if (dcConfig.postCreateCommand) {
        await this._runPostCreateCommand(containerId, dcConfig.postCreateCommand)
      }
    } catch (err) {
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
      compose: null,
      composeProject: null,
    }

    this._environments.set(id, env)
    this._persist()
    this.emit('environment_created', env)
    log.info(`Environment "${name}" created (container: ${containerId.slice(0, 12)})`)
    return env
  }

  /**
   * Create a Compose-backed environment.
   * Starts all services via docker compose, identifies the primary container,
   * sets up the non-root user, and installs Claude Code.
   */
  async _createComposeEnvironment({ id, name, cwd, user, compose, primaryService, composeProject }) {
    log.info(`Creating compose environment "${name}" (id: ${id}, compose: ${compose})`)

    await this._composeUp(compose, composeProject, cwd)

    let containerId
    try {
      containerId = await this._composePrimaryContainerId(composeProject, primaryService)
    } catch (err) {
      log.warn(`Failed to identify primary container, tearing down: ${err.message}`)
      await this._composeDown(compose, composeProject, cwd)
      throw err
    }

    let containerCliPath
    try {
      await this._setupContainer(containerId, user)
      containerCliPath = await this._discoverCliPath(containerId)
    } catch (err) {
      log.warn(`Compose environment setup failed, tearing down: ${err.message}`)
      await this._composeDown(compose, composeProject, cwd)
      throw err
    }

    const services = await this._composeServices(composeProject)

    const env = {
      id,
      name: name.trim(),
      cwd: cwd.trim(),
      image: 'compose',
      containerId,
      containerUser: user,
      containerCliPath,
      status: 'running',
      sessions: [],
      createdAt: new Date().toISOString(),
      memoryLimit: null,
      cpuLimit: null,
      compose,
      composeProject,
      primaryService: primaryService || null,
      services,
    }

    this._environments.set(id, env)
    this._persist()
    this.emit('environment_created', env)
    log.info(`Compose environment "${name}" created (primary: ${containerId.slice(0, 12)}, services: ${services.length})`)
    return env
  }

  /**
   * Create a snapshot of a running environment via docker commit.
   *
   * @param {string} envId - Environment ID
   * @param {Object} [opts]
   * @param {string} [opts.name] - Human-readable snapshot name
   * @returns {Promise<Object>} Snapshot metadata { id, name, image, createdAt }
   */
  async snapshot(envId, { name } = {}) {
    const release = await this._acquireLock(envId)
    try {
      const env = this._environments.get(envId)
      if (!env) throw new Error(`Environment not found: ${envId}`)
      if (env.status !== 'running') throw new Error(`Environment "${env.name}" is not running (status: ${env.status})`)
      const snapshotId = 'snap-' + randomBytes(8).toString('hex')
      const timestamp = Date.now()
      const imageTag = `chroxy-env:${envId}-${timestamp}`

      log.info(`Creating snapshot "${name || snapshotId}" for environment "${env.name}"`)

      await this._commitContainer(env.containerId, imageTag)

      const snap = {
        id: snapshotId,
        name: name || snapshotId,
        image: imageTag,
        createdAt: new Date().toISOString(),
      }

      if (!Array.isArray(env.snapshots)) {
        env.snapshots = []
      }
      env.snapshots.push(snap)

      this._persist()
      this.emit('environment_snapshot', { envId, snapshot: snap })
      log.info(`Snapshot "${snap.name}" created (image: ${imageTag})`)
      return snap
    } finally {
      release()
    }
  }

  /**
   * Restore an environment from a snapshot.
   *
   * Stops the current container and starts a new one from the snapshot image,
   * preserving the same security constraints.
   *
   * @param {string} envId - Environment ID
   * @param {string} snapshotId - Snapshot ID to restore
   * @returns {Promise<Object>} Updated environment object
   */
  async restore(envId, snapshotId) {
    const release = await this._acquireLock(envId)
    try {
      const env = this._environments.get(envId)
      if (!env) throw new Error(`Environment not found: ${envId}`)

      const snapshots = env.snapshots || []
      const snap = snapshots.find(s => s.id === snapshotId)
      if (!snap) throw new Error(`Snapshot not found: ${snapshotId}`)
      log.info(`Restoring environment "${env.name}" from snapshot "${snap.name}"`)

      const oldContainerId = env.containerId

      // Rename old container so the new one can reuse the chroxy-env-{envId} name
      await this._renameContainer(oldContainerId, `chroxy-env-${envId}-old`)

      // Start new container from snapshot BEFORE removing old one
      const containerId = await this._startContainer({
        envId,
        cwd: env.cwd,
        image: snap.image,
        memoryLimit: env.memoryLimit || DEFAULT_MEMORY_LIMIT,
        cpuLimit: env.cpuLimit || DEFAULT_CPU_LIMIT,
      })

      // Health check: verify the new container is running
      let healthy = false
      try {
        healthy = await this._inspectContainer(containerId)
      } catch (err) {
        log.warn(`Restore health check inspect failed for container ${containerId.slice(0, 12)}: ${err.message}`)
      }

      if (!healthy) {
        // New container failed — clean it up and preserve the old one
        log.warn(`Restore health check failed for new container ${containerId.slice(0, 12)}, rolling back`)
        await this._removeContainer(containerId)
        throw new Error(`Restored container health check failed for environment "${env.name}"`)
      }

      // New container is healthy — remove the old one
      await this._removeContainer(oldContainerId)

      env.containerId = containerId
      env.status = 'running'

      this._persist()
      this.emit('environment_restored', { envId, snapshotId, containerId })
      log.info(`Environment "${env.name}" restored (container: ${containerId.slice(0, 12)})`)
      return env
    } finally {
      release()
    }
  }

  /**
   * Destroy an environment and its container.
   * @param {string} envId - Environment ID
   */
  async destroy(envId) {
    const release = await this._acquireLock(envId)
    try {
      const env = this._environments.get(envId)
      if (!env) throw new Error(`Environment not found: ${envId}`)
      log.info(`Destroying environment "${env.name}" (${envId})`)

      if (env.compose && env.composeProject) {
        await this._composeDown(env.compose, env.composeProject, env.cwd)
      } else if (env.containerId && env.status === 'running') {
        await this._removeContainer(env.containerId)
      }

      // Clean up snapshot images
      if (Array.isArray(env.snapshots)) {
        for (const snap of env.snapshots) {
          await this._removeImage(snap.image)
        }
      }

      this._environments.delete(envId)
      this._persist()
      this.emit('environment_destroyed', { id: envId, name: env.name })
      log.info(`Environment "${env.name}" destroyed`)
    } finally {
      release()
    }
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

  /**
   * Reconcile running containers against the registry.
   * Enumerates all `chroxy-env-*` containers and stops any that are not
   * tracked in the environment registry. Best-effort — failures are logged
   * but do not throw.
   */
  async reconcile() {
    let containerIds
    try {
      containerIds = await this._listChroxyContainers()
    } catch (err) {
      log.warn(`Reconcile: failed to list containers: ${err.message}`)
      return
    }

    const knownIds = new Set()
    for (const env of this._environments.values()) {
      if (env.containerId) knownIds.add(env.containerId)
    }

    const orphans = containerIds.filter(id => !knownIds.has(id))
    if (orphans.length === 0) return

    log.info(`Reconcile: found ${orphans.length} orphaned container(s), removing`)
    for (const id of orphans) {
      log.info(`Reconcile: removing orphaned container ${id.slice(0, 12)}`)
      await this._removeContainer(id)
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Docker operations (async wrappers around execFile)
  // ──────────────────────────────────────────────────────────────────────────

  _startContainer({ envId, cwd, image, memoryLimit, cpuLimit, containerEnv, forwardPorts, mounts }) {
    return new Promise((resolve, reject) => {
      const runArgs = [
        'run', '-d', '--init',
        '--name', `chroxy-env-${envId}`,
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

  _commitContainer(containerId, imageTag) {
    return new Promise((resolve, reject) => {
      this._execFile('docker', ['commit', containerId, imageTag], { encoding: 'utf-8', timeout: 120_000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr ? stderr.trim() : err.message))
          return
        }
        resolve(stdout.trim())
      })
    })
  }

  _renameContainer(containerId, newName) {
    return new Promise((resolve) => {
      this._execFile('docker', ['rename', containerId, newName], { encoding: 'utf-8', timeout: 10_000 }, (err) => {
        if (err) log.warn(`Failed to rename container ${containerId.slice(0, 12)}: ${err.message}`)
        resolve()
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

  _removeImage(imageTag) {
    return new Promise((resolve) => {
      this._execFile('docker', ['rmi', imageTag], { stdio: 'ignore' }, (err) => {
        if (err) log.warn(`Failed to remove image ${imageTag}: ${err.message}`)
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

  /**
   * List all running chroxy-env-* container IDs.
   * Used by reconcile() to detect orphaned containers.
   */
  _listChroxyContainers() {
    return new Promise((resolve, reject) => {
      this._execFile('docker', [
        'ps', '-q', '--filter', 'name=chroxy-env',
      ], { encoding: 'utf-8', timeout: 10_000 }, (err, stdout) => {
        if (err) {
          reject(new Error(err.message))
          return
        }
        const ids = stdout.trim().split('\n').filter(Boolean)
        resolve(ids)
      })
    })
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DevContainer support
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Parse a devcontainer.json from the given cwd.
   * Looks for `.devcontainer/devcontainer.json` first, then `.devcontainer.json`.
   * Returns an object with supported fields. Logs warnings for unrecognized fields.
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

    for (const key of Object.keys(raw)) {
      if (!SUPPORTED_FIELDS.has(key)) {
        log.warn(`devcontainer.json: unsupported field "${key}" (ignored)`)
      }
    }

    const config = {}
    if (typeof raw.image === 'string' && raw.image.trim()) config.image = raw.image.trim()
    if (typeof raw.remoteUser === 'string' && raw.remoteUser.trim()) config.remoteUser = raw.remoteUser.trim()
    if (typeof raw.postCreateCommand === 'string' && raw.postCreateCommand.trim()) config.postCreateCommand = raw.postCreateCommand.trim()
    if (raw.containerEnv && typeof raw.containerEnv === 'object' && !Array.isArray(raw.containerEnv)) config.containerEnv = raw.containerEnv
    if (Array.isArray(raw.forwardPorts)) config.forwardPorts = raw.forwardPorts.filter(p => typeof p === 'number' || typeof p === 'string')
    if (Array.isArray(raw.mounts)) config.mounts = raw.mounts.filter(m => typeof m === 'string')

    return config
  }

  /**
   * Validate mount source paths. Only mounts whose source is inside the
   * project directory (cwd) are allowed. Mounts outside cwd or targeting
   * sensitive paths (~/.ssh, ~/.aws, /etc, etc.) are rejected and logged.
   *
   * Supports both short-form (`source:target`) and long-form
   * (`source=...,target=...,type=bind`) mount strings.
   *
   * @param {string[]|undefined} mounts - Raw mount strings from devcontainer.json
   * @param {string} cwd - Project directory (allowlist root)
   * @returns {string[]} Filtered array of safe mounts
   */
  _validateMounts(mounts, cwd) {
    if (!Array.isArray(mounts) || mounts.length === 0) return undefined

    const resolvedCwd = cwd.endsWith('/') ? cwd : cwd + '/'
    const home = homedir()

    const allowed = []
    for (const mount of mounts) {
      const source = this._extractMountSource(mount)
      if (!source) {
        log.warn(`devcontainer mount rejected (unparseable): ${mount}`)
        continue
      }

      // Expand ~ to home directory for comparison
      const expandedSource = source.startsWith('~/')
        ? join(home, source.slice(2))
        : source.startsWith('~')
          ? home
          : source

      // Normalize to resolve any .. segments (path traversal defense)
      const normalizedSource = resolve(expandedSource)

      // Source must be an absolute path inside the project directory
      if (!normalizedSource.startsWith(resolvedCwd) && normalizedSource !== cwd) {
        log.warn(`devcontainer mount rejected (outside project dir): ${source}`)
        continue
      }

      allowed.push(mount)
    }

    return allowed.length > 0 ? allowed : undefined
  }

  /**
   * Extract the source path from a mount string.
   * Handles both `source:target[:opts]` and `source=path,target=path,type=bind`.
   */
  _extractMountSource(mount) {
    // Long-form: source=...,target=...,type=bind
    const sourceMatch = mount.match(/(?:^|,)source=([^,]+)/)
    if (sourceMatch) return sourceMatch[1]

    // Short-form: source:target[:opts]
    const parts = mount.split(':')
    if (parts.length >= 2) return parts[0]

    return null
  }

  /**
   * Sanitize containerEnv keys. Only keys matching [A-Za-z_][A-Za-z0-9_]*
   * are allowed. Invalid keys are rejected and logged.
   *
   * @param {Object|undefined} containerEnv - Raw env vars from devcontainer.json
   * @returns {Object|undefined} Filtered env object with only valid keys
   */
  _sanitizeContainerEnv(containerEnv) {
    if (!containerEnv || typeof containerEnv !== 'object') return undefined

    const sanitized = Object.create(null)
    let hasKeys = false

    for (const [key, value] of Object.entries(containerEnv)) {
      if (!VALID_ENV_KEY_RE.test(key)) {
        log.warn(`devcontainer env key rejected (invalid characters): ${key}`)
        continue
      }
      sanitized[key] = value
      hasKeys = true
    }

    return hasKeys ? sanitized : undefined
  }

  /**
   * Run a postCreateCommand inside a container via docker exec.
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
  // Docker Compose operations
  // ──────────────────────────────────────────────────────────────────────────

  _composeUp(composeFile, project, cwd) {
    return new Promise((resolve, reject) => {
      this._execFile('docker', [
        'compose', '-f', composeFile, '-p', project, 'up', '-d',
      ], { encoding: 'utf-8', timeout: 120_000, cwd }, (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(stderr ? stderr.trim() : err.message))
          return
        }
        resolve()
      })
    })
  }

  _composeDown(composeFile, project, cwd) {
    return new Promise((resolve) => {
      this._execFile('docker', [
        'compose', '-f', composeFile, '-p', project, 'down', '--remove-orphans',
      ], { encoding: 'utf-8', timeout: 30_000, cwd }, (err) => {
        if (err) log.warn(`docker compose down failed: ${err.message}`)
        resolve()
      })
    })
  }

  /**
   * Find the primary container ID in a compose project.
   * Uses primaryService if specified, otherwise picks the first service.
   */
  _composePrimaryContainerId(project, primaryService) {
    return new Promise((resolve, reject) => {
      const args = ['compose', '-p', project, 'ps', '--format', 'json']
      if (primaryService) args.push(primaryService)

      this._execFile('docker', args, { encoding: 'utf-8', timeout: 10_000 }, (err, stdout) => {
        if (err) {
          reject(new Error(`Failed to list compose containers: ${err.message}`))
          return
        }
        // docker compose ps --format json outputs one JSON object per line
        const lines = stdout.trim().split('\n').filter(Boolean)
        if (lines.length === 0) {
          reject(new Error('No running containers found in compose project'))
          return
        }
        try {
          const container = JSON.parse(lines[0])
          resolve(container.ID || container.Id)
        } catch {
          reject(new Error('Failed to parse compose container info'))
        }
      })
    })
  }

  /**
   * List all services in a compose project with their status.
   */
  _composeServices(project) {
    return new Promise((resolve) => {
      this._execFile('docker', [
        'compose', '-p', project, 'ps', '--format', 'json',
      ], { encoding: 'utf-8', timeout: 10_000 }, (err, stdout) => {
        if (err) {
          log.warn(`Failed to list compose services for project "${project}": ${err.message}`)
          resolve([])
          return
        }
        try {
          const lines = stdout.trim().split('\n').filter(Boolean)
          const services = lines.map(line => {
            const c = JSON.parse(line)
            return {
              name: c.Service || c.Name,
              status: c.State || 'unknown',
              primary: false,
            }
          })
          resolve(services)
        } catch (parseErr) {
          log.warn(`Failed to parse compose services for project "${project}": ${parseErr.message}`)
          resolve([])
        }
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
