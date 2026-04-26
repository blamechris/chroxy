import { createServer } from 'http'
import { randomBytes, randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { WebSocketServer } from 'ws'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { decrypt, DIRECTION_CLIENT } from '@chroxy/store-core/crypto'
import { safeTokenCompare } from './token-compare.js'
import { createClientSender } from './ws-client-sender.js'
import { ClientMessageSchema, EncryptedEnvelopeSchema } from './ws-schemas.js'
import { EventNormalizer } from './event-normalizer.js'
import { createFileOps } from './ws-file-ops/index.js'
import { createPermissionHandler } from './ws-permissions.js'
import { setupForwarding } from './ws-forwarding.js'
import { handleSessionMessage, handleCliMessage } from './ws-message-handlers.js'
import { handleAuthMessage, handlePairMessage, handleKeyExchange, BENIGN_PAIR_WINDOW_MS } from './ws-auth.js'
import { sendPostAuthInfo, replayHistory, flushPostAuthQueue, sendSessionInfo } from './ws-history.js'
import { createHttpHandler } from './http-routes.js'
import { CheckpointManager } from './checkpoint-manager.js'
import { DevPreviewManager } from './dev-preview.js'
import { WebTaskManager } from './web-task-manager.js'
import { RateLimiter, getClientIp, getRateLimitKey } from './rate-limiter.js'
import { createLogger, addLogListener, removeLogListener } from './logger.js'
import { PermissionAuditLog } from './permission-audit.js'
import { WsBroadcaster } from './ws-broadcaster.js'
import { WsClientManager } from './ws-client-manager.js'
import { getProviderDataDirs } from './providers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'))

export function sanitizeErrorMessage(err) {
  const safeMessages = {
    INVALID_MESSAGE: 'Message validation failed',
    SESSION_NOT_FOUND: 'Session not found',
    PERMISSION_DENIED: 'Permission denied',
  }
  if (err && err.code && safeMessages[err.code]) {
    return safeMessages[err.code]
  }
  return 'An internal error occurred'
}
const SERVER_VERSION = packageJson.version
const log = createLogger('ws')

/**
 * Protocol version — controls client/server compatibility negotiation.
 *
 * BUMP POLICY (Option B — breaking changes only):
 *
 *   - DO NOT bump for additive changes (new message types, new optional fields).
 *     Clients already ignore unknown message types with a console.warn when
 *     serverProtocolVersion > clientProtocolVersion.
 *
 *   - DO bump (increment by 1) for breaking changes:
 *       * Removing or renaming an existing message type
 *       * Changing the shape of an existing message (renaming/removing fields,
 *         changing field types, making optional fields required)
 *       * Changing auth handshake semantics
 *
 *   - When bumping, update PROTOCOL_CHANGELOG below and coordinate with
 *     CLIENT_PROTOCOL_VERSION in:
 *       * packages/app/src/store/message-handler.ts
 *       * packages/dashboard/src/store/message-handler.ts
 *
 *   - If a bump would break old clients, consider whether MIN_PROTOCOL_VERSION
 *     should also increase (rejecting clients that cannot speak the new protocol).
 *
 * See also: #1058 (enforce MIN_PROTOCOL_VERSION during auth)
 */
export const SERVER_PROTOCOL_VERSION = 2
/** Minimum protocol version this server can speak */
export const MIN_PROTOCOL_VERSION = 1
/**
 * Minimum protocol version for structured tunnel-warming/ready status
 * broadcasts (#2849). v1 clients don't know how to render the `phase`
 * field and would mis-render it as a chat message — they are simply
 * excluded from these broadcasts rather than served a phase-less
 * fallback (which would reintroduce the mis-render).
 */
export const TUNNEL_STATUS_MIN_PROTOCOL_VERSION = 2

/**
 * PROTOCOL_CHANGELOG
 *
 * v1 (initial) — baseline message set: auth, auth_ok, message, assistant,
 *   result, raw_output, model_changed, permission_request, tool_use, etc.
 *   All subsequent additive message types (e.g. plan_started, plan_ready,
 *   models_updated, client_focus_changed) do NOT bump the version per the
 *   breaking-changes-only policy above.
 *
 * v2 (#2849) — `server_status` gained a structured `phase` field
 *   ('tunnel_warming' | 'ready') that v1 dashboards don't know how to
 *   render (they only read `msg.message` and push the payload as a
 *   chat system message). The structured broadcasts are gated to
 *   clients that advertised v2+ at auth time; v1 clients no longer
 *   receive tunnel warming / ready status at all. Gating happens at
 *   the broadcast site in server-cli.js via
 *   WsServer.broadcastMinProtocolVersion (see
 *   TUNNEL_STATUS_MIN_PROTOCOL_VERSION).
 */

/** Cached latest version from npm registry (null if unavailable) */
let _latestVersionCache = { version: null, checkedAt: 0 }
const VERSION_CHECK_TTL = 3600_000 // 1 hour

async function checkLatestVersion(packageName) {
  const now = Date.now()
  if (_latestVersionCache.checkedAt > 0 && (now - _latestVersionCache.checkedAt) < VERSION_CHECK_TTL) {
    return _latestVersionCache.version
  }
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      })
      clearTimeout(timeout)
      if (res.ok) {
        const data = await res.json()
        if (data.version) {
          _latestVersionCache = { version: data.version, checkedAt: now }
          return data.version
        }
      }
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    // npm registry unreachable or package not published — expected
  }
  _latestVersionCache = { version: null, checkedAt: now }
  return null
}

function getGitInfo() {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
    return { commit, branch }
  } catch {
    return { commit: 'unknown', branch: 'unknown' }
  }
}

/**
 * Determine if request is served over HTTPS (tunnel or reverse proxy).
 */
function _isSecureRequest(req) {
  const proto = req.headers['x-forwarded-proto']
  return proto === 'https'
}

