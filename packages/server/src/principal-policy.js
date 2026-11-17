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
 * v1 allowlist: the five existing types, plus the `principal_*` types of the children that
 * have landed their handlers (S3: the journal read path). A new `principal_*` type is
 * listed here only together with its handler. `tier` is the lowest tier that may send the
 * type.
 * @type {Readonly<Record<string, { tier: string, reason: string }>>}
 */
export const PRINCIPAL_ALLOWED_MESSAGE_TYPES = Object.freeze({
  principal_subscribe: Object.freeze({
    tier: 'observe',
    reason: 'observe: a correlated subscribe to the normalized event journal; the handler resolves EVERY explicit session id through principalMaySee and refuses the whole request scope_denied when any one is not granted',
  }),
  principal_unsubscribe: Object.freeze({
    tier: 'observe',
    reason: 'observe: stops the caller\'s own journal subscriptions; it can name only its own, so it grants nothing and leaks nothing',
  }),
  principal_events_read: Object.freeze({
    tier: 'observe',
    reason: 'observe: a paged read of the normalized event journal (limit 200); the handler resolves the explicit session id through principalMaySee',
  }),
  principal_pending_permissions: Object.freeze({
    tier: 'observe',
    reason: 'observe: a read-only snapshot of the pending permission requests of the granted sessions (#9119); it grants no decision authority; the handler resolves EVERY explicit session id through principalMaySee and refuses the whole request scope_denied when any one is not granted',
  }),
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
  principal_admin_grant: CREDENTIAL,
  principal_admin_list: CREDENTIAL,
  principal_admin_revoke: CREDENTIAL,
  principal_admin_disable: CREDENTIAL,
  principal_admin_enable: CREDENTIAL,
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
  principal_subscribe: Object.freeze({
    fields: Object.freeze(['type', 'requestId', 'sessionIds', 'cursors']),
  }),
  principal_unsubscribe: Object.freeze({
    fields: Object.freeze(['type', 'requestId', 'sessionIds']),
  }),
  principal_events_read: Object.freeze({
    fields: Object.freeze(['type', 'requestId', 'sessionId', 'cursor', 'limit']),
  }),
  principal_pending_permissions: Object.freeze({
    fields: Object.freeze(['type', 'requestId', 'sessionIds']),
  }),
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
 *   - auth_ok: the handshake answer. Reduced to the protocol negotiation and
 *     the public key-exchange material (the client derives its key from it): no
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
  // The public handshake material of the eager key exchange stays: the client derives
  // the shared key FROM serverPublicKey, so stripping it leaves a principal that can
  // never decrypt the encrypted burst that follows auth_ok.
  auth_ok: Object.freeze([
    'type', 'clientId', 'encryption', 'protocolVersion', 'minProtocolVersion', 'maxProtocolVersion',
    'serverPublicKey', 'serverKeySig', 'newIdentityKey', 'rotationCert',
  ]),
  session_error: Object.freeze(['type', 'message', 'code', 'recoverable', 'reason', 'requestId', 'requestType', 'sessionId']),
  server_error: Object.freeze(['type', 'category', 'recoverable', 'sessionId']),
  rate_limited: Object.freeze(['type', 'retryAfterMs', 'message']),
  input_ack: Object.freeze([
    'type', 'sessionId', 'clientMessageId', 'status', 'delivery', 'retrySafe', 'acceptedAt',
    'retentionExpiresAt', 'dedupScope', 'reason', 'message', 'context',
  ]),
  credential_invalidated: Object.freeze(['type', 'reason']),
  // The journal read path (S3). Delivered by a dedicated per-subscription direct send
  // (principal-subscriptions.js), never by a broadcast, and each is re-checked against the
  // grant at send time. `principal_subscribed` has no top-level session: every session it
  // lists is checked (see `frameForPrincipal`).
  principal_subscribed: Object.freeze(['type', 'requestId', 'sessions']),
  principal_event: Object.freeze([
    'type', 'requestId', 'sessionId', 'journalId', 'journalSeq', 'ts', 'eventType', 'data', 'truncated', 'replay',
  ]),
  principal_live_fence: Object.freeze(['type', 'requestId', 'sessionId', 'journalId', 'journalSeq']),
  principal_gap: Object.freeze(['type', 'requestId', 'sessionId', 'journalId', 'reason', 'fromSeq', 'toSeq', 'ended']),
  principal_events_page: Object.freeze(['type', 'requestId', 'sessionId', 'journalId', 'events', 'headSeq', 'cursor', 'more', 'gap']),
  // The pending-permission snapshot (S4). A direct reply to `principal_pending_permissions`;
  // like `principal_subscribed` it has no top-level session: every request it lists is
  // checked against the grant and rebuilt from `PRINCIPAL_PENDING_PERMISSION_FIELDS`.
  principal_pending_permissions_result: Object.freeze(['type', 'requestId', 'generatedAt', 'permissions', 'truncated']),
})

