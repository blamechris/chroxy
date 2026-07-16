import { execFile, spawn } from 'child_process'
import { createLogger } from '../../logger.js'
import { VALID_USERNAME_RE } from '../../utils/validation-patterns.js'
import { getChroxyHostEnv } from '../../chroxy-host-metadata.js'

const log = createLogger('docker-backend')

const DEFAULT_CONTAINER_CLI_PATH = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'

/**
 * #6155 — first-class docker labels stamped on the chroxy resources created via
 * `docker run` (`_startContainer`) and `docker commit` (`_commitContainer`), so
 * the Control Room host-prune survey can identify them by label (robust) with the
 * legacy name/tag convention (`chroxy-env-*` / `chroxy-env:` / `chroxy-byok-snap:`)
 * as a fallback. NOTE: compose-managed containers (`_composeUp` → `docker compose
 * up`) do NOT receive these CLI `--label` flags — they're covered by the
 * `chroxy-env-*` name fallback instead (their compose project is `chroxy-env-<id>`).
 * `MANAGED` marks ownership; `KIND` distinguishes a live env container from a
 * committed snapshot image. Kept here (the producer) and imported by
 * `control-room/host-prune.js`.
 */
export const CHROXY_MANAGED_LABEL = 'com.chroxy.managed'
export const CHROXY_LABEL_KIND = 'com.chroxy.kind'

/**
 * #5127 — Cap on the per-stream buffer the streaming execInEnvironment path
 * retains for the resolved value / failure tail. The buffered execFile path
 * rejects past Node's 1 MB maxBuffer; the streaming path used to accumulate
 * without limit, so a postCreateCommand that printed hundreds of MB grew the
 * daemon's retained buffer unbounded.
 *
 * We keep the LAST N bytes (the tail) because the failure event only surfaces
 * a 4 KiB tail (POST_CREATE_OUTPUT_CAP_BYTES in docker-byok-session.js) and
 * diagnostic info (the actual exception, exit codes) lands at the end. 256 KiB
 * is comfortably larger than the 4 KiB failure tail while staying bounded.
 *
 * onData STILL fires for every chunk — streaming is not truncated, only the
 * retained accumulator is capped.
 */
const STREAM_RETAINED_BUFFER_CAP_BYTES = 256 * 1024

/**
 * #5126 — Grace period after a SIGTERM-on-timeout before escalating to
 * SIGKILL. A child that ignores SIGTERM (or is stuck uninterruptibly) would
 * otherwise leave the streaming promise pending forever, since it only settles
 * on the subsequent `close`.
 */
const STREAM_SIGKILL_GRACE_MS = 5_000

/**
 * Append `chunk` to `buf` keeping at most `cap` UTF-16 code units (the tail).
 * Uses string length as a cheap proxy for byte size — exact byte accounting
 * isn't required since the value is a diagnostic tail and the downstream
 * failure event re-caps to 4 KiB. A multibyte sequence clipped at the cut
 * boundary decodes to U+FFFD, which is acceptable for a tail.
 */
function appendCapped(buf, chunk, cap = STREAM_RETAINED_BUFFER_CAP_BYTES) {
  const next = buf + chunk
  if (next.length <= cap) return next
  return next.slice(next.length - cap)
}

/**
 * Env vars explicitly forwarded into the container during streamCliInEnvironment.
 * Mirrors the allowlist in docker-sdk-session.js — keep both in sync.
 *
 * Only vars needed for Claude Code operation; never forward the full host env.
 * HOME and PATH are set explicitly per-call rather than forwarded from the host.
 */
