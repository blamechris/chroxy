/**
 * What an agent principal may send, see and be sent.
 *
 * An agent principal (docs/security/agent-principals.md) is a scoped, revocable,
 * labelled credential for a supervisor agent. A principal connection is stamped
 * `client.principal = { principalId, label, tier, scope, constraints }`, has
 * `isPrimaryToken === false`, and carries a fixed non-empty sentinel in
 * `client.boundSessionId` so every host gate that branches on the binding still
 * refuses it. This module is the deny-by-default policy for that class:
 *
 *   - INBOUND  `refusePrincipalMessage`: a message type is dispatched for a
 *     principal only when it is in `PRINCIPAL_ALLOWED_MESSAGE_TYPES`, the
 *     principal's tier is high enough, and the message carries no field outside
 *     the per-operation envelope (`PRINCIPAL_ENVELOPES`). Everything else is
 *     refused `scope_denied`.
 *   - ACCESS   `principalMaySee`: the one per-session access helper (grant
 *     constraint, tier and, for a mutation, lease).
 *   - OUTBOUND `frameForPrincipal`: deny by default. A frame tagged with a
 *     session is delivered only when the grant covers that session; a frame with
 *     no session is delivered only when its type is in
 *     `PRINCIPAL_OUTGOING_ALLOWED`, reduced to that type's field whitelist.
 *     Ordinary session broadcasts are never delivered (contract §3.1 item 7).
 *
 * `dispatchPolicyFor` is the ONE selector both inbound sites use (the pre-schema
 * gate in ws-server.js and `handleSessionMessage`). A principal gets
 * `refusePrincipalMessage` INSTEAD of `refuseBoundMessage`, never in addition,
 * and the bound allowlist is neither consulted for a principal nor loosened.
 *
 * Every function here is INERT for a client with no `principal` stamp: no
 * existing client can carry one until the credential class lands (S1, #9116),
 * so non-principal behaviour is byte-identical.
 *
 * tests/principal-policy.test.js asserts the classification is total in both
 * directions against the client-schema registry and `registeredMessageTypes`,
 * and the outgoing roster against the server schema registry.
 */

import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { createLogger, loggableValue } from './logger.js'
import { refuseBoundMessage } from './bound-client-policy.js'

const log = createLogger('principal-policy')

// -- Tiers ------------------------------------------------------------------

/** observe < steer < drive < answer; a higher tier includes everything below it. */
export const PRINCIPAL_TIER_ORDER = Object.freeze(['observe', 'steer', 'drive', 'answer'])

const TIER_RANK = new Map(PRINCIPAL_TIER_ORDER.map((t, i) => [t, i]))

/** Needs that mutate a session and therefore require a lease (steer and above). */
const MUTATION_NEEDS = new Set(['steer', 'drive', 'answer'])

// -- Inbound: transport exempt set ------------------------------------------

/**
 * Types handled in ws-auth.js and ws-server.js OUTSIDE `handlerRegistry`. They
 * are asserted as a separate, literal set (not a hole in the roster): `auth` and
 * `key_exchange` run before dispatch, and `ping` is answered before the gate.
 * @type {readonly string[]}
 */
export const PRINCIPAL_TRANSPORT_EXEMPT = Object.freeze(['auth', 'key_exchange', 'ping'])

// -- Inbound: allowlist ------------------------------------------------------

/**
 * v1 allowlist: EXISTING types only. The new `principal_*` types are added by the
 * children that add their handlers; none is listed here before it exists.
 * `tier` is the lowest tier that may send the type.
 * @type {Readonly<Record<string, { tier: string, reason: string }>>}
 */
export const PRINCIPAL_ALLOWED_MESSAGE_TYPES = Object.freeze({
  input: Object.freeze({
    tier: 'steer',
    reason: 'steer: one fenced, provenance-labelled input into a leased session; the handler resolves an explicit sessionId through principalMaySee with no activeSessionId fallback',
  }),
  interrupt: Object.freeze({
    tier: 'drive',
    reason: 'drive: stops a turn on a leased session; the handler resolves an explicit sessionId through principalMaySee',
  }),
  create_session: Object.freeze({
    tier: 'drive',
    reason: 'drive: creates a session inside the grant; the handler carries its own principal branch placed before the bound refusal (constrained create is S12)',
  }),
  destroy_session: Object.freeze({
    tier: 'drive',
    reason: 'drive: closes a session the principal created; the handler resolves the target through principalMaySee',
  }),
  permission_response: Object.freeze({
    tier: 'answer',
    reason: 'answer: denies a pending prompt on a leased session; deny only, field-limited, resolved through principalMaySee',
  }),
})

