/**
 * @module environments/backends/types
 *
 * Defines the pluggable Backend interface for container environments.
 *
 * The EnvironmentManager owns lifecycle state — the in-memory map, persistence,
 * per-environment mutexes, naming, input validation, and event emission.  The
 * Backend owns the underlying execution mechanism — Docker shellout today,
 * Kubernetes API tomorrow (#3191+).
 *
 * Backends MUST NOT hold environment state of their own.  Every method receives
 * all the information it needs on each call via its arguments.  State ownership
 * stays with EnvironmentManager.
 *
 * "Handle" is an opaque identifier that maps to the underlying resource.  For
 * DockerBackend it is the container ID string returned by `docker run`.  For
 * compose environments it is the compose project name.  The manager stores the
 * handle inside the environment record and passes it back on every subsequent
 * call.
 */

/**
 * @interface Backend
 *
 * Contract that every backend implementation MUST satisfy.  Implementations
 * live in sibling files (e.g. docker.js) and are injected into EnvironmentManager
 * via the `backend` constructor parameter.
 */

// ─── Method contracts ──────────────────────────────────────────────────────

/**
 * Start a new standalone (non-compose) container and prepare it for use.
 *
 * Responsibilities:
 *   - Launch the container with the requested resource limits and mounts
 *   - Create the non-root user inside the container
 *   - Install Claude Code CLI globally
 *   - Determine the installed CLI path
 *   - Run postCreateCommand if provided
 *   - On any failure after the container starts, stop and remove the container
 *     before re-throwing so the manager never sees a partially-initialised handle
 *
 * @function createEnvironment
 * @memberof Backend
 * @param {Object} opts
 * @param {string}   opts.envId           - Unique environment ID (used to name the container `chroxy-env-{envId}`)
 * @param {string}   opts.cwd             - Host working directory; mounted as /workspace inside the container
 * @param {string}   opts.image           - Docker image tag (already resolved to a default before this call)
 * @param {string}   opts.memoryLimit     - Docker memory limit string (e.g. "2g")
 * @param {string}   opts.cpuLimit        - Docker CPU limit string (e.g. "2")
 * @param {string}   opts.containerUser   - Non-root username to create inside the container
 * @param {Object}   [opts.containerEnv]  - Extra environment variables to inject (already sanitized)
 * @param {number[]|string[]} [opts.forwardPorts] - Ports to expose from the container
 * @param {string[]} [opts.mounts]        - Additional volume mounts (already validated)
 * @param {string}   [opts.postCreateCommand] - Shell command to run after setup completes
 * @param {'Always'|'IfNotPresent'|'Never'} [opts.imagePullPolicy] - Container image pull policy.
 *   Honoured only by K8sBackend — Docker and other backends silently ignore this field.
 *   When absent, K8sBackend omits the field from the Pod spec and the K8s cluster default applies
 *   (typically `IfNotPresent` for tagged images, `Always` for `latest`).
 * @returns {Promise<{ containerId: string, containerCliPath: string }>}
 *   containerId — the full container ID string returned by the runtime
 *   containerCliPath — absolute path inside the container where the CLI binary was installed
 * @throws {Error} If any step fails; the container is cleaned up before throwing
 */

/**
 * Start a Docker Compose stack and prepare the primary service container.
 *
 * Responsibilities:
 *   - Run `docker compose up -d` for the given compose file
 *   - Identify the primary container (by service name or first service)
 *   - Set up the non-root user and install Claude Code inside the primary container
 *   - Return the full list of services in the project
 *   - On any failure, run `docker compose down` before re-throwing
 *
 * @function createComposeEnvironment
 * @memberof Backend
 * @param {Object} opts
 * @param {string}  opts.envId           - Unique environment ID
 * @param {string}  opts.cwd             - Working directory (passed to docker compose as its cwd)
 * @param {string}  opts.composeFile     - Absolute path to the docker-compose.yml file
 * @param {string}  opts.composeProject  - Compose project name (e.g. "chroxy-env-{envId}")
 * @param {string}  opts.containerUser   - Non-root username to create inside the primary container
 * @param {string}  [opts.primaryService] - Service name to target as the primary; uses first service if omitted
 * @returns {Promise<{ containerId: string, containerCliPath: string, services: Array<{name: string, status: string, primary: boolean}> }>}
 *   containerId — container ID of the primary service
 *   containerCliPath — absolute path to the CLI inside the primary container
 *   services — metadata for all services in the compose project
 * @throws {Error} If up, identification, or setup fails; compose stack is torn down before throwing
 */

/**
 * Destroy a standalone container environment.
 *
 * @function destroyEnvironment
 * @memberof Backend
 * @param {string} containerId - Container ID to force-remove (`docker rm -f`)
 * @returns {Promise<void>} Resolves when the container is removed (or was already gone).
 *                          Never rejects — removal failures are logged and swallowed.
 */

