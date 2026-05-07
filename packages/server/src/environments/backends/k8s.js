import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { KubeConfig, CoreV1Api, PortForward } from '@kubernetes/client-node'
import WebSocket from 'ws'
import { createLogger } from '../../logger.js'

const log = createLogger('k8s-backend')

const POLL_INTERVAL_MS = 1_000
const DESTROY_TIMEOUT_MS = 30_000

// Reconnect parameters for SidecarProcess WS blip recovery (#3321).
// These are the defaults; inject overrides via constructor opts for tests.
const DEFAULT_RECONNECT_DELAYS = [250, 500, 1_000, 2_000, 4_000, 8_000]
const DEFAULT_MAX_RETRIES = 5

/** Default sidecar image — overridden via constructor option */
const DEFAULT_SIDECAR_IMAGE = 'chroxy-pod-agent:latest'

/** Port the chroxy-pod-agent sidecar listens on inside the Pod */
const AGENT_PORT = 7681

/**
 * Default container CLI path — used to remap the host's absolute cli.js path
 * (passed by the SDK as args[0]) to a path that exists inside the Pod.
 * Mirrors DEFAULT_CONTAINER_CLI_PATH in docker.js.
 */
const DEFAULT_CONTAINER_CLI_PATH = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'

// Per-method deferral tracking: each stub points to the issue/phase that owns it.
// Keep this in sync with the Backend interface (types.js) and the K8s phase plan in #3191.
// Note: renameEnvironment is intentionally absent — it is a documented no-op on K8s (see types.js).
const NOT_IMPLEMENTED_REASON = {
  createComposeEnvironment: 'N/A for K8s — compose is a Docker-only concept',
  destroyComposeEnvironment: 'N/A for K8s — compose is a Docker-only concept',
  removeImage: 'N/A for K8s — image lifecycle is owned by the cluster registry/CRI',
  listEnvironments: 'deferred to Phase 2',
  commitEnvironment: 'deferred to Phase 2',
  restoreEnvironment: 'deferred to Phase 2',
}

function notImplemented(method) {
  const reason = NOT_IMPLEMENTED_REASON[method] || 'deferred to a later phase'
  const err = new Error(`K8sBackend.${method} is not implemented in Phase 1 — ${reason}`)
  err.name = 'NotImplementedError'
  return err
}

/** Valid Kubernetes imagePullPolicy values */
const VALID_PULL_POLICIES = new Set(['Always', 'IfNotPresent', 'Never'])

/**
 * Validates an imagePullPolicy value.  Throws TypeError for unrecognised strings.
 * Passes through null/undefined (meaning: omit the field, let K8s apply its default).
 *
 * @param {string|null|undefined} value
 * @param {string} context - Describes where the value came from (for the error message)
 */
function validateImagePullPolicy(value, context) {
  if (value == null) return
  if (!VALID_PULL_POLICIES.has(value)) {
    throw new TypeError(
      `K8sBackend: invalid imagePullPolicy "${value}" in ${context} — ` +
      `must be one of: Always, IfNotPresent, Never`
    )
  }
}

/**
 * K8sBackend implements the Backend interface (see types.js) using the
 * Kubernetes API via @kubernetes/client-node.
 *
 * Phase 1 (#3191): createEnvironment (Pod create) + destroyEnvironment (Pod delete).
 * Phase 2 (#3320): streamCliInEnvironment, execInEnvironment, getEnvironmentStatus.
 * All other Backend interface methods throw NotImplementedError until later phases.
 *
 * This class owns NO environment state.  Every method receives the identifier
 * (Pod name) from the caller's in-memory record.  The "handle" stored by
 * EnvironmentManager for a K8s environment is the Pod name string.
 *
 * Connection modes for streamCliInEnvironment (constructor-gated):
 *   'portforward' (default) — uses @kubernetes/client-node PortForward to tunnel
 *                             TCP from a local port to the sidecar's AGENT_PORT.
 *                             Safe from outside the cluster (dev / CI).
 *   'clusterip'            — dials the Pod IP directly.  Requires chroxy to run
 *                             inside the cluster where Pod IPs are routable.
 */