/**
 * The only fields of one request in a `principal_pending_permissions_result`. There is no
 * `input` and no `toolInput`: a tool input never reaches a principal (contract sections 7.3
 * and 8). `description` is further limited to requests that are not floored.
 * @type {readonly string[]}
 */
export const PRINCIPAL_PENDING_PERMISSION_FIELDS = Object.freeze([
  'requestId', 'sessionId', 'tool', 'floored', 'explicitConsent', 'nonDelegable', 'origin', 'createdAt', 'expiresAt', 'description',
])

/**
 * Every other real server frame: a principal is never sent one on the direct-reply
 * path. Together with `PRINCIPAL_OUTGOING_ALLOWED` and `PRINCIPAL_TRANSPORT_FRAMES`
 * this classifies EVERY frame the daemon can emit (schema-backed and schema-less), so a
 * new frame cannot reach a principal without a decision. Delivery stays deny by default
 * either way; this roster exists so tests/principal-policy.test.js can be red when a
 * frame is added and nobody decided about it.
 * @type {readonly string[]}
 */
export const PRINCIPAL_OUTGOING_DENIED = Object.freeze([
  'activity_delta', 'activity_snapshot', 'agent_busy', 'agent_completed', 'agent_event', 'agent_idle',
  'agent_list', 'agent_spawned', 'append_memory_result', 'archived_session_history',
  'archived_sessions_list', 'auth_bootstrap', 'auth_fail', 'available_models',
  'available_permission_modes', 'background_work_changed', 'billing_canary', 'budget_exceeded',
  'budget_resume_ack', 'budget_resumed', 'budget_warning', 'byok_credentials_status',
  'byok_pool_action_ack', 'byok_pool_status_snapshot', 'cancel_activity_ack', 'checkpoint_created',
  'checkpoint_list', 'checkpoint_restored', 'chroxy_context_hint_changed', 'claude_ready',
  'client_focus_changed', 'client_joined', 'client_left', 'code_search_results', 'confirm_permission_mode',
  'containers_action_ack', 'containers_status_snapshot', 'conversation_id', 'conversations_list',
  'cost_summary', 'cost_update', 'credential_test_result', 'credentials_status',
  'daemon_update_action_result', 'daemon_update_confirm_required', 'daemon_update_status',
  'delete_archived_session_result', 'dev_preview', 'dev_preview_status', 'dev_preview_stopped',
  'diff_result', 'directory_listing', 'emulator_action_ack', 'emulator_status_snapshot',
  'environment_created', 'environment_destroyed', 'environment_error', 'environment_info',
  'environment_list', 'evaluate_draft_result', 'evaluator_clarify', 'evaluator_rewrite',
  'extension_message', 'external_sessions_snapshot', 'failed_restore_history', 'failed_restores_list',
  'file_content', 'file_list', 'file_listing', 'git_branches_result', 'git_commit_result', 'git_create_pr_result',
  'git_repo_check_result', 'git_stage_result', 'git_status_result', 'git_unstage_result',
  'github_webhook_config', 'history_replay_end', 'history_replay_start', 'host_prune_action_ack',
  'host_prune_status_snapshot', 'host_status_snapshot', 'inactivity_warning', 'integration_action_ack',
  'integration_status_snapshot', 'log_entry', 'mailbox_status_snapshot', 'mcp_servers',
  'memory_stack_result', 'message', 'message_dequeued', 'message_queued', 'model_changed',
  'monthly_budget', 'multi_question_intervention', 'notification_prefs', 'orchestration_action_ack',
  'orchestration_run_delta', 'orchestration_run_snapshot', 'orchestration_runs_snapshot', 'pair_fail',
  'pair_pending', 'pair_request_pending', 'pair_resolved', 'pair_result', 'pairing_refreshed',
  'permission_audit_result', 'permission_expired', 'permission_input', 'permission_mode_changed',
  'permission_outcome', 'permission_request', 'permission_resolved', 'permission_rules_updated',
  'plan_ready', 'plan_started', 'primary_changed', 'principal_admin_result', 'prompt_evaluator_changed',
  'prompt_evaluator_skip_pattern_changed', 'provider_list', 'provider_runtime_info', 'push_token_error',
  'references_result', 'repo_events_delta', 'repo_events_snapshot', 'repo_list',
  'repo_runtime_config_snapshot', 'restore_archived_session_result', 'result',
  'retry_failed_restore_result', 'runner_status_snapshot', 'scheduled_tasks', 'search_results',
  'server_mode', 'server_shutdown', 'server_status', 'session_activity', 'session_archive_policy_result',
  'session_context', 'session_cost_threshold_crossed', 'session_destroyed', 'session_list',
  'session_persist_failed', 'session_pr_status', 'session_pr_threads', 'session_preamble_changed',
  'session_preset_snapshot', 'session_restore_failed', 'session_role', 'session_status', 'session_stopped',
  'session_switched', 'session_timeout', 'session_updated', 'session_usage', 'session_warning',
  'shell_pending_approval', 'simulator_action_ack', 'simulator_status_snapshot', 'skill_activated',
  'skill_changed', 'skill_deactivated', 'skill_trust_accepted', 'skill_trust_grant_ok',
  'skill_trust_granted', 'skill_trust_request', 'skills_inventory_snapshot', 'skills_list',
  'slash_commands', 'status', 'statusline_output', 'stdin_dropped_totals', 'stream_delta', 'stream_end',
  'stream_start', 'subscriptions_updated', 'summarize_session_result', 'symbol_location',
  'symbols_snapshot', 'terminal_output', 'terminal_size', 'thinking_level_changed', 'token_rotated',
  'tool_input_delta', 'tool_result', 'tool_start', 'tunnel_url_changed', 'user_input', 'user_question',
  'web_feature_status', 'web_task_created', 'web_task_error', 'web_task_list', 'web_task_updated',
  'write_file_result', 'wsl_action_ack', 'wsl_status_snapshot',
])