/**
 * WebSocket server that bridges the phone client to the backend.
 *
 * Supports two modes:
 *   - Multi-session (sessionManager): multiple concurrent CliSession instances
 *   - Single CLI (cliSession): headless `claude -p` with structured JSON (legacy)
 *
 * Protocol (JSON messages over WebSocket):
 *
 * Client -> Server:
 *   { type: 'auth',      token: '...', deviceInfo? }   — authenticate (deviceInfo: { deviceId, deviceName, deviceType, platform })
 *   { type: 'input',     data: '...' }               — send text to active session
 *   { type: 'interrupt' }                             — interrupt active session
 *   { type: 'set_model', model: '...' }              — change model on active session
 *   { type: 'set_permission_mode', mode: '...', confirmed? } — change permission mode (confirmed: true required for 'auto')
 *   { type: 'permission_response', requestId, decision } — respond to permission prompt
 *   { type: 'list_sessions' }                         — request session list
 *   { type: 'switch_session', sessionId }             — switch to a different session
 *   { type: 'create_session', name?, cwd?, provider? } — create a new session
 *   { type: 'destroy_session', sessionId }            — destroy a session
 *   { type: 'rename_session', sessionId, name }       — rename a session
 *   { type: 'register_push_token', token }             — register push token for notifications
 *   { type: 'user_question_response', answer }         — respond to AskUserQuestion prompt
 *   { type: 'list_directory', path? }                  — request directory listing for file browser
 *   { type: 'browse_files', path? }                   — request file/directory listing for file browser
 *   { type: 'read_file', path }                       — request file content for file viewer
 *   { type: 'write_file', path, content }              — write file content (path validated, 5MB limit)
 *   { type: 'list_slash_commands' }                     — request available slash commands
 *   { type: 'list_agents' }                             — request available custom agents
 *   { type: 'request_full_history', sessionId? }         — request full JSONL history for a session
 *   { type: 'key_exchange', publicKey }                  — client's ephemeral X25519 public key (E2E encryption)
 *   { type: 'create_checkpoint', name?, description? }  — create a checkpoint for active session
 *   { type: 'list_checkpoints' }                         — request checkpoint list for active session
 *   { type: 'restore_checkpoint', checkpointId }         — rewind to a checkpoint (creates new session)
 *   { type: 'delete_checkpoint', checkpointId }          — delete a checkpoint
 *   { type: 'close_dev_preview', port, sessionId? }     — close a dev server preview tunnel
 *   { type: 'launch_web_task', prompt, cwd? }           — launch a Claude Code Web cloud task
 *   { type: 'list_web_tasks' }                          — request list of web tasks
 *   { type: 'teleport_web_task', taskId }               — pull cloud task into local session
 *   { type: 'ping' }                                    — client heartbeat (server responds with pong)
 *   { type: 'add_repo', path }                          — add a repository path to workspace
 *   { type: 'cli', command }                            — send raw CLI command to active session
 *   { type: 'get_diff', path? }                         — request git diff for working directory
 *   { type: 'git_branches' }                            — request git branch list
 *   { type: 'git_commit', message, files? }             — commit staged/specified files
 *   { type: 'git_stage', files }                        — stage files for commit
 *   { type: 'git_status' }                              — request git status
 *   { type: 'git_unstage', files }                      — unstage files
 *   { type: 'list_conversations' }                      — request saved conversation list
 *   { type: 'list_files', path? }                       — request file listing for a path
 *   { type: 'list_providers' }                          — request available provider list
 *   { type: 'list_repos' }                              — request workspace repository list
 *   { type: 'list_skills' }                             — request active skills list
 *   { type: 'pair', pairingCode }                       — pair with another device via pairing code
 *   { type: 'query_permission_audit', last? }           — query permission audit log
 *   { type: 'remove_repo', path }                       — remove a repository path from workspace
 *   { type: 'request_cost_summary' }                    — request cost summary for current session
 *   { type: 'request_session_context', sessionId? }     — request session context (cwd, conversation, etc.)
 *   { type: 'resume_budget' }                           — resume after budget exceeded
 *   { type: 'resume_conversation', conversationId }     — resume a saved conversation
 *   { type: 'search_conversations', query }             — search saved conversations
 *   { type: 'subscribe_sessions' }                      — subscribe to session discovery events
 *   { type: 'unsubscribe_sessions' }                    — unsubscribe from session discovery
 *   { type: 'set_thinking_level', level }               — set thinking budget level ('default'|'high'|'max')
 *   { type: 'set_permission_rules', rules, sessionId }  — set per-session auto-approval rules
 *   { type: 'extension_message', ... }                  — opaque extension payload (passthrough, no server handling)
 *   { type: 'create_environment', name, cwd, image?, ... } — create persistent container environment
 *   { type: 'list_environments' }                       — list all persistent environments
 *   { type: 'destroy_environment', environmentId }      — destroy an environment and its container
 *   { type: 'get_environment', environmentId }          — get single environment details
 *
 * Server -> Client:
 *   All session-scoped messages include a `sessionId` field for background sync.
 *   { type: 'auth_ok', clientId, serverMode, serverVersion, latestVersion, serverCommit, cwd, defaultCwd, connectedClients, encryption } — auth succeeded (encryption: 'required'|'disabled')
 *   { type: 'key_exchange_ok', publicKey }               — server's ephemeral X25519 public key (E2E encryption)
 *   { type: 'auth_fail',    reason: '...' }           — auth failed
 *   { type: 'server_mode',  mode: 'cli' }             — which backend mode is active
 *   { type: 'message',      ... }                     — parsed chat message
 *   { type: 'stream_start', messageId: '...' }        — beginning of streaming response
 *   { type: 'stream_delta', messageId, delta }         — token-by-token text
 *   { type: 'stream_end',   messageId: '...' }        — streaming response complete
 *   { type: 'tool_start',   messageId, toolUseId, tool, input, serverName? } — tool invocation (serverName present for MCP tools)
 *   { type: 'tool_result',  toolUseId, result, truncated, images? }  — tool result (images: [{mediaType, data}])
 *   { type: 'mcp_servers',  servers: [{ name, status }] }     — connected MCP servers
 *   { type: 'result',       ... }                     — query stats
 *   { type: 'status',       connected: true }         — connection status
 *   { type: 'claude_ready' }                          — Claude Code ready for input
 *   { type: 'model_changed', model: '...' }          — active model updated
 *   { type: 'available_models', models: [...] }       — models the server accepts
 *   { type: 'permission_request', requestId, tool, description, input, remainingMs } — permission prompt
 *   { type: 'confirm_permission_mode', mode, warning } — server challenges auto mode (client must re-send with confirmed: true)
 *   { type: 'permission_mode_changed', mode: '...' } — permission mode updated
 *   { type: 'available_permission_modes', modes: [...] } — permission modes
 *   { type: 'session_list', sessions: [...] }         — all sessions
 *   { type: 'session_switched', sessionId, name, cwd, conversationId? } — switched active session
 *   { type: 'session_created', sessionId, name }      — new session created
 *   { type: 'session_destroyed', sessionId }          — session removed
 *   { type: 'session_restore_failed', sessionId, name, provider, errorCode, errorMessage, originalHistoryPreserved }
 *     — session in persisted state could not be restored (e.g. missing env var); history kept on disk for retry
 *   { type: 'session_error', message, category?, sessionId?, recoverable? } — session operation error
 *   { type: 'history_replay_start', sessionId, fullHistory?, truncated? } — beginning of history replay
 *   { type: 'history_replay_end', sessionId }         — end of history replay
 *   { type: 'conversation_id', sessionId, conversationId } — SDK conversation ID for session portability
 *   { type: 'user_question', toolUseId, questions }   — AskUserQuestion prompt from Claude
 *   { type: 'agent_busy' }                           — agent started processing (per-session)
 *   { type: 'agent_idle' }                           — agent finished processing (per-session)
 *   { type: 'plan_started' }                         — Claude entered plan mode (transient)
 *   { type: 'plan_ready', allowedPrompts }           — plan complete, awaiting approval (transient)
 *   { type: 'server_shutdown', reason, restartEtaMs } — server shutting down (reason: 'restart'|'shutdown')
 *   { type: 'server_status', message }               — non-error status update (e.g., recovery)
 *   { type: 'server_error', category, message, recoverable, sessionId? } — server-side error forwarded to app
 *   { type: 'directory_listing', path, parentPath, entries, error } — directory listing response for file browser
 *   { type: 'file_listing', path, parentPath, entries, error } — file browser listing response
 *   { type: 'file_content', path, content, language, size, truncated, error } — file content response
 *   { type: 'slash_commands', commands: [{ name, description, source }] } — available slash commands
 *   { type: 'agent_list', agents: [{ name, description, source }] } — available custom agents
 *   { type: 'client_joined', client: { clientId, deviceName, deviceType, platform } } — new client connected
 *   { type: 'client_left', clientId }                — client disconnected
 *   { type: 'client_focus_changed', clientId, sessionId, timestamp } — another client changed session focus
 *   { type: 'checkpoint_created', sessionId, checkpoint } — checkpoint created (auto or manual)
 *   { type: 'checkpoint_list', sessionId, checkpoints }   — list of checkpoints
 *   { type: 'checkpoint_restored', checkpointId, newSessionId, name } — checkpoint restored (new session created)
 *   { type: 'primary_changed', sessionId, clientId } — last-writer-wins primary changed (null on disconnect)
 *   { type: 'pong' }                                    — heartbeat response
 *   { type: 'permission_expired', requestId, sessionId, message }  — permission response could not be routed (expired/handled)
 *   { type: 'token_rotated', expiresAt }                — API token was rotated, client must re-authenticate
 *   { type: 'session_warning', sessionId, name, reason, message, remainingMs } — session about to timeout
 *   { type: 'session_timeout', sessionId, name, idleMs }         — session destroyed due to idle timeout
 *   { type: 'dev_preview', port, url, sessionId }       — dev server preview tunnel opened
 *   { type: 'dev_preview_stopped', port, sessionId }    — dev server preview tunnel closed
 *   { type: 'web_task_created', task }                  — cloud task launched
 *   { type: 'web_task_updated', task }                  — cloud task status changed
 *   { type: 'web_task_error', taskId?, message, code?, boundSessionId?, boundSessionName? } — cloud task error
 *                                                       (code may carry SESSION_TOKEN_MISMATCH or other web-task codes
 *                                                        e.g. WEB_TASK_PROMPT_TOO_LARGE; boundSessionId/boundSessionName
 *                                                        are populated on SESSION_TOKEN_MISMATCH only;
 *                                                        see docs/error-taxonomy.md)
 *   { type: 'web_task_list', tasks }                    — response to list_web_tasks
 *   { type: 'diff_result', diff, error? }              — git diff result
 *   { type: 'error', message }                          — general error message
 *   { type: 'file_list', path, files, error? }          — file listing response
 *   { type: 'git_branches_result', branches, current, error? } — git branches result
 *   { type: 'git_commit_result', success, hash?, error? }     — git commit result
 *   { type: 'git_stage_result', success, error? }       — git stage result
 *   { type: 'git_status_result', status, error? }       — git status result
 *   { type: 'git_unstage_result', success, error? }     — git unstage result
 *   { type: 'write_file_result', success, error? }      — write file result
 *   { type: 'log_entry', level, message, timestamp }    — server log entry for dashboard
 *   { type: 'session_activity', sessionId, isBusy, lastCost } — session busy/idle state change
 *   { type: 'session_context', sessionId, cwd, conversationId?, ... } — session context data
 *   { type: 'session_updated', sessionId, name }        — session metadata updated
 *   { type: 'discovered_sessions', sessions }           — discovered local Claude sessions
 *   { type: 'pair_fail', reason }                       — pairing failed
 *   { type: 'pairing_refreshed' }                       — pairing ID consumed; clients should re-fetch /qr (#2916)
 *   { type: 'rate_limited', message }                   — client rate-limited
 *   { type: 'agent_spawned', sessionId, agentId, parentToolId, model } — background agent spawned
 *   { type: 'agent_completed', sessionId, agentId, parentToolId }       — background agent completed
 *   { type: 'provider_list', providers }                — available providers
 *   { type: 'skills_list', skills }                     — active skills (name, description per entry)
 *   { type: 'push_token_error', message }               — push token registration error
 *   { type: 'cost_update', sessionId, cost }            — session cost update
 *   { type: 'budget_warning', sessionId, message, ... } — budget approaching limit
 *   { type: 'budget_exceeded', sessionId, message, ... } — budget exceeded
 *   { type: 'web_feature_status', features }            — web feature availability
 *   { type: 'permission_rules_updated', rules }         — per-session auto-approval rules changed
 *   { type: 'extension_message', ... }                  — opaque extension payload (passthrough, no server handling)
 *   { type: 'environment_created', environmentId, name, status } — environment created
 *   { type: 'environment_list', environments: [...] }   — list of all environments
 *   { type: 'environment_destroyed', environmentId }    — environment destroyed
 *   { type: 'environment_info', environment: {...} }    — single environment details
 *   { type: 'environment_error', error, environmentId? } — environment operation error
 *
 * Encrypted envelope (bidirectional, wraps any message above after key exchange):
 *   { type: 'encrypted', d: '<base64 ciphertext>', n: <nonce counter> }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Error response taxonomy (see docs/error-taxonomy.md for the full contract)
 * ─────────────────────────────────────────────────────────────────────────────
 * The server emits three distinct error message types. Clients must handle all
 * three, and handlers must pick the type that best matches the failure class.
 * Do NOT rename or remove these types — existing clients depend on them.
 *
 *   1. { type: 'error', code, message, requestId?, correlationId?, details? }
 *        Transport / protocol / validation errors. Client-caused.
 *        Emitted for: invalid JSON, schema validation failures, auth failures.
 *        Sent by: ws-auth.js, ws-server._handleMessage (schema path), handler-utils.sendError.
 *        Client behavior: surface message, do not retry automatically.
 *
 *   2. { type: 'server_error', message, recoverable, correlationId?, category?, sessionId? }
 *        Server-side handler failure or unhandled exception. Not the client's fault.
 *        Emitted for: unhandled errors in _handleMessage, ws-broadcaster failures,
 *        repo listing failures, encryption key-exchange timeouts.
 *        `recoverable: true`  — client may retry the request.
 *        `recoverable: false` — client should reconnect (fatal connection state).
 *        Sent by: ws-server._handleMessage (catch path), ws-history.js, ws-auth.js,
 *        ws-broadcaster.js, repo-handlers.js.
 *
 *   3. { type: 'session_error', message, sessionId?, code?, category?, recoverable? }
 *        Session-scoped operation error. Tied to a specific session or to the
 *        client's active session context (may be null when no session exists).
 *        Emitted for: session not found, session-token mismatch, input while paused,
 *        provider does not support feature, invalid session operation arguments,
 *        checkpoint/conversation/environment operation failures.
 *        Sent by: handlers/*-handlers.js via ctx.send.
 *        Client behavior: surface message, clear loading state for the session.
 *
 * Rule of thumb for handler authors:
 *   - The WS message was malformed or failed schema validation → `error`
 *   - The handler threw an unexpected exception → `server_error` (handled by outer catch)
 *   - A session operation failed in an expected, user-facing way → `session_error`
 */
