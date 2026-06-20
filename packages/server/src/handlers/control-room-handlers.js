/**
 * Control Room v2 (#5174) — Host/Repo Status WS handler.
 *
 * Handles: host_status_request, runner_status_request (#5253),
 * integration_status_request (#5499), integration_action (#5500/#5502)
 *
 * Wires the host survey (control-room/repo-set.js + control-room/survey.js) to
 * the WS protocol. On a `host_status_request` the handler:
 *   - resolves the repo set (config.repos ∪ auto-discovered under the root)
 *   - runs the survey, passing the cwds of currently-active chroxy sessions so
 *     the survey can mark session-bound repos `live`
 *   - replies to the requesting client with a single `host_status_snapshot`
 *     (the survey result + the `type` field), echoing the optional `requestId`
 *
 * Bearer-token authority (see docs/security/bearer-token-authority.md):
 *   The survey returns host-wide metadata about EVERY repo the host knows about
 *   — broader than any single session's scope. We therefore serve it only to
 *   clients holding host-level authority (the primary token or an unbound
 *   linking-mode pairing token, both of which have `client.boundSessionId`
 *   unset). A pairing-bound (share-a-session) client is scoped to one session
 *   and must NOT receive a cross-repo host survey, so it gets a permission
 *   error. Authentication itself is already enforced before dispatch in
 *   ws-server._handleMessage, so this handler only adds the
 *   bound-vs-unbound authority check.
 *
 * Concurrency: a host survey shells out to git/gh once per repo. To stop a
 * spamming client from piling up overlapping surveys we keep a single in-flight
 * survey per client (keyed by the client object via a WeakSet) and reject
 * additional requests until the current one settles.
 */
import { realpathSync } from 'fs'
import { resolve } from 'path'
import { createLogger } from '../logger.js'
import { resolveRepoSet, DEFAULT_CONTROL_ROOM_ROOT } from '../control-room/repo-set.js'
import { surveyRepos } from '../control-room/survey.js'
import { surveyRunners, DEFAULT_RUNNER_ROOT } from '../control-room/runners.js'
import { surveyContainers } from '../control-room/containers.js'
import { surveyRepoRuntimeConfig, hostRuntimeDefaults } from '../control-room/repo-runtime-config.js'
import { surveyByokPool } from '../control-room/byok-pool.js'
import { isPoolEnabled, getSharedPool } from '../docker-byok-pool.js'
import { surveyHostPrune, runHostPrune, PRUNE_KINDS } from '../control-room/host-prune.js'
import { surveyIntegrations, runRepoMemoryIndex, runRepoRelayRerun } from '../control-room/integrations.js'
import { surveySkillsInventory } from '../control-room/skills-inventory.js'

const log = createLogger('ws')

// Per-client in-flight guard. A WeakSet keyed by the client object means we
// never leak entries when a client disconnects (the client object is GC'd) and
// we never need an explicit cleanup path.
const inFlight = new WeakSet()
// #5253: a separate in-flight guard for the runner survey, so a runner refresh
// and a host refresh don't block each other (they shell out to different tools).
const runnerInFlight = new WeakSet()
// #5499: same again for the integrations survey — independent of both above.
const integrationInFlight = new WeakSet()
// #5554: same again for the skills inventory survey — independent of all above.
const skillsInventoryInFlight = new WeakSet()
// #6133: same again for the containers & environments survey — independent of all above.
const containersInFlight = new WeakSet()
// #6139: same again for the per-repo runtime config survey — independent of all above.
const repoRuntimeConfigInFlight = new WeakSet()
// #6135: same again for the BYOK pool stats survey — independent of all above.
const byokPoolInFlight = new WeakSet()
// #6140: same again for the host prune guardrails survey — independent of all above.
const hostPruneInFlight = new WeakSet()

/**
 * #5377 — shared builder for the survey error-snapshots. The error reply is a
 * schema-conformant but empty snapshot (empty repos, zeroed summary, the real
 * root + a fresh timestamp) plus an additive `error` (and echoed `requestId`)
 * the dashboard branches on — so the consumer never special-cases a malformed
 * reply. `errorSnapshot` and `runnerErrorSnapshot` are identical apart from
 * their `type` and the keys of the zeroed `summary`; this is the single place
 * the envelope is shaped, so a schema change touches one function and a future
 * survey reuses it.
 *
 * @param {string} type - the snapshot message type.
 * @param {object} emptySummary - the zeroed, type-specific summary object.
 * @param {string} root - effective discovery/install root to report.
 * @param {string|null} requestId - correlation id to echo, or null.
 * @param {{ code: string, message: string }} error
 * @returns {object} a schema-conformant status snapshot carrying the error.
 */
function buildSurveyErrorSnapshot(type, emptySummary, root, requestId, error) {
  return {
    type,
    requestId,
    generatedAt: new Date().toISOString(),
    root,
    summary: emptySummary,
    repos: [],
    error,
  }
}

/** `host_status_snapshot` error reply — see {@link buildSurveyErrorSnapshot}. */
function errorSnapshot(root, requestId, error) {
  return buildSurveyErrorSnapshot(
    'host_status_snapshot',
    { live: 0, onboarded: 0, abandoned: 0, investigate: 0, recent: 0 },
    root, requestId, error,
  )
}

/**
 * Derive the set of cwds for currently-active chroxy sessions, used by the
 * survey to mark session-bound repos as `live`. Reads from the SessionManager's
 * `listSessions()` snapshot (each entry carries `cwd`).
 *
 * @param {object} sessionManager
 * @returns {string[]} de-duped, non-empty cwd strings.
 */
function activeSessionCwds(sessionManager) {
  if (!sessionManager || typeof sessionManager.listSessions !== 'function') return []
  let sessions
  try {
    sessions = sessionManager.listSessions()
  } catch {
    return []
  }
  const out = new Set()
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (s && typeof s.cwd === 'string' && s.cwd.length > 0) out.add(s.cwd)
  }
  return [...out]
}

async function handleHostStatusRequest(ws, client, msg, ctx) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null

  const config = ctx?.services?.config || {}
  // Effective discovery root: the configured root, else resolveRepoSet's own
  // default (~/Projects). Resolve it HERE — not as an undefined passed down —
  // so the snapshot's `root` reports the directory we actually scanned rather
  // than '' when controlRoomRoot is unset.
  const root = typeof config.controlRoomRoot === 'string' && config.controlRoomRoot.length > 0
    ? config.controlRoomRoot
    : DEFAULT_CONTROL_ROOM_ROOT
  const repos = Array.isArray(config.repos) ? config.repos : []

  // Authority gate: host-wide survey is for host-level (unbound) clients only.
  // A pairing-bound (share-a-session) token is scoped to one session.
  if (client?.boundSessionId) {
    ctx.transport.send(ws, errorSnapshot(root, requestId, {
      code: 'FORBIDDEN',
      message: 'host_status_request requires host-level authority (a session-bound token cannot survey the host)',
    }))
    return
  }

  // In-flight guard: one survey per client at a time.
  if (inFlight.has(client)) {
    ctx.transport.send(ws, errorSnapshot(root, requestId, {
      code: 'SURVEY_IN_PROGRESS',
      message: 'A host status survey is already in progress for this client',
    }))
    return
  }

  // Tests can inject `ctx.surveyRepos` / `ctx.resolveRepoSet` to stub the
  // filesystem + git/gh calls without patching modules. Production never sets
  // them and falls through to the real implementations.
  const resolveFn = typeof ctx?.resolveRepoSet === 'function' ? ctx.resolveRepoSet : resolveRepoSet
  const surveyFn = typeof ctx?.surveyRepos === 'function' ? ctx.surveyRepos : surveyRepos

  inFlight.add(client)
  try {
    const repoSet = resolveFn({ repos, root })
    const snapshot = await surveyFn(repoSet, {
      activeSessionCwds: activeSessionCwds(ctx?.sessions?.sessionManager),
      root,
    })

    ctx.transport.send(ws, {
      type: 'host_status_snapshot',
      requestId,
      generatedAt: snapshot.generatedAt,
      root: snapshot.root,
      summary: snapshot.summary,
      repos: snapshot.repos,
    })
  } catch (err) {
    log.warn(`host_status_request failed: ${err && err.message ? err.message : 'unknown error'}`)
    ctx.transport.send(ws, errorSnapshot(root, requestId, {
      code: 'SURVEY_FAILED',
      message: err && err.message ? err.message : 'host status survey failed',
    }))
  } finally {
    inFlight.delete(client)
  }
}

