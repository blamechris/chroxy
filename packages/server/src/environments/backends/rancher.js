import { KubeConfig, CoreV1Api } from '@kubernetes/client-node'
import { K8sBackend } from './k8s.js'
import { createLogger } from '../../logger.js'

const log = createLogger('rancher-backend')

/**
 * Rancher cluster-ID format: `c-<short>` (legacy RKE) or `c-m-<random>` (Rancher
 * v2 provisioned). We accept both by requiring a `c-` prefix followed by
 * lowercase alphanumerics and hyphens. Validating up-front keeps a typo'd
 * clusterId from being silently spliced into the proxy URL where it would
 * surface as an opaque 404 from the Rancher server.
 */
const RANCHER_CLUSTER_ID = /^c-[a-z0-9-]+$/

/**
 * Rancher project-ID format: `p-<random>`. Used only when annotating a
 * project-scoped namespace; never spliced into a URL.
 */
const RANCHER_PROJECT_ID = /^p-[a-z0-9-]+$/

/** Annotation Rancher reads to bind a namespace to a project. */
const PROJECT_ID_ANNOTATION = 'field.cattle.io/projectId'

/**
 * Builds the Rancher kube-API proxy path for a cluster.
 *
 * Rancher fronts each downstream cluster's Kubernetes API under
 * `<rancherUrl>/k8s/clusters/<clusterId>`, authenticated with a Rancher bearer
 * token. Pointing a standard `@kubernetes/client-node` client at this URL lets
 * the entire K8sBackend operate unchanged — Rancher is purely an auth/proxy
 * layer in front of the kube API.
 *
 * @param {string} rancherUrl - Rancher server base URL (trailing slash tolerated)
 * @param {string} clusterId  - Rancher downstream cluster ID (e.g. `c-m-abc123`)
 * @returns {string} Fully-qualified proxy URL
 */
function buildProxyUrl(rancherUrl, clusterId) {
  const base = rancherUrl.replace(/\/+$/, '')
  return `${base}/k8s/clusters/${clusterId}`
}

/**
 * Validates the Rancher-specific connection options and normalises them.
 *
 * Enforced (all required unless noted):
 *   - rancherUrl: non-empty http(s):// URL
 *   - clusterId : matches the Rancher cluster-ID format
 *   - token     : non-empty string (bearer token; never logged)
 *   - caData    : optional, base64-encoded PEM bundle (string)
 *   - skipTLSVerify: optional boolean (default false)
 *
 * @param {Object} opts
 * @returns {{ rancherUrl: string, clusterId: string, token: string, caData?: string, skipTLSVerify: boolean }}
 * @throws {Error} on any malformed option
 */
function validateRancherOptions({ rancherUrl, clusterId, token, caData, skipTLSVerify } = {}) {
  if (typeof rancherUrl !== 'string' || rancherUrl.length === 0) {
    throw new Error('RancherBackend: rancherUrl must be a non-empty string')
  }
  let parsed
  try {
    parsed = new URL(rancherUrl)
  } catch {
    throw new Error(`RancherBackend: rancherUrl is not a valid URL: ${rancherUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`RancherBackend: rancherUrl must use http:// or https://, got ${parsed.protocol}`)
  }

  if (typeof clusterId !== 'string' || !RANCHER_CLUSTER_ID.test(clusterId)) {
    throw new Error(`RancherBackend: clusterId must match the Rancher cluster-ID format (c-...), got "${clusterId}"`)
  }

  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('RancherBackend: token must be a non-empty bearer token string')
  }

  if (caData != null && (typeof caData !== 'string' || caData.length === 0)) {
    throw new Error('RancherBackend: caData, when provided, must be a non-empty base64-encoded PEM string')
  }

  if (skipTLSVerify != null && typeof skipTLSVerify !== 'boolean') {
    throw new Error(`RancherBackend: skipTLSVerify must be a boolean, got ${typeof skipTLSVerify}`)
  }

  return {
    rancherUrl,
    clusterId,
    token,
    caData: caData ?? undefined,
    skipTLSVerify: skipTLSVerify ?? false,
  }
}

/**
 * Builds a CoreV1Api client pointed at the Rancher kube-API proxy.
 *
 * Uses `KubeConfig.loadFromClusterAndUser` so no kubeconfig file is needed:
 * the cluster's server URL is the Rancher proxy endpoint and the user carries
 * the Rancher bearer token. TLS verification is on by default; operators can
 * supply a CA bundle (`caData`) for self-signed Rancher servers or, as a last
 * resort, disable verification (`skipTLSVerify`).
 *
 * @param {{ rancherUrl: string, clusterId: string, token: string, caData?: string, skipTLSVerify: boolean }} cfg
 * @returns {import('@kubernetes/client-node').CoreV1Api}
 */