/**
 * Tear down a Docker Compose stack.
 *
 * @function destroyComposeEnvironment
 * @memberof Backend
 * @param {Object} opts
 * @param {string} opts.composeFile    - Absolute path to the docker-compose.yml
 * @param {string} opts.composeProject - Compose project name
 * @param {string} opts.cwd            - Working directory for docker compose
 * @returns {Promise<void>} Resolves after `docker compose down --remove-orphans`.
 *                          Never rejects — failures are logged and swallowed.
 */

/**
 * Remove a local Docker image (e.g. a snapshot image created by commitEnvironment).
 *
 * @function removeImage
 * @memberof Backend
 * @param {string} imageTag - Image tag to remove
 * @returns {Promise<void>} Resolves when the image is removed (or was already gone).
 *                          Never rejects — removal failures are logged and swallowed.
 */

/**
 * Execute a shell command inside a running container.
 *
 * Used by EnvironmentManager for any in-container operation that goes beyond
 * setup/install (e.g. running a one-off tool command initiated by a session).
 * The DockerBackend implements this as `docker exec`.
 *
 * @function execInEnvironment
 * @memberof Backend
 * @param {string} containerId - Container ID
 * @param {Object} opts
 * @param {string}   opts.cmd            - Shell command to run (passed as `bash -c <cmd>`)
 * @param {Object}   [opts.env]          - Extra environment variables for the exec process
 * @param {string}   [opts.cwd]          - Working directory inside the container
 * @param {number}   [opts.timeout]      - Timeout in ms (default 30 000)
 * @returns {Promise<{ stdout: string, stderr: string }>}
 * @throws {Error} If the command exits non-zero
 */

/**
 * Inspect a container and return whether it is currently running.
 *
 * Used by reconnect() to check container health after server restart, and by
 * restore() to validate a newly-started container before removing the old one.
 *
 * @function getEnvironmentStatus
 * @memberof Backend
 * @param {string} containerId - Container ID to inspect
 * @returns {Promise<boolean>} true if the container exists and is in the Running state
 * @throws {Error} If the container does not exist (lets the caller distinguish
 *                 "not found" from "stopped")
 */

/**
 * List all running containers whose names match the `chroxy-env-*` pattern.
 *
 * Used by reconcile() to detect orphaned containers that are not tracked in
 * the environment registry.
 *
 * @function listEnvironments
 * @memberof Backend
 * @returns {Promise<string[]>} Array of short container IDs
 * @throws {Error} If the Docker daemon is unreachable (caller must handle)
 */

/**
 * Commit a running container to a new local image (snapshot).
 *
 * This maps to `docker commit`.  It does not fit neatly into the
 * create/destroy/exec/status/list quintet because it produces a named artifact
 * (the image tag) that lives outside the container lifecycle.  It is therefore
 * a 6th method on the interface rather than being squeezed into an existing one.
 *
 * @function commitEnvironment
 * @memberof Backend
 * @param {string} containerId - Running container to commit
 * @param {string} imageTag    - Local image tag to create (e.g. "chroxy-env:{envId}-{timestamp}")
 * @returns {Promise<string>} The image SHA returned by `docker commit`
 * @throws {Error} If the commit fails
 */

/**
 * Rename a container (used during atomic restore to free the chroxy-env-{envId} name).
 *
 * This is an 8th method beyond the standard 5.  It is needed by the atomic
 * restore flow: before starting the new container under the canonical name, the
 * old container must be renamed so the name is free.  It does not fit into any
 * of the other 5 methods and is too low-level to be a composite operation.
 * Failures are swallowed (logged only) because the rename is best-effort and
 * the restore can proceed without it.
 *
 * **Docker-only concept — non-Docker backends MUST implement this as a no-op.**
 *
 * Docker containers have mutable, reusable names: the canonical
 * `chroxy-env-{envId}` name must be freed before the replacement container can
 * claim it.  K8s pods are immutable and have unique names by design — there is
 * no canonical name slot to free — so K8sBackend (and any future backend that
 * does not rely on mutable container names) MUST resolve the returned Promise
 * immediately without performing any I/O.  The restore flow in
 * EnvironmentManager tolerates a no-op here because the old resource is
 * destroyed after the new container passes its health check, regardless of
 * whether a rename occurred.
 *
 * Implementation guidance per backend:
 *  - **DockerBackend** — calls `docker rename <containerId> <newName>`; failures
 *    are logged and swallowed (best-effort).
 *  - **K8sBackend** — no-op; `return Promise.resolve()`.  Do NOT throw
 *    `NotImplementedError` — the restore flow calls this unconditionally and a
 *    rejection will abort the restore.
 *
 * @function renameEnvironment
 * @memberof Backend
 * @param {string} containerId - Container to rename (Docker) or ignored (K8s / no-op backends)
 * @param {string} newName     - New name (Docker) or ignored (K8s / no-op backends)
 * @returns {Promise<void>} Resolves regardless of success — rename failures are logged only;
 *                          non-Docker backends resolve immediately without any I/O
 */