export class WsServer {
  constructor({ port, apiToken, cliSession, sessionManager, defaultSessionId, authRequired = true, pushManager = null, maxPayload, noEncrypt, keyExchangeTimeoutMs, localhostBypass, tokenManager, pairingManager, maxPendingConnections, backpressureThreshold, environmentManager, config = null } = {}) {
    this.port = port
    this.apiToken = apiToken
    this._tokenManager = tokenManager || null
    this._pairingManager = pairingManager || null
    // Runtime config object — exposed to handler dispatch so validators
    // can read settings (e.g. workspaceRoots for cwd allowlist) at
    // message time. May be null in tests that don't pass it through.
    this.config = config || null
    this._maxPayload = maxPayload || 10 * 1024 * 1024 // default 10MB (supports image/doc attachments)
    this.authRequired = authRequired
    this._encryptionEnabled = !noEncrypt
    this._keyExchangeTimeoutMs = keyExchangeTimeoutMs ?? 10_000
    this._localhostBypass = localhostBypass ?? true
    this._maxPendingConnections = maxPendingConnections ?? 20
    this._backpressureThreshold = backpressureThreshold ?? 1024 * 1024 // 1MB default
    this._backpressureMaxDrops = 10 // close connection after this many consecutive drops
    this._rateLimiter = new RateLimiter()
    // Separate, relaxed limiter for permission/question responses (60 per minute, no burst)
    this._permissionRateLimiter = new RateLimiter({ windowMs: 60_000, maxMessages: 60, burst: 0 })
    this._clientSend = createClientSender(log)
    this._clientManager = new WsClientManager()
    this.clients = this._clientManager.clients // back-compat: expose the raw Map for context objects
    this.httpServer = null
    this.wss = null
    this._pingInterval = null
    this._pendingPermissions = new Map() // requestId -> { resolve, timer }
    this._permissionSessionMap = new Map() // requestId -> sessionId (for routing responses to correct session)
    this._hookSecrets = new Set() // per-session hook secrets registered by active CliSessions
    this._sessionHookSecrets = new Map() // sessionId -> hookSecret (for cleanup on session_destroyed)
    this._questionSessionMap = new Map() // toolUseId -> sessionId (for routing question responses)
    this._primaryClients = new Map() // sessionId -> clientId (last-writer-wins)
    // Late-binding wrappers: allows tests to monkey-patch _send/_broadcast
    const self = this
    const sendFn = (ws, msg) => self._send(ws, msg)
    this._broadcaster = new WsBroadcaster({
      clients: this.clients,
      sendFn,
      backpressureThreshold: this._backpressureThreshold,
      backpressureMaxDrops: this._backpressureMaxDrops,
    })
    const broadcastFn = (msg, filter) => self._broadcast(msg, filter)
    // Pass explicit workspace root so file ops resolve paths against the
    // session manager's default cwd instead of falling back to homedir.
    const workspaceRoot = sessionManager?.defaultCwd || process.cwd()
    this._fileOps = createFileOps(sendFn, workspaceRoot)
    this._permissions = createPermissionHandler({
      sendFn,
      broadcastFn,
      validateBearerAuth: (req, res) => self._validateBearerAuth(req, res),
      validateHookAuth: (req, res) => self._validateHookAuth(req, res),
      pushManager,
      pendingPermissions: this._pendingPermissions,
      permissionSessionMap: this._permissionSessionMap,
      getSessionManager: () => self.sessionManager,
      // Pass pairingManager so the HTTP /permission-response fallback can
      // enforce session binding — see 2026-04-11 audit blocker 5.
      pairingManager: this._pairingManager,
      // #2831: let the permission handler tell a CliSession that a hook
      // permission belonging to it is outstanding so the session's
      // 5-min inactivity timer can pause until the user responds.
      findSessionByHookSecret: (secret) => self._findSessionByHookSecret(secret),
    })
    // Handler context: late-bound via getters for test compat (tests may reassign properties)
    this._handlerCtx = {
      send: sendFn,
      broadcast: broadcastFn,
      broadcastToSession: (sid, msg, filter) => self._broadcastToSession(sid, msg, filter),
      broadcastSessionList: () => {
        const allSessions = self.sessionManager.listSessions()
        for (const [ws, c] of self.clients) {
          if (c.authenticated && ws.readyState === 1) {
            const sessions = c.boundSessionId
              ? allSessions.filter(s => s.sessionId === c.boundSessionId)
              : allSessions
            sendFn(ws, { type: 'session_list', sessions })
          }
        }
      },
      get sessionManager() { return self.sessionManager },
      get cliSession() { return self.cliSession },
      get pushManager() { return self.pushManager },
      get checkpointManager() { return self._checkpointManager },
      get devPreview() { return self._devPreview },
      get webTaskManager() { return self._webTaskManager },
      primaryClients: this._primaryClients,
      get clients() { return self.clients },
      permissionSessionMap: this._permissionSessionMap,
      questionSessionMap: this._questionSessionMap,
      pendingPermissions: this._pendingPermissions,
      fileOps: this._fileOps,
      permissions: this._permissions,
      get permissionAudit() { return self._permissionAudit },
      updatePrimary: (sid, cid) => self._updatePrimary(sid, cid),
      sendSessionInfo: (ws, sid) => self._sendSessionInfo(ws, sid),
      replayHistory: (ws, sid) => self._replayHistory(ws, sid),
      get draining() { return self._draining },
      get environmentManager() { return self.environmentManager },
      // Runtime config exposed to handlers so validators (e.g.
      // validateCwdAllowed) can consult workspaceRoots, feature flags,
      // etc. Late-bound so test harnesses that mutate this.config after
      // construction still see the updated value.
      get config() { return self.config },
      // Multi-provider data dirs (#2965): computed fresh each access so new
      // provider registrations are reflected without restarting the server.
      get projectsDirs() { return getProviderDataDirs().map(d => join(d, 'projects')) },
      get userAgentsDirs() { return getProviderDataDirs().map(d => join(d, 'agents')) },
    }

    // Context objects for extracted modules (ws-auth.js, ws-history.js)
    this._historyCtx = {
      get clients() { return self.clients },
      get sessionManager() { return self.sessionManager },
      get cliSession() { return self.cliSession },
      get defaultSessionId() { return self.defaultSessionId },
      get serverMode() { return self.serverMode },
      serverVersion: SERVER_VERSION,
      get latestVersion() { return self._latestVersion },
      get gitInfo() { return self._gitInfo },
      get encryptionEnabled() { return self._encryptionEnabled },
      get localhostBypass() { return self._localhostBypass },
      get keyExchangeTimeoutMs() { return self._keyExchangeTimeoutMs },
      protocolVersion: SERVER_PROTOCOL_VERSION,
      minProtocolVersion: MIN_PROTOCOL_VERSION,
      get webTaskManager() { return self._webTaskManager },
      send: sendFn,
      broadcast: broadcastFn,
      getConnectedClientList: () => self._getConnectedClientList(),
      get permissions() { return self._permissions },
    }
    this._authCtx = {
      get clients() { return self.clients },
      get authRequired() { return self.authRequired },
      isTokenValid: (token) => self._isTokenValid(token),
      get authFailures() { return self._authFailures },
      get benignPairAttempts() { return self._benignPairAttempts },
      get pairingManager() { return self._pairingManager },
      get activeSessionId() {
        // Provide the server's default/first session ID so pairing can bind
        // the issued token to the session that was active at pairing time.
        if (self.defaultSessionId) return self.defaultSessionId
        if (self.sessionManager) return self.sessionManager.firstSessionId || null
        return null
      },
      send: sendFn,
      onAuthSuccess: (ws, client) => {
        // If paired, include sessionToken in auth_ok response
        if (client._sessionToken) {
          self._sendPostAuthInfo(ws, { sessionToken: client._sessionToken })
          delete client._sessionToken
        } else {
          self._sendPostAuthInfo(ws)
        }
        self._broadcastClientJoined(client, ws)
      },
      minProtocolVersion: MIN_PROTOCOL_VERSION,
      serverProtocolVersion: SERVER_PROTOCOL_VERSION,
      flushPostAuthQueue: (ws, queue) => self._flushPostAuthQueue(ws, queue),
    }

    this.pushManager = pushManager

    // Permission audit trail
    this._permissionAudit = new PermissionAuditLog()

    // Auth rate limiting: track failed attempts per IP
    this._authFailures = new Map() // ip -> { count, firstFailure, blockedUntil }
    // Lenient pairing rate limiter (#3019) — caps already_used/expired hammering
    // without locking out users who legitimately rescan a stale QR a few times.
    // Strictly separate from _authFailures: a benign breach must NOT disable
    // genuine brute-force protection for the same IP.
    this._benignPairAttempts = new Map() // ip -> { count, windowStart, blockedUntil }
    this._authCleanupInterval = null

    // Multi-session support: prefer sessionManager, fall back to single cliSession
    this.sessionManager = sessionManager || null
    this.environmentManager = environmentManager || null
    this.defaultSessionId = defaultSessionId || null
    this._checkpointManager = new CheckpointManager()

    // Register/unregister per-session hook secrets and clean up checkpoints on lifecycle events.
    // Handlers are stored on `this` so close() can remove them — without this, a long-lived
    // SessionManager keeps every retired WsServer pinned in memory and replays events to
    // closed instances. Symmetric with _pairingRefreshedHandler / _tokenRotatedHandler.
    if (sessionManager && typeof sessionManager.on === 'function') {
      this._sessionCreatedHandler = ({ sessionId }) => {
        const entry = sessionManager.getSession(sessionId)
        const secret = entry?.session?._hookSecret
        if (secret) {
          this.registerHookSecret(secret)
          this._sessionHookSecrets.set(sessionId, secret)
          log.debug(`Registered hook secret for session ${sessionId}`)
        }
      }
      this._sessionDestroyedHandler = ({ sessionId }) => {
        // Look up the stored secret — the session is already removed from the map
        const secret = this._sessionHookSecrets.get(sessionId)
        if (secret) {
          this.unregisterHookSecret(secret)
          this._sessionHookSecrets.delete(sessionId)
          log.debug(`Unregistered hook secret for session ${sessionId}`)
        }
        try {
          this._checkpointManager.clearCheckpoints(sessionId)
        } catch (err) {
          log.warn(`Failed to clear checkpoints for destroyed session ${sessionId}: ${err.message}`)
        }
        for (const [key, sid] of this._permissionSessionMap) {
          if (sid === sessionId) this._permissionSessionMap.delete(key)
        }
        for (const [key, sid] of this._questionSessionMap) {
          if (sid === sessionId) this._questionSessionMap.delete(key)
        }
      }
      // #3057: audit auto-deny resolution paths (timeout / aborted / cleared).
      // The WS inline response path in settings-handlers.js audits user
      // resolutions with the responding client's id. Auto-deny paths have no
      // client — record them here with clientId null so forensic queries see
      // the full lifecycle of every permission request, not just the ones a
      // user touched. (HTTP user resolutions still aren't audited — pre-existing
      // gap tracked in #3059.)
      this._sessionEventAuditHandler = ({ sessionId, event, data }) => {
        if (event !== 'permission_resolved') return
        if (!data || data.reason === 'user') return
        this._permissionAudit.logDecision({
          clientId: null,
          sessionId,
          requestId: data.requestId,
          decision: data.decision,
          reason: data.reason,
        })
      }
      sessionManager.on('session_created', this._sessionCreatedHandler)
      sessionManager.on('session_destroyed', this._sessionDestroyedHandler)
      sessionManager.on('session_event', this._sessionEventAuditHandler)
    }

    // Dev server preview tunneling
    this._devPreview = new DevPreviewManager()

    // Web task manager (Claude Code Web cloud delegation)
    this._webTaskManager = new WebTaskManager({ cwd: sessionManager?.defaultCwd || process.cwd() })

    // Legacy single-session mode: wrap cliSession in a minimal shim
    if (!sessionManager && cliSession) {
      this.cliSession = cliSession
      // Register the hook secret immediately — no session_created event fires in legacy mode
      if (cliSession._hookSecret) {
        this.registerHookSecret(cliSession._hookSecret)
      }
    } else {
      this.cliSession = null
    }

    this.serverMode = 'cli'
    this._normalizer = new EventNormalizer()
    this._gitInfo = getGitInfo()
    this._startedAt = Date.now()
    this._draining = false
    this._latestVersion = null

    // Background version check (non-blocking, skipped in test/CI)
    if (process.env.NODE_ENV !== 'test') {
      checkLatestVersion(packageJson.name).then((v) => { this._latestVersion = v }).catch((err) => {
        log.warn(`Failed to check latest npm version: ${err.message} (non-critical, update check skipped)`)
      })
    }

    // Wire PairingManager refresh events — broadcast pairing_refreshed to all
    // authenticated dashboard clients so they can auto-refresh the QR code (#2916).
    this._pairingRefreshedHandler = null
    if (this._pairingManager) {
      this._pairingRefreshedHandler = () => {
        this._broadcast({ type: 'pairing_refreshed' })
        log.debug('Broadcasted pairing_refreshed to all clients')
      }
      this._pairingManager.on('pairing_refreshed', this._pairingRefreshedHandler)
    }

    // Wire TokenManager rotation events — broadcast new token to all clients
    this._tokenRotatedHandler = null
    if (this._tokenManager) {
      this._tokenRotatedHandler = ({ newToken, expiresAt }) => {
        // Update our reference so subsequent auth checks use the new token
        this.apiToken = newToken
        // Send the new token to encrypted clients (they need it for reconnection).
        // Unencrypted clients (e.g. localhost dashboard) get the event without the
        // raw token to avoid leaking credentials over plaintext connections.
        let encrypted = 0, unencrypted = 0
        for (const [ws, client] of this.clients) {
          if (!client.authenticated || ws.readyState !== 1) continue
          if (client.encryptionState) {
            this._send(ws, { type: 'token_rotated', token: newToken, expiresAt })
            encrypted++
          } else {
            this._send(ws, { type: 'token_rotated', expiresAt })
            unencrypted++
          }
        }
        log.info(`Broadcasted token_rotated to ${encrypted} encrypted + ${unencrypted} unencrypted clients`)
      }
      this._tokenManager.on('token_rotated', this._tokenRotatedHandler)
    }
  }

