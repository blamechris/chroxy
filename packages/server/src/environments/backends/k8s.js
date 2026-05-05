import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { KubeConfig, CoreV1Api, PortForward } from '@kubernetes/client-node'
import WebSocket from 'ws'
import { createLogger } from '../../logger.js'

const log = createLogger('k8s-backend')

const POLL_INTERVAL_MS = 1_000
const DESTROY_TIMEOUT_MS = 30_000

/** Default sidecar image — overridden via constructor option */
const DEFAULT_SIDECAR_IMAGE = 'chroxy-pod-agent:latest'

/** Port the chroxy-pod-agent sidecar listens on inside the Pod */
const AGENT_PORT = 7681

// Per-method deferral tracking: each stub points to the issue/phase that owns it.
// Keep this in sync with the Backend interface (types.js) and the K8s phase plan in #3191.
const NOT_IMPLEMENTED_REASON = {
  createComposeEnvironment: 'N/A for K8s — compose is a Docker-only concept',
  destroyComposeEnvironment: 'N/A for K8s — compose is a Docker-only concept',
  removeImage: 'N/A for K8s — image lifecycle is owned by the cluster registry/CRI',
  listEnvironments: 'deferred to Phase 2',
  commitEnvironment: 'deferred to Phase 2',
  renameEnvironment: 'no-op pending #3313',
  restoreEnvironment: 'deferred to Phase 2',
}

