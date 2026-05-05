import { execFile } from 'child_process'
import { SdkSession } from './sdk-session.js'
import { createLogger } from './logger.js'
import { classifyDockerError } from './docker-session.js'
import { DockerBackend, FORWARDED_ENV_KEYS, DEFAULT_CONTAINER_CLI_PATH } from './environments/backends/docker.js'

const log = createLogger('docker-sdk')

/**
 * Valid POSIX username: starts with lowercase letter or underscore,
 * followed by lowercase alphanumeric, underscore, or hyphen.
 */
const VALID_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/

/**
 * DockerSdkSession runs Claude Code inside an isolated Docker container
 * using the Agent SDK's spawnClaudeCodeProcess callback.
 *
 * Unlike DockerSession (which extends CliSession and uses `docker exec` to
 * run `claude -p` as a subprocess), this class extends SdkSession and injects
 * a custom `spawnClaudeCodeProcess` into the SDK's query() options. The SDK
 * manages the conversation loop in-process; only the actual CLI process is
 * containerized.
 *
 * Container lifecycle:
 *   start()   -> _startContainer() -> `docker run -d --init --rm ... sleep infinity`
 *             -> create non-root user
 *             -> install Claude Code CLI
 *   query()   -> spawnClaudeCodeProcess -> `docker exec -i <id> node <cli.js> ...`
 *   destroy() -> `docker rm -f <id>`
 *
 * Key findings from spike (#2472):
 *   1. The SDK passes host's absolute path to cli.js as args[0] -- must remap
 *   2. Claude Code refuses --dangerously-skip-permissions as root -- need non-root user
 *   3. Node's ChildProcess from spawn() satisfies SpawnedProcess interface natively
 */
export class DockerSdkSession extends SdkSession {
  static get capabilities() {
    return { ...SdkSession.capabilities, containerized: true }
  }

  constructor(opts = {}) {
    super(opts)
    const containerId = opts.containerId?.trim() || null
    const containerCliPath = opts.containerCliPath?.trim() || null
    this._containerId = containerId
    this._containerOwned = !containerId
    this._image = opts.image || 'node:22-slim'
    this._memoryLimit = opts.memoryLimit || '2g'
    this._cpuLimit = opts.cpuLimit || '2'
    const user = opts.containerUser || 'chroxy'
    if (!VALID_USERNAME_RE.test(user)) {
      throw new Error(`Invalid containerUser "${user}" — must match POSIX username rules`)
    }
    this._containerUser = user
    this._containerCliPath = containerCliPath
  }

  /**
   * Start the session: launch the container, set up the non-root user,
   * install Claude Code, then call super.start() to mark ready.
   *
   * When an external containerId was provided (containerOwned: false),
   * skips container creation and only discovers the CLI path if needed.
   */
  start() {
    if (this._containerId) {
      // External container — verify it's reachable, then discover CLI path if needed
      this._verifyContainer((err) => {
        if (err) {
          const classified = classifyDockerError(err)
          log.warn(`External container verification failed [${classified.code}]: ${classified.message}`)
          this.emit('error', { code: classified.code, message: classified.message })
          this.destroy()
          return
        }
        if (!this._containerCliPath) {
          this._discoverCliPath((discoverErr) => {
            if (discoverErr) {
              this._containerCliPath = DEFAULT_CONTAINER_CLI_PATH
              log.warn(`CLI path discovery failed on external container, using default: ${discoverErr.message}`)
            }
            super.start()
          })
          return
        }
        super.start()
      })
      return
    }

    this._startContainer((err) => {
      if (err) {
        this.emit('error', { code: err.code || 'docker_error', message: `Failed to start Docker container: ${err.message}` })
        this.destroy()
        return
      }
      super.start()
    })
  }

  /**
   * Verify that an external container is reachable via docker exec.
   * Fails fast if the container is not running or Docker is unavailable.
   */
  _verifyContainer(callback) {
    execFile('docker', [
      'exec', this._containerId, 'true',
    ], { encoding: 'utf-8', timeout: 10_000 }, (err, _stdout, stderr) => {
      if (err) {
        // Attach stderr so classifyDockerError can inspect it
        err.stderr = stderr || ''
        callback(err)
      } else {
        callback(null)
      }
    })
  }

  /**
   * Discover the CLI path on an existing container via npm prefix -g.
   * Used when connecting to an externally-managed container.
   */
  _discoverCliPath(callback) {
    execFile('docker', [
      'exec', this._containerId,
      'npm', 'prefix', '-g',
    ], { encoding: 'utf-8', timeout: 10_000 }, (prefixErr, prefixOut) => {
      if (!prefixErr && prefixOut) {
        this._containerCliPath = `${prefixOut.trim()}/lib/node_modules/@anthropic-ai/claude-code/cli.js`
        log.info(`Discovered container CLI path: ${this._containerCliPath}`)
        callback(null)
      } else {
        callback(prefixErr || new Error('Empty npm prefix output'))
      }
    })
  }

