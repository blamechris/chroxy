import { createHash, randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { KubeConfig, CoreV1Api, PortForward } from '@kubernetes/client-node'
import WebSocket from 'ws'
import { createLogger } from '../../logger.js'
import { getChroxyHostEnv } from '../../chroxy-host-metadata.js'

const log = createLogger('k8s-backend')

const POLL_INTERVAL_MS = 1_000
const DESTROY_TIMEOUT_MS = 30_000

// Reconnect parameters for SidecarProcess WS blip recovery (#3321).
// These are the defaults; inject overrides via constructor opts for tests.
const DEFAULT_RECONNECT_DELAYS = [250, 500, 1_000, 2_000, 4_000, 8_000]
const DEFAULT_MAX_RETRIES = 5

/**
 * Cap on bytes held in `_stdinBuffer` before the WS dial resolves (#3401).
 * If the dial hangs (slow cluster, DNS failure) and the caller is piping
 * large stdin payloads, an unbounded buffer would grow until the server
 * OOMs.  Writes that would push the buffer past the cap are dropped with
 * a warning.  1 MiB is generous for a few large prompts but bounds the
 * worst-case memory hold at one process-worth.
 */
const DEFAULT_MAX_STDIN_BUFFER_BYTES = 1 * 1024 * 1024  // 1 MiB

/** Default sidecar image — overridden via constructor option */
const DEFAULT_SIDECAR_IMAGE = 'chroxy-pod-agent:latest'

/** Port the chroxy-pod-agent sidecar listens on inside the Pod */
const AGENT_PORT = 7681

/**
 * Default resource requests/limits applied to the sidecar container when a
 * createEnvironment call does not specify its own (#3195).
 *
 * Requests are what the scheduler reserves (and what the pod is guaranteed);
 * limits are the hard ceiling the kernel/cgroup enforces. The defaults keep a
 * single runaway session from starving the node while leaving generous
 * headroom for a real Claude Code workload:
 *   - request 500m CPU / 512Mi memory — modest reservation so several
 *     environments can be packed onto one node.
 *   - limit   2 CPU  / 4Gi  memory — a session may burst well above its
 *     request but is capped before it can consume the whole node.
 *
 * Operators override any field per-call via `opts.resources` (or the legacy
 * `opts.memoryLimit`/`opts.cpuLimit`); see createEnvironment's JSDoc.
 */
export const DEFAULT_RESOURCES = Object.freeze({
  cpu: '500m',
  memory: '512Mi',
  cpuLimit: '2',
  memoryLimit: '4Gi',
})

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
 * RFC 1123 label regex: lowercase alphanumeric, '-' allowed in the middle,
 * must start and end with an alphanumeric character.
 *   1 char         → [a-z0-9]
 *   ≥2 chars       → [a-z0-9] + 0..n of ([a-z0-9-]) + [a-z0-9]
 * Length is checked separately so the error message can distinguish
 * "too long" from "bad characters".
 */
const RFC_1123_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** RFC 1123 label maximum length (per the spec; K8s namespace == DNS label). */
const RFC_1123_MAX_LENGTH = 63

/**
 * Validates a Kubernetes namespace string against the RFC 1123 DNS label rules
 * the API server enforces.  Layered on top of `_resolveNamespace()` so all five
 * per-call resolution sites gain validation atomically (#3571).
 *
 * Rules enforced:
 *   - Must be a non-empty string
 *   - Length 1..63 characters
 *   - Lowercase alphanumeric and hyphens only
 *   - First and last character must be alphanumeric
 *
 * Throws Error with a `${context}:` prefix so the caller can identify which
 * Backend method observed the invalid namespace (mirrors validateImagePullPolicy).
 *
 * @param {*}      ns       - Resolved namespace value
 * @param {string} context  - Method name / call site label for the error message
 * @returns {string} The validated namespace (returned for convenient one-line use)
 * @throws {Error} If `ns` is not a non-empty RFC 1123 label
 */
function validateNamespace(ns, context) {
  if (typeof ns !== 'string' || ns.length === 0) {
    throw new Error(`${context}: namespace must be a non-empty string`)
  }
  if (ns.length > RFC_1123_MAX_LENGTH) {
    throw new Error(
      `${context}: namespace "${ns}" exceeds ${RFC_1123_MAX_LENGTH}-char RFC 1123 limit`
    )
  }
  if (!RFC_1123_LABEL.test(ns)) {
    throw new Error(
      `${context}: namespace "${ns}" must match RFC 1123 label format ` +
      '(lowercase alphanumeric and hyphens, start/end alphanumeric)'
    )
  }
  return ns
}

/**
 * Static prefix for per-user/per-project namespaces derived by the default
 * mapping function (#3194).  Kept short so the sanitized identity gets the
 * lion's share of the 63-char RFC 1123 budget.
 */
const DEFAULT_NAMESPACE_PREFIX = 'chroxy-user-'

/**
 * Sanitize an arbitrary identity string (userId / projectId) into a fragment
 * safe to splice into an RFC 1123 DNS label (#3194).
 *
 * Multi-tenant safety: the namespace is the tenant-isolation boundary, so the
 * sanitizer must be *deterministic* (the same identity always maps to the same
 * namespace) and *collision-resistant* (distinct identities should not silently
 * collapse onto the same namespace and thereby share another tenant's Pods).
 *
 * Transform:
 *   - Lowercase (RFC 1123 labels are lowercase only).
 *   - Replace every run of disallowed characters with a single '-'.
 *   - Strip leading/trailing '-' so the fragment starts/ends alphanumeric.
 *
 * Collision handling: because the lossy character replacement above can map two
 * different identities onto the same fragment (e.g. `a.b` and `a/b` → `a-b`), a
 * short deterministic hash of the ORIGINAL identity is appended whenever the
 * sanitized fragment differs from the input or has to be truncated.  Two
 * identities that sanitize identically will therefore still produce different
 * namespaces (their hashes differ), preserving tenant isolation.
 *
 * Length: the returned fragment is capped at `maxLength` (default 50) leaving
 * headroom for the caller's prefix; the hash suffix is included within the cap.
 *
 * @param {string} identity  - Raw identity (userId or projectId)
 * @param {Object} [opts]
 * @param {number} [opts.maxLength=50] - Max length of the returned fragment
 * @returns {string} An RFC 1123-label-safe fragment (non-empty)
 * @throws {Error} If `identity` is not a non-empty string
 */
export function sanitizeNamespaceLabel(identity, { maxLength = 50 } = {}) {
  if (typeof identity !== 'string' || identity.length === 0) {
    throw new Error('sanitizeNamespaceLabel: identity must be a non-empty string')
  }

  const lowered = identity.toLowerCase()
  // Collapse every run of non-[a-z0-9] into a single '-', then trim '-' ends.
  let fragment = lowered.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

  // A short deterministic hash of the ORIGINAL identity disambiguates two
  // identities that sanitize to the same fragment (lossy replacement) and two
  // that share a truncated prefix.  8 hex chars (32 bits) is ample for the
  // expected tenant cardinality and keeps the suffix compact.
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 8)

  // Decide whether disambiguation is needed: the sanitize step lost information
  // (the result differs from the ORIGINAL identity — this also catches case
  // folding, so `alice` and `Alice` map to different namespaces), the fragment
  // is empty (all-symbol identity), or the raw fragment exceeds the budget.
  const needsHash = fragment.length === 0 ||
    fragment !== identity ||
    fragment.length > maxLength

  if (!needsHash) {
    return fragment
  }

  // Reserve room for "-<hash>" within maxLength, then re-trim any '-' the
  // truncation may have exposed at the boundary.
  const suffix = `-${hash}`
  // When maxLength is too small to hold even "<1char>-<hash>", drop the fragment
  // entirely and return the hash truncated to maxLength. This keeps the
  // documented length cap a hard guarantee (the `head + suffix` path below would
  // otherwise overshoot for pathologically small maxLength values).  The hash is
  // [a-f0-9], so any prefix of it is still a valid RFC 1123 label.
  if (maxLength <= suffix.length) {
    return hash.slice(0, Math.max(1, maxLength))
  }
  const budget = maxLength - suffix.length
  const head = fragment.slice(0, budget).replace(/-+$/g, '')
  // `head` can be empty when the identity was all symbols; fall back to the
  // hash alone (always [a-f0-9], a valid label).
  return head.length > 0 ? `${head}${suffix}` : hash
}

/**
 * Default namespace mapping function (#3194).
 *
 * Maps a per-call identity to a Kubernetes namespace name:
 *   - `userId`    → `chroxy-user-<sanitized-userId>`
 *   - `projectId` (no userId) → `chroxy-user-<sanitized-projectId>`
 *   - neither     → `null` (caller falls back to the static default namespace)
 *
 * The result is validated by `validateNamespace()` at the call site, so this
 * function only needs to produce a candidate; the sanitizer guarantees a valid
 * RFC 1123 label fragment and the short prefix keeps the total within 63 chars.
 *
 * @param {Object} identity
 * @param {string} [identity.userId]    - User identity
 * @param {string} [identity.projectId] - Project identity (used when no userId)
 * @returns {string|null} Namespace name, or null when no identity was supplied
 */
function defaultNamespaceFor({ userId, projectId } = {}) {
  const id = (typeof userId === 'string' && userId.length > 0)
    ? userId
    : (typeof projectId === 'string' && projectId.length > 0 ? projectId : null)
  if (id == null) return null
  // Reserve the prefix length out of the 63-char budget for the fragment.
  const maxLength = RFC_1123_MAX_LENGTH - DEFAULT_NAMESPACE_PREFIX.length
  return `${DEFAULT_NAMESPACE_PREFIX}${sanitizeNamespaceLabel(id, { maxLength })}`
}

/**
 * Validate `opts.workspacePVC` for createEnvironment (#3385).
 *
 * Accepts:
 *   - `undefined` / `null` — no PVC workspace requested (caller will fall back
 *     to the hostPath strategy via opts.cwd, or no workspace at all).
 *   - `{ claimName: string, mountPath?: string, readOnly?: boolean }` — operator
 *     opts into the PVC strategy.  `claimName` is required and must be a
 *     non-empty string.
 *
 * Also enforces the mutual exclusion with `opts.cwd` (hostPath strategy):
 * passing both is an operator-intent ambiguity, not a fallback chain.
 *
 * @param {*}      workspacePVC - Raw opts.workspacePVC value
 * @param {*}      cwd          - opts.cwd value (for mutual-exclusion check)
 * @throws {Error} If the value is malformed or both strategies are passed.
 */