// -- Inbound: denied roster --------------------------------------------------

const SESSION_READ = 'a raw session read: a principal reads through the daemon-normalized principal_* family, never the raw output a dashboard gets'
const SESSION_SETTING = 'changes a session setting a principal does not hold; a principal steers by input only'
const HOST_WIDE = 'host-wide surface a principal never sees'
const HOST_ACTION = 'host-wide action a principal never takes'
const CREDENTIAL = 'credential or trust management a principal never touches'
const WORKSPACE_WRITE = 'writes the workspace, which a principal never does'
const WORKSPACE_READ = 'reads the workspace directly; a principal reads through the normalized principal_* family'
const HUMAN_SURFACE = 'a human-client surface (focus, presence, subscription, visibility) with no meaning for a principal'

/**
 * Every other registered client type. Anything not listed here or in the allowlist
 * is refused anyway, so a handler added without a decision is unavailable to a
 * principal rather than silently open to it.
 * @type {Readonly<Record<string, string>>}
 */
export const PRINCIPAL_DENIED_MESSAGE_TYPES = Object.freeze({
  // -- sessions: roster, navigation, lifecycle other than create/destroy --
  list_sessions: 'a raw roster; a principal reads its granted sessions through principal_sessions_snapshot',
  switch_session: 'moves a human client\'s focus; a principal has no active session',
  subscribe_sessions: HUMAN_SURFACE,
  unsubscribe_sessions: HUMAN_SURFACE,
  rename_session: 'renames a session; not in the v1 authority tiers',
  claim_primary: 'takes the primary-driver slot, which belongs to a human client',
  client_visible: HUMAN_SURFACE,
  resume_conversation: 'creates a session outside the constrained create envelope',
  restore_archived_session: 'creates a session outside the constrained create envelope',
  list_archived_sessions: HOST_WIDE,
  get_archived_session_history: HOST_WIDE,
  delete_archived_session: 'archive purge is never delegated',
  set_session_archive_policy: 'archive policy is never delegated',
  list_failed_restores: HOST_WIDE,
  retry_failed_restore: HOST_ACTION,
  get_failed_restore_history: HOST_WIDE,

  // -- turn control other than input/interrupt --
  cancel_queued: 'edits a human queue; not in the v1 authority tiers',
  cancel_activity: 'cancels background work; not in the v1 authority tiers',
  resume_budget: 'lifts a budget pause, which a human decides',
  user_question_response: 'answers a question; a principal answers prompts only through permission_response deny',
  get_permission_input: 'the raw pending tool input; a principal reads the normalized pending-permission snapshot',
  query_permission_audit: 'the permission audit is a host record',
  register_push_token: 'registers a device for notifications; a principal is not a device',
  notification_prefs_get: HOST_WIDE,
  notification_prefs_set: 'host-wide notification settings are never delegated',

  // -- terminals: a principal never types into a PTY --
  terminal_input: 'raw keystrokes into a PTY; a principal reaches a PTY only through the fenced sendMessage path',
  terminal_subscribe: 'raw terminal output; a principal reads normalized events',
  terminal_unsubscribe: HUMAN_SURFACE,
  terminal_resize: HUMAN_SURFACE,
  terminal_resync: SESSION_READ,

  // -- per-session settings --
  set_model: SESSION_SETTING,
  set_thinking_level: SESSION_SETTING,
  set_permission_mode: 'permission mode is never delegated: auto and more-permissive modes are outside every tier',
  set_prompt_evaluator: SESSION_SETTING,
  set_chroxy_context_hint: SESSION_SETTING,
  set_session_preamble: SESSION_SETTING,
  set_mcp_server_enabled: SESSION_SETTING,
  evaluate_draft: SESSION_SETTING,
  extension_message: 'delivers an arbitrary extension payload to a session',
  skill_activate: SESSION_SETTING,
  skill_deactivate: SESSION_SETTING,
  list_skills: SESSION_READ,
  list_slash_commands: SESSION_READ,
  list_agents: SESSION_READ,

  // -- history, conversations and raw reads --
  request_full_history: SESSION_READ,
  request_session_context: SESSION_READ,
  request_conversation_transcript: SESSION_READ,
  list_conversations: SESSION_READ,
  search_conversations: SESSION_READ,
  summarize_session: SESSION_READ,
  session_pr_status_request: SESSION_READ,
  session_pr_threads_request: SESSION_READ,

  // -- workspace reads, writes, git and IDE --
  browse_files: WORKSPACE_READ,
  list_files: WORKSPACE_READ,
  read_file: WORKSPACE_READ,
  memory_read: WORKSPACE_READ,
  get_diff: WORKSPACE_READ,
  git_status: WORKSPACE_READ,
  git_branches: WORKSPACE_READ,
  list_symbols: WORKSPACE_READ,
  resolve_symbol: WORKSPACE_READ,
  search_content: WORKSPACE_READ,
  find_references: WORKSPACE_READ,
  list_directory: 'enumerates host directories',
  check_git_repo: 'probes arbitrary host directories',
  write_file: WORKSPACE_WRITE,
  append_memory: WORKSPACE_WRITE,
  git_stage: WORKSPACE_WRITE,
  git_unstage: WORKSPACE_WRITE,
  git_commit: WORKSPACE_WRITE,
  git_create_pr: 'writes the workspace and the remote',
  restore_checkpoint: 'rewrites the workspace',
  create_checkpoint: 'writes workspace state; not in the v1 authority tiers',
  list_checkpoints: SESSION_READ,
  delete_checkpoint: 'deletes workspace state',

  // -- permission rules, credentials and trust --
  set_permission_rules: 'permission rules and allowAlways are never delegated',
  set_prompt_evaluator_skip_pattern: 'a pattern the daemon runs on its own event loop for every input',
  add_mcp_server: 'MCP configuration is a command the machine runs',
  remove_mcp_server: 'MCP configuration is never delegated',
  submit_mcp_auth_code: CREDENTIAL,
  list_providers: HOST_WIDE,
  byok_get_credentials_status: HOST_WIDE,
  get_credentials_status: HOST_WIDE,
  byok_set_credentials: CREDENTIAL,
  byok_clear_credentials: CREDENTIAL,
  set_credential: CREDENTIAL,
  delete_credential: CREDENTIAL,
  test_credential: 'uses a host-wide credential',
  skill_trust_accept: 'skill trust is host-executable code and never delegated',
  skill_trust_grant: 'skill trust is host-executable code and never delegated',
  github_webhook_config_request: HOST_WIDE,
  github_webhook_set_secret: CREDENTIAL,
  github_webhook_clear_secret: CREDENTIAL,
  session_preset_get: HOST_WIDE,
  session_preset_set: 'host-wide presets are never delegated',
  session_preset_approve: 'host-wide presets are never delegated',
  session_preset_revoke: 'host-wide presets are never delegated',
  daemon_update_action: 'daemon update and restart are never delegated',
  revoke_token: CREDENTIAL,
  pair_approve: 'pairing is never delegated',
  pair_deny: 'pairing is never delegated',

  // -- repositories, web tasks, previews, environments --
  list_repos: HOST_WIDE,
  add_repo: HOST_ACTION,
  remove_repo: HOST_ACTION,
  launch_web_task: 'starts independent execution',
  teleport_web_task: 'starts independent execution',
  list_web_tasks: HOST_WIDE,
  open_dev_preview: 'preview publication is never delegated',
  close_dev_preview: 'preview lifecycle is never delegated',
  create_environment: 'environments are never delegated',
  list_environments: HOST_WIDE,
  destroy_environment: 'environments are never delegated',
  get_environment: HOST_WIDE,

  // -- control room, orchestration, scheduling --
  request_cost_summary: HOST_WIDE,
  host_status_request: HOST_WIDE,
  runner_status_request: HOST_WIDE,
  containers_status_request: HOST_WIDE,
  repo_runtime_config_request: HOST_WIDE,
  byok_pool_status_request: HOST_WIDE,
  host_prune_status_request: HOST_WIDE,
  simulator_status_request: HOST_WIDE,
  emulator_status_request: HOST_WIDE,
  wsl_status_request: HOST_WIDE,
  integration_status_request: HOST_WIDE,
  skills_inventory_request: HOST_WIDE,
  mailbox_status_request: HOST_WIDE,
  external_sessions_request: HOST_WIDE,
  repo_events_request: HOST_WIDE,
  containers_action: HOST_ACTION,
  byok_pool_action: HOST_ACTION,
  host_prune_action: HOST_ACTION,
  simulator_action: HOST_ACTION,
  emulator_action: HOST_ACTION,
  wsl_action: HOST_ACTION,
  integration_action: HOST_ACTION,
  orchestration_runs_request: HOST_WIDE,
  orchestration_run_detail_request: HOST_WIDE,
  orchestration_run_start: 'orchestration start is never delegated',
  orchestration_gate_response: HOST_ACTION,
  orchestration_run_action: HOST_ACTION,
  orchestration_run_annotate: HOST_ACTION,
  scheduled_tasks_request: HOST_WIDE,
  scheduled_task_action: 'scheduled tasks are never delegated',
  set_scheduler_enabled: 'scheduled tasks are never delegated',
})