  /**
   * Launch a long-lived container with security constraints.
   * Uses async execFile to avoid blocking the event loop during image pull.
   */
  _startContainer(callback) {
    const runArgs = [
      'run', '-d', '--init', '--rm',
      '--memory', this._memoryLimit,
      '--cpus', this._cpuLimit,
      '--pids-limit', '512',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '-v', `${this.cwd || process.cwd()}:/workspace`,
      '-w', '/workspace',
    ]

    // Pass ANTHROPIC_API_KEY so Claude can authenticate
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (apiKey) {
      runArgs.push('--env', `ANTHROPIC_API_KEY=${apiKey}`)
    }

    // On Linux, host.docker.internal is not available by default
    if (process.platform === 'linux') {
      runArgs.push('--add-host', 'host.docker.internal:host-gateway')
    }

    runArgs.push(this._image, 'sleep', 'infinity')

    log.info(`Starting container (image: ${this._image}, memory: ${this._memoryLimit}, cpus: ${this._cpuLimit})`)

    execFile('docker', runArgs, { encoding: 'utf-8', timeout: 120_000 }, (err, stdout, stderr) => {
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

      // Create non-root user and install Claude Code
      this._setupContainer(callback)
    })
  }

  /**
   * Create a non-root user inside the container and install Claude Code CLI.
   * Claude Code refuses --dangerously-skip-permissions as root.
   */
  _setupContainer(callback) {
    const user = this._containerUser
    const setupCmd = [
      `useradd -m -s /bin/bash ${user}`,
      `chown ${user}:${user} /workspace`,
    ].join(' && ')

    execFile('docker', [
      'exec', this._containerId,
      'bash', '-c', setupCmd,
    ], { encoding: 'utf-8', timeout: 10_000 }, (err) => {
      if (err) {
        callback(new Error(`Failed to create container user: ${err.message}`))
        return
      }
      log.info(`Created non-root user "${user}" in container`)

      this._installClaudeCode(callback)
    })
  }

  /**
   * Install Claude Code CLI globally in the container and discover the CLI path.
   */
  _installClaudeCode(callback) {
    execFile('docker', [
      'exec', this._containerId,
      'npm', 'install', '-g', '@anthropic-ai/claude-code',
    ], { encoding: 'utf-8', timeout: 120_000 }, (installErr) => {
      if (installErr) {
        callback(new Error(`Failed to install Claude Code in container: ${installErr.message}`))
        return
      }
      log.info('Claude Code installed in container')

      // Discover the container's CLI path
      execFile('docker', [
        'exec', this._containerId,
        'npm', 'prefix', '-g',
      ], { encoding: 'utf-8', timeout: 10_000 }, (prefixErr, prefixOut) => {
        if (!prefixErr && prefixOut) {
          this._containerCliPath = `${prefixOut.trim()}/lib/node_modules/@anthropic-ai/claude-code/cli.js`
          log.info(`Container CLI path: ${this._containerCliPath}`)
        } else {
          this._containerCliPath = DEFAULT_CONTAINER_CLI_PATH
          log.warn(`Could not determine CLI path, using default: ${this._containerCliPath}`)
        }
        callback(null)
      })
    })
  }

  /**
   * Augment query options with the spawnClaudeCodeProcess callback.
   * Called by SdkSession.sendMessage() before passing options to query().
   */
  _augmentQueryOptions(options) {
    if (!this._containerId) {
      log.warn('No container ID — spawnClaudeCodeProcess will not be injected')
      return
    }
    options.spawnClaudeCodeProcess = this._createSpawnCallback()
  }

  /**
   * Create the spawnClaudeCodeProcess callback for the SDK.
   *
   * The SDK calls this with SpawnOptions { command, args, cwd, env, signal }
   * and expects a SpawnedProcess (Node ChildProcess satisfies this).
   *
   * Delegates to DockerBackend.streamCliInEnvironment so the docker-exec
   * invocation shape (containerUser, env allowlist, HOME/PATH, cli.js path
   * remap, stderr logging, abort wiring) has a single source of truth.
   */
  _createSpawnCallback() {
    const backend = this._backend || (this._backend = new DockerBackend())
    const containerId = this._containerId
    const containerCliPath = this._containerCliPath || DEFAULT_CONTAINER_CLI_PATH
    const containerUser = this._containerUser
    const hostCwd = this.cwd || process.cwd()

    return (options) => {
      const { command, args, cwd, env, signal } = options
      return backend.streamCliInEnvironment(containerId, {
        cmd: command,
        args,
        env,
        cwd,
        signal,
        containerUser,
        containerCliPath,
        hostCwd,
      })
    }
  }

  /**
   * Destroy the session: interrupt active query, optionally remove the container,
   * and clean up SdkSession state.
   *
   * When containerOwned is false (external container), the container is left
   * running — it's managed by EnvironmentManager or the caller.
   */
  destroy() {
    const containerId = this._containerId
    this._containerId = null

    super.destroy()

    if (containerId && this._containerOwned) {
      log.info(`Removing container ${containerId.slice(0, 12)}`)
      execFile('docker', ['rm', '-f', containerId], { stdio: 'ignore' }, (err) => {
        if (err) log.warn(`Failed to remove container ${containerId.slice(0, 12)}: ${err.message}`)
      })
    } else if (containerId) {
      log.info(`Disconnecting from external container ${containerId.slice(0, 12)} (not removing)`)
    }
  }
}

// Re-export the forwarded env keys and default CLI path for testing.
// Both are owned by ./environments/backends/docker.js — re-exported here for
// callers that import from docker-sdk-session.js.
export { FORWARDED_ENV_KEYS, DEFAULT_CONTAINER_CLI_PATH }
