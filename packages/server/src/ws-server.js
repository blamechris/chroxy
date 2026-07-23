import { createServer } from 'http'
import { randomBytes, randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { WebSocketServer } from 'ws'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { PagesStore } from './pages-store.js'
import { ShellApprovalStore } from './shell-approval-store.js'
import { finalizeShellCreate } from './handlers/session-handlers.js'
import { decrypt, DIRECTION_CLIENT } from '@chroxy/store-core/crypto'
import { safeTokenCompare } from './token-compare.js'
import { createClientSender } from './ws-client-sender.js'
import { ClientMessageSchema, EncryptedEnvelopeSchema } from './ws-schemas.js'
import { EventNormalizer } from './event-normalizer.js'
import { createFileOps } from './ws-file-ops/index.js'
import { createPermissionHandler } from './ws-permissions.js'
import { setupForwarding } from './ws-forwarding.js'
import { handleSessionMessage, handleCliMessage } from './ws-message-handlers.js'
import { handleAuthMessage, handlePairMessage, handlePairRequestMessage, handleKeyExchange, BENIGN_PAIR_WINDOW_MS } from './ws-auth.js'
import { postPairLinkToDiscord } from './discord-pair-delivery.js'
import { sendPostAuthInfo, replayHistory, flushPostAuthQueue, sendSessionInfo } from './ws-history.js'
import { createDevicePreferences } from './device-preferences.js'
import { isUserShellEnabled, isIdeFeatureEnabled, isOrchestrationEnabled } from './config.js'
import { createHttpHandler } from './http-routes.js'
import { setMcpOAuthCallbackBase } from './byok-mcp-oauth.js'
import { CheckpointManager } from './checkpoint-manager.js'
import { DevPreviewManager } from './dev-preview.js'
import { WebTaskManager } from './web-task-manager.js'
import { RateLimiter, getClientIp, getRateLimitKey, LOOPBACK_ADDRESSES } from './rate-limiter.js'
import { isUserShellApprovalRequired } from './config.js'
import { writeShellApprovalInfo, removeShellApprovalInfo } from './shell-approval-info.js'
import { createLogger, addLogListener, removeLogListener } from './logger.js'
import { PermissionAuditLog } from './permission-audit.js'
import { WsBroadcaster } from './ws-broadcaster.js'
import { WsClientManager } from './ws-client-manager.js'
import { terminalMirrorRecipient } from './handler-utils.js'
import { getProviderDataDirs } from './providers.js'
import { assertCtxShape } from './ws-handler-context.js'
import { isLoopbackHost } from './bind-host.js'
import { isLocalOrLanPeer } from './connection-locality.js'

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

/**
 * Resolve the per-IP rate-limit config for GET /diagnostics (#3737).
 *
 * Override precedence:
 *   1. Constructor opt `diagnosticsRateLimit` — full RateLimiter options
 *      object `{ windowMs, maxMessages, burst }`. Used by tests.
 *   2. `CHROXY_DIAGNOSTICS_RATE_LIMIT` env var — a single positive integer
 *      sets `maxMessages`; burst defaults to `Math.max(1, Math.floor(N/3))`.
 *   3. Defaults — 12 req/min + 4 burst (half of /permission since the cost
 *      is comparable but legitimate use is diagnostic, not interactive).
 *
 * Invalid env values (NaN, non-integer, < 1) silently fall through to
 * defaults. Sub-integer values like `0.5` are rejected outright rather
 * than truncated, because Math.trunc(0.5) = 0 and RateLimiter treats
 * `maxMessages: 0` as "use default" via `||`, which would *raise* the
 * limit instead of restoring it.
 *
 * @param {object|null} overrideOpts
 * @returns {{ windowMs: number, maxMessages: number, burst: number }}
 */
export function resolveDiagnosticsRateLimit(overrideOpts) {
  if (overrideOpts && typeof overrideOpts === 'object') return overrideOpts
  const raw = process.env.CHROXY_DIAGNOSTICS_RATE_LIMIT
  if (raw != null && raw !== '') {
    const n = Number(raw)
    if (Number.isInteger(n) && n >= 1) {
      return {
        windowMs: 60_000,
        maxMessages: n,
        burst: Math.max(1, Math.floor(n / 3)),
      }
    }
  }
  return { windowMs: 60_000, maxMessages: 12, burst: 4 }
}

/**
 * Parse a duration value coming from a `CHROXY_DEVICE_PREFS_*_MS` env var.
 * Accepts:
 *   - a non-negative numeric string → that many milliseconds (fractional
 *     values are floored, e.g. `"1.9"` → 1)
 *   - `"0"` → 0 (the literal zero; callers decide what 0 means — the
 *     device-preferences `prune()` treats `maxAgeMs === 0` as "no age
 *     cap", so setting `CHROXY_DEVICE_PREFS_MAX_AGE_MS=0` disables the
 *     hard age cap rather than evicting every entry)
 *   - empty / null / non-numeric → fall back to `defaultMs`
 *
 * Negative numbers are silently coerced to the default so a typo can't
 * disable the prune by making `now - updatedAt > -1` always true.
 *
 * @param {string|undefined|null} raw
 * @param {number} defaultMs
 * @returns {number}
 */
export function parseDevicePrefsDuration(raw, defaultMs) {
  if (raw == null || raw === '') return defaultMs
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return defaultMs
  return Math.floor(n)
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
 *   models_updated, client_focus_changed, message_queued, message_dequeued)
 *   do NOT bump the version per the breaking-changes-only policy above.
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

// #5555.6 — keepalive sweep cadence. Previously 30s, which (with the
// two-phase mark-then-terminate cycle) held a zombie client up to ~60s — ~6×
// longer than a client holds a zombie server (15s ping + 5s pong timeout =
// 20s). We now (1) treat ANY inbound frame as proof of life (the client's own
// 15s heartbeat ping suffices — see ws.on('message')), and (2) drop the sweep
// to 15s so a client that goes truly silent is detected in 15–30s, ~2× the
// client cadence. The server's own ws.ping() still fires each sweep to hold
// Cloudflare / mobile-OS idle timeouts open for clients that don't initiate.
export const KEEPALIVE_SWEEP_MS = 15_000

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
 *   { type: 'interrupt' }                             — interrupt active session (also cancels the WHOLE outgoing queue)
 *   { type: 'cancel_queued', clientMessageId, sessionId? } — cancel ONE queued send-while-busy follow-up (#5943); server emits message_dequeued(reason: 'cancelled')
 *   { type: 'set_model', model: '...' }              — change model on active session
 *   { type: 'set_permission_mode', mode: '...', confirmed? } — change permission mode (confirmed: true required for 'auto')
 *   { type: 'permission_response', requestId, decision } — respond to permission prompt
 *   { type: 'list_sessions' }                         — request session list
 *   { type: 'switch_session', sessionId }             — switch to a different session
 *   { type: 'create_session', name?, cwd?, provider?, agentCommId? } — create a new session
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
 *   { type: 'request_conversation_transcript', conversationId, cwd? } — read-only replay of a CLOSED conversation from disk (no provider spawn; #6860)
 *   { type: 'list_files', path? }                       — request file listing for a path
 *   { type: 'list_symbols', path? }                     — request workspace symbol table (#6471, opt-in IDE — features.ide)
 *   { type: 'resolve_symbol', symbol, file? }           — resolve a symbol name to its definition (#6475, opt-in IDE — features.ide)
 *   { type: 'search_content', query, path? }            — find-in-project content grep (#6474, opt-in IDE — features.ide)
 *   { type: 'find_references', symbol, file? }           — find-all-references word-boundary grep (#6477, opt-in IDE — features.ide)
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
 *   { type: 'terminal_subscribe', sessionId }           — #5835 opt IN to a session's live PTY mirror (terminal_output); only opted-in clients receive raw bytes
 *   { type: 'terminal_unsubscribe', sessionId }         — #5835 opt OUT of a session's live PTY mirror
 *   { type: 'terminal_resize', sessionId, cols, rows }  — #5835 Phase 2 request to resize the live claude-tui PTY; applied only for the session's primary owner (or an unclaimed session), then broadcast back as terminal_size
 *   { type: 'terminal_input', sessionId, data }         — #5835 Phase 3 raw keystrokes → live claude-tui PTY (true remote control); authority mirrors `input` (bound-session check + single-driver primary gate; an observer's keystroke is rejected with input_conflict)
 *   { type: 'set_thinking_level', level }               — set thinking budget level ('default'|'high'|'max')
 *   { type: 'set_permission_rules', rules, sessionId }  — set per-session auto-approval rules
 *   { type: 'set_prompt_evaluator', value: boolean, sessionId? } — toggle the per-session promptEvaluator (#3185)
 *   { type: 'set_prompt_evaluator_skip_pattern', value: string|null, sessionId? } — set the per-session evaluator skip-pattern source (#3639)
 *   { type: 'set_chroxy_context_hint', value: boolean, sessionId? } — toggle the per-session Chroxy context hint (#3805)
 *   { type: 'set_session_preamble', value: string, sessionId? } — set the per-session user-authored preamble (#4660)
 *   { type: 'skill_activate', skillName, sessionId? }   — activate a manual skill at runtime (#3209)
 *   { type: 'skill_deactivate', skillName, sessionId? } — deactivate a manual skill at runtime (#3209)
 *   { type: 'skill_trust_accept', skillName, sessionId?, requestId? } — re-trust a skill after a content-hash mismatch (#3235)
 *   { type: 'skill_trust_grant', skillName, author, scope?, sessionId?, requestId? } — grant community-skill trust (#3297)
 *   { type: 'extension_message', ... }                  — opaque extension payload (passthrough, no server handling)
 *   { type: 'create_environment', name, cwd, image?, ... } — create persistent container environment
 *   { type: 'list_environments' }                       — list all persistent environments
 *   { type: 'destroy_environment', environmentId }      — destroy an environment and its container
 *   { type: 'get_environment', environmentId }          — get single environment details
 *
 * Server -> Client:
 *   All session-scoped messages include a `sessionId` field for background sync.
 *   { type: 'auth_ok', clientId, serverMode, serverVersion, latestVersion, serverCommit, cwd, defaultCwd, connectedClients, encryption, resultTimeoutMs, hardTimeoutMs, streamStallTimeoutMs } — auth succeeded (encryption: 'required'|'disabled'; resultTimeoutMs = soft-warning window in ms, hardTimeoutMs = hard-kill window in ms, streamStallTimeoutMs = stream-stall recovery window in ms (0 = disabled) — #3760, #3905, #4477)
 *   { type: 'key_exchange_ok', publicKey }               — server's ephemeral X25519 public key (E2E encryption)
 *   { type: 'auth_bootstrap', providers, slashCommands, agents, sessionId?, tunnelUrl? } — #5555: connect-time burst folding the provider/slash-command/agent lists so a new client skips its 3-request list_* round trip; tunnelUrl re-advertises the live public URL (sub-item 7)
 *   { type: 'tunnel_url_changed', url, previousUrl? } — #5555 (sub-item 7): quick-tunnel recovery rotated the public URL; clients repoint their stored endpoint. Best-effort for tunnel-connected clients (their socket rode the now-dead old tunnel); durable recovery is auth_bootstrap.tunnelUrl on reconnect
 *   { type: 'auth_fail',    reason: '...' }           — auth failed
 *   { type: 'server_mode',  mode: 'cli' }             — which backend mode is active
 *   { type: 'message',      ... }                     — parsed chat message
 *   { type: 'stream_start', messageId: '...' }        — beginning of streaming response
 *   { type: 'stream_delta', messageId, delta }         — token-by-token text
 *   { type: 'stream_end',   messageId: '...' }        — streaming response complete
 *   { type: 'terminal_output', sessionId, data }       — #5835 live claude-tui PTY mirror (raw, ANSI-intact, coalesced ~50ms); emitted from ws-forwarding.js to clients that opted in via terminal_subscribe; the remote-viewer / authenticity surface
 *   { type: 'terminal_size', sessionId, cols, rows }   — #5835 Phase 2 authoritative live-PTY grid size; sent to a client on terminal_subscribe and broadcast to all terminal subscribers on a primary-driven terminal_resize so observers re-letterbox to the same grid
 *   { type: 'tool_start',   messageId, toolUseId, tool, input, serverName? } — tool invocation (serverName present for MCP tools)
 *   { type: 'tool_input_delta', messageId, toolUseId, partialJson } — #4080/#4081: incremental partial JSON for the streaming tool_use `input`; concatenate per-toolUseId for the live bubble preview
 *   { type: 'tool_result',  toolUseId, result, truncated, images?, isError? }  — tool result (images: [{mediaType, data}]; #6712 isError flags a failed tool for the error affordance)
 *   { type: 'mcp_servers',  servers: [{ name, status, enabled?, canToggle?, authUrl? }] } — configured MCP servers (#6824: enabled + canToggle per-server; BYOK lane sets canToggle:true so clients render the enable/disable toggle; status 'disabled' = parked; #6822: status 'oauth-required' + authUrl surfaces the browser authorization URL a remote server needs)
 *   { type: 'result',       ... }                     — query stats
 *   { type: 'status',       connected: true }         — connection status
 *   { type: 'claude_ready' }                          — Claude Code ready for input
 *   { type: 'model_changed', model: '...' }          — active model updated
 *   { type: 'available_models', models: [...], provider?, defaultModel? } — models the active provider accepts
 *   { type: 'permission_input', requestId, found, tool?, input?, error? } — #6543 (IDE P3 feature B) reply to a `get_permission_input` pull: the FULL secret-redacted tool input for a pending permission (the `permission_request` broadcast truncates `input` at ~10K), so a client can build a per-hunk pre-write diff. `found:false` (+ `error`) when the request is unknown / already resolved / owned by another session — the handler is session-bound (a client only gets input for a permission its session owns).
 *   { type: 'permission_audit_result', entries } — #6772 reply to a `query_permission_audit` pull: recent permission audit entries (mode changes / session-rule changes / allow-deny decisions) matching the query's optional sessionId/auditType/since/limit. Consumed by the dashboard's per-session "Permission history" view.
 *   { type: 'permission_request', requestId, tool, description, input, remainingMs } — permission prompt
 *   { type: 'confirm_permission_mode', mode, warning } — server challenges auto mode (client must re-send with confirmed: true)
 *   { type: 'permission_mode_changed', mode: '...' } — permission mode updated
 *   { type: 'available_permission_modes', modes: [...] } — permission modes
 *   { type: 'session_list', sessions: [...] }         — all sessions
 *   { type: 'session_switched', sessionId, name, cwd, conversationId?, sessionPreset? } — switched active session. On a fresh create-confirm `sessionPreset` (#5553) discloses the resolved per-repo preset (length-only preamble — the text is already folded into the prompt server-side — plus the seed staged editable into the composer + trust metadata); omitted when the session has no preset.
 *   { type: 'session_created', sessionId, name }      — new session created
 *   { type: 'session_destroyed', sessionId }          — session removed
 *   { type: 'session_stopped', sessionId?, code? } — user-initiated Stop confirmation (#4756); CliSession emitted `stopped` after a clean SIGINT exit; pairs with the louder `session_error` crash toast
 *   { type: 'session_restore_failed', sessionId, name, provider, cwd?, model?, permissionMode?, errorCode, errorMessage, originalHistoryPreserved, historyLength? }
 *     — session in persisted state could not be restored (e.g. missing env var); history kept on disk for retry
 *   { type: 'session_persist_failed', sessionId, name|null }
 *     — a session-list mutation (create/rename/destroy) could not be flushed to disk and will be lost on restart (#5714).
 *       `name` is null on the destroy path where the entry was already removed before the flush.
 *   { type: 'session_error', message, category?, sessionId?, recoverable? } — session operation error
 *   { type: 'history_replay_start', sessionId, fullHistory?, truncated? } — beginning of history replay
 *   { type: 'history_replay_end', sessionId }         — end of history replay
 *   { type: 'conversation_id', sessionId, conversationId } — SDK conversation ID for session portability
 *   { type: 'user_question', toolUseId, questions }   — AskUserQuestion prompt from Claude
 *   { type: 'agent_busy' }                           — agent started processing (per-session)
 *   { type: 'agent_idle' }                           — agent finished processing (per-session)
 *   { type: 'plan_started' }                         — Claude entered plan mode (transient)
 *   { type: 'plan_ready', allowedPrompts }           — plan complete, awaiting approval (transient)
 *   { type: 'inactivity_warning', messageId, idleMs, prefab } — soft check-in prompt, session stays alive (#3899)
 *   { type: 'multi_question_intervention', toolUseId, questionCount, reason, timestamp } — chroxy permission-hook denied a multi-question AskUserQuestion (#4653)
 *   { type: 'server_shutdown', reason, restartEtaMs } — server shutting down (reason: 'restart'|'shutdown')
 *   { type: 'server_status', message }               — non-error status update (e.g., recovery)
 *   { type: 'server_error', category, message, recoverable, sessionId? } — server-side error forwarded to app
 *   { type: 'directory_listing', path, parentPath, entries, error } — directory listing response for file browser
 *   { type: 'file_listing', path, parentPath, entries, error } — file browser listing response
 *   { type: 'file_content', path, content, language, size, truncated, error } — file content response
 *   { type: 'symbols_snapshot', path, symbols: [{ name, kind, file, line, exported }], truncated, error } — #6471 workspace symbol table (opt-in IDE, features.ide; dashboard-only v1)
 *   { type: 'symbol_location', symbol, file, line, error } — #6475 go-to-definition result (opt-in IDE, features.ide; dashboard-only v1)
 *   { type: 'code_search_results', query, results: [{ file, line, column, text }], truncated, error } — #6474 find-in-project results (opt-in IDE, features.ide; dashboard-only v1)
 *   { type: 'references_result', symbol, results: [{ file, line, column, text }], truncated, error } — #6477 find-all-references results (opt-in IDE, features.ide; dashboard-only v1)
 *   { type: 'slash_commands', commands: [{ name, description, source }] } — available slash commands
 *   { type: 'agent_list', agents: [{ name, description, source }] } — available custom agents
 *   { type: 'client_joined', client: { clientId, deviceName, deviceType, platform } } — new client connected
 *   { type: 'client_left', clientId }                — client disconnected
 *   { type: 'client_focus_changed', clientId, sessionId, timestamp } — another client changed session focus
 *   { type: 'checkpoint_created', sessionId, checkpoint } — checkpoint created (auto or manual)
 *   { type: 'checkpoint_list', sessionId, checkpoints }   — list of checkpoints
 *   { type: 'checkpoint_restored', checkpointId, mode, newSessionId?, name?, filesOnly? } — checkpoint restored (#6766/#6767: mode 'files' keeps the current session — no newSessionId, name = the checkpoint's name; 'conversation'/'both' create + re-home to a rewound session, name = its name; filesOnly true = working tree only, conversation NOT branched)
 *   { type: 'primary_changed', sessionId, clientId } — last-writer-wins primary changed (null on disconnect)
 *   { type: 'session_role', sessionId, primaryClientId } — #5589/#5281: explicit primary-ownership; client derives its role (primary iff primaryClientId === own clientId, observer if another holds it, null = unclaimed)
 *   { type: 'pong' }                                    — heartbeat response
 *   { type: 'permission_expired', requestId, sessionId, message }  — permission response could not be routed (expired/handled)
 *   { type: 'token_rotated', token?, expiresAt, reason? } — API token changed. Scheduled rotation carries the new `token` to encrypted clients (transparent re-key, sessions survive). A `reason: 'revoke'` (#6006) carries NO token: the operator revoked, so the server severed user-shell sessions and cleared this connection's auth — the client must re-authenticate with the current token (obtained out-of-band).
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
 *   { type: 'append_memory_result', path, created, error? } — `#`-quick-append ack (#6861)
 *   { type: 'log_entry', level, message, timestamp }    — server log entry for dashboard
 *   { type: 'session_activity', sessionId, isBusy, lastCost } — session busy/idle state change
 *   { type: 'session_context', sessionId, cwd, conversationId?, ... } — session context data
 *   { type: 'session_updated', sessionId, name }        — session metadata updated
 *   { type: 'discovered_sessions', sessions }           — discovered local Claude sessions
 *   { type: 'pair_fail', reason }                       — pairing failed
 *   { type: 'pairing_refreshed' }                       — pairing ID consumed; clients should re-fetch /qr (#2916)
 *   { type: 'pair_request_pending', requestId, verifyCode } — pairing-approval primitive (#5510, epic #5509): ack to the camera-less requester carrying the 6-digit code to DISPLAY. Sent only over the requester's own pre-auth connection; the code travels server→requester only and is never echoed back.
 *   { type: 'pair_pending', requestId, deviceName, verifyCode, expiresAt } — pairing-approval fan-out (#5510) to HOST-LEVEL (unbound) surfaces only; carries the verify code to COMPARE and the attacker-controlled (schema-capped, plain-text) deviceName. Bound/session-scoped clients never receive it.
 *   { type: 'pair_result', requestId, ok, token?, reason? } — pairing-approval terminal result (#5510) to the requester over its still-open connection. On approve `ok: true` + the unbound (host-authority) session token, delivered exactly once and never logged; on deny/expire/disconnect `ok: false` + reason.
 *   { type: 'pair_resolved', requestId, reason } — pairing-approval retraction (#5510) to host-level surfaces so every banner drops a request that was approved/denied/expired/disconnected elsewhere.
 *   { type: 'rate_limited', message }                   — client rate-limited
 *   { type: 'agent_spawned', sessionId, agentId, parentToolId, model } — background agent spawned
 *   { type: 'agent_completed', sessionId, agentId, parentToolId }       — background agent completed
 *   { type: 'agent_event', sessionId, parentToolUseId, eventType, payload } — Task subagent intermediate wire event re-emit (#5016, transient; eventType is one of `tool_start` / `tool_input_delta` / `tool_result` / `stream_delta`)
 *   { type: 'background_work_changed', sessionId, pending } — pending background shells snapshot changed (#4307, transient; `pending: [{ shellId, command, startedAt }, …]`)
 *   { type: 'shell_pending_approval', approvalId, hint? } — #6277 host-local user-shell approval: a requested user-shell spawn is HELD pending the host operator's out-of-band approval (`chroxy shell approve <id>`). Informational; dashboard-only banner for v1. The normal `session_switched` confirms on approval, a `session_error` (SHELL_APPROVAL_DENIED) on deny.
 *   { type: 'activity_snapshot', sessionId, schemaVersion, entries } — Control Room full activity tree for a session, on subscribe/resync (#5161 schema; emitter #5160; `entries: [{ id, kind, label, status, startedAt, endedAt?, parentId?, outputRef? }, …]`)
 *   { type: 'activity_delta', sessionId, schemaVersion, op, entry } — Control Room incremental activity-entry change (#5161 schema; emitter #5160; `op` is one of `started` / `updated` / `ended`; `entry` is the full node)
 *   { type: 'message_queued', sessionId, clientMessageId?, text, queueLength } — a send-while-busy follow-up entered the server's outgoing-message queue (#5936/#5937, transient; mirrors `_outgoingQueue`)
 *   { type: 'message_dequeued', sessionId, clientMessageId?, queueLength, reason } — a queued follow-up left the queue (#5936/#5937/#5943, transient; `reason` is `flush` (auto-sent on turn-complete), `interrupted` (whole queue cancelled by a Stop), or `cancelled` (one item cancelled via `cancel_queued`))
 *   { type: 'host_status_snapshot', requestId?, generatedAt, root, summary, repos, error? } — Control Room Host/Repo Status survey reply (#5171 schema; emitter #5174); reply to a `host_status_request`. Always carries the full snapshot shape (so it is protocol-schema-valid); on failure `repos` is empty, `summary` is zeroed, and an additive `error: { code, message }` annotation is present for the consumer to branch on. `requestId` echoes the request when provided.
 *   { type: 'runner_status_snapshot', requestId?, generatedAt, root, summary, repos, error? } — Control Room self-hosted runner survey reply (#5253 schema + emitter); reply to a `runner_status_request`. Same degraded-snapshot-with-`error` posture as `host_status_snapshot`: always the full shape; on failure `repos` is empty, `summary` is zeroed, and an additive `error: { code, message }` is present. `requestId` echoes the request when provided.
 *   { type: 'containers_status_snapshot', requestId?, generatedAt, summary, containers, dockerStatsNote?, error? } — Control Room containers & environments survey reply (#6133 schema + emitter, epic #5530); reply to a `containers_status_request`. Flat `containers` array of chroxy-managed environments (id, name, cwd, image, status, backend, sessionCount, uptimeMs, best-effort `docker stats`); `dockerStatsNote` is set when the stats enrichment was unavailable (every entry's `stats` then null). Same degraded-snapshot-with-`error` posture as the host/runner surveys. `requestId` echoes the request when provided.
 *   { type: 'repo_runtime_config_snapshot', requestId?, generatedAt, backend, backendSource, isolation, allowlist, repos, summary, error? } — Control Room per-repo runtime config survey reply (#6139, epic #5530); reply to a `repo_runtime_config_request`. Read-only. Host-level defaults (effective `backend` + its `backendSource`, `isolation` order, effective image `allowlist`) plus a per-repo array (devcontainer/compose presence, the image it would run + the allowlist verdict). Same degraded-snapshot-with-`error` posture as the host/runner/containers surveys. `requestId` echoes the request when provided.
 *   { type: 'byok_pool_status_snapshot', requestId?, generatedAt, enabled, note, limits, stats, error? } — Control Room BYOK container-pool stats survey reply (#6135, epic #5530); reply to a `byok_pool_status_request`. Read-only. `enabled:false` (with `note`, null limits/stats) is a first-class state — the pool is off by default. When enabled: `limits` (idle TTL / per-key / total / max-age caps) + `stats` (hits/misses/releases/evictions-by-reason + per-key warm buckets + a recent-evictions tail). Same degraded-snapshot-with-`error` posture as the sibling surveys. `requestId` echoes the request when provided.
 *   { type: 'host_prune_status_snapshot', requestId?, generatedAt, dockerAvailable, note, containers, images, summary, error? } — Control Room host prune guardrails survey reply (#6140, epic #5530); reply to a `host_prune_status_request`. Read-only. Reclaimable, chroxy-scoped, ORPHAN-ONLY docker pressure: stopped `chroxy-env-*` containers + chroxy snapshot images (`chroxy-env`/`chroxy-byok-snap`) NOT tracked by a live env, with per-resource sizes + a `summary` (counts + estimated reclaimableBytes). `dockerAvailable:false` (with `note`, empty lists) is a first-class state. Same degraded-snapshot-with-`error` posture as the sibling surveys.
 *   { type: 'host_prune_action_ack', kind, requestId?, dockerAvailable, removedContainers, removedImages, reclaimedBytes, failures } — Control Room host prune action ack (#6140, epic #5530); reply to a successful `host_prune_action` (kind containers/images/all). The server re-surveys the chroxy-scoped orphan set and removes only those ids; the ack carries removed counts, estimated `reclaimedBytes`, and a `failures` list (resources whose `docker rm`/`rmi` failed). Failures to start surface as a HOST_PRUNE_ACTION_FAILED `session_error` echoing `kind`/`requestId`.
 *   { type: 'simulator_status_snapshot', requestId?, generatedAt, available, note, devices, readyForMaestro, error? } — Control Room iOS simulator survey reply (#6136, epic #5530); reply to a `simulator_status_request`. Read-only. `devices` is the `xcrun simctl list devices` inventory (udid/name/state/runtime/deviceType); `readyForMaestro` is the composite verdict (booted sim + Metro :8081 + mock-server :9876 reachable, with `reasons[]`). `available:false` (with `note`, empty devices) off macOS / no xcrun is a first-class state. Same degraded-snapshot-with-`error` posture as the sibling surveys.
 *   { type: 'emulator_status_snapshot', requestId?, generatedAt, available, note, devices, readyForMaestro, error? } — Control Room Android emulator survey reply (#6137, epic #5530); reply to an `emulator_status_request`. Read-only. `devices` joins `emulator -list-avds` with `adb devices` (avd/serial/state: running|stopped); `readyForMaestro` is the composite verdict (running emulator + Metro :8081 + mock-server :9876 reachable, with `reasons[]`). `available:false` (with `note`, empty devices) with no Android SDK is a first-class state. Same degraded-snapshot-with-`error` posture as the sibling surveys.
 *   { type: 'emulator_action_ack', action, avd?, serial?, requestId?, status } — Control Room Android emulator action ack (#6137, epic #5530); reply to a successful `emulator_action` (boot/kill). The server re-surveys, validates the target (boot → a stopped `avd`, kill → a running `serial`) + state-gates it, runs `emulator -avd` (detached) / `adb emu kill`, and echoes `action` + the relevant `avd`/`serial` (+ `requestId`) plus the resulting `status` ("starting"/"killed"). Failures surface as an EMULATOR_ACTION_FAILED `session_error` echoing the same correlation fields.
 *   { type: 'wsl_status_snapshot', requestId?, generatedAt, available, note, defaultDistro, distros, error? } — Control Room WSL2 distro survey reply (#6138, epic #5530); reply to a `wsl_status_request`. Read-only (Windows hosts). `distros` is the `wsl.exe -l -v` inventory (name/state/version/isDefault); `defaultDistro` names the `*`-marked default. `available:false` (with `note`, empty distros) off Windows / no wsl.exe is a first-class state. Same degraded-snapshot-with-`error` posture as the sibling surveys.
 *   { type: 'wsl_action_ack', action, distro, requestId?, status } — Control Room WSL2 action ack (#6138, epic #5530); reply to a successful `wsl_action` (start/terminate). The server re-surveys `wsl.exe -l -v`, validates the `distro` is enumerated + state-gated (start a non-running distro, terminate a running one), runs `wsl.exe -d <distro> -e true` / `wsl.exe --terminate <distro>`, and echoes `action`/`distro` (+ `requestId`) plus the resulting `status` ("running"/"stopped"). Failures surface as a WSL_ACTION_FAILED `session_error` echoing the same correlation fields.
 *   { type: 'integration_status_snapshot', requestId?, generatedAt, root, summary, repos, repoMemoryCli?, error? } — Control Room Integrations survey reply (#5499 schema + emitter, epic #5498); reply to an `integration_status_request`. Per-repo repo-memory status (config, cache stats, telemetry report); `repoMemoryCli` notes the once-per-snapshot binary probe. Same degraded-snapshot-with-`error` posture as the host/runner surveys. `requestId` echoes the request when provided.
 *   { type: 'containers_action_ack', action, environmentId, requestId?, status? } — Control Room container lifecycle action ack (#6134, epic #5530); reply to a successful `containers_action` (stop/restart/destroy). Echoes `action`/`environmentId` (+ `requestId` when provided) and carries the resulting `status` (stopped/running/destroyed). Failures surface as a CONTAINER_ACTION_FAILED `session_error` echoing the same correlation fields.
 *   { type: 'byok_pool_action_ack', action, requestId?, key?, drained?, evicted?, limits?, configured? } — Control Room BYOK pool mutating action ack (#6135 slice 2, epic #5530); reply to a successful `byok_pool_action` (drain/recycle/resize). Echoes `action` (+ `requestId`/`key` when provided) and carries the result: `drained` (containers evicted by drain/recycle), `evicted` (containers evicted to honor a tightened resize), `limits` (new effective caps after resize), `configured` (the operator-configured cap ceiling resize clamps to). Failures surface as a BYOK_POOL_ACTION_FAILED `session_error` echoing the same correlation fields.
 *   { type: 'simulator_action_ack', action, udid, requestId?, status } — Control Room iOS simulator action ack (#6136 slice 2, epic #5530); reply to a successful `simulator_action` (boot/shutdown). The server re-surveys `xcrun simctl list devices`, validates the `udid` is enumerated + state-gated (boot a non-booted device, shutdown a booted one), runs `simctl <action> <udid>`, and echoes `action`/`udid` (+ `requestId` when provided) plus the resulting `status` ("Booted"/"Shutdown"). Failures surface as a SIMULATOR_ACTION_FAILED `session_error` echoing the same correlation fields.
 *   { type: 'integration_action_ack', action, repoPath, requestId?, counts } — Control Room Integrations action ack (#5500, epic #5498); reply to a successful `integration_action` (currently `repo_memory_reindex`). Echoes `action`/`repoPath` (+ `requestId` when provided) cloning the cancel_activity_ack correlation contract; `counts` carries the parsed scanned/summarized/fresh/skipped index result, or null when the CLI output was unparseable. Failures surface as an INTEGRATION_ACTION_FAILED `session_error` echoing the same correlation fields.
 *   { type: 'skills_inventory_snapshot', requestId?, generatedAt, root, global, globalError?, repos, error? } — Control Room Skills inventory survey reply (#5554 schema + emitter, epic #5159); reply to a `skills_inventory_request`. `global` is the `~/.chroxy/skills/` tier and `repos` the per-repo `.chroxy/skills/` overlays, each entry carrying name/description/activation/trust/hash/installed + usage (lastUsed/count/repos). Skill BODIES never leave the server. Same degraded-snapshot-with-`error` posture as the host/runner/integration surveys; `globalError` / per-repo `error` degrade a single tier without blanking the snapshot. `requestId` echoes the request when provided.
 *   { type: 'mailbox_status_snapshot', requestId?, generatedAt, registrations, recentEvents, error? } — Control Room "Mailbox" tab survey reply (#5914 follow-up); reply to a `mailbox_status_request`. `registrations` is the live agentCommId→session map (each with sessionName/isBusy/isTui) and `recentEvents` a bounded newest-first ring buffer of recent live-interrupt deliveries (to/from/unreadCount/outcome). Host-level: a session-bound token is refused with an additive `error: { code, message }` on an otherwise-empty (schema-valid) snapshot. `requestId` echoes the request when provided.
 *   { type: 'external_sessions_snapshot', requestId?, generatedAt, sessions, error? } — Control Room mission-control external-session survey reply (#5969, epic #5422 phase 4); reply to an `external_sessions_request`. `sessions` lists the LIVE external Claude Code sessions the daemon learned about over `POST /api/events` (#5413) — sessions it did NOT launch — each carrying source/sessionId/name/project/cwd, a read-only `status` ('running'|'idle'), active `subagents`, and `lastActivityTs`. Read-only (no PTY/control handle exists for these). Host-level: a session-bound token is refused with an additive `error: { code, message }` on an otherwise-empty (schema-valid) snapshot. `requestId` echoes the request when provided.
 *   { type: 'repo_events_delta', generatedAt, event } — Control Room repo-events LIVE delta (#6536, PR-2 of #5966); server-INITIATED (no request) push of a single newly-buffered repo-event when a GitHub webhook delivery lands, so the pane updates without a Refresh. Host-level: broadcast ONLY to unbound (host-authority) clients — a session-bound (share-a-session) token never receives host repo activity. A client that hasn't run the survey ignores it; a client with a snapshot appends the event (bounded). No `error`/`requestId` — degraded surveys still flow through the pull `repo_events_snapshot`.
 *   { type: 'repo_events_snapshot', requestId?, generatedAt, events, error? } — Control Room repo-events survey reply (#5966, epic #5422 phase 5); reply to a `repo_events_request`. `events` is the tail (most-recent-last) of the daemon's bounded RepoEventStore — GitHub-webhook activity (push/pull_request/issues/ping) ingested HMAC-verified over `POST /api/github/webhook` (#6468) — each carrying kind/repo/actor/at plus kind-specific branch/action/number/title/url and a pre-rendered `summary`. Read-only; no delta stream (a full snapshot per pull, like the host/mailbox/external surveys). Host-level: a session-bound token is refused with an additive `error: { code, message }` on an otherwise-empty (schema-valid) snapshot. `requestId` echoes the request when provided.
 *   { type: 'summarize_session_result', sessionId, summary, truncated?, requestId? } — reply to a `summarize_session` (#5547); the model-written continuation brief built from the session's persisted history, seeded editable into the dashboard's create-session composer. `truncated` flags a windowed history. Failures surface as a SUMMARIZE_FAILED `session_error` echoing `sessionId`/`requestId` (curated message — no token/key material).
 *   { type: 'session_preset_snapshot', cwd, preset: { source, active, trustState, enabled, preamble, seed, preambleLength, seedLength, capped, repoPath } | null, requestId? } — Control Room per-repo session-preset reply (#5553, epic #5159); reply to a host-authority `session_preset_get` / `session_preset_set` / `session_preset_approve` / `session_preset_revoke`. `preset` is null when the repo has no preset. Full preamble + seed text reaches HOST-level clients only (the four requests are rejected for session-bound pairing clients). `requestId` echoes the request when provided.
 *   { type: 'provider_list', providers }                — available providers
 *   { type: 'byok_credentials_status', requestId?, status, source, masked?, reason? } — BYOK credentials state for the dashboard (#4052)
 *   { type: 'credentials_status', requestId?, credentials: [{ key, provider, label, kind, status, source, masked?, oauth }], fileExists?, fileError? } — generalized provider-credential status for the dashboard (#3855); masked, value-free; sent to requester + broadcast after set/delete
 *   { type: 'credential_test_result', requestId?, key, ok, error?, model?, latencyMs? } — result of a test_credential ping (#3855)
 *   { type: 'notification_prefs', requestId?, prefs: { categories, devices, quietHours } } — current notification preferences snapshot (#4541/#4542); echoed back on `notification_prefs_get` and broadcast after every `notification_prefs_set`
 *   { type: 'skills_list', skills }                     — active skills (name, description, activation, active per entry)
 *   { type: 'skill_changed', skillName, sessionId, oldHashPrefix, newHashPrefix, mode } — skill content-hash mismatch (#3234, transient)
 *   { type: 'skill_activated', sessionId, skillName }   — manual skill toggled on at runtime (#3209)
 *   { type: 'skill_deactivated', sessionId, skillName } — manual skill toggled off at runtime (#3209)
 *   { type: 'skill_trust_accepted', sessionId, skillName } — operator re-trusted a skill after hash mismatch (#3235)
 *   { type: 'skill_trust_request', skillName, author, source, description, path, sessionId } — community skill awaiting first-activation grant (#3297, transient)
 *   { type: 'skill_trust_granted', sessionId, skillName, author } — community skill trust granted (#3297)
 *   { type: 'skill_trust_grant_ok', requestId, sessionId, skillName, author } — ack for skill_trust_grant handler (#3297)
 *   { type: 'push_token_error', message }               — push token registration error
 *   { type: 'cost_update', sessionId, sessionCost, totalCost, budget } — session cost update (budget-oriented; sessionId injected by _broadcastToSession)
 *   { type: 'session_usage', sessionId, cumulativeUsage } — per-session cumulative tokens + cost; cumulativeUsage = { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd, turnsBilled } (#4072)
 *   { type: 'session_cost_threshold_crossed', sessionId, costUsd, thresholdUsd } — soft "you've spent $X" warning; fires ONCE per session when cumulativeUsage.costUsd >= threshold (#4075)
 *   { type: 'budget_warning', sessionId, message, ... } — budget approaching limit
 *   { type: 'budget_exceeded', sessionId, message, ... } — budget exceeded
 *   { type: 'monthly_budget', month, spentUsd, budgetUsd, percent, warning, exceeded, ... } — machine-wide monthly programmatic-credit meter (#5665); broadcast to ALL clients after each programmatic-credit turn + sent once on connect
 *   { type: 'web_feature_status', features }            — web feature availability
 *   { type: 'permission_rules_updated', rules }         — per-session auto-approval rules changed
 *   { type: 'extension_message', ... }                  — opaque extension payload (passthrough, no server handling)
 *   { type: 'environment_created', environmentId, name, status } — environment created
 *   { type: 'environment_list', environments: [...] }   — list of all environments
 *   { type: 'environment_destroyed', environmentId }    — environment destroyed
 *   { type: 'environment_info', environment: {...} }    — single environment details
 *   { type: 'environment_error', error, environmentId? } — environment operation error
 *   { type: 'evaluate_draft_result', requestId, verdict?, rewritten?, clarification?, reasoning?, error? } — prompt evaluator response (#3068)
 *   { type: 'prompt_evaluator_changed', sessionId, value: boolean } — per-session promptEvaluator toggle changed (#3185)
 *   { type: 'prompt_evaluator_skip_pattern_changed', sessionId, value: string|null } — per-session evaluator skip pattern changed (#3639)
 *   { type: 'chroxy_context_hint_changed', sessionId, value: boolean } — per-session Chroxy context hint toggle changed (#3805)
 *   { type: 'session_preamble_changed', sessionId, value: string } — per-session preamble changed (#4660)
 *   { type: 'evaluator_rewrite', sessionId, originalDraft, rewritten, reasoning, evaluatorIterationId } — auto-evaluator rewrite verdict broadcast (#3208 schema, #3186 emit, #3188 dashboard handler)
 *   { type: 'evaluator_clarify', sessionId, originalDraft, clarification, reasoning, evaluatorIterationId, evaluatorIteration } — auto-evaluator clarify verdict broadcast (#3208 schema, #3186 emit, #3188 dashboard handler)
 *   { type: 'stdin_dropped_totals', sessionId, bytes, count, reason, escalated } — cumulative SidecarProcess pre-dial-cap drop totals (#3544, transient)
 *   { type: 'orchestration_runs_snapshot', requestId?, generatedAt, runs: [RunSummary], error? } — orchestration runs-list survey (#6691, dashboard-only v1)
 *   { type: 'orchestration_run_snapshot', requestId?, generatedAt, seq, run: RunDetail|null, error? } — one run's full detail (pull-only; run:null = degraded reply) (#6691)
 *   { type: 'orchestration_run_delta', runId, seq, generatedAt, run?, node?, gate?, timeline? } — live run update pushed to host-level clients; client applies iff seq===held+1 (#6691)
 *   { type: 'orchestration_action_ack', requestId?, action, runId, gateId? } — terminal success echo for a mutating orchestration action (#6691)
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
  constructor({ port, apiToken, cliSession, sessionManager, defaultSessionId, authRequired = true, pushManager = null, maxPayload, noEncrypt, keyExchangeTimeoutMs, localhostBypass, tokenManager, pairingManager, serverIdentity = null, maxPendingConnections, backpressureThreshold, environmentManager, orchestrationManager = null, config = null, diagnosticsRateLimit = null, devicePreferences = null, pagesStore = null, pagesRateLimiter } = {}) {
    this.port = port
    this.apiToken = apiToken
    this._tokenManager = tokenManager || null
    this._pairingManager = pairingManager || null
    // #5536 — long-lived Ed25519 identity keypair. Its secret half signs each
    // connection's ephemeral exchange public key (eager + discrete paths) so a
    // pinned client can verify the exchange key came from this daemon. Null when
    // pinning is unavailable — in that case the server signs nothing and the
    // exchange stays TOFU (backward compatible: old clients never look for a sig).
    this._serverIdentity = serverIdentity || null
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
    // #5356 (visibility layer): exposure snapshot surfaced in auth_ok so the
    // dashboard can warn about non-loopback binds / public quick tunnels.
    // _boundHost is set in start(); _quickTunnelActive by server-cli when a
    // quick (trycloudflare) tunnel is configured.
    this._boundHost = undefined
    this._quickTunnelActive = false
    // #5555 (sub-item 7): the server's current public tunnel URL as a `wss://`
    // endpoint, set by server-cli once the tunnel is up and updated on a
    // quick-tunnel URL rotation. Surfaced in the auth_bootstrap burst so a
    // reconnecting client always re-learns the live URL. `null` for LAN /
    // no-tunnel deployments.
    this._tunnelUrl = null
    this._backpressureThreshold = backpressureThreshold ?? 1024 * 1024 // 1MB default
    this._backpressureMaxDrops = 10 // close connection after this many consecutive drops
    // #3996: name each limiter so eviction logs and /diagnostics
    // rateLimiters[].name can identify which one is shedding entries.
    this._rateLimiter = new RateLimiter({ name: 'ws' })
    // Separate, relaxed limiter for permission/question responses (60 per minute, no burst)
    this._permissionRateLimiter = new RateLimiter({ name: 'permission', windowMs: 60_000, maxMessages: 60, burst: 0 })
    // #6551: dedicated limiter for get_permission_input (the pre-write-diff pull).
    // Each pull can return up to 512K, so it's TIGHTER than the general limiter
    // (30/min + 10 burst vs 100 + 20) to bound cost/egress amplification — a
    // legit diff-review UI pulls at most once per permission prompt, so 40
    // effective/min is generous while capping a self-DoS from one client hammering
    // one requestId.
    this._permissionInputRateLimiter = new RateLimiter({ name: 'permission-input', windowMs: 60_000, maxMessages: 30, burst: 10 })
    // #3737: per-IP limiter for GET /diagnostics. Default 12 req/min + 4 burst
    // — half of /permission since the cost (FS read + session iteration) is
    // comparable but legitimate use is diagnostic, not interactive. Override
    // via constructor opt (tests) or `CHROXY_DIAGNOSTICS_RATE_LIMIT` (deploy:
    // a single integer sets maxMessages, with a 1/3 burst).
    this._diagnosticsRateLimiter = new RateLimiter(
      { name: 'diagnostics', ...resolveDiagnosticsRateLimit(diagnosticsRateLimit) }
    )
    // #5683 — Chroxy Pages. Per-IP limiter for the public `/p/<slug>` route
    // (assets + refreshes are more frequent than diagnostics, hence higher
    // than /diagnostics but still bounded to blunt slug-scanning). The store is
    // injectable for tests; the default is rooted at $CHROXY_CONFIG_DIR /
    // ~/.chroxy/pages and only READS on construct (no sandbox write).
    // Injectable so tests/deployments can override or DISABLE it (pass null).
    // `!== undefined` (not ||/??) so an explicit null genuinely disables the
    // limiter rather than falling back to the default.
    this._pagesRateLimiter = pagesRateLimiter !== undefined
      ? pagesRateLimiter
      : new RateLimiter({ name: 'pages', windowMs: 60_000, maxMessages: 120, burst: 30 })
    this.pagesStore = pagesStore || new PagesStore({
      pagesDir: join(process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy'), 'pages'),
    })
    // #6277: host-local user-shell approval store. The create gate holds a spawn
    // here when userShell.requireApproval is on; the host operator approves it
    // out-of-band via the loopback /api/shell routes (or `chroxy shell approve`).
    this._shellApprovalStore = new ShellApprovalStore()
    this._clientSend = createClientSender(log)
    // audit P1-2: when a client's active session changes, re-sync the live
    // terminal mirror gate for BOTH the session it left and the one it joined.
    // Without this a client opted into session A's terminal that switches to B
    // would fall out of A's delivery filter while A's coalescer kept running to
    // nobody (the waste #5837/#5844 set out to kill). _syncTerminalMirror
    // no-ops on a null id, so passing prev=null is safe.
    this._clientManager = new WsClientManager({
      onActiveSessionChanged: (_client, prev, next) => {
        this._syncTerminalMirror(prev)
        this._syncTerminalMirror(next)
      },
    })
    this.clients = this._clientManager.clients // back-compat: expose the raw Map for context objects
    // #4835: per-device active-session memory. Caller can inject a custom
    // store (tests do this with a tmp file path); otherwise we construct
    // the default disk-backed store rooted at $CHROXY_CONFIG_DIR /
    // ~/.chroxy. The store is consumed by ws-history.sendPostAuthInfo on
    // reconnect and updated by session-handlers.handleSwitchSession after
    // every explicit switch.
    this._devicePreferences = devicePreferences || createDevicePreferences()
    // #5821: provider for the current billing-canary snapshot, wired by
    // server-cli after the monitor is constructed (the monitor depends on this
    // WsServer's broadcast, so it's created after — set the provider here once
    // it exists). null = no seed (older boot / tests); the ctx getter folds this in.
    this._billingCanaryProvider = null
    // #4849: lazy startup prune. server-cli calls sessionManager.restoreState()
    // before constructing the WsServer, so any device-pref entry whose
    // activeSessionId is missing here is genuinely orphaned (a session
    // destroyed in a previous run, or one rotated out by the user). The
    // grace window guards against the rare path where restoreState
    // intentionally skipped a session (e.g. corrupted state). prune is a
    // no-op when the device list is empty, so the disk-I/O cost is zero
    // for first-run installs and for users who never connected from
    // ephemeral devices. Threshold env vars:
    //   - CHROXY_DEVICE_PREFS_MAX_AGE_MS — hard age cap (default 90d)
    //   - CHROXY_DEVICE_PREFS_STALE_GRACE_MS — stale-session grace (default 30d)
    // Both can be set to 0 to disable. See #4849.
    if (sessionManager && typeof this._devicePreferences.prune === 'function') {
      try {
        const maxAgeMs = parseDevicePrefsDuration(
          process.env.CHROXY_DEVICE_PREFS_MAX_AGE_MS,
          90 * 24 * 60 * 60 * 1000,
        )
        const staleGraceMs = parseDevicePrefsDuration(
          process.env.CHROXY_DEVICE_PREFS_STALE_GRACE_MS,
          30 * 24 * 60 * 60 * 1000,
        )
        // Only enable stale-session pruning when SessionManager actually
        // exposes getSession. With optional chaining, `getSession?.(id)`
        // silently returns undefined when the method is missing — every
        // session would look "stale" and the prune would evict everything
        // past the grace window. Belt-and-braces: when the predicate is
        // omitted, prune() skips the stale-session arm and only the
        // age-based cap (if any) applies.
        const pruneOpts = {
          maxAgeMs,
          staleSessionGraceMs: staleGraceMs,
        }
        if (typeof sessionManager.getSession === 'function') {
          pruneOpts.sessionExists = (id) => !!sessionManager.getSession(id)
        }
        this._devicePreferences.prune(pruneOpts)
      } catch (err) {
        // A prune failure must never block server startup — the next mutation
        // will reload the file anyway, and the worst case is a slightly
        // larger preferences file.
        log.warn(`device-preferences startup prune failed: ${err.message}`)
      }
    }
    this.httpServer = null
    this.wss = null
    this._pingInterval = null
    this._pendingPermissions = new Map() // requestId -> { resolve, timer }
    // #3637: per-session auto-evaluator iteration counter for the clarify
    // loop cap (#3186). Lives on the WsServer (not per-message-ctx)
    // because handler ctx is spread fresh on every dispatch — without a
    // stable home the counter would reset on every message and the cap
    // would never fire in production. Cleaned up by `_sessionDestroyedHandler`
    // so a long-running server doesn't leak entries for destroyed sessions.
    this._evaluatorIterations = new Map() // sessionId -> iteration count
    this._permissionSessionMap = new Map() // requestId -> sessionId (for routing responses to correct session)
    // #5704: refcount of permission-INDUCED session subscriptions, per client.
    // clientId -> Map<sessionId, refcount>. _registerPermissionRoute increments
    // it for a new route's auto-subscribe UNLESS that subscription is explicitly
    // owned (the client holds it with refcount 0) — so a permission can never
    // "steal ownership" of an explicit subscription, while a second concurrent
    // permission on an already permission-owned session does count up;
    // _unregisterPermissionRoute (wired to every resolve/expire/cleanup site)
    // decrements it and tears the auto-subscription back down when the count
    // hits zero AND the client is neither active on nor explicitly subscribed to
    // the session. An explicit switch_session/subscribe_sessions ADOPTS the
    // subscription by zeroing this refcount (see _adoptPermissionSubscription),
    // so permission teardown never unsubscribes a client that asked to watch.
    this._permissionSubs = new Map() // clientId -> Map<sessionId, refcount>
    this._hookSecrets = new Set() // per-session hook secrets registered by active CliSessions
    this._sessionHookSecrets = new Map() // sessionId -> hookSecret (for cleanup on session_destroyed)
    this._questionSessionMap = new Map() // toolUseId -> sessionId (for routing question responses)
    // #5563: primary-ownership now lives on the WsClientManager (sessionId →
    // primary clientId) with explicit claim/observe/hand-off semantics, not a
    // last-writer-wins map. `primaryClients` is no longer a server-owned Map;
    // handlers query it through ctx.transport.getPrimary / isPrimary / claim /
    // clear helpers below.
    // #5510: pairing-approval primitive — requestId → requester ws. The
    // requester's WS stays open (pre-auth) after pair_request; on approve/deny/
    // expire/disconnect we look it up here to deliver `pair_result`. Bounded by
    // the PairingManager queue cap; cleaned up on resolution and on disconnect.
    this._pairRequesters = new Map() // requestId -> ws
    // Late-binding wrappers: allows tests to monkey-patch _send/_broadcast
    const self = this
    const sendFn = (ws, msg) => self._send(ws, msg)
    this._broadcaster = new WsBroadcaster({
      clients: this.clients,
      // #5563: share the reverse index owner so session broadcasts + subscriber
      // counts iterate the sessionId→clients index instead of scanning all clients.
      clientManager: this._clientManager,
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
      // #4798: same auto-subscribe helper used by ws-forwarding's dispatch
      // path. Hook-originated HTTP permission requests also need to seed
      // subscribedSessionIds on connected viewers so the settings-handler
      // subscription guard accepts the legitimate response.
      registerPermissionRoute: (requestId, sessionId) => self._registerPermissionRoute(requestId, sessionId),
      // #5704: tear down the permission-induced subscription refcount in lockstep
      // with the map entry on every resolve / expire / cleanup / drain / destroy.
      unregisterPermissionRoute: (requestId) => self._unregisterPermissionRoute(requestId),
      getSessionManager: () => self.sessionManager,
      // Pass pairingManager so the HTTP /permission-response fallback can
      // enforce session binding — see 2026-04-11 audit blocker 5.
      pairingManager: this._pairingManager,
      // #2831: let the permission handler tell a CliSession that a hook
      // permission belonging to it is outstanding so the session's
      // 5-min inactivity timer can pause until the user responds.
      findSessionByHookSecret: (secret) => self._findSessionByHookSecret(secret),
      // #3059: audit HTTP user-initiated permission responses. Late-bound
      // via getter because _permissionAudit is constructed after this call.
      getPermissionAudit: () => self._permissionAudit,
    })
    // Handler context (#5558): role-scoped namespaces, not a flat god-context.
    // Each bucket declares what a handler couples to — transport (send/
    // broadcast/subscribe), sessions (the session managers), permissions
    // (audit + routing maps), services (managers + config + fileOps), runtime
    // (drain flag, provider dirs, evaluator counters). Late-bound via getters
    // for test compat (tests may reassign the underlying server properties).
    // The single source of truth for the shape is ws-handler-context.js.
    this._handlerCtx = {
      transport: {
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
        // #5563: index-maintaining mutators for client subscription / active
        // session. Handlers MUST route subscription + active-session changes
        // through these (NOT bare `client.subscribedSessionIds.add()` /
        // `client.activeSessionId = x`) so the sessionId→clients reverse index
        // can never drift from the per-client Sets.
        subscribeClient: (client, sid) => {
          // #5704: an EXPLICIT subscribe (switch_session / subscribe_sessions /
          // session-create auto-sub all route through here) adopts the
          // subscription — zero any permission-induced refcount so permission
          // teardown can never tear down a subscription the client asked for.
          self._adoptPermissionSubscription(client.id, sid)
          self._clientManager.subscribe(client, sid)
        },
        unsubscribeClient: (client, sid) => {
          // #5704: an explicit unsubscribe also drops any permission refcount —
          // the client chose to stop watching; a later permission teardown must
          // not be a no-op-that-leaks the bookkeeping entry.
          self._adoptPermissionSubscription(client.id, sid)
          self._clientManager.unsubscribe(client, sid)
        },
        setActiveSession: (client, sid) => self._clientManager.setActiveSession(client, sid),
        // #5563: explicit primary-ownership surface. `updatePrimary` is the
        // first-input adoption path (claims if unclaimed, no-op if already
        // primary, REJECTED-without-side-effects if another client owns it).
        // `claimPrimary` is the explicit claim/hand-off path (force=true for an
        // operator-driven hand-off). `getPrimary`/`isPrimary` are reads used by
        // the input_conflict gate. `clearPrimary` is the destroy/cleanup path.
        updatePrimary: (sid, cid) => self._updatePrimary(sid, cid),
        claimPrimary: (sid, cid, opts) => self._claimPrimary(sid, cid, opts),
        getPrimary: (sid) => self._clientManager.getPrimary(sid),
        isPrimary: (sid, cid) => self._clientManager.isPrimary(sid, cid),
        clearPrimary: (sid) => self._clearPrimary(sid),
        // #5837: re-evaluate the terminal-mirror coalescer gate for a session
        // after its subscriber set changes (handlers call this on subscribe/
        // unsubscribe; departure is handled server-side in _handleClientDeparture).
        syncTerminalMirror: (sid) => self._syncTerminalMirror(sid),
        sendSessionInfo: (ws, sid) => self._sendSessionInfo(ws, sid),
        replayHistory: (ws, sid, opts) => self._replayHistory(ws, sid, opts),
        get clients() { return self.clients },
      },
      sessions: {
        get sessionManager() { return self.sessionManager },
        get cliSession() { return self.cliSession },
      },
      permissions: {
        permissions: this._permissions,
        get permissionAudit() { return self._permissionAudit },
        pendingPermissions: this._pendingPermissions,
        permissionSessionMap: this._permissionSessionMap,
        // #5704: the resolver in settings-handlers (WS permission_response) must
        // route its map delete through this so the permission-induced
        // subscription refcount is decremented in lockstep — same hook the HTTP
        // resolver uses via createPermissionHandler.
        unregisterPermissionRoute: (requestId) => self._unregisterPermissionRoute(requestId),
        questionSessionMap: this._questionSessionMap,
      },
      services: {
        get pushManager() { return self.pushManager },
        // #5510: pairing-approval primitive — host-level approve/deny handlers.
        get pairingManager() { return self._pairingManager },
        get checkpointManager() { return self._checkpointManager },
        // #6006: the token lifecycle manager — exposed so the primary-gated
        // `revoke_token` handler can fire the operator panic button
        // (TokenManager.revoke()). Null when auth is disabled (--no-auth).
        get tokenManager() { return self._tokenManager },
        get devPreview() { return self._devPreview },
        get webTaskManager() { return self._webTaskManager },
        get environmentManager() { return self.environmentManager },
        // #4835: per-device active-session memory. handleSwitchSession writes
        // here after every successful switch so the next reconnect can
        // restore the same session.
        get devicePreferences() { return self._devicePreferences },
        fileOps: this._fileOps,
        // Runtime config exposed to handlers so validators (e.g.
        // validateCwdAllowed) can consult workspaceRoots, feature flags,
        // etc. Late-bound so test harnesses that mutate this.config after
        // construction still see the updated value.
        get config() { return self.config },
        // #5554: the per-skill usage recorder lives on the SessionManager (it
        // records activations at session creation); the Skills inventory handler
        // reads its aggregates to join lastUsed / count / repos onto the snapshot.
        get skillsUsageRecorder() { return self.sessionManager?.skillsUsageRecorder ?? null },
        resolvePairRequester: (requestId, result) => self._resolvePairRequester(requestId, result),
        broadcastPairResolved: (requestId, reason) => self._broadcastPairResolved(requestId, reason),
        // #6277: the create gate reads this to HOLD a user-shell spawn pending
        // host approval. Late-bound so it tracks the server instance.
        get shellApprovalStore() { return self._shellApprovalStore },
        // #5966: the bounded RepoEventStore the GitHub-webhook receiver fills
        // (github-webhook.js) and the Control Room repo-events survey drains.
        // Lazily created on the first webhook delivery, so null until then —
        // the survey handler treats a null store as an empty (schema-valid) feed.
        get repoEventStore() { return self._repoEventStore ?? null },
        // #6691: the OrchestrationManager, wired for real in E-4. Null until then
        // (and whenever the feature is off) — the handlers treat a null manager
        // as "engine not running" and reply with an unavailable error.
        get orchestrationManager() { return self._orchestrationManager ?? null },
      },
      runtime: {
        get draining() { return self._draining },
        // Multi-provider data dirs (#2965): computed fresh each access so new
        // provider registrations are reflected without restarting the server.
        get projectsDirs() { return getProviderDataDirs().map(d => join(d, 'projects')) },
        get userAgentsDirs() { return getProviderDataDirs().map(d => join(d, 'agents')) },
        // #3637: stable per-session auto-evaluator iteration counter (#3186).
        // See WsServer constructor for the lifecycle rationale.
        evaluatorIterations: this._evaluatorIterations,
      },
    }
    // Fail loudly if the production ctx ever drifts from the declared shape.
    // #5579: deep assert so a CTX_NAMESPACES field forgotten on _handlerCtx
    // fails at construction, not as a silent `undefined` read in prod. The
    // deep check uses `key in bucket`, which does NOT invoke getters — so the
    // late-bound getter fields (config, skillsUsageRecorder, projectsDirs, …)
    // are verified present without triggering their side effects. One-time
    // cost at startup is acceptable.
    assertCtxShape(this._handlerCtx, { deep: true })

    // Context objects for extracted modules (ws-auth.js, ws-history.js)
    this._historyCtx = {
      get clients() { return self.clients },
      // #5563: index-maintaining active-session mutator for the post-auth
      // restore path (ws-history.js sets activeSessionId once per connect).
      setActiveSession: (client, sid) => self._clientManager.setActiveSession(client, sid),
      // #5731 T5 / #5623 / #5613: current primary owner for a session, so
      // sendSessionInfo can re-sync `session_role` on reconnect/tab-switch
      // (otherwise the presence badge goes stale — the role is only ever
      // broadcast on an actual primary change via _announcePrimary).
      getPrimary: (sid) => self._clientManager.getPrimary(sid),
      get sessionManager() { return self.sessionManager },
      get cliSession() { return self.cliSession },
      get defaultSessionId() { return self.defaultSessionId },
      get serverMode() { return self.serverMode },
      serverVersion: SERVER_VERSION,
      get latestVersion() { return self._latestVersion },
      get gitInfo() { return self._gitInfo },
      get encryptionEnabled() { return self._encryptionEnabled },
      // #5536 — identity keypair for signing the eager exchange public key.
      get serverIdentity() { return self._serverIdentity },
      get localhostBypass() { return self._localhostBypass },
      // #6564 — a POSITIVE "an edge could be in front" signal. Any of: a running
      // Quick/named tunnel (_quickTunnelActive / _tunnelUrl), OR an operator-supplied
      // external URL (config.externalUrl — SKIP_TUNNEL mode, where the operator runs
      // their own reverse proxy in front, exactly the unknown-edge case). When true,
      // the localhost plaintext bypass is gated off (see ws-history).
      get tunnelActive() { return self._quickTunnelActive || self._tunnelUrl != null || Boolean(self.config?.externalUrl) },
      get keyExchangeTimeoutMs() { return self._keyExchangeTimeoutMs },
      protocolVersion: SERVER_PROTOCOL_VERSION,
      minProtocolVersion: MIN_PROTOCOL_VERSION,
      get webTaskManager() { return self._webTaskManager },
      send: sendFn,
      broadcast: broadcastFn,
      getConnectedClientList: () => self._getConnectedClientList(),
      get permissions() { return self._permissions },
      // #3760: effective inactivity timeout, surfaced in auth_ok so clients
      // render their ActivityIndicator timeout warning against the real
      // configured value. Late-bound so test harnesses mutating this.config
      // after construction are reflected. #3905 adds the parallel hard-cap.
      get resultTimeoutMs() { return self.config?.resultTimeoutMs ?? null },
      get hardTimeoutMs() { return self.config?.hardTimeoutMs ?? null },
      // #4477: effective stream-stall recovery window in ms. null = use
      // BaseSession's DEFAULT_STREAM_STALL_TIMEOUT_MS (5min); 0 = operator
      // explicitly disabled stall recovery (preserved as-is on the wire so
      // the dashboard chip can hide instead of rendering against a
      // disabled timer).
      get streamStallTimeoutMs() { return self.config?.streamStallTimeoutMs ?? null },
      // #5986 (epic #5982): whether the embedded user-shell terminal is enabled
      // (userShell.enabled). Surfaced in auth_ok's capability map so the
      // dashboard can show/hide the "New shell" affordance fail-closed (the
      // user-shell provider is hidden from listProviders, so the picker can't
      // advertise it). Late-bound getter so a test mutating self.config is seen.
      get userShellEnabled() { return isUserShellEnabled(self.config) },
      // #6481 (epic #6469): whether the opt-in IDE feature surface is enabled on
      // this server (config.features.ide / CHROXY_ENABLE_IDE). Surfaced as the
      // `ide` capability so clients gate IDE UI. Late-bound getter so a test
      // mutating self.config is seen.
      get ideEnabled() { return isIdeFeatureEnabled(self.config) },
      // #6691: whether the orchestration harness is enabled on THIS server,
      // surfaced as the `orchestration` capability so the dashboard reveals the
      // Runs surface. Server-wide gate, not token-scoped; fail-closed.
      get orchestrationEnabled() { return isOrchestrationEnabled(self.config) },
      // #6006: whether the operator panic button (revoke_token) can fire — true
      // iff a usable rotating TokenManager exists (i.e. auth is on). Mirrors the
      // token-handlers availability check (`typeof revoke === 'function'`) so the
      // capability never advertises a button that would only get REVOKE_UNAVAILABLE.
      // Surfaced as the `tokenRevoke` capability, further gated to primary-token
      // clients in ws-history so a paired device never sees the affordance.
      get tokenRevocable() { return self._tokenManager != null && typeof self._tokenManager.revoke === 'function' },
      // #4835: per-device active-session memory consulted during reconnect.
      // sendPostAuthInfo treats this as optional, but production wiring
      // always supplies the default disk-backed store from the WsServer
      // constructor.
      get devicePreferences() { return self._devicePreferences },
      // #5356: exposure snapshot (non-loopback bind / public quick tunnel)
      // surfaced in auth_ok so the dashboard can render a warning banner.
      // null until start() has bound a socket.
      get exposure() { return self.exposure },
      // #5821: current billing-canary snapshot, seeded into auth_ok so a
      // freshly-connected client renders the billing banner immediately. null
      // until a provider is wired (server-cli sets it post-construct) — live
      // changes still arrive via the `billing_canary` broadcast.
      get billingCanary() {
        try { return self._billingCanaryProvider ? self._billingCanaryProvider() : null }
        catch { return null }
      },
      // #5555 (auth_bootstrap): file ops + provider agent dirs so the
      // connect-time bootstrap burst can compute the slash-command / agent
      // lists inline (same payloads the list_* request handlers produce),
      // letting the client skip its 3-request connect-time round trip.
      get fileOps() { return self._fileOps },
      get userAgentsDirs() { return getProviderDataDirs().map(d => join(d, 'agents')) },
      // #5555 (sub-item 7): the current public tunnel URL (wss://), folded into
      // the auth_bootstrap burst so a reconnecting client always re-learns the
      // live URL — the durable recovery path when a quick-tunnel rotation
      // happened while the client was offline. null for LAN / no-tunnel.
      get tunnelUrl() { return self._tunnelUrl },
    }
    this._authCtx = {
      get clients() { return self.clients },
      get authRequired() { return self.authRequired },
      isTokenValid: (token) => self._isTokenValid(token),
      get authFailures() { return self._authFailures },
      get benignPairAttempts() { return self._benignPairAttempts },
      get pairingManager() { return self._pairingManager },
      // #5536 — identity keypair for signing the discrete exchange public key.
      get serverIdentity() { return self._serverIdentity },
      get activeSessionId() {
        // Linking-mode default: return null so paired tokens are NOT auto-bound
        // to a specific session. The QR shown by the dashboard is intended as a
        // general "link this device" code that lets the app create/switch
        // sessions freely. Auto-binding to defaultSessionId/firstSessionId
        // (the prior behavior) silently produced session-locked tokens, so
        // every newly-paired phone hit "Device paired to one session" the
        // moment it tried to open another tab.
        //
        // Session-bound pairings are still possible via the per-client
        // boundSessionId path; a future "Share this session" UI can opt in by
        // creating a session-scoped pairing through a different code path.
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
      // #5510: register the requester's still-open ws so a later approve/deny
      // can reach it, and fan `pair_pending` out to host-level surfaces.
      registerPairRequester: (requestId, ws) => self._pairRequesters.set(requestId, ws),
      broadcastPairPending: (msg) => self._broadcastPairPending(msg),
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
    // #6691 (E-4): the OrchestrationManager (null when the feature is off). Its
    // run_delta events are forwarded to host-level clients by server-cli via
    // _broadcastOrchestrationDelta; the handlers read it off ctx.services.
    this._orchestrationManager = orchestrationManager || null
    this.defaultSessionId = defaultSessionId || null
    this._checkpointManager = new CheckpointManager()

    // Register/unregister per-session hook secrets and clean up checkpoints on lifecycle events.
    // Handlers are stored on `this` so close() can remove them — without this, a long-lived
    // SessionManager keeps every retired WsServer pinned in memory and replays events to
    // closed instances. Symmetric with _pairingRefreshedHandler / _tokenRotatedHandler.
    if (sessionManager && typeof sessionManager.on === 'function') {
      this._sessionCreatedHandler = ({ sessionId }) => {
        const entry = sessionManager.getSession(sessionId)
        this._registerSessionHookSecretIfMissing(sessionId, entry)
        this._attachPermissionAuditSink(sessionId, entry)
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
        // #5731 T7: auto-deny any pending HTTP-hook permission for this session
        // BEFORE we drop its map entries below. Otherwise the hook's parked
        // POST /permission blocks the tool call for the full 5-min timeout,
        // then fires on a destroyed session, leaking the held response until
        // then. drainSessionPermissions() resolves each as 'deny' (its shared
        // cleanup also removes the requestId from _permissionSessionMap); the
        // loop below then only mops up any orphaned mapping with no live
        // pending entry.
        try {
          this._permissions?.drainSessionPermissions?.(sessionId)
        } catch (err) {
          log.warn(`Failed to drain pending permissions for destroyed session ${sessionId}: ${err.message}`)
        }
        // #5704: route the orphan sweep through _unregisterPermissionRoute so a
        // destroyed session's permission-induced subscriptions are torn down,
        // not just the map entry. Collect keys first to avoid mutating the map
        // mid-iteration (_unregisterPermissionRoute deletes the entry).
        for (const key of [...this._permissionSessionMap.keys()]) {
          if (this._permissionSessionMap.get(key) === sessionId) this._unregisterPermissionRoute(key)
        }
        for (const [key, sid] of this._questionSessionMap) {
          if (sid === sessionId) this._questionSessionMap.delete(key)
        }
        // #3637: drop the auto-evaluator iteration counter entry for the
        // destroyed session. The Map would otherwise grow unboundedly
        // over the server's lifetime — small leak (one int per session)
        // but a long-running server with many session destroys would
        // accumulate dead entries.
        this._evaluatorIterations.delete(sessionId)
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
        // #3061: defensive — if the SdkSession requestId gate is ever widened
        // (e.g. to propagate AskUserQuestion lifecycle events), don't silently
        // write audit entries with requestId: undefined. Today this branch is
        // unreachable because sdk-session.js gates the re-emit on data.requestId.
        if (!data.requestId) return
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

      // Retroactively register hook secrets for sessions that already exist
      // on this SessionManager. server-cli.js calls sessionManager.restoreState()
      // BEFORE constructing the WsServer, so the session_created events fire
      // before _sessionCreatedHandler is attached and restored sessions never
      // get their _hookSecret registered. Result: every POST /permission from
      // a restored session's hook script fails _validateHookAuth with 403,
      // the curl response has no `decision` field, and the script returns
      // "ask" — surfacing as "Hook PreToolUse:Bash asked for confirmation"
      // with no dashboard prompt ever appearing (#3716).
      // Guard: many tests pass a stub sessionManager without _sessions.
      // Resolve each entry through getSession() so we skip sessions marked
      // _destroying — matches what _sessionCreatedHandler above does and
      // mirrors clearAllPendingPermissions() at line 1443.
      if (sessionManager._sessions instanceof Map && typeof sessionManager.getSession === 'function') {
        for (const [sessionId, entry] of sessionManager._sessions) {
          if (entry?._destroying) continue
          const resolved = sessionManager.getSession(sessionId)
          this._registerSessionHookSecretIfMissing(sessionId, resolved)
          // #6830 — restored sessions predate this WsServer (restoreState runs
          // before construction, same shape as the #3716 hook-secret gap), so
          // their persisted-rule audit sinks must be wired retroactively too.
          this._attachPermissionAuditSink(sessionId, resolved)
        }
      }
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
    // #5516/#5562: hand the normalizer a subscriber-count resolver so it can
    // tighten the fixed delta micro-batch window (16→8ms) when a session has a
    // single subscriber — the common phone-on-LAN / single-dashboard case.
    // Multi-client sessions keep the 16ms window (fan-out amortization). These
    // are fixed micro-batch windows, not an adaptive throttle — the adaptive
    // part is the client-side store-core EWMA (resolveDeltaFlushMs); #5562
    // shrank the server window from 25/50ms so it no longer stacks on top of
    // that EWMA. Legacy single-session mode (sessionId === null) reports null
    // (unknown), which the normalizer treats as "keep the default window".
    // #5578: also hand it a deflate-subscriber predicate so the window can
    // widen (8/16 → 16/25ms) when any subscriber is on a deflate-negotiated
    // (tunnel/cellular) socket, where each sub-1024B stream_delta ships
    // uncompressed and the per-frame small-packet cost dominates. O(subscribers)
    // via the #5575 reverse index — never an O(all-clients) scan on the
    // per-token hot path. Legacy single-session mode (sessionId === null) can't
    // resolve subscribers, so it reports false → keeps the LAN window.
    this._normalizer = new EventNormalizer({
      getSubscriberCount: (sessionId) =>
        sessionId == null ? null : this._broadcaster._countSessionSubscribers(sessionId),
      getHasDeflateSubscriber: (sessionId) =>
        sessionId == null ? false : this._broadcaster._hasDeflateSubscriber(sessionId),
    })
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
    this._pendingRequestExpiredHandler = null
    if (this._pairingManager) {
      this._pairingRefreshedHandler = () => {
        this._broadcast({ type: 'pairing_refreshed' })
        log.debug('Broadcasted pairing_refreshed to all clients')
      }
      this._pairingManager.on('pairing_refreshed', this._pairingRefreshedHandler)

      // #5510: a pending pair request hit its TTL while still unresolved. Tell
      // the requester (its connection may still be open) and retract the banner
      // on every host surface.
      this._pendingRequestExpiredHandler = ({ requestId }) => {
        this._resolvePairRequester(requestId, { ok: false, reason: 'expired' })
        this._broadcastPairResolved(requestId, 'expired')
      }
      this._pairingManager.on('pending_request_expired', this._pendingRequestExpiredHandler)
    }

    // Wire TokenManager rotation events — broadcast new token to all clients
    this._tokenRotatedHandler = null
    if (this._tokenManager) {
      this._tokenRotatedHandler = ({ newToken, expiresAt, reason }) => {
        // Update our reference so subsequent auth checks use the new token
        this.apiToken = newToken

        if (reason === 'revoke') {
          // #6006 panic button. The old token is compromised and we cannot tell
          // an attacker's connection from a legitimate one — every connection
          // authenticated with the same now-suspect token. So:
          //   (a) sever every privileged user-shell session, and
          //   (b) force EVERY connection to re-authenticate: clear
          //       `authenticated` + `isPrimaryToken` so the dispatch gate
          //       (_handleMessage) rejects all privileged ops — including a
          //       re-create of the shell — until the connection re-auths with
          //       the current token, obtained out-of-band (re-pair / re-scan).
          // We deliberately do NOT push the new token to any client, even
          // encrypted ones: handing it down a possibly-compromised connection
          // would defeat the revoke. The token-less `token_rotated` already
          // drives clients onto their "must re-authenticate" path.
          let severed = 0
          try {
            severed = this.sessionManager?.destroyAllUserShellSessions('revoked') ?? 0
          } catch (err) {
            log.error(`Failed to sever user-shell sessions on revoke: ${err.message}`)
          }
          let forced = 0
          for (const [ws, client] of this.clients) {
            // Skip connections still mid-handshake (not yet authenticated): they
            // hold no authority to strip and will fail their pending auth step
            // against the now-current token on their own.
            if (!client.authenticated || ws.readyState !== 1) continue
            client.authenticated = false
            client.isPrimaryToken = false
            this._send(ws, { type: 'token_rotated', expiresAt, reason: 'revoke' })
            forced++
          }
          log.warn(`Token REVOKED — severed ${severed} user-shell session(s), forced re-auth on ${forced} connection(s)`)
          return
        }

        // Scheduled/periodic rotation — graceful re-key, live sessions survive.
        // Send the new token to encrypted clients (they need it for reconnection).
        // Unencrypted clients (e.g. localhost dashboard) get the event without the
        // raw token to avoid leaking credentials over plaintext connections.
        let encrypted = 0, unencrypted = 0
        for (const [ws, client] of this.clients) {
          if (!client.authenticated || ws.readyState !== 1) continue
          // Carry `reason: 'scheduled'` so the wire is self-describing and
          // matches the documented contract + TokenManager's event payload.
          if (client.encryptionState) {
            this._send(ws, { type: 'token_rotated', token: newToken, expiresAt, reason: 'scheduled' })
            // #6012: this connection just received the new token, so refresh the
            // token recorded at auth — an honest, still-connected encrypted
            // primary can then open a NEW user-shell (#6004 gate) without a
            // reconnect. Only on a SCHEDULED push: revoke never pushes the token
            // and de-auths instead, so a compromised connection can't gain
            // currency this way. Unencrypted clients get no token, so theirs
            // stays stale (they must reconnect) — handled by the else branch.
            client.authToken = newToken
            encrypted++
          } else {
            this._send(ws, { type: 'token_rotated', expiresAt, reason: 'scheduled' })
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
   * Validate that an HTTP request carries the PRIMARY token class — i.e. the
   * static apiToken (or an active rotation/grace token), NOT a pairing-bound
   * session token. Used by host-authority endpoints that a scoped, paired
   * device must not be able to invoke (#5533): e.g. POST /pair-discord, which
   * posts a fresh pairing link to a shared channel. Per
   * docs/security/bearer-token-authority.md, pairing-bound tokens are scoped to
   * one session and must never carry host-level authority.
   *
   * A token is primary iff it validates but is NOT a PairingManager-issued
   * session token. Returns true on pass; writes a 403 and returns false
   * otherwise.
   */
  _validatePrimaryBearerAuth(req, res) {
    if (!this.authRequired) return true
    const authHeader = req.headers['authorization'] || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token || !this._isTokenValid(token)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return false
    }
    // Reject pairing-bound (and any other PairingManager-issued) session tokens:
    // they are valid, but scoped — not the host-authority primary token.
    if (this._pairingManager && this._pairingManager.isSessionTokenValid(token)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'primary_token_required' }))
      return false
    }
    return true
  }

  /**
   * #6277 — complete a host-approved user-shell spawn. Resolves the requesting
   * socket from the client map (it may be GONE if the requester disconnected
   * during the approval window — that's tolerated: the session is still created
   * + audited + broadcast to other clients, only the requester notify is
   * skipped) and replays finalizeShellCreate with the audit identity captured at
   * request time. Returns the created sessionId; throws on a create failure
   * (the caller maps it to an HTTP 500).
   *
   * @param {object} entry - the resolved pending-approval entry from the store
   * @returns {string} sessionId
   */
  completeShellApproval(entry) {
    let ws = null
    let client = null
    for (const [sock, c] of this.clients) {
      if (c?.id === entry.clientId) { ws = sock; client = c; break }
    }
    return finalizeShellCreate(ws, client, entry.createSessionOptions, this._handlerCtx, {
      isUserShell: true,
      tokenClass: entry.tokenClass || 'primary',
      deviceName: entry.deviceName,
      clientId: entry.clientId,
    })
  }

  /**
   * #6277 — tell the requester their shell was declined by the host operator.
   * No-op if the requesting socket is already gone.
   * @param {object} entry - the resolved pending-approval entry
   */
  notifyShellDenied(entry) {
    for (const [sock, c] of this.clients) {
      if (c?.id === entry.clientId) {
        this._handlerCtx.transport.send(sock, {
          type: 'session_error',
          code: 'SHELL_APPROVAL_DENIED',
          message: 'The host operator declined this shell.',
        })
        break
      }
    }
  }

  /**
   * #6277 — start the host-local user-shell approval listener.
   *
   * A SEPARATE HTTP server bound to 127.0.0.1 ONLY, on an ephemeral port the
   * Cloudflare tunnel never forwards (cloudflared only proxies the main port).
   * This separation is the load-bearing security property: a loopback check on
   * the MAIN port would be defeated because cloudflared makes tunnel traffic
   * arrive as 127.0.0.1, so a leaked-token attacker over the tunnel could
   * approve their own held shell. Only the host can reach this listener; the
   * primary-token check then narrows it to the operator. The port is published
   * to a 0600 file for the `chroxy shell approve` CLI.
   */
  _startApprovalListener() {
    this._approvalServer = createServer((req, res) => this._handleApprovalRequest(req, res))
    this._approvalServer.on('error', (err) => {
      log.error(`[shell-approval] listener error: ${err.message}`)
    })
    this._approvalServer.listen(0, '127.0.0.1', () => {
      const port = this._approvalServer.address()?.port
      this._shellApprovalPort = port
      try {
        writeShellApprovalInfo({ port, pid: process.pid })
        log.info(`[shell-approval] host-local approval listener on 127.0.0.1:${port} — user-shell spawns require \`chroxy shell approve\``)
      } catch (err) {
        log.error(`[shell-approval] failed to publish approval port: ${err.message}`)
      }
    })
  }

  /**
   * #6277 — request handler for the host-local approval listener. Serves only
   * POST /api/shell/approve, POST /api/shell/deny, GET /api/shell/pending. The
   * listener is already 127.0.0.1-bound, but the kernel socket-IP is re-checked
   * (defense-in-depth against a future bind mistake) and every route requires
   * the primary token.
   */
  _handleApprovalRequest(req, res) {
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    // Defense-in-depth: bound to 127.0.0.1, but re-verify the kernel-supplied
    // socket IP so a future 0.0.0.0 bind mistake can't quietly expose this.
    const socketIp = req.socket?.remoteAddress || ''
    if (!LOOPBACK_ADDRESSES.has(socketIp)) return json(403, { error: 'loopback_only' })
    // Host-OPERATOR authority: rejects pairing-bound tokens (writes its own 403).
    // Under --no-auth (no token configured) this passes through, consistent with
    // chroxy's local-trust model — the listener is still loopback-only (not
    // tunnel-reachable) and the create-side gate is equally token-free there.
    if (!this._validatePrimaryBearerAuth(req, res)) return
    const path = (req.url || '').split('?')[0]
    const store = this._shellApprovalStore
    if (req.method === 'GET' && path === '/api/shell/pending') {
      return json(200, { pending: store.list() })
    }
    if (req.method === 'POST' && (path === '/api/shell/approve' || path === '/api/shell/deny')) {
      let id = null
      try { id = new URL(req.url, 'http://localhost').searchParams.get('id') } catch { /* malformed url */ }
      if (!id) return json(400, { error: 'missing_id' })
      const isApprove = path === '/api/shell/approve'
      const result = isApprove ? store.approve(id) : store.deny(id)
      if (!result.ok) return json(result.reason === 'not_found' ? 404 : 403, { error: result.reason })
      if (isApprove) {
        try {
          return json(200, { ok: true, sessionId: this.completeShellApproval(result.entry) })
        } catch (err) {
          log.warn(`[shell-approval] approve ${id}: create failed: ${err.message}`)
          return json(500, { error: 'create_failed', message: err.message })
        }
      }
      try { this.notifyShellDenied(result.entry) } catch { /* requester socket gone */ }
      return json(200, { ok: true })
    }
    return json(404, { error: 'not_found' })
  }

  /**
   * Post an approval-gated pairing link to the configured Discord webhook
   * (#5513). Thin seam around discord-pair-delivery.postPairLinkToDiscord so
   * http-routes can call it and tests can stub it. Never logs / returns the
   * webhook URL.
   */
  async _postPairLinkToDiscord(link) {
    return postPairLinkToDiscord(link)
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
   * Register a session's hook secret on this WsServer if not already tracked.
   * Shared by the `session_created` handler and the constructor's retroactive
   * scan over `sessionManager._sessions` (#3716, #3717). Caller is responsible
   * for the outer `instanceof Map` check and any `_destroying` skip on the raw
   * map entry; this helper handles the missing-secret and dedupe guards.
   */
  _registerSessionHookSecretIfMissing(sessionId, entry) {
    const secret = entry?.session?._hookSecret
    if (!secret) return
    if (this._sessionHookSecrets.has(sessionId)) return
    this.registerHookSecret(secret)
    this._sessionHookSecrets.set(sessionId, secret)
    log.debug(`Registered hook secret for session ${sessionId}`)
  }

  /**
   * #6830 (PR #6842 review) — wire this server's PermissionAuditLog straight
   * into a session's persisted-rule audit path. Called from the
   * `session_created` handler AND the constructor's retroactive scan (same
   * dual wiring as _registerSessionHookSecretIfMissing, for the same #3716
   * restored-session reason).
   *
   * A persisted-rule auto-approve deliberately bypasses the whole
   * session-event pipeline: emitting `permission_resolved` for it would ride
   * ws-forwarding → broadcastToSession to every client on EVERY rule-matched
   * tool call (the PR #6842 review finding). The sink is a plain callback
   * into logPersistedRuleApproval, which also COALESCES repeats per
   * (sessionId, tool, projectKey) so the 500-entry ring is never flooded.
   *
   * The closure captures ONLY the audit log + sessionId — never `this` — so
   * a session outliving a retired WsServer pins a small ring buffer, not the
   * whole server (the #3060 concern that motivated the removable
   * session_event listeners). Single-slot on the manager side: a replacement
   * WsServer's attach overwrites this one (last writer wins).
   *
   * @param {string} sessionId
   * @param {object|null} entry - SessionManager entry ({ session, ... })
   */
  _attachPermissionAuditSink(sessionId, entry) {
    const session = entry?.session
    if (typeof session?.setPermissionAuditSink !== 'function') return
    const audit = this._permissionAudit
    session.setPermissionAuditSink((info) => {
      audit.logPersistedRuleApproval({ sessionId, tool: info?.tool, projectKey: info?.projectKey ?? null })
    })
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

  /**
   * #5356: record whether the configured tunnel is a public quick
   * (trycloudflare) tunnel. Called by server-cli before tunnel startup so the
   * exposure snapshot in auth_ok reflects the public URL.
   * @param {boolean} active
   */
  setQuickTunnelActive(active) {
    this._quickTunnelActive = !!active
  }

  /**
   * #5555 (sub-item 7): record the server's current public tunnel URL as a
   * `wss://` endpoint. Called by server-cli once the tunnel is up (and on a
   * URL rotation via broadcastTunnelUrlChanged). Surfaced in the
   * auth_bootstrap burst so a reconnecting client always re-learns the live
   * URL — the durable recovery path when a rotation happened while the client
   * was offline. Pass `null` to clear (no tunnel).
   * @param {string|null} wsUrl
   */
  setTunnelUrl(wsUrl) {
    this._tunnelUrl = wsUrl || null
  }

  /** #5555 (sub-item 7): the current `wss://` tunnel URL, or null. */
  get tunnelUrl() {
    return this._tunnelUrl
  }

  /**
   * #5555 (sub-item 7): a quick-tunnel recovery rotated the public URL. Record
   * the new URL (so reconnecting clients get it via auth_bootstrap) and push a
   * `tunnel_url_changed` frame to every authenticated client so they can
   * update the stored endpoint their reconnect path dials.
   *
   * BEST-EFFORT for tunnel-connected clients: they reach the server THROUGH
   * the old tunnel, which has just died, so the push usually will not arrive —
   * their durable recovery is the auth_bootstrap `tunnelUrl` on next connect.
   * LAN-connected clients (localhost dashboard, LAN clients) keep their socket
   * across the rotation and get the new URL immediately.
   *
   * SECURITY: the tunnel URL is connection metadata, not a secret (the QR code
   * shares it), so it goes to ALL authenticated clients including
   * pairing-bound ones — see docs/security/bearer-token-authority.md.
   *
   * @param {string} newWsUrl  the new `wss://` endpoint
   * @param {string|null} [previousWsUrl]  the prior `wss://` endpoint, if known
   */
  broadcastTunnelUrlChanged(newWsUrl, previousWsUrl = null) {
    if (!newWsUrl) return
    this.setTunnelUrl(newWsUrl)
    this._broadcast({
      type: 'tunnel_url_changed',
      url: newWsUrl,
      ...(previousWsUrl ? { previousUrl: previousWsUrl } : {}),
    })
  }

  /**
   * #5356: exposure snapshot included in auth_ok (see sendPostAuthInfo).
   * `null` until start() has bound a socket — test harnesses that never call
   * start() simply omit the field from auth_ok.
   * @returns {{ lanBind: boolean, bindHost: string, quickTunnel: boolean }|null}
   */
  get exposure() {
    if (this._boundHost === undefined) return null
    return {
      lanBind: !isLoopbackHost(this._boundHost),
      bindHost: this._boundHost,
      quickTunnel: this._quickTunnelActive,
    }
  }

  start(host) {
    // #5356: remember what we bound. `undefined` means the default
    // all-interfaces bind — record it as 0.0.0.0 so exposure reads true.
    this._boundHost = host ?? '0.0.0.0'
    // Create HTTP server — route handling extracted to http-routes.js
    this.httpServer = createServer(createHttpHandler(this))

    // WebSocket server in noServer mode — we handle the upgrade manually
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this._maxPayload,
      // #5516 (epic #5514): permessage-deflate is enabled here for ALL
      // connections (tunnel bandwidth saving). It is then SKIPPED per-connection
      // for local/LAN peers in the 'upgrade' handler below (strip the client's
      // Sec-WebSocket-Extensions header before handleUpgrade) — local links
      // aren't bandwidth-bound, so compressing every frame just adds CPU
      // latency. Choosing skip-on-local over a blanket higher threshold keeps
      // tunnel behavior byte-for-byte unchanged.
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
      // #5516 (epic #5514): skip permessage-deflate for local/LAN peers. On a
      // fast local link compressing every message buys nothing (the link isn't
      // the bottleneck) and just adds CPU latency on the dev machine. Tunnel
      // connections KEEP deflate — that's where the WAN bandwidth saving is
      // real. `ws` negotiates permessage-deflate from the client's
      // Sec-WebSocket-Extensions request header, so deleting it for a local
      // peer makes `handleUpgrade` complete WITHOUT compression for THIS socket
      // only — the server-level config still applies to tunnel connections.
      // Security: isLocalOrLanPeer keys off the unspoofable socket peer; a
      // forged proxy header can only KEEP deflate (the safe default), never
      // remove it. See connection-locality.js.
      // #5578: stash the locality decision on `req` so the 'connection' handler
      // can stamp a per-client `usesDeflate` flag without re-classifying. A
      // LAN/loopback peer had its extension header stripped (no deflate); any
      // other peer keeps the server-level permessage-deflate. The flag drives
      // the deflate-aware delta-coalescing window (see EventNormalizer /
      // ws-broadcaster `_hasDeflateSubscriber`). Keyed off the unspoofable
      // socket peer, identical to the strip decision — they can never diverge.
      const localPeer = isLocalOrLanPeer(req)
      req._chroxyUsesDeflate = !localPeer
      // #6562: carry the same upgrade-time locality CLASSIFICATION (unspoofable
      // socket peer + proxy-header ABSENCE) to the encryption decision.
      // isLocalOrLanPeer is false when proxy headers are present, so a
      // cloudflared-tunneled connection (which arrives at socketIp 127.0.0.1 but
      // carries cf-connecting-ip) is NOT classified local — the loopback
      // encryption bypass (ws-history.js) must consult this so tunneled clients
      // still do the key_exchange instead of a plaintext downgrade. Header absence
      // is a weak positive signal (see #6564), but the security-relevant direction
      // is safe: an attacker can't strip cloudflared's edge-stamped header to gain
      // the bypass.
      req._chroxyLocalPeer = localPeer
      if (localPeer) {
        delete req.headers['sec-websocket-extensions']
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
        // #5563: stable back-reference to this client's socket so the
        // sessionId→clients reverse index (which stores `client`) can resolve
        // the `ws` for readyState + backpressure without a per-send Map lookup.
        _ws: ws,
        authenticated: false,
        // #5985b: a fresh client is never the primary token class until
        // handleAuthMessage proves it. Initialized false (not left undefined) so
        // the strict `=== true` user-shell gates fail closed even if a future
        // code path reads the field before auth completes.
        isPrimaryToken: false,
        mode: 'chat', // default to chat view
        activeSessionId: null,
        subscribedSessionIds: new Set(),
        // #5835 Phase 1: sessions this client opted into LIVE TERMINAL output for
        // (terminal_subscribe). Kept separate from subscribedSessionIds so a
        // Chat-tab client subscribed to a session doesn't receive its raw PTY
        // mirror bytes — only clients actually viewing the terminal do.
        terminalSessionIds: new Set(),
        isAlive: true,
        deviceInfo: null,
        ip,
        socketIp,
        rateLimitKey,
        // #5578: true for a non-LAN peer (tunnel / remote) that kept the
        // server-level permessage-deflate; false for LAN/loopback peers whose
        // extension header was stripped at upgrade. This is the upgrade-time
        // LOCALITY decision, not the actual negotiated extension — a remote
        // client that declines deflate in its handshake still reads true, which
        // is the intended (and safe) direction: those links pay the same WAN
        // per-frame cost. Drives the deflate-aware delta-coalescing window
        // — see EventNormalizer._resolveFlushIntervalMs. Set from the
        // unspoofable upgrade-time locality decision (req._chroxyUsesDeflate).
        usesDeflate: req._chroxyUsesDeflate === true,
        // #6562: true only for a genuine loopback/LAN peer with NO proxy headers
        // — i.e. NOT a cloudflared-tunneled connection. Gates the loopback
        // encryption bypass so a tunneled (proxied) connection to socketIp
        // 127.0.0.1 is not treated as trusted-local and still requires E2E.
        localPeer: req._chroxyLocalPeer === true,
        // #3404: visible defaults to true; mobile flips to false on backgrounding
        // so completion push notifications fire instead of being suppressed by
        // a still-alive but invisible WS connection.
        visible: true,
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
        // #5555.6 — any inbound frame is proof of life. The client's 15s
        // heartbeat ping is the dominant signal, but ANY decoded frame (input,
        // subscribe, pong-as-message, …) resets the liveness flag so the 15s
        // keepalive sweep never terminates a client that is actively talking.
        // This is the "client ping IS liveness" half of #5555.6; the protocol
        // `pong` listener on the socket covers the server-initiated ping.
        if (client) client.isAlive = true
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
        // #5510: if a pair requester (unauthenticated, connection-pending) drops
        // before resolution, deny + drop its queue entry and retract the host
        // banner so an abandoned request can't sit on a queue slot for its TTL.
        this._cleanupPairRequesterOnDisconnect(ws)
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

    // #6277 — host-local user-shell approval listener. Started only when approval
    // is enabled at boot (off by default → the WsServer test harness is
    // untouched). See _startApprovalListener for why it's a separate
    // 127.0.0.1-only server rather than a main-port route.
    if (isUserShellApprovalRequired(this.config)) {
      this._startApprovalListener()
    }

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
    //
    // #4787 (P0 security): unscoped log entries (no entry.sessionId) MUST NOT
    // fan out to bound clients (mobile pairings into a single per-task
    // session) — pre-fix, server-side logs that lacked withSession() context
    // leaked PTY hex dumps, toolUseIds, prompt sizes and attachment names from
    // every session to every authenticated WS client. Most server logs are
    // unscoped today (only a handful of call sites use withSession()), so the
    // fall-through covered almost the entire log stream. Restrict unscoped
    // entries to unbound clients (operator dashboards have boundSessionId ==
    // null and legitimately want to see everything). The durable fix — a
    // loggerForSession factory + lint to force per-call-site scoping — is
    // tracked as a follow-up (#4792).
    let inLogBroadcast = false
    this._logListener = (entry) => {
      if (inLogBroadcast) return
      inLogBroadcast = true
      try {
        if (entry.sessionId) {
          this._broadcastToSession(entry.sessionId, { type: 'log_entry', ...entry })
        } else {
          // Use loose-equality null check so any non-null/undefined
          // boundSessionId (including the unlikely empty string) is treated
          // as bound — matches the comment above and the intent of #4787.
          this._broadcast(
            { type: 'log_entry', ...entry },
            (client) => client.boundSessionId == null
          )
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
      checkpointManager: this._checkpointManager,
      pushManager: this.pushManager,
      permissionSessionMap: this._permissionSessionMap,
      questionSessionMap: this._questionSessionMap,
      // #4788 Wave 2: hand the question-route registration through a helper so
      // dispatch and routing-guard stay symmetric. When a question is
      // registered for session S, every currently-connected client that's
      // permitted to see broadcasts for S gets auto-subscribed to S — this
      // mirrors _broadcastToSession's recipient filter so the new
      // input-handlers guard naturally passes for legitimate viewers without
      // re-opening the cross-session hijack vector (unconnected / future
      // clients are still unable to answer).
      registerQuestionRoute: (toolUseId, sessionId) => this._registerQuestionRoute(toolUseId, sessionId),
      // #4798: symmetry with registerQuestionRoute — auto-subscribe eligible
      // clients to the permission's session at dispatch time so the
      // settings-handlers subscription guard naturally passes for legitimate
      // viewers (including the "view A → switch to B → respond" flow).
      registerPermissionRoute: (requestId, sessionId) => this._registerPermissionRoute(requestId, sessionId),
      broadcast: (msg, filter) => this._broadcast(msg, filter),
      broadcastToSession: (sid, msg, filter) => this._broadcastToSession(sid, msg, filter),
      broadcastSessionList: () => this._handlerCtx.transport.broadcastSessionList(),
    })

    // #5555.6 — sweep authenticated clients every KEEPALIVE_SWEEP_MS. See
    // _keepaliveSweep for the liveness/eviction contract.
    this._pingInterval = setInterval(() => this._keepaliveSweep(), KEEPALIVE_SWEEP_MS)

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
    // #6822: point the MCP OAuth redirect at this daemon's loopback callback so a
    // desktop-local browser auto-completes the flow; remote/tunneled browsers
    // that can't reach loopback fall back to the paste-code path. An operator
    // override (CHROXY_MCP_OAUTH_REDIRECT_URI) still wins inside the module.
    try { setMcpOAuthCallbackBase(`http://127.0.0.1:${this.port}`) } catch { /* best-effort */ }
  }

  /**
   * #5821: wire the billing-canary snapshot provider. server-cli calls this
   * after constructing the monitor (which depends on this server's broadcast).
   * The provider is read by the `_historyCtx.billingCanary` getter to seed
   * `auth_ok`. `fn` returns the current snapshot or null.
   */
  setBillingCanaryProvider(fn) {
    this._billingCanaryProvider = typeof fn === 'function' ? fn : null
  }

  /** Delegates to ws-history.js */
  _sendPostAuthInfo(ws, extra) { sendPostAuthInfo(this._historyCtx, ws, extra) }
  _replayHistory(ws, sessionId, opts) { replayHistory(this._historyCtx, ws, sessionId, opts) }
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
      } else if (msg.type === 'pair_request') {
        // #5510: camera-less device requests pairing. Same exposure class as
        // `pair` (unauthenticated, rate-limited, queue-capped). The connection
        // stays OPEN — the requester waits for `pair_result`.
        handlePairRequestMessage(this._authCtx, ws, msg)
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
      // #5515 (epic #5514): stamp a wall-clock (ms epoch) serverTs so clients
      // can split the ping/pong RTT into uplink (ping send → serverTs) and
      // downlink (serverTs → pong recv) halves. Wall-clock — not the monotonic
      // clock used by the #5414 watchdogs — because it crosses machines; the
      // client treats it as skew-prone and derives one-way numbers from the
      // RTT split, never from raw clock subtraction.
      this._send(ws, { type: 'pong', serverTs: Date.now() })
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
    } else if (msg.type === 'get_permission_input') {
      // #6551: the pre-write-diff pull has its own tight limiter (each call can
      // return up to 512K), so it can't burn the general budget or self-DoS.
      const { allowed, retryAfterMs } = this._permissionInputRateLimiter.check(client.rateLimitKey)
      if (!allowed) {
        this._send(ws, { type: 'rate_limited', retryAfterMs, message: 'Too many permission-input pulls. Please slow down.' })
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

  /**
   * #5510: fan a `pair_pending` (or any pairing-approval surface event) out to
   * HOST-LEVEL clients only — authenticated clients with no `boundSessionId`.
   * A session-bound (share-a-session) token must NOT see host-wide pair
   * requests, mirroring the `host_status_request` authority gate. The verify
   * code in `msg` is server-generated; deviceName is attacker-controlled and is
   * relayed verbatim as plain text (surfaces escape on render).
   */
  _broadcastPairPending(message) {
    this._broadcast(message, (client) => !client.boundSessionId)
  }

  /** #5510: retract a resolved pending request from every host surface. */
  _broadcastPairResolved(requestId, reason) {
    this._broadcastPairPending({ type: 'pair_resolved', requestId, reason })
  }

  /**
   * #6536 (PR-2 of #5966): fan a live repo-events delta out to HOST-LEVEL
   * clients only — authenticated clients with no `boundSessionId` — mirroring
   * the `repo_events_request` survey's host-authority gate. Called by the
   * GitHub-webhook receiver after a normalized event is pushed onto the store,
   * so a connected Control Room pane updates without a Refresh. A session-bound
   * (share-a-session) token must NOT see host repo activity. The event is the
   * same normalized shape the survey serves; `generatedAt` is the broadcast time.
   */
  _broadcastRepoEvent(event) {
    if (!event) return
    this._broadcast(
      { type: 'repo_events_delta', generatedAt: new Date().toISOString(), event },
      (client) => !client.boundSessionId,
    )
  }

  // #6691: push a single orchestration run delta to host-level (unbound) clients
  // only — runs are host-wide cross-session objects; a session-bound token never
  // receives them. Called by the OrchestrationManager (E-4); the `delta`
  // already carries its own type/runId/seq (schemas/server/orchestration.ts).
  _broadcastOrchestrationDelta(delta) {
    if (!delta) return
    this._broadcast(delta, (client) => !client.boundSessionId)
  }

  /**
   * #5510: deliver a terminal `pair_result` to the requester's still-open
   * connection (if present) and drop the tracking entry. On approve the result
   * carries the issued token; on deny/expire/disconnect it carries a reason.
   * If the requester's connection is gone, the entry is just dropped.
   */
  _resolvePairRequester(requestId, result) {
    const ws = this._pairRequesters.get(requestId)
    this._pairRequesters.delete(requestId)
    if (!ws || ws.readyState !== 1) return
    this._send(ws, { type: 'pair_result', requestId, ...result })
  }

  /**
   * #5510: a requester's connection closed. If it had an outstanding pending
   * request, remove it from the queue (freeing the slot) and retract the host
   * banner. No `pair_result` is sent (the socket is gone).
   */
  _cleanupPairRequesterOnDisconnect(ws) {
    if (this._pairRequesters.size === 0) return
    for (const [requestId, reqWs] of this._pairRequesters) {
      if (reqWs !== ws) continue
      this._pairRequesters.delete(requestId)
      if (this._pairingManager) this._pairingManager.denyPendingRequest(requestId)
      this._broadcastPairResolved(requestId, 'disconnected')
    }
  }

  /**
   * #4788 Wave 2: register an AskUserQuestion route for `toolUseId` against
   * `sessionId` AND auto-subscribe every currently-eligible authenticated
   * client to `sessionId`. This keeps the input-handler's subscription guard
   * (handlers/input-handlers.js — the "unbound client must be subscribed or
   * active on the question's session" check) symmetric with
   * `_broadcastToSession`'s default recipient filter: any client that was
   * eligible to RECEIVE the question is now eligible to ANSWER it, even after
   * a `switch_session` flips their `activeSessionId` away.
   *
   * Wave 1 closed a cross-session answer-hijack vector (#4788) by requiring
   * unbound clients to be subscribed before routing a `user_question_response`.
   * That broke the legitimate "view A → get question for A → switch to B →
   * answer" flow because `switch_session` only adds the *new* target to
   * `subscribedSessionIds`; the originating session A was in neither set.
   * Auto-subscribing at dispatch time means the client that legitimately
   * received the question keeps the membership it needs to answer it.
   *
   * Bound clients are filtered out so a client paired to session X can never
   * be quietly subscribed to session Y. Unbound clients always get added —
   * matching `_broadcastToSession`'s default filter (which only requires
   * `activeSessionId === sessionId || subscribedSessionIds.has(sessionId)`,
   * but auto-subscribe seeds the latter so the filter passes for everyone
   * currently connected). Clients that connect AFTER dispatch are still
   * unable to answer; that's the desired hijack-prevention property.
   */
  _registerQuestionRoute(toolUseId, sessionId) {
    this._questionSessionMap.set(toolUseId, sessionId)
    if (!sessionId) return
    for (const [, client] of this.clients) {
      if (!client.authenticated) continue
      // Don't auto-subscribe a client bound to a *different* session — the
      // bound binding is the security contract for that client.
      if (client.boundSessionId && client.boundSessionId !== sessionId) continue
      if (!client.subscribedSessionIds) continue
      // #5563: route through the index-maintaining helper.
      this._clientManager.subscribe(client, sessionId)
    }
  }

  /**
   * #4798 (P0 symmetry with #4788): register a permission route for
   * `requestId` against `sessionId` AND auto-subscribe every currently-eligible
   * authenticated client to `sessionId`. Mirrors `_registerQuestionRoute` — the
   * settings-handler's permission_response subscription guard (the "unbound
   * client must be subscribed or active on the permission's session" check)
   * stays symmetric with `_broadcastToSession`'s default recipient filter:
   * any client that was eligible to RECEIVE the permission request is now
   * eligible to RESPOND to it, even after a `switch_session` flips their
   * `activeSessionId` away.
   *
   * Without the auto-subscribe at dispatch, the Wave 1 guard would silently
   * drop the legitimate "view A → get permission for A → switch to B →
   * respond" flow because `switch_session` only adds the new target to
   * `subscribedSessionIds`; the originating session A would be in neither
   * set after the switch.
   *
   * Same bound-client filter as the question variant: clients paired to a
   * different session never get quietly subscribed elsewhere. Clients that
   * connect AFTER dispatch are still unable to respond — that's the desired
   * hijack-prevention property.
   */
  _registerPermissionRoute(requestId, sessionId) {
    // #5704: a route may be re-registered for the same requestId (e.g. the
    // resend-on-reconnect path re-runs the dispatch). Don't double-count the
    // refcount — only the FIRST registration of a requestId seeds the per-client
    // permission-induced subscriptions. Subsequent re-registrations just re-seed
    // subscribedSessionIds (idempotent) without re-incrementing.
    const isNewRoute = !this._permissionSessionMap.has(requestId)
    this._permissionSessionMap.set(requestId, sessionId)
    if (!sessionId) return
    for (const [, client] of this.clients) {
      if (!client.authenticated) continue
      if (client.boundSessionId && client.boundSessionId !== sessionId) continue
      if (!client.subscribedSessionIds) continue
      // #5704: decide whether THIS route's auto-subscribe is permission-induced
      // (refcounted + torn-down) or rides on an existing EXPLICIT subscription
      // (left untouched). A subscription is EXPLICIT iff the client is subscribed
      // with NO permission refcount — an explicit switch_session/subscribe_sessions
      // ADOPTS by zeroing the refcount. The ACTIVE session is deliberately NOT
      // treated as ownership here: a client active on A at dispatch is exactly the
      // #4798 "view A → switch to B → respond" case — it WILL switch away, and we
      // must hold a refcount so the subscription is torn down after resolve. The
      // teardown's own active-session guard still protects a client that stays
      // active on the session. So:
      //   - subscribed && refcount === 0   -> explicit ownership: don't count.
      //   - refcount > 0                   -> already permission-owned: count up
      //                                       (a second concurrent permission).
      //   - otherwise                      -> permission-induced subscribe: count.
      const existingRefcount = this._permissionSubs.get(client.id)?.get(sessionId) || 0
      const explicitlyOwned = client.subscribedSessionIds.has(sessionId) && existingRefcount === 0
      // #5563: route through the index-maintaining helper.
      this._clientManager.subscribe(client, sessionId)
      if (isNewRoute && !explicitlyOwned) {
        this._incPermissionSub(client.id, sessionId)
      }
    }
  }

  /**
   * #5704: tear down a permission route registered by `_registerPermissionRoute`.
   * Called at EVERY resolve / expire / cleanup site (the WS + HTTP resolver, the
   * HTTP-hook cleanup()/destroy(), the session-destroy sweep) so a permission-
   * induced subscription never outlives its permission. Idempotent: deleting an
   * already-gone requestId is a no-op (returns without touching refcounts).
   *
   * Decrements every connected client's permission-induced refcount for the
   * route's session and, when a client's count reaches zero, removes the
   * auto-subscription UNLESS the client is the active session or still
   * explicitly subscribed (adoption — see _adoptPermissionSubscription). The
   * #4798 cross-tab flow stays intact because teardown only fires AFTER the
   * permission is resolved/expired; while it is live the refcount is > 0.
   * @param {string} requestId
   */
  _unregisterPermissionRoute(requestId) {
    if (!this._permissionSessionMap.has(requestId)) return
    const sessionId = this._permissionSessionMap.get(requestId)
    this._permissionSessionMap.delete(requestId)
    if (!sessionId) return
    // Decrement for every connected client that holds a permission-induced
    // refcount on this session. We iterate this.clients (connected clients); a
    // client that already disconnected had its refcount entry purged by
    // _handleClientDeparture, so it's absent here and never double-decremented,
    // and _decPermissionSub is a no-op for a client with no entry for sessionId.
    for (const [, client] of this.clients) {
      this._decPermissionSub(client, sessionId)
    }
  }

  /**
   * #5704: increment the permission-induced subscription refcount for
   * (clientId, sessionId). Lazily creates the per-client Map.
   * @private
   */
  _incPermissionSub(clientId, sessionId) {
    let perSession = this._permissionSubs.get(clientId)
    if (!perSession) {
      perSession = new Map()
      this._permissionSubs.set(clientId, perSession)
    }
    perSession.set(sessionId, (perSession.get(sessionId) || 0) + 1)
  }

  /**
   * #5704: decrement the permission-induced subscription refcount for `client`
   * on `sessionId`. When it hits zero, drop the bookkeeping entry and unsubscribe
   * the client from the session — but ONLY if the client neither has it as its
   * active session NOR is explicitly subscribed (adoption zeroes the refcount, so
   * a still-counted entry here means no explicit subscribe happened). Never
   * drives the count negative: a client with no counted entry is a no-op.
   * @private
   */
  _decPermissionSub(client, sessionId) {
    const perSession = this._permissionSubs.get(client.id)
    if (!perSession) return
    const count = perSession.get(sessionId)
    if (!count) return
    if (count > 1) {
      perSession.set(sessionId, count - 1)
      return
    }
    // Last permission-induced reference for this (client, session) is gone.
    perSession.delete(sessionId)
    if (perSession.size === 0) this._permissionSubs.delete(client.id)
    // Don't tear down a subscription the client still actively views. An
    // EXPLICIT subscribe would have adopted/zeroed the refcount, so reaching
    // here (count was > 0) already means no explicit subscribe happened — only
    // the transient active-session case still needs guarding before unsubscribe.
    if (client.activeSessionId === sessionId) return
    this._clientManager.unsubscribe(client, sessionId)
  }

  /**
   * #5704: an explicit subscribe (switch_session / subscribe_sessions /
   * session-create auto-subscribe) ADOPTS the subscription for (client,
   * sessionId): it zeroes any permission-induced refcount so a later permission
   * teardown can never unsubscribe a client that asked to watch the session.
   * Wired into transport.subscribeClient so every explicit subscribe path runs
   * it; the permission auto-subscribe goes straight through _clientManager and
   * therefore does NOT trigger adoption of its own refcount.
   * @private
   */
  _adoptPermissionSubscription(clientId, sessionId) {
    const perSession = this._permissionSubs.get(clientId)
    if (!perSession) return
    if (perSession.delete(sessionId) && perSession.size === 0) {
      this._permissionSubs.delete(clientId)
    }
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

  /** Broadcast client_left to all OTHER authenticated clients */
  _broadcastClientLeft(departingClient) {
    this._broadcaster._broadcastClientLeft(departingClient)
  }

  /**
   * #5555.6 — one keepalive sweep over all authenticated clients.
   *
   * Liveness contract: `client.isAlive` is set true by ANY inbound frame
   * (ws.on('message')) and by the protocol-level `pong` handler, so a client
   * running its 15s heartbeat ping always reads alive at the 15s sweep. Each
   * sweep clears the flag on live clients and pings them (to hold Cloudflare /
   * mobile-OS idle timeouts open for peers that don't initiate). A client that
   * goes truly silent fails the `!isAlive` check on the sweep AFTER the one that
   * cleared its flag — detection in 15–30s, ~2× the client cadence (was up to
   * ~60s with the old 30s sweep).
   *
   * Eviction goes through the sanctioned departure path so the
   * sessionId→clients reverse index (WsClientManager) and any primary-client
   * claim (#5589) are released atomically — the index lint rejects raw
   * mutations. `_handleClientDeparture` runs first (it reads client state),
   * then `removeClient` updates the index, then we terminate the socket.
   */
  _keepaliveSweep() {
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
  }

  /** Handle cleanup when an authenticated client disconnects or is terminated */
  _handleClientDeparture(departingClient) {
    // #5563: vacate primary for every session this client owned. Promotion
    // policy is NOBODY-UNTIL-CLAIM — we clear the slot (broadcast null) rather
    // than auto-promote an observer, so a backgrounded viewer is never silently
    // handed the session; the next claim_primary (or first input) takes over.
    // This matches the pre-#5563 disconnect behaviour exactly.
    for (const sessionId of this._clientManager.clearPrimaryForClient(departingClient.id)) {
      this._announcePrimary(sessionId, null)
    }

    // #5837: this client's terminal subscriptions are gone. Clear them first (the
    // client is still in `this.clients` until removeClient runs after departure),
    // then re-sync each watched session's mirror so the coalescer stops when this
    // was the last viewer.
    if (departingClient.terminalSessionIds && departingClient.terminalSessionIds.size > 0) {
      const watched = [...departingClient.terminalSessionIds]
      departingClient.terminalSessionIds.clear()
      for (const sessionId of watched) this._syncTerminalMirror(sessionId)
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

    // #5704: drop this client's permission-induced subscription bookkeeping so
    // a disconnected client never leaks a per-client Map entry (and can never be
    // double-decremented by a later _unregisterPermissionRoute — the entry is
    // gone). The reverse-index membership is purged separately by removeClient.
    this._permissionSubs.delete(departingClient.id)

    // Broadcast client_left to remaining authenticated clients
    this._broadcastClientLeft(departingClient)
  }

  /**
   * Input adoption path (#5563). Called only for input that already PASSED the
   * input_conflict gate — i.e. the session was idle, or the sender is already
   * primary. Accepted input adopts primary (`force: true`): the server cannot
   * distinguish "same user, second device" from "shared-session observer"
   * without identity, and blocking adoption here strands a solo user's second
   * device behind input_conflict for the rest of the run it just started. The
   * mid-run steal is still prevented by the conflict gate itself; true
   * observe-only enforcement is client-role work (#5281) built on the explicit
   * `claim_primary` path below, which IS sticky (rejects without `force`).
   * Broadcasts `primary_changed` (legacy) + `session_role` (new) only on an
   * actual change.
   */
  _updatePrimary(sessionId, clientId) {
    if (!sessionId) return
    const res = this._clientManager.claimPrimary(sessionId, clientId, { force: true })
    if (res.changed) this._announcePrimary(sessionId, clientId)
  }

  /**
   * Explicit claim / hand-off path (#5563). Returns the claim result so the
   * handler can tell the requester whether it succeeded or was rejected
   * (observe-only: another client already owns the session and no hand-off was
   * authorised). `force` overrides an existing owner for an operator-driven
   * hand-off. Broadcasts on an actual change.
   * @returns {{ changed: boolean, rejected?: boolean, primaryClientId: string|undefined }}
   */
  _claimPrimary(sessionId, clientId, opts = {}) {
    if (!sessionId) return { changed: false, primaryClientId: undefined }
    const res = this._clientManager.claimPrimary(sessionId, clientId, opts)
    if (res.changed) this._announcePrimary(sessionId, clientId)
    return res
  }

  /** Clear the primary slot for a session and announce the vacancy (#5563). */
  _clearPrimary(sessionId) {
    if (!sessionId) return
    const prev = this._clientManager.clearPrimary(sessionId)
    if (prev !== undefined) this._announcePrimary(sessionId, null)
  }

  /**
   * #5837: recompute whether ANY connected client is subscribed to a session's
   * live terminal mirror, and toggle the session's coalescer accordingly. Called
   * after every terminal-subscription change (subscribe / unsubscribe / client
   * departure) so the mirror runs only while at least one viewer is watching.
   * Only claude-tui sessions expose setTerminalMirrorActive; others have no PTY.
   */
  _syncTerminalMirror(sessionId) {
    if (!sessionId) return
    const entry = this.sessionManager.getSession?.(sessionId)
    if (typeof entry?.session?.setTerminalMirrorActive !== 'function') return
    let active = false
    for (const client of this.clients.values()) {
      // Count a client only if it would actually RECEIVE terminal_output — the
      // SAME predicate ws-forwarding's terminalSubscriberFilter delivers on, so
      // the coalescer gate and the delivery audience can never diverge (#5844
      // review). Shared via terminalMirrorRecipient (audit P1-2).
      if (terminalMirrorRecipient(client, sessionId)) {
        active = true
        break
      }
    }
    entry.session.setTerminalMirrorActive(active)
  }

  /**
   * Announce the current primary for a session to every subscriber (#5563).
   * Emits BOTH the legacy `primary_changed` envelope (so existing clients keep
   * working unchanged) AND the new `session_role` envelope that names the
   * primary and lets a client compute its own role (primary iff
   * primaryClientId === its own clientId, else observer; null === unclaimed).
   * @param {string} sessionId
   * @param {string|null} clientId - the new primary, or null when vacated
   */
  _announcePrimary(sessionId, clientId) {
    this._broadcastToSession(sessionId, {
      type: 'primary_changed',
      sessionId,
      clientId,
    })
    this._broadcastToSession(sessionId, {
      type: 'session_role',
      sessionId,
      primaryClientId: clientId,
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
    // #5721: propagate the delivery boolean so callers gating crypto state on a
    // frame reaching the wire (the eager handshake's auth_ok) can observe a
    // swallowed send failure. Other callers ignore the return, unchanged.
    return this._clientSend(ws, client, message)
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
    // Remove PairingManager listeners to prevent post-shutdown broadcasts
    if (this._pairingManager && this._pairingRefreshedHandler) {
      this._pairingManager.off('pairing_refreshed', this._pairingRefreshedHandler)
      this._pairingRefreshedHandler = null
    }
    if (this._pairingManager && this._pendingRequestExpiredHandler) {
      this._pairingManager.off('pending_request_expired', this._pendingRequestExpiredHandler)
      this._pendingRequestExpiredHandler = null
    }
    this._pairRequesters.clear()

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
    // #5563: primary-ownership lives on the client manager now; clear it via
    // its public API rather than reaching into the private `_primaryClients`.
    this._clientManager.clearAllPrimary()
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
    // #6277 — tear down the host-local approval listener + its port file.
    if (this._approvalServer) {
      try { this._approvalServer.close() } catch { /* already closing */ }
      this._approvalServer = null
      removeShellApprovalInfo()
    }
  }
}
