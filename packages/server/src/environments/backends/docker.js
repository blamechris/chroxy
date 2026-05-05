import { execFile, spawn } from 'child_process'
import { createLogger } from '../../logger.js'

const log = createLogger('docker-backend')

const DEFAULT_CONTAINER_CLI_PATH = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'

/**
 * DockerBackend implements the Backend interface (see types.js) using the local
 * Docker CLI (`docker` / `docker compose`).
 *
 * This class owns ALL Docker shellout operations.  It has no environment state
 * of its own — every method receives the handle (containerId or compose project
 * name) from the manager's in-memory record.
 *
 * Injecting `_execFile` in the constructor lets existing tests pass their
 * mock execFile through EnvironmentManager → DockerBackend without any test
 * changes.
 */
export class DockerBackend {
  constructor({ _execFile: injectedExecFile, _spawn: injectedSpawn } = {}) {
    this._execFile = injectedExecFile || execFile
    this._spawn = injectedSpawn || spawn
  }

  // ─────────────────────────────────────────────────────────────────────────
  // createEnvironment — start a standalone container + run setup
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * @param {Object} opts - See Backend interface in types.js
   * @returns {Promise<{ containerId: string, containerCliPath: string }>}
   */
  async createEnvironment(opts) {
    const { envId, cwd, image, memoryLimit, cpuLimit, containerUser,
      containerEnv, forwardPorts, mounts, postCreateCommand } = opts

    const containerId = await this._startContainer({
      envId, cwd, image, memoryLimit, cpuLimit, containerEnv, forwardPorts, mounts,
    })

    let containerCliPath
    try {
      await this._setupContainer(containerId, containerUser)
      containerCliPath = await this._discoverCliPath(containerId)
      if (postCreateCommand) {
        await this._runPostCreateCommand(containerId, postCreateCommand)
      }
    } catch (err) {
      log.warn(`Environment setup failed, removing container ${containerId.slice(0, 12)}: ${err.message}`)
      await this._removeContainer(containerId)
      throw err
    }

    return { containerId, containerCliPath }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // createComposeEnvironment — start a compose stack + setup primary service
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * @param {Object} opts - See Backend interface in types.js
   * @returns {Promise<{ containerId: string, containerCliPath: string, services: Array }>}
   */
  async createComposeEnvironment(opts) {
    const { cwd, composeFile, composeProject, containerUser, primaryService } = opts

    await this._composeUp(composeFile, composeProject, cwd)

    let containerId
    try {
      containerId = await this._composePrimaryContainerId(composeProject, primaryService)
    } catch (err) {
      log.warn(`Failed to identify primary container, tearing down: ${err.message}`)
      await this._composeDown(composeFile, composeProject, cwd)
      throw err
    }

    let containerCliPath
    try {
      await this._setupContainer(containerId, containerUser)
      containerCliPath = await this._discoverCliPath(containerId)
    } catch (err) {
      log.warn(`Compose environment setup failed, tearing down: ${err.message}`)
      await this._composeDown(composeFile, composeProject, cwd)
      throw err
    }

    const services = await this._composeServices(composeProject)

    return { containerId, containerCliPath, services }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // destroyEnvironment — force-remove a standalone container
  // ─────────────────────────────────────────────────────────────────────────

  /** @returns {Promise<void>} */
  destroyEnvironment(containerId) {
    return this._removeContainer(containerId)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // destroyComposeEnvironment — tear down a compose stack
  // ─────────────────────────────────────────────────────────────────────────

  /** @returns {Promise<void>} */
  destroyComposeEnvironment({ composeFile, composeProject, cwd }) {
    return this._composeDown(composeFile, composeProject, cwd)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // removeImage — delete a local Docker image
  // ─────────────────────────────────────────────────────────────────────────

  /** @returns {Promise<void>} */
  removeImage(imageTag) {
    return this._removeImage(imageTag)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // execInEnvironment — run a shell command inside a container
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * @param {string} containerId
   * @param {{ cmd: string, env?: Object, cwd?: string, timeout?: number }} opts
   * @returns {Promise<{ stdout: string, stderr: string }>}
   */
  execInEnvironment(containerId, { cmd, timeout = 30_000 }) {
    return new Promise((resolve, reject) => {
      this._execFile('docker', [
        'exec', containerId, 'bash', '-c', cmd,
      ], { encoding: 'utf-8', timeout }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr ? stderr.trim() : err.message))
        else resolve({ stdout: stdout || '', stderr: stderr || '' })
      })
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // streamCliInEnvironment — spawn a long-lived process, return ChildProcess
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Spawn a process inside the container via `docker exec -i` and return the
   * ChildProcess directly.  Node's ChildProcess satisfies the SpawnedProcess
   * interface (stdout/stderr/stdin streams + 'exit' event) that the SDK expects.
   *
   * @param {string} containerId
   * @param {Object} opts  - See Backend interface in types.js
   * @returns {import('child_process').ChildProcess}
   */
  streamCliInEnvironment(containerId, { cmd, args = [], env, cwd, signal } = {}) {
    const dockerArgs = ['exec', '-i']

    if (cwd) {
      dockerArgs.push('--workdir', cwd)
    }

    if (env) {
      for (const [key, value] of Object.entries(env)) {
        dockerArgs.push('--env', `${key}=${value}`)
      }
    }

    dockerArgs.push(containerId, cmd, ...args)

    log.info(`docker exec stream: ${containerId.slice(0, 12)} ${cmd} ${args.slice(0, 2).join(' ')}`)

    const child = (this._spawn || spawn)('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    if (signal) {
      if (signal.aborted) {
        child.kill('SIGTERM')
      } else {
        signal.addEventListener('abort', () => {
          if (!child.killed) child.kill('SIGTERM')
        }, { once: true })
      }
    }

    return child
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getEnvironmentStatus — inspect a container for running state
  // ─────────────────────────────────────────────────────────────────────────

  /** @returns {Promise<boolean>} */
  getEnvironmentStatus(containerId) {
    return this._inspectContainer(containerId)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // listEnvironments — enumerate all chroxy-env-* containers
  // ─────────────────────────────────────────────────────────────────────────

  /** @returns {Promise<string[]>} */
  listEnvironments() {
    return this._listChroxyContainers()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // commitEnvironment — docker commit (snapshot)
  // ─────────────────────────────────────────────────────────────────────────

  /** @returns {Promise<string>} image SHA */
  commitEnvironment(containerId, imageTag) {
    return this._commitContainer(containerId, imageTag)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // renameEnvironment — rename a container (used during atomic restore)
  // ─────────────────────────────────────────────────────────────────────────

  /** @returns {Promise<void>} */
  renameEnvironment(containerId, newName) {
    return this._renameContainer(containerId, newName)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // restoreEnvironment — start a snapshot image without re-running setup
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * @param {Object} opts - See Backend interface in types.js
   * @returns {Promise<string>} Full container ID of the newly-started container
   */
  restoreEnvironment(opts) {
    return this._startContainer(opts)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private Docker shellout helpers
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
}