// -- Inbound: wire envelopes (contract §4.1.1) -------------------------------

/**
 * One CLOSED field set per allowed operation. A field outside the set, including
 * a `.passthrough()` extra, is refused `scope_denied` at dispatch. `leaseId` and
 * `gen` are the lease the mutation is made under. `values` pins a field to the
 * listed values (a principal answers a prompt with `deny` only in v1).
 * @type {Readonly<Record<string, { fields: readonly string[], values?: Readonly<Record<string, readonly unknown[]>> }>>}
 */
export const PRINCIPAL_ENVELOPES = Object.freeze({
  input: Object.freeze({
    fields: Object.freeze(['type', 'sessionId', 'clientMessageId', 'data', 'leaseId', 'gen']),
  }),
  interrupt: Object.freeze({
    fields: Object.freeze(['type', 'sessionId', 'requestId', 'leaseId', 'gen']),
  }),
  permission_response: Object.freeze({
    fields: Object.freeze(['type', 'sessionId', 'requestId', 'decision', 'leaseId', 'gen']),
    values: Object.freeze({ decision: Object.freeze(['deny']) }),
  }),
  destroy_session: Object.freeze({
    fields: Object.freeze(['type', 'sessionId', 'requestId', 'leaseId', 'gen']),
  }),
  // create_session is exempt from a session lease (no session exists yet).
  create_session: Object.freeze({
    fields: Object.freeze(['type', 'requestId', 'cwd', 'name', 'provider', 'model', 'permissionMode', 'worktree']),
  }),
})