function buildRancherApi(cfg) {
  const kc = new KubeConfig()
  const cluster = {
    name: `rancher-${cfg.clusterId}`,
    server: buildProxyUrl(cfg.rancherUrl, cfg.clusterId),
    skipTLSVerify: cfg.skipTLSVerify,
  }
  if (cfg.caData) cluster.caData = cfg.caData
  kc.loadFromClusterAndUser(cluster, {
    name: `rancher-${cfg.clusterId}-user`,
    token: cfg.token,
  })
  return kc.makeApiClient(CoreV1Api)
}

/**
 * Returns true when the supplied options carry a complete Rancher connection
 * config (URL + clusterId + token). EnvironmentManager / config wiring uses
 * this to decide whether to instantiate a RancherBackend at all — when Rancher
 * is not configured, the plain K8sBackend (in-cluster / kubeconfig) path is the
 * default and nothing about Rancher is touched.
 *
 * Does NOT validate shape (that is `validateRancherOptions`'s job at construct
 * time); it only checks presence so the default path stays untouched.
 *
 * @param {Object} [opts]
 * @returns {boolean}
 */
export function isRancherConfigured(opts = {}) {
  return Boolean(opts && opts.rancherUrl && opts.clusterId && opts.token)
}

/**
 * Determine whether an API error means "already exists" (HTTP 409 Conflict).
 * Mirrors `_isNotFound` in k8s.js but for the create-idempotency case.
 */
function isAlreadyExists(err) {
  return err?.code === 409 ||
    err?.statusCode === 409 ||
    err?.response?.statusCode === 409 ||
    err?.body?.code === 409 ||
    err?.body?.reason === 'AlreadyExists'
}

/**
 * RancherBackend — optional adapter that runs the full K8sBackend against a
 * Rancher-managed cluster (#3196).
 *
 * Rancher is an auth/proxy layer in front of the Kubernetes API: it exposes
 * every downstream cluster's kube API under `/k8s/clusters/<clusterId>` and
 * authenticates with a Rancher bearer token. RancherBackend therefore reuses
 * 100% of the K8sBackend pod/secret/exec logic and only changes how the kube
 * client is constructed (Rancher proxy URL + bearer token + optional CA).
 *
 * It additionally layers Rancher's org model on top: `ensureProjectNamespace`
 * creates a namespace bound to a Rancher Project via the
 * `field.cattle.io/projectId` annotation, so quotas / RBAC defined at the
 * project level apply to Chroxy's environments.
 *
 * Opt-in: this class is only instantiated when a Rancher connection is
 * configured (`isRancherConfigured`). The default in-cluster / kubeconfig
 * K8sBackend path is unchanged when Rancher is not configured.
 */
export class RancherBackend extends K8sBackend {
  /**
   * @param {Object} opts - All K8sBackend opts PLUS the Rancher connection block:
   * @param {string}  opts.rancherUrl       - Rancher server base URL
   * @param {string}  opts.clusterId        - Rancher downstream cluster ID (c-...)
   * @param {string}  opts.token            - Rancher bearer token (never logged)
   * @param {string}  [opts.caData]         - base64-encoded PEM CA bundle for the Rancher server
   * @param {boolean} [opts.skipTLSVerify]  - Disable TLS verification (default false; discouraged)
   * @param {string}  [opts.defaultProjectId] - Default Rancher project (p-...) for ensureProjectNamespace
   * @param {object}  [opts._coreV1Api]     - Injected CoreV1Api for testing (bypasses Rancher kube-client build)
   */
  constructor(opts = {}) {
    const {
      rancherUrl, clusterId, token, caData, skipTLSVerify, defaultProjectId,
      _coreV1Api,
      ...k8sOpts
    } = opts

    if (_coreV1Api) {
      // Test / pre-built-client seam: skip Rancher kube-client construction and
      // hand the injected api straight to K8sBackend. We still record the
      // Rancher identity fields (validated leniently) so ensureProjectNamespace
      // can form the projectId annotation, but we tolerate their absence here so
      // unit tests can exercise pod logic without a full Rancher config.
      super({ ...k8sOpts, _coreV1Api })
      this._rancher = {
        rancherUrl,
        clusterId,
        defaultProjectId,
      }
    } else {
      const cfg = validateRancherOptions({ rancherUrl, clusterId, token, caData, skipTLSVerify })
      if (defaultProjectId != null && !RANCHER_PROJECT_ID.test(defaultProjectId)) {
        throw new Error(`RancherBackend: defaultProjectId must match the Rancher project-ID format (p-...), got "${defaultProjectId}"`)
      }
      const api = buildRancherApi(cfg)
      // Hand the Rancher-pointed client to K8sBackend via its injection seam so
      // K8sBackend never constructs its own (in-cluster/kubeconfig) client.
      super({ ...k8sOpts, _coreV1Api: api })
      // Store only non-secret identity fields. The bearer token lives inside
      // the kube client's auth provider and is never copied onto `this`.
      this._rancher = {
        rancherUrl: cfg.rancherUrl,
        clusterId: cfg.clusterId,
        defaultProjectId: defaultProjectId ?? undefined,
      }
      log.info(`RancherBackend connected to cluster ${cfg.clusterId} via ${cfg.rancherUrl} (proxy: /k8s/clusters/${cfg.clusterId})`)
    }
  }