  /**
   * Check whether a token is valid. Delegates to TokenManager (supports
   * rotated + grace-period tokens) when available, otherwise falls back
   * to constant-time comparison against the static apiToken.
   */
  _isTokenValid(token) {
    if (!token) return false
    // Check session tokens issued via pairing
    if (this._pairingManager && this._pairingManager.isSessionTokenValid(token)) return true
    if (this._tokenManager) return this._tokenManager.validate(token)
    return safeTokenCompare(token, this.apiToken)
  }

  /**
   * Authenticate a dashboard HTTP request using cookie, bearer, or query token.
   * Returns true if auth passes (or auth is disabled). On failure or redirect,
   * writes the response and returns false (caller should stop processing).
   */
  _authenticateDashboardRequest(req, res, dashUrl, securityHeaders) {
    if (!this.authRequired) return true
    const bearerToken = (req.headers['authorization'] || '').startsWith('Bearer ')
      ? req.headers['authorization'].slice(7) : null
    const cookieToken = (req.headers['cookie'] || '').match(/(?:^|;\s*)chroxy_auth=([^;]*)/)
    let cookieVal = null
    if (cookieToken) {
      try { cookieVal = decodeURIComponent(cookieToken[1]) } catch { cookieVal = null }
    }
    const queryToken = dashUrl.searchParams.get('token')
    const token = queryToken || bearerToken || cookieVal
    if (!token || !this._isTokenValid(token)) {
      res.writeHead(403, { 'Content-Type': 'text/html', ...securityHeaders })
      res.end('<h1>403 Forbidden</h1><p>Invalid or missing token.</p>')
      return false
    }
    if (queryToken) {
      const encoded = encodeURIComponent(queryToken)
      // Set cookie for future requests, but DON'T redirect — serve content
      // directly. Tauri's WKWebView doesn't reliably send cookies on 302
      // redirects to 127.0.0.1 with SameSite=Strict.
      const securePart = _isSecureRequest(req) ? '; Secure' : ''
      res.setHeader('Set-Cookie', `chroxy_auth=${encoded}; Path=/dashboard; SameSite=Strict; HttpOnly${securePart}; Max-Age=86400`)
    }
    return true
  }

