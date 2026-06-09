/**
 * Control Room v2 (#5174) — Host/Repo Status WS handler.
 *
 * Handles: host_status_request
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
import { createLogger } from '../logger.js'
import { resolveRepoSet, DEFAULT_CONTROL_ROOM_ROOT } from '../control-room/repo-set.js'
import { surveyRepos } from '../control-room/survey.js'
import { surveyRunners, DEFAULT_RUNNER_ROOT } from '../control-room/runners.js'

const log = createLogger('ws')

// Per-client in-flight guard. A WeakSet keyed by the client object means we
// never leak entries when a client disconnects (the client object is GC'd) and
// we never need an explicit cleanup path.
const inFlight = new WeakSet()
// #5253: a separate in-flight guard for the runner survey, so a runner refresh
// and a host refresh don't block each other (they shell out to different tools).
const runnerInFlight = new WeakSet()

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

  const config = ctx?.config || {}
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
    ctx.send(ws, errorSnapshot(root, requestId, {
      code: 'FORBIDDEN',
      message: 'host_status_request requires host-level authority (a session-bound token cannot survey the host)',
    }))
    return
  }

  // In-flight guard: one survey per client at a time.
  if (inFlight.has(client)) {
    ctx.send(ws, errorSnapshot(root, requestId, {
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
      activeSessionCwds: activeSessionCwds(ctx?.sessionManager),
      root,
    })

    ctx.send(ws, {
      type: 'host_status_snapshot',
      requestId,
      generatedAt: snapshot.generatedAt,
      root: snapshot.root,
      summary: snapshot.summary,
      repos: snapshot.repos,
    })
  } catch (err) {
    log.warn(`host_status_request failed: ${err && err.message ? err.message : 'unknown error'}`)
    ctx.send(ws, errorSnapshot(root, requestId, {
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

  const config = ctx?.config || {}
  const root = typeof config.controlRoomRunnerRoot === 'string' && config.controlRoomRunnerRoot.length > 0
    ? config.controlRoomRunnerRoot
    : DEFAULT_RUNNER_ROOT

  // Authority gate: a host-wide runner survey is for host-level clients only.
  if (client?.boundSessionId) {
    ctx.send(ws, runnerErrorSnapshot(root, requestId, {
      code: 'FORBIDDEN',
      message: 'runner_status_request requires host-level authority (a session-bound token cannot survey the host)',
    }))
    return
  }

  if (runnerInFlight.has(client)) {
    ctx.send(ws, runnerErrorSnapshot(root, requestId, {
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
    ctx.send(ws, {
      type: 'runner_status_snapshot',
      requestId,
      generatedAt: snapshot.generatedAt,
      root: snapshot.root,
      summary: snapshot.summary,
      repos: snapshot.repos,
    })
  } catch (err) {
    log.warn(`runner_status_request failed: ${err && err.message ? err.message : 'unknown error'}`)
    ctx.send(ws, runnerErrorSnapshot(root, requestId, {
      code: 'SURVEY_FAILED',
      message: err && err.message ? err.message : 'runner status survey failed',
    }))
  } finally {
    runnerInFlight.delete(client)
  }
}

export const controlRoomHandlers = {
  host_status_request: handleHostStatusRequest,
  runner_status_request: handleRunnerStatusRequest,
}