// -- Predicates --------------------------------------------------------------

/**
 * Is this connection an agent principal? Fail-safe, the same shape as the
 * `== null` bound rule: anything that is not provably "no stamp" is a principal,
 * so a malformed stamp (`{}`, `false`, `0`) is a principal that is granted nothing.
 * @param {object|null|undefined} client
 * @returns {boolean}
 */
export function isPrincipalClient(client) {
  return client != null && client.principal != null
}

/**
 * The ONE selector both inbound sites call. A principal gets the principal
 * allowlist; every other client keeps the bound allowlist, unchanged. Never both.
 * @param {object|null|undefined} client
 * @returns {(ws: object, client: object, msg: object, ctx: object) => boolean}
 */
export function dispatchPolicyFor(client) {
  return isPrincipalClient(client) ? refusePrincipalMessage : refuseBoundMessage
}

// -- Inbound: refusal ---------------------------------------------------------

/** The one refusal text. It carries no detail beyond the code. */
export const PRINCIPAL_REFUSAL_MESSAGE = 'Not permitted for this credential'

/** The one refusal code. */
export const PRINCIPAL_REFUSAL_CODE = 'scope_denied'

const MAX_ECHOED_LENGTH = 128

/**
 * Send the one refusal reply. The reply names no session (the sentinel binding
 * and every other session id stay out of it) and echoes `requestType` and
 * `requestId` only when they are strings of at most MAX_ECHOED_LENGTH characters;
 * anything else is dropped, not truncated. Nothing from the payload is logged:
 * `reason` is one of this module's own fixed words and the type is rendered
 * through `loggableValue`.
 *
 * @param {object} ws
 * @param {object} client
 * @param {object} msg
 * @param {object} ctx
 * @param {string} reason  an internal reason word, logged but never sent
 */
export function sendPrincipalRefusal(ws, client, msg, ctx, reason) {
  const type = msg?.type
  log.info(`Principal client ${client?.id} refused message type ${loggableValue(type)} (${reason})`)
  ctx.transport.send(ws, {
    type: 'session_error',
    code: PRINCIPAL_REFUSAL_CODE,
    message: PRINCIPAL_REFUSAL_MESSAGE,
    ...(typeof type === 'string' && type.length <= MAX_ECHOED_LENGTH ? { requestType: type } : {}),
    ...(typeof msg?.requestId === 'string' && msg.requestId.length <= MAX_ECHOED_LENGTH ? { requestId: msg.requestId } : {}),
  })
}