/** #5253 — `runner_status_snapshot` error reply — see {@link buildSurveyErrorSnapshot}. */
function runnerErrorSnapshot(root, requestId, error) {
  return buildSurveyErrorSnapshot(
    'runner_status_snapshot',
    { total: 0, busy: 0, idle: 0, offline: 0, stopped: 0, unregistered: 0 },
    root, requestId, error,
  )
}

/**
 * #5253 — self-hosted runner status survey handler. Same authority +
 * in-flight + degraded-reply contract as `handleHostStatusRequest`: the survey
 * exposes host-wide runner metadata, so it is served only to host-level
 * (unbound) clients, one survey per client at a time.
 */
async function handleRunnerStatusRequest(ws, client, msg, ctx) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null

  const config = ctx?.services?.config || {}
  const root = typeof config.controlRoomRunnerRoot === 'string' && config.controlRoomRunnerRoot.length > 0
    ? config.controlRoomRunnerRoot
    : DEFAULT_RUNNER_ROOT

  // Authority gate: a host-wide runner survey is for host-level clients only.
  if (client?.boundSessionId) {
    ctx.transport.send(ws, runnerErrorSnapshot(root, requestId, {
      code: 'FORBIDDEN',
      message: 'runner_status_request requires host-level authority (a session-bound token cannot survey the host)',
    }))
    return
  }

  if (runnerInFlight.has(client)) {
    ctx.transport.send(ws, runnerErrorSnapshot(root, requestId, {
      code: 'SURVEY_IN_PROGRESS',
      message: 'A runner status survey is already in progress for this client',
    }))
    return
  }

  // Tests inject `ctx.surveyRunners` to stub the fs/exec calls.
  const surveyFn = typeof ctx?.surveyRunners === 'function' ? ctx.surveyRunners : surveyRunners

  // #5260: gh enrichment is on by default; an operator disables it (faster,
  // local-only survey, or no `gh` auth) by setting controlRoomRunnerIncludeGithub
  // false. Only an explicit `false` turns it off — unset/undefined stays true.
  const includeGithub = config.controlRoomRunnerIncludeGithub !== false

  runnerInFlight.add(client)
  try {
    const snapshot = await surveyFn({ root, includeGithub })
    ctx.transport.send(ws, {
      type: 'runner_status_snapshot',
      requestId,
      generatedAt: snapshot.generatedAt,
      root: snapshot.root,
      summary: snapshot.summary,
      repos: snapshot.repos,
    })
  } catch (err) {
    log.warn(`runner_status_request failed: ${err && err.message ? err.message : 'unknown error'}`)
    ctx.transport.send(ws, runnerErrorSnapshot(root, requestId, {
      code: 'SURVEY_FAILED',
      message: err && err.message ? err.message : 'runner status survey failed',
    }))
  } finally {
    runnerInFlight.delete(client)
  }
}

/**
 * #6133 — `containers_status_snapshot` error reply. The containers survey uses a
 * flat `containers` shape (no `root`/`repos`), so it builds its own degraded
 * snapshot rather than the shared `buildSurveyErrorSnapshot` (which sets
 * `repos: []`). Empty containers + zeroed summary + the typed `error`.
 */
function containersErrorSnapshot(requestId, error) {
  return {
    type: 'containers_status_snapshot',
    requestId,
    generatedAt: new Date().toISOString(),
    summary: { total: 0, running: 0, stopped: 0, other: 0 },
    containers: [],
    dockerStatsNote: null,
    error,
  }
}

/**
 * #6133 (epic #5530) — containers & environments survey handler. Same authority
 * + in-flight + degraded-reply contract as the sibling surveys: it exposes
 * host-wide runtime metadata, so it is served only to host-level (unbound)
 * clients, one survey per client at a time. Surveys ONLY chroxy's own
 * EnvironmentManager records (never arbitrary host containers).
 */
async function handleContainersStatusRequest(ws, client, msg, ctx) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null

  // Authority gate: a host-wide container survey is for host-level clients only.
  if (client?.boundSessionId) {
    ctx.transport.send(ws, containersErrorSnapshot(requestId, {
      code: 'FORBIDDEN',
      message: 'containers_status_request requires host-level authority (a session-bound token cannot survey the host)',
    }))
    return
  }

  if (containersInFlight.has(client)) {
    ctx.transport.send(ws, containersErrorSnapshot(requestId, {
      code: 'SURVEY_IN_PROGRESS',
      message: 'A containers status survey is already in progress for this client',
    }))
    return
  }

  // Tests inject `ctx.surveyContainers` to stub the docker/exec calls.
  const surveyFn = typeof ctx?.surveyContainers === 'function' ? ctx.surveyContainers : surveyContainers
  // The EnvironmentManager may be absent (container support disabled) — degrade
  // to an empty inventory rather than erroring.
  const envManager = ctx?.services?.environmentManager || null

  // #6133: `docker stats` enrichment is on by default; an operator on a slow or
  // socketless docker disables it (inventory-only survey) by setting
  // controlRoomContainersIncludeStats false. Only an explicit `false` turns it
  // off — unset/undefined stays true. Mirrors the runner survey's includeGithub.
  const config = ctx?.services?.config || {}
  const includeStats = config.controlRoomContainersIncludeStats !== false

  containersInFlight.add(client)
  try {
    const snapshot = await surveyFn({
      listEnvironments: () => (typeof envManager?.list === 'function' ? envManager.list() : []),
      includeStats,
    })
    ctx.transport.send(ws, {
      type: 'containers_status_snapshot',
      requestId,
      generatedAt: snapshot.generatedAt,
      summary: snapshot.summary,
      containers: snapshot.containers,
      dockerStatsNote: snapshot.dockerStatsNote ?? null,
    })
  } catch (err) {
    log.warn(`containers_status_request failed: ${err && err.message ? err.message : 'unknown error'}`)
    ctx.transport.send(ws, containersErrorSnapshot(requestId, {
      code: 'SURVEY_FAILED',
      message: err && err.message ? err.message : 'containers status survey failed',
    }))
  } finally {
    containersInFlight.delete(client)
  }
}

/**
 * #6139 — `repo_runtime_config_snapshot` error reply. Like the containers
 * survey, this uses a flat shape (no shared `root`/`repos` envelope), so it
 * builds its own degraded snapshot: empty repos + zeroed summary + the typed
 * `error`.
 *
 * `hostDefaults` (optional) carries the real config-derived host-level fields
 * (backend / backendSource / isolation / allowlist) so a degraded reply to an
 * AUTHORIZED host-level client (SURVEY_IN_PROGRESS / SURVEY_FAILED) still
 * reports the effective defaults instead of placeholders. When omitted (the
 * FORBIDDEN path — an unauthorized session-bound client) it falls back to safe
 * placeholders: a session-bound token must NOT learn the host's backend or
 * allowlist patterns (the same leak boundary as effectiveAllowlist's note).
 */