export class K8sBackend {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.namespace='default']         - Kubernetes namespace for all Pods
   * @param {boolean} [opts.inCluster]                  - Force in-cluster auth (default: auto-detect via KUBERNETES_SERVICE_HOST)
   * @param {string}  [opts.kubeconfigPath]             - Path to kubeconfig file (overrides default search)
   * @param {string}  [opts.sidecarImage]               - Sidecar image to use in createEnvironment (default: chroxy-pod-agent:latest)
   * @param {'Always'|'IfNotPresent'|'Never'} [opts.imagePullPolicy] - imagePullPolicy applied to all
   *   containers in the Pod spec. When unset the field is omitted and Kubernetes applies its own default
   *   ('Always' for :latest tags, 'IfNotPresent' otherwise). Set to 'IfNotPresent' for air-gapped
   *   clusters or local kind-based CI where images are loaded directly into the cluster.
   * @param {'portforward'|'clusterip'} [opts.connectMode='portforward'] - How to reach the sidecar
   * @param {object}  [opts._coreV1Api]                 - Injected CoreV1Api for testing
   * @param {object}  [opts._portForward]               - Injected PortForward for testing
   * @param {Function} [opts._dialWs]                   - Injected WS dial factory for testing: (url, token) => WebSocket
   * @param {number[]} [opts._reconnectDelays]          - Override backoff delays in ms for testing
   * @param {number}   [opts._maxRetries]               - Override max reconnect retries for testing
   * @param {Function} [opts._setTimeout]               - Override setTimeout for deterministic testing
   * @param {Function} [opts._clearTimeout]             - Override clearTimeout for deterministic testing
   */
  constructor({ namespace, inCluster, kubeconfigPath, sidecarImage, imagePullPolicy,
    connectMode, _coreV1Api, _portForward, _dialWs, _net,
    _reconnectDelays, _maxRetries,
    _setTimeout: setTimeoutImpl, _clearTimeout: clearTimeoutImpl } = {}) {
    validateImagePullPolicy(imagePullPolicy, 'constructor opts')
    this._namespace = namespace || 'default'
    this._sidecarImage = sidecarImage || DEFAULT_SIDECAR_IMAGE
    this._imagePullPolicy = imagePullPolicy || null
    this._connectMode = connectMode || 'portforward'

    if (_coreV1Api) {
      this._api = _coreV1Api
      this._kc = null
    } else {
      const kc = new KubeConfig()
      const useInCluster = inCluster ?? Boolean(process.env.KUBERNETES_SERVICE_HOST)
      if (useInCluster) {
        kc.loadFromCluster()
      } else if (kubeconfigPath) {
        kc.loadFromFile(kubeconfigPath)
      } else {
        kc.loadFromDefault()
      }
      this._kc = kc
      this._api = kc.makeApiClient(CoreV1Api)
    }

    // Allow PortForward injection for unit tests
    this._portForwardImpl = _portForward || null
    // Allow `net` injection for unit tests of the portforward bridge
    this._netImpl = _net || null
    // Allow WS dial injection for unit tests.
    // When _dialWs is injected, _dial() calls it directly (bypasses pod-IP
    // lookup and port-forward machinery) — useful in unit tests where there is
    // no real cluster.
    if (_dialWs) {
      this._dialWs = _dialWs
      this._directDial = true
    } else {
      this._dialWs = _defaultDialWs
      this._directDial = false
    }

    // Per-Pod agent tokens, keyed by pod name. Populated by createEnvironment()
    // and consulted by streamCliInEnvironment() / execInEnvironment(). Removed
    // by destroyEnvironment(). Storing it here keeps the Backend.streamCli...
    // interface uniform across backends — callers do not need to thread a
    // K8s-specific agentToken arg through the manager.
    this._agentTokens = new Map()

    // Reconnect backoff config — injectable for deterministic unit tests.
    // Validate the delay schedule defensively: an empty array (or non-finite
    // entries) would make `delay` undefined and let `setTimeout` fire on the
    // next tick, producing a tight reconnect loop.
    const delays = _reconnectDelays || DEFAULT_RECONNECT_DELAYS
    const validDelays = Array.isArray(delays) && delays.length > 0 &&
      delays.every((d) => Number.isFinite(d) && d >= 0)
    this._reconnectDelays = validDelays ? delays : DEFAULT_RECONNECT_DELAYS
    this._maxRetries = Number.isFinite(_maxRetries) && _maxRetries >= 0
      ? _maxRetries
      : DEFAULT_MAX_RETRIES
    // Timer seam: allow tests to substitute a fake clock and avoid real-time polling.
    this._setTimeout = setTimeoutImpl || setTimeout
    this._clearTimeout = clearTimeoutImpl || clearTimeout
  }

  // ─────────────────────────────────────────────────────────────────────────
  // createEnvironment — create a sidecar Pod + per-Pod Secret
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a per-Pod K8s Secret containing a random auth token, then creates
   * a single-container Pod running the chroxy-pod-agent sidecar.  The token is
   * injected as CHROXY_AGENT_TOKEN via secretKeyRef.
   *
   * Returns as soon as `createNamespacedPod` resolves — the Pod has been accepted
   * by the API server but may not yet be scheduled or Running.
   *
   * Workspace mount strategy — hostPath:
   *   `opts.cwd` is mounted into the Pod as a `hostPath` volume at `/workspace`.
   *   This is the simplest strategy for local clusters (kind, minikube, Docker
   *   Desktop) where the Node running the Pod shares the host filesystem.  For
   *   production clusters where Pods run on remote nodes the host path will not
   *   exist; operators should provision a PVC pre-populated with the workspace and
   *   pass it via `opts.mounts` instead.  Cluster-side requirement: the K8s node
   *   must be able to read the path provided in opts.cwd from its local filesystem.
   *
   * @param {Object} opts - See Backend interface in types.js
   * @param {string}   opts.envId          - Unique environment ID
   * @param {string}   [opts.cwd]          - Host path to mount as /workspace inside the Pod
   * @param {string}   [opts.image]        - Overrides the constructor sidecarImage
   * @param {string}   [opts.memoryLimit]  - K8s memory quantity string (e.g. "2Gi").
   *   Applied to both `resources.limits.memory` and `resources.requests.memory`.
   *   Accepts Docker-style suffixes ("g"/"m") and standard K8s suffixes ("Gi"/"Mi").
   * @param {string}   [opts.cpuLimit]     - K8s CPU quantity string (e.g. "2" or "500m").
   *   Applied to both `resources.limits.cpu` and `resources.requests.cpu`.
   *   A plain integer or float (e.g. "2", "0.5") is valid K8s CPU quantity syntax.
   * @param {number[]|string[]} [opts.forwardPorts] - Extra ports to expose from the container
   *   (in addition to the built-in AGENT_PORT).  Each value may be a bare port number
   *   or a "hostPort:containerPort" string; only the containerPort is used in the Pod spec.
   * @param {string[]} [opts.mounts]       - Additional volume mounts in Docker-style
   *   "hostPath:containerPath[:ro]" format.  Each entry is translated into a
   *   `hostPath` volume + corresponding `volumeMount`.  The volume name is derived
   *   from the entry index ("extra-vol-0", "extra-vol-1", …).
   * @param {Object}   [opts.containerEnv] - Extra environment variables
   * @param {string}   [opts.namespace]    - Overrides the constructor default namespace
   * @param {'Always'|'IfNotPresent'|'Never'} [opts.imagePullPolicy] - Per-call override for the
   *   container imagePullPolicy. Falls back to the constructor-level option when unset.
   * @returns {Promise<{ containerId: string, containerCliPath: string, agentToken: string, secretName: string }>}
   *   containerId  — the Pod name (used as handle on subsequent calls)
   *   containerCliPath — hardcoded default; sidecar-based discovery is future work
   *   agentToken   — token to authenticate WS connections (stored in memory by caller)
   *   secretName   — Secret name (stored by caller so destroyEnvironment can delete it)
   */
  async createEnvironment(opts) {
    const {
      envId, cwd, containerEnv, namespace,
      memoryLimit, cpuLimit, forwardPorts, mounts,
      imagePullPolicy: callImagePullPolicy,
    } = opts
    validateImagePullPolicy(callImagePullPolicy, 'createEnvironment opts')
    const ns = namespace || this._namespace
    const podName = `chroxy-env-${envId}`
    const secretName = `chroxy-token-${envId}`
    // K8sBackend ALWAYS runs the chroxy-pod-agent sidecar — the sidecar is
    // the env, and the user's workload runs inside it. EnvironmentManager
    // passes a workspace image (e.g. node:22-slim) which we deliberately
    // ignore here; only the constructor-configured sidecarImage is used.
    const sidecarImage = this._sidecarImage

    // 1. Generate per-Pod auth token
    const agentToken = randomBytes(32).toString('base64url')

    // 2. Create K8s Secret containing the token
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        labels: {
          'app.kubernetes.io/managed-by': 'chroxy',
          'chroxy-env-id': envId,
        },
      },
      stringData: {
        CHROXY_AGENT_TOKEN: agentToken,
      },
    }

    log.info(`Creating Secret ${secretName} in namespace ${ns}`)
    await this._api.createNamespacedSecret({ namespace: ns, body: secret })

    // 3. Build env array for the Pod, merging extra vars + secret ref
    const env = []

    // Mount the token from the Secret
    env.push({
      name: 'CHROXY_AGENT_TOKEN',
      valueFrom: {
        secretKeyRef: {
          name: secretName,
          key: 'CHROXY_AGENT_TOKEN',
        },
      },
    })

    // Extra env vars from caller
    if (containerEnv) {
      for (const [name, value] of Object.entries(containerEnv)) {
        env.push({ name, value: String(value) })
      }
    }

    // 4. Resolve imagePullPolicy: per-call opt > constructor opt > omit (K8s default)
    const imagePullPolicy = callImagePullPolicy || this._imagePullPolicy

    // 4. Build volumes + volumeMounts
    // 4a. Workspace: mount opts.cwd as /workspace via hostPath.
    //     Requirement: the K8s node must be able to read opts.cwd from its local
    //     filesystem.  Satisfied automatically for single-node clusters (kind,
    //     minikube, Docker Desktop).  For multi-node clusters operators must ensure
    //     the path exists on the scheduled node or use a PVC passed via opts.mounts.
    const volumes = []
    const volumeMounts = []

    if (cwd) {
      volumes.push({
        name: 'workspace',
        hostPath: { path: cwd, type: 'DirectoryOrCreate' },
      })
      volumeMounts.push({
        name: 'workspace',
        mountPath: '/workspace',
      })
    }

    // 4b. Additional mounts: Docker-style "hostPath:containerPath[:ro]" strings.
    if (mounts && mounts.length > 0) {
      for (let i = 0; i < mounts.length; i++) {
        const parsed = _parseMountString(mounts[i])
        if (!parsed) {
          log.warn(`createEnvironment: ignoring unparseable mount entry "${mounts[i]}"`)
          continue
        }
        const volName = `extra-vol-${i}`
        volumes.push({
          name: volName,
          hostPath: { path: parsed.hostPath, type: 'DirectoryOrCreate' },
        })
        const vm = { name: volName, mountPath: parsed.containerPath }
        if (parsed.readOnly) vm.readOnly = true
        volumeMounts.push(vm)
      }
    }

    // 5. Build ports list: AGENT_PORT is always present; forwardPorts adds more.
    const ports = [{ containerPort: AGENT_PORT, name: 'agent' }]
    if (forwardPorts && forwardPorts.length > 0) {
      for (const entry of forwardPorts) {
        // Accept bare port number or "hostPort:containerPort" strings.
        const containerPort = _parseContainerPort(entry)
        if (containerPort && containerPort !== AGENT_PORT) {
          ports.push({ containerPort })
        }
      }
    }

    // 6. Build resource limits/requests.
    //    Convert Docker-style suffixes (g → Gi, m → Mi) to K8s quantity strings.
    //    A plain integer/float string (e.g. "2", "0.5") is already valid K8s CPU syntax.
    const resources = {}
    if (memoryLimit || cpuLimit) {
      const limits = {}
      const requests = {}
      if (memoryLimit) {
        const mem = _normaliseMemoryQuantity(memoryLimit)
        limits.memory = mem
        requests.memory = mem
      }
      if (cpuLimit) {
        limits.cpu = String(cpuLimit)
        requests.cpu = String(cpuLimit)
      }
      resources.limits = limits
      resources.requests = requests
    }

    // 7. Assemble container spec
    const containerSpec = {
      name: 'agent',
      image: sidecarImage,
      env,
      ports,
      livenessProbe: {
        httpGet: { path: '/healthz', port: AGENT_PORT },
        initialDelaySeconds: 5,
        periodSeconds: 10,
      },
      readinessProbe: {
        httpGet: { path: '/healthz', port: AGENT_PORT },
        initialDelaySeconds: 2,
        periodSeconds: 5,
      },
    }

    if (imagePullPolicy) {
      containerSpec.imagePullPolicy = imagePullPolicy
    }

    if (volumeMounts.length > 0) {
      containerSpec.volumeMounts = volumeMounts
    }

    if (Object.keys(resources).length > 0) {
      containerSpec.resources = resources
    }

    // 8. Assemble Pod spec
    const podSpec = {
      restartPolicy: 'Never',
      containers: [containerSpec],
    }

    if (volumes.length > 0) {
      podSpec.volumes = volumes
    }

    const pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: podName,
        labels: {
          'app.kubernetes.io/managed-by': 'chroxy',
          'chroxy-env-id': envId,
        },
      },
      spec: podSpec,
    }

    log.info(`Creating Pod ${podName} in namespace ${ns}`)
    try {
      await this._api.createNamespacedPod({ namespace: ns, body: pod })
    } catch (err) {
      // Pod creation failed — clean up the Secret we already created
      log.warn(`Pod creation failed, removing Secret ${secretName}: ${err.message}`)
      await this._deleteSecret(secretName, ns)
      throw err
    }

    // Register the token internally so streamCliInEnvironment() can look it
    // up by Pod name without callers having to plumb it through.
    this._agentTokens.set(podName, agentToken)

    return {
      containerId: podName,
      containerCliPath: DEFAULT_CONTAINER_CLI_PATH,
      agentToken,
      secretName,
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // destroyEnvironment — delete Pod + Secret and wait until Pod is gone (or 404)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Deletes the named Pod and polls until it no longer exists (404).
   * Also deletes the per-Pod Secret.
   *
   * `secretName` defaults to `chroxy-token-<envId>` derived from the canonical
   * `chroxy-env-<envId>` pod name. Callers that created the Pod via
   * createEnvironment() do not need to plumb the secret name through.
   *
   * Best-effort by design (mirrors `DockerBackend._removeContainer`):
   *   - Idempotent: if the Pod is already gone (404 on delete), resolves immediately.
   *   - If `deleteNamespacedPod` fails with a non-404 error, logs a warning and resolves
   *     without throwing (the env record is removed regardless).
   *   - The poll loop exits early on the first non-404 read error rather than retrying.
   *   - Falls through to a timeout warning if the Pod never disappears within
   *     {@link DESTROY_TIMEOUT_MS}.
   *
   * @param {string} podName - Pod name (the containerId handle stored by EnvironmentManager)
   * @param {Object} [opts]
   * @param {string} [opts.namespace]   - Overrides the constructor default namespace
   * @param {string} [opts.secretName]  - Per-Pod Secret to delete (default: derived from podName)
   * @returns {Promise<void>}
   */
  async destroyEnvironment(podName, opts = {}) {
    const ns = opts.namespace || this._namespace
    const secretName = opts.secretName || _deriveSecretName(podName)

    // Always drop the cached token first so a partial failure can't leave
    // a dangling token in memory.
    this._agentTokens.delete(podName)

    log.info(`Deleting Pod ${podName} in namespace ${ns}`)

    try {
      await this._api.deleteNamespacedPod({ name: podName, namespace: ns })
    } catch (err) {
      if (_isNotFound(err)) {
        log.info(`Pod ${podName} already gone`)
        // Still clean up the Secret
        await this._deleteSecret(secretName, ns)
        return
      }
      log.warn(`Failed to delete Pod ${podName}: ${err.message}`)
      await this._deleteSecret(secretName, ns)
      // Best-effort: do not rethrow — mirrors DockerBackend._removeContainer
      return
    }

    // Poll until the Pod disappears from the API
    const deadline = Date.now() + DESTROY_TIMEOUT_MS
    while (Date.now() < deadline) {
      await _sleep(POLL_INTERVAL_MS)
      try {
        await this._api.readNamespacedPod({ name: podName, namespace: ns })
        // Pod still exists — keep polling
      } catch (err) {
        if (_isNotFound(err)) {
          log.info(`Pod ${podName} terminated`)
          await this._deleteSecret(secretName, ns)
          return
        }
        log.warn(`Error polling Pod ${podName}: ${err.message}`)
        await this._deleteSecret(secretName, ns)
        return
      }
    }

    log.warn(`Timed out waiting for Pod ${podName} to terminate`)
    await this._deleteSecret(secretName, ns)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getEnvironmentStatus — read Pod phase via readNamespacedPod
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns true if the Pod exists and its phase is 'Running'.
   *
   * @param {string} podName
   * @param {Object} [opts]
   * @param {string} [opts.namespace]
   * @returns {Promise<boolean>}
   * @throws {Error} If the Pod does not exist
   */
  async getEnvironmentStatus(podName, opts = {}) {
    const ns = opts.namespace || this._namespace
    const result = await this._api.readNamespacedPod({ name: podName, namespace: ns })
    const phase = result?.status?.phase
    return phase === 'Running'
  }

  // ─────────────────────────────────────────────────────────────────────────
  // execInEnvironment — one-shot command via streamCliInEnvironment wrapper
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Run a command inside the Pod and return buffered stdout/stderr.
   * Thin wrapper over streamCliInEnvironment — captures output to strings,
   * resolves on exit code 0, rejects on non-zero exit.
   *
   * @param {string} podName
   * @param {Object} opts
   * @param {string}   opts.cmd            - Command to run
   * @param {string[]} [opts.args]         - Arguments
   * @param {Object}   [opts.env]          - Extra env vars
   * @param {string}   [opts.cwd]          - Working directory
   * @param {number}   [opts.timeout=30000] - Timeout in ms
   * @param {string}   opts.agentToken     - Auth token for the sidecar
   * @returns {Promise<{ stdout: string, stderr: string }>}
   */
  execInEnvironment(podName, opts = {}) {
    const { timeout = 30_000 } = opts

    return new Promise((resolve, reject) => {
      let proc
      let settled = false

      const settleReject = (err) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        // Drain output streams so PassThroughs never accumulate buffered
        // data after the consumer has moved on (avoids slow-leak on a
        // long-running pod-side child after timeout).
        if (proc) {
          try { proc.stdout.resume() } catch (_) { /* ignore */ }
          try { proc.stderr.resume() } catch (_) { /* ignore */ }
        }
        reject(err)
      }

      const settleResolve = (value) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(value)
      }

      const timer = timeout > 0
        ? setTimeout(() => {
          // Kill the underlying process so the WS closes and the agent
          // SIGTERMs the in-pod child (PROTOCOL.md "Lifecycle and Orphan
          // Prevention"). Otherwise the WS + child + buffered streams
          // leak past the caller's await point.
          if (proc && typeof proc.kill === 'function') {
            try { proc.kill('SIGTERM') } catch (_) { /* ignore */ }
          }
          settleReject(new Error(`execInEnvironment timed out after ${timeout}ms`))
        }, timeout)
        : null

      try {
        proc = this.streamCliInEnvironment(podName, opts)
      } catch (err) {
        settleReject(err)
        return
      }

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (chunk) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString() })

      proc.on('exit', (code) => {
        if (code === 0 || code === null) {
          settleResolve({ stdout, stderr })
        } else {
          settleReject(new Error(stderr.trim() || `Command exited with code ${code}`))
        }
      })

      proc.on('error', (err) => {
        settleReject(err)
      })
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // streamCliInEnvironment — open WS to sidecar, send spawn frame, bridge I/O
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Opens a WebSocket connection to the chroxy-pod-agent sidecar running inside
   * the Pod, sends a `spawn` frame per the sidecar protocol (PROTOCOL.md), and
   * returns a ChildProcess-shaped EventEmitter that bridges the WS events to the
   * SpawnedProcess interface consumed by the Agent SDK.
   *
   * Connection is established asynchronously (the WS dial happens in the
   * background; the spawn frame is sent on `open`).  The returned handle
   * immediately exposes `stdout`, `stderr`, and `stdin` streams so the caller
   * can attach listeners before the connection completes.
   *
   * The bearer token used to authenticate with the sidecar is read from the
   * backend's per-Pod registry (populated by `createEnvironment`). Callers do
   * not need to thread `agentToken` through opts; for tests / external pods
   * the token may be passed explicitly via `opts.agentToken`.
   *
   * Like DockerBackend.streamCliInEnvironment, this method also remaps the
   * SDK's host-absolute `cli.js` path (passed as args[0]) to the container's
   * installed CLI path so the Pod can actually exec it.
   *
   * @param {string} podName
   * @param {Object} opts
   * @param {string}   opts.cmd         - Binary to execute inside the Pod
   * @param {string[]} [opts.args]      - Argument list
   * @param {Object}   [opts.env]       - Extra env vars for the child
   * @param {string}   [opts.cwd]       - Working directory for the child
   * @param {AbortSignal} [opts.signal] - Abort → SIGTERM the child (WS close)
   * @param {string}   [opts.agentToken] - Override the registered bearer token (test seam)
   * @param {string}   [opts.containerCliPath] - Pod-side cli.js path (default fallback)
   * @param {string}   [opts.hostCwd]   - Host CWD mount root for path remapping
   * @param {string}   [opts.namespace] - Namespace override
   * @returns {SidecarProcess} ChildProcess-shaped handle
   */
  streamCliInEnvironment(podName, opts = {}) {
    const {
      cmd, args = [], env, cwd, signal, namespace,
      containerCliPath = DEFAULT_CONTAINER_CLI_PATH,
      hostCwd,
    } = opts
    const ns = namespace || this._namespace

    // Prefer explicit token (test seam), fall back to the in-memory cache, and
    // lazily fetch from the K8s Secret when neither is available (e.g. after a
    // server restart that cleared _agentTokens). The lazy path is async, so we
    // wrap the entire dial in a Promise and let it proceed in the background.
    const tokenOrPromise = opts.agentToken
      || this._agentTokens.get(podName)
      || this._readAgentToken(podName, ns)

    // Remap host cli.js path to container path, mirroring DockerBackend.
    const containerArgs = [...args]
    if (containerArgs.length > 0 &&
        typeof containerArgs[0] === 'string' &&
        containerArgs[0].includes('@anthropic-ai/claude-code/cli.js')) {
      log.info(`Remapped CLI path: ${containerArgs[0]} -> ${containerCliPath}`)
      containerArgs[0] = containerCliPath
    }

    // Remap host cwd to /workspace inside the Pod when provided.
    let containerCwd = cwd
    if (cwd && hostCwd) {
      containerCwd = cwd.startsWith(hostCwd)
        ? '/workspace' + cwd.slice(hostCwd.length)
        : '/workspace'
    }

    const {
      _reconnectDelays: reconnectDelays,
      _maxRetries: maxRetries,
      _setTimeout: setTimeoutImpl,
      _clearTimeout: clearTimeoutImpl,
    } = this
    const proc = new SidecarProcess({ reconnectDelays, maxRetries, setTimeoutImpl, clearTimeoutImpl })

    // Resolve the token (synchronous fast path or async Secret fetch), then dial.
    Promise.resolve(tokenOrPromise).then((agentToken) => {
      if (!agentToken) {
        // Phrasing kept compatible with the existing /agentToken is required/
        // assertion. The token is normally registered by createEnvironment() or
        // repopulated by reconnect(); tests can still pass opts.agentToken directly.
        throw new Error(
          `K8sBackend.streamCliInEnvironment: agentToken is required for Pod "${podName}" ` +
          '(register via createEnvironment(), reconnect(), or pass opts.agentToken)'
        )
      }

      // Bind a redial function so the reconnect loop inside _wireWsToProc can
      // re-dial the same pod without holding a reference to this K8sBackend.
      proc._redial = () => this._dial(podName, ns, agentToken)

      // Dial asynchronously; the returned handle is usable immediately. We
      // capture portforward cleanup callbacks so kill() / exit can tear down
      // the local TCP listener even if dial completes after kill is called.
      return this._dial(podName, ns, agentToken)
    }).then((dialResult) => {
      // dialResult is either { ws, cleanup? } (portforward bridge) or a bare
      // ws (clusterip / direct dial). Normalize.
      const ws = dialResult && dialResult.ws ? dialResult.ws : dialResult
      const cleanup = dialResult && typeof dialResult.cleanup === 'function'
        ? dialResult.cleanup : null

      // Race: kill() / abort may have fired before dial resolved. In that
      // case `proc.killed` is set but `_ws` is null, so the synchronous
      // kill() call did nothing. Detect that here and tear down cleanly.
      if (proc.killed || (signal && signal.aborted)) {
        try { ws.close() } catch (_) { /* ignore */ }
        if (cleanup) { try { cleanup() } catch (_) { /* ignore */ } }
        if (!proc._exited) {
          proc._exited = true
          proc.stdout.push(null)
          proc.stderr.push(null)
          proc.emit('exit', -1)
        }
        return
      }

      _wireWsToProc(ws, proc, {
        cmd, args: containerArgs, env, cwd: containerCwd, signal, cleanup,
      })
    }).catch((err) => {
      log.warn(`streamCliInEnvironment dial failed for ${podName}: ${err.message}`)
      if (!proc._exited) {
        proc._exited = true
        proc.stdout.push(null)
        proc.stderr.push(null)
        proc.emit('exit', -1)
      }
    })

    return proc
  }

  // ─────────────────────────────────────────────────────────────────────────
  // reconnectAgentToken — repopulate _agentTokens from the K8s Secret
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Reads the per-Pod Secret and registers the agent token in the in-memory
   * cache.  Called by EnvironmentManager.reconnect() for K8s-backed
   * environments so that streamCliInEnvironment() works after a server restart.
   *
   * Returns `true` when the token was successfully fetched and cached; `false`
   * when the Secret no longer exists (Pod was externally garbage-collected).
   *
   * @param {string} podName - Pod name (the containerId handle)
   * @param {Object} [opts]
   * @param {string} [opts.namespace] - Overrides the constructor default namespace
   * @returns {Promise<boolean>}
   */
  async reconnectAgentToken(podName, opts = {}) {
    const ns = opts.namespace || this._namespace
    const token = await this._readAgentToken(podName, ns)
    return token !== null
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase-1 stubs — not yet implemented
  // ─────────────────────────────────────────────────────────────────────────

  createComposeEnvironment(_opts) {
    return Promise.reject(notImplemented('createComposeEnvironment'))
  }

  destroyComposeEnvironment(_opts) {
    return Promise.reject(notImplemented('destroyComposeEnvironment'))
  }

  removeImage(_imageTag) {
    return Promise.reject(notImplemented('removeImage'))
  }

  listEnvironments() {
    return Promise.reject(notImplemented('listEnvironments'))
  }

  commitEnvironment(_containerId, _imageTag) {
    return Promise.reject(notImplemented('commitEnvironment'))
  }

  // K8s pods have unique names by design — there is no mutable canonical name
  // slot to free.  The restore flow tolerates a no-op here because the old pod
  // is destroyed after the new one passes its health check.  See types.js.
  renameEnvironment(_containerId, _newName) {
    return Promise.resolve()
  }

  restoreEnvironment(_opts) {
    return Promise.reject(notImplemented('restoreEnvironment'))
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resolve the WebSocket URL for the sidecar and open a connection.
   * Mode 'clusterip': dial pod-ip:AGENT_PORT directly.
   * Mode 'portforward': open a local TCP listener and bridge each connection
   *   through @kubernetes/client-node `PortForward` to the Pod's AGENT_PORT,
   *   then dial localhost:<listenerPort>.
   *
   * When `_dialWs` was injected at construction time (test mode) the lookup
   * and port-forward machinery is skipped and `_dialWs` is called directly
   * with a synthetic URL so unit tests never need a real cluster.
   *
   * @param {string} podName
   * @param {string} ns
   * @param {string} token
   * @returns {Promise<WebSocket | { ws: WebSocket, cleanup: Function }>}
   *   Returns either a bare WebSocket (clusterip / direct dial) or a dial
   *   result object that includes a `cleanup` callback for tearing down the
   *   local TCP listener (portforward mode). The caller is expected to invoke
   *   `cleanup` on exit/error so listeners do not leak.
   */
  async _dial(podName, ns, token) {
    if (this._directDial) {
      return this._dialWs(`ws://test/${podName}`, token)
    }

    if (this._connectMode === 'clusterip') {
      const podIp = await this._getPodIp(podName, ns)
      const url = `ws://${podIp}:${AGENT_PORT}`
      log.info(`Dialing sidecar ${podName} via ClusterIP: ${url}`)
      return this._dialWs(url, token)
    }

    // portforward mode
    return this._dialViaPortForward(podName, ns, token)
  }

  /**
   * Look up the Pod's IP address from the API.
   *
   * @param {string} podName
   * @param {string} ns
   * @returns {Promise<string>}
   */
  async _getPodIp(podName, ns) {
    const result = await this._api.readNamespacedPod({ name: podName, namespace: ns })
    const ip = result?.status?.podIP
    if (!ip) throw new Error(`Pod ${podName} has no podIP yet — is it Running?`)
    return ip
  }

  /**
   * Set up a localhost TCP listener that bridges each incoming connection
   * through `PortForward.portForward` to the Pod's AGENT_PORT, then dial
   * `ws://127.0.0.1:<listenerPort>` and return both the WS and a cleanup
   * callback that closes the listener.
   *
   * The `@kubernetes/client-node` `PortForward` API is per-connection: it
   * does NOT bind a local TCP listener — the caller does. Each call to
   * `pf.portForward(ns, pod, [TARGET_POD_PORT], stream, errStream, input,
   * [TARGET_POD_PORT])` proxies a single duplex stream pair to the pod's
   * `TARGET_POD_PORT`. We wire the local TCP socket as that stream pair so
   * an HTTP/WS client connecting to the listener appears at the pod's port
   * 7681 (AGENT_PORT) end-to-end.
   *
   * @param {string} podName
   * @param {string} ns
   * @param {string} token
   * @returns {Promise<{ ws: WebSocket, cleanup: Function }>}
   */
  async _dialViaPortForward(podName, ns, token) {
    const net = this._netImpl || (await import('net'))
    const pf = this._portForwardImpl || (this._kc ? new PortForward(this._kc) : null)
    if (!pf) {
      throw new Error('PortForward not available — no KubeConfig (was _coreV1Api injected in tests?)')
    }

    return new Promise((resolve, reject) => {
      // Bridge each accepted local TCP connection through the K8s
      // portforward subresource to the Pod's fixed AGENT_PORT.
      const server = net.createServer((socket) => {
        try {
          // Per @kubernetes/client-node API:
          //   portForward(ns, podName, targetPorts, output, error, input, [outputPorts])
          // The target/output port array contains the POD-side port, not the
          // local listener port.
          pf.portForward(ns, podName, [AGENT_PORT], socket, socket, socket, [AGENT_PORT])
        } catch (err) {
          log.warn(`portForward bridge error for ${podName}: ${err.message}`)
          try { socket.destroy() } catch (_) { /* ignore */ }
        }
      })

      server.on('error', (err) => {
        log.warn(`portforward listener error for ${podName}: ${err.message}`)
      })

      server.listen(0, '127.0.0.1', async () => {
        const localPort = server.address().port
        const url = `ws://127.0.0.1:${localPort}`
        log.info(`Dialing sidecar ${podName} via port-forward listener on port ${localPort}`)

        const cleanup = () => {
          try { server.close() } catch (_) { /* ignore */ }
        }

        try {
          const ws = await this._dialWs(url, token)
          resolve({ ws, cleanup })
        } catch (err) {
          cleanup()
          reject(err)
        }
      })
    })
  }

  /**
   * Read the per-Pod Secret and return the agent token, caching it in
   * `_agentTokens` for subsequent calls.  Returns `null` when the Secret
   * does not exist (404) so callers can distinguish "gone" from errors.
   *
   * This is the recovery path for server restart: the Secret is the canonical
   * source of truth for the token; the in-memory map is just a cache.
   *
   * @param {string} podName
   * @param {string} ns
   * @returns {Promise<string|null>}
   */
  async _readAgentToken(podName, ns) {
    const secretName = _deriveSecretName(podName)
    try {
      const secret = await this._api.readNamespacedSecret({ name: secretName, namespace: ns })
      // The K8s API decodes base64 stringData into `.data` as base64-encoded
      // strings, but when we store via `stringData` the API may return the
      // value under either field depending on the client version.  Prefer
      // `data` (always present on read responses), fall back to `stringData`.
      const raw = secret?.data?.CHROXY_AGENT_TOKEN
        || secret?.stringData?.CHROXY_AGENT_TOKEN
      if (!raw) {
        log.warn(`Secret ${secretName} exists but has no CHROXY_AGENT_TOKEN — treating as missing`)
        return null
      }
      // K8s stores Secret `.data` values as base64; decode unconditionally.
      // If the value came via `stringData` it is already plaintext, but a
      // base64-decode of a base64url-encoded token (no padding) is idempotent
      // only when the token length is a multiple of 4.  Instead, detect the
      // encoding: `data` values are padded base64; `stringData` values are not.
      const token = secret?.data?.CHROXY_AGENT_TOKEN
        ? Buffer.from(raw, 'base64').toString('utf8')
        : raw
      // Cache for subsequent calls so we only hit the API once per pod per process.
      this._agentTokens.set(podName, token)
      log.info(`Loaded agentToken for Pod ${podName} from Secret ${secretName}`)
      return token
    } catch (err) {
      if (_isNotFound(err)) {
        log.warn(`Secret ${secretName} not found — pod may have been externally deleted`)
        return null
      }
      throw err
    }
  }

  /**
   * Delete a K8s Secret, swallowing 404s and errors (best-effort).
   *
   * @param {string} secretName
   * @param {string} ns
   */
  async _deleteSecret(secretName, ns) {
    try {
      await this._api.deleteNamespacedSecret({ name: secretName, namespace: ns })
      log.info(`Deleted Secret ${secretName}`)
    } catch (err) {
      if (!_isNotFound(err)) {
        log.warn(`Failed to delete Secret ${secretName}: ${err.message}`)
      }
    }
  }
}

// ─── SidecarProcess ──────────────────────────────────────────────────────────

/**
 * ChildProcess-shaped EventEmitter that bridges the sidecar WebSocket protocol
 * to the SpawnedProcess interface expected by the Agent SDK.
 *
 * Exposes:
 *   - `stdout` {PassThrough} — receives data pushed via `event` WS frames
 *   - `stderr` {PassThrough} — receives data pushed via `stderr` WS frames
 *   - `stdin`  {PassThrough} — writes here are forwarded to the sidecar as
 *                              `stdin` / `stdin_end` WS frames (#3336)
 *   - `'exit'` event (code)  — emitted when the `exit` WS frame arrives or on error
 *
 * On unexpected WS disconnect the process attempts to reconnect with exponential
 * backoff (#3321). The redial function is injected via `proc._redial` after
 * construction by `K8sBackend.streamCliInEnvironment`.
 *
 * ### stdin forwarding and reconnect semantics
 *
 * `stdin` frames are NOT buffered by the agent's ring buffer and are NOT
 * replayed on resume.  A reconnect (`resume` frame) picks up output from where
 * the client left off — it does NOT re-send stdin.  Callers must NOT replay
 * stdin data after a reconnect; doing so would cause the in-pod child to
 * receive duplicate input.
 *
 * ### stdin write before WS is open
 *
 * Writes that arrive before the WS dial resolves are held in `_stdinBuffer`
 * (an array of Buffer chunks) and flushed as `stdin` frames when `_wireStdin`
 * is called by `_wireWsToProc` after the connection opens.  If the process is
 * killed or exits before the dial resolves, the buffer is discarded silently.
 */
class SidecarProcess extends EventEmitter {
  /**
   * @param {Object} [opts]
   * @param {number[]} [opts.reconnectDelays]  - Backoff delay schedule in ms
   * @param {number}   [opts.maxRetries]       - Max reconnect attempts before giving up
   * @param {Function} [opts.setTimeoutImpl]   - setTimeout override for deterministic testing
   * @param {Function} [opts.clearTimeoutImpl] - clearTimeout override for deterministic testing
   */
  constructor({
    reconnectDelays = DEFAULT_RECONNECT_DELAYS,
    maxRetries = DEFAULT_MAX_RETRIES,
    setTimeoutImpl,
    clearTimeoutImpl,
  } = {}) {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.stdin = new PassThrough()
    this.killed = false
    this._exited = false
    this._ws = null
    this._cleanup = null

    // Reconnect state (#3321)
    this._reconnectDelays = reconnectDelays
    this._maxRetries = maxRetries
    this._retryAttempt = 0   // current reconnect attempt count
    this._retryTimer = null  // pending setTimeout handle for next reconnect
    this._sessionId = null   // set by _wireWsToProc when session_started arrives
    this._lastSeq = 0        // last seq number seen from the sidecar
    this._redial = null      // injected by K8sBackend.streamCliInEnvironment

    // Timer seam: defaults to globals; override in tests for deterministic scheduling.
    this._setTimeout = setTimeoutImpl || setTimeout
    this._clearTimeout = clearTimeoutImpl || clearTimeout
    // stdin forwarding (#3336): buffer writes that arrive before the WS opens.
    // Once _wireStdin() is called the buffer is flushed and subsequent writes
    // go directly to the live WS.
    this._stdinBuffer = []       // Array<Buffer> — pre-dial write buffer
    this._stdinWired = false     // true once _wireStdin() has been called
    this._stdinEnded = false     // true once stdin 'end' has fired

    // Accumulate stdin data until the WS is ready.
    this.stdin.on('data', (chunk) => {
      if (this._stdinWired) {
        // _wireStdin() already flushed and replaced this handler — should not
        // reach here, but guard defensively.
        return
      }
      this._stdinBuffer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    this.stdin.on('end', () => {
      this._stdinEnded = true
      if (this._stdinWired) {
        // WS is live — send stdin_end frame if WS is still open.
        _sendStdinEnd(this._ws)
      }
      // If not yet wired, _wireStdin() will send stdin_end after flushing.
    })
  }

  kill(signal = 'SIGTERM') {
    if (this.killed) return
    this.killed = true
    log.info(`SidecarProcess.kill(${signal}) — closing WS`)
    // Cancel any pending reconnect timer so we don't re-dial after kill.
    if (this._retryTimer) {
      this._clearTimeout(this._retryTimer)
      this._retryTimer = null
    }
    if (this._ws) {
      try {
        this._ws.close()
      } catch (_) {
        // ignore
      }
    }
    if (this._cleanup) {
      try { this._cleanup() } catch (_) { /* ignore */ }
      this._cleanup = null
    }
    // If the WS was never wired (kill called before dial resolved), there
    // will be no `close` event to drive the exit. The post-dial wiring path
    // checks `proc.killed` and synthesizes exit(-1) in that case.
  }
}

// ─── WS wiring ───────────────────────────────────────────────────────────────

/**
 * Wire a live WebSocket to a SidecarProcess once the connection is open.
 * Sends the `spawn` frame (new session) or `resume` frame (reconnect) and
 * routes incoming frames to the proc's streams.
 *
 * On an unexpected WS close or error the function schedules a reconnect with
 * exponential backoff if the session has been established (session_started
 * received). On reconnect, a `resume` frame is sent so the agent can replay
 * any buffered output the client missed.
 *
 * Unrecoverable situations (max retries exceeded, session_lost from agent)
 * emit exit(-2) so upstream consumers can distinguish session loss from a
 * clean pre-session failure (exit(-1)).
 *
 * @param {WebSocket} ws
 * @param {SidecarProcess} proc
 * @param {Object} spawnOpts
 * @param {string}    spawnOpts.cmd
 * @param {string[]} [spawnOpts.args]
 * @param {Object}   [spawnOpts.env]
 * @param {string}   [spawnOpts.cwd]
 * @param {AbortSignal} [spawnOpts.signal]
 * @param {Function} [spawnOpts.cleanup] - Optional teardown for portforward bridge
 */
function _wireWsToProc(ws, proc, { cmd, args = [], env, cwd, signal, cleanup } = {}) {
  // Distinguish initial wiring (spawn) from a reconnect (resume).
  const isReconnect = Boolean(proc._sessionId)

  // Attach the WS + cleanup to the proc so kill() can close them
  proc._ws = ws
  if (cleanup) proc._cleanup = cleanup

  // Tracks whether the agent has produced any output yet. An `error` frame
  // that arrives BEFORE any event/stderr means the spawn was rejected — per
  // PROTOCOL.md the WS stays open in that case, but the consumer's `exit`
  // listener must still fire or `execInEnvironment` will hang until timeout.
  let firstFrameSeen = false

  const finishWithExit = (code) => {
    if (proc._exited) return
    proc._exited = true
    if (proc._retryTimer) {
      proc._clearTimeout(proc._retryTimer)
      proc._retryTimer = null
    }
    proc.stdout.push(null)
    proc.stderr.push(null)
    proc.emit('exit', code)
    try { ws.close() } catch (_) { /* ignore */ }
    if (proc._cleanup) {
      try { proc._cleanup() } catch (_) { /* ignore */ }
      proc._cleanup = null
    }
  }

  /**
   * Schedule a reconnect attempt with exponential backoff.
   * If no session has been established yet (pre-session failure) emit exit(-1).
   * If max retries are exceeded emit exit(-2) (session unrecoverable).
   *
   * Idempotent: WS 'error' and 'close' handlers can both fire for the same
   * underlying drop; without de-dup we would create two pending timers and
   * double-step the retry counter. Returning early when a timer is already
   * pending guarantees one reconnect attempt per drop.
   */
  const scheduleReconnect = () => {
    if (proc._exited || proc.killed) return
    if (proc._retryTimer) return  // already scheduled — drop duplicate trigger
    if (!proc._sessionId) {
      // Failed before the session was acknowledged — treat as connection failure.
      finishWithExit(-1)
      return
    }
    if (proc._retryAttempt >= proc._maxRetries) {
      log.warn(`SidecarProcess: max retries (${proc._maxRetries}) exceeded — giving up`)
      finishWithExit(-2)
      return
    }
    const delay = proc._reconnectDelays[
      Math.min(proc._retryAttempt, proc._reconnectDelays.length - 1)
    ]
    proc._retryAttempt += 1
    log.info(`SidecarProcess: scheduling reconnect attempt ${proc._retryAttempt} in ${delay}ms`)
    proc._retryTimer = proc._setTimeout(() => {
      proc._retryTimer = null
      if (proc._exited || proc.killed) return
      proc._redial().then((dialResult) => {
        if (proc._exited || proc.killed) {
          // kill() fired during dial — tear down cleanly.
          const rws = dialResult && dialResult.ws ? dialResult.ws : dialResult
          try { rws.close() } catch (_) { /* ignore */ }
          const rCleanup = dialResult && typeof dialResult.cleanup === 'function'
            ? dialResult.cleanup : null
          if (rCleanup) { try { rCleanup() } catch (_) { /* ignore */ } }
          // Caller-initiated cancellation → exit(-1) (matches the synchronous
          // kill() before-dial path). exit(-2) is reserved for unrecoverable
          // session loss the consumer cannot mitigate.
          if (!proc._exited) finishWithExit(-1)
          return
        }
        const rws = dialResult && dialResult.ws ? dialResult.ws : dialResult
        const rCleanup = dialResult && typeof dialResult.cleanup === 'function'
          ? dialResult.cleanup : null
        _wireWsToProc(rws, proc, { cmd, args, env, cwd, signal, cleanup: rCleanup })
      }).catch((err) => {
        log.warn(`SidecarProcess: reconnect dial failed: ${err.message}`)
        scheduleReconnect()
      })
    }, delay)
  }

  const sendFirst = () => {
    let frame
    if (isReconnect) {
      frame = { type: 'resume', sessionId: proc._sessionId, lastSeq: proc._lastSeq }
      log.info(`Sent resume frame: sessionId=${proc._sessionId} lastSeq=${proc._lastSeq}`)
    } else {
      frame = { type: 'spawn', cmd, args, stdin: 'ignore' }
      // Always request a piped stdin channel so the consumer can write user
      // turns as NDJSON (--input-format stream-json workflow). Matches the
      // sidecar protocol default introduced by #3329.
      frame = { type: 'spawn', cmd, args, stdin: 'pipe' }
      if (env && Object.keys(env).length > 0) frame.env = env
      if (cwd) frame.cwd = cwd
      log.info(`Sent spawn frame: ${cmd} ${args.slice(0, 2).join(' ')}`)
    }
    ws.send(JSON.stringify(frame))
    // Wire proc.stdin → WS after the first frame is sent so the agent has
    // already opened a piped stdin channel before we forward any data.
    // On reconnect we do NOT re-wire — stdin forwarding is not resumed
    // (see class-level JSDoc on resume semantics).
    if (!isReconnect) {
      _wireStdin(ws, proc)
    }
  }

  if (ws.readyState === WebSocket.OPEN) {
    sendFirst()
  } else {
    ws.once('open', sendFirst)
  }

  ws.on('message', (raw) => {
    let frame
    try {
      frame = JSON.parse(raw.toString())
    } catch {
      log.warn('Received non-JSON frame from sidecar — ignoring')
      return
    }

    // Track the highest seq seen for resume replay (#3321).
    if (typeof frame.seq === 'number' && frame.seq > proc._lastSeq) {
      proc._lastSeq = frame.seq
    }

    switch (frame.type) {
      case 'session_started':
        // Agent acknowledged the spawn and assigned a sessionId.
        proc._sessionId = frame.sessionId
        proc._retryAttempt = 0  // reset retry counter on fresh session
        log.info(`Sidecar session started: ${frame.sessionId}`)
        break
      case 'resumed':
        // Agent acknowledged a successful resume after replay (#3348). Reset
        // the retry counter so `maxRetries` is a per-blip budget, not a
        // session-lifetime budget. PROTOCOL.md documents this frame.
        proc._retryAttempt = 0
        log.info(`Sidecar session resumed: ${frame.sessionId} (replayed=${frame.replayedCount ?? 0})`)
        break
      case 'session_lost':
        // Agent does not recognise our sessionId or cannot replay the gap
        // (buffer overflow). Either way unrecoverable — exit(-2) signals
        // session loss to the caller.
        log.warn(`Sidecar session lost: ${frame.sessionId} (reason=${frame.reason || 'unknown'})`)
        finishWithExit(-2)
        break
      case 'event': {
        firstFrameSeen = true
        // Each `event` frame carries one parsed stdout NDJSON object (or raw string).
        // Re-serialize to NDJSON so the SDK's readline reader sees complete lines.
        const line = typeof frame.payload === 'string'
          ? frame.payload
          : JSON.stringify(frame.payload)
        proc.stdout.push(line + '\n')
        break
      }
      case 'stderr':
        firstFrameSeen = true
        proc.stderr.push(frame.data)
        break
      case 'exit':
        finishWithExit(frame.code ?? 0)
        break
      case 'error':
        log.warn(`Sidecar error frame: ${frame.message}`)
        proc.stderr.push(`sidecar error: ${frame.message}\n`)
        // Per PROTOCOL.md the agent leaves the connection open after most
        // error frames. But spawn-rejection errors arrive BEFORE any
        // event/stderr (because the child never started) and the agent
        // will not emit a follow-up `exit`. Without a synthetic exit the
        // consumer hangs until its timeout. Treat any error-before-first-
        // frame as fatal and synthesize exit(-1) to terminate the wait.
        if (!firstFrameSeen) {
          finishWithExit(-1)
        }
        break
      case 'pong':
        // no-op
        break
      default:
        log.warn(`Unknown sidecar frame type: ${frame.type}`)
    }
  })

  ws.on('error', (err) => {
    if (proc._exited) return
    log.warn(`Sidecar WS error for process: ${err.message}`)
    // Caller asked to stop. Real-world WS errors (TCP reset, DNS, etc.) do
    // NOT guarantee a follow-up close with code 1000 — emit exit(-1) here
    // so the consumer's `on('exit')` listener fires regardless of which
    // event the underlying ws emits. Without this, kill() before a 1006-
    // shaped drop leaves _exited=false forever (#3346).
    if (proc.killed || (signal && signal.aborted)) {
      finishWithExit(-1)
      return
    }
    scheduleReconnect()
  })

  ws.on('close', (code) => {
    if (proc._exited) return
    // Caller asked to stop — synthesize exit(-1) immediately, regardless of
    // the close code. Real WS implementations emit 1006 when the TCP socket
    // is dropped abruptly (the common case after kill()), and the original
    // code path fell through to scheduleReconnect() which then bailed on
    // proc.killed without ever emitting exit (#3346).
    if (proc.killed || (signal && signal.aborted)) {
      log.info(`Sidecar WS closed after kill (code=${code})`)
      finishWithExit(-1)
      return
    }
    // Normal close codes (1000 = normal, 1001 = going away) indicate a
    // clean shutdown — treat as pre-session failure or natural exit.
    if (code === 1000 || code === 1001) {
      log.info(`Sidecar WS closed normally (code=${code})`)
      finishWithExit(-1)
      return
    }
    log.warn(`Sidecar WS closed unexpectedly (code=${code}) — scheduling reconnect`)
    scheduleReconnect()
  })

  // Abort signal support
  if (signal) {
    const onAbort = () => {
      if (!proc.killed) proc.kill('SIGTERM')
    }
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }
}

// ─── stdin forwarding helpers (#3336) ────────────────────────────────────────

/**
 * Flush the pre-dial stdin buffer and wire future writes to the live WS.
 *
 * Called once by `_wireWsToProc` immediately after the spawn frame is sent.
 * Removes the accumulator `data` listener from `proc.stdin`, replaces it with
 * a live-forwarding listener, flushes any buffered chunks, and sends
 * `stdin_end` if the stream already ended while we were dialling.
 *
 * This function is intentionally NOT called on reconnect because stdin frames
 * are not replayed by the agent's ring buffer.  The consumer must not send
 * the same stdin bytes twice.
 *
 * @param {WebSocket} ws
 * @param {SidecarProcess} proc
 */
function _wireStdin(ws, proc) {
  // Mark as wired first to suppress the accumulator listener's fallthrough.
  proc._stdinWired = true

  // Replace the accumulator with a live-forwarding listener.
  // Remove all 'data' listeners that the constructor added (there should be
  // only the one accumulator, but removeAllListeners scopes to this event).
  proc.stdin.removeAllListeners('data')
  proc.stdin.on('data', (chunk) => {
    if (ws.readyState !== WebSocket.OPEN) {
      // WS closed mid-stream. Emit an error on proc so the consumer knows
      // stdin writes are being dropped, then swallow silently afterwards.
      proc.emit('error', new Error('SidecarProcess: WS closed while writing stdin'))
      // Stop forwarding — remove this listener so further writes are silent.
      proc.stdin.removeAllListeners('data')
      return
    }
    try {
      const data = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      ws.send(JSON.stringify({ type: 'stdin', data }))
    } catch (err) {
      log.warn(`SidecarProcess: failed to send stdin frame: ${err.message}`)
    }
  })

  // Flush buffered chunks accumulated before the WS opened.
  for (const chunk of proc._stdinBuffer) {
    if (ws.readyState !== WebSocket.OPEN) break
    try {
      ws.send(JSON.stringify({ type: 'stdin', data: chunk.toString('utf8') }))
    } catch (err) {
      log.warn(`SidecarProcess: failed to flush buffered stdin frame: ${err.message}`)
    }
  }
  proc._stdinBuffer = []  // release memory

  // stdin may have already ended while we were buffering.
  if (proc._stdinEnded) {
    _sendStdinEnd(ws)
  }
}

/**
 * Send a `stdin_end` frame over the WS if the connection is still open.
 *
 * @param {WebSocket|null} ws
 */
function _sendStdinEnd(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(JSON.stringify({ type: 'stdin_end' }))
  } catch (err) {
    log.warn(`SidecarProcess: failed to send stdin_end frame: ${err.message}`)
  }
}

// ─── Default WS dial factory ─────────────────────────────────────────────────

/**
 * Open a WebSocket to `url` with bearer token auth.
 * Resolves once the WS `open` event fires.
 *
 * @param {string} url
 * @param {string} token
 * @returns {Promise<WebSocket>}
 */
function _defaultDialWs(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Detects a Kubernetes 404 across the shapes the JS clients have used over time.
// `@kubernetes/client-node` v1.x throws `ApiException` with the HTTP status on
// `err.code` — that's the canonical real-world shape. The other branches cover
// older clients and adapter wrappers, so we keep them as a safety net.
function _isNotFound(err) {
  return err?.code === 404 ||
    err?.statusCode === 404 ||
    err?.response?.statusCode === 404 ||
    err?.body?.code === 404
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Derive a per-Pod Secret name from the canonical Pod name.
 * createEnvironment() names pods `chroxy-env-<envId>` and secrets
 * `chroxy-token-<envId>`; given the former, return the latter.
 */
function _deriveSecretName(podName) {
  if (typeof podName === 'string' && podName.startsWith('chroxy-env-')) {
    return 'chroxy-token-' + podName.slice('chroxy-env-'.length)
  }
  // Fallback: best-effort token cleanup name based on the pod name itself.
  return `chroxy-token-${podName}`
}

/**
 * Parse a Docker-style volume mount string into its components.
 *
 * Supported formats:
 *   "/host/path:/container/path"
 *   "/host/path:/container/path:ro"
 *
 * Returns null for unrecognised input so the caller can log and skip.
 *
 * @param {string} mountStr
 * @returns {{ hostPath: string, containerPath: string, readOnly: boolean } | null}
 */
function _parseMountString(mountStr) {
  if (typeof mountStr !== 'string') return null
  const parts = mountStr.split(':')
  if (parts.length < 2) return null
  const hostPath = parts[0]
  const containerPath = parts[1]
  if (!hostPath || !containerPath) return null
  const readOnly = parts[2] === 'ro'
  return { hostPath, containerPath, readOnly }
}

/**
 * Extract the container port from a forwardPorts entry.
 *
 * Accepts:
 *   - A bare number or numeric string: "8080" → 8080
 *   - A "hostPort:containerPort" string: "9000:8080" → 8080
 *
 * Returns null for non-numeric or zero values.
 *
 * @param {string|number} entry
 * @returns {number | null}
 */
function _parseContainerPort(entry) {
  const str = String(entry)
  const colonIdx = str.indexOf(':')
  const portStr = colonIdx >= 0 ? str.slice(colonIdx + 1) : str
  const port = parseInt(portStr, 10)
  return Number.isFinite(port) && port > 0 ? port : null
}

/**
 * Normalise a memory quantity string to a valid Kubernetes quantity.
 *
 * Docker accepts lowercase suffixes ("g", "m", "k") while Kubernetes expects
 * binary SI suffixes ("Gi", "Mi", "Ki").  This function converts Docker-style
 * single-letter suffixes to their K8s equivalents.  Values that already use
 * K8s suffixes (e.g. "2Gi", "512Mi") or plain integers (bytes) are returned
 * unchanged.
 *
 * Mapping:
 *   "2g"   → "2Gi"
 *   "512m" → "512Mi"
 *   "1024k"→ "1024Ki"
 *   "2Gi"  → "2Gi"   (already valid)
 *   "1024" → "1024"  (plain bytes, valid K8s quantity)
 *
 * @param {string} value
 * @returns {string}
 */
function _normaliseMemoryQuantity(value) {
  const str = String(value)
  // Replace trailing lone-letter suffix (g/m/k, case-insensitive) with the
  // K8s binary equivalent.  A trailing 'i' (already K8s-style) is left alone.
  return str.replace(/^(\d+(?:\.\d+)?)\s*([gGmMkK])$/, (_, num, unit) => {
    const map = { g: 'Gi', G: 'Gi', m: 'Mi', M: 'Mi', k: 'Ki', K: 'Ki' }
    return num + (map[unit] || unit)
  })
}