/**
 * Start a container from a pre-configured image WITHOUT running user setup or
 * CLI install.  Used exclusively by the restore flow, where the snapshot image
 * already has the user, CLI, and workspace baked in.
 *
 * This is distinct from createEnvironment (which runs full setup) because
 * re-running setup on a pre-configured snapshot image would fail or corrupt
 * the environment.  Backends that do not support snapshotting (e.g. K8sBackend
 * before snapshots are implemented, #3191) should throw a descriptive error.
 *
 * @function restoreEnvironment
 * @memberof Backend
 * @param {Object} opts
 * @param {string} opts.envId        - Environment ID (used to name the container `chroxy-env-{envId}`)
 * @param {string} opts.cwd          - Host working directory to mount as /workspace
 * @param {string} opts.image        - Snapshot image tag to run
 * @param {string} opts.memoryLimit  - Docker memory limit string (e.g. "2g")
 * @param {string} opts.cpuLimit     - Docker CPU limit string (e.g. "2")
 * @returns {Promise<string>} The full container ID of the newly-started container
 * @throws {Error} If the container fails to start
 */

/**
 * Re-populate the backend's in-memory credential cache for a single environment
 * after a server restart.  This method is OPTIONAL — the Backend interface does
 * not require it.  EnvironmentManager.reconnect() checks for it via duck-typing:
 *
 * ```js
 * if (typeof this._backend.reconnectAgentToken === 'function') {
 *   await this._backend.reconnectAgentToken(env.containerId)
 * }
 * ```
 *
 * Backends that hold per-environment credentials in memory (e.g. K8sBackend
 * stores agent tokens fetched from a K8s Secret) SHOULD implement this method
 * so that streamCliInEnvironment() continues to work after the server process
 * restarts.  Backends whose credentials are stateless or persisted to disk
 * (e.g. DockerBackend) need not implement it.
 *
 * @function reconnectAgentToken
 * @memberof Backend
 * @param {string} handle - Opaque environment handle (container ID for Docker, Pod name for K8s)
 * @param {Object} [opts] - Backend-specific options (e.g. {namespace} for K8sBackend)
 * @returns {Promise<boolean>}
 *   `true`  — credential was found and is now cached; the environment is usable
 *   `false` — credential source is gone (e.g. the Pod/Secret was garbage-collected);
 *             the caller should treat the environment as unreachable
 * @throws {Error} On unexpected I/O errors (not on 404 / resource-not-found — return false instead)
 */

/**
 * Spawn a long-lived CLI process inside a running environment and return a
 * ChildProcess-shaped handle for streaming I/O.
 *
 * Used by session layers (e.g. DockerSdkSession, K8sSdkSession) as the
 * `spawnClaudeCodeProcess` callback passed to the Agent SDK's `query()`.
 * The return value must satisfy the SpawnedProcess interface that the SDK
 * expects: readable `stdout` and `stderr` streams, a writable `stdin` stream,
 * and an `'exit'` event emitted with `(code)` when the process terminates.
 *
 * Node's `ChildProcess` (returned by `child_process.spawn`) satisfies this
 * contract natively for DockerBackend.  K8sBackend returns a thin EventEmitter
 * wrapper that bridges the sidecar WebSocket protocol to the same surface.
 *
 * Unlike `execInEnvironment` (which buffers output and resolves on exit),
 * `streamCliInEnvironment` is intended for long-running interactive processes
 * whose stdout is consumed incrementally by the SDK.
 *
 * @function streamCliInEnvironment
 * @memberof Backend
 * @param {string} handle - Environment handle (container ID for Docker, Pod name for K8s)
 * @param {Object} opts
 * @param {string}   opts.cmd            - Binary to execute (e.g. 'node')
 * @param {string[]} [opts.args]         - Argument list (default [])
 * @param {Object}   [opts.env]          - Extra environment variables (merged on top of container env)
 * @param {string}   [opts.cwd]          - Working directory inside the environment
 * @param {AbortSignal} [opts.signal]    - Abort signal; triggers SIGTERM on the child when fired
 * @returns {object} SpawnedProcess-like handle with:
 *   - `stdout` {stream.Readable}   — child process stdout
 *   - `stderr` {stream.Readable}   — child process stderr
 *   - `stdin`  {stream.Writable}   — child process stdin
 *   - `'exit'` event `(code: number|null)` — emitted when the child exits
 * @throws {Error} If the environment is not reachable or the spawn fails synchronously
 */