function repoRuntimeConfigErrorSnapshot(requestId, error, hostDefaults = null) {
  const d = hostDefaults || {
    backend: 'docker',
    backendSource: 'default',
    isolation: 'worktree-before-docker',
    allowlist: { source: 'default', patterns: [] },
  }
  return {
    type: 'repo_runtime_config_snapshot',
    requestId,
    generatedAt: new Date().toISOString(),
    backend: d.backend,
    backendSource: d.backendSource,
    isolation: d.isolation,
    allowlist: d.allowlist,
    repos: [],
    summary: { total: 0, withDevcontainer: 0, withCompose: 0, imagesDenied: 0, errored: 0 },
    error,
  }
}

/**
 * #6139 (epic #5530) — per-repo runtime config survey handler. Read-only. Same
 * authority + in-flight + degraded-reply contract as the sibling surveys: it
 * exposes host-wide runtime metadata (the resolved repo set + the host's
 * backend/allowlist defaults), so it's served only to host-level (unbound)
 * clients, one survey per client at a time.
 */
async function handleRepoRuntimeConfigRequest(ws, client, msg, ctx) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null

  // Authority gate: a host-wide runtime-config survey is for host-level clients.
  // FORBIDDEN replies use safe placeholders (no hostDefaults) — a session-bound
  // token must not learn the host's backend/allowlist.
  if (client?.boundSessionId) {
    ctx.transport.send(ws, repoRuntimeConfigErrorSnapshot(requestId, {
      code: 'FORBIDDEN',
      message: 'repo_runtime_config_request requires host-level authority (a session-bound token cannot survey the host)',
    }))
    return
  }

  // Past the authority gate: this client is host-level, so degraded snapshots
  // may carry the real config-derived host defaults (computed without touching
  // the filesystem) rather than placeholders.
  const config = ctx?.services?.config || {}
  const hostDefaults = hostRuntimeDefaults(config)

  if (repoRuntimeConfigInFlight.has(client)) {
    ctx.transport.send(ws, repoRuntimeConfigErrorSnapshot(requestId, {
      code: 'SURVEY_IN_PROGRESS',
      message: 'A repo runtime config survey is already in progress for this client',
    }, hostDefaults))
    return
  }

  // Same repo-set resolution as host_status_request: configured root else the
  // default, config.repos plus auto-discovered git repos.
  const root = typeof config.controlRoomRoot === 'string' && config.controlRoomRoot.length > 0
    ? config.controlRoomRoot
    : DEFAULT_CONTROL_ROOM_ROOT
  const repos = Array.isArray(config.repos) ? config.repos : []

  // Tests inject `ctx.resolveRepoSet` / `ctx.surveyRepoRuntimeConfig` to stub
  // the filesystem + devcontainer-parse touches.
  const resolveFn = typeof ctx?.resolveRepoSet === 'function' ? ctx.resolveRepoSet : resolveRepoSet
  const surveyFn = typeof ctx?.surveyRepoRuntimeConfig === 'function' ? ctx.surveyRepoRuntimeConfig : surveyRepoRuntimeConfig

  repoRuntimeConfigInFlight.add(client)
  try {
    const repoSet = resolveFn({ repos, root })
    const snapshot = await surveyFn({ repoSet, config })
    ctx.transport.send(ws, {
      type: 'repo_runtime_config_snapshot',
      requestId,
      generatedAt: snapshot.generatedAt,
      backend: snapshot.backend,
      backendSource: snapshot.backendSource,
      isolation: snapshot.isolation,
      allowlist: snapshot.allowlist,
      repos: snapshot.repos,
      summary: snapshot.summary,
    })
  } catch (err) {
    log.warn(`repo_runtime_config_request failed: ${err && err.message ? err.message : 'unknown error'}`)
    ctx.transport.send(ws, repoRuntimeConfigErrorSnapshot(requestId, {
      code: 'SURVEY_FAILED',
      message: err && err.message ? err.message : 'repo runtime config survey failed',
    }, hostDefaults))
  } finally {
    repoRuntimeConfigInFlight.delete(client)
  }
}

/**
 * #6135 — `byok_pool_status_snapshot` error reply. Flat shape (no `root`/`repos`
 * envelope), so it builds its own degraded snapshot: a disabled pool + null
 * limits/stats + the typed `error`.
 */
function byokPoolErrorSnapshot(requestId, error) {
  return {
    type: 'byok_pool_status_snapshot',
    requestId,
    generatedAt: new Date().toISOString(),
    enabled: false,
    note: null,
    limits: null,
    stats: null,
    error,
  }
}

/**
 * #6135 (epic #5530) — BYOK container-pool stats survey handler. Read-only. Same
 * authority + in-flight + degraded-reply contract as the sibling surveys: it
 * exposes host-wide pool metadata, so it is served only to host-level (unbound)
 * clients, one survey per client at a time. The pool being OFF is a first-class
 * `enabled: false` snapshot, not an error.
 */
async function handleByokPoolStatusRequest(ws, client, msg, ctx) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null

  if (client?.boundSessionId) {
    ctx.transport.send(ws, byokPoolErrorSnapshot(requestId, {
      code: 'FORBIDDEN',
      message: 'byok_pool_status_request requires host-level authority (a session-bound token cannot survey the host)',
    }))
    return
  }

  if (byokPoolInFlight.has(client)) {
    ctx.transport.send(ws, byokPoolErrorSnapshot(requestId, {
      code: 'SURVEY_IN_PROGRESS',
      message: 'A BYOK pool status survey is already in progress for this client',
    }))
    return
  }

  // Tests inject `ctx.surveyByokPool` to stub the pool/stats singletons.
  const surveyFn = typeof ctx?.surveyByokPool === 'function' ? ctx.surveyByokPool : surveyByokPool

  byokPoolInFlight.add(client)
  try {
    const snapshot = await surveyFn()
    ctx.transport.send(ws, {
      type: 'byok_pool_status_snapshot',
      requestId,
      generatedAt: snapshot.generatedAt,
      enabled: snapshot.enabled,
      note: snapshot.note ?? null,
      limits: snapshot.limits ?? null,
      stats: snapshot.stats ?? null,
    })
  } catch (err) {
    log.warn(`byok_pool_status_request failed: ${err && err.message ? err.message : 'unknown error'}`)
    ctx.transport.send(ws, byokPoolErrorSnapshot(requestId, {
      code: 'SURVEY_FAILED',
      message: err && err.message ? err.message : 'BYOK pool status survey failed',
    }))
  } finally {
    byokPoolInFlight.delete(client)
  }
}

/** #5499 — `integration_status_snapshot` error reply — see {@link buildSurveyErrorSnapshot}. */
function integrationErrorSnapshot(root, requestId, error) {
  return buildSurveyErrorSnapshot(
    'integration_status_snapshot',
    { total: 0, configured: 0, notConfigured: 0, degraded: 0 },
    root, requestId, error,
  )
}

/**
 * #5499/#5501 (epic #5498) — Integrations survey handler (repo-memory and
 * repo-relay observability). Same authority + in-flight + degraded-reply contract as
 * `handleHostStatusRequest`: the survey exposes host-wide per-repo metadata,
 * so it is served only to host-level (unbound) clients, one survey per client
 * at a time. The repo set is the same one the host survey resolves
 * (config.repos ∪ auto-discovered under controlRoomRoot).
 */