  /**
   * Rancher cluster ID this backend is bound to (for diagnostics / annotation).
   * @returns {string|undefined}
   */
  get clusterId() {
    return this._rancher?.clusterId
  }

  /**
   * Create (idempotently) a Kubernetes namespace bound to a Rancher Project.
   *
   * Rancher's project model is expressed on standard K8s Namespaces via the
   * `field.cattle.io/projectId: <clusterId>:<projectId>` annotation — Rancher's
   * controllers then apply the project's RBAC and resource quotas to the
   * namespace. Creating the namespace through the proxied kube API (the same
   * `_api` client every K8sBackend method uses) is all that is required; there
   * is no separate Rancher REST call.
   *
   * Idempotent: a 409 Conflict (namespace already exists) is treated as success.
   *
   * Fallback: if Rancher is not configured with a usable clusterId (e.g. the
   * test/injected-client path) the annotation is omitted and a plain namespace
   * is created — this is the "falls back to plain K8s" behaviour from the AC.
   *
   * @param {string} namespace - RFC 1123 namespace name to create
   * @param {Object} [opts]
   * @param {string} [opts.projectId] - Rancher project ID (p-...); defaults to defaultProjectId
   * @returns {Promise<{ namespace: string, projectId: string|null, created: boolean }>}
   */
  async ensureProjectNamespace(namespace, opts = {}) {
    const ns = this._validateNamespace(this._resolveNamespace(namespace), 'ensureProjectNamespace')
    const projectId = opts.projectId ?? this._rancher?.defaultProjectId ?? null
    const clusterId = this._rancher?.clusterId

    const metadata = { name: ns }

    if (projectId != null) {
      if (!RANCHER_PROJECT_ID.test(projectId)) {
        throw new Error(`RancherBackend.ensureProjectNamespace: projectId must match the Rancher project-ID format (p-...), got "${projectId}"`)
      }
      if (!clusterId) {
        // Project requested but we have no cluster ID to form the binding.
        // Fall back to a plain namespace rather than creating a malformed
        // annotation, and surface the degradation in the logs.
        log.warn(`ensureProjectNamespace: projectId ${projectId} requested but no clusterId configured — creating plain namespace ${ns} without project binding`)
      } else {
        metadata.annotations = {
          [PROJECT_ID_ANNOTATION]: `${clusterId}:${projectId}`,
        }
      }
    }

    const boundProjectId = metadata.annotations ? projectId : null
    const body = { apiVersion: 'v1', kind: 'Namespace', metadata }

    log.info(`Ensuring namespace ${ns}${boundProjectId ? ` bound to project ${boundProjectId}` : ''}`)
    try {
      await this._api.createNamespace({ body })
      return { namespace: ns, projectId: boundProjectId, created: true }
    } catch (err) {
      if (isAlreadyExists(err)) {
        log.info(`Namespace ${ns} already exists — treating as success`)
        return { namespace: ns, projectId: boundProjectId, created: false }
      }
      // Do not include err details that could echo the request body / token.
      log.warn(`Failed to create namespace ${ns}: ${err.message}`)
      throw err
    }
  }
}

// Internal helpers exported for unit testing only.
export const __test__ = {
  buildProxyUrl,
  validateRancherOptions,
  buildRancherApi,
  isAlreadyExists,
  RANCHER_CLUSTER_ID,
  RANCHER_PROJECT_ID,
  PROJECT_ID_ANNOTATION,
}