function validateWorkspacePVC(workspacePVC, cwd) {
  if (workspacePVC == null) return
  if (typeof workspacePVC !== 'object' || Array.isArray(workspacePVC)) {
    throw new Error(
      'createEnvironment: opts.workspacePVC must be an object with a claimName property',
    )
  }
  if (typeof workspacePVC.claimName !== 'string' || workspacePVC.claimName.length === 0) {
    throw new Error(
      'createEnvironment: opts.workspacePVC.claimName must be a non-empty string',
    )
  }
  if (cwd != null && cwd !== '') {
    throw new Error(
      'createEnvironment: opts.cwd and opts.workspacePVC are mutually exclusive — ' +
      'choose either the hostPath strategy (opts.cwd, single-node clusters) ' +
      'or the PVC strategy (opts.workspacePVC, multi-node clusters), not both',
    )
  }
}

/** Default git image used by the clone init container — overridable via opts. */
const DEFAULT_GIT_IMAGE = 'alpine/git:latest'

/** Default mount path the workspace volume is exposed at inside the Pod. */
const DEFAULT_WORKSPACE_MOUNT_PATH = '/workspace'

/**
 * Reject argv values that git would interpret as an option rather than a
 * positional argument (argument-injection hardening, #3193).
 *
 * git-clone argv is NOT passed through a shell — the init container runs
 * `command: ['git']` with an explicit `args` array — so classic shell
 * metacharacter injection (`;`, `|`, `$()`, backticks) is structurally
 * impossible. The residual risk is *argument* injection: a value beginning
 * with `-` (e.g. `--upload-pack=…`, `--config=…`) would be parsed by git as a
 * flag. We reject any value whose first character is `-`; the clone argv also
 * uses `--` to terminate option parsing as belt-and-braces.
 *
 * @param {string} value
 * @param {string} field - Field name for the error message
 * @throws {Error} If the value starts with '-'
 */
function rejectGitOptionLike(value, field) {
  if (typeof value === 'string' && value.startsWith('-')) {
    throw new Error(
      `createEnvironment: opts.gitRepo.${field} must not start with "-" ` +
      '(rejected to prevent git argument injection)',
    )
  }
}

/**
 * Validate + normalise `opts.gitRepo` for createEnvironment (#3193).
 *
 * The git-clone workspace strategy (Phase 1) provisions the Pod's workspace by
 * cloning a repo into an `emptyDir` volume via an init container, instead of
 * mounting a host path (`opts.cwd`) or referencing a pre-provisioned PVC
 * (`opts.workspacePVC`). It is the K8s-native answer to "the pod is on a remote
 * node and can't see the operator's filesystem" without requiring an
 * out-of-band PVC seed step.
 *
 * Accepts:
 *   - `undefined` / `null` — git-clone strategy not requested.
 *   - A non-empty string — shorthand for `{ url: <string> }`.
 *   - `{ url, branch?, commit?, depth?, mountPath? }` — `url` is required and
 *     must be a non-empty string. `branch` / `commit` pin the checkout. `depth`
 *     (positive integer) requests a shallow clone. `mountPath` overrides the
 *     pod-side mount (default `/workspace`).
 *
 * Enforces mutual exclusion with the other two workspace strategies (`opts.cwd`
 * and `opts.workspacePVC`): exactly one strategy may be chosen. The alternative
 * — a silent precedence rule — would hide operator intent.
 *
 * branch + commit may both be supplied: git supports `clone --branch <branch>`
 * followed by a `checkout <commit>`, so the clone fetches the branch tip and a
 * second step pins the exact commit.
 *
 * @param {*} gitRepo - Raw opts.gitRepo value
 * @param {*} cwd     - opts.cwd value (mutual-exclusion check)
 * @param {*} workspacePVC - opts.workspacePVC value (mutual-exclusion check)
 * @returns {{ url: string, branch: string|null, commit: string|null, depth: number|null, mountPath: string }|null}
 *   Normalised descriptor, or null when no git-clone strategy was requested.
 * @throws {Error} If the value is malformed or conflicts with another strategy.
 */
function validateGitRepo(gitRepo, cwd, workspacePVC) {
  if (gitRepo == null) return null

  // Normalise the string shorthand to the object form.
  const spec = typeof gitRepo === 'string' ? { url: gitRepo } : gitRepo

  if (typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(
      'createEnvironment: opts.gitRepo must be a non-empty URL string or ' +
      'an object with a url property',
    )
  }
  if (typeof spec.url !== 'string' || spec.url.length === 0) {
    throw new Error(
      'createEnvironment: opts.gitRepo.url must be a non-empty string',
    )
  }
  rejectGitOptionLike(spec.url, 'url')

  if (spec.branch != null) {
    if (typeof spec.branch !== 'string' || spec.branch.length === 0) {
      throw new Error('createEnvironment: opts.gitRepo.branch must be a non-empty string')
    }
    rejectGitOptionLike(spec.branch, 'branch')
  }

  if (spec.commit != null) {
    if (typeof spec.commit !== 'string' || spec.commit.length === 0) {
      throw new Error('createEnvironment: opts.gitRepo.commit must be a non-empty string')
    }
    rejectGitOptionLike(spec.commit, 'commit')
  }

  let depth = null
  if (spec.depth != null) {
    if (!Number.isInteger(spec.depth) || spec.depth < 1) {
      throw new Error('createEnvironment: opts.gitRepo.depth must be a positive integer')
    }
    depth = spec.depth
  }

  let mountPath = DEFAULT_WORKSPACE_MOUNT_PATH
  if (spec.mountPath != null) {
    if (typeof spec.mountPath !== 'string' || spec.mountPath.length === 0) {
      throw new Error('createEnvironment: opts.gitRepo.mountPath must be a non-empty string')
    }
    // K8s requires volumeMount.mountPath to be absolute; a relative value would
    // be rejected at Pod-create time with an opaque API error. Reject `.`/`..`
    // segments too so the path can't escape the intended workspace root.
    if (!spec.mountPath.startsWith('/')) {
      throw new Error(
        'createEnvironment: opts.gitRepo.mountPath must be an absolute path (start with "/")',
      )
    }
    if (spec.mountPath.split('/').some((seg) => seg === '.' || seg === '..')) {
      throw new Error(
        'createEnvironment: opts.gitRepo.mountPath must not contain "." or ".." segments',
      )
    }
    mountPath = spec.mountPath
  }

  // Mutual exclusion with the other two strategies.
  if (cwd != null && cwd !== '') {
    throw new Error(
      'createEnvironment: opts.cwd and opts.gitRepo are mutually exclusive — ' +
      'choose exactly one workspace strategy (hostPath, PVC, or git-clone)',
    )
  }
  if (workspacePVC != null) {
    throw new Error(
      'createEnvironment: opts.workspacePVC and opts.gitRepo are mutually exclusive — ' +
      'choose exactly one workspace strategy (hostPath, PVC, or git-clone)',
    )
  }

  return { url: spec.url, branch: spec.branch ?? null, commit: spec.commit ?? null, depth, mountPath }
}

/**
 * Build the git-clone init container spec(s) for the git-clone workspace
 * strategy (#3193).
 *
 * Each container runs `git` with an explicit argv array (never a shell string),
 * cloning `descriptor.url` into the shared `emptyDir` workspace volume mounted
 * at `descriptor.mountPath`. Branch / commit pinning and shallow depth are
 * honoured:
 *   - `--branch <branch>` checks out the named branch/tag at clone time.
 *   - `--depth <n>` requests a shallow clone.
 *   - `commit` pins the exact SHA via a SECOND init container running
 *     `git -C <dir> checkout --detach <commit>`. K8s runs init containers
 *     sequentially over the shared emptyDir, so the clone completes before the
 *     checkout starts. Splitting into two containers keeps every value in an
 *     argv slot — no shell is ever invoked, so neither the URL nor the SHA can
 *     be interpreted as a command.
 *
 * @param {{ url: string, branch: string|null, commit: string|null, depth: number|null, mountPath: string }} descriptor
 * @param {string} gitImage - Image providing the `git` binary
 * @returns {Array<object>} One or two init container specs (clone, optional checkout)
 */