/**
 * Why a principal may not send `msg`, or null when dispatch may proceed. Checked
 * in the order: transport exempt, allowlist, tier, envelope.
 * @param {object} client
 * @param {object} msg
 * @returns {string|null}
 */
export function principalDispatchRefusal(client, msg) {
  const type = msg?.type
  if (typeof type !== 'string') return 'type_not_allowed'
  if (PRINCIPAL_TRANSPORT_EXEMPT.includes(type)) return null
  if (!Object.hasOwn(PRINCIPAL_ALLOWED_MESSAGE_TYPES, type)) return 'type_not_allowed'
  const rank = TIER_RANK.get(client?.principal?.tier)
  const needed = TIER_RANK.get(PRINCIPAL_ALLOWED_MESSAGE_TYPES[type].tier)
  if (rank === undefined || needed === undefined || rank < needed) return 'tier'
  const envelope = PRINCIPAL_ENVELOPES[type]
  if (!envelope || msg === null || typeof msg !== 'object' || Array.isArray(msg)) return 'envelope'
  for (const key of Object.keys(msg)) {
    if (!envelope.fields.includes(key)) return 'envelope'
  }
  if (envelope.values) {
    for (const [field, allowed] of Object.entries(envelope.values)) {
      if (Object.hasOwn(msg, field) && !allowed.includes(msg[field])) return 'envelope'
    }
  }
  return null
}

/**
 * The single place the principal allowlist is applied to a principal's request.
 * Returns true when `msg` was refused (and replied to), false when the
 * connection may use it, and false for a client that is not a principal. A
 * missing or non-string `type` is refused.
 *
 * ws-server calls this before schema validation and `handleSessionMessage` calls
 * it again as the dispatch gate, both through `dispatchPolicyFor`.
 *
 * @param {object} ws
 * @param {object} client
 * @param {object} msg
 * @param {object} ctx
 * @returns {boolean}
 */
export function refusePrincipalMessage(ws, client, msg, ctx) {
  if (!isPrincipalClient(client)) return false
  const reason = principalDispatchRefusal(client, msg)
  if (reason === null) return false
  sendPrincipalRefusal(ws, client, msg, ctx, reason)
  return true
}

// -- Access: one helper for per-session authority ----------------------------

/**
 * @typedef {object} PrincipalPolicyOpts
 * @property {(sessionId: string) => string|null|undefined} [sessionCwd]
 *   resolves a session's cwd (the grant may be a cwd root)
 * @property {(sessionId: string) => boolean} [sessionExists]
 *   when given, a session that does not exist is never granted
 * @property {(client: object, sessionId: string) => ({ kind: string }|null|undefined)} [leaseFor]
 *   the lease this principal holds on a session; defaults to none (S8 supplies it)
 * @property {(path: string) => string} [realpath]  defaults to fs.realpathSync
 */

function underRoot(root, dir) {
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep)
}

function grantCovers(constraints, sessionId, opts) {
  if (constraints == null || typeof constraints !== 'object') return false
  const ids = constraints.sessionIds
  if (Array.isArray(ids) && ids.includes(sessionId)) return true
  const roots = constraints.cwdRoots
  if (!Array.isArray(roots) || roots.length === 0) return false
  const cwd = typeof opts.sessionCwd === 'function' ? opts.sessionCwd(sessionId) : null
  if (typeof cwd !== 'string' || cwd.length === 0) return false
  const realpath = opts.realpath ?? realpathSync
  let realCwd
  try {
    realCwd = realpath(cwd)
  } catch {
    return false
  }
  return roots.some((root) => {
    if (typeof root !== 'string' || root.length === 0) return false
    try {
      return underRoot(realpath(root), realCwd)
    } catch {
      return false
    }
  })
}

/**
 * May this principal act on `sessionId` with authority `need`?
 *
 *   1. grant: the session id is in `constraints.sessionIds`, or the session's cwd
 *      is under one of `constraints.cwdRoots` (either grants it). Nothing granted
 *      is nothing allowed.
 *   2. tier: observe < steer < drive < answer.
 *   3. lease: a mutation (steer and above) needs a lease from `opts.leaseFor`,
 *      which defaults to none, so no lease is `lease_required`. A steer need is
 *      met by a steer or drive lease; drive and answer need a drive lease.
 *
 * A session that is not granted and a session that does not exist return the SAME
 * `scope` reason, so a principal cannot probe which ids exist. It never reads the
 * sentinel binding.
 *
 * @param {object} client
 * @param {unknown} sessionId
 * @param {'observe'|'steer'|'drive'|'answer'} need
 * @param {PrincipalPolicyOpts} [opts]
 * @returns {{ ok: true } | { ok: false, reason: 'not_principal'|'scope'|'tier'|'lease_required' }}
 */
