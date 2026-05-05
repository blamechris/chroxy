import { KubeConfig, CoreV1Api } from '@kubernetes/client-node'
import { createLogger } from '../../logger.js'

const log = createLogger('k8s-backend')

const POLL_INTERVAL_MS = 1_000
const DESTROY_TIMEOUT_MS = 30_000

function notImplemented(method) {
  const err = new Error(`K8sBackend.${method} is not implemented in Phase 1 — deferred to #3192`)
  err.name = 'NotImplementedError'
  return err
}

/**
 * K8sBackend implements the Backend interface (see types.js) using the
 * Kubernetes API via @kubernetes/client-node.
 *
 * Phase 1 (#3191): createEnvironment (Pod create) + destroyEnvironment (Pod delete).
 * All other Backend interface methods throw NotImplementedError until later phases.
 *
 * This class owns NO environment state.  Every method receives the identifier
 * (Pod name) from the caller's in-memory record.  The "handle" stored by
 * EnvironmentManager for a K8s environment is the Pod name string.
 */
export class K8sBackend {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.namespace='default'] - Kubernetes namespace for all Pods
   * @param {boolean} [opts.inCluster]          - Force in-cluster auth (default: auto-detect via KUBERNETES_SERVICE_HOST)
   * @param {string}  [opts.kubeconfigPath]     - Path to kubeconfig file (overrides default search)
   * @param {object}  [opts._coreV1Api]         - Injected CoreV1Api for testing
   */
  constructor({ namespace, inCluster, kubeconfigPath, _coreV1Api } = {}) {
    this._namespace = namespace || 'default'

    if (_coreV1Api) {
      this._api = _coreV1Api
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
      this._api = kc.makeApiClient(CoreV1Api)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // createEnvironment — create a Pod and wait for it to reach Running phase
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a single-container Pod named `chroxy-env-{envId}`.
   *
   * Returns as soon as the Pod is accepted by the API (phase Pending or Running).
   * The caller (EnvironmentManager) is responsible for any further readiness gating.
   *
   * @param {Object} opts - See Backend interface in types.js
   * @param {string}   opts.envId          - Unique environment ID
   * @param {string}   opts.image          - Container image to run
   * @param {Object}   [opts.containerEnv] - Extra environment variables
   * @param {string}   [opts.namespace]    - Overrides the constructor default namespace
   * @returns {Promise<{ containerId: string, containerCliPath: string }>}
   *   containerId — the Pod name (used as handle on subsequent calls)
   *   containerCliPath — hardcoded default; exec-based discovery is Phase 2 (#3192)
   */
  async createEnvironment(opts) {
    const { envId, image, containerEnv, namespace } = opts
    const ns = namespace || this._namespace
    const podName = `chroxy-env-${envId}`

    const env = containerEnv
      ? Object.entries(containerEnv).map(([name, value]) => ({ name, value: String(value) }))
      : []

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
            name: 'env',
            image,
            command: ['sleep', 'infinity'],
            env,
          },
        ],
      },
    }

    log.info(`Creating Pod ${podName} in namespace ${ns}`)
    await this._api.createNamespacedPod({ namespace: ns, body: pod })

    return {
      containerId: podName,
      containerCliPath: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // destroyEnvironment — delete a Pod and wait until it is gone (or 404)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Deletes the named Pod and polls until it no longer exists (404).
   * Idempotent: if the Pod is already gone, resolves immediately with no error.
   *
   * @param {string} podName - Pod name (the containerId handle stored by EnvironmentManager)
   * @param {Object} [opts]
   * @param {string} [opts.namespace] - Overrides the constructor default namespace
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
        return
      }
      log.warn(`Failed to delete Pod ${podName}: ${err.message}`)
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
          return
        }
        log.warn(`Error polling Pod ${podName}: ${err.message}`)
        return
      }
    }

    log.warn(`Timed out waiting for Pod ${podName} to terminate`)
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

  execInEnvironment(_containerId, _opts) {
    return Promise.reject(notImplemented('execInEnvironment'))
  }

  getEnvironmentStatus(_containerId) {
    return Promise.reject(notImplemented('getEnvironmentStatus'))
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