  /**
   * Validate Bearer token on an HTTP request. Returns true if auth passes
   * (or auth is disabled). On failure, writes a 403 response and returns false.
   */
  _validateBearerAuth(req, res) {
    if (!this.authRequired) return true
    const authHeader = req.headers['authorization'] || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token || !this._isTokenValid(token)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return false
    }
    return true
  }

  /**
   * Validate the per-session hook secret on a POST /permission request.
   * Only accepts secrets registered by active CliSessions — never the primary
   * API token. Falls back to bearer auth when no hook secrets are registered
   * (e.g. single-session legacy mode without hook secret support).
   */
  _validateHookAuth(req, res) {
    if (!this.authRequired) return true
    const authHeader = req.headers['authorization'] || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return false
    }
    if (this._hookSecrets.size > 0) {
      let valid = false
      for (const secret of this._hookSecrets) {
        if (safeTokenCompare(token, secret)) { valid = true; break }
      }
      if (!valid) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return false
      }
      return true
    }
    // No hook secrets registered — fall back to main token validation
    // (handles legacy single-session setups and tests that don't register secrets)
    if (!this._isTokenValid(token)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return false
    }
    return true
  }

  /**
   * Register a per-session hook secret so POST /permission accepts it.
   * Called by session-manager when a CliSession is created.
   */
  registerHookSecret(secret) {
    if (secret) this._hookSecrets.add(secret)
  }

  /**
   * Find the CliSession whose hookSecret matches `secret`. Returns
   * `{ session, sessionId }` (sessionId is the chroxy-managed key, not
   * the upstream Claude conversation id) or `null` if no match.
   *
   * The sessionId is needed by the permission handler so it can populate
   * `permissionSessionMap[requestId]` for legacy hook-based permissions
   * (#2832). Without that mapping, a paired client whose token is bound
   * to the same session can never approve hook permissions — the
   * binding check at `permission_response` time finds no entry and
   * rejects with SESSION_TOKEN_MISMATCH.
   */
  _findSessionByHookSecret(secret) {
    if (!secret) return null
    // Scan _sessionHookSecrets — Map<sessionId, secret>
    for (const [sessionId, storedSecret] of this._sessionHookSecrets) {
      if (storedSecret === secret) {
        const entry = this.sessionManager?.getSession(sessionId)
        return entry?.session ? { session: entry.session, sessionId } : null
      }
    }
    // Legacy single-session mode — no chroxy sessionId surface, so
    // callers can still notify the session but must skip mapping.
    if (this.cliSession && this.cliSession._hookSecret === secret) {
      return { session: this.cliSession, sessionId: null }
    }
    return null
  }

  /**
   * Remove a per-session hook secret when the session is destroyed.
   * Called by session-manager when a CliSession is destroyed.
   */
  unregisterHookSecret(secret) {
    if (secret) this._hookSecrets.delete(secret)
  }

  start(host) {
    // Create HTTP server — route handling extracted to http-routes.js
    this.httpServer = createServer(createHttpHandler(this))

    // WebSocket server in noServer mode — we handle the upgrade manually
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this._maxPayload,
      perMessageDeflate: {
        zlibDeflateOptions: { level: 6 },
        zlibInflateOptions: { chunkSize: 16 * 1024 },
        threshold: 1024,
        concurrencyLimit: 10,
      },
    })

    this.httpServer.on('upgrade', (req, socket, head) => {
      // Enforce pre-auth connection limit to prevent FD exhaustion
      const pendingCount = this._countPendingConnections()
      if (pendingCount >= this._maxPendingConnections) {
        log.warn(`Pre-auth connection limit reached (${pendingCount}/${this._maxPendingConnections}), rejecting upgrade`)
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req)
      })
    })

    this.wss.on('connection', (ws, req) => {
      const clientId = randomUUID().slice(0, 8)
      // Best-effort client IP for logging — prefers CF-Connecting-IP / X-Forwarded-For.
      const ip = getClientIp(req)
      // SECURITY: For localhost bypass decisions (e.g. skipping encryption),
      // use ONLY the raw TCP socket address. Proxy headers like x-forwarded-for
      // and cf-connecting-ip can be spoofed by an attacker to fake a localhost
      // origin and bypass encryption. req.socket.remoteAddress is set by the
      // kernel and cannot be forged over the network.
      const socketIp = req.socket.remoteAddress || 'unknown'
      // Rate-limit key: trusts proxy headers only when the TCP peer is loopback
      // (cloudflared or local proxy). Direct connections use socketIp to prevent
      // header spoofing that could exhaust another IP's rate-limit bucket.
      const rateLimitKey = getRateLimitKey(socketIp, req)
      this._clientManager.addClient(ws, {
        id: clientId,
        authenticated: false,
        mode: 'chat', // default to chat view
        activeSessionId: null,
        subscribedSessionIds: new Set(),
        isAlive: true,
        deviceInfo: null,
        ip,
        socketIp,
        rateLimitKey,
        _seq: 0,                  // monotonic sequence number for outbound messages
        encryptionState: null,    // { sharedKey, sendNonce, recvNonce } when active
        encryptionPending: false, // true while waiting for key_exchange
        postAuthQueue: null,      // queued messages during key exchange
        _flushing: false,         // gates _send during setImmediate gaps in post-auth flush
        _flushOverflow: null,     // messages that arrived during flush
      })

      // Track pong responses for keepalive detection
      ws.on('pong', () => {
        const client = this.clients.get(ws)
        if (client) client.isAlive = true
      })

      log.info(`Client ${clientId} connected (awaiting auth)`)

      // When auth is disabled, auto-authenticate immediately
      if (!this.authRequired) {
        const client = this.clients.get(ws)
        client.authenticated = true
        client.authTime = Date.now()
        // --no-auth is dev-only and trusts itself — pin to the server's own
        // protocol version so version-gated broadcasts (e.g. #2849 tunnel
        // warming / ready via broadcastMinProtocolVersion) reach dev clients
        // instead of being silently filtered out.
        //
        // Assumption: a client connecting to a --no-auth dev server is built
        // from the same checkout as the server and therefore speaks
        // SERVER_PROTOCOL_VERSION (loopback bind enforces this in practice).
        // Stale-build clients on a newer --no-auth server may receive v2-shape
        // messages they can't parse — acceptable for dev, revisit if --no-auth
        // ever broadens beyond loopback. See packages/server/CONFIG.md#--no-auth-trust-model.
        client.protocolVersion = SERVER_PROTOCOL_VERSION
        this._sendPostAuthInfo(ws)
        this._broadcastClientJoined(client, ws)
        log.info(`Client ${clientId} auto-authenticated (--no-auth)`)
      }

      // Auto-disconnect if not authenticated within 10s (skip when auth is disabled)
      const authTimeout = this.authRequired
        ? setTimeout(() => {
            const client = this.clients.get(ws)
            if (client && !client.authenticated) {
              this._send(ws, { type: 'auth_fail', reason: 'timeout' })
              ws.close()
            }
          }, 10_000)
        : null

      ws.on('message', (raw) => {
        let msg
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return // ignore non-JSON
        }
        // Reject non-object top-level JSON up front. JSON.parse accepts
        // JSON "value" grammar, so `null`, `"string"`, `42`, `[]`, `true`
        // are all valid parses but none carry a `.type` field. Without
        // this guard, the downgrade check below would throw TypeError on
        // `null.type` and (worse) could be bypassed by a client sending
        // JSON `null` as a post-handshake plaintext frame — the
        // type-check would throw, control would escape to the outer
        // error handler, and _handleMessage would be called on the null.
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
          return // ignore non-object payloads
        }
        // Decrypt incoming encrypted messages, and enforce encryption once
        // a key exchange has established it. Without this post-handshake
        // rejection, a buggy or malicious client could unilaterally downgrade
        // to plaintext after a successful key_exchange — the server would
        // happily process the plaintext frame as a normal message. Discovered
        // in the 2026-04-11 production readiness audit.
        //
        // On a downgrade attempt, we log server-side (diagnostics for the
        // operator) and close silently with 1008 + a policy-violation reason
        // in the WebSocket close frame. We deliberately do NOT send a
        // plaintext error envelope back — doing so would itself leak a
        // plaintext frame after a successful handshake, contradicting the
        // very invariant this check exists to enforce. The WebSocket close
        // reason string ('encryption required') is diagnostic enough for a
        // legitimate misconfigured client.
        const client = this.clients.get(ws)
        if (client?.encryptionState) {
          if (msg.type !== 'encrypted') {
            log.error(`Plaintext frame from ${client.id} after encryption established (type=${msg?.type}); closing connection`)
            ws.close(1008, 'encryption required')
            return
          }
          const envParsed = EncryptedEnvelopeSchema.safeParse(msg)
          if (!envParsed.success) {
            log.error(`Invalid encrypted message envelope from ${client.id}`)
            ws.close()
            return
          }
          try {
            msg = decrypt(msg, client.encryptionState.sharedKey, client.encryptionState.recvNonce, DIRECTION_CLIENT)
            client.encryptionState.recvNonce++
          } catch (err) {
            log.error(`Decryption failed from ${client.id}: ${err.message}`)
            ws.close()
            return
          }
        }
        this._handleMessage(ws, msg).catch((err) => {
          log.error(`Unhandled error in message handler: ${err.message}`)
          if (err.stack) log.error(err.stack)
          try {
            this._send(ws, { type: 'server_error', message: sanitizeErrorMessage(err), recoverable: true })
          } catch {
            // Best-effort — client may already be disconnected
          }
        })
      })

      ws.on('close', () => {
        clearTimeout(authTimeout)
        const client = this._clientManager.getClient(ws)
        if (client?._keyExchangeTimeout) clearTimeout(client._keyExchangeTimeout)
        log.info(`Client ${client?.id} disconnected`)
        if (client?.authenticated) {
          this._handleClientDeparture(client)
        }
        // Do not remove rate limiter entries on disconnect — the limiter keys by IP,
        // so removing on disconnect would reset the shared bucket for all connections
        // from the same real IP. The sliding window's natural expiry cleans up entries.
        this._clientManager.removeClient(ws)
      })

      ws.on('error', (err) => {
        log.error(`Client error: ${err.message}`)
      })
    })

    this.wss.on('error', (err) => {
      log.error(`WebSocket server error: ${err.message}`)
    })

    this.httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`Port ${this.port} is already in use — is another Chroxy instance running?`)
        process.exit(1)
      }
      log.error(`HTTP server error: ${err.message}`)
    })

    this.httpServer.listen(this.port, host)

    // Detect Claude Code Web features (non-blocking)
    this._webTaskManager.detectFeatures().then(({ remote, teleport }) => {
      if (remote || teleport) {
        log.info(`Claude Code Web features detected: remote=${remote}, teleport=${teleport}`)
      }
    }).catch((err) => {
      log.warn(`Failed to detect Claude Code Web features: ${err.message} (non-critical, web features disabled)`)
    })

    // Forward web task events to all authenticated clients
    this._webTaskManager.on('task_created', (task) => this._broadcast({ type: 'web_task_created', task }))
    this._webTaskManager.on('task_updated', (task) => this._broadcast({ type: 'web_task_updated', task }))
    this._webTaskManager.on('task_error', ({ taskId, message }) => this._broadcast({ type: 'web_task_error', taskId, message }))

    // Broadcast structured log entries to dashboard clients.
    // Re-entrancy guard prevents infinite recursion when _broadcast() itself
    // logs (e.g. backpressure debug messages) and log level is set to debug.
    let inLogBroadcast = false
    this._logListener = (entry) => {
      if (inLogBroadcast) return
      inLogBroadcast = true
      try {
        if (entry.sessionId) {
          this._broadcastToSession(entry.sessionId, { type: 'log_entry', ...entry })
        } else {
          this._broadcast({ type: 'log_entry', ...entry })
        }
      } finally {
        inLogBroadcast = false
      }
    }
    addLogListener(this._logListener)

    // Wire up unified event forwarding via EventNormalizer
    setupForwarding({
      normalizer: this._normalizer,
      sessionManager: this.sessionManager,
      cliSession: this.cliSession,
      devPreview: this._devPreview,
      pushManager: this.pushManager,
      permissionSessionMap: this._permissionSessionMap,
      questionSessionMap: this._questionSessionMap,
      broadcast: (msg, filter) => this._broadcast(msg, filter),
      broadcastToSession: (sid, msg, filter) => this._broadcastToSession(sid, msg, filter),
      broadcastSessionList: () => this._handlerCtx.broadcastSessionList(),
    })

    // Ping all authenticated clients every 30s to keep connections alive through
    // Cloudflare/mobile OS idle timeouts. Terminate unresponsive clients.
    this._pingInterval = setInterval(() => {
      for (const [ws, client] of this.clients) {
        if (!client.authenticated) continue
        if (ws.readyState !== 1) continue
        if (!client.isAlive) {
          log.info(`Client ${client.id} unresponsive, terminating`)
          this._handleClientDeparture(client)
          this._clientManager.removeClient(ws)
          try { ws.terminate() } catch {}
          continue
        }
        client.isAlive = false
        try { ws.ping() } catch {}
      }
    }, 30_000)

    // Prune stale auth failure entries every 60s
    this._authCleanupInterval = setInterval(() => {
      const now = Date.now()
      const cutoff = now - 5 * 60 * 1000
      for (const [ip, entry] of this._authFailures) {
        if (entry.firstFailure < cutoff) {
          this._authFailures.delete(ip)
        }
      }
      // Lenient bucket entries are short-lived (60s window + 30s block); drop
      // any whose window is fully expired and that aren't currently blocked.
      for (const [ip, entry] of this._benignPairAttempts) {
        const windowExpired = now - entry.windowStart > BENIGN_PAIR_WINDOW_MS
        const notBlocked = entry.blockedUntil <= now
        if (windowExpired && notBlocked) {
          this._benignPairAttempts.delete(ip)
        }
      }
    }, 60_000)

    log.info(`Server listening on ${host || '0.0.0.0'}:${this.port} (${this.serverMode} mode)`)
  }

  /** Delegates to ws-history.js */
  _sendPostAuthInfo(ws, extra) { sendPostAuthInfo(this._historyCtx, ws, extra) }
  _replayHistory(ws, sessionId) { replayHistory(this._historyCtx, ws, sessionId) }
  _flushPostAuthQueue(ws, queue) { flushPostAuthQueue(this._historyCtx, ws, queue) }
  _sendSessionInfo(ws, sessionId) { sendSessionInfo(this._historyCtx, ws, sessionId) }

  /** Route incoming client messages */
  async _handleMessage(ws, msg) {
    const client = this.clients.get(ws)
    if (!client) return

    // Generate a correlation ID for tracing this message through the pipeline
    const correlationId = randomBytes(4).toString('hex')

    // Auth handling (delegates to ws-auth.js)
    if (!client.authenticated) {
      if (msg.type === 'pair') {
        handlePairMessage(this._authCtx, ws, msg)
      } else {
        handleAuthMessage(this._authCtx, ws, msg)
      }
      return
    }
    if (msg.type === 'auth') return

    // Key exchange for E2E encryption (delegates to ws-auth.js)
    if (handleKeyExchange(this._authCtx, ws, msg)) return

    // Respond to client-side heartbeat pings immediately (even during drain)
    if (msg.type === 'ping') {
      this._send(ws, { type: 'pong' })
      return
    }

    // Rate limiting — permission/question responses use a relaxed separate limiter (60/min).
    // client.rateLimitKey is the trusted rate-limit identity: CF-Connecting-IP when the
    // connection arrived via the loopback (cloudflared), otherwise the raw socket address.
    if (msg.type === 'permission_response' || msg.type === 'user_question_response') {
      const { allowed, retryAfterMs } = this._permissionRateLimiter.check(client.rateLimitKey)
      if (!allowed) {
        const label = msg.type === 'user_question_response' ? 'question responses' : 'permission responses'
        this._send(ws, { type: 'rate_limited', retryAfterMs, message: `Too many ${label}. Please slow down.` })
        return
      }
    } else {
      const { allowed, retryAfterMs } = this._rateLimiter.check(client.rateLimitKey)
      if (!allowed) {
        this._send(ws, { type: 'rate_limited', retryAfterMs, message: 'Too many messages. Please slow down.' })
        return
      }
    }

    // During drain, only allow permission_response and user_question_response
    if (this._draining && msg.type !== 'permission_response' && msg.type !== 'user_question_response') {
      if (msg.type === 'input') {
        this._send(ws, { type: 'server_status', message: 'Server is restarting, please wait...' })
      }
      return
    }

    // Validate message schema before routing
    const parsed = ClientMessageSchema.safeParse(msg)
    if (!parsed.success) {
      const details = parsed.error.issues.map(i => i.message).join(', ')
      log.warn(`[${correlationId}] Invalid message from ${client.id}: ${details}`)
      this._send(ws, { type: 'error', code: 'INVALID_MESSAGE', correlationId, details })
      return
    }
    const validatedMsg = parsed.data

    log.debug(`[${correlationId}] Handling ${validatedMsg.type} from ${client.id}`)

    // Route based on server mode — pass correlationId in context
    const ctx = { ...this._handlerCtx, correlationId }
    try {
      if (this.sessionManager) {
        await handleSessionMessage(ws, client, validatedMsg, ctx)
      } else if (this.cliSession) {
        await handleCliMessage(ws, client, validatedMsg, ctx)
      }
    } catch (err) {
      log.error(`[${correlationId}] Handler error for ${validatedMsg.type}: ${err.message}`)
      this._send(ws, { type: 'server_error', correlationId, message: err.message, recoverable: true })
    }
  }

  /** Delegate: re-send pending permissions (test compat) */
  _resendPendingPermissions(ws) {
    const client = this.clients.get(ws)
    this._permissions.resendPendingPermissions(ws, client)
  }

  /** Public broadcast: send a message to all authenticated clients */
  broadcast(message) {
    this._broadcaster.broadcast(message)
  }

  /**
   * Broadcast a message only to authenticated clients that advertised at
   * least `minProtocolVersion` during auth. See WsBroadcaster for details.
   */
  broadcastMinProtocolVersion(minProtocolVersion, message) {
    this._broadcaster.broadcastMinProtocolVersion(minProtocolVersion, message)
  }

  /** Broadcast a message to all authenticated clients matching a filter */
  _broadcast(message, filter) {
    this._broadcaster._broadcast(message, filter)
  }

  /**
   * Broadcast a session-scoped message to clients viewing that session.
   * Tags the message with `sessionId` so clients can route it to the correct
   * session state. By default only delivers to clients whose activeSessionId
   * matches — prevents cross-session info leakage and bandwidth waste.
   * Pass a custom filter to override the default recipient selection when needed.
   */
  _broadcastToSession(sessionId, message, filter) {
    this._broadcaster._broadcastToSession(sessionId, message, filter)
  }

  /** Count unauthenticated connections for pre-auth limit enforcement */
  _countPendingConnections() {
    return this._clientManager.countPending()
  }

  /** Get list of connected clients for auth_ok payload */
  _getConnectedClientList() {
    return this._clientManager.getConnectedList()
  }

  /** Broadcast client_joined to all OTHER authenticated clients */
  _broadcastClientJoined(newClient, excludeWs) {
    this._broadcaster._broadcastClientJoined(newClient, excludeWs)
  }

  /** Handle cleanup when an authenticated client disconnects or is terminated */
  _handleClientDeparture(departingClient) {
    // Clear primary for any sessions this client was primary on
    for (const [sessionId, primaryClientId] of this._primaryClients) {
      if (primaryClientId === departingClient.id) {
        this._primaryClients.delete(sessionId)
        this._broadcastToSession(sessionId, {
          type: 'primary_changed',
          sessionId,
          clientId: null,
        })
      }
    }

    // Release this client's ownership of any push tokens it registered.
    // Uses ref-counted release so a token registered by multiple
    // concurrent connections (multi-device or reconnect-race) isn't
    // stripped from the registry until the last owner goes away.
    //
    // Prevents the long-lived-token-hijack pattern documented in the
    // 2026-04-11 audit (blocker 6): an attacker who authenticates,
    // registers their own ExponentPushToken, and disconnects would
    // otherwise keep receiving future permission prompts indefinitely.
    // Tokens are preserved across disconnect only if the client re-
    // registers them on reconnect, or if another active client still
    // owns them.
    if (departingClient._ownedPushTokens && this.pushManager) {
      for (const token of departingClient._ownedPushTokens) {
        this.pushManager.releaseTokenOwner(token, departingClient.id)
      }
      departingClient._ownedPushTokens.clear()
    }

    // Broadcast client_left to remaining authenticated clients
    const message = { type: 'client_left', clientId: departingClient.id }
    for (const [ws, client] of this.clients) {
      if (client.id !== departingClient.id && client.authenticated && ws.readyState === 1) {
        this._send(ws, message)
      }
    }
  }

  /** Update primary client for a session (last-writer-wins) */
  _updatePrimary(sessionId, clientId) {
    if (!sessionId) return
    const current = this._primaryClients.get(sessionId)
    if (current === clientId) return // already primary
    this._primaryClients.set(sessionId, clientId)
    this._broadcastToSession(sessionId, {
      type: 'primary_changed',
      sessionId,
      clientId,
    })
  }

  /**
   * Broadcast a server-side error to all authenticated clients.
   * @param {'tunnel'|'session'|'permission'|'general'} category
   * @param {string} message - Human-readable error description
   * @param {boolean} recoverable - true for warnings, false for fatal errors
   * @param {string|null} [sessionId] - Optional session ID for scoped errors
   */
  broadcastError(category, message, recoverable = true, sessionId = null) {
    this._broadcaster.broadcastError(category, message, recoverable, sessionId)
  }

  /**
   * Broadcast a server status update to all authenticated clients.
   * Used for non-error status updates like recovery notifications.
   * @param {string} message - Human-readable status message
   */
  broadcastStatus(message) {
    this._broadcaster.broadcastStatus(message)
  }

  /**
   * Broadcast a shutdown notification to all authenticated clients.
   * Sent before the server goes down so the app can show reason + ETA.
   *
   * Note: This is a global broadcast (not per-session), so server_shutdown
   * is intentionally not listed in TRANSIENT_EVENTS in session-manager.js.
   *
   * @param {'restart'|'shutdown'|'crash'} reason - Why the server is going down
   * @param {number} restartEtaMs - Estimated ms until server is back (0 = not coming back)
   */
  broadcastShutdown(reason, restartEtaMs) {
    this._broadcaster.broadcastShutdown(reason, restartEtaMs)
  }

  /** Set the draining state. When draining, new input is rejected. */
  setDraining(draining) {
    this._draining = !!draining
  }

  /** Count of authenticated, connected clients */
  get authenticatedClientCount() {
    return this._clientManager.authenticatedCount
  }

  /** Check if any authenticated client is actively viewing the given session */
  hasActiveViewersForSession(sessionId) {
    return this._clientManager.hasActiveViewers(sessionId)
  }

  /** Send JSON to a single client (delegates to extracted ws-client-sender) */
  _send(ws, message) {
    const client = this.clients.get(ws)
    this._clientSend(ws, client, message)
  }

  /**
   * Clear all pending permission requests across both subsystems.
   *
   * Covers:
   *   - Legacy HTTP hook permissions held in this._pendingPermissions (via ws-permissions.js)
   *   - SDK in-process permissions held by each session's PermissionManager
   *
   * Called by close() automatically. Exposed as a public method so callers can
   * drain permissions independently (e.g. before a controlled restart).
   */
  clearAllPendingPermissions() {
    // Legacy HTTP hook permissions: auto-deny and clear
    this._permissions.destroy()

    // SDK in-process permissions: auto-deny via each session's PermissionManager
    if (this.sessionManager?._sessions instanceof Map) {
      for (const [, entry] of this.sessionManager._sessions) {
        try {
          entry.session?._permissions?.clearAll()
        } catch {}
      }
    }
  }

  /** Graceful shutdown */
  close() {
    // Remove PairingManager listener to prevent post-shutdown broadcasts
    if (this._pairingManager && this._pairingRefreshedHandler) {
      this._pairingManager.off('pairing_refreshed', this._pairingRefreshedHandler)
      this._pairingRefreshedHandler = null
    }

    // Remove TokenManager listener to prevent post-shutdown broadcasts
    if (this._tokenManager && this._tokenRotatedHandler) {
      this._tokenManager.off('token_rotated', this._tokenRotatedHandler)
      this._tokenRotatedHandler = null
    }

    // Remove SessionManager listeners to prevent the closed WsServer from
    // being kept alive by a long-lived SessionManager. Without this, a server
    // recreated against the same SessionManager would receive duplicated
    // events on every old + new instance (#3060).
    if (this.sessionManager && typeof this.sessionManager.off === 'function') {
      if (this._sessionCreatedHandler) {
        this.sessionManager.off('session_created', this._sessionCreatedHandler)
        this._sessionCreatedHandler = null
      }
      if (this._sessionDestroyedHandler) {
        this.sessionManager.off('session_destroyed', this._sessionDestroyedHandler)
        this._sessionDestroyedHandler = null
      }
      if (this._sessionEventAuditHandler) {
        this.sessionManager.off('session_event', this._sessionEventAuditHandler)
        this._sessionEventAuditHandler = null
      }
    }

    if (this._pingInterval) {
      clearInterval(this._pingInterval)
      this._pingInterval = null
    }
    if (this._authCleanupInterval) {
      clearInterval(this._authCleanupInterval)
      this._authCleanupInterval = null
    }

    // Auto-deny all pending permission requests (both subsystems)
    this.clearAllPendingPermissions()
    this._questionSessionMap.clear()
    this._primaryClients.clear()
    this._normalizer.destroy()

    // Clean up all dev preview tunnels (fire-and-forget; close() is synchronous
    // by contract, and tunnel process cleanup is best-effort before exit)
    void this._devPreview.closeAll()

    // Clean up web task manager
    this._webTaskManager.destroy()

    // Remove this instance's log listener to prevent post-shutdown broadcasts and GC leak
    if (this._logListener) {
      removeLogListener(this._logListener)
      this._logListener = null
    }

    for (const [ws] of this.clients) {
      ws.close()
    }
    if (this.wss) this.wss.close()
    if (this.httpServer) this.httpServer.close()
  }
}
