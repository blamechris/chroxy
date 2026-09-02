import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'
import { execFile } from 'child_process'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { writeFileRestricted } from './platform.js'
import { createLogger } from './logger.js'
import { VALID_USERNAME_RE } from './utils/validation-patterns.js'
import { DockerBackend } from './environments/backends/docker.js'
import { configPath } from './config-dir.js'
import {
  parseDevContainer,
  validateMounts,
  sanitizeContainerEnv,
} from './devcontainer-config.js'
import { liveSessionsError } from './environments/destroy-with-sessions.js'

const log = createLogger('environment-manager')

function defaultStatePath() {
  return configPath('environments.json')
}
const DEFAULT_IMAGE = 'node:22-slim'
const DEFAULT_MEMORY_LIMIT = '2g'
const DEFAULT_CPU_LIMIT = '2'
const DEFAULT_CONTAINER_USER = 'chroxy'

// Re-export `UNREACHABLE_STATUSES` from the dedicated constants module so
// existing importers (tests, future consumers) continue to work. The
// canonical definition lives in `environment-statuses.js` so `server-cli.js`
// can pull the set without eagerly loading this module's `DockerBackend`
// transitive dependency — see the file header in environment-statuses.js.
export { UNREACHABLE_STATUSES } from './environment-statuses.js'

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
  /**
   * @param {Object}  [opts]
   * @param {string}  [opts.statePath] - On-disk path for environments.json
   * @param {Function} [opts._execFile] - Injected execFile (testing seam)
   * @param {Object}  [opts.backend]   - Pluggable backend (defaults to DockerBackend)
   * @param {Object}  [opts.workspacePVCDefault] - #4556: operator-configured
   *   PVC workspace strategy applied to every `create()` call that doesn't pass
   *   an explicit `opts.workspacePVC`. Wires the chroxy-config
   *   `environments.k8s.workspace` block into the manager. Shape mirrors
   *   `K8sBackend.validateWorkspacePVC()`: `{ claimName, mountPath?, readOnly? }`.
   *   Forwarded verbatim to the backend; non-K8s backends ignore it. Shape
   *   validation lives in `validateConfig()` at load-time and (defensively
   *   again) in `K8sBackend.validateWorkspacePVC()` at create-time — the
   *   manager performs no validation of its own.
   */
  constructor({ statePath, _execFile, backend, workspacePVCDefault } = {}) {
    super()
    this._statePath = statePath || defaultStatePath()
    this._environments = new Map()
    // Per-environment mutex: Map<envId, Promise> — serializes operations
    this._locks = new Map()
    // #7575 — ids of environments currently mid-teardown. An INTERNAL, never-
    // persisted marker (a Set, not an `env.status` value): `destroy()` adds an id
    // before its first teardown `await` and clears it in a `finally`, and
    // `getContainerInfo()` refuses a create while an id is present. It is NOT a
    // fourth `status` — the wire enum (`EnvironmentStatusSchema`) is closed to
    // running/stopped/error, and this marker is never serialized, so a client
    // snapshot never carries it and a crash mid-teardown clears it for free
    // (the Set is reconstructed empty on restart).
    this._destroying = new Set()
    // Injected for testing — falls back to real execFile.
    // _execFile is forwarded to DockerBackend so existing tests that inject a
    // mock execFile continue to work without modification.
    this._execFile = _execFile || execFile
    // Pluggable backend — defaults to DockerBackend with the same _execFile
    // so the existing _execFile test seam still reaches Docker shellouts.
    this._backend = backend || new DockerBackend({ _execFile: this._execFile })
    // #4556: configured PVC workspace default (operator surface). When set,
    // every create() that doesn't pass workspacePVC falls back to this value.
    // null when no `environments.k8s.workspace` block is configured.
    this._workspacePVCDefault = workspacePVCDefault ?? null
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
   * Look up a tracked environment by id, throwing the canonical
   * `Environment not found: <id>` error when it is absent. Callers that
   * want a graceful miss (e.g. session add/remove) check `_environments`
   * directly instead — this helper is only for the throw-on-missing paths.
   *
   * @param {string} envId
   * @returns {Object} the environment record
   */
  _getEnvironmentOrThrow(envId) {
    const env = this._environments.get(envId)
    if (!env) throw new Error(`Environment not found: ${envId}`)
    return env
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
   * @param {Object} [opts.resources] - K8s-only: structured resource requests/limits
   *   `{ cpu, memory, cpuLimit, memoryLimit }` (#3195). Forwarded verbatim to the backend;
   *   only K8sBackend acts on it (DockerBackend and others ignore it). On K8s these values
   *   take precedence over the flat `memoryLimit`/`cpuLimit` above; unset fields fall back to
   *   the backend's configured defaults.
   * @param {string} [opts.containerUser] - Non-root user (default: chroxy)
   * @param {Object} [opts.workspacePVC] - K8s-only: mount a pre-provisioned
   *   PersistentVolumeClaim as the workspace instead of the host `cwd` directory.
   *   See `K8sBackend.createEnvironment` (#3385) for the full shape and semantics
   *   (`{ claimName, mountPath?, readOnly? }`). Forwarded verbatim to the backend;
   *   DockerBackend and other non-K8s backends ignore it. Mutually exclusive with
   *   `opts.cwd`-as-hostPath on K8sBackend — the backend validates and throws.
   *
   *   #4556 — when the operator has configured `environments.k8s.workspace` in
   *   chroxy config (wired via the constructor's `workspacePVCDefault` option),
   *   a `create()` call that omits this field falls back to the configured
   *   default. An explicit value here always wins (per-call override surface
   *   for any future dashboard/CLI input).
   * @returns {Promise<Object>} The created environment object
   */
  async create({ name, cwd, image, memoryLimit, cpuLimit, resources, containerUser, compose, primaryService, devcontainer, workspacePVC } = {}) {
    if (!name?.trim()) throw new Error('Environment name is required')
    if (!cwd?.trim()) throw new Error('Environment cwd is required')

    // Merge devcontainer.json when requested (explicit opts win).
    // Parsing/validation logic lives in `devcontainer-config.js` so the
    // persistent-environment path here and the per-session DockerByokSession
    // path share one source of truth (#5077).
    let dcConfig = {}
    if (devcontainer) {
      dcConfig = parseDevContainer(cwd, { logger: log })
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

    // Validate devcontainer mounts and env before passing to Docker.
    // Shared helpers from `devcontainer-config.js` (#5077).
    const validatedMounts = validateMounts(dcConfig.mounts, cwd, { logger: log })
    const validatedEnv = sanitizeContainerEnv(dcConfig.containerEnv, { logger: log })

    // #4556: caller-supplied workspacePVC wins; otherwise fall back to the
    // configured default (when the operator has set `environments.k8s.workspace`
    // in chroxy config). Resolved here so the backend always sees the final
    // effective value and the manager remains the single wiring point.
    const effectiveWorkspacePVC = workspacePVC !== undefined ? workspacePVC : (this._workspacePVCDefault ?? undefined)

    const { containerId, containerCliPath } = await this._backend.createEnvironment({
      envId: id,
      cwd,
      image: resolvedImage,
      memoryLimit: resolvedMemory,
      cpuLimit: resolvedCpu,
      // #3195: structured K8s resource requests/limits, forwarded verbatim.
      // Only K8sBackend acts on it; the manager does no shape validation
      // (that lives in K8sBackend.buildResourceBlock). undefined → backend defaults.
      resources,
      containerUser: user,
      containerEnv: validatedEnv,
      forwardPorts: dcConfig.forwardPorts,
      mounts: validatedMounts,
      postCreateCommand: dcConfig.postCreateCommand,
      // #4548: forward verbatim — only K8sBackend acts on this. Manager does no
      // shape validation; that lives in K8sBackend.validateWorkspacePVC().
      // #4556: `effectiveWorkspacePVC` resolves the caller-vs-config-default
      // precedence so the backend sees a single value.
      workspacePVC: effectiveWorkspacePVC,
    })

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

    const { containerId, containerCliPath, services } = await this._backend.createComposeEnvironment({
      envId: id,
      cwd,
      composeFile: compose,
      composeProject,
      containerUser: user,
      primaryService,
    })

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
      const env = this._getEnvironmentOrThrow(envId)
      if (env.status !== 'running') throw new Error(`Environment "${env.name}" is not running (status: ${env.status})`)
      const snapshotId = 'snap-' + randomBytes(8).toString('hex')
      const timestamp = Date.now()
      const imageTag = `chroxy-env:${envId}-${timestamp}`

      log.info(`Creating snapshot "${name || snapshotId}" for environment "${env.name}"`)

      await this._backend.commitEnvironment(env.containerId, imageTag)

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
      const env = this._getEnvironmentOrThrow(envId)

      const snapshots = env.snapshots || []
      const snap = snapshots.find(s => s.id === snapshotId)
      if (!snap) throw new Error(`Snapshot not found: ${snapshotId}`)
      log.info(`Restoring environment "${env.name}" from snapshot "${snap.name}"`)

      const oldContainerId = env.containerId

      // Rename old container so the new one can reuse the chroxy-env-{envId} name
      await this._backend.renameEnvironment(oldContainerId, `chroxy-env-${envId}-old`)

      // Start new container from snapshot BEFORE removing old one.
      // Use restoreEnvironment (not createEnvironment) because the snapshot
      // image already has the user, CLI, and workspace baked in — re-running
      // full setup would fail on a pre-configured image.
      const containerId = await this._backend.restoreEnvironment({
        envId,
        cwd: env.cwd,
        image: snap.image,
        memoryLimit: env.memoryLimit || DEFAULT_MEMORY_LIMIT,
        cpuLimit: env.cpuLimit || DEFAULT_CPU_LIMIT,
      })

      // Health check: verify the new container is running
      let healthy = false
      try {
        healthy = await this._backend.getEnvironmentStatus(containerId)
      } catch (err) {
        log.warn(`Restore health check inspect failed for container ${containerId.slice(0, 12)}: ${err.message}`)
      }

      if (!healthy) {
        // New container failed — clean it up and preserve the old one
        log.warn(`Restore health check failed for new container ${containerId.slice(0, 12)}, rolling back`)
        await this._backend.destroyEnvironment(containerId)
        throw new Error(`Restored container health check failed for environment "${env.name}"`)
      }

      // New container is healthy — remove the old one
      await this._backend.destroyEnvironment(oldContainerId)

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
   *
   * #7562: REFUSES when sessions are still attached (`env.sessions` non-empty)
   * unless `force` is set. This is the server-side half of a guard that lived
   * only in the dashboard (`EnvironmentPanel`'s disabled Destroy button), so any
   * OTHER sender of the message — a stale dashboard tab, the Control Room's
   * `containers_action` (no UI guard at all), a script, any future client —
   * could `docker rm -f` the container out from under running sessions. (The
   * mobile app is not one of them today: it can put a session INTO an
   * environment via `create_session`'s `environmentId`, but it has no
   * environment-destroy surface. It is a potential victim of this, not a
   * perpetrator.) The check sits HERE, at the one chokepoint every
   * caller reaches, rather than in each handler: a per-caller check is the
   * "guard wired to only some of its callers" shape in
   * docs/false-safety-guards.md, which is precisely how `containers_action`
   * came to have no guard at all.
   *
   * `force` does NOT clean the sessions up — this class has no handle on the
   * SessionManager. The cascade (destroy the sessions cleanly, THEN the
   * environment) is `environments/destroy-with-sessions.js`, which is what both
   * handlers call. A direct `destroy(id, { force: true })` is the deliberate
   * "I know, take it down anyway" escape.
   *
   * @param {string} envId - Environment ID
   * @param {{force?: boolean}} [opts]
   * @throws {Error & {code: 'ENVIRONMENT_HAS_LIVE_SESSIONS', sessions: string[]}}
   *   when sessions are attached and `force` is not set. Nothing is torn down.
   */
  async destroy(envId, { force = false } = {}) {
    const release = await this._acquireLock(envId)
    try {
      const env = this._getEnvironmentOrThrow(envId)
      // #7562 — refuse BEFORE any teardown, so a refused destroy leaves the
      // container running and the environment registered.
      if (!force && Array.isArray(env.sessions) && env.sessions.length > 0) {
        log.warn(`Refusing to destroy environment "${env.name}" (${envId}): ${env.sessions.length} live session(s) attached`)
        throw liveSessionsError(env)
      }
      log.info(`Destroying environment "${env.name}" (${envId})`)

      // #7575 — mark the environment mid-teardown BEFORE the first `await`, while
      // this method still holds the lock and no other task can run. `destroy` is
      // async and YIELDS at the backend teardown below; a `create_session` that
      // begins during that yield would otherwise attach a session to a container
      // we are about to `docker rm -f` and an environment record we are about to
      // delete — a TOCTOU on the #7562 live-sessions guard, which saw zero
      // sessions and proceeded. Adding the id to `_destroying` here means such a
      // create's `getContainerInfo` is refused with the existing NOT_RUNNING-style
      // error — no new wire shape, and (unlike overloading `env.status`) no value
      // that could leak into the closed `EnvironmentStatusSchema` enum or persist.
      //
      // Why marking synchronously here is SUFFICIENT (and `addSession` is not
      // also gated): the create path reads the container info (the create
      // handler's `getContainerInfo`) and tags the env (`addSession`, via the
      // synchronous `SessionManager.createSession`) in ONE synchronous run — there
      // is no `await` between them — so that whole read→tag sequence is atomic
      // with respect to this method's yields. Every interleaving therefore
      // resolves safely: a create that ran entirely BEFORE this mark tagged the
      // env, so the #7562 check above saw the session and refused this destroy; a
      // create that starts AT OR AFTER this mark sees the env in `_destroying` at
      // `getContainerInfo` and is refused. There is no interleaving where
      // `getContainerInfo` passes AND `addSession` lands during teardown.
      //
      // LOAD-BEARING INVARIANT: that atomicity. If a future change inserts an
      // `await` between `getContainerInfo` and `addSession`, a create whose read
      // already passed could still `addSession` during this teardown, reopening
      // the window — close it then by re-checking `_destroying` inside
      // `addSession` (which runs synchronously and would observe this mark).
      this._destroying.add(envId)
      try {
        if (env.compose && env.composeProject) {
          await this._backend.destroyComposeEnvironment({
            composeFile: env.compose,
            composeProject: env.composeProject,
            cwd: env.cwd,
          })
        } else if (env.containerId) {
          // #6134: remove the container whenever one exists — NOT only when
          // status==='running'. Now that stop() makes 'stopped' a reachable state,
          // gating on 'running' would orphan a stopped container (the manager
          // entry is deleted but `docker rm -f` never runs). `docker rm -f` works
          // on stopped/exited containers too, and _removeContainer swallows a
          // "no such container" for one that never started.
          await this._backend.destroyEnvironment(env.containerId)
        }

        // Clean up snapshot images
        if (Array.isArray(env.snapshots)) {
          for (const snap of env.snapshots) {
            await this._backend.removeImage(snap.image)
          }
        }

        this._environments.delete(envId)
        this._persist()
        this.emit('environment_destroyed', { id: envId, name: env.name })
        log.info(`Environment "${env.name}" destroyed`)
      } finally {
        // Clear the marker on BOTH paths. On success the env is already gone, so
        // this only matters on failure: a teardown that threw left the env
        // registered and unchanged (nothing was deleted, `env.status` was never
        // touched), and clearing the mark makes it immediately re-enterable —
        // `getContainerInfo` stops refusing and a subsequent create succeeds.
        this._destroying.delete(envId)
      }
    } finally {
      release()
    }
  }

  /**
   * #6134 — stop a running standalone environment's container (the backing
   * container survives, so it can be restarted). Returns the resulting status.
   * No-op (returns the current status) when the environment is already stopped.
   *
   * Compose environments are not supported yet (a compose stack needs
   * `docker compose stop`, tracked as a follow-up) — they throw. Backends that
   * don't implement the lifecycle (k8s/rancher today) throw a clear error that
   * the handler surfaces as CONTAINER_ACTION_FAILED.
   */
  async stop(envId) {
    const release = await this._acquireLock(envId)
    try {
      const env = this._getEnvironmentOrThrow(envId)
      if (env.compose) throw new Error(`Stop is not supported for compose environments yet`)
      if (!env.containerId) throw new Error(`Environment "${env.name}" has no container to stop`)
      if (typeof this._backend.stopEnvironment !== 'function') {
        throw new Error(`Stop is not supported on this environment backend`)
      }
      if (env.status !== 'running') return env.status
      log.info(`Stopping environment "${env.name}" (${envId})`)
      await this._backend.stopEnvironment(env.containerId)
      env.status = 'stopped'
      this._persist()
      this.emit('environment_stopped', { id: envId, name: env.name })
      return env.status
    } finally {
      release()
    }
  }

  /**
   * #6134 — restart a standalone environment's container (works whether it is
   * currently running or stopped; ends running). Returns the resulting status.
   * Same compose / backend-support constraints as {@link stop}.
   */
  async restart(envId) {
    const release = await this._acquireLock(envId)
    try {
      const env = this._getEnvironmentOrThrow(envId)
      if (env.compose) throw new Error(`Restart is not supported for compose environments yet`)
      if (!env.containerId) throw new Error(`Environment "${env.name}" has no container to restart`)
      if (typeof this._backend.restartEnvironment !== 'function') {
        throw new Error(`Restart is not supported on this environment backend`)
      }
      log.info(`Restarting environment "${env.name}" (${envId})`)
      await this._backend.restartEnvironment(env.containerId)
      env.status = 'running'
      this._persist()
      this.emit('environment_restarted', { id: envId, name: env.name })
      return env.status
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
    const env = this._getEnvironmentOrThrow(envId)
    // #7575 — refuse a create against an environment whose teardown is already
    // in flight. `destroy()` adds the id to `_destroying` before its first
    // `await` (and clears it in a `finally`), so this closes the TOCTOU window
    // where `destroy` had passed the #7562 sessions check and was mid-`docker
    // rm -f`: without this, `getContainerInfo` returned live details and the
    // session attached to a container about to vanish. Same NOT_RUNNING-style
    // refusal — no new wire shape.
    if (this._destroying.has(envId)) throw new Error(`Environment "${env.name}" is not running (status: destroying)`)
    if (env.status !== 'running') throw new Error(`Environment "${env.name}" is not running (status: ${env.status})`)
    return {
      containerId: env.containerId,
      containerUser: env.containerUser,
      containerCliPath: env.containerCliPath,
    }
  }

  /**
   * Track a session connecting to an environment.
   *
   * #7552: called from `SessionManager.createSession` for every session created
   * with an `environmentId` — the production writer `env.sessions` spent its
   * whole life without. Idempotent; a no-op for an unknown environment (which
   * can be destroyed between the handler's `getContainerInfo` and the create).
   *
   * @param {string} envId
   * @param {string} sessionId
   */
  addSession(envId, sessionId) {
    const env = this._environments.get(envId)
    if (!env) return
    if (!env.sessions.includes(sessionId)) {
      env.sessions.push(sessionId)
      this._persist()
      this._emitSessionsChanged(env)
    }
  }

  /**
   * Track a session disconnecting from an environment.
   *
   * #7552: called from `SessionManager._cleanupSessionMaps` (the single funnel
   * every session takes OUT of `_sessions`) and from `destroyAll()`. A MISSED
   * detach is the inverse of the bug this wiring fixes — a stale id would make
   * the environment permanently undestroyable — so the caller side is pinned
   * path-by-path in `tests/environment-session-wiring.test.js`.
   *
   * @param {string} envId
   * @param {string} sessionId
   */
  removeSession(envId, sessionId) {
    const env = this._environments.get(envId)
    if (!env) return
    if (!env.sessions.includes(sessionId)) return
    env.sessions = env.sessions.filter(s => s !== sessionId)
    this._persist()
    this._emitSessionsChanged(env)
  }

  /**
   * #7552: announce that an environment's session tag CHANGED, so the WsServer
   * can re-broadcast `environment_list` and the dashboard's copy stays true.
   *
   * Without this the dashboard refreshes only when the Environments panel
   * mounts or an environment is created/destroyed — none of which is a session
   * lifecycle event. A destroy guard reading a stale `sessions.length` is the
   * same false safety by a different route, so the freshness is part of the fix
   * rather than a follow-up. Emitted only on a REAL change (a duplicate add or
   * an absent remove is silent) so a busy-but-unchanged daemon broadcasts
   * nothing.
   *
   * @param {Object} env
   * @private
   */
  _emitSessionsChanged(env) {
    this.emit('environment_sessions_changed', { id: env.id, sessions: [...env.sessions] })
  }

  /**
   * Reconnect to persisted environments on server restart.
   * Inspects each saved container and updates its status.
   *
   * INVARIANT (#3492): every code path that flips `allHealthy = false` MUST
   * also set `env.status` to a value in `UNREACHABLE_STATUSES` (currently
   * `'error'` or `'stopped'`). The set is consumed by the boot-path
   * aggregate-warn helper in
   * `server-cli.js#logEnvironmentManagerReconnectResult`, which derives the
   * unreachable count via
   * `list().filter(e => UNREACHABLE_STATUSES.has(e.status)).length`. A future
   * contributor adding a new `allHealthy = false` branch (quotas,
   * partial-restore, metrics check, …) without a co-located unreachable
   * status assignment would silently undercount and emit
   * `0 environment(s) unreachable` at boot. If a new unreachable status is
   * introduced (beyond `'error'`/`'stopped'`) it MUST be added to
   * `UNREACHABLE_STATUSES` so the aggregate warn stays accurate. The
   * invariant guard test in `tests/environment-manager.test.js` will fail CI
   * if the count of `allHealthy = false` branches drifts from the count of
   * unreachable status assignments.
   *
   * @returns {Promise<boolean>} `true` if every environment reconnected
   *   successfully; `false` if at least one environment was marked unreachable.
   *   An environment is considered unreachable when any of the following hold:
   *   - it has no `containerId` (status set to `'error'`)
   *   - `getEnvironmentStatus` reports the container is stopped (status set to `'stopped'`)
   *   - `getEnvironmentStatus` throws (status set to `'error'`)
   *   - `reconnectAgentToken` returns any non-`true` value, e.g. `false`
   *     (credential source GC'd) or `undefined` / `null` from a misbehaving
   *     backend (#3495) — status set to `'error'`
   *   - `reconnectAgentToken` throws (status set to `'error'`)
   */
  async reconnect() {
    this._restore()
    if (this._environments.size === 0) return true

    log.info(`Reconnecting to ${this._environments.size} persisted environment(s)`)

    let allHealthy = true

    for (const env of this._environments.values()) {
      // Clear the PREVIOUS process's session references unconditionally,
      // regardless of whether the environment's container is reachable,
      // stopped, or has no containerId at all. (#3494: this used to live at the
      // bottom of the loop body and was skipped by the no-containerId
      // `continue` below.)
      //
      // #7561: this is no longer the last word on the tag. Sessions now persist
      // their environment binding and RE-ATTACH on restore, so the sequence at
      // boot is: reconnect() wipes the stale ids written by the process that
      // died, then SessionManager.restoreState() re-tags the ones that actually
      // came back. The ordering is load-bearing and holds in server-cli.js —
      // the manager is constructed and reconnect()ed before the SessionManager
      // exists, let alone restores — and is pinned in
      // tests/environment-restore-binding.test.js. A reconnect() AFTER a
      // restore would silently un-tag every restored session and put the
      // destroy guard (#7562) back to sleep.
      env.sessions = []

      if (!env.containerId) {
        // Invariant: allHealthy=false co-located with unreachable status (#3492)
        env.status = 'error'
        allHealthy = false
        continue
      }
      try {
        const running = await this._backend.getEnvironmentStatus(env.containerId)
        if (running) {
          env.status = 'running'
          log.info(`Environment "${env.name}" reconnected (container: ${env.containerId.slice(0, 12)})`)
        } else {
          // Invariant: allHealthy=false co-located with unreachable status (#3492).
          // 'stopped' is in UNREACHABLE_STATUSES — see the boot-path aggregate
          // warn in server-cli.js#logEnvironmentManagerReconnectResult.
          env.status = 'stopped'
          allHealthy = false
          log.warn(`Environment "${env.name}" (id: ${env.id}) container is stopped`)
        }
      } catch (err) {
        // Invariant: allHealthy=false co-located with unreachable status (#3492)
        env.status = 'error'
        allHealthy = false
        log.warn(`Environment "${env.name}" (id: ${env.id}) container inspect failed: ${err.message}`)
      }
      // For backends that hold per-environment credentials in memory (e.g.
      // K8sBackend._agentTokens), re-populate them from the canonical source
      // so that streamCliInEnvironment() works after a server restart.
      //
      // Per the Backend JSDoc, reconnectAgentToken returns:
      //   true  — credential found and cached; environment is usable
      //   false — credential source is gone (Pod/Secret GC'd); the environment
      //           is unreachable and must be marked accordingly so future
      //           streamCliInEnvironment calls don't fail without warning.
      //
      // A thrown error is treated as the same unreachable signal as returning
      // false (#3478): the operator cannot rely on the credential, so the
      // environment must be marked error and reconnect() must report failure.
      //
      // Defensive (#3495): treat any non-`true` return (including `undefined` /
      // `null` from a misbehaving or future backend) as the same unreachable
      // signal. The contract is "strict `=== true` for success" — a missing
      // credential is just as unusable as `false`.
      if (typeof this._backend.reconnectAgentToken === 'function') {
        try {
          const ok = await this._backend.reconnectAgentToken(env.containerId)
          if (ok !== true) {
            // Invariant: allHealthy=false co-located with unreachable status (#3492)
            env.status = 'error'
            allHealthy = false
            log.warn(`Environment "${env.name}" (id: ${env.id}) credential source is gone — marking unreachable`)
          }
        } catch (err) {
          // Invariant: allHealthy=false co-located with unreachable status (#3492)
          env.status = 'error'
          allHealthy = false
          log.warn(`Environment "${env.name}" (id: ${env.id}) token refresh failed: ${err.message}`)
        }
      }
    }

    this._persist()
    this.emit('environments_reconnected', this.list())
    return allHealthy
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
      containerIds = await this._backend.listEnvironments()
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
      await this._backend.destroyEnvironment(id)
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Backward-compat delegation shim
  //
  // Tests that call manager._composeServices() directly (graceful degradation
  // tests) continue to work via this thin delegation to the backend.
  // No other Docker-specific private methods live here — they have all moved
  // to DockerBackend in packages/server/src/environments/backends/docker.js.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * @deprecated Call via this._backend instead.  Kept for test backward-compat.
   */
  _composeServices(project) {
    return this._backend._composeServices(project)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DevContainer support
  //
  // Parsing and validation helpers live in `devcontainer-config.js` as pure
  // functions so the persistent-environment `create()` path here and the
  // per-session DockerByokSession path share one source of truth (#5077).
  // Call sites: `parseDevContainer` / `validateMounts` / `sanitizeContainerEnv`
  // are invoked from `create()` above.
  // ──────────────────────────────────────────────────────────────────────────

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

      // writeFileRestricted is atomic on both POSIX (#4850) and Windows
      // (#4913) and cleans up its intermediate `.tmp` on rename failure
      // (#4874) — no manual tmp+rename wrapper needed here. The
      // pre-#4874 unlinkSync(EEXIST) workaround is no longer required
      // since Node's renameSync uses MoveFileExW(REPLACE_EXISTING) on
      // Windows.
      writeFileRestricted(this._statePath, JSON.stringify(data, null, 2))
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