/**
 * Frames sent to a principal by RAW socket writes that bypass `_send` on purpose (the
 * key exchange is plaintext and must keep its ordering, so it cannot use the queued or
 * encrypted sender). Each type lists the only fields it is sent with. `error` is limited
 * to the key-exchange codes, and `server_error` (whose whitelist lives in
 * `PRINCIPAL_OUTGOING_ALLOWED`) to the two fixed encryption messages.
 * @type {Readonly<Record<string, { fields: readonly string[], codes?: readonly string[] }>>}
 */
export const PRINCIPAL_TRANSPORT_FRAMES = Object.freeze({
  key_exchange_ok: Object.freeze({ fields: Object.freeze(['type', 'publicKey', 'serverKeySig', 'newIdentityKey', 'rotationCert']) }),
  error: Object.freeze({
    fields: Object.freeze(['type', 'code', 'message']),
    codes: Object.freeze(['KEY_EXCHANGE_SALT_REQUIRED', 'INVALID_MESSAGE']),
  }),
})

/** The fixed `server_error` texts the raw key-exchange sinks send. */
export const PRINCIPAL_TRANSPORT_SERVER_ERROR_MESSAGES = Object.freeze([
  'Encryption required but key exchange timed out. Please reconnect.',
  'Encryption required but client did not initiate key exchange.',
])

/**
 * The payload a RAW transport send should write for `client`: the frame unchanged for a
 * client that is not a principal (byte-identical), the whitelisted reduction for a
 * principal, and null when a principal may not be sent it (the caller writes nothing).
 * @param {object} client
 * @param {object} frame
 * @returns {object|null}
 */
export function principalTransportFrame(client, frame) {
  if (!isPrincipalClient(client)) return frame
  const type = frame?.type
  if (type === 'server_error') {
    if (!PRINCIPAL_TRANSPORT_SERVER_ERROR_MESSAGES.includes(frame.message)) return null
    return { type, message: frame.message, recoverable: frame.recoverable }
  }
  if (typeof type !== 'string' || !Object.hasOwn(PRINCIPAL_TRANSPORT_FRAMES, type)) return null
  const spec = PRINCIPAL_TRANSPORT_FRAMES[type]
  if (spec.codes && !spec.codes.includes(frame.code)) return null
  const out = {}
  for (const field of spec.fields) {
    if (Object.hasOwn(frame, field)) out[field] = frame[field]
  }
  return out
}