export function principalMaySee(client, sessionId, need, opts = {}) {
  if (!isPrincipalClient(client)) return { ok: false, reason: 'not_principal' }
  const needRank = TIER_RANK.get(need)
  if (needRank === undefined) return { ok: false, reason: 'tier' }
  if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false, reason: 'scope' }
  if (!grantCovers(client.principal.constraints, sessionId, opts)) return { ok: false, reason: 'scope' }
  if (typeof opts.sessionExists === 'function' && opts.sessionExists(sessionId) !== true) {
    return { ok: false, reason: 'scope' }
  }
  const rank = TIER_RANK.get(client.principal.tier)
  if (rank === undefined || rank < needRank) return { ok: false, reason: 'tier' }
  if (MUTATION_NEEDS.has(need)) {
    const lease = typeof opts.leaseFor === 'function' ? opts.leaseFor(client, sessionId) : null
    const kind = lease?.kind
    const held = need === 'steer' ? (kind === 'steer' || kind === 'drive') : kind === 'drive'
    if (!held) return { ok: false, reason: 'lease_required' }
  }
  return { ok: true }
}

/**
 * The policy inputs a handler can derive from its context. Session lookups go
 * through the session manager; the lease lookup is read from `ctx.services` when
 * the lease store exists (S8) and is otherwise none.
 * @param {object} ctx
 * @returns {PrincipalPolicyOpts}
 */
export function principalPolicyOptsFromCtx(ctx) {
  const manager = ctx?.sessions?.sessionManager
  const entryFor = (id) => (typeof manager?.getSession === 'function' ? manager.getSession(id) : null)
  const leases = ctx?.services?.principalLeases
  return {
    sessionCwd: (id) => {
      const entry = entryFor(id)
      return entry?.cwd ?? entry?.session?.cwd ?? null
    },
    sessionExists: (id) => entryFor(id) != null,
    leaseFor: typeof leases?.leaseFor === 'function' ? (c, id) => leases.leaseFor(c, id) : undefined,
  }
}

/**
 * The principal branch of a session-mutating handler. It resolves the target
 * through `principalMaySee` from an EXPLICIT `msg.sessionId` (no fallback to the
 * active session) and always replies `scope_denied`: until the child that owns the
 * operation lands (S8 lease, S9 delivery, S12 create, S13 interrupt, S15 answer)
 * there is nothing a principal may do here, so a granted, leased principal is
 * refused as well. A handler that calls this MUST return right after, so a
 * principal can never fall into the host path.
 *
 * @param {object} ws
 * @param {object} client
 * @param {object} msg
 * @param {object} ctx
 * @param {'steer'|'drive'|'answer'|null} need  null for create (no session yet)
 */
export function refusePrincipalHandler(ws, client, msg, ctx, need) {
  let reason = 'not_available'
  if (need !== null) {
    const verdict = principalMaySee(client, msg?.sessionId, need, principalPolicyOptsFromCtx(ctx))
    if (!verdict.ok) reason = verdict.reason
  }
  sendPrincipalRefusal(ws, client, msg, ctx, reason)
}

// -- Outbound ----------------------------------------------------------------