async function handleIntegrationStatusRequest(ws, client, msg, ctx) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null

  const config = ctx?.services?.config || {}
  const root = typeof config.controlRoomRoot === 'string' && config.controlRoomRoot.length > 0
    ? config.controlRoomRoot
    : DEFAULT_CONTROL_ROOM_ROOT
  const repos = Array.isArray(config.repos) ? config.repos : []

  // Authority gate: a host-wide integrations survey is for host-level clients only.
  if (client?.boundSessionId) {
    ctx.transport.send(ws, integrationErrorSnapshot(root, requestId, {
      code: 'FORBIDDEN',
      message: 'integration_status_request requires host-level authority (a session-bound token cannot survey the host)',
    }))
    return
  }

  if (integrationInFlight.has(client)) {
    ctx.transport.send(ws, integrationErrorSnapshot(root, requestId, {
      code: 'SURVEY_IN_PROGRESS',
      message: 'An integration status survey is already in progress for this client',
    }))
    return
  }

  // Tests inject `ctx.resolveRepoSet` / `ctx.surveyIntegrations` to stub the
  // fs/exec calls without patching modules.
  const resolveFn = typeof ctx?.resolveRepoSet === 'function' ? ctx.resolveRepoSet : resolveRepoSet
  const surveyFn = typeof ctx?.surveyIntegrations === 'function' ? ctx.surveyIntegrations : surveyIntegrations

  // Optional explicit repo-memory binary path — skips the PATH probe (useful
  // when the daemon runs with a GUI/launchd PATH that misses npm globals).
  const bin = typeof config.controlRoomRepoMemoryBin === 'string' && config.controlRoomRepoMemoryBin.length > 0
    ? config.controlRoomRepoMemoryBin
    : undefined

  integrationInFlight.add(client)
  try {
    const repoSet = resolveFn({ repos, root })
    const snapshot = await surveyFn(repoSet, { root, bin })
    ctx.transport.send(ws, {
      type: 'integration_status_snapshot',
      requestId,
      generatedAt: snapshot.generatedAt,
      root: snapshot.root,
      summary: snapshot.summary,
      repos: snapshot.repos,
      repoMemoryCli: snapshot.repoMemoryCli,
      // #5501: snapshot-level gh CLI note for the repo-relay columns.
      ghCli: snapshot.ghCli,
    })
  } catch (err) {
    log.warn(`integration_status_request failed: ${err && err.message ? err.message : 'unknown error'}`)
    ctx.transport.send(ws, integrationErrorSnapshot(root, requestId, {
      code: 'SURVEY_FAILED',
      message: err && err.message ? err.message : 'integration status survey failed',
    }))
  } finally {
    integrationInFlight.delete(client)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// #5554 (epic #5159) — Skills inventory survey handler.
// ───────────────────────────────────────────────────────────────────────────

/**
 * #5554 — `skills_inventory_snapshot` error reply. The skills snapshot has a
 * different shape from the host/runner/integration trio (global/repos tiers,
 * no `summary`), so it gets its own degraded-snapshot builder rather than
 * reusing `buildSurveyErrorSnapshot`. Same posture though: a schema-valid empty
 * snapshot (empty global + repos, the real root, a fresh timestamp) plus an
 * additive `error` the dashboard branches on, with the request's `requestId`
 * echoed.
 */
function skillsInventoryErrorSnapshot(root, requestId, error) {
  return {
    type: 'skills_inventory_snapshot',
    requestId,
    generatedAt: new Date().toISOString(),
    root,
    global: [],
    globalError: null,
    repos: [],
    error,
  }
}

/**
 * #5554 — Skills inventory survey handler. Same authority + in-flight +
 * degraded-reply contract as the sibling surveys: the inventory exposes
 * host-wide skill metadata (the global tier + every surveyed repo's overlay),
 * so it is served only to host-level (unbound) clients, one survey per client
 * at a time. The repo set is the same one the host survey resolves
 * (config.repos ∪ auto-discovered under controlRoomRoot).
 *
 * Scan-on-request only — the global + per-repo overlay scans are NOT part of
 * the periodic survey. SECURITY: skill BODIES never leave the server; the
 * survey carries names / descriptions / metadata only (see
 * control-room/skills-inventory.js).
 */
async function handleSkillsInventoryRequest(ws, client, msg, ctx) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null

  const config = ctx?.services?.config || {}
  const root = typeof config.controlRoomRoot === 'string' && config.controlRoomRoot.length > 0
    ? config.controlRoomRoot
    : DEFAULT_CONTROL_ROOM_ROOT
  const repos = Array.isArray(config.repos) ? config.repos : []

  // Authority gate: a host-wide skills inventory is for host-level clients only.
  if (client?.boundSessionId) {
    ctx.transport.send(ws, skillsInventoryErrorSnapshot(root, requestId, {
      code: 'FORBIDDEN',
      message: 'skills_inventory_request requires host-level authority (a session-bound token cannot survey the host)',
    }))
    return
  }

  if (skillsInventoryInFlight.has(client)) {
    ctx.transport.send(ws, skillsInventoryErrorSnapshot(root, requestId, {
      code: 'SURVEY_IN_PROGRESS',
      message: 'A skills inventory survey is already in progress for this client',
    }))
    return
  }

  // Tests inject `ctx.resolveRepoSet` / `ctx.surveySkillsInventory` to stub the
  // fs scans without patching modules.
  const resolveFn = typeof ctx?.resolveRepoSet === 'function' ? ctx.resolveRepoSet : resolveRepoSet
  const surveyFn = typeof ctx?.surveySkillsInventory === 'function' ? ctx.surveySkillsInventory : surveySkillsInventory

  // Per-skill usage aggregates from the recorder (when the daemon wired one).
  // Absent → the inventory simply reports zeroed usage.
  const recorder = ctx?.services?.skillsUsageRecorder
  const usage = recorder && typeof recorder.aggregatesByName === 'function'
    ? recorder.aggregatesByName()
    : null

  skillsInventoryInFlight.add(client)
  try {
    const repoSet = resolveFn({ repos, root })
    const snapshot = await surveyFn(repoSet, { root, usage })
    ctx.transport.send(ws, {
      type: 'skills_inventory_snapshot',
      requestId,
      generatedAt: snapshot.generatedAt,
      root: snapshot.root,
      global: snapshot.global,
      globalError: snapshot.globalError ?? null,
      repos: snapshot.repos,
    })
  } catch (err) {
    log.warn(`skills_inventory_request failed: ${err && err.message ? err.message : 'unknown error'}`)
    ctx.transport.send(ws, skillsInventoryErrorSnapshot(root, requestId, {
      code: 'SURVEY_FAILED',
      message: err && err.message ? err.message : 'skills inventory survey failed',
    }))
  } finally {
    skillsInventoryInFlight.delete(client)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// #5500/#5502 (epic #5498) — integration_action: repo-memory Reindex and
// repo-relay Re-run
// ───────────────────────────────────────────────────────────────────────────

/**
 * #5500: per-repo in-flight guard for ALL integration actions, keyed by the
 * repo's CANONICAL realpath (so a symlinked alias can't sidestep the overlap
 * check). A plain Map (not a WeakSet like the survey guards) because the key
 * is a string and entries are explicitly deleted in the handler's `finally`
 * — nothing leaks across client disconnects since completion always settles
 * the promise. Map.size doubles as the global concurrency gauge.
 *
 * #5502: deliberately ONE bucket across action kinds (reindex + relay
 * re-run share it): a repo gets at most one mutating integration action at a
 * time, and the global cap bounds total subprocess fan-out regardless of
 * which buttons the operator mashes. Actions are rare operator clicks — a
 * shared bucket is the simplest cap that still can't be sidestepped by
 * mixing action kinds.
 */
const actionInFlight = new Map()
/**
 * #5500: global concurrency cap — the action buttons must not be able to
 * fork-bomb the host. No queue by design: a request above the cap is
 * rejected with a legible "busy" error and the operator retries.
 */
export const MAX_CONCURRENT_INTEGRATION_ACTIONS = 2

/**
 * #5500: shared INTEGRATION_ACTION_FAILED reply. Mirrors how the
 * CANCEL_ACTIVITY_FAILED session_error is built in input-handlers.js: the
 * `session_error` envelope with a stable `code`, a `reason` discriminator,
 * and the request's correlation fields (`requestId` / `action` / `repoPath`,
 * plus `runId` for #5502 re-runs) echoed so the dashboard can clear the
 * exact row's pending state.
 */
function integrationActionError(ws, ctx, msg, reason, message) {
  ctx.transport.send(ws, {
    type: 'session_error',
    code: 'INTEGRATION_ACTION_FAILED',
    message,
    reason,
    action: typeof msg?.action === 'string' ? msg.action : null,
    repoPath: typeof msg?.repoPath === 'string' ? msg.repoPath : null,
    runId: Number.isInteger(msg?.runId) ? msg.runId : null,
    requestId: typeof msg?.requestId === 'string' ? msg.requestId : null,
  })
}

/**
 * #5500/#5502 — integration action registry. The shared handler below runs
 * the authority / repoPath / repo-set-membership / in-flight gates ONCE for
 * every action; each entry only contributes:
 *   - `validate(msg)` — action-specific request-shape checks, run before any
 *     path resolution. Returns `[reason, message]` to reject, or null.
 *   - `run({ msg, ctx, config, targetKey })` — the exec, against the
 *     CANONICAL realpath. Resolves the action-specific ack fields (spread
 *     into the `integration_action_ack`); throws (optionally with a machine
 *     `.reason`) to fail.
 *   - `failureReason` — the fallback `reason` when a thrown error has none.
 *
 * The schema's closed enum already rejects unknown actions at the wire; the
 * registry lookup is defence in depth for in-process callers/future drift.
 */
const integrationActions = {
  /**
   * #5500: `repo-memory index <repoRoot>` — prewarm/refresh the summary
   * cache (there is no watcher — the cache only refreshes on agent reads or
   * an explicit index run). Acks with the parsed scanned/summarized/fresh/
   * skipped counts (or `counts: null` when the CLI output is unparseable).
   * Safe alongside live sessions: repo-memory's cache is SQLite in WAL mode,
   * so a concurrent index is safe next to an agent session reading summaries.
   */
  repo_memory_reindex: {
    failureReason: 'index-failed',
    validate: () => null,
    async run({ ctx, config, targetKey }) {
      const runFn = typeof ctx?.runRepoMemoryIndex === 'function' ? ctx.runRepoMemoryIndex : runRepoMemoryIndex
      const bin = typeof config.controlRoomRepoMemoryBin === 'string' && config.controlRoomRepoMemoryBin.length > 0
        ? config.controlRoomRepoMemoryBin
        : undefined
      const result = await runFn(targetKey, { bin })
      return { counts: result && result.counts ? result.counts : null }
    },
  },
  /**
   * #5502: `gh run rerun <databaseId> -R <owner>/<repo>` for a FAILED
   * repo-relay run. The client's `runId` is only a lookup key —
   * runRepoRelayRerun re-fetches the run list server-side and requires the
   * id to name a surfaced run with conclusion 'failure' before any exec.
   * The rerun ack echoes the runId and carries `counts: null` (nothing to
   * count — the new attempt shows as in_progress on the next refresh).
   */
  repo_relay_rerun: {
    failureReason: 'rerun-failed',
    validate(msg) {
      if (!Number.isInteger(msg?.runId) || msg.runId < 0) {
        return ['invalid-run-id',
          'repo_relay_rerun requires an integer runId (the databaseId of a surveyed failed run)']
      }
      return null
    },
    async run({ msg, ctx, targetKey }) {
      const runFn = typeof ctx?.runRepoRelayRerun === 'function' ? ctx.runRepoRelayRerun : runRepoRelayRerun
      const result = await runFn(targetKey, msg.runId)
      return { runId: result && Number.isInteger(result.runId) ? result.runId : msg.runId, counts: null }
    },
  },
  // #5502 Part 2 (BLOCKED upstream) — `repo_relay_dispatch` ("Sync now")
  // slots in HERE once blamechris/repo-relay#168 ships a workflow_dispatch
  // trigger: same shared gates, `gh workflow run repo-relay.yml -R
  // <owner>/<repo> -f ...`, additionally gated on the repo's pinned
  // repo-relay version supporting dispatch (the #5501 drift data already
  // carries the pin). Lands as its own PR when upstream releases.
}

/**
 * #5500/#5502 (epic #5498) — `integration_action` handler. Dispatches to the
 * `integrationActions` registry above; success replies with an
 * `integration_action_ack` (the registry entry's fields + the correlation
 * echo), every failure replies with exactly one INTEGRATION_ACTION_FAILED
 * session_error.
 *
 * SECURITY (docs/security/bearer-token-authority.md checklist): every action
 * execs a binary against a host filesystem path, so two gates run BEFORE any
 * exec — shared here, never per-action:
 *   1. Host-level authority — same bound-vs-unbound check as the surveys: a
 *      pairing-bound (share-a-session) client is scoped to one session and
 *      must not run host-wide actions.
 *   2. Repo-set membership — the client-supplied `repoPath` is resolved to
 *      its realpath and MUST match the realpath of a repo in the surveyed
 *      set (config.repos ∪ auto-discovered under controlRoomRoot, the same
 *      set `integration_status_request` reports on). A path the survey never
 *      showed the operator is rejected; the exec then targets the CANONICAL
 *      realpath, never the raw client string — so traversal tricks
 *      (`repo/../../etc`) and symlink aliases collapse before comparison.
 *
 * Concurrency: one in-flight action per repo (overlapping requests on the
 * same repo are rejected with a clear error) plus a global cap of
 * MAX_CONCURRENT_INTEGRATION_ACTIONS across all repos and action kinds —
 * rejected, not queued (see the `actionInFlight` note on the shared bucket).
 */
async function handleIntegrationAction(ws, client, msg, ctx) {
  const config = ctx?.services?.config || {}

  // Authority gate (#1 above): host-level (unbound) clients only.
  if (client?.boundSessionId) {
    integrationActionError(ws, ctx, msg, 'forbidden',
      'integration_action requires host-level authority (a session-bound token cannot run host actions)')
    return
  }

  // Registry lookup (Object.hasOwn so '__proto__'/'constructor' can't match
  // inherited keys). The schema's closed enum already rejects unknown
  // actions at the wire; this is defence in depth.
  const action = typeof msg?.action === 'string' ? msg.action : ''
  const actionEntry = Object.hasOwn(integrationActions, action) ? integrationActions[action] : null
  if (!actionEntry) {
    integrationActionError(ws, ctx, msg, 'unsupported-action',
      `Unsupported integration action: ${action.length > 0 ? action : '(none)'}`)
    return
  }

  // Defence in depth behind the schema's `min(1)` bound: an absent/empty
  // repoPath must hard-fail HERE, before `resolve()` — `resolve('')` is the
  // daemon's cwd, so falling through would let a malformed in-process message
  // target whatever directory the daemon happened to be launched from.
  const repoPath = typeof msg?.repoPath === 'string' ? msg.repoPath : ''
  if (repoPath.length === 0) {
    integrationActionError(ws, ctx, msg, 'invalid-repo-path',
      'integration_action requires a non-empty repoPath')
    return
  }

  // Action-specific request-shape validation (e.g. #5502's required runId),
  // still before any path resolution or exec.
  const invalid = actionEntry.validate(msg)
  if (invalid) {
    integrationActionError(ws, ctx, msg, invalid[0], invalid[1])
    return
  }

  const root = typeof config.controlRoomRoot === 'string' && config.controlRoomRoot.length > 0
    ? config.controlRoomRoot
    : DEFAULT_CONTROL_ROOM_ROOT
  const repos = Array.isArray(config.repos) ? config.repos : []

  // Tests inject ctx.resolveRepoSet / ctx.realpath (and the per-action run
  // seams, ctx.runRepoMemoryIndex / ctx.runRepoRelayRerun) to stub fs/exec;
  // production falls through to the real implementations.
  const resolveFn = typeof ctx?.resolveRepoSet === 'function' ? ctx.resolveRepoSet : resolveRepoSet
  const realpathFn = typeof ctx?.realpath === 'function' ? ctx.realpath : realpathSync

  // Repo-set membership gate (#2 above): canonicalize, then compare.
  let targetKey
  try {
    targetKey = realpathFn(resolve(repoPath))
  } catch {
    integrationActionError(ws, ctx, msg, 'unknown-repo',
      `repoPath does not resolve to a surveyed repo: ${repoPath}`)
    return
  }
  let isMember = false
  try {
    for (const repo of resolveFn({ repos, root })) {
      if (!repo || typeof repo.path !== 'string') continue
      let memberKey
      try {
        memberKey = realpathFn(resolve(repo.path))
      } catch {
        continue
      }
      if (memberKey === targetKey) {
        isMember = true
        break
      }
    }
  } catch (err) {
    integrationActionError(ws, ctx, msg, 'repo-set-failed',
      `Could not resolve the surveyed repo set: ${err && err.message ? err.message : 'unknown error'}`)
    return
  }
  if (!isMember) {
    integrationActionError(ws, ctx, msg, 'unknown-repo',
      `repoPath is not a member of the surveyed repo set: ${repoPath}`)
    return
  }

  // Per-repo overlap guard, then the global cap (reject, never queue). One
  // shared bucket across action kinds — see the `actionInFlight` note.
  if (actionInFlight.has(targetKey)) {
    integrationActionError(ws, ctx, msg, 'action-in-progress',
      `An integration action (${actionInFlight.get(targetKey)}) is already in progress for ${targetKey}`)
    return
  }
  if (actionInFlight.size >= MAX_CONCURRENT_INTEGRATION_ACTIONS) {
    integrationActionError(ws, ctx, msg, 'busy',
      `The host is busy: ${actionInFlight.size} integration actions are already in flight (max ${MAX_CONCURRENT_INTEGRATION_ACTIONS}) — retry when one finishes`)
    return
  }

  actionInFlight.set(targetKey, action)
  try {
    // Exec against the canonical realpath — never the raw client string.
    const ackFields = await actionEntry.run({ msg, ctx, config, targetKey })
    log.info(`integration_action ${action} completed for ${targetKey} (client=${client?.id})`)
    ctx.transport.send(ws, {
      type: 'integration_action_ack',
      action,
      // Echo the CLIENT-supplied path so the dashboard's pending state
      // (keyed by what it sent) correlates even through a symlink alias.
      repoPath,
      requestId: typeof msg?.requestId === 'string' ? msg.requestId : null,
      ...ackFields,
    })
  } catch (err) {
    const message = err && err.message ? err.message : `${action} failed`
    log.warn(`integration_action ${action} failed for ${targetKey}: ${message}`)
    const reason = err && typeof err.reason === 'string' && err.reason.length > 0
      ? err.reason
      : actionEntry.failureReason
    integrationActionError(ws, ctx, msg, reason, message)
  } finally {
    actionInFlight.delete(targetKey)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// #6134 (epic #5530) — containers_action: stop / restart / destroy a
// chroxy-managed container or environment.
// ───────────────────────────────────────────────────────────────────────────

/**
 * #6134: per-environment in-flight guard for container lifecycle actions, keyed
 * by environmentId. Independent of the integration-action bucket (different key
 * space, different subprocess fan-out) — same string-keyed Map shape, entries
 * deleted in the handler's `finally`, `.size` doubling as the global gauge.
 */
const containerActionInFlight = new Map()
/** #6134: global cap on concurrent container actions (reject, never queue). */
export const MAX_CONCURRENT_CONTAINER_ACTIONS = 2

/**
 * #6134: shared CONTAINER_ACTION_FAILED reply. Mirrors `integrationActionError`:
 * a `session_error` envelope with the stable code, a `reason` discriminator, and
 * the request's correlation fields (`action` / `environmentId` / `requestId`)
 * echoed so the dashboard can clear the exact row's pending state.
 */
function containerActionError(ws, ctx, msg, reason, message) {
  ctx.transport.send(ws, {
    type: 'session_error',
    code: 'CONTAINER_ACTION_FAILED',
    message,
    reason,
    action: typeof msg?.action === 'string' ? msg.action : null,
    environmentId: typeof msg?.environmentId === 'string' ? msg.environmentId : null,
    requestId: typeof msg?.requestId === 'string' ? msg.requestId : null,
  })
}

/** #6134: failure `reason` discriminator per action (for CONTAINER_ACTION_FAILED). */
const CONTAINER_ACTION_FAILURE_REASON = {
  stop: 'stop-failed',
  restart: 'restart-failed',
  destroy: 'destroy-failed',
}

/**
 * #6134 (epic #5530) — `containers_action` handler. Stop / restart / destroy a
 * chroxy-managed environment, replying with exactly one `containers_action_ack`
 * on success or one CONTAINER_ACTION_FAILED `session_error` on failure.
 *
 * SECURITY (docs/security/bearer-token-authority.md checklist):
 *   1. Host-level authority — a pairing-bound (share-a-session) client is scoped
 *      to one session and must not run host-wide lifecycle actions.
 *   2. Survey membership — the client-supplied `environmentId` MUST name a live
 *      environment the EnvironmentManager tracks (the same set the containers
 *      survey reports). An unknown id is rejected; the client id is a lookup
 *      key, never a trusted target. Only chroxy's own environments are touchable
 *      — never an arbitrary host container.
 *
 * Concurrency: one in-flight action per environment, plus a global cap of
 * MAX_CONCURRENT_CONTAINER_ACTIONS (rejected, not queued).
 */
async function handleContainersAction(ws, client, msg, ctx) {
  // Authority gate (#1): host-level (unbound) clients only.
  if (client?.boundSessionId) {
    containerActionError(ws, ctx, msg, 'forbidden',
      'containers_action requires host-level authority (a session-bound token cannot run host actions)')
    return
  }

  const action = typeof msg?.action === 'string' ? msg.action : ''
  if (action !== 'stop' && action !== 'restart' && action !== 'destroy') {
    containerActionError(ws, ctx, msg, 'unsupported-action',
      `Unsupported container action: ${action.length > 0 ? action : '(none)'}`)
    return
  }

  const environmentId = typeof msg?.environmentId === 'string' ? msg.environmentId : ''
  if (environmentId.length === 0) {
    containerActionError(ws, ctx, msg, 'invalid-environment-id',
      'containers_action requires a non-empty environmentId')
    return
  }

  const envManager = ctx?.services?.environmentManager || null
  if (!envManager || typeof envManager.get !== 'function') {
    containerActionError(ws, ctx, msg, 'no-environment-manager',
      'Container environments are not enabled on this server')
    return
  }

  // Survey membership gate (#2): the id MUST name a live environment.
  const env = envManager.get(environmentId)
  if (!env) {
    containerActionError(ws, ctx, msg, 'unknown-environment',
      `environmentId does not name a surveyed environment: ${environmentId}`)
    return
  }

  // Per-environment overlap guard, then the global cap (reject, never queue).
  if (containerActionInFlight.has(environmentId)) {
    containerActionError(ws, ctx, msg, 'action-in-progress',
      `A container action (${containerActionInFlight.get(environmentId)}) is already in progress for ${environmentId}`)
    return
  }
  if (containerActionInFlight.size >= MAX_CONCURRENT_CONTAINER_ACTIONS) {
    containerActionError(ws, ctx, msg, 'busy',
      `The host is busy: ${containerActionInFlight.size} container actions are already in flight (max ${MAX_CONCURRENT_CONTAINER_ACTIONS}) — retry when one finishes`)
    return
  }

  containerActionInFlight.set(environmentId, action)
  try {
    let status
    if (action === 'stop') {
      status = await envManager.stop(environmentId)
    } else if (action === 'restart') {
      status = await envManager.restart(environmentId)
    } else {
      await envManager.destroy(environmentId)
      status = 'destroyed'
    }
    log.info(`containers_action ${action} completed for ${environmentId} (client=${client?.id})`)
    ctx.transport.send(ws, {
      type: 'containers_action_ack',
      action,
      environmentId,
      requestId: typeof msg?.requestId === 'string' ? msg.requestId : null,
      status: typeof status === 'string' ? status : null,
    })
  } catch (err) {
    const message = err && err.message ? err.message : `${action} failed`
    log.warn(`containers_action ${action} failed for ${environmentId}: ${message}`)
    containerActionError(ws, ctx, msg, CONTAINER_ACTION_FAILURE_REASON[action], message)
  } finally {
    containerActionInFlight.delete(environmentId)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// #6135 slice 2 (epic #5530) — byok_pool_action: drain / recycle / resize the
// BYOK warm-container pool.
// ───────────────────────────────────────────────────────────────────────────

/**
 * #6135 slice 2: the BYOK pool is a process-wide singleton, so a single global
 * in-flight flag serializes all pool mutations (drain/recycle/resize) — they all
 * mutate the same shared state and must not race. Rejected, never queued.
 */
let byokPoolActionInFlight = false

/**
 * #6135 slice 2: shared BYOK_POOL_ACTION_FAILED reply. Mirrors
 * `containerActionError`: a `session_error` envelope with the stable code, a
 * `reason` discriminator, and the request's correlation fields (`action` / `key`
 * / `requestId`) echoed so the dashboard can clear the exact row's pending state.
 */
function byokPoolActionError(ws, ctx, msg, reason, message) {
  ctx.transport.send(ws, {
    type: 'session_error',
    code: 'BYOK_POOL_ACTION_FAILED',
    message,
    reason,
    action: typeof msg?.action === 'string' ? msg.action : null,
    key: typeof msg?.key === 'string' ? msg.key : null,
    requestId: typeof msg?.requestId === 'string' ? msg.requestId : null,
  })
}

/**
 * #6135 slice 2 (epic #5530) — `byok_pool_action` handler. Drain / recycle /
 * resize the BYOK warm-container pool, replying with exactly one
 * `byok_pool_action_ack` on success or one BYOK_POOL_ACTION_FAILED
 * `session_error` on failure.
 *
 * SECURITY (docs/security/bearer-token-authority.md checklist):
 *   1. Host-level authority — a pairing-bound (share-a-session) client is scoped
 *      to one session and must not run host-wide pool actions.
 *   2. Survey membership — for `recycle`, the client-supplied `key` MUST name a
 *      bucket the pool's OWN survey (`inspect()`) currently enumerates. An
 *      unknown key is rejected; the client key is a lookup key, never a trusted
 *      target. drain/resize have no client-supplied target — drain acts on all
 *      buckets the pool itself owns; resize is bounded server-side to the
 *      operator-configured ceiling (the pool clamps, never the client).
 *
 * Concurrency: a single global in-flight flag — pool mutations are host-wide and
 * serialized (rejected, not queued).
 */
async function handleByokPoolAction(ws, client, msg, ctx) {
  // Authority gate (#1): host-level (unbound) clients only.
  if (client?.boundSessionId) {
    byokPoolActionError(ws, ctx, msg, 'forbidden',
      'byok_pool_action requires host-level authority (a session-bound token cannot run host actions)')
    return
  }

  const action = typeof msg?.action === 'string' ? msg.action : ''
  if (action !== 'drain' && action !== 'recycle' && action !== 'resize') {
    byokPoolActionError(ws, ctx, msg, 'unsupported-action',
      `Unsupported BYOK pool action: ${action.length > 0 ? action : '(none)'}`)
    return
  }

  // Pool-enabled gate — degrade cleanly when the pool is off (the default).
  const poolEnabled = typeof ctx?.isPoolEnabled === 'function' ? ctx.isPoolEnabled() : isPoolEnabled(process.env)
  if (!poolEnabled) {
    byokPoolActionError(ws, ctx, msg, 'pool-disabled',
      'The BYOK container pool is disabled (set CHROXY_DOCKER_BYOK_POOL to enable)')
    return
  }

  // Tests inject `ctx.byokPool`; production resolves the shared singleton.
  const pool = 'byokPool' in (ctx || {}) ? ctx.byokPool : getSharedPool(process.env)
  if (!pool || typeof pool.drainAll !== 'function') {
    byokPoolActionError(ws, ctx, msg, 'no-pool',
      'BYOK pool is enabled but no pool instance is available yet')
    return
  }

  // Validate the recycle target against the pool's OWN survey (#2) BEFORE taking
  // the in-flight lock, so a bad request fails fast and doesn't block real work.
  let key = null
  if (action === 'recycle') {
    key = typeof msg?.key === 'string' ? msg.key : ''
    if (key.length === 0) {
      byokPoolActionError(ws, ctx, msg, 'invalid-key', 'recycle requires a non-empty key')
      return
    }
    // The survey is the ONLY source of truth for a valid target. If the pool
    // can't be surveyed, fail with a distinct reason rather than misreporting
    // every key as unknown — the target can't be validated, so we refuse.
    if (typeof pool.inspect !== 'function') {
      byokPoolActionError(ws, ctx, msg, 'no-pool',
        'BYOK pool cannot be surveyed to validate the recycle target')
      return
    }
    const surveyedKeys = pool.inspect().map((b) => b.key)
    if (!surveyedKeys.includes(key)) {
      byokPoolActionError(ws, ctx, msg, 'unknown-key',
        `key does not name a surveyed pool bucket: ${key}`)
      return
    }
  }

  // Validate resize params: at least one cap, positive integers (the pool clamps
  // to the configured ceiling — we only reject malformed input here).
  if (action === 'resize') {
    const hasPerKey = msg?.maxPerKey !== undefined
    const hasTotal = msg?.maxTotal !== undefined
    if (!hasPerKey && !hasTotal) {
      byokPoolActionError(ws, ctx, msg, 'invalid-resize',
        'resize requires at least one of maxPerKey / maxTotal')
      return
    }
    if (hasPerKey && !(Number.isInteger(msg.maxPerKey) && msg.maxPerKey >= 1)) {
      byokPoolActionError(ws, ctx, msg, 'invalid-resize', 'maxPerKey must be a positive integer')
      return
    }
    if (hasTotal && !(Number.isInteger(msg.maxTotal) && msg.maxTotal >= 1)) {
      byokPoolActionError(ws, ctx, msg, 'invalid-resize', 'maxTotal must be a positive integer')
      return
    }
  }

  // Global serialization (reject, never queue) — one pool mutation at a time.
  if (byokPoolActionInFlight) {
    byokPoolActionError(ws, ctx, msg, 'action-in-progress',
      'A BYOK pool action is already in progress')
    return
  }

  byokPoolActionInFlight = true
  try {
    const ack = {
      type: 'byok_pool_action_ack',
      action,
      key: key || null,
      requestId: typeof msg?.requestId === 'string' ? msg.requestId : null,
      drained: null,
      evicted: null,
      limits: null,
      configured: null,
    }
    if (action === 'drain') {
      ack.drained = await pool.drainAll()
    } else if (action === 'recycle') {
      ack.drained = await pool.recycleKey(key)
    } else {
      const result = await pool.resize({ maxPerKey: msg?.maxPerKey, maxTotal: msg?.maxTotal })
      ack.evicted = result?.evicted ?? 0
      ack.limits = result?.limits ?? null
      ack.configured = result?.configured ?? null
    }
    log.info(`byok_pool_action ${action} completed (client=${client?.id})`)
    ctx.transport.send(ws, ack)
  } catch (err) {
    const message = err && err.message ? err.message : `${action} failed`
    log.warn(`byok_pool_action ${action} failed: ${message}`)
    byokPoolActionError(ws, ctx, msg, `${action}-failed`, message)
  } finally {
    byokPoolActionInFlight = false
  }
}

// ───────────────────────────────────────────────────────────────────────────
// #6140 (epic #5530) — host prune guardrails: survey reclaimable chroxy-scoped
// orphan docker pressure (host_prune_status_request) + prune it (host_prune_action).
// ───────────────────────────────────────────────────────────────────────────

/** #6140: schema-conformant error reply for the host-prune survey. */
function hostPruneErrorSnapshot(requestId, error) {
  return {
    type: 'host_prune_status_snapshot',
    requestId: requestId ?? null,
    generatedAt: new Date().toISOString(),
    dockerAvailable: false,
    note: null,
    containers: [],
    images: [],
    summary: { containerCount: 0, imageCount: 0, reclaimableBytes: 0 },
    error,
  }
}

/**
 * #6140 — host prune survey handler (read-only). Host-authority + per-client
 * in-flight + degraded-reply contract as the sibling surveys. Surveys ONLY
 * chroxy's own orphan resources (never arbitrary host containers/images).
 */
async function handleHostPruneStatusRequest(ws, client, msg, ctx) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null
  if (client?.boundSessionId) {
    ctx.transport.send(ws, hostPruneErrorSnapshot(requestId, {
      code: 'FORBIDDEN',
      message: 'host_prune_status_request requires host-level authority (a session-bound token cannot survey the host)',
    }))
    return
  }
  if (hostPruneInFlight.has(client)) {
    ctx.transport.send(ws, hostPruneErrorSnapshot(requestId, {
      code: 'SURVEY_IN_PROGRESS',
      message: 'A host prune survey is already in progress for this client',
    }))
    return
  }
  const surveyFn = typeof ctx?.surveyHostPrune === 'function' ? ctx.surveyHostPrune : surveyHostPrune
  const envManager = ctx?.services?.environmentManager || null
  hostPruneInFlight.add(client)
  try {
    const snapshot = await surveyFn({
      listEnvironments: () => (typeof envManager?.list === 'function' ? envManager.list() : []),
    })
    ctx.transport.send(ws, {
      type: 'host_prune_status_snapshot',
      requestId,
      generatedAt: snapshot.generatedAt,
      dockerAvailable: snapshot.dockerAvailable,
      note: snapshot.note ?? null,
      containers: snapshot.containers,
      images: snapshot.images,
      summary: snapshot.summary,
    })
  } catch (err) {
    log.warn(`host_prune_status_request failed: ${err && err.message ? err.message : 'unknown error'}`)
    ctx.transport.send(ws, hostPruneErrorSnapshot(requestId, {
      code: 'SURVEY_FAILED',
      message: err && err.message ? err.message : 'host prune survey failed',
    }))
  } finally {
    hostPruneInFlight.delete(client)
  }
}

/**
 * #6140: a host prune mutates host-wide docker state, so a single global flag
 * serializes prune actions (rejected, never queued).
 */
let hostPruneActionInFlight = false

/** #6140: shared HOST_PRUNE_ACTION_FAILED reply (mirrors byokPoolActionError). */
function hostPruneActionError(ws, ctx, msg, reason, message) {
  ctx.transport.send(ws, {
    type: 'session_error',
    code: 'HOST_PRUNE_ACTION_FAILED',
    message,
    reason,
    kind: typeof msg?.kind === 'string' ? msg.kind : null,
    requestId: typeof msg?.requestId === 'string' ? msg.requestId : null,
  })
}

/**
 * #6140 (epic #5530) — `host_prune_action` handler. Removes reclaimable
 * chroxy-scoped orphan docker resources, replying with exactly one
 * `host_prune_action_ack` on success or one HOST_PRUNE_ACTION_FAILED
 * `session_error` on failure.
 *
 * SECURITY: host-level authority only. The action takes NO target list — it
 * re-surveys the chroxy-scoped orphan set server-side (`runHostPrune`) and removes
 * only those exact ids; the client supplies only a `kind` selector. Never a
 * blanket docker prune, never a running/tracked/non-chroxy resource.
 */
async function handleHostPruneAction(ws, client, msg, ctx) {
  if (client?.boundSessionId) {
    hostPruneActionError(ws, ctx, msg, 'forbidden',
      'host_prune_action requires host-level authority (a session-bound token cannot run host actions)')
    return
  }
  const kind = typeof msg?.kind === 'string' ? msg.kind : ''
  if (!PRUNE_KINDS.includes(kind)) {
    hostPruneActionError(ws, ctx, msg, 'unsupported-kind',
      `Unsupported prune kind: ${kind.length > 0 ? kind : '(none)'}`)
    return
  }
  if (hostPruneActionInFlight) {
    hostPruneActionError(ws, ctx, msg, 'action-in-progress', 'A host prune action is already in progress')
    return
  }
  const runFn = typeof ctx?.runHostPrune === 'function' ? ctx.runHostPrune : runHostPrune
  const envManager = ctx?.services?.environmentManager || null
  hostPruneActionInFlight = true
  try {
    const result = await runFn({
      kind,
      listEnvironments: () => (typeof envManager?.list === 'function' ? envManager.list() : []),
    })
    log.info(`host_prune_action ${kind} removed ${result.removedContainers}c/${result.removedImages}i (client=${client?.id})`)
    ctx.transport.send(ws, {
      type: 'host_prune_action_ack',
      kind: result.kind,
      requestId: typeof msg?.requestId === 'string' ? msg.requestId : null,
      dockerAvailable: result.dockerAvailable,
      removedContainers: result.removedContainers,
      removedImages: result.removedImages,
      reclaimedBytes: result.reclaimedBytes,
      failures: result.failures,
    })
  } catch (err) {
    const message = err && err.message ? err.message : 'host prune failed'
    log.warn(`host_prune_action ${kind} failed: ${message}`)
    hostPruneActionError(ws, ctx, msg, 'prune-failed', message)
  } finally {
    hostPruneActionInFlight = false
  }
}

/**
 * #5914 follow-up — reply to a `mailbox_status_request` with a point-in-time
 * snapshot of the daemon's mailbox state for the Control Room "Mailbox" tab:
 * the live `agentCommId -> session` registrations plus a bounded ring buffer of
 * recent live-interrupt deliveries (newest first). Reads in-memory SessionManager
 * state only (no git/gh survey), so unlike the host/runner surveys it is
 * synchronous and has no in-flight guard.
 *
 * Host-level survey: a pairing-bound (share-a-session) token is rejected, like
 * `host_status_request`. On refusal it still replies with a schema-valid
 * snapshot (empty arrays) carrying an additive `error` annotation so the tab can
 * render the refusal rather than spin forever.
 */
function handleMailboxStatusRequest(ws, client, msg, ctx) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null
  const base = {
    type: 'mailbox_status_snapshot',
    requestId,
    generatedAt: new Date().toISOString(),
    registrations: [],
    recentEvents: [],
  }

  if (client?.boundSessionId) {
    ctx.transport.send(ws, {
      ...base,
      error: {
        code: 'FORBIDDEN',
        message: 'mailbox_status_request requires host-level authority (a session-bound token cannot survey the host)',
      },
    })
    return
  }

  const sm = ctx?.sessions?.sessionManager
  ctx.transport.send(ws, {
    ...base,
    registrations: typeof sm?.listAgentCommRegistrations === 'function' ? sm.listAgentCommRegistrations() : [],
    recentEvents: typeof sm?.getMailboxEvents === 'function' ? sm.getMailboxEvents() : [],
  })
}

export const controlRoomHandlers = {
  host_status_request: handleHostStatusRequest,
  runner_status_request: handleRunnerStatusRequest,
  containers_status_request: handleContainersStatusRequest,
  repo_runtime_config_request: handleRepoRuntimeConfigRequest,
  byok_pool_status_request: handleByokPoolStatusRequest,
  host_prune_status_request: handleHostPruneStatusRequest,
  containers_action: handleContainersAction,
  byok_pool_action: handleByokPoolAction,
  host_prune_action: handleHostPruneAction,
  integration_status_request: handleIntegrationStatusRequest,
  skills_inventory_request: handleSkillsInventoryRequest,
  mailbox_status_request: handleMailboxStatusRequest,
  integration_action: handleIntegrationAction,
}