/**
 * Write a transport frame straight to a socket (plaintext, in order, no queue and no
 * encryption: the key exchange needs exactly that) through `principalTransportFrame`.
 * A client that is not a principal gets the frame unchanged. Throws what `ws.send` throws.
 */
export function sendRawTransport(ws, client, frame) {
  const out = principalTransportFrame(client, frame)
  if (out !== null) ws.send(JSON.stringify(out))
}

/**
 * Frames a principal may receive on the BROADCAST path (the broadcaster and the
 * session-broadcast paths), with the fields each is delivered with. EMPTY, and it stays
 * empty in S3: a principal receives no ordinary session broadcast of any type (contract
 * section 3.1 item 7). S3 chose the other of the two options its predecessor left open: the
 * `principal_event` family is delivered by a dedicated per-subscription DIRECT send
 * (principal-subscriptions.js) through `PRINCIPAL_OUTGOING_ALLOWED`, because the fence, the
 * held buffer and the release order are per-subscription state and because the broadcast
 * path would need the principal on the ClientManager session index, which S2 pinned shut.
 * The extension point and `frameForPrincipalBroadcast` remain, deny by default, for a
 * later child that needs a true broadcast; the grant check applies to every entry.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const PRINCIPAL_BROADCAST_ALLOWED = Object.freeze({})

// Frames `frameForPrincipalBroadcast` already vetted, mapped to the ONE client each was vetted
// for. The broadcaster hands them to `_send`, whose direct-reply allowlist would otherwise drop
// them. A vetted frame is frozen, is honoured only for its own recipient, and has its session
// re-checked against that recipient's grant at send time (a grant revoked in between wins).
const VETTED_BROADCAST = new WeakMap()

/**
 * The frame a principal should receive from a BROADCAST, or null. Separate from
 * `frameForPrincipal` (direct replies to the principal's own requests): the two
 * allowlists are distinct, so a direct-reply type such as `session_error` reaches a
 * principal only as a reply and never as a broadcast. A broadcast frame must be in
 * `opts.broadcastAllowed` (default `PRINCIPAL_BROADCAST_ALLOWED`), carry a string
 * `sessionId`, and pass `principalMaySee(..., 'observe')`.
 * @param {object} client
 * @param {object} message
 * @param {PrincipalPolicyOpts & { broadcastAllowed?: Readonly<Record<string, readonly string[]>> }} [opts]
 * @returns {object|null}
 */
export function frameForPrincipalBroadcast(client, message, opts = {}) {
  if (!isPrincipalClient(client)) return null
  const allowed = opts.broadcastAllowed ?? PRINCIPAL_BROADCAST_ALLOWED
  const type = message?.type
  if (typeof type !== 'string' || !Object.hasOwn(allowed, type)) return null
  if (typeof message.sessionId !== 'string' || !principalMaySee(client, message.sessionId, 'observe', opts).ok) return null
  const frame = {}
  for (const field of allowed[type]) {
    if (Object.hasOwn(message, field)) frame[field] = cloneField(message[field])
  }
  const binding = client.boundSessionId
  if (typeof binding === 'string' && binding.length > 0 && JSON.stringify(frame).includes(binding)) return null
  VETTED_BROADCAST.set(frame, client)
  return deepFreezeFrame(frame)
}

/** Freeze a vetted frame and every nested object in it: `Object.freeze` alone is shallow. */
function deepFreezeFrame(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreezeFrame(value[key])
  }
  return value
}