/**
 * Frames a principal may receive that carry no session, and the ONLY fields each
 * is delivered with. Everything else is dropped. Each entry is one a principal
 * plausibly needs today:
 *
 *   - pong: the keepalive answer to its own `ping`.
 *   - auth_ok: the handshake answer. Reduced to the protocol negotiation: no
 *     session list, no replay, no host fields (cwd, version, features, exposure,
 *     connected clients, billing).
 *   - session_error: the refusal reply (`scope_denied`) and any error about its
 *     own request. Free text is kept; binding fields (`boundSessionId`,
 *     `boundSessionName`) and `primaryClientId` are not in the whitelist.
 *   - server_error: a daemon fault notice. The free-text message can carry host
 *     detail, so only `category` and `recoverable` are kept.
 *   - rate_limited: the throttle notice, so a principal backs off.
 *   - input_ack: the acceptance acknowledgement for its own input (session
 *     tagged, so it also needs the session grant).
 *   - credential_invalidated: the revoke/expiry notice that tells it to stop.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const PRINCIPAL_OUTGOING_ALLOWED = Object.freeze({
  pong: Object.freeze(['type', 'serverTs']),
  auth_ok: Object.freeze(['type', 'clientId', 'encryption', 'protocolVersion', 'minProtocolVersion', 'maxProtocolVersion']),
  session_error: Object.freeze(['type', 'message', 'code', 'recoverable', 'reason', 'requestId', 'requestType', 'sessionId']),
  server_error: Object.freeze(['type', 'category', 'recoverable', 'sessionId']),
  rate_limited: Object.freeze(['type', 'retryAfterMs', 'message']),
  input_ack: Object.freeze([
    'type', 'sessionId', 'clientMessageId', 'status', 'delivery', 'retrySafe', 'acceptedAt',
    'retentionExpiresAt', 'dedupScope', 'reason', 'message', 'context',
  ]),
  credential_invalidated: Object.freeze(['type', 'reason']),
})

/**
 * The frame a principal should receive for `message`, or null when it must
 * receive nothing. DENY BY DEFAULT: a type that is not in
 * `PRINCIPAL_OUTGOING_ALLOWED` is never delivered, and a frame tagged with a
 * string `sessionId` is delivered only when `principalMaySee(..., 'observe')`
 * passes for it. The delivered frame is rebuilt from the type's field whitelist.
 * As a last line of defence a frame that contains the client's own binding value
 * is dropped, so the sentinel cannot reach the wire through a future field.
 *
 * @param {object} client
 * @param {object} message
 * @param {PrincipalPolicyOpts} [opts]
 * @returns {object|null}
 */
export function frameForPrincipal(client, message, opts = {}) {
  if (!isPrincipalClient(client)) return null
  const type = message?.type
  if (typeof type !== 'string' || !Object.hasOwn(PRINCIPAL_OUTGOING_ALLOWED, type)) return null
  if (typeof message.sessionId === 'string' && !principalMaySee(client, message.sessionId, 'observe', opts).ok) {
    return null
  }
  const frame = {}
  for (const field of PRINCIPAL_OUTGOING_ALLOWED[type]) {
    if (Object.hasOwn(message, field)) frame[field] = message[field]
  }
  const binding = client.boundSessionId
  if (typeof binding === 'string' && binding.length > 0 && JSON.stringify(frame).includes(binding)) return null
  return frame
}

// -- Never table (contract §4.3) ----------------------------------------------

/**
 * Each capability a principal never holds, as a machine-read table. Column (a) is
 * the dispatch allowlist (the type is absent from `PRINCIPAL_ALLOWED_MESSAGE_TYPES`).
 * Column (b) is `handlerPredicate`: the handler-level check that refuses a
 * principal on its own. The guard in tests/principal-policy.test.js reads THIS
 * constant, not the contract prose.
 *
 *   - `types`: the client message types the row covers (empty when no WebSocket
 *     type exists).
 *   - `sentinelDependent`: the predicate tests a truthy `boundSessionId` (or
 *     `isBoundClient`, which today reaches a principal only through the sentinel
 *     until the `principal != null` clause of S1 lands), so it refuses a principal
 *     ONLY because the sentinel is set. Removing the sentinel must turn it red.
 *   - `s2AddsRefusal`: the handler had no principal-relevant check; S2 adds an
 *     explicit `isPrincipalClient` refusal.
 *
 * @type {readonly Readonly<{ id: string, capability: string, types: readonly string[], handlerPredicate: string, sentinelDependent: boolean, s2AddsRefusal: boolean }>[]}
 */