const FORWARDED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'NODE_ENV',
]

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
    const { cwd, composeFile, composeProject, containerUser, primaryService, envFile } = opts

    await this._composeUp(composeFile, composeProject, cwd, envFile)

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
  // stop / start / restart — standalone-container lifecycle (#6134)
  //
  // Unlike `_removeContainer` (which swallows so a teardown never blocks), these
  // REJECT on failure so the EnvironmentManager / containers_action handler can
  // surface a CONTAINER_ACTION_FAILED to the operator rather than silently
  // claiming success.
  // ─────────────────────────────────────────────────────────────────────────

  /** @returns {Promise<void>} */
  stopEnvironment(containerId) {
    return this._dockerLifecycle('stop', containerId)
  }

  /** @returns {Promise<void>} */
  startEnvironment(containerId) {
    return this._dockerLifecycle('start', containerId)
  }

  /** @returns {Promise<void>} */
  restartEnvironment(containerId) {
    return this._dockerLifecycle('restart', containerId)
  }

  _dockerLifecycle(verb, containerId) {
    return new Promise((resolve, reject) => {
      this._execFile('docker', [verb, containerId], { stdio: 'ignore' }, (err) => {
        if (err) {
          log.warn(`docker ${verb} ${containerId.slice(0, 12)} failed: ${err.message}`)
          reject(new Error(`docker ${verb} failed: ${err.message}`))
          return
        }
        resolve()
      })
    })
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
   * @param {{ cmd: string, env?: Object.<string,string>, envFile?: string, cwd?: string, timeout?: number, user?: string, onData?: (chunk: string, stream: 'stdout'|'stderr') => void }} opts
   * @returns {Promise<{ stdout: string, stderr: string }>}
   *
   * opts.onData — OPTIONAL streaming callback (#5069). When provided, the
   * command runs via a streaming `spawn` instead of the buffered `execFile`,
   * and `onData(chunk, 'stdout'|'stderr')` is invoked with each decoded chunk
   * as bytes arrive. This lets a caller surface progress for multi-minute
   * setups (npm install, apt-get) instead of staring at a silent dashboard.
   * The buffered last-N-KiB tail is STILL accumulated and attached to the
   * rejected Error on failure (#5067 contract preserved), so streaming and
   * the failure-tail capture coexist. When `onData` is absent the original
   * buffered `execFile` path is used unchanged — every existing caller keeps
   * its exact behaviour.
   *
   * opts.env — all key/value pairs are forwarded as `--env KEY=VAL` flags.
   * Entries whose value is null or undefined are skipped with a `log.warn`
   * (caller mistake — passing them would produce `KEY=null` / `KEY=undefined`
   * which is hard to debug; the warn surfaces it in server logs without
   * breaking the call).  All other values are coerced to String explicitly.
   * No allowlist filter is applied here: unlike streamCliInEnvironment (which
   * runs the long-lived Claude Code CLI and must never leak the full host env),
   * execInEnvironment is a general-purpose helper invoked with an explicit env
   * object constructed by the caller. The caller is responsible for passing only
   * the vars required for the command. process.env is never consulted.
   *
   * opts.envFile — forwarded as `--env-file <path>`. Useful for secrets that
   * must not appear in `ps` output (`docker exec --env KEY=secret` exposes
   * the value in the process listing). The file format follows Docker's own
   * env file spec: one `KEY=VALUE` pair per line, no quoting required.
   * Callers are responsible for creating the file with 0600 permissions and
   * unlinking it when no longer needed. docker-byok (#5079) uses this to
   * forward `ANTHROPIC_API_KEY` into compose-managed containers without
   * exposing the key in argv.
   *
   * opts.cwd — forwarded as `--workdir <cwd>`.  The path must already be an
   * absolute path *inside* the container; callers are responsible for remapping
   * host paths to container paths if necessary.
   *
   * opts.user — forwarded as `-u <user>` so the command runs as a non-root
   * container user. Validated against the same POSIX username regex as
   * `streamCliInEnvironment` to refuse shell-injection payloads. Optional
   * for backward compatibility (docker-sdk's CLI bootstrap path runs as
   * root for `npm install -g`, then `streamCliInEnvironment` switches to
   * the non-root user for the long-lived Claude process). docker-byok
   * (#5021) passes it for every tool dispatch so file ops respect the
   * `useradd` + `chown /workspace` setup done at container start.
   */
  execInEnvironment(containerId, { cmd, env, envFile, cwd, timeout = 30_000, user, onData } = {}) {
    return new Promise((resolve, reject) => {
      const execArgs = ['exec']

      if (user) {
        // Refuse anything but a POSIX username so a caller-supplied string
        // can't smuggle a `docker exec` flag (VALID_USERNAME_RE is shared).
        if (!VALID_USERNAME_RE.test(user)) {
          reject(new Error(`Invalid user "${user}" — must match POSIX username rules`))
          return
        }
        execArgs.push('-u', user)
      }

      if (cwd) {
        execArgs.push('--workdir', cwd)
      }

      if (envFile) {
        execArgs.push('--env-file', envFile)
      }

      if (env) {
        for (const [key, val] of Object.entries(env)) {
          if (val == null) {
            // Caller-provided key is JSON-encoded before interpolation to prevent
            // log forging via embedded control characters (newlines, ANSI escapes).
            log.warn(`execInEnvironment: skipping null/undefined value for env key ${JSON.stringify(key)}`)
            continue
          }
          execArgs.push('--env', `${key}=${String(val)}`)
        }
      }

      execArgs.push(containerId, 'bash', '-c', cmd)

      // #5069 — Streaming path. When the caller supplies `onData`, run the
      // command via `spawn` so stdout/stderr surface incrementally as bytes
      // arrive (long-running setup like `npm install` / `apt-get`). We still
      // accumulate the full stdout/stderr so the resolved value and the
      // failure-tail attached to the rejected Error (#5067) are identical to
      // the buffered path. When `onData` is absent we keep the original
      // `execFile` call untouched for every existing caller.
      if (typeof onData === 'function') {
        const child = this._spawn('docker', execArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

        let stdout = ''
        let stderr = ''
        let settled = false
        let timedOut = false
        let timer = null
        // #5126 — SIGKILL escalation timer, armed only after the SIGTERM-on-
        // timeout fires. Cleared on close so a child that exits promptly never
        // gets force-killed.
        let killTimer = null

        const settle = (fn, arg) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          if (killTimer) clearTimeout(killTimer)
          fn(arg)
        }

        if (timeout && timeout > 0) {
          timer = setTimeout(() => {
            timedOut = true
            // SIGTERM the docker exec wrapper so we don't leak the process
            // on a stuck setup. Matches execFile's `timeout` semantics.
            if (child && !child.killed) {
              try { child.kill('SIGTERM') } catch { /* already gone */ }
            }
            // #5126 — Escalate to SIGKILL if the child ignores SIGTERM. The
            // promise otherwise only settles on `close`; a child stuck in an
            // uninterruptible state would leave it pending forever. Cleared on
            // close via settle(); unref'd so it never holds the loop open.
            //
            // Gate on `!settled` (the `close` hasn't fired) rather than
            // `!child.killed`: Node flips `child.killed` to true the moment a
            // signal is *delivered*, even if the process keeps running, so a
            // `!child.killed` guard would skip the SIGKILL on exactly the
            // stuck-child case this is meant to handle.
            killTimer = setTimeout(() => {
              if (!settled && child) {
                try { child.kill('SIGKILL') } catch { /* already gone */ }
              }
            }, STREAM_SIGKILL_GRACE_MS)
            if (killTimer && typeof killTimer.unref === 'function') killTimer.unref()
          }, timeout)
          // Don't let the timeout keep the event loop alive on its own.
          if (timer && typeof timer.unref === 'function') timer.unref()
        }

        if (child.stdout) {
          child.stdout.setEncoding('utf-8')
          child.stdout.on('data', (chunk) => {
            // #5127 — retain a bounded tail, not the full stream. onData still
            // fires for every chunk below (streaming is never truncated).
            stdout = appendCapped(stdout, chunk)
            // Never let an onData throw escape and orphan the child.
            try { onData(chunk, 'stdout') } catch { /* listener error — ignore */ }
          })
        }
        if (child.stderr) {
          child.stderr.setEncoding('utf-8')
          child.stderr.on('data', (chunk) => {
            stderr = appendCapped(stderr, chunk)
            try { onData(chunk, 'stderr') } catch { /* listener error — ignore */ }
          })
        }

        child.on('error', (err) => {
          // spawn failure (docker binary missing, etc.) — surface with the
          // same enriched-Error shape the buffered path uses.
          const wrapped = new Error(stderr ? stderr.trim() : err.message)
          wrapped.stdout = stdout
          wrapped.stderr = stderr
          if (err.code) wrapped.code = err.code
          settle(reject, wrapped)
        })

        child.on('close', (code, signal) => {
          if (timedOut) {
            const err = new Error(`Command timed out after ${timeout}ms`)
            err.killed = true
            err.signal = signal || 'SIGTERM'
            err.stdout = stdout
            err.stderr = stderr
            settle(reject, err)
            return
          }
          if (code === 0) {
            settle(resolve, { stdout, stderr })
            return
          }
          // Non-zero exit — mirror the buffered-path enriched Error so the
          // #5067 stdout/stderr capture is preserved for the failure event.
          const wrapped = new Error(stderr ? stderr.trim() : `Command exited with code ${code}`)
          wrapped.stdout = stdout
          wrapped.stderr = stderr
          if (code != null) wrapped.code = code
          if (signal) wrapped.signal = signal
          settle(reject, wrapped)
        })
        return
      }

      this._execFile('docker', execArgs, { encoding: 'utf-8', timeout }, (err, stdout, stderr) => {
        if (err) {
          // #5067 — Preserve both captured streams on failure. The error
          // message stays stderr-first (existing callers rely on that
          // shape for log lines), but we attach raw `stdout` / `stderr`
          // properties so the caller can surface BOTH streams in a
          // user-facing error event without re-running the command.
          //
          // npm install, repo bootstrap scripts, and apt-get commonly
          // print the actually-useful diagnostic on stdout; dropping it
          // here turned every post-create failure into a guess-and-retry.
          //
          // Falls through to err.message when stderr is empty, matching
          // the pre-#5067 behaviour for stderr-silent commands. The
          // post-create caller in docker-byok-session.js applies its own
          // POST_CREATE_OUTPUT_CAP_BYTES truncation before serialising
          // into the error event payload.
          const wrapped = new Error(stderr ? stderr.trim() : err.message)
          wrapped.stdout = stdout || ''
          wrapped.stderr = stderr || ''
          if (err.code) wrapped.code = err.code
          if (err.signal) wrapped.signal = err.signal
          if (typeof err.killed === 'boolean') wrapped.killed = err.killed
          reject(wrapped)
        } else {
          resolve({ stdout: stdout || '', stderr: stderr || '' })
        }
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
   * Security hardening (must match `_createSpawnCallback` in docker-sdk-session.js):
   *   - `containerUser` is honored via `docker exec -u <user>` (never run as root)
   *   - Only env vars in `FORWARDED_ENV_KEYS` are forwarded from `opts.env`
   *   - `HOME` / `PATH` are set explicitly for the container user
   *   - The host's absolute path to `cli.js` (passed as `args[0]` by the SDK) is
   *     remapped to the container's installed CLI path
   *   - The host `cwd` is remapped to the container mount point (`/workspace`)
   *   - stderr is logged for debugging
   *
   * `docker-sdk-session.js#_createSpawnCallback` delegates here so there is a
   * single source of truth for the docker-exec invocation shape.
   *
   * @param {string} containerId
   * @param {Object} opts  - See Backend interface in types.js
   * @param {string}   opts.cmd
   * @param {string[]} [opts.args]
   * @param {Object.<string,string>} [opts.env]
   * @param {string}   [opts.cwd]            - Host CWD (remapped to container path)
   * @param {AbortSignal} [opts.signal]
   * @param {string}   [opts.containerUser]  - Non-root user inside the container (default: 'chroxy')
   * @param {string}   [opts.containerCliPath] - Container path to claude-code CLI (default fallback)
   * @param {string}   [opts.hostCwd]        - Host CWD mount root (default: opts.cwd)
   * @returns {import('child_process').ChildProcess}
   */
  streamCliInEnvironment(containerId, opts = {}) {
    const {
      cmd, args = [], env, cwd, signal,
      containerUser = 'chroxy',
      containerCliPath = DEFAULT_CONTAINER_CLI_PATH,
      hostCwd,
    } = opts

    const dockerArgs = ['exec', '-i', '-u', containerUser]

    // Remap host cwd to container mount point — the SDK passes the host's
    // absolute path but the container only has /workspace.
    if (cwd) {
      const mountRoot = hostCwd || cwd
      const containerCwd = cwd.startsWith(mountRoot)
        ? '/workspace' + cwd.slice(mountRoot.length)
        : '/workspace'
      dockerArgs.push('--workdir', containerCwd)
    }

    // Forward only allowlisted env vars — never leak the whole host env.
    if (env) {
      for (const key of FORWARDED_ENV_KEYS) {
        const val = env[key]
        if (val !== undefined) {
          dockerArgs.push('--env', `${key}=${val}`)
        }
      }
    }
    // #6633: also forward Chroxy's own (non-sensitive) host identity so an agent
    // INSIDE the container can answer "what build am I in?". Sourced from the
    // authoritative computed block (not `env`), so it lands regardless of how the
    // caller built its env.
    for (const [key, val] of Object.entries(getChroxyHostEnv())) {
      dockerArgs.push('--env', `${key}=${val}`)
    }

    // Override HOME and PATH for the container user.
    dockerArgs.push('--env', `HOME=/home/${containerUser}`)
    dockerArgs.push('--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')

    // Remap host cli.js path to container path (SDK passes host's absolute path).
    const containerArgs = [...args]
    if (containerArgs.length > 0 &&
        typeof containerArgs[0] === 'string' &&
        containerArgs[0].includes('@anthropic-ai/claude-code/cli.js')) {
      log.info(`Remapped CLI path: ${containerArgs[0]} -> ${containerCliPath}`)
      containerArgs[0] = containerCliPath
    }

    dockerArgs.push(containerId, cmd, ...containerArgs)

    log.info(`docker exec stream: ${containerId.slice(0, 12)} ${cmd} ${containerArgs.slice(0, 2).join(' ')}`)

    const child = (this._spawn || spawn)('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Log stderr for debugging.
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim()
        if (text) log.info(`container stderr: ${text}`)
      })
    }

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
        // #6155: first-class ownership labels (survey identity, name as fallback).
        '--label', `${CHROXY_MANAGED_LABEL}=true`,
        '--label', `${CHROXY_LABEL_KIND}=env`,
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
      // #6155: stamp ownership labels onto the committed snapshot image (both env
      // snapshots and BYOK pool snapshots commit through here) via `--change LABEL`,
      // so host-prune can identify it by label with the `chroxy-*` tag as fallback.
      const commitArgs = [
        'commit',
        '--change', `LABEL ${CHROXY_MANAGED_LABEL}=true`,
        '--change', `LABEL ${CHROXY_LABEL_KIND}=snapshot`,
        containerId, imageTag,
      ]
      this._execFile('docker', commitArgs, { encoding: 'utf-8', timeout: 120_000 }, (err, stdout, stderr) => {
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
      // --no-trunc is required: without it, `docker ps -q` returns 12-char
      // truncated IDs that never match the full 64-char IDs persisted by
      // createEnvironment, causing reconcile() to destroy every known
      // container as an "orphan" (#3314).
      this._execFile('docker', [
        'ps', '-q', '--no-trunc', '--filter', 'name=chroxy-env',
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

  // #5124: `composeFile` may be a single path or an ARRAY of paths
  // (devcontainer.json `dockerComposeFile` base + overrides). Normalise a
  // lone string to a single-element array and drop non-string/empty entries
  // so every call site emits `-f <file>` flags in declared order.
  // Backward-compatible: existing single-file callers pass a string and get
  // one `-f`.
  _composeFileList(composeFile) {
    const files = Array.isArray(composeFile) ? composeFile : [composeFile]
    return files.filter((f) => typeof f === 'string' && f.length > 0)
  }

  _composeUp(composeFile, project, cwd, envFile) {
    return new Promise((resolve, reject) => {
      // `docker compose --env-file <path>` (before the subcommand) sets the
      // env used for compose-file interpolation, so a compose service that
      // declares `environment: [ANTHROPIC_API_KEY]` or `${ANTHROPIC_API_KEY}`
      // picks the value up without the operator having to hand-edit their
      // compose file. The file is short-lived (tmpfile created + unlinked
      // by the caller) and lives at 0600 so the key never appears in `ps`
      // output. (#5079)
      //
      // #5124: compose merges a base + overrides via a repeated `-f` flag in
      // DECLARED ORDER (later files override earlier ones), so we emit one
      // `-f <file>` per entry rather than a single `-f`.
      const files = this._composeFileList(composeFile)
      // Fail fast on an empty/invalid file set rather than letting
      // `docker compose up` silently fall back to a default compose file in
      // cwd. The pre-#5124 single-`-f` path errored on an undefined file, so
      // this preserves that fail-fast contract for the array path too.
      if (files.length === 0) {
        reject(new Error('docker compose up requires at least one compose file'))
        return
      }
      const args = ['compose']
      if (envFile) args.push('--env-file', envFile)
      for (const file of files) {
        args.push('-f', file)
      }
      args.push('-p', project, 'up', '-d')
      this._execFile('docker', args, { encoding: 'utf-8', timeout: 120_000, cwd }, (err, _stdout, stderr) => {
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
      // #5124: tear the stack down with the SAME `-f` file set used to bring
      // it up, in declared order, so the merged config resolves identically.
      const args = ['compose']
      for (const file of this._composeFileList(composeFile)) {
        args.push('-f', file)
      }
      args.push('-p', project, 'down', '--remove-orphans')
      this._execFile('docker', args, { encoding: 'utf-8', timeout: 30_000, cwd }, (err) => {
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

// Re-exported for parity with docker-sdk-session.js and for tests
export { FORWARDED_ENV_KEYS, DEFAULT_CONTAINER_CLI_PATH }