function buildGitCloneInitContainers(descriptor, gitImage) {
  const { url, branch, commit, depth, mountPath } = descriptor

  const cloneArgs = ['clone']
  if (depth != null) {
    cloneArgs.push('--depth', String(depth))
  }
  if (branch != null) {
    cloneArgs.push('--branch', branch)
  }
  // `--` terminates option parsing so url/mountPath can never be read as flags.
  cloneArgs.push('--', url, mountPath)

  const volumeMount = { name: 'workspace', mountPath }

  const containers = [{
    name: 'git-clone',
    image: gitImage,
    command: ['git'],
    args: cloneArgs,
    volumeMounts: [volumeMount],
  }]

  if (commit != null) {
    containers.push({
      name: 'git-checkout',
      image: gitImage,
      command: ['git'],
      // `-C <dir>` runs git in the cloned tree; `checkout --detach` pins the
      // exact commit. `--` terminates option parsing before the SHA.
      args: ['-C', mountPath, 'checkout', '--detach', '--', commit],
      volumeMounts: [volumeMount],
    })
  }

  return containers
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
 * Namespace contract (#3571, #3194):
 *   - `_resolveNamespace(callNs, identity)` precedence: explicit `callNs`
 *     (`callNs != null`, so an empty string is preserved verbatim — #3493) >
 *     identity-derived namespace (`namespaceFor({ userId, projectId })`, #3194) >
 *     the static `this._namespace`.
 *   - `_validateNamespace(ns, context)` enforces the RFC 1123 DNS label rules
 *     the K8s API server applies: 1-63 chars, lowercase alphanumeric + hyphens,
 *     start/end alphanumeric.  Throws with a `${context}:` prefix.
 *   - Per-call sites call `_namespaceForCall(opts, '<method>')` which resolves
 *     (explicit > identity > static) and validates in one step, so bad
 *     namespaces (empty, uppercase, too long, bad characters, leading/trailing
 *     dashes) are rejected client-side before any K8s API call is issued.
 *
 * Multi-tenant isolation (#3194):
 *   - The constructor `namespaceFor` mapping turns a per-call `userId`/`projectId`
 *     into a deterministic, sanitized, collision-resistant namespace name
 *     (default `chroxy-user-<sanitized-id>`).
 *   - `createEnvironment` calls `ensureNamespace(ns)` (idempotent read-or-create;
 *     409 AlreadyExists swallowed) so each tenant's namespace exists on demand.
 *   - `listEnvironments` is scoped to exactly one namespace and label-filtered to
 *     `app.kubernetes.io/managed-by=chroxy`, so a tenant never sees another
 *     tenant's Pods.  destroy/status/stream all target the resolved namespace.
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
   * @param {string} [opts.namespace='default']         - Static fallback namespace, used when a
   *   per-call invocation carries no identity (no userId/projectId) and no explicit `opts.namespace`.
   * @param {Function} [opts.namespaceFor]              - Namespace mapping function (#3194):
   *   `({ userId, projectId }) => string|null`. Called per createEnvironment/destroy/etc. to derive
   *   the tenant-isolated namespace from caller identity. Default maps `userId` (or `projectId`) to
   *   `chroxy-user-<sanitized-id>` and returns `null` when neither is present (→ static fallback).
   *   The returned name is validated against RFC 1123 before any K8s API call. Pass a custom function
   *   to project namespaces differently (e.g. `chroxy-proj-<projectId>`).
   * @param {boolean} [opts.inCluster]                  - Force in-cluster auth (default: auto-detect via KUBERNETES_SERVICE_HOST)
   * @param {string}  [opts.kubeconfigPath]             - Path to kubeconfig file (overrides default search)
   * @param {string}  [opts.sidecarImage]               - Sidecar image to use in createEnvironment (default: chroxy-pod-agent:latest)
   * @param {string}  [opts.gitImage]                   - Image providing `git` for the git-clone workspace
   *   init container (default: alpine/git:latest). Used only when a createEnvironment call passes
   *   `opts.gitRepo` (#3193).
   * @param {'Always'|'IfNotPresent'|'Never'} [opts.imagePullPolicy] - imagePullPolicy applied to all
   *   containers in the Pod spec. When unset the field is omitted and Kubernetes applies its own default
   *   ('Always' for :latest tags, 'IfNotPresent' otherwise). Set to 'IfNotPresent' for air-gapped
   *   clusters or local kind-based CI where images are loaded directly into the cluster.
   * @param {Object|null} [opts.defaultResources] - Cluster-wide default resource requests/limits
   *   applied to the sidecar container when a createEnvironment call does not override them (#3195).
   *   Same shape as `createEnvironment`'s `opts.resources` (`{ cpu, memory, cpuLimit, memoryLimit }`).
   *   An object is merged over the built-in {@link DEFAULT_RESOURCES} (so partial overrides are fine)
   *   and validated at construction. Pass `null` to disable defaults entirely — then only explicit
   *   per-call resource values produce a `resources` block. Omit to use the built-in defaults.
   * @param {Object|null} [opts.namespaceQuota] - Per-tenant aggregate ResourceQuota spec (#5142).
   *   When set, a namespace-scoped `ResourceQuota` capping the tenant's TOTAL CPU/memory (and
   *   optionally Pod count) across all their Pods is ensured (idempotent create) whenever a tenant
   *   namespace is ensured. Shape: `{ cpu, memory, cpuLimit, memoryLimit, pods }` — `cpu`/`memory`
   *   map to aggregate `requests.*`, `cpuLimit`/`memoryLimit` to aggregate `limits.*`, `pods` to the
   *   max object count. At least one field is required. Quantities are validated at construction.
   *   Distinct from per-pod `defaultResources` (#3195), which limits each individual Pod. Omit (or
   *   `null`) to skip — the namespace-ensure path is unchanged. Never applied to the static default
   *   namespace.
   * @param {Object|null} [opts.namespaceLimitRange] - Per-tenant LimitRange defaults (#5142).
   *   When set, a namespace-scoped `LimitRange` is ensured so Pods created WITHOUT explicit
   *   requests/limits inherit namespace defaults at the cluster level (defence-in-depth on top of
   *   `defaultResources`). Same flat shape as `defaultResources`: `{ cpu, memory, cpuLimit,
   *   memoryLimit }` — `cpu`/`memory` become `defaultRequest.*`, `cpuLimit`/`memoryLimit` become
   *   `default.*`. At least one field required. Quantities validated at construction. Omit (or
   *   `null`) to skip. Never applied to the static default namespace.
   * @param {'portforward'|'clusterip'} [opts.connectMode='portforward'] - How to reach the sidecar
   * @param {object}  [opts._coreV1Api]                 - Injected CoreV1Api for testing
   * @param {object}  [opts._portForward]               - Injected PortForward for testing
   * @param {Function} [opts._dialWs]                   - Injected WS dial factory for testing: (url, token) => WebSocket
   * @param {number[]} [opts._reconnectDelays]          - Override backoff delays in ms for testing
   * @param {number}   [opts._maxRetries]               - Override max reconnect retries for testing
   * @param {number}   [opts._maxStdinBufferBytes]      - Override SidecarProcess pre-dial stdin buffer cap (#3401)
   * @param {Function} [opts._setTimeout]               - Override setTimeout for deterministic testing
   * @param {Function} [opts._clearTimeout]             - Override clearTimeout for deterministic testing
   */
  constructor({ namespace, namespaceFor, inCluster, kubeconfigPath, sidecarImage, gitImage, imagePullPolicy,
    defaultResources, namespaceQuota, namespaceLimitRange, connectMode, _coreV1Api, _portForward, _dialWs, _net,
    _reconnectDelays, _maxRetries, _maxStdinBufferBytes,
    _setTimeout: setTimeoutImpl, _clearTimeout: clearTimeoutImpl } = {}) {
    validateImagePullPolicy(imagePullPolicy, 'constructor opts')
    this._namespace = namespace ?? 'default'
    // Namespace mapping function (#3194). A non-function override is rejected
    // up-front rather than blowing up later inside _resolveNamespace.
    if (namespaceFor != null && typeof namespaceFor !== 'function') {
      throw new TypeError('K8sBackend: opts.namespaceFor must be a function')
    }
    this._namespaceFor = namespaceFor || defaultNamespaceFor
    // Namespaces we have already ensured exist this process, so repeated
    // createEnvironment calls for the same tenant skip the read/create roundtrip.
    this._ensuredNamespaces = new Set()
    this._sidecarImage = sidecarImage ?? DEFAULT_SIDECAR_IMAGE
    this._gitImage = gitImage ?? DEFAULT_GIT_IMAGE
    this._imagePullPolicy = imagePullPolicy ?? null
    // Default resource requests/limits applied to the sidecar container (#3195).
    //   - undefined → use the module DEFAULT_RESOURCES
    //   - an object → merge over DEFAULT_RESOURCES (operator-set cluster-wide defaults)
    //   - null      → disable defaults entirely (only explicit per-call values apply)
    // Validate any object form up-front so a malformed quantity surfaces at
    // construction rather than at the first createEnvironment call.
    if (defaultResources === null) {
      this._defaultResources = null
    } else if (defaultResources === undefined) {
      this._defaultResources = { ...DEFAULT_RESOURCES }
    } else if (typeof defaultResources === 'object' && !Array.isArray(defaultResources)) {
      const merged = { ...DEFAULT_RESOURCES, ...defaultResources }
      // Reuse the per-call builder purely to validate the merged quantities
      // (defaults disabled so only the merged object is validated). Re-scope
      // any failure to opts.defaultResources — buildResourceBlock blames
      // `resources.*`/`createEnvironment`, which points at the wrong call
      // site for constructor config (#3195 review) — preserving the
      // underlying error as `cause`.
      try {
        buildResourceBlock(merged, undefined, undefined, null)
      } catch (err) {
        throw new Error(`K8sBackend: opts.defaultResources is invalid — ${err.message}`, { cause: err })
      }
      this._defaultResources = merged
    } else {
      throw new TypeError('K8sBackend: opts.defaultResources must be an object or null')
    }

    // Namespace-level (per-tenant) ResourceQuota / LimitRange (#5142). These are
    // OPT-IN: when unset the namespace-ensure path is unchanged. Build the canonical
    // K8s spec up-front so a malformed quantity surfaces at construction rather than
    // at the first createEnvironment call (mirrors defaultResources).
    //   - undefined/null → feature off (no quota / limitrange ensured)
    //   - object         → validated + cached spec, ensured per tenant namespace
    // Re-scope any builder failure to the constructor option (mirrors how
    // defaultResources wraps buildResourceBlock above) — the builders blame
    // `namespaceQuota.*` via _validateResourceQuantity's `createEnvironment:`
    // prefix, which points at the wrong call site for constructor config. The
    // original error is preserved as `cause`.
    if (namespaceQuota == null) {
      this._namespaceQuotaSpec = null
    } else {
      try {
        this._namespaceQuotaSpec = buildResourceQuotaSpec(namespaceQuota)
      } catch (err) {
        throw new Error(`K8sBackend: opts.namespaceQuota is invalid — ${err.message}`, { cause: err })
      }
    }
    if (namespaceLimitRange == null) {
      this._namespaceLimitRangeSpec = null
    } else {
      try {
        this._namespaceLimitRangeSpec = buildLimitRangeSpec(namespaceLimitRange)
      } catch (err) {
        throw new Error(`K8sBackend: opts.namespaceLimitRange is invalid — ${err.message}`, { cause: err })
      }
    }
    // Namespaces whose ResourceQuota / LimitRange we have already ensured this
    // process, so repeated createEnvironment calls for the same tenant skip the
    // read/create roundtrip (mirrors _ensuredNamespaces).
    this._ensuredQuotas = new Set()
    this._ensuredLimitRanges = new Set()

    this._connectMode = connectMode ?? 'portforward'

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

    // In-flight _readAgentToken promises, keyed by pod name. Coalesces
    // concurrent callers so only one K8s API request is made per pod at a time
    // (deduplicates the race where two streamCliInEnvironment calls arrive
    // before either has populated _agentTokens).
    this._pendingAgentTokens = new Map()

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
    // Pre-dial stdin buffer cap (#3401) — injectable for tests.
    this._maxStdinBufferBytes = Number.isFinite(_maxStdinBufferBytes) && _maxStdinBufferBytes > 0
      ? _maxStdinBufferBytes
      : DEFAULT_MAX_STDIN_BUFFER_BYTES
    // Timer seam: allow tests to substitute a fake clock and avoid real-time polling.
    this._setTimeout = setTimeoutImpl || setTimeout
    this._clearTimeout = clearTimeoutImpl || clearTimeout
  }

  /**
   * Resolve the effective namespace for a per-call invocation.
   *
   * Precedence (highest first):
   *   1. Explicit per-call `callNamespace` — including the empty string (#3493).
   *      `??` preserves `''` verbatim so it surfaces to the K8s API (and is
   *      rejected by `_validateNamespace`) rather than being silently rewritten.
   *   2. Identity-derived namespace (#3194) — when `callNamespace` is
   *      null/undefined and `identity` carries a userId/projectId, the
   *      constructor-supplied `namespaceFor` mapping derives a tenant-isolated
   *      namespace. A `null` from the mapping means "no identity" → fall through.
   *   3. The constructor-stored static `namespace` (default 'default').
   *
   * The mapping function runs only on the fall-through path so an explicit
   * namespace always wins and an identity-less call keeps the legacy behaviour.
   *
   * @param {string|undefined|null} callNamespace - Per-call namespace override
   * @param {Object} [identity]            - Per-call tenant identity (#3194)
   * @param {string} [identity.userId]     - User identity for namespace mapping
   * @param {string} [identity.projectId]  - Project identity for namespace mapping
   * @returns {string} Resolved namespace
   */
  _resolveNamespace(callNamespace, identity) {
    if (callNamespace != null) return callNamespace
    if (identity && (identity.userId != null || identity.projectId != null)) {
      const mapped = this._namespaceFor(identity)
      if (mapped != null) return mapped
    }
    return this._namespace
  }

  /**
   * Idempotently ensure a namespace exists (#3194).
   *
   * Multi-tenant isolation requires the per-user/per-project namespace to be
   * present before any Pod/Secret is created in it.  This method is safe to call
   * repeatedly and concurrently:
   *   - The first call reads the namespace; a 404 triggers a create.
   *   - A create that races another creator (409 AlreadyExists) is swallowed —
   *     the namespace exists, which is the post-condition we want.
   *   - Once ensured, the name is cached for the process so subsequent calls are
   *     a no-op (no API roundtrip).
   *
   * The static default namespace ('default', or any operator-supplied static
   * `namespace`) is treated as pre-existing and never created — it is part of the
   * cluster bootstrap, and a chroxy service account is unlikely to hold
   * cluster-scoped namespace-create RBAC for it. Only namespaces *derived* from
   * tenant identity are created on demand.
   *
   * @param {string} ns - A namespace name already validated as an RFC 1123 label
   * @returns {Promise<void>}
   */
  async ensureNamespace(ns) {
    if (this._ensuredNamespaces.has(ns)) return
    // Never attempt to create the static fallback namespace — it is assumed to
    // exist (cluster bootstrap) and chroxy may lack RBAC to create it.
    if (ns === this._namespace) {
      this._ensuredNamespaces.add(ns)
      return
    }

    try {
      await this._api.readNamespace({ name: ns })
      this._ensuredNamespaces.add(ns)
      return
    } catch (err) {
      if (!_isNotFound(err)) throw err
      // 404 → fall through and create it.
    }

    const body = {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: ns,
        labels: { 'app.kubernetes.io/managed-by': 'chroxy' },
      },
    }
    try {
      log.info(`Creating namespace ${ns}`)
      await this._api.createNamespace({ body })
    } catch (err) {
      // Another creator won the race (or it already existed) — AlreadyExists is
      // success for an idempotent ensure, not an error.
      if (!_isAlreadyExists(err)) throw err
      log.info(`Namespace ${ns} already exists (concurrent create)`)
    }
    this._ensuredNamespaces.add(ns)
  }

  /**
   * Idempotently ensure a per-tenant `ResourceQuota` exists in `ns` (#5142).
   *
   * A namespace-scoped ResourceQuota caps the AGGREGATE CPU/memory (and
   * optionally Pod count) a tenant may consume across ALL their Pods — distinct
   * from the per-pod requests/limits #3195 sets on each container. It is the
   * tenant-level guardrail that becomes meaningful now that #3194 gives every
   * tenant their own namespace.
   *
   * Opt-in + safe by construction:
   *   - No-op when the backend was constructed without `namespaceQuota`.
   *   - No-op for the static default namespace (treated as cluster bootstrap,
   *     chroxy is unlikely to hold RBAC there) — mirrors ensureNamespace.
   *   - Read-or-create, idempotent, safe to call repeatedly/concurrently: a 404
   *     read triggers a create; a 409 AlreadyExists on create is swallowed.
   *   - Once ensured, the namespace is cached so subsequent calls are a no-op.
   *
   * @param {string} ns - A namespace name already validated as an RFC 1123 label
   * @returns {Promise<void>}
   */
  async ensureResourceQuota(ns) {
    if (this._namespaceQuotaSpec == null) return
    if (this._ensuredQuotas.has(ns)) return
    // Never touch the static default namespace — assumed pre-existing, and chroxy
    // may lack RBAC to write ResourceQuota objects there.
    if (ns === this._namespace) {
      this._ensuredQuotas.add(ns)
      return
    }

    const name = 'chroxy-quota'
    try {
      await this._api.readNamespacedResourceQuota({ name, namespace: ns })
      this._ensuredQuotas.add(ns)
      return
    } catch (err) {
      if (!_isNotFound(err)) throw err
      // 404 → fall through and create it.
    }

    const body = {
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: {
        name,
        labels: { 'app.kubernetes.io/managed-by': 'chroxy' },
      },
      spec: { hard: this._namespaceQuotaSpec },
    }
    try {
      log.info(`Creating ResourceQuota ${name} in namespace ${ns}`)
      await this._api.createNamespacedResourceQuota({ namespace: ns, body })
    } catch (err) {
      // Another creator won the race (or it already existed) — AlreadyExists is
      // success for an idempotent ensure, not an error.
      if (!_isAlreadyExists(err)) throw err
      log.info(`ResourceQuota ${name} already exists in ${ns} (concurrent create)`)
    }
    this._ensuredQuotas.add(ns)
  }

  /**
   * Idempotently ensure a per-tenant `LimitRange` exists in `ns` (#5142).
   *
   * A namespace-scoped LimitRange supplies cluster-level DEFAULT requests/limits
   * so Pods created WITHOUT explicit resources inherit sane values — a
   * defence-in-depth layer on top of the backend's own DEFAULT_RESOURCES.
   *
   * Same opt-in + idempotency semantics as {@link ensureResourceQuota}:
   *   - No-op when constructed without `namespaceLimitRange`.
   *   - No-op for the static default namespace.
   *   - Read-or-create (404 → create, 409 → swallowed), cached per process.
   *
   * @param {string} ns - A namespace name already validated as an RFC 1123 label
   * @returns {Promise<void>}
   */
  async ensureLimitRange(ns) {
    if (this._namespaceLimitRangeSpec == null) return
    if (this._ensuredLimitRanges.has(ns)) return
    if (ns === this._namespace) {
      this._ensuredLimitRanges.add(ns)
      return
    }

    const name = 'chroxy-limits'
    try {
      await this._api.readNamespacedLimitRange({ name, namespace: ns })
      this._ensuredLimitRanges.add(ns)
      return
    } catch (err) {
      if (!_isNotFound(err)) throw err
      // 404 → fall through and create it.
    }

    const body = {
      apiVersion: 'v1',
      kind: 'LimitRange',
      metadata: {
        name,
        labels: { 'app.kubernetes.io/managed-by': 'chroxy' },
      },
      spec: { limits: [this._namespaceLimitRangeSpec] },
    }
    try {
      log.info(`Creating LimitRange ${name} in namespace ${ns}`)
      await this._api.createNamespacedLimitRange({ namespace: ns, body })
    } catch (err) {
      if (!_isAlreadyExists(err)) throw err
      log.info(`LimitRange ${name} already exists in ${ns} (concurrent create)`)
    }
    this._ensuredLimitRanges.add(ns)
  }

  /**
   * Validates a resolved namespace against RFC 1123 DNS label rules (#3571).
   *
   * Layered on top of `_resolveNamespace` so all five per-call resolution
   * sites gain validation atomically.  Delegates to the module-level
   * `validateNamespace()` helper.
   *
   * @param {*}      ns      - Resolved namespace value (output of _resolveNamespace)
   * @param {string} context - Method name / call site label for the error message
   * @returns {string} The validated namespace
   * @throws {Error} If `ns` is not a valid RFC 1123 DNS label
   */
  _validateNamespace(ns, context) {
    return validateNamespace(ns, context)
  }

  /**
   * Resolve + validate the namespace for a per-call invocation in one step
   * (#3194).  Reads `namespace`, `userId`, and `projectId` from the caller's
   * opts, runs them through `_resolveNamespace` (explicit > identity > static),
   * then validates the result against RFC 1123.  Used by every per-call site so
   * identity-based isolation and validation stay consistent.
   *
   * @param {Object} opts             - The method's opts object
   * @param {string} [opts.namespace] - Explicit namespace override
   * @param {string} [opts.userId]    - Tenant identity
   * @param {string} [opts.projectId] - Project identity
   * @param {string} context          - Call-site label for the error message
   * @returns {string} Validated namespace
   */
  _namespaceForCall(opts, context) {
    const resolved = this._resolveNamespace(opts.namespace, {
      userId: opts.userId,
      projectId: opts.projectId,
    })
    return this._validateNamespace(resolved, context)
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
   * Workspace mount strategies (mutually exclusive — pick exactly one):
   *
   * 1. hostPath (single-node clusters) — pass `opts.cwd`:
   *      `opts.cwd` is mounted into the Pod as a `hostPath` volume at `/workspace`.
   *      This is the simplest strategy for local clusters (kind, minikube, Docker
   *      Desktop) where the Node running the Pod shares the host filesystem.
   *      Cluster-side requirement: the K8s node the Pod schedules onto must be
   *      able to read `opts.cwd` from its local filesystem.
   *
   *      Failure mode on multi-node clusters: the Pod schedules onto a node that
   *      does not have the path, which `hostPath` `DirectoryOrCreate` silently
   *      papers over by creating an empty directory — the workload then sees an
   *      empty workspace with no surface error.
   *
   * 2. PersistentVolumeClaim (multi-node clusters) — pass `opts.workspacePVC`:
   *      `opts.workspacePVC = { claimName, mountPath?, readOnly? }` translates to
   *      a `persistentVolumeClaim` volume + matching `volumeMount`.  This is the
   *      recommended strategy for production / multi-node clusters where the
   *      workspace must follow the Pod across nodes.  Operators are responsible
   *      for provisioning the PVC and seeding its contents out-of-band; the
   *      backend only references the claim by name.  `mountPath` defaults to
   *      `/workspace` to match the hostPath strategy.
   *
   *      Migration from hostPath → PVC:
   *        - Drop `opts.cwd` and pass `opts.workspacePVC.claimName` instead.
   *        - Pre-populate the PVC with the workspace contents (e.g. an initContainer
   *          that clones a repo, a Job that rsyncs from object storage, or a
   *          manual `kubectl cp`) before relying on the workspace inside the Pod.
   *        - `opts.cwd` and `opts.workspacePVC` are mutually exclusive — passing
   *          both throws.  Operators must explicitly choose one strategy.
   *
   * 3. git-clone (Phase 1, #3193) — pass `opts.gitRepo`:
   *      `opts.gitRepo = { url, branch?, commit?, depth?, mountPath? }` (or a bare
   *      URL string) provisions an ephemeral `emptyDir` workspace that a
   *      `git clone` init container populates before the main container starts.
   *      This is the K8s-native answer to "the Pod runs on a remote node that
   *      can't see the operator's filesystem" without requiring an out-of-band
   *      PVC seed step. Branch / commit pinning and shallow `depth` are honoured.
   *      The git binary comes from the constructor `gitImage` (default
   *      `alpine/git:latest`).
   *
   *      Persistence caveat: `emptyDir` is tied to the Pod lifecycle — when the
   *      Pod is deleted the cloned tree is gone. PVC-backed persistence for the
   *      git-clone strategy is the explicit follow-up (#3385); until then a
   *      git-clone workspace is for ephemeral, single-Pod sessions only.
   *
   *      mountPath caveat (#3193 phase 1): the default `mountPath` of
   *      `/workspace` aligns with `streamCliInEnvironment`'s host→Pod cwd
   *      remap, so exec sessions land on the cloned tree automatically. A
   *      NON-default `mountPath` is supported in the Pod manifest, but the cwd
   *      remap still targets `/workspace` — callers that override `mountPath`
   *      must pass the matching `cwd` to `streamCliInEnvironment` themselves.
   *      Per-Pod workspace-root tracking is left as follow-up.
   *
   * **Security warning — hostPath privilege escalation:**
   *   `hostPath` volumes (used for both `opts.cwd` and `opts.mounts`) give the
   *   Pod direct access to the underlying node's filesystem. This is a
   *   privilege-escalation vector on multi-tenant clusters: a malicious or
   *   misconfigured workspace path could mount sensitive node paths such as
   *   `/etc/kubernetes/pki`, `/var/run/docker.sock`, or `/var/lib/kubelet`,
   *   allowing the workload to read cluster credentials or break out of the
   *   container.
   *
   *   Most production clusters block `hostPath` via PodSecurity admission —
   *   PSA `restricted` and `baseline` policies both prohibit it, so Pod
   *   creation will be rejected by the PSA admission controller (the API
   *   server returns a 4xx at create time, before the Pod ever reaches the
   *   scheduler).  The PVC strategy above does NOT have this restriction and
   *   is the safe default for shared / multi-tenant clusters.
   *
   *   **This mode is not safe for shared / multi-tenant clusters.** Operators
   *   running on shared infrastructure should use the PVC-based workspace
   *   strategy (`opts.workspacePVC`) instead of relying on `hostPath`. Use
   *   this backend only on single-tenant clusters where you control every
   *   workload, or on a namespace where Pod Security Admission is enforced
   *   at the `privileged` level (or with an equivalent policy exemption) so
   *   that `hostPath` volumes are explicitly permitted.
   *
   * @param {Object} opts - See Backend interface in types.js
   * @param {string}   opts.envId          - Unique environment ID
   * @param {string}   [opts.cwd]          - Host path to mount as /workspace inside the Pod (hostPath strategy).
   *   Mutually exclusive with `opts.workspacePVC` — passing both throws.
   * @param {Object}   [opts.workspacePVC] - PVC-based workspace strategy for multi-node clusters.
   * @param {string}   opts.workspacePVC.claimName   - Name of a pre-provisioned PVC in the target namespace
   * @param {string}   [opts.workspacePVC.mountPath] - Pod-side mount path (default: `/workspace`)
   * @param {boolean}  [opts.workspacePVC.readOnly]  - Mount the PVC read-only (default: false)
   * @param {string|Object} [opts.gitRepo]  - git-clone workspace strategy (#3193). A bare URL string is
   *   shorthand for `{ url }`. Provisions an `emptyDir` workspace populated by a `git clone` init container.
   *   Mutually exclusive with `opts.cwd` and `opts.workspacePVC` — passing more than one throws.
   * @param {string}   opts.gitRepo.url        - Repo URL to clone (required; must not start with "-")
   * @param {string}   [opts.gitRepo.branch]   - Branch/tag to check out at clone time (`--branch`)
   * @param {string}   [opts.gitRepo.commit]   - Exact commit SHA to pin via a follow-up checkout init container
   * @param {number}   [opts.gitRepo.depth]    - Positive integer for a shallow clone (`--depth`)
   * @param {string}   [opts.gitRepo.mountPath] - Pod-side workspace mount path (default: `/workspace`)
   * @param {string}   [opts.image]        - Overrides the constructor sidecarImage
   * @param {Object}   [opts.resources]    - Structured resource requests/limits (#3195).
   *   All four fields are optional K8s quantity strings, validated before any API call:
   *     - `resources.cpu`         → `resources.requests.cpu`    (e.g. "500m", "1")
   *     - `resources.memory`      → `resources.requests.memory` (e.g. "512Mi", "1Gi")
   *     - `resources.cpuLimit`    → `resources.limits.cpu`      (e.g. "2")
   *     - `resources.memoryLimit` → `resources.limits.memory`   (e.g. "4Gi")
   *   Unset fields fall back to the legacy flat opts (below), then to the
   *   constructor `defaultResources` (default {@link DEFAULT_RESOURCES}). Pass the
   *   constructor `defaultResources: null` to omit defaults entirely.
   * @param {string}   [opts.memoryLimit]  - Legacy flat K8s memory quantity string (e.g. "2Gi").
   *   Applied to BOTH `resources.limits.memory` and `resources.requests.memory` for the
   *   memory dimension (pre-#3195 behaviour). Superseded by `opts.resources.memory` /
   *   `opts.resources.memoryLimit` when those are set.
   *   Accepts Docker-style suffixes ("g"/"m") and standard K8s suffixes ("Gi"/"Mi").
   * @param {string}   [opts.cpuLimit]     - Legacy flat K8s CPU quantity string (e.g. "2" or "500m").
   *   Applied to BOTH `resources.limits.cpu` and `resources.requests.cpu` for the CPU
   *   dimension (pre-#3195 behaviour). Superseded by `opts.resources.cpu` /
   *   `opts.resources.cpuLimit` when those are set.
   *   A plain integer or float (e.g. "2", "0.5") is valid K8s CPU quantity syntax.
   * @param {number[]|string[]} [opts.forwardPorts] - Extra ports to expose from the container
   *   (in addition to the built-in AGENT_PORT).  Each value may be a bare port number
   *   or a "hostPort:containerPort" string; only the containerPort is used in the Pod spec.
   * @param {string[]} [opts.mounts]       - Additional volume mounts in Docker-style
   *   "hostPath:containerPath[:ro]" format.  Each entry is translated into a
   *   `hostPath` volume + corresponding `volumeMount`.  The volume name is derived
   *   from the entry index ("extra-vol-0", "extra-vol-1", …).
   * @param {Object.<string,string>} [opts.containerEnv] - Extra environment variables
   * @param {string}   [opts.namespace]    - Explicit namespace; overrides both the identity mapping
   *   and the constructor default.
   * @param {string}   [opts.userId]       - Tenant identity for namespace isolation (#3194). When set
   *   (and no explicit `opts.namespace`), the Pod/Secret are created in the namespace produced by the
   *   constructor `namespaceFor` mapping (default `chroxy-user-<userId>`). The namespace is created
   *   on demand if it does not yet exist.
   * @param {string}   [opts.projectId]    - Project identity for namespace isolation (#3194), used by
   *   the default mapping only when no `userId` is supplied.
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
      envId, cwd, containerEnv, namespace, userId, projectId,
      memoryLimit, cpuLimit, resources: callResources, forwardPorts, mounts,
      imagePullPolicy: callImagePullPolicy,
      workspacePVC, gitRepo,
    } = opts
    validateImagePullPolicy(callImagePullPolicy, 'createEnvironment opts')
    // Workspace-strategy validation: three mutually-exclusive strategies decide
    // what backs /workspace:
    //   - opts.cwd          → hostPath volume      (single-node clusters, #3316)
    //   - opts.workspacePVC → persistentVolumeClaim (multi-node clusters, #3385)
    //   - opts.gitRepo      → git-clone init container into an emptyDir (#3193)
    // Accept exactly one — passing more than one throws. The alternative would
    // be a silent precedence rule that hides operator intent.
    validateWorkspacePVC(workspacePVC, cwd)
    const gitClone = validateGitRepo(gitRepo, cwd, workspacePVC)
    const ns = this._namespaceForCall({ namespace, userId, projectId }, 'createEnvironment')
    // Ensure the tenant namespace exists before provisioning any resource in it
    // (#3194). Idempotent + cached; a no-op for the static default namespace.
    await this.ensureNamespace(ns)
    // Ensure per-tenant namespace-level guardrails (#5142). Both are opt-in
    // (no-op unless the backend was constructed with namespaceQuota /
    // namespaceLimitRange) and idempotent + cached. Run after ensureNamespace so
    // the namespace is guaranteed to exist before the quota/limitrange is written.
    await this.ensureResourceQuota(ns)
    await this.ensureLimitRange(ns)
    const podName = `chroxy-env-${envId}`
    const secretName = `chroxy-token-${envId}`
    // K8sBackend ALWAYS runs the chroxy-pod-agent sidecar — the sidecar is
    // the env, and the user's workload runs inside it. EnvironmentManager
    // passes a workspace image (e.g. node:22-slim) which we deliberately
    // ignore here; only the constructor-configured sidecarImage is used.
    const sidecarImage = this._sidecarImage

    // 0. Pre-flight: validate every mount string up-front. _parseMountString()
    //    throws for Windows-style drive-letter paths (#3388); doing this BEFORE
    //    the Secret/Pod create avoids leaking a half-provisioned Secret when a
    //    caller passes a bad mount. Parse results are reused below.
    const parsedMounts = []
    if (mounts && mounts.length > 0) {
      for (let i = 0; i < mounts.length; i++) {
        parsedMounts.push(_parseMountString(mounts[i]))
      }
    }

    // Build + validate the resources block up-front too (#3195). A malformed
    // quantity throws here, BEFORE the Secret/Pod create, so a bad value never
    // leaks a half-provisioned Secret. Defaults are applied unless the operator
    // disabled them (constructor `defaultResources: null`).
    const resources = buildResourceBlock(
      callResources, cpuLimit, memoryLimit, this._defaultResources,
    )

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

    // #6633: Chroxy's own (non-sensitive) host identity, so an agent exec'd into
    // the pod can answer "what build am I in?" — pod-spec env is inherited by
    // `kubectl exec` processes. Added after containerEnv so the computed identity
    // is authoritative.
    for (const [name, value] of Object.entries(getChroxyHostEnv())) {
      env.push({ name, value: String(value) })
    }

    // 4. Resolve imagePullPolicy: per-call opt > constructor opt > omit (K8s default)
    const imagePullPolicy = callImagePullPolicy || this._imagePullPolicy

    // 4. Build volumes + volumeMounts
    // 4a. Workspace volume — one of three mutually-exclusive strategies:
    //   - `opts.cwd`          → hostPath volume (single-node clusters, #3316)
    //   - `opts.workspacePVC` → persistentVolumeClaim volume (multi-node clusters, #3385)
    //   - `opts.gitRepo`      → emptyDir populated by a git-clone init container (#3193)
    //   See the createEnvironment JSDoc for the strategy comparison and migration
    //   guidance. The validators above already rejected any both-set combination.
    const volumes = []
    const volumeMounts = []
    // Init containers populate the workspace before the main container starts
    // (git-clone strategy). Empty for the other strategies.
    const initContainers = []

    if (gitClone) {
      // git-clone strategy: an emptyDir is shared between the clone init
      // container(s) and the main container. The init container clones the repo
      // into the emptyDir; the main container then sees the populated tree.
      // emptyDir is ephemeral — PVC-backed persistence is the explicit
      // follow-up (#3385); see the createEnvironment JSDoc.
      volumes.push({ name: 'workspace', emptyDir: {} })
      volumeMounts.push({ name: 'workspace', mountPath: gitClone.mountPath })
      const cloneContainers = buildGitCloneInitContainers(gitClone, this._gitImage)
      if (imagePullPolicy) {
        for (const c of cloneContainers) c.imagePullPolicy = imagePullPolicy
      }
      initContainers.push(...cloneContainers)
    } else if (workspacePVC) {
      const mountPath = workspacePVC.mountPath || '/workspace'
      volumes.push({
        name: 'workspace',
        persistentVolumeClaim: { claimName: workspacePVC.claimName },
      })
      const vm = { name: 'workspace', mountPath }
      if (workspacePVC.readOnly) vm.readOnly = true
      volumeMounts.push(vm)
    } else if (cwd) {
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
    //     Parse results were validated up-front (step 0); a `null` entry means
    //     the input did not match any supported format and is logged + skipped.
    if (parsedMounts.length > 0) {
      for (let i = 0; i < parsedMounts.length; i++) {
        const parsed = parsedMounts[i]
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
        if (containerPort === null) {
          log.warn(`createEnvironment: ignoring invalid forwardPorts entry "${entry}" (must be 1-65535)`)
          continue
        }
        if (containerPort !== AGENT_PORT) {
          ports.push({ containerPort })
        }
      }
    }

    // 6. Resources block (requests/limits) was built + validated up-front in
    //    step 0 (`resources`). See buildResourceBlock for the precedence rules
    //    and DEFAULT_RESOURCES for the defaults (#3195).

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

    if (initContainers.length > 0) {
      podSpec.initContainers = initContainers
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
   * @param {string} [opts.namespace]   - Explicit namespace override
   * @param {string} [opts.userId]      - Tenant identity for namespace isolation (#3194)
   * @param {string} [opts.projectId]   - Project identity for namespace isolation (#3194)
   * @param {string} [opts.secretName]  - Per-Pod Secret to delete (default: derived from podName)
   * @returns {Promise<void>}
   */
  async destroyEnvironment(podName, opts = {}) {
    const ns = this._namespaceForCall(opts, 'destroyEnvironment')
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
   * @param {string} [opts.namespace]  - Explicit namespace override
   * @param {string} [opts.userId]     - Tenant identity for namespace isolation (#3194)
   * @param {string} [opts.projectId]  - Project identity for namespace isolation (#3194)
   * @returns {Promise<boolean>}
   * @throws {Error} If the Pod does not exist
   */
  async getEnvironmentStatus(podName, opts = {}) {
    const ns = this._namespaceForCall(opts, 'getEnvironmentStatus')
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
   * @param {Object.<string,string>} [opts.env] - Extra env vars
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
   * @param {Object.<string,string>} [opts.env] - Extra env vars for the child
   * @param {string}   [opts.cwd]       - Working directory for the child
   * @param {AbortSignal} [opts.signal] - Abort → SIGTERM the child (WS close)
   * @param {string}   [opts.agentToken] - Override the registered bearer token (test seam)
   * @param {string}   [opts.containerCliPath] - Pod-side cli.js path (default fallback)
   * @param {string}   [opts.hostCwd]   - Host CWD mount root for path remapping
   * @param {string}   [opts.namespace] - Explicit namespace override
   * @param {string}   [opts.userId]    - Tenant identity for namespace isolation (#3194)
   * @param {string}   [opts.projectId] - Project identity for namespace isolation (#3194)
   * @returns {SidecarProcess} ChildProcess-shaped handle
   */
  streamCliInEnvironment(podName, opts = {}) {
    const {
      cmd, args = [], env, cwd, signal,
      containerCliPath = DEFAULT_CONTAINER_CLI_PATH,
      hostCwd,
    } = opts
    const ns = this._namespaceForCall(opts, 'streamCliInEnvironment')

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
      _maxStdinBufferBytes: maxStdinBufferBytes,
      _setTimeout: setTimeoutImpl,
      _clearTimeout: clearTimeoutImpl,
    } = this
    const proc = new SidecarProcess({
      reconnectDelays, maxRetries, maxStdinBufferBytes, setTimeoutImpl, clearTimeoutImpl,
    })

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
   * @param {string} [opts.namespace]  - Explicit namespace override
   * @param {string} [opts.userId]     - Tenant identity for namespace isolation (#3194)
   * @param {string} [opts.projectId]  - Project identity for namespace isolation (#3194)
   * @returns {Promise<boolean>}
   */
  async reconnectAgentToken(podName, opts = {}) {
    const ns = this._namespaceForCall(opts, 'reconnectAgentToken')
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

  // ─────────────────────────────────────────────────────────────────────────
  // listEnvironments — list chroxy-managed Pods, scoped to one namespace (#3194)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List the names of chroxy-managed Pods in a single namespace (#3194).
   *
   * Multi-tenant isolation: the list is scoped to exactly one namespace — the
   * one resolved from the caller's identity (or the explicit/static namespace) —
   * and filtered by the `app.kubernetes.io/managed-by=chroxy` label so it never
   * returns Pods belonging to other tenants or unrelated workloads in the same
   * namespace.  There is intentionally no cluster-wide list: a tenant must only
   * ever see its own environments.
   *
   * A brand-new tenant whose namespace has not been created yet has, by
   * definition, no environments.  The K8s API returns 404 ("namespace not
   * found") for `listNamespacedPod` in that case, which we translate to an empty
   * list rather than surfacing as an error.
   *
   * @param {Object} [opts]
   * @param {string} [opts.namespace]  - Explicit namespace to list
   * @param {string} [opts.userId]     - Tenant identity for namespace resolution
   * @param {string} [opts.projectId]  - Project identity for namespace resolution
   * @returns {Promise<string[]>} Pod names (the containerId handles) in the namespace
   */
  async listEnvironments(opts = {}) {
    const ns = this._namespaceForCall(opts, 'listEnvironments')
    let result
    try {
      result = await this._api.listNamespacedPod({
        namespace: ns,
        labelSelector: 'app.kubernetes.io/managed-by=chroxy',
      })
    } catch (err) {
      // The tenant namespace does not exist yet → no environments.
      if (_isNotFound(err)) return []
      throw err
    }
    const items = result?.items || []
    return items
      .map((pod) => pod?.metadata?.name)
      .filter((name) => typeof name === 'string' && name.length > 0)
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
   * Concurrent callers for the same pod are coalesced: only one K8s API
   * request is issued at a time.  The in-flight promise is stored in
   * `_pendingAgentTokens` and cleared once it settles, so a subsequent call
   * after resolution starts a fresh fetch (needed for the reconnect path where
   * the Secret may have been rotated).
   *
   * @param {string} podName
   * @param {string} ns
   * @returns {Promise<string|null>}
   */
  _readAgentToken(podName, ns) {
    // Return the in-flight promise if one already exists for this pod.
    if (this._pendingAgentTokens.has(podName)) {
      return this._pendingAgentTokens.get(podName)
    }

    const secretName = _deriveSecretName(podName)
    const pending = (async () => {
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
      } finally {
        // Always clear the in-flight entry so the next caller starts a fresh
        // fetch (important for the reconnect path where the Secret may rotate).
        this._pendingAgentTokens.delete(podName)
      }
    })()

    this._pendingAgentTokens.set(podName, pending)
    return pending
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
 *
 * The pre-dial buffer is capped at `maxStdinBufferBytes` (default 1 MiB,
 * #3401).  Writes that would push the buffer past the cap are dropped with
 * a `log.warn`; this prevents unbounded memory growth when the WS dial
 * hangs and a fast producer keeps writing.  `kill()` clears the buffer
 * immediately so the bytes are not held until GC.
 *
 * Each over-cap drop also emits a `'stdin_dropped'` event on the proc with
 * `{ bytes, reason: 'pre-dial-cap' }` so consumers (`SdkSession`) get a
 * runtime signal instead of silent loss (#3474).  The event fires once per
 * dropped chunk; the log.warn spam guard only suppresses repeat log lines,
 * not the event itself.
 *
 * ### stdin disabled signal (#3402)
 *
 * On WS reconnect (`resume` frame) stdin forwarding is intentionally NOT
 * re-wired — see resume semantics above. To prevent silent data loss when a
 * consumer keeps writing after reconnect, the proc emits a one-shot
 * `'stdin_disabled'` event the moment forwarding becomes unrecoverable
 * (reconnect dial succeeds, or WS closes mid-write before reconnect).  After
 * that point further writes are dropped and the consumer can use
 * `isStdinForwardingEnabled()` to poll the current state.
 */
class SidecarProcess extends EventEmitter {
  /**
   * @param {Object} [opts]
   * @param {number[]} [opts.reconnectDelays]      - Backoff delay schedule in ms
   * @param {number}   [opts.maxRetries]           - Max reconnect attempts before giving up
   * @param {number}   [opts.maxStdinBufferBytes]  - Pre-dial stdin buffer cap in bytes (#3401)
   * @param {Function} [opts.setTimeoutImpl]       - setTimeout override for deterministic testing
   * @param {Function} [opts.clearTimeoutImpl]     - clearTimeout override for deterministic testing
   */
  constructor({
    reconnectDelays = DEFAULT_RECONNECT_DELAYS,
    maxRetries = DEFAULT_MAX_RETRIES,
    maxStdinBufferBytes = DEFAULT_MAX_STDIN_BUFFER_BYTES,
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
    this._stdinBufferBytes = 0   // running total of bytes held in _stdinBuffer
    this._stdinBufferDropped = false  // true once a write has been dropped due to cap
    this._maxStdinBufferBytes = maxStdinBufferBytes
    this._stdinWired = false     // true once _wireStdin() has been called
    this._stdinEnded = false     // true once stdin 'end' has fired

    // stdin disabled signal (#3402): set true once forwarding is permanently
    // off (reconnect happened, or live WS dropped mid-write).  The first
    // transition emits a one-shot 'stdin_disabled' event so consumers can
    // surface the failure to the user instead of silently losing turns.
    this._stdinForwardingDisabled = false
    this._stdinDisabledSignaled = false

    // Accumulate stdin data until the WS is ready.
    this.stdin.on('data', (chunk) => {
      if (this._stdinWired) {
        // _wireStdin() already flushed and replaced this handler — should not
        // reach here, but guard defensively.
        return
      }
      if (this._stdinForwardingDisabled) {
        // Reconnect happened before _wireStdin ran on this WS — surface the
        // disabled state to the consumer rather than buffering forever.
        this._signalStdinDisabled()
        return
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      // Cap the pre-dial buffer (#3401). Without a cap a slow WS dial plus a
      // fast producer would grow this array without bound and OOM the server.
      // Drop the over-cap chunk entirely (rather than truncating) so we don't
      // split frames mid-line — the consumer's NDJSON stream would become
      // invalid otherwise.
      if (this._stdinBufferBytes + buf.length > this._maxStdinBufferBytes) {
        if (!this._stdinBufferDropped) {
          // Log only the first drop to avoid log spam from a fast producer;
          // smaller writes that still fit may continue to be buffered.
          log.warn(
            `SidecarProcess: pre-dial stdin buffer exceeded cap (` +
            `${this._maxStdinBufferBytes} bytes) — dropping ${buf.length}-byte chunk; ` +
            `further drops will be silent`
          )
          this._stdinBufferDropped = true
        }
        // Emit 'stdin_dropped' for every over-cap chunk (#3474). The log.warn
        // above is one-shot to avoid spam, but the event must fire each time
        // so structured consumers (e.g. SdkSession) can sum lost bytes,
        // surface the failure to the user, or fall back to a different
        // delivery path. Payload mirrors the 'stdin_disabled' shape: a small
        // object with the dropped byte count and a reason tag callers can
        // switch on if more drop reasons are added later.
        this.emit('stdin_dropped', { bytes: buf.length, reason: 'pre-dial-cap' })
        return
      }
      this._stdinBuffer.push(buf)
      this._stdinBufferBytes += buf.length
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

  /**
   * Whether writes to `proc.stdin` are currently being forwarded to the
   * sidecar (#3402).  Returns `false` once a reconnect has occurred or the
   * live WS dropped mid-write — at that point further writes are dropped
   * silently, and the consumer should fall back to a different mechanism
   * (or surface an error to the user).
   *
   * @returns {boolean}
   */
  isStdinForwardingEnabled() {
    return !this._stdinForwardingDisabled
  }

  /**
   * Mark stdin forwarding as disabled and emit `'stdin_disabled'` exactly
   * once (#3402).  Idempotent — repeated calls are no-ops after the first
   * emission.  Called by the reconnect path in `_wireWsToProc` and by the
   * live-forwarding listener in `_wireStdin` when WS closes mid-write.
   *
   * On the first transition we also drop any pre-wire buffered chunks in
   * `_stdinBuffer`: once forwarding is permanently off the buffer can never
   * be flushed (no live WS will ever take it), so retaining it would leak
   * memory.  Anything that was already buffered is unrecoverable from the
   * sidecar's perspective; the consumer was just told via `'stdin_disabled'`
   * and should fall back to a different mechanism.  The number of dropped
   * chunks is logged so operators have a paper trail for lost input.
   *
   * @private
   */
  _signalStdinDisabled() {
    this._stdinForwardingDisabled = true
    if (this._stdinDisabledSignaled) return
    this._stdinDisabledSignaled = true
    if (this._stdinBuffer.length > 0) {
      log.warn(
        `SidecarProcess: dropping ${this._stdinBuffer.length} pre-wire stdin ` +
        `chunk(s) (${this._stdinBufferBytes} bytes) — forwarding disabled ` +
        'before flush could complete',
      )
      this._stdinBuffer = []
      this._stdinBufferBytes = 0
    }
    this.emit('stdin_disabled')
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
    // Release the pre-dial stdin buffer immediately (#3401). If kill() fires
    // before the dial resolves, _wireStdin() will never run and the buffered
    // bytes would otherwise be held until the proc is GC'd.
    this._stdinBuffer = []
    this._stdinBufferBytes = 0
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
    // (see class-level JSDoc on resume semantics).  Surface the disabled
    // state to the consumer so they can stop writing or surface an error
    // (#3402).
    if (!isReconnect) {
      _wireStdin(ws, proc)
    } else {
      proc._signalStdinDisabled()
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
      // WS closed mid-stream. Surface the disabled state via the dedicated
      // #3402 'stdin_disabled' signal first — that event is one-shot and
      // explicit, and unlike 'error' it never throws when no listener is
      // attached.
      proc._signalStdinDisabled()
      // Only emit 'error' if a consumer is actually listening — Node throws
      // an unhandled 'error' otherwise, which would crash the process and
      // defeat the point of the 'stdin_disabled' signal.  Consumers that
      // care about errors should subscribe; consumers that only need the
      // disabled signal listen on 'stdin_disabled' instead.
      if (proc.listenerCount('error') > 0) {
        proc.emit('error', new Error('SidecarProcess: WS closed while writing stdin'))
      } else {
        log.warn('SidecarProcess: WS closed while writing stdin — dropping further writes (no error listener)')
      }
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
  proc._stdinBufferBytes = 0

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

// Detects a Kubernetes 409 Conflict (AlreadyExists) across the client shapes,
// mirroring _isNotFound. Used to make namespace create idempotent: a 409 from
// createNamespace means another creator won the race (#3194).
function _isAlreadyExists(err) {
  return err?.code === 409 ||
    err?.statusCode === 409 ||
    err?.response?.statusCode === 409 ||
    err?.body?.code === 409
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
 * Returns null for unrecognised *formats* (so the caller can log and skip), but
 * throws for inputs that are recognised as invalid — currently Windows-style
 * drive-letter prefixes (see below). Callers must therefore tolerate both a
 * `null` return and a thrown Error.
 *
 * Windows-style paths with a drive letter (e.g. `C:\Users\foo:/workspace` or
 * the relative form `C:foo:/container`) are rejected with an explicit Error:
 * splitting on `:` would silently truncate the host path to the drive letter
 * (`"C"`) and treat the rest of the Windows path as the container path,
 * producing a misconfigured mount that fails later at Pod scheduling. K8s
 * nodes are Linux-only, so Windows host paths are not supportable in any
 * case — fail loudly at parse time. Two guards run: (1) a regex that catches
 * absolute drive-letter prefixes (`C:\…`/`C:/…`), and (2) a post-split check
 * for any 1-char single-letter hostPath that catches relative drive paths.
 *
 * @param {string} mountStr Docker-style mount string in `<host>:<container>[:ro]` form.
 * @returns {{ hostPath: string, containerPath: string, readOnly: boolean } | null}
 * @throws {Error} when `mountStr` is recognised as a Windows drive-letter path.
 */
// Build the Windows-path Error thrown by both _parseMountString guards.
// Centralised so the message can't drift between the absolute-form regex check
// and the relative-form post-split check below.
function _windowsMountPathError(mountStr) {
  return new Error(
    `K8s mount string '${mountStr}' looks like a Windows path; K8s nodes only accept POSIX paths (expected '<host>:<container>[:ro]' with a POSIX host path)`
  )
}

function _parseMountString(mountStr) {
  if (typeof mountStr !== 'string') return null
  // Reject Windows drive-letter paths up-front: `C:\…` or `C:/…` would split on
  // `:` into a 1-char hostPath and a corrupted containerPath. K8s nodes only
  // accept POSIX paths, so this can never produce a valid mount.
  if (/^[A-Za-z]:[\\/]/.test(mountStr)) {
    throw _windowsMountPathError(mountStr)
  }
  const parts = mountStr.split(':')
  if (parts.length < 2) return null
  const hostPath = parts[0]
  const containerPath = parts[1]
  if (!hostPath || !containerPath) return null
  // Defensive second check: a single-character hostPath that is a letter is a
  // Windows *relative* drive path (e.g. `C:foo:/container` → hostPath="C") that
  // the drive-letter prefix regex above can't catch (it requires `\` or `/`
  // after the colon). No legitimate POSIX mount ever produces a 1-char
  // hostPath ('/' alone splits to '' and is already rejected by the !hostPath
  // check), so fail loud with the same Error shape.
  if (hostPath.length === 1 && /^[A-Za-z]$/.test(hostPath)) {
    throw _windowsMountPathError(mountStr)
  }
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
 * Returns null for non-numeric, zero, or out-of-range (> 65535) values.
 *
 * @param {string|number} entry
 * @returns {number | null}
 */
function _parseContainerPort(entry) {
  const str = String(entry)
  const colonIdx = str.indexOf(':')
  const portStr = colonIdx >= 0 ? str.slice(colonIdx + 1) : str
  const port = parseInt(portStr, 10)
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null
  return port
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
 * **SI vs binary-SI approximation:** Docker's single-letter suffixes use SI
 * (decimal) units — "g" = 10^9 bytes, "m" = 10^6 bytes, "k" = 10^3 bytes —
 * while Kubernetes binary suffixes ("Gi", "Mi", "Ki") use powers of two.
 * The mapping is therefore not lossless:
 *
 *   "2g"   → "2Gi"   (~7.4 % over: 2 GiB = 2,147,483,648 B vs 2,000,000,000 B)
 *   "512m" → "512Mi" (~4.9 % over: 512 MiB = 536,870,912 B vs 512,000,000 B)
 *
 * The conversion always **errs generous** — the container receives slightly
 * more memory than the Docker value would imply.  This is intentional and
 * safe for the typical use case.  Operators who need exact semantics should
 * supply a K8s-native quantity string (e.g. "2Gi", "2000000000") which is
 * passed through unchanged.
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

// Valid Kubernetes CPU quantity: a plain decimal number ("2", "0.5", "1.5")
// or a milli-cpu value with the `m` suffix ("500m", "1500m"). Exponent /
// binary-SI suffixes are not meaningful for CPU and are rejected.
const _CPU_QUANTITY_RE = /^(?:\d+(?:\.\d+)?|\.\d+|\d+m)$/

// Valid Kubernetes memory quantity AFTER normalisation: a number with an
// optional binary-SI ("Ki"/"Mi"/"Gi"/"Ti"/"Pi"/"Ei"), decimal-SI
// ("k"/"M"/"G"/"T"/"P"/"E"), or exponent ("e6") suffix, or a bare byte count.
// We normalise Docker-style lone-letter suffixes first, then validate.
const _MEMORY_QUANTITY_RE =
  /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+|Ki|Mi|Gi|Ti|Pi|Ei|[kKMGTPE])?$/

/**
 * Validate + normalise a single resource quantity string (#3195).
 *
 * @param {string} value    - The caller-supplied quantity (e.g. "500m", "2Gi")
 * @param {'cpu'|'memory'} kind - Which quantity grammar to enforce
 * @param {string} field    - Field label for the error message (e.g. "resources.cpu")
 * @returns {string} The validated (and, for memory, normalised) quantity string
 * @throws {Error} If `value` is not a string or is not a valid K8s quantity
 */
function _validateResourceQuantity(value, kind, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `createEnvironment: ${field} must be a non-empty K8s quantity string`,
    )
  }
  const trimmed = value.trim()
  if (kind === 'cpu') {
    if (!_CPU_QUANTITY_RE.test(trimmed)) {
      throw new Error(
        `createEnvironment: ${field} "${value}" is not a valid K8s CPU quantity ` +
        '(expected e.g. "500m", "1", "0.5")',
      )
    }
    return trimmed
  }
  // memory
  const normalised = _normaliseMemoryQuantity(trimmed)
  if (!_MEMORY_QUANTITY_RE.test(normalised)) {
    throw new Error(
      `createEnvironment: ${field} "${value}" is not a valid K8s memory quantity ` +
      '(expected e.g. "512Mi", "2Gi", "1G")',
    )
  }
  return normalised
}

/**
 * Build a Pod container `resources` block from caller opts + defaults (#3195).
 *
 * Resolution precedence per field (highest first):
 *   1. The structured `opts.resources` object: `{ cpu, memory, cpuLimit, memoryLimit }`
 *      where `cpu`/`memory` map to `requests` and `cpuLimit`/`memoryLimit` to `limits`.
 *   2. The legacy flat opts `opts.cpuLimit` / `opts.memoryLimit` (applied to BOTH
 *      the request and the limit for that dimension — the pre-#3195 behaviour).
 *   3. The supplied `defaults` object (constructor `defaultResources`, itself
 *      seeded from the module-level {@link DEFAULT_RESOURCES}). Pass `null` to
 *      disable defaults so only explicit per-call values produce a block.
 *
 * Every resolved quantity is validated against the K8s quantity grammar; an
 * invalid string throws before the Pod/Secret are created — `createEnvironment`
 * awaits `ensureNamespace()` first, so the tenant namespace may already exist,
 * but no workload is provisioned with a bad value.
 *
 * @param {Object} [resources]            - opts.resources (structured form)
 * @param {string} [legacyCpuLimit]       - opts.cpuLimit (flat form)
 * @param {string} [legacyMemoryLimit]    - opts.memoryLimit (flat form)
 * @param {Object|null} [defaults=DEFAULT_RESOURCES] - Per-field defaults, or null to disable
 * @returns {{ requests?: Object, limits?: Object }} A resources block (possibly empty)
 */
function _resolveResourceField(structured, structuredLabel, legacy, legacyLabel, dflt, defaultLabel) {
  if (structured != null) return { value: structured, field: structuredLabel }
  if (legacy != null) return { value: legacy, field: legacyLabel }
  if (dflt != null) return { value: dflt, field: defaultLabel }
  return { value: null, field: null }
}

export function buildResourceBlock(resources, legacyCpuLimit, legacyMemoryLimit, defaults = DEFAULT_RESOURCES) {
  if (resources != null && (typeof resources !== 'object' || Array.isArray(resources))) {
    throw new Error('createEnvironment: opts.resources must be an object')
  }
  const r = resources || {}
  const d = defaults || {}

  // Resolve each of the four dimensions through the precedence chain,
  // tracking which source actually supplied the value so a validation
  // failure names the option the operator set (#3195 review) — the legacy
  // flat opt or a constructor default — instead of always blaming
  // `resources.*`.
  const cpuRequest = _resolveResourceField(r.cpu, 'resources.cpu', legacyCpuLimit, 'cpuLimit', d.cpu, 'defaultResources.cpu')
  const memRequest = _resolveResourceField(r.memory, 'resources.memory', legacyMemoryLimit, 'memoryLimit', d.memory, 'defaultResources.memory')
  const cpuLimit = _resolveResourceField(r.cpuLimit, 'resources.cpuLimit', legacyCpuLimit, 'cpuLimit', d.cpuLimit, 'defaultResources.cpuLimit')
  const memLimit = _resolveResourceField(r.memoryLimit, 'resources.memoryLimit', legacyMemoryLimit, 'memoryLimit', d.memoryLimit, 'defaultResources.memoryLimit')

  const requests = {}
  const limits = {}
  if (cpuRequest.value != null) requests.cpu = _validateResourceQuantity(cpuRequest.value, 'cpu', cpuRequest.field)
  if (memRequest.value != null) requests.memory = _validateResourceQuantity(memRequest.value, 'memory', memRequest.field)
  if (cpuLimit.value != null) limits.cpu = _validateResourceQuantity(cpuLimit.value, 'cpu', cpuLimit.field)
  if (memLimit.value != null) limits.memory = _validateResourceQuantity(memLimit.value, 'memory', memLimit.field)

  const block = {}
  if (Object.keys(requests).length > 0) block.requests = requests
  if (Object.keys(limits).length > 0) block.limits = limits
  return block
}

/**
 * Map a tenant-friendly quota spec to the K8s `ResourceQuota.spec.hard` keys
 * (#5142).
 *
 * The operator supplies a small, intention-revealing object; this builder
 * translates it into the canonical `hard` map the API server understands and
 * validates every quantity through the same grammar the per-pod path uses
 * (`_validateResourceQuantity`). CPU/memory values become the standard
 * `requests.*` / `limits.*` aggregate keys, and the pod count maps to the
 * `pods` object-count quota.
 *
 *   { cpu, memory }             → requests.cpu / requests.memory
 *   { cpuLimit, memoryLimit }   → limits.cpu   / limits.memory
 *   { pods }                    → pods         (max object count, integer)
 *
 * @param {Object} spec
 * @param {string} [spec.cpu]         - Aggregate CPU request cap (e.g. "8")
 * @param {string} [spec.memory]      - Aggregate memory request cap (e.g. "16Gi")
 * @param {string} [spec.cpuLimit]    - Aggregate CPU limit cap (e.g. "16")
 * @param {string} [spec.memoryLimit] - Aggregate memory limit cap (e.g. "32Gi")
 * @param {number} [spec.pods]        - Max number of Pods in the namespace
 * @returns {Object} A `ResourceQuota.spec.hard` map (at least one entry)
 * @throws {Error} If the spec is malformed or yields no caps
 */
export function buildResourceQuotaSpec(spec) {
  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('K8sBackend: namespaceQuota must be an object')
  }
  const hard = {}
  if (spec.cpu != null) {
    hard['requests.cpu'] = _validateResourceQuantity(spec.cpu, 'cpu', 'namespaceQuota.cpu')
  }
  if (spec.memory != null) {
    hard['requests.memory'] = _validateResourceQuantity(spec.memory, 'memory', 'namespaceQuota.memory')
  }
  if (spec.cpuLimit != null) {
    hard['limits.cpu'] = _validateResourceQuantity(spec.cpuLimit, 'cpu', 'namespaceQuota.cpuLimit')
  }
  if (spec.memoryLimit != null) {
    hard['limits.memory'] = _validateResourceQuantity(spec.memoryLimit, 'memory', 'namespaceQuota.memoryLimit')
  }
  if (spec.pods != null) {
    if (!Number.isInteger(spec.pods) || spec.pods < 1) {
      throw new Error('K8sBackend: namespaceQuota.pods must be a positive integer')
    }
    // ResourceQuota `hard` values are all quantity strings, including counts.
    hard.pods = String(spec.pods)
  }
  if (Object.keys(hard).length === 0) {
    throw new Error(
      'K8sBackend: namespaceQuota must set at least one of ' +
      'cpu, memory, cpuLimit, memoryLimit, pods',
    )
  }
  return hard
}

/**
 * Map a tenant-friendly LimitRange spec to a single container-scoped
 * `LimitRange.spec.limits[]` entry (#5142).
 *
 * A LimitRange supplies *namespace-level* defaults so Pods created WITHOUT
 * explicit requests/limits inherit sane values at the cluster level — a
 * defence-in-depth layer on top of the backend's own DEFAULT_RESOURCES. The
 * operator supplies the same flat shape as `defaultResources`; this builder
 * splits it into the `default` (limits) and `defaultRequest` (requests) maps a
 * container-type LimitRange item expects, validating every quantity.
 *
 *   { cpu, memory }           → defaultRequest.cpu / defaultRequest.memory
 *   { cpuLimit, memoryLimit } → default.cpu        / default.memory
 *
 * @param {Object} spec
 * @param {string} [spec.cpu]         - Default CPU request (e.g. "250m")
 * @param {string} [spec.memory]      - Default memory request (e.g. "256Mi")
 * @param {string} [spec.cpuLimit]    - Default CPU limit (e.g. "1")
 * @param {string} [spec.memoryLimit] - Default memory limit (e.g. "1Gi")
 * @returns {{ type: 'Container', default?: Object, defaultRequest?: Object }}
 *   A single LimitRange item (at least one of default/defaultRequest set)
 * @throws {Error} If the spec is malformed or yields no defaults
 */
export function buildLimitRangeSpec(spec) {
  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('K8sBackend: namespaceLimitRange must be an object')
  }
  const defaultRequest = {}
  const defaultLimit = {}
  if (spec.cpu != null) {
    defaultRequest.cpu = _validateResourceQuantity(spec.cpu, 'cpu', 'namespaceLimitRange.cpu')
  }
  if (spec.memory != null) {
    defaultRequest.memory = _validateResourceQuantity(spec.memory, 'memory', 'namespaceLimitRange.memory')
  }
  if (spec.cpuLimit != null) {
    defaultLimit.cpu = _validateResourceQuantity(spec.cpuLimit, 'cpu', 'namespaceLimitRange.cpuLimit')
  }
  if (spec.memoryLimit != null) {
    defaultLimit.memory = _validateResourceQuantity(spec.memoryLimit, 'memory', 'namespaceLimitRange.memoryLimit')
  }
  const item = { type: 'Container' }
  if (Object.keys(defaultLimit).length > 0) item.default = defaultLimit
  if (Object.keys(defaultRequest).length > 0) item.defaultRequest = defaultRequest
  if (item.default == null && item.defaultRequest == null) {
    throw new Error(
      'K8sBackend: namespaceLimitRange must set at least one of ' +
      'cpu, memory, cpuLimit, memoryLimit',
    )
  }
  return item
}