export const PRINCIPAL_NEVER_CAPABILITIES = Object.freeze([
  { id: 'permission-mode', capability: 'auto / more-permissive mode, acceptEdits, skipPermissions', types: ['set_permission_mode'], handlerPredicate: 'handleSetPermissionMode resolves the session through resolveSession, which refuses a client bound to another id (the sentinel)', sentinelDependent: true, s2AddsRefusal: false },
  { id: 'permission-rules', capability: 'permission rules and allowAlways', types: ['set_permission_rules'], handlerPredicate: 'handleSetPermissionRules refuses isPrincipalClient(client) first (independent gate); isBoundClient(client) follows', sentinelDependent: false, s2AddsRefusal: true },
  { id: 'revoke-token', capability: 'revoke_token', types: ['revoke_token'], handlerPredicate: 'handleRevokeToken refuses client.isPrimaryToken !== true', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'pairing', capability: 'pairing (pair_approve, pair_deny), QR, /connect', types: ['pair_approve', 'pair_deny'], handlerPredicate: 'rejectIfBound refuses a truthy boundSessionId', sentinelDependent: true, s2AddsRefusal: false },
  { id: 'identity-rotation', capability: 'identity rotation', types: [], handlerPredicate: 'no WebSocket type exists; the CLI needs local primary authority', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'mcp-config', capability: 'MCP config', types: ['add_mcp_server', 'remove_mcp_server'], handlerPredicate: 'rejectMcpConfigWriteUnlessPrimary refuses client.isPrimaryToken !== true', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'skill-trust', capability: 'skill trust', types: ['skill_trust_accept', 'skill_trust_grant'], handlerPredicate: 'rejectSkillTrustIfBound refuses isPrincipalClient(client) first (independent gate); a truthy boundSessionId follows', sentinelDependent: false, s2AddsRefusal: true },
  { id: 'file-git-writes', capability: 'file and git writes', types: ['write_file', 'append_memory', 'git_stage', 'git_unstage', 'git_commit', 'git_create_pr'], handlerPredicate: 'rejectMutationIfBound refuses a truthy boundSessionId', sentinelDependent: true, s2AddsRefusal: false },
  { id: 'environment-create', capability: 'environments (create)', types: ['create_environment'], handlerPredicate: 'handleCreateEnvironment refuses client.isPrimaryToken !== true', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'environment-destroy', capability: 'environments (destroy)', types: ['destroy_environment'], handlerPredicate: 'handleDestroyEnvironment refuses isBoundClient(client)', sentinelDependent: true, s2AddsRefusal: false },
  { id: 'config-settings', capability: 'host-wide config and settings', types: ['session_preset_set'], handlerPredicate: 'handleSessionPresetSet opens with rejectIfNotHost, which refuses a truthy boundSessionId', sentinelDependent: true, s2AddsRefusal: false },
  { id: 'notification-prefs', capability: 'notification preferences', types: ['notification_prefs_set'], handlerPredicate: 'handleNotificationPrefsSet refuses isPrincipalClient(client) (it had no authority check)', sentinelDependent: false, s2AddsRefusal: true },
  { id: 'terminal-input', capability: 'user-shell, terminal_input, shell terminal_subscribe', types: ['terminal_input'], handlerPredicate: 'handleTerminalInput refuses isPrincipalClient(client) unconditionally (the user-shell check applies to user-shell sessions only)', sentinelDependent: false, s2AddsRefusal: true },
  { id: 'terminal-subscribe', capability: 'shell terminal_subscribe (and raw terminal output)', types: ['terminal_subscribe'], handlerPredicate: 'handleTerminalSubscribe returns when a bound client names another session (the sentinel); a user-shell session additionally needs client.isPrimaryToken === true', sentinelDependent: true, s2AddsRefusal: false },
  { id: 'dev-preview', capability: 'dev-preview publication', types: ['open_dev_preview'], handlerPredicate: 'DevPreviewManager._assertAuthority requires the primary-token client with no boundSessionId', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'archive', capability: 'archive purge and policy', types: ['delete_archived_session', 'set_session_archive_policy'], handlerPredicate: 'both handlers refuse isBoundClient(client)', sentinelDependent: true, s2AddsRefusal: false },
  { id: 'daemon-update', capability: 'daemon update and restart', types: ['daemon_update_action'], handlerPredicate: 'handleDaemonUpdateAction refuses isPrimaryToken !== true or a truthy boundSessionId', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'scheduled-tasks', capability: 'scheduled tasks', types: ['scheduled_task_action', 'set_scheduler_enabled'], handlerPredicate: 'rejectSchedulerWriteUnlessPrimary refuses a non-primary client or a truthy boundSessionId', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'orchestration-start', capability: 'orchestration start', types: ['orchestration_run_start'], handlerPredicate: 'guardAction refuses a truthy boundSessionId and, with requirePrimary, a non-primary client', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'checkpoint-restore', capability: 'checkpoint file restore', types: ['restore_checkpoint'], handlerPredicate: 'handleRestoreCheckpoint refuses isBoundClient(client)', sentinelDependent: true, s2AddsRefusal: false },
  { id: 'set-model', capability: 'set_model (v1)', types: ['set_model'], handlerPredicate: 'handleSetModel resolves the session through resolveSession, which refuses a client bound to another id (the sentinel)', sentinelDependent: true, s2AddsRefusal: false },
].map((row) => Object.freeze({ ...row, types: Object.freeze([...row.types]) })))
