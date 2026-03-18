import { spawn, execFile } from 'child_process'
import { SdkSession } from './sdk-session.js'
import { createLogger } from './logger.js'

const log = createLogger('docker-sdk')

/**
 * Env vars explicitly forwarded into the Docker container.
 * Only vars needed for Claude Code operation — never forward the full host env.
 *
 * This list is intentionally narrower than DockerSession's allowlist.
 * The SDK manages permissions in-process (no external hook HTTP calls),
 * so CLI-specific vars like CHROXY_PORT, CHROXY_HOOK_SECRET,
 * CHROXY_PERMISSION_MODE, and CLAUDE_HEADLESS are not needed.
 * HOME and PATH are set explicitly in _createSpawnCallback() rather
 * than forwarded from the host.
 *
 * See also: DockerSession.FORWARDED_ENV_KEYS in docker-session.js
 */
const FORWARDED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'NODE_ENV',
]

/**
 * Default container CLI path for globally-installed Claude Code.
 * Resolved dynamically after install; this is the fallback.
 */
const DEFAULT_CONTAINER_CLI_PATH = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'

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
    this._containerId = null
    this._image = opts.image || 'node:22-slim'
    this._memoryLimit = opts.memoryLimit || '2g'
    this._cpuLimit = opts.cpuLimit || '2'
    const user = opts.containerUser || 'chroxy'
    if (!VALID_USERNAME_RE.test(user)) {
      throw new Error(`Invalid containerUser "${user}" — must match POSIX username rules`)
    }
    this._containerUser = user
    this._containerCliPath = null
  }

  /**
   * Start the session: launch the container, set up the non-root user,
   * install Claude Code, then call super.start() to mark ready.
   */
  start() {
    if (this._containerId) {
      super.start()
      return
    }

    this._startContainer((err) => {
      if (err) {
        this.emit('error', { message: `Failed to start Docker container: ${err.message}` })
        this.destroy()
        return
      }
      super.start()
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
        callback(new Error(stderr ? stderr.trim() : err.message))
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
   * Critical: The SDK passes the HOST's absolute path to cli.js as args[0].
   * Inside the container that path doesn't exist -- we remap to the container's
   * installed path.
   */
  _createSpawnCallback() {
    const containerId = this._containerId
    const containerCliPath = this._containerCliPath || DEFAULT_CONTAINER_CLI_PATH
    const containerUser = this._containerUser
    const hostCwd = this.cwd || process.cwd()

    return (options) => {
      const { command, args, cwd, env, signal } = options

      const dockerArgs = ['exec', '-i', '-u', containerUser]

      // Remap host cwd to container mount point — the SDK passes the host's
      // absolute path but the container only has /workspace
      if (cwd) {
        const containerCwd = cwd.startsWith(hostCwd)
          ? '/workspace' + cwd.slice(hostCwd.length)
          : '/workspace'
        dockerArgs.push('--workdir', containerCwd)
      }

      // Forward only allowlisted env vars -- never leak the whole host env
      for (const key of FORWARDED_ENV_KEYS) {
        const val = env?.[key]
        if (val !== undefined) {
          dockerArgs.push('--env', `${key}=${val}`)
        }
      }

      // Override HOME and PATH for the container user
      dockerArgs.push('--env', `HOME=/home/${containerUser}`)
      dockerArgs.push('--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')

      // Remap host paths in args to container paths
      const containerCommand = command
      const containerArgs = [...args]

      if (containerArgs.length > 0 && containerArgs[0].includes('claude')) {
        log.info(`Remapped CLI path: ${args[0]} -> ${containerCliPath}`)
        containerArgs[0] = containerCliPath
      }

      dockerArgs.push(containerId, containerCommand, ...containerArgs)

      log.info(`Docker exec: ${containerId.slice(0, 12)} ${containerCommand} ${containerArgs.slice(0, 2).join(' ')}...`)

      const child = spawn('docker', dockerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      // Log stderr for debugging
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim()
        if (text) log.info(`container stderr: ${text}`)
      })

      // Wire up abort signal
      if (signal) {
        signal.addEventListener('abort', () => {
          if (!child.killed) {
            child.kill('SIGTERM')
          }
        }, { once: true })
      }

      return child
    }
  }

  /**
   * Destroy the session: interrupt active query, remove the container,
   * and clean up SdkSession state.
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

// Re-export the forwarded env keys and default CLI path for testing
export { FORWARDED_ENV_KEYS, DEFAULT_CONTAINER_CLI_PATH }
