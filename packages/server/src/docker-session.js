import { spawn, execFile } from 'child_process'
import { createInterface } from 'readline'
import { CliSession } from './cli-session.js'
import { createLogger } from './logger.js'
import { BILLING_CLASSES } from './billing-class.js'
import { getChroxyHostEnv } from './chroxy-host-metadata.js'

const log = createLogger('docker-session')

/**
 * #7599 — the error `code` a containerized session emits when it detects that
 * its container has vanished underneath a live turn (stopped / restarted /
 * killed, including a plain `docker stop` performed OUTSIDE chroxy). Distinct
 * from a code crash (`cli_respawn_exhausted`) and from a dead daemon: the
 * container is gone but the daemon and the session live on, so the session is
 * kept (not dropped) for the reconnect that acts on it (#7602). Rides the
 * existing error rails — it is emitted as an `error` event and the generic
 * normalizer (event-normalizer.js) forwards its `code` to clients unchanged (the
 * same path `cli_respawn_exhausted` / `stream_stall` / `resume_unknown` use), so
 * no wire change is needed.
 */
export const CONTAINER_VANISHED = 'CONTAINER_VANISHED'

/**
 * #7599/#7601 — the single message surfaced with a CONTAINER_VANISHED error, on
 * every path that detects a vanish (reactive exec-close, reactive turn-reject,
 * the proactive liveness poll, and the environment_stopped/restarted fast-path).
 * One const so those four sites cannot drift on the wording (the
 * adjacent-field-wire-cap lesson).
 */
export const CONTAINER_VANISHED_MESSAGE =
  'The container for this session is no longer running (it may have been stopped, restarted, or removed).'

/**
 * #7601 — surface CONTAINER_VANISHED on a containerized session AT MOST ONCE per
 * vanish. Idempotent via the session's `_containerVanishedNotified` latch so the
 * proactive liveness poll (which re-checks the same container every interval)
 * and the reactive close path cannot double-emit for one vanish. The latch is
 * reset by `clearContainerVanished` when a poll later observes the container
 * running again, so a stop → start → stop cycle re-surfaces on the second stop.
 *
 * Suppressed (returns false, emits nothing) when the session is tearing down
 * (emitting on a destroy()'d EventEmitter throws — #7599 review), when it has
 * already been notified, or when no container is bound. NEVER nulls
 * `_containerId` (the #7561 trap: an absent id reads as owned → a fresh default
 * container). Returns true only when it actually emitted.
 *
 * @param {import('events').EventEmitter & {_destroying?:boolean, _containerVanishedNotified?:boolean, _containerId?:string|null}} session
 * @returns {boolean}
 */
export function surfaceContainerVanished(session) {
  if (session._destroying || session._containerVanishedNotified || !session._containerId) return false
  session._containerVanishedNotified = true
  session.emit('error', { code: CONTAINER_VANISHED, message: CONTAINER_VANISHED_MESSAGE })
  return true
}

/**
 * #7601 — the liveness verdict the proactive poll acts on, derived from a
 * `docker inspect` of a single container (backend.getEnvironmentStatus →
 * _inspectContainer). Returns one of:
 *   'running' — inspect reports `State.Running: true`
 *   'gone'    — the container is STOPPED (`Running: false`) OR REMOVED (inspect
 *               rejects with a container-missing error)
 *   'unknown' — any OTHER failure (Docker daemon down, timeout, permission)
 *
 * The 'unknown' bucket is load-bearing: a naive "inspect rejected → gone" would
 * turn a transient Docker-daemon outage into a CONTAINER_VANISHED surfaced on
 * EVERY containerized session at once. So a rejection is classified with the
 * SAME `classifyDockerError` the reactive probe uses — only a positively
 * recognised container-missing error is 'gone'; `docker_not_running` and
 * anything unrecognised are 'unknown' and the poll leaves the session untouched
 * (the #7599 daemon-down guard, applied to the poll).
 *
 * `docker inspect` reports a removed container as `no such object` (verified
 * against the CLI) — distinct from `docker exec`'s `No such container` that
 * `classifyDockerError` already matches — so that phrasing is recognised here
 * explicitly.
 *
 * @param {(containerId: string) => Promise<boolean>} getStatus backend.getEnvironmentStatus
 * @param {string} containerId
 * @returns {Promise<'running'|'gone'|'unknown'>}
 */