/** A frame field's value, deep-copied when it is an object or array. */
function cloneField(value) {
  return value !== null && typeof value === 'object' ? structuredClone(value) : value
}

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
  if (message !== null && typeof message === 'object' && VETTED_BROADCAST.has(message)) {
    const ok = VETTED_BROADCAST.get(message) === client && Object.isFrozen(message) &&
      typeof message.sessionId === 'string' && principalMaySee(client, message.sessionId, 'observe', opts).ok
    return ok ? message : null
  }
  const type = message?.type
  if (typeof type !== 'string' || !Object.hasOwn(PRINCIPAL_OUTGOING_ALLOWED, type)) return null
  // The ONE frame that is delivered for a session the principal can no longer see: the notice
  // that its own subscription ended because the grant was narrowed or the session was removed.
  // It names only the session id the principal itself subscribed to, and nothing else.
  const endNotice = type === 'principal_gap' && message.ended === true && (message.reason === 'scope' || message.reason === 'removed')
  if (!endNotice && typeof message.sessionId === 'string' && !principalMaySee(client, message.sessionId, 'observe', opts).ok) {
    return null
  }
  // `principal_subscribed` lists its sessions instead of carrying one: each must be granted.
  if (type === 'principal_subscribed') {
    const sessions = message.sessions
    if (sessions !== undefined && (!Array.isArray(sessions) || !sessions.every((s) => typeof s?.sessionId === 'string' && principalMaySee(client, s.sessionId, 'observe', opts).ok))) {
      return null
    }
  }
  // The snapshot lists requests instead of carrying one session: each must be granted, and
  // each is rebuilt from its own whitelist (no input, a description only when not floored).
  if (type === 'principal_pending_permissions_result') {
    const requests = message.permissions
    if (requests !== undefined && (!Array.isArray(requests) || !requests.every((r) => typeof r?.sessionId === 'string' && principalMaySee(client, r.sessionId, 'observe', opts).ok))) {
      return null
    }
    const rebuilt = {}
    for (const field of PRINCIPAL_OUTGOING_ALLOWED[type]) {
      if (field === 'permissions') {
        if (requests !== undefined) rebuilt.permissions = requests.map((r) => {
          const entry = {}
          for (const key of PRINCIPAL_PENDING_PERMISSION_FIELDS) {
            if (key === 'description' && r.floored !== false) continue
            if (Object.hasOwn(r, key)) entry[key] = cloneField(r[key])
          }
          return entry
        })
      } else if (Object.hasOwn(message, field)) {
        rebuilt[field] = cloneField(message[field])
      }
    }
    return withoutBindingValue(client, rebuilt)
  }
  const frame = {}
  for (const field of PRINCIPAL_OUTGOING_ALLOWED[type]) {
    // A nested value is copied, never shared: the delivered frame holds nothing the
    // journal (or any other owner) can still change or that could be changed through it.
    if (Object.hasOwn(message, field)) frame[field] = cloneField(message[field])
  }
  return withoutBindingValue(client, frame)
}