function notImplemented(method) {
  const reason = NOT_IMPLEMENTED_REASON[method] || 'deferred to a later phase'
  const err = new Error(`K8sBackend.${method} is not implemented in Phase 1 — ${reason}`)
  err.name = 'NotImplementedError'
  return err
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
   * @param {'portforward'|'clusterip'} [opts.connectMode='portforward'] - How to reach the sidecar
   * @param {object}  [opts._coreV1Api]                 - Injected CoreV1Api for testing
   * @param {object}  [opts._portForward]               - Injected PortForward for testing
   * @param {Function} [opts._dialWs]                   - Injected WS dial factory for testing: (url, token) => WebSocket
   */
  constructor({ namespace, inCluster, kubeconfigPath, sidecarImage,
    connectMode, _coreV1Api, _portForward, _dialWs } = {}) {
    this._namespace = namespace || 'default'
    this._sidecarImage = sidecarImage || DEFAULT_SIDECAR_IMAGE
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
   * @param {Object} opts - See Backend interface in types.js
   * @param {string}   opts.envId          - Unique environment ID
   * @param {string}   [opts.image]        - Overrides the constructor sidecarImage
   * @param {Object}   [opts.containerEnv] - Extra environment variables
   * @param {string}   [opts.namespace]    - Overrides the constructor default namespace
   * @returns {Promise<{ containerId: string, containerCliPath: string, agentToken: string, secretName: string }>}
   *   containerId  — the Pod name (used as handle on subsequent calls)
   *   containerCliPath — hardcoded default; sidecar-based discovery is future work
   *   agentToken   — token to authenticate WS connections (stored in memory by caller)
   *   secretName   — Secret name (stored by caller so destroyEnvironment can delete it)
   */
  async createEnvironment(opts) {
    const { envId, image, containerEnv, namespace } = opts
    const ns = namespace || this._namespace
    const podName = `chroxy-env-${envId}`
    const secretName = `chroxy-token-${envId}`
    const sidecarImage = image || this._sidecarImage

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

    // 4. Create the Pod
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
      spec: {
        restartPolicy: 'Never',
        containers: [
          {
            name: 'agent',
            image: sidecarImage,
            env,
            ports: [{ containerPort: AGENT_PORT, name: 'agent' }],
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
          },
        ],
      },
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

    return {
      containerId: podName,
      containerCliPath: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      agentToken,
      secretName,
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // destroyEnvironment — delete Pod + Secret and wait until Pod is gone (or 404)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Deletes the named Pod and polls until it no longer exists (404).
   * Also deletes the per-Pod Secret if secretName is provided.
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
   * @param {string} [opts.secretName]  - Per-Pod Secret to delete alongside the Pod
   * @returns {Promise<void>}
   */
  async destroyEnvironment(podName, opts = {}) {
    const ns = opts.namespace || this._namespace

    log.info(`Deleting Pod ${podName} in namespace ${ns}`)

    try {
      await this._api.deleteNamespacedPod({ name: podName, namespace: ns })
    } catch (err) {
      if (_isNotFound(err)) {
        log.info(`Pod ${podName} already gone`)
        // Still clean up the Secret
        if (opts.secretName) await this._deleteSecret(opts.secretName, ns)
        return
      }
      log.warn(`Failed to delete Pod ${podName}: ${err.message}`)
      if (opts.secretName) await this._deleteSecret(opts.secretName, ns)
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
          if (opts.secretName) await this._deleteSecret(opts.secretName, ns)
          return
        }
        log.warn(`Error polling Pod ${podName}: ${err.message}`)
        if (opts.secretName) await this._deleteSecret(opts.secretName, ns)
        return
      }
    }

    log.warn(`Timed out waiting for Pod ${podName} to terminate`)
    if (opts.secretName) await this._deleteSecret(opts.secretName, ns)
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
      const timer = timeout > 0
        ? setTimeout(() => {
          reject(new Error(`execInEnvironment timed out after ${timeout}ms`))
        }, timeout)
        : null

      try {
        proc = this.streamCliInEnvironment(podName, opts)
      } catch (err) {
        if (timer) clearTimeout(timer)
        reject(err)
        return
      }

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (chunk) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString() })

      proc.on('exit', (code) => {
        if (timer) clearTimeout(timer)
        if (code === 0 || code === null) {
          resolve({ stdout, stderr })
        } else {
          reject(new Error(stderr.trim() || `Command exited with code ${code}`))
        }
      })

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer)
        reject(err)
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
   * Connection is established synchronously (the WS dial is initiated, then the
   * spawn frame is sent on `open`).  The returned handle immediately exposes
   * `stdout`, `stderr`, and `stdin` streams so the caller can attach listeners
   * before the connection completes.
   *
   * @param {string} podName
   * @param {Object} opts
   * @param {string}   opts.cmd         - Binary to execute inside the Pod
   * @param {string[]} [opts.args]      - Argument list
   * @param {Object}   [opts.env]       - Extra env vars for the child
   * @param {string}   [opts.cwd]       - Working directory for the child
   * @param {AbortSignal} [opts.signal] - Abort → SIGTERM the child (WS close)
   * @param {string}   opts.agentToken  - Bearer token (from createEnvironment return value)
   * @param {string}   [opts.namespace] - Namespace override
   * @returns {SidecarProcess} ChildProcess-shaped handle
   */
  streamCliInEnvironment(podName, opts = {}) {
    const { cmd, args = [], env, cwd, signal, agentToken, namespace } = opts
    const ns = namespace || this._namespace

    if (!agentToken) {
      throw new Error('K8sBackend.streamCliInEnvironment: agentToken is required')
    }

    const proc = new SidecarProcess()

    // Dial asynchronously; the returned handle is usable immediately
    this._dial(podName, ns, agentToken).then((ws) => {
      _wireWsToProc(ws, proc, { cmd, args, env, cwd, signal })
    }).catch((err) => {
      log.warn(`streamCliInEnvironment dial failed for ${podName}: ${err.message}`)
      proc.emit('exit', -1)
    })

    return proc
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

  renameEnvironment(_containerId, _newName) {
    return Promise.reject(notImplemented('renameEnvironment'))
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
   * Mode 'portforward': allocate a local port, set up kubectl port-forward,
   *   then dial localhost:localPort.
   *
   * When `_dialWs` was injected at construction time (test mode) the lookup
   * and port-forward machinery is skipped and `_dialWs` is called directly
   * with a synthetic URL so unit tests never need a real cluster.
   *
   * @param {string} podName
   * @param {string} ns
   * @param {string} token
   * @returns {Promise<WebSocket>}
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
   * Set up a kubectl port-forward via @kubernetes/client-node PortForward,
   * then dial the sidecar over the local tunnel.
   *
   * @param {string} podName
   * @param {string} ns
   * @param {string} token
   * @returns {Promise<WebSocket>}
   */
  async _dialViaPortForward(podName, ns, token) {
    const { createServer } = await import('net')

    return new Promise((resolve, reject) => {
      // Bind a TCP server on port 0 to get a free OS port, then immediately
      // close it.  The risk of a race is small and acceptable for dev/test use.
      const probe = createServer()
      probe.listen(0, '127.0.0.1', () => {
        const localPort = probe.address().port
        probe.close(async () => {
          try {
            await this._startPortForward(podName, ns, localPort)
            const url = `ws://127.0.0.1:${localPort}`
            log.info(`Dialing sidecar ${podName} via port-forward on port ${localPort}`)
            const ws = await this._dialWs(url, token)
            resolve(ws)
          } catch (err) {
            reject(err)
          }
        })
      })
      probe.on('error', reject)
    })
  }

  /**
   * Start a PortForward tunnel from localhost:localPort to Pod:AGENT_PORT.
   *
   * @param {string} podName
   * @param {string} ns
   * @param {number} localPort
   * @returns {Promise<void>} resolves once the tunnel is established
   */
  async _startPortForward(podName, ns, localPort) {
    const pf = this._portForwardImpl || (this._kc ? new PortForward(this._kc) : null)
    if (!pf) {
      throw new Error('PortForward not available — no KubeConfig (was _coreV1Api injected in tests?)')
    }

    const { PassThrough: PT } = await import('stream')
    const output = new PT()
    const errStream = new PT()
    const input = new PT()

    // portForward sets up the K8s SPDY/WS tunnel; once the promise resolves
    // the tunnel is active and connections to localPort will be forwarded.
    await pf.portForward(ns, podName, [localPort], output, errStream, input)
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
 *   - `stdin`  {PassThrough} — writes here are forwarded to the child (future)
 *   - `'exit'` event (code)  — emitted when the `exit` WS frame arrives or on error
 */
class SidecarProcess extends EventEmitter {
  constructor() {
    super()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.stdin = new PassThrough()
    this.killed = false
    this._exited = false
  }

  kill(signal = 'SIGTERM') {
    if (this.killed) return
    this.killed = true
    log.info(`SidecarProcess.kill(${signal}) — closing WS`)
    if (this._ws) {
      try {
        this._ws.close()
      } catch (_) {
        // ignore
      }
    }
  }
}

// ─── WS wiring ───────────────────────────────────────────────────────────────

/**
 * Wire a live WebSocket to a SidecarProcess once the connection is open.
 * Sends the `spawn` frame and routes incoming frames to the proc's streams.
 *
 * @param {WebSocket} ws
 * @param {SidecarProcess} proc
 * @param {Object} spawnOpts - { cmd, args, env, cwd, signal }
 */
function _wireWsToProc(ws, proc, { cmd, args = [], env, cwd, signal } = {}) {
  // Attach the WS to the proc so kill() can close it
  proc._ws = ws

  const sendSpawn = () => {
    const frame = { type: 'spawn', cmd, args }
    if (env && Object.keys(env).length > 0) frame.env = env
    if (cwd) frame.cwd = cwd
    ws.send(JSON.stringify(frame))
    log.info(`Sent spawn frame: ${cmd} ${args.slice(0, 2).join(' ')}`)
  }

  if (ws.readyState === WebSocket.OPEN) {
    sendSpawn()
  } else {
    ws.once('open', sendSpawn)
  }

  ws.on('message', (raw) => {
    let frame
    try {
      frame = JSON.parse(raw.toString())
    } catch {
      log.warn('Received non-JSON frame from sidecar — ignoring')
      return
    }

    switch (frame.type) {
      case 'event': {
        // Each `event` frame carries one parsed stdout NDJSON object (or raw string).
        // Re-serialize to NDJSON so the SDK's readline reader sees complete lines.
        const line = typeof frame.payload === 'string'
          ? frame.payload
          : JSON.stringify(frame.payload)
        proc.stdout.push(line + '\n')
        break
      }
      case 'stderr':
        proc.stderr.push(frame.data)
        break
      case 'exit':
        proc._exited = true
        proc.stdout.push(null)   // EOF
        proc.stderr.push(null)
        proc.emit('exit', frame.code ?? 0)
        ws.close()
        break
      case 'error':
        log.warn(`Sidecar error frame: ${frame.message}`)
        proc.stderr.push(`sidecar error: ${frame.message}\n`)
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
    proc._exited = true
    log.warn(`Sidecar WS error for process: ${err.message}`)
    proc.stdout.push(null)
    proc.stderr.push(null)
    // #3321 — on WS drop emit exit with code -1 so the session errors cleanly
    proc.emit('exit', -1)
  })

  ws.on('close', (code, reason) => {
    if (proc._exited) return
    proc._exited = true
    log.warn(`Sidecar WS closed unexpectedly (code=${code} reason=${reason})`)
    proc.stdout.push(null)
    proc.stderr.push(null)
    proc.emit('exit', -1)
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