export async function inspectContainerLiveness(getStatus, containerId) {
  try {
    const running = await getStatus(containerId)
    return running ? 'running' : 'gone'
  } catch (err) {
    const { code } = classifyDockerError(err, err?.stderr || '')
    if (code === 'container_gone') return 'gone'
    const combined = `${err?.message || ''} ${err?.stderr || ''}`.toLowerCase()
    if (combined.includes('no such object') || combined.includes('no such container')) return 'gone'
    return 'unknown'
  }
}

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
    combined.includes('pull access denied') ||
    combined.includes('repository does not exist') ||
    (combined.includes('not found') && combined.includes('image'))
  ) {
    const imageMatch = combined.match(/(?:no such image:\s*|pull access denied for\s+)['"]?([a-z0-9][a-z0-9._\/-]*(?::[a-z0-9._-]+)?)/)
    const imageName = imageMatch ? imageMatch[1] : null
    const message = imageName
      ? `Docker image '${imageName}' not found. Run: docker pull ${imageName}`
      : 'Docker image not found. Run: docker pull <image>'
    return { code: 'docker_image_not_found', message }
  }
  // #7599: the container is gone — stopped, restarted, or removed. Docker reports
  // `Container <id> is not running` for a stopped one and `No such container` for
  // a removed one. `is not running` REQUIRES `container` alongside it so a generic
  // "<daemon/service> is not running" can't false-match a vanished container
  // (#7604 Copilot review). Checked AFTER the daemon + image buckets (whose
  // patterns don't overlap these) and BEFORE the generic fallback.
  if (
    combined.includes('no such container') ||
    (combined.includes('is not running') && combined.includes('container'))
  ) {
    return { code: 'container_gone', message: 'The container for this session is no longer running (it may have been stopped, restarted, or removed).' }
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
 * #7599 — actively probe whether a container is gone by running
 * `docker exec <id> true` and classifying the PROBE's own stderr (pure
 * docker-client output — never the session's application stderr). Resolves
 * `true` only on a `container_gone` classification; a healthy probe, a dead
 * daemon, or any other error resolves `false` (not a per-container vanish).
 *
 * This is the reliable container-liveness signal both exec-based session paths
 * use — the docker-sdk path because the SDK's query rejection does not carry the
 * docker stderr, and the docker-cli path because the exec child's merged stderr
 * mixes docker-client errors with the app's own output (so trusting it produced
 * both false positives and false negatives — #7599 review).
 *
 * @param {string} containerId
 * @param {Function} [exec] injectable execFile-shaped fn (for tests)
 * @returns {Promise<boolean>}
 */
export function probeContainerGone(containerId, exec = execFile) {
  return new Promise((resolve) => {
    if (!containerId) return resolve(false)
    exec('docker', ['exec', containerId, 'true'], { encoding: 'utf-8', timeout: 10_000 }, (err, _stdout, stderr) => {
      if (!err) return resolve(false)
      const { code } = classifyDockerError(err, stderr || err.stderr || '')
      resolve(code === 'container_gone')
    })
  })
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

// #7337: `CHROXY_PERMISSION_MODE_FILE` is DELIBERATELY absent from the list
// above, and must stay absent until the sidecar is actually reachable from
// inside the container.
//
// CliSession creates the sidecar under the HOST's tmpdir and publishes its
// path in the child env, so `permission-hook.sh` can re-read the live
// permission mode on every tool call instead of the spawn-frozen
// CHROXY_PERMISSION_MODE. A container has its own filesystem and `docker exec`
// cannot add a mount (mounts are fixed at `docker run`), so forwarding the key
// would name a host path that does not exist in the container. The hook's
// `[ -r ... ]` guard makes that fall back to CHROXY_PERMISSION_MODE — correct,
// but only by accident, and it would read as "containers have the live channel"
// when they do not.
//
// The consequence is that a containerized CLI session still needs the respawn
// to pick up a mode change, exactly as before #7337. Giving it the live channel
// needs a bind mount established in `_startContainer()`; tracked separately.
// tests/cli-permission-mode-sidecar.test.js pins the omission (with a
// CHROXY_PERMISSION_MODE positive control) so it cannot be "fixed" by adding
// the key alone. NOT docker-session.test.js — that file drives a hand-written
// mirror of _spawnPersistentProcess and never reads the real array.

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

  /**
   * Preflight credentials block — overrides CliSession's host-side spec (#4780).
   *
   * Inside a container `claude login` cannot work: there is no ~/.claude OAuth
   * state and the host Keychain is invisible. The only valid path is the
   * `ANTHROPIC_API_KEY` env var, which `_startContainer` forwards via
   * `docker run --env`. CLAUDE_CODE_OAUTH_TOKEN is intentionally NOT in
   * `envVars` — _startContainer does not forward it, so claiming the OAuth
   * token satisfies auth would mislead the dashboard into reporting ready
   * for a container that would still fail to authenticate.
   */
  static get preflight() {
    const parent = CliSession.preflight
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
   * Docker container providers forward process.env.ANTHROPIC_API_KEY to
   * the container at `docker run` time (see _startContainer). Inside the
   * container there is no ~/.claude OAuth state, so the env var is the
   * only auth path — no OAuth fallback even though the host-side preflight
   * marks credentials as optional. Overrides CliSession's "subscription
   * always" branch — container providers do not bill the host's subscription.
   *
   * @param {NodeJS.ProcessEnv} env
   * @returns {{ready:boolean, source:string, envVar:string|null, envVars:string[], hint:string, detail:string, billingClass:string}}
   */
  static resolveAuth(env) {
    const credSpec = this.preflight.credentials
    const envVars = credSpec.envVars
    const hint = credSpec.hint

    // docker-cli forwards the host's ANTHROPIC_API_KEY into the container and
    // has NO OAuth fallback (the container has no ~/.claude state), so it
    // always bills the raw API account — api-key, era-independent. The host's
    // subscription/programmatic-credit pool never applies inside the container.
    const billingClass = BILLING_CLASSES.API_KEY
    const matched = envVars.find(v => env[v])
    if (matched) {
      return {
        ready: true,
        source: 'env',
        envVar: matched,
        envVars,
        hint: '',
        detail: `Anthropic API (forwarded to container) (${matched} set)`,
        billingClass,
      }
    }
    return {
      ready: false,
      source: 'none',
      envVar: null,
      envVars,
      hint,
      detail: 'Not configured — set ANTHROPIC_API_KEY on the host (forwarded into the container at run time). No OAuth fallback inside the container — the container has no ~/.claude state.',
      billingClass,
    }
  }

  constructor(opts = {}) {
    super(opts)
    this._containerId = null
    this._image = opts.image || 'node:22-slim'
    this._memoryLimit = opts.memoryLimit || '2g'
    this._cpuLimit = opts.cpuLimit || '2'
    // #7601 — the CONTAINER_VANISHED idempotency latch (see surfaceContainerVanished).
    this._containerVanishedNotified = false
  }

  /**
   * #7601 — surface a CONTAINER_VANISHED error once for this session (idempotent).
   * Called by the reactive exec-close path AND the proactive liveness poll /
   * environment_stopped fast-path; the shared latch keeps them from double-emitting.
   * @returns {boolean} true if it emitted
   */
  notifyContainerVanished() {
    return surfaceContainerVanished(this)
  }

  /**
   * #7601 — reset the CONTAINER_VANISHED latch after the container is observed
   * running again, so a later vanish re-surfaces. Called by the liveness poll on
   * a healthy inspect.
   */
  clearContainerVanished() {
    this._containerVanishedNotified = false
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
   * Spawn seam (#7374).
   *
   * Exists so a test can observe the argv `_spawnPersistentProcess` ACTUALLY
   * builds. Before this, the rule that `CHROXY_PERMISSION_MODE_FILE` must not
   * reach the container was pinned only by a source-level grep of the
   * `FORWARDED_ENV_KEYS` literal — which stays green when a key is pushed into
   * `dockerArgs` OUTSIDE the allowlist loop. That is not hypothetical: there
   * are already two such explicit pushes immediately below the loop
   * (`CHROXY_HOST`, `getChroxyHostEnv()`), so the allowlist is demonstrably not
   * the only way in.
   *
   * Kept as a one-line override point rather than a constructor opt so it adds
   * no BaseSession opt to forward (see BASE_SESSION_OPT_KEYS and
   * scripts/lint-session-opt-forwarding.sh).
   */
  _spawnDocker(dockerArgs) {
    return spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
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
    // #6633: forward Chroxy's own (non-sensitive) host identity so an agent
    // INSIDE the container can still answer "what build am I in?". Sourced from
    // the authoritative computed block; the `CHROXY_HOST_` prefix (trailing
    // underscore) is distinct from the permission-hook `CHROXY_HOST` routing var
    // above.
    for (const [key, val] of Object.entries(getChroxyHostEnv())) {
      dockerArgs.push('--env', `${key}=${val}`)
    }

    dockerArgs.push(this._containerId, 'claude', ...claudeArgs)

    log.info(`Exec into container ${this._containerId.slice(0, 12)} (model: ${this.model || 'default'})`)

    const child = this._spawnDocker(dockerArgs)

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

    child.on('close', (code) => this._handleChildClose(code))

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

  // #4473: log the container-specific exit line under the docker-session
  // namespace before delegating to the inherited handler (#4469). The
  // inherited code emits its own "Process exited" line; this override
  // lands first so `docker logs <ctr>` correlation by operators stays easy.
  _handleChildClose(code) {
    if (!this._destroying && !this._respawning) {
      log.info(`Container exec exited (code ${code})`)
    }
    super._handleChildClose(code)
  }

  /**
   * #7599 — container-vanish hook (overrides CliSession's no-op).
   *
   * Called by CliSession._handleChildClose for a genuine unexpected exit — i.e.
   * AFTER the intentional-stop and resume-unknown branches have returned, and
   * just BEFORE the generic "exited unexpectedly → respawn" tail. Returns a
   * Promise, so the base defers the generic respawn until it resolves.
   *
   * It ACTIVELY PROBES the container (`docker exec <id> true`) rather than
   * trusting the closed exec's merged stderr: that stream mixes docker-client
   * errors with the app's own stderr, so a benign app line containing "is not
   * running" would have falsely suppressed the respawn, and an in-flight kill
   * (exit 137, no docker-client line) would have been missed on the first close
   * (#7599 review). The probe classifies pure docker-client output and is the
   * same signal the docker-sdk path uses.
   *
   * On a confirmed vanish it surfaces one coded CONTAINER_VANISHED session error
   * and resolves `true` so the respawn is suppressed — respawning a `docker exec`
   * into a stopped/removed container would only flap toward `cli_respawn_exhausted`.
   * The session is deliberately NOT torn down and `_containerId` is NOT nulled
   * (the #7561 trap: a null id reads as `_containerOwned` and would launch a fresh
   * default container), so the reconnect path (#7602) can re-attach an env-backed
   * container that returns.
   *
   * Returns a plain `false` synchronously when there is no container to probe
   * (so a no-container close respawns inline, exactly as before), and a
   * `Promise<boolean>` only when it actually probes.
   *
   * @param {number} code exit code of the closed exec child
   * @returns {boolean|Promise<boolean>} true if handled as a vanish (suppress respawn)
   */
  _handleContainerGoneOnClose(code) {
    if (!this._containerId) return false
    return this._probeContainerGone().then((gone) => {
      // Re-check teardown after the async probe: a destroy() that lands in the
      // probe window has already removed listeners, so emitting here would fire
      // on a dead EventEmitter (Node throws on an unhandled 'error') — #7599 review.
      if (!gone || this._destroying) return this._destroying
      ;(this._log || log).warn(
        `Container for this session is gone (exec exit ${code}) — surfacing CONTAINER_VANISHED, not respawning`,
      )
      // #7601: route through the shared idempotent surface so a proactive
      // liveness-poll tick that already surfaced this vanish can't be
      // double-emitted here (and vice-versa). Only `code` (+ `message`) reach
      // clients — the generic error normalizer caps adjacent fields, so the CODE
      // is the surfaced signal; reconnectability is a #7602 server-side decision.
      // Suppress the respawn on a confirmed vanish regardless of whether the
      // latch had already fired.
      this.notifyContainerVanished()
      return true
    })
  }

  /**
   * Probe whether the bound container is gone. Extracted as an instance method
   * so tests can stub it. Delegates to the shared `probeContainerGone` helper.
   * @returns {Promise<boolean>}
   */
  _probeContainerGone() {
    return probeContainerGone(this._containerId)
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