/** The frame, or null when it contains the client's own binding value (the sentinel must not reach the wire). */
function withoutBindingValue(client, frame) {
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
 *   - `sentinelDependent`: the predicate tests a truthy `boundSessionId` (not
 *     `isBoundClient`, which has refused a principal through its own `principal != null`
 *     clause since S1), so it refuses a principal ONLY because the sentinel is set.
 *     Removing the sentinel must turn it red.
 *   - `s2AddsRefusal`: the handler had no principal-relevant check; S2 adds an
 *     explicit `isPrincipalClient` refusal.
 *
 * @type {readonly Readonly<{ id: string, capability: string, types: readonly string[], handlerPredicate: string, sentinelDependent: boolean, s2AddsRefusal: boolean }>[]}
 */
export const PRINCIPAL_NEVER_CAPABILITIES = Object.freeze([
  { id: 'permission-mode', capability: 'auto / more-permissive mode, acceptEdits, skipPermissions', types: ['set_permission_mode'], handlerPredicate: 'handleSetPermissionMode resolves the session through resolveSession, which refuses isBoundClient(client) bound to another id; isBoundClient is true for a principal through the principal clause (S1), with or without the sentinel', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'permission-rules', capability: 'permission rules and allowAlways', types: ['set_permission_rules'], handlerPredicate: 'handleSetPermissionRules refuses isPrincipalClient(client) first (independent gate); isBoundClient(client) follows', sentinelDependent: false, s2AddsRefusal: true },
  { id: 'revoke-token', capability: 'revoke_token', types: ['revoke_token'], handlerPredicate: 'handleRevokeToken refuses client.isPrimaryToken !== true', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'pairing', capability: 'pairing (pair_approve, pair_deny), QR, /connect', types: ['pair_approve', 'pair_deny'], handlerPredicate: 'rejectIfBound refuses a truthy boundSessionId', sentinelDependent: true, s2AddsRefusal: false },
  { id: 'identity-rotation', capability: 'identity rotation', types: [], handlerPredicate: 'no WebSocket type exists; the CLI needs local primary authority', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'mcp-config', capability: 'MCP config', types: ['add_mcp_server', 'remove_mcp_server'], handlerPredicate: 'rejectMcpConfigWriteUnlessPrimary refuses client.isPrimaryToken !== true', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'skill-trust', capability: 'skill trust', types: ['skill_trust_accept', 'skill_trust_grant'], handlerPredicate: 'rejectSkillTrustIfBound refuses isPrincipalClient(client) first (independent gate); a truthy boundSessionId follows', sentinelDependent: false, s2AddsRefusal: true },
  { id: 'file-git-writes', capability: 'file and git writes', types: ['write_file', 'append_memory', 'git_stage', 'git_unstage', 'git_commit', 'git_create_pr'], handlerPredicate: 'rejectMutationIfBound refuses a truthy boundSessionId', sentinelDependent: true, s2AddsRefusal: false },
  { id: 'environment-create', capability: 'environments (create)', types: ['create_environment'], handlerPredicate: 'handleCreateEnvironment refuses client.isPrimaryToken !== true', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'environment-destroy', capability: 'environments (destroy)', types: ['destroy_environment'], handlerPredicate: 'handleDestroyEnvironment refuses isBoundClient(client), true for a principal through the principal clause (S1), with or without the sentinel', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'config-settings', capability: 'host-wide config and settings', types: ['session_preset_set'], handlerPredicate: 'handleSessionPresetSet opens with rejectIfNotHost, which refuses a truthy boundSessionId', sentinelDependent: true, s2AddsRefusal: false },
  { id: 'notification-prefs', capability: 'notification preferences', types: ['notification_prefs_set'], handlerPredicate: 'handleNotificationPrefsSet refuses isPrincipalClient(client) (it had no authority check)', sentinelDependent: false, s2AddsRefusal: true },
  { id: 'terminal-input', capability: 'user-shell, terminal_input, shell terminal_subscribe', types: ['terminal_input'], handlerPredicate: 'handleTerminalInput refuses isPrincipalClient(client) unconditionally (the user-shell check applies to user-shell sessions only)', sentinelDependent: false, s2AddsRefusal: true },
  { id: 'terminal-subscribe', capability: 'shell terminal_subscribe (and raw terminal output)', types: ['terminal_subscribe'], handlerPredicate: 'handleTerminalSubscribe returns when a bound client names another session (the sentinel); a user-shell session additionally needs client.isPrimaryToken === true', sentinelDependent: true, s2AddsRefusal: false },
  { id: 'dev-preview', capability: 'dev-preview publication', types: ['open_dev_preview'], handlerPredicate: 'DevPreviewManager._assertAuthority requires the primary-token client with no boundSessionId', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'archive', capability: 'archive purge and policy', types: ['delete_archived_session', 'set_session_archive_policy'], handlerPredicate: 'both handlers refuse isBoundClient(client), true for a principal through the principal clause (S1), with or without the sentinel', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'daemon-update', capability: 'daemon update and restart', types: ['daemon_update_action'], handlerPredicate: 'handleDaemonUpdateAction refuses isPrimaryToken !== true or a truthy boundSessionId', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'scheduled-tasks', capability: 'scheduled tasks', types: ['scheduled_task_action', 'set_scheduler_enabled'], handlerPredicate: 'rejectSchedulerWriteUnlessPrimary refuses a non-primary client or a truthy boundSessionId', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'orchestration-start', capability: 'orchestration start', types: ['orchestration_run_start'], handlerPredicate: 'guardAction refuses a truthy boundSessionId and, with requirePrimary, a non-primary client', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'checkpoint-restore', capability: 'checkpoint file restore', types: ['restore_checkpoint'], handlerPredicate: 'handleRestoreCheckpoint refuses isBoundClient(client), true for a principal through the principal clause (S1), with or without the sentinel', sentinelDependent: false, s2AddsRefusal: false },
  { id: 'set-model', capability: 'set_model (v1)', types: ['set_model'], handlerPredicate: 'handleSetModel resolves the session through resolveSession, which refuses isBoundClient(client) bound to another id; isBoundClient is true for a principal through the principal clause (S1), with or without the sentinel', sentinelDependent: false, s2AddsRefusal: false },
].map((row) => Object.freeze({ ...row, types: Object.freeze([...row.types]) })))
