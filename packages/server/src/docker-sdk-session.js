import { execFile } from 'child_process'
import { SdkSession } from './sdk-session.js'
import { createLogger } from './logger.js'
import { classifyDockerError, CONTAINER_VANISHED, CONTAINER_VANISHED_MESSAGE, probeContainerGone, surfaceContainerVanished } from './docker-session.js'
import { DockerBackend, FORWARDED_ENV_KEYS, DEFAULT_CONTAINER_CLI_PATH } from './environments/backends/docker.js'
import { BILLING_CLASSES } from './billing-class.js'
import { VALID_USERNAME_RE } from './utils/validation-patterns.js'

const log = createLogger('docker-sdk')

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
    // #6767: the transcript for a containerized session lives inside the
    // container, so the host-side conversation fork can't reach it — restore
    // degrades to files-only here (mirrors the instance-level
    // `supportsConversationFork` getter below). Advertise conversationFork:false
    // so the checkpoint UI disables the "Conversation" restore-mode option.
    return { ...SdkSession.capabilities, containerized: true, conversationFork: false }
  }

  /**
   * #6766: the SDK transcript for a containerized session lives inside the
   * container (`~/.claude/projects` in the container's filesystem), not on the
   * host where the standalone `forkSession` reads. So a host-side conversation
   * fork can't reach it — restore degrades to a files-only rewind here.
   */
  get supportsConversationFork() {
    return false
  }

  /**
   * Preflight credentials block — overrides SdkSession's host-side spec (#4780).
   *
   * Mirror of DockerSession.preflight — see that class for the full rationale.
   * The container has no ~/.claude state and the host Keychain is invisible,
   * so `claude login` is futile inside the container. Only `ANTHROPIC_API_KEY`
   * gets forwarded (see `_startContainer` and `DockerBackend.FORWARDED_ENV_KEYS`),
   * so it is the only env var we advertise here — listing CLAUDE_CODE_OAUTH_TOKEN
   * would falsely report ready when the container would still be unauthed.
   */
  static get preflight() {
    const parent = SdkSession.preflight
    return {
      ...parent,
      credentials: {
        envVars: ['ANTHROPIC_API_KEY'],
        hint: 'set ANTHROPIC_API_KEY on the host so it is forwarded into the container (no OAuth fallback inside the container — the container has no ~/.claude state)',
        optional: true,
      },
    }
  }

  /**
   * Resolve runtime auth state for the dashboard (#4769, #4780).
   *
   * Mirror of DockerSession.resolveAuth — overrides SdkSession's OAuth
   * fallback because the container has no ~/.claude state, so env var is
   * the only valid path. See DockerSession for the full rationale.
   *
   * @param {NodeJS.ProcessEnv} env
   * @returns {{ready:boolean, source:string, envVar:string|null, envVars:string[], hint:string, detail:string, billingClass:string}}
   */
  static resolveAuth(env) {
    const credSpec = this.preflight.credentials
    const envVars = credSpec.envVars
    const hint = credSpec.hint

    // docker-sdk forwards the host's ANTHROPIC_API_KEY into the container and
    // has NO OAuth fallback, so it always bills the raw API account — api-key,
    // era-independent. The host subscription/credit pool never applies inside
    // the container.
    const matched = envVars.find(v => env[v])
    if (matched) {
      return {
        ready: true,
        source: 'env',
        envVar: matched,
        envVars,
        hint: '',
        detail: `Docker-isolated — Anthropic API (your ${matched})`,
        billingClass: BILLING_CLASSES.API_KEY,
      }
    }
    return {
      ready: false,
      source: 'none',
      envVar: null,
      envVars,
      hint,
      detail: 'Not configured — set ANTHROPIC_API_KEY on the host (forwarded into the container at run time). No OAuth fallback inside the container — the container has no ~/.claude state.',
      billingClass: BILLING_CLASSES.API_KEY,
    }
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
    // #7601 — the CONTAINER_VANISHED idempotency latch (see surfaceContainerVanished).
    this._containerVanishedNotified = false
    // #3468 + #3501: `_stdinForwardingDisabled` is initialised by the
    // SdkSession parent constructor from the `stdinForwardingDisabled` opt
    // (see #3540 + #3576 — restored sessions hydrate the latched flag via
    // SessionManager.restoreState). Do NOT reassign here: a hard `= false`
    // would clobber the hydrated value on cold restart and silently re-arm
    // stdin forwarding for a session the previous run had already latched
    // off, defeating the persistence introduced in PR #3564.
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
   *
   * #3468: When the backend returns a SidecarProcess-shaped EventEmitter (i.e.
   * K8sBackend after a WS reconnect), stdin forwarding can become permanently
   * disabled mid-turn. The proc emits a one-shot `'stdin_disabled'` signal at
   * that point — subscribe so the loss is observable instead of silent.
   */
  _createSpawnCallback() {
    const backend = this._backend || (this._backend = new DockerBackend())
    const containerId = this._containerId
    const containerCliPath = this._containerCliPath || DEFAULT_CONTAINER_CLI_PATH
    const containerUser = this._containerUser
    const hostCwd = this.cwd || process.cwd()

    return (options) => {
      const { command, args, cwd, env, signal } = options
      const proc = backend.streamCliInEnvironment(containerId, {
        cmd: command,
        args,
        env,
        cwd,
        signal,
        containerUser,
        containerCliPath,
        hostCwd,
      })
      // Attach default warn-log listeners for SidecarProcess stdin failure
      // signals (#3402, #3468, #3474).  Docker procs are plain ChildProcess
      // and never fire these events; the helper is a no-op on them so this
      // is safe to wire unconditionally.  Note: a K8s session class (when
      // it lands) would extend SdkSession directly, not DockerSdkSession,
      // so it must call `_attachSidecarProcessListeners` from its own
      // spawn path — the helper lives on SdkSession precisely so any
      // subclass can reuse it.
      this._attachSidecarProcessListeners(proc)
      return proc
    }
  }

  /**
   * #7599 — classify a turn failure as a vanished container (overrides the
   * SdkSession no-op).
   *
   * A containerized turn runs `docker exec` into the session's container; when
   * the container has been stopped / restarted / removed underneath the live
   * session (including a plain `docker stop` performed OUTSIDE chroxy), that exec
   * fails and the SDK's query() rejects. The rejection message does NOT carry the
   * docker stderr, so we probe the container directly and treat only a confirmed
   * container-gone as a vanish — an API/model error with a healthy container
   * falls through to the generic surface.
   *
   * Never nulls `_containerId` (the #7561 fresh-container trap): the session
   * stays bound so a returning env container can be reconnected (#7602). On the
   * next turn a still-gone container re-detects and re-surfaces once more; it is
   * never resurrected onto the host or a fresh default container.
   *
   * @param {Error} _err
   * @returns {Promise<{code:string,message:string,recoverable:boolean}|null>}
   */
  async _classifyContainerFailure(_err) {
    if (!this._containerId) return null
    const gone = await this._probeContainerGone()
    if (!gone) return null
    // #7601: latch so a proactive liveness-poll tick doesn't ALSO surface this
    // same vanish. The SDK reactive path still RETURNS the payload for
    // SdkSession to emit (its deliberate per-turn re-surface is unchanged — the
    // latch gates only the poll, not this return), so a still-gone container
    // re-surfaces on the next turn exactly as in #7599.
    this._containerVanishedNotified = true
    // Only `code` (+ `message`) survives the generic error normalizer to the
    // wire; the code is the surfaced signal (reconnectability is a #7602
    // server-side decision, not a wire flag).
    return {
      code: CONTAINER_VANISHED,
      message: CONTAINER_VANISHED_MESSAGE,
    }
  }

  /**
   * #7601 — surface a CONTAINER_VANISHED error once for this session (idempotent).
   * Called by the proactive liveness poll / environment_stopped fast-path; the
   * shared latch keeps it from double-emitting with the reactive turn-reject path.
   * @returns {boolean} true if it emitted
   */
  notifyContainerVanished() {
    return surfaceContainerVanished(this)
  }

  /**
   * #7601 — reset the CONTAINER_VANISHED latch after the container is observed
   * running again, so a later vanish re-surfaces. Called by the liveness poll on
   * a healthy inspect.
   *
   * #7602 — returns whether this call actually FLIPPED the latch (the gone→
   * running recovery edge), symmetric with `notifyContainerVanished`'s "true if
   * it emitted". That edge, and only that edge, drives the live re-attach in
   * `SessionManager._reattachEnvironmentBoundSession`.
   *
   * @returns {boolean} true when the latch transitioned
   */
  clearContainerVanished() {
    if (!this._containerVanishedNotified) return false
    this._containerVanishedNotified = false
    return true
  }

  /**
   * #7602 — the live re-attach contract: re-affirm this session's binding to an
   * environment container that has come back, so the next turn's `docker exec`
   * resumes inside it.
   *
   * Why the SDK provider is the one that has this: an `environmentId` create is
   * forced to `provider: 'docker-sdk'` (`handlers/session-handlers.js`), env
   * containers are launched NAMED and WITHOUT `--rm`, so they survive a stop and
   * keep their id — the only reconnect target there is. `DockerSession`'s and a
   * self-owned `DockerSdkSession`'s containers are `--rm` and are REMOVED when
   * they stop; those stay terminal / fail-visible-only, which is why
   * `_containerOwned` is refused below and why `DockerSession` exposes no
   * `reattachContainer` at all (the SessionManager feature-detects this method
   * exactly the way #7601 feature-detects `notifyContainerVanished`).
   *
   * There is no in-container process to respawn — a containerized turn spawns a
   * fresh `docker exec` per query via `_createSpawnCallback`, which reads
   * `_containerId` / `_containerCliPath` / `_containerUser` at spawn time. So a
   * re-attach is exactly: confirm the binding still points at the container the
   * environment owns, and refresh the exec parameters. The caller has already
   * checked the id against the live `EnvironmentManager`; the equality check
   * here is defence in depth, and it is what makes "never a new container" (the
   * #7561 trap) true at BOTH layers.
   *
   * `_containerId` is never nulled and never widened to a different container:
   * a stop/start preserves the container's writable layer, so the in-container
   * `claude` install, the non-root user and the SDK transcript under its HOME
   * are all still there and the resumed turn is genuinely the same conversation.
   * A DIFFERENT id would be a REBUILT container with none of that — resuming
   * into it would silently produce a blank session, which is the one outcome
   * #7602 must not accept. Hence: refuse, and stay fail-visible.
   *
   * @param {{containerId?: string, containerUser?: string, containerCliPath?: string}} binding
   * @returns {boolean} true when the binding was re-affirmed
   */
  reattachContainer(binding = {}) {
    if (this._destroying) return false
    // A self-owned `--rm` container is terminal — it cannot come back, and
    // re-binding one would be the #7561 fresh-container trap by another route.
    if (this._containerOwned) return false
    // The `typeof` test is load-bearing, not defensive dressing: it is what
    // keeps a non-string `containerId` from throwing on `.trim()`.
    const containerId = typeof binding.containerId === 'string' ? binding.containerId.trim() : ''
    // ONE clause, deliberately. The binding must name EXACTLY the container this
    // session is already in; a missing, blank or non-string id normalises to ''
    // and can never equal a real container id, and `_containerId` is never ''
    // (the constructor maps a blank to null, and a null id means
    // `_containerOwned`, already refused above). An extra "is it empty" test
    // would be a guard nothing could ever make fail — see
    // docs/false-safety-guards.md.
    if (containerId !== this._containerId) return false

    const cliPath = typeof binding.containerCliPath === 'string' ? binding.containerCliPath.trim() : ''
    if (cliPath) this._containerCliPath = cliPath
    const user = typeof binding.containerUser === 'string' ? binding.containerUser.trim() : ''
    // Same validation the constructor applies — a re-attach must not be a way to
    // smuggle an unvalidated username into the `docker exec --user` argv. The
    // constructor THROWS here; a re-attach cannot (it would strand a session over
    // a field it does not need), so it keeps the existing user — but says so,
    // rather than dropping the update silently.
    if (user && !VALID_USERNAME_RE.test(user)) {
      log.warn(`Ignoring invalid containerUser "${user}" on re-attach — keeping "${this._containerUser}"`)
    } else if (user) {
      this._containerUser = user
    }

    log.info(`Re-attached to container ${this._containerId.slice(0, 12)} — next turn resumes inside it`)
    return true
  }

  /**
   * Probe whether the bound container is gone via `docker exec <id> true`.
   * Delegates to the shared `probeContainerGone` helper (same probe the
   * docker-cli path uses). Resolves true ONLY on a container-gone classification;
   * a healthy probe, a dead daemon, or any other failure resolves false.
   *
   * @returns {Promise<boolean>}
   */
  _probeContainerGone() {
    return probeContainerGone(this._containerId)
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
