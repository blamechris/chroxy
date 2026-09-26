/**
 * agent-control: a provider-neutral client for chroxy's existing authenticated
 * WebSocket protocol, built for an EXTERNAL AGENT HARNESS (Codex, Claude,
 * Gemini, …) driving an ordinary chroxy session — not a new control plane.
 *
 * This is deliberately a THIN client over the protocol chroxy already ships:
 *   - Auth + E2E encryption: `packages/server/src/ws-auth.js` +
 *     `@chroxy/store-core/crypto` (see docs/security/encryption-threat-model.md).
 *   - Token authority: `packages/server/src/ws-server.js` /
 *     docs/security/bearer-token-authority.md — this client never widens what
 *     the presented token is allowed to do; the SERVER enforces authority.
 *   - Correlated input admission: `packages/server/src/handlers/input-handlers.js`
 *     (#7822's `input_ack` contract) — this client negotiates
 *     `input_context_v1` and reports the ack exactly as the server sent it.
 *   - Permission relay: `handlePermissionResponse`
 *     (`packages/server/src/handlers/settings-handlers.js`) — `respondPermission`
 *     sends only `allow`/`deny` (never `allowAlways`, which persists a durable
 *     project rule — out of scope for an external planner relay) for a
 *     permission this client has itself observed as pending and owns.
 *
 * It does NOT introduce a second scheduler, task database, token class, or
 * mailbox store. Durable task/handoff identity across daemon restarts is
 * #7823's job, not this client's; a universal mailbox is #7437's; in-daemon
 * orchestration is epic #6691's. See docs/guides/agent-control.md for how
 * this connects to (without duplicating) each of those.
 *
 * Design contract this file holds itself to:
 *   - Never log, throw, or return the bearer token in any error message,
 *     event, or generated text.
 *   - Never silently retry a MUTATION (`createSession` / `sendInput` /
 *     `interrupt` / `respondPermission`) after a timeout or disconnect — an
 *     uncertain outcome is returned/reported as uncertain, not retried and
 *     not reported as success.
 *   - Never infer task completion from a socket closing, `agent_idle`, or the
 *     presence of a `result` message — those are exposed as events for the
 *     caller to interpret, never collapsed into a synthetic "done".
 *   - Bound every wait (connect, request/response, event long-poll) so a
 *     hung daemon cannot hang the caller forever.
 *   - Never let this process crash on a transport error — an internal
 *     default listener backstops every EventEmitter-special 'error' emission.
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  createKeyPair,
  deriveSharedKey,
  deriveConnectionKey,
  generateConnectionSalt,
  encrypt,
  decrypt,
  verifyExchangeKeySignature,
  DIRECTION_SERVER,
  DIRECTION_CLIENT,
} from '@chroxy/store-core/crypto'
import { SessionEventLog, StreamAccumulator, classifyBroadcast, DEFAULT_RETENTION, MAX_WAIT_MS } from './events.js'
import { redactValue, SENSITIVE_KEY_NAMES } from '../redaction.js'

export const PROTOCOL_CAPABILITY_INPUT_CONTEXT = 'input_context_v1'
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
export const DEFAULT_INTERRUPT_GRACE_MS = 2_000
const ALLOWED_PERMISSION_DECISIONS = new Set(['allow', 'deny'])
// A caller-supplied `clientMessageId` (for a deliberate dedup retry) must
// match the CANONICAL wire rule the daemon itself enforces — see
// `InputContextEnvelopeSchema`'s superRefine in
// `packages/protocol/src/schemas/client.ts` (`/^[A-Za-z0-9_-]{1,128}$/`,
// reserved: 'thinking'/'pending'/'queued') and the same 128-char cap in
// `handlers/input-handlers.js`. Anything looser here would let this client
// accept an id the daemon then rejects or reinterprets, breaking ack
// correlation. A few extra reserved values are added defensively — being
// stricter than the wire schema is safe, being looser is not.
export const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
export const RESERVED_CLIENT_MESSAGE_IDS = new Set(['thinking', 'pending', 'queued', 'null', 'undefined', '__proto__', 'constructor', 'prototype'])

// (kind of the one in-flight uncorrelated op) -> the reply type(s) that
// satisfy it. `list_sessions`/`create_session`/`subscribe_sessions` have NO
// requestId on the wire, so this connection serializes them (see
// `_runSerial`) and matches strictly by kind -> allowed reply type, never by
// "any reply of a type ANY pending kind might accept" (that OR-precedence
// bug let a stray `session_list` broadcast satisfy a pending `create_session`
// op).
const SERIAL_REPLY_TYPES = {
  list_sessions: ['session_list'],
  create_session: ['session_switched', 'session_error'],
  subscribe_sessions: ['subscriptions_updated'],
}

// Broadcast types worth preserving even when they arrive DURING the
// handshake/startup fence (before this connection is "ready") — see
// `_dispatch`'s pre-ready buffer. Deliberately narrow: a `permission_request`
// for an already-pending permission is real state this client must not lose,
// not "login replay noise" to discard along with everything else the fence
// exists to drain. Its two terminal counterparts are buffered too, so a
// request that is resolved/expired inside the same pre-ready window is
// replayed in order and does not flush as still-pending.
//
// Buffered frames are NOT trusted on arrival: each carries whether it
// arrived under the connection key, and the flush discards the unencrypted
// ones when the daemon turned out to require encryption (see `connect()`).
const PRE_READY_BUFFERED_TYPES = new Set(['permission_request', 'permission_resolved', 'permission_expired'])
const MAX_PRE_READY_BUFFER = 100

/** A mutation was requested while the client is in read-only mode. */
export class ReadOnlyModeError extends Error {
  constructor(operation) {
    super(`agent-control client is read-only: '${operation}' is not permitted`)
    this.name = 'ReadOnlyModeError'
    this.code = 'READ_ONLY_MODE'
    this.operation = operation
  }
}

/** The daemon rejected authentication, key exchange, or identity pinning. */
export class ConnectionRefusedError extends Error {
  constructor(reason, message) {
    super(message || reason)
    this.name = 'ConnectionRefusedError'
    this.code = reason
  }
}

/** A bounded wait (connect / request / handshake) elapsed with no reply. */
export class TimeoutError extends Error {
  constructor(what, ms) {
    super(`timed out after ${ms}ms waiting for: ${what}`)
    this.name = 'TimeoutError'
    this.code = 'TIMEOUT'
  }
}

/** Sent while not connected/ready, or the socket dropped mid-request. */
export class NotConnectedError extends Error {
  constructor(detail) {
    super(detail || 'agent-control client is not connected')
    this.name = 'NotConnectedError'
    this.code = 'NOT_CONNECTED'
  }
}

function noopLogger() {}

function stderrLogger(...args) {
  // MCP stdio requires stdout to carry ONLY JSON-RPC frames — every log line
  // from this client (and anything it wraps) must go to stderr, never stdout.
  console.error('[agent-control]', ...args)
}

/**
 * Replace every exact occurrence of `token` in `text` with a placeholder.
 * This is deliberately EXACT-match, not a heuristic "looks like a secret"
 * pattern — the one value this client actually knows is a secret is its own
 * bearer token, and an exact match can never false-negative on it the way a
 * shape-based heuristic could. Defense in depth: normal operation never
 * embeds the token in a server-supplied string, but a compromised/buggy
 * daemon echoing it back (e.g. in an `auth_fail` reason) must not leak it
 * back out through this client's errors/logs/tool results.
 */
export function redactToken(text, token) {
  if (typeof text !== 'string' || typeof token !== 'string' || !token) return text
  return text.split(token).join('[REDACTED_TOKEN]')
}

export function redactPublicText(text, token) {
  return redactValue(redactToken(String(text), token))
}

/**
 * @typedef {object} AgentControlClientOptions
 * @property {string} url - `ws://` or `wss://` daemon URL. Never inferred here.
 * @property {string} token - bearer token. Held in memory only; never logged.
 * @property {boolean} [readOnly] - when true, every mutating method throws
 *   synchronously before any network I/O.
 * @property {number} [connectTimeoutMs]
 * @property {number} [requestTimeoutMs]
 * @property {number} [eventRetention] - per-session ring buffer size.
 * @property {boolean} [includeThinking] - forward thinking-stream text into
 *   the event log (default false — see events.js doc comment).
 * @property {string} [identityPublicKey] - base64 Ed25519 daemon identity
 *   public key to PIN (see docs/security/encryption-threat-model.md §3.1).
 *   When set, a handshake that lacks a valid signature over the offered
 *   exchange key — or offers plaintext — is refused, never silently accepted.
 * @property {string} [deviceName]
 * @property {Map} [modelExpectations] - injection seam so a caller managing
 *   reconnects (multiple client instances over time) can carry model
 *   expectations across them; defaults to a fresh, connection-local Map.
 * @property {(...args: unknown[]) => void} [log] - defaults to a stderr logger.
 * @property {typeof WebSocket} [WebSocketImpl] - injection seam for tests.
 */

export class AgentControlClient extends EventEmitter {
  /** @param {AgentControlClientOptions} opts */
  constructor(opts = {}) {
    super()
    if (!opts.url) throw new Error('AgentControlClient requires opts.url')
    if (!opts.token) throw new Error('AgentControlClient requires opts.token')

    // EventEmitter throws if 'error' is emitted with zero listeners. This
    // client legitimately needs to report transport failures via 'error' for
    // callers that want them, but a caller that doesn't attach a listener
    // must never crash the host process for it — this permanent internal
    // listener is the backstop. It does NOT suppress the event from other
    // listeners; it only satisfies Node's "at least one" requirement.
    this.on('error', () => {})

    this._url = opts.url
    this._token = opts.token
    this.readOnly = opts.readOnly === true
    this._connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this._requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this._pinnedIdentityKey = opts.identityPublicKey || null
    this._deviceName = opts.deviceName || 'chroxy-agent-control'
    const rawLog = opts.log || (opts.silent ? noopLogger : stderrLogger)
    // Every log line is redacted for the token before it reaches the raw
    // logger — see `redactToken`'s doc comment.
    this._log = (...args) => rawLog(...args.map((a) => redactPublicText(a, this._token)))
    this._WebSocket = opts.WebSocketImpl || WebSocket

    this._state = 'idle' // idle -> connecting -> ready -> closed
    this._ws = null
    this._encryptionState = null // { sharedKey, sendNonce, recvNonce }
    this._encryptionRequired = null
    this._daemonMeta = null

    this._eventLog = new SessionEventLog({ retention: opts.eventRetention ?? DEFAULT_RETENTION })
    this._streamAccumulator = new StreamAccumulator()
    this._includeThinking = opts.includeThinking === true
    this._replayingSessions = new Set()
    this._subscribedSessionIds = new Set()

    // clientMessageId -> { resolve, timer, sessionId, lastKnown }
    this._pendingInputAcks = new Map()
    // requestId -> { sessionId, resolve, timer }
    this._pendingPermissionResponses = new Map()
    // requestId -> { sessionId, seenAt } — permissions THIS client has
    // observed as pending, from `permission_request` broadcasts. A
    // `respondPermission` call for any other requestId is refused before any
    // network I/O — "only answer a still-observed, session-owned pending
    // permission".
    this._observedPermissions = new Map()

    // one in-flight "uncorrelated" op (list_sessions / create_session /
    // subscribe_sessions) at a time on this connection — see SERIAL_REPLY_TYPES.
    this._serialQueue = Promise.resolve()
    this._pendingSerialOp = null // { kind, resolve, reject, timer }

    // sessionId -> { requestedModel: string|null, lastKnownStatus }. Accepts
    // an INJECTED Map so a caller managing reconnects across multiple
    // AgentControlClient instances (see mcp-server.js's ClientManager) can
    // pass the SAME Map through each reconnect — a model expectation
    // recorded by `createSession` on a connection that later drops must not
    // evaporate just because the transport reconnected within the same
    // process; it has nothing to do with the connection's own lifetime.
    this._modelExpectations = opts.modelExpectations instanceof Map ? opts.modelExpectations : new Map()

    // Handshake-phase waiters that must be aborted immediately (not left to
    // time out) if the socket closes/errors before the handshake completes.
    this._handshakeAbortListeners = new Set()
    // Bounded buffer of state-bearing broadcasts seen during the handshake —
    // see PRE_READY_BUFFERED_TYPES / `_dispatch`.
    this._preReadyBuffer = []
  }

  get state() {
    return this._state
  }

  /** Safe, bounded metadata about the daemon — never the raw auth_ok/connection.json. */
  get daemonInfo() {
    if (!this._daemonMeta) return null
    return { ...this._daemonMeta }
  }

  // ---------------------------------------------------------------------
  // Connect / handshake
  // ---------------------------------------------------------------------

  async connect() {
    if (this._state !== 'idle') {
      throw new Error(`connect() called in state '${this._state}' — a client is single-use per connection`)
    }
    this._state = 'connecting'

    const overallDeadline = Date.now() + this._connectTimeoutMs
    const timeLeft = () => Math.max(0, overallDeadline - Date.now())

    const ws = new this._WebSocket(this._url)
    this._ws = ws
    ws.on('message', (raw) => this._onRawMessage(raw))
    ws.on('close', (code, reason) => this._onSocketClosed(code, reason))
    ws.on('error', (err) => this._onSocketError(err))

    try {
      await this._waitForOpen(ws, timeLeft())

      const clientKp = createKeyPair()
      const salt = generateConnectionSalt()

      this._sendPlain({
        type: 'auth',
        token: this._token,
        deviceInfo: {
          deviceName: this._deviceName,
          deviceType: 'desktop',
          platform: process.platform,
        },
        capabilities: [PROTOCOL_CAPABILITY_INPUT_CONTEXT],
        // Eager key exchange (#5555) — fold our half of the handshake into
        // `auth` so an encrypting daemon can reply in the SAME auth_ok frame
        // instead of a second round trip. A daemon that doesn't support this
        // simply ignores the extra fields and we fall back to the discrete
        // `key_exchange` path below.
        eagerPublicKey: clientKp.publicKey,
        eagerSalt: salt,
      })

      // `onMatch` runs SYNCHRONOUSLY inside the message-received callback,
      // before this awaited promise's continuation gets a chance to run as a
      // microtask. This matters: the underlying `ws` library can emit
      // several 'message' events synchronously, back-to-back in the SAME
      // call stack, for frames that arrived coalesced in one TCP read (e.g.
      // auth_ok immediately followed by the post-auth encrypted flush). If
      // key derivation happened only AFTER `await`, a coalesced encrypted
      // frame could be processed before `_encryptionState` was set and get
      // silently dropped. Deriving inside `onMatch` closes that window.
      await this._waitForOneOf(['auth_ok', 'auth_fail'], timeLeft(), {
        onMatch: (msg) => {
          if (msg.type === 'auth_fail') {
            // `reason` is SERVER-supplied. Redact our own token from it
            // before it becomes an Error message a caller might log/print —
            // a buggy or compromised daemon echoing it back must not leak it
            // back out through this client.
            const reason = redactPublicText(msg.reason || 'unknown reason', this._token)
            throw new ConnectionRefusedError('AUTH_FAILED', `daemon rejected authentication: ${reason}`)
          }
          this._encryptionRequired = msg.encryption === 'required'
          this._daemonMeta = this._buildDaemonMeta(msg)

          if (this._pinnedIdentityKey && !this._encryptionRequired) {
            // Mirrors the server's own #5614 gate: a pinned client must never
            // be routed onto a plaintext connection, even if auth_ok claims
            // one is fine — that is exactly the downgrade #5614 closes
            // server-side.
            throw new ConnectionRefusedError('IDENTITY_PIN_REQUIRES_ENCRYPTION', 'a pinned daemon identity requires encryption; the daemon offered none — refusing (possible downgrade)')
          }

          if (this._encryptionRequired && typeof msg.serverPublicKey === 'string' && msg.serverPublicKey) {
            // Eager path completed in this same frame.
            this._verifyPinIfConfigured(msg.serverPublicKey, msg.serverKeySig)
            const raw = deriveSharedKey(msg.serverPublicKey, clientKp.secretKey)
            this._encryptionState = { sharedKey: deriveConnectionKey(raw, salt), sendNonce: 0, recvNonce: 0 }
            return { eager: true }
          }
          return { eager: false }
        },
      })

      if (this._encryptionRequired && !this._encryptionState) {
        // Discrete fallback — daemon didn't fold the eager fields into
        // auth_ok. Send the documented key_exchange message and wait for
        // key_exchange_ok, deriving the key synchronously in `onMatch` for
        // the same coalesced-frame reason as above.
        // Construct the waiter FIRST (its Promise executor registers the
        // '_handshake' listener synchronously) and only THEN send — sending
        // before awaiting is fine (no `await` happens in between, so the
        // event loop cannot deliver a reply before the listener exists
        // either way), but awaiting before sending would deadlock until the
        // timeout, since nothing would ever trigger the reply.
        const kePromise = this._waitForOneOf(['key_exchange_ok'], timeLeft(), {
          onMatch: (keOk) => {
            if (typeof keOk.publicKey !== 'string' || !keOk.publicKey) {
              throw new ConnectionRefusedError('MALFORMED_KEY_EXCHANGE', 'key_exchange_ok missing a valid publicKey')
            }
            this._verifyPinIfConfigured(keOk.publicKey, keOk.serverKeySig)
            const raw = deriveSharedKey(keOk.publicKey, clientKp.secretKey)
            this._encryptionState = { sharedKey: deriveConnectionKey(raw, salt), sendNonce: 0, recvNonce: 0 }
          },
        })
        this._sendPlain({ type: 'key_exchange', publicKey: clientKp.publicKey, salt })
        await kePromise
      } else if (this._pinnedIdentityKey && !this._encryptionRequired) {
        // Unreachable given the gate above, kept as defense-in-depth.
        throw new ConnectionRefusedError('IDENTITY_PIN_REQUIRES_ENCRYPTION', 'refusing unencrypted connection with a pinned identity configured')
      }

      // Startup fence (#7822-adjacent hardening): drain whatever the daemon
      // already queued to send right after auth (session replay, an initial
      // session_switched for a default session, etc.) before this client is
      // considered "ready" and before any correlated request can be issued.
      // A `ping`/`pong` round trip is ordered on the same connection, so by
      // the time `pong` arrives every message the daemon had already queued
      // ahead of it has been delivered. Messages seen during the fence are
      // NOT dispatched into the event log or serial-op correlation — they
      // predate any request this client will ever make.
      const pongPromise = this._waitForOneOf(['pong'], timeLeft())
      this._send({ type: 'ping' })
      await pongPromise

      this._state = 'ready'
      this._eventLog.reset()
      this._streamAccumulator.clear()
      // Flush anything the fence buffered (see PRE_READY_BUFFERED_TYPES)
      // through the SAME path a live message takes, now that `reset()` has
      // minted the fresh epoch they'll be recorded under.
      //
      // A daemon that requires encryption sends every application frame
      // under the connection key (eager: from the frame after auth_ok;
      // discrete: nothing until key_exchange_ok), so a PLAINTEXT application
      // frame buffered during the handshake did not come from the daemon we
      // authenticated — it is an on-path injection (the pre-auth_ok window,
      // or the discrete key-exchange window). Identity pinning authenticates
      // the exchange key, not frames that were never under it; recording
      // such a frame as an observed permission would let an injector plant a
      // request (with a description of its choosing) that this client would
      // then answer. Drop it instead.
      const buffered = this._preReadyBuffer
      this._preReadyBuffer = []
      for (const { msg, authenticated } of buffered) {
        if (this._encryptionRequired && !authenticated) {
          this._log(`dropping a plaintext '${msg.type}' frame received before the encrypted handshake completed — not authenticated by the daemon`)
          continue
        }
        this._trackPermissionObservation(msg)
        this._processReadyMessage(msg)
      }
      this.emit('ready', this.daemonInfo)
    } catch (err) {
      this._state = 'error'
      try { ws.close() } catch { /* already closing/closed */ }
      throw this._safeError(err)
    }
  }

  _verifyPinIfConfigured(offeredPublicKey, sig) {
    if (!this._pinnedIdentityKey) return
    if (typeof sig !== 'string' || !sig) {
      throw new ConnectionRefusedError('IDENTITY_UNSIGNED', 'server identity is pinned but the daemon offered no signature over its exchange key — refusing (possible downgrade or impersonation)')
    }
    const ok = verifyExchangeKeySignature(offeredPublicKey, sig, this._pinnedIdentityKey)
    if (!ok) {
      throw new ConnectionRefusedError('IDENTITY_MISMATCH', 'server identity signature does not match the pinned identity — refusing (server identity changed)')
    }
  }

  _buildDaemonMeta(authOk) {
    // Deliberately an ALLOWLIST, not a forward of the raw auth_ok frame —
    // auth_ok can carry a bootstrap burst (providers, slash commands,
    // agents, tunnelUrl) that is more than "safe version/capability
    // metadata" and is not this tool's business to redistribute. Same for
    // `capabilities`: only the specific boolean flags a planner might
    // legitimately want to know about (e.g. "does this daemon support
    // input_context_v1 at all") are copied, by name, as booleans.
    const rawCaps = authOk.capabilities && typeof authOk.capabilities === 'object' ? authOk.capabilities : {}
    const safeString = value => typeof value === 'string' ? redactPublicText(value, this._token).slice(0, 512) : null
    return {
      serverVersion: safeString(authOk.serverVersion),
      latestVersion: safeString(authOk.latestVersion),
      protocolVersion: typeof authOk.protocolVersion === 'number' && Number.isFinite(authOk.protocolVersion) ? authOk.protocolVersion : safeString(authOk.protocolVersion),
      serverCommit: safeString(authOk.serverCommit),
      serverMode: safeString(authOk.serverMode),
      encryption: safeString(authOk.encryption) ?? 'disabled',
      connectedClients: typeof authOk.connectedClients === 'number' && Number.isFinite(authOk.connectedClients) ? authOk.connectedClients : null,
      capabilities: {
        inputContextV1: rawCaps.inputContextV1 === true,
      },
    }
  }

  async close() {
    if (this._state === 'closed') return
    this._state = 'closed'
    this._teardownConnectionState()
    this._abortHandshakeWaiters(new NotConnectedError('client closed'))
    this._rejectAllPending(new NotConnectedError('client closed'))
    if (this._ws) {
      try { this._ws.close() } catch { /* already closed */ }
    }
    this._ws = null
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  async listSessions() {
    this._assertReady()
    const msg = await this._runSerial('list_sessions', this._requestTimeoutMs, () => {
      this._send({ type: 'list_sessions' })
    })
    const sessions = Array.isArray(msg.sessions) ? msg.sessions.map((s) => this._annotateModelStatus(s)) : []
    return { sessions }
  }

  /**
   * @param {object} opts
   * @param {string} [opts.name]
   * @param {string} [opts.cwd]
   * @param {string} [opts.provider] - explicitly NEVER 'user-shell' (see class doc)
   * @param {string} [opts.model]
   * @param {string} [opts.permissionMode] - defaults to 'approve'; NEVER 'auto'
   *   through this client (that mode requires host-level confirmation this
   *   client cannot honestly supply).
   * @param {boolean} [opts.worktree]
   */
  async createSession(opts = {}) {
    this._assertMutationAllowed('createSession')
    this._assertReady()

    // Trim BEFORE comparing — `' user-shell '` must be refused exactly like
    // `'user-shell'`, not slip through an exact-match guard on the untrimmed
    // value.
    const trimmedProvider = typeof opts.provider === 'string' ? opts.provider.trim() : undefined
    if (trimmedProvider === 'user-shell') {
      throw new Error("createSession: provider 'user-shell' is not permitted through agent-control (arbitrary host shell access is out of scope — see docs/guides/agent-control.md)")
    }
    if ('skipPermissions' in opts) {
      throw new Error('createSession: skipPermissions is not permitted through agent-control (this client always sends skipPermissions:false explicitly)')
    }
    const permissionMode = typeof opts.permissionMode === 'string' && opts.permissionMode.trim() ? opts.permissionMode.trim() : 'approve'
    if (permissionMode === 'auto') {
      throw new Error("createSession: permissionMode 'auto' is not permitted through agent-control")
    }

    const payload = {
      type: 'create_session',
      // Explicit, not omitted: a host with `defaultSkipPermissions: true`
      // configured would otherwise hand an agent-control-created session an
      // unmediated permission bypass by default. This client never wants
      // that, so it says so on every create rather than relying on the
      // daemon's default.
      skipPermissions: false,
      permissionMode,
    }
    if (typeof opts.name === 'string' && opts.name.trim()) payload.name = opts.name.trim()
    if (typeof opts.cwd === 'string' && opts.cwd.trim()) payload.cwd = opts.cwd.trim()
    if (trimmedProvider) payload.provider = trimmedProvider
    if (typeof opts.model === 'string' && opts.model.trim()) payload.model = opts.model.trim()
    if (opts.worktree === true) payload.worktree = true

    const result = await this._runSerial('create_session', this._requestTimeoutMs, () => {
      this._send(payload)
    })

    if (result.type === 'session_error') {
      const err = new Error(result.message || 'create_session failed')
      err.code = result.code || 'SESSION_ERROR'
      throw err
    }

    const sessionId = result.sessionId
    if (payload.model) this._modelExpectations.set(sessionId, { requestedModel: payload.model })
    await this._ensureSubscribed(sessionId).catch((err) => this._log('createSession: subscribe failed (non-fatal):', err.message))

    // The success reply (`session_switched`) does not itself carry the
    // resolved `model` — only `list_sessions` does (see session-manager.js
    // listSessions(): `model: entry.session.model || entry.session.bootedModel
    // || null`). One follow-up round trip is the honest way to learn what
    // model actually got resolved, rather than assuming the request was
    // honored (see the live sonnet -> claude-sonnet-4-6 /
    // silent-fallback-to-Opus incident this client exists to catch).
    let modelStatus = { requested: payload.model || null, observed: null, unknown: true, mismatch: false }
    try {
      const { sessions } = await this.listSessions()
      const row = sessions.find((s) => s.sessionId === sessionId)
      if (row) modelStatus = row.modelStatus
    } catch (err) {
      this._log('createSession: follow-up listSessions failed, model status unknown:', err.message)
    }

    return {
      sessionId,
      name: result.name ?? null,
      cwd: result.cwd ?? null,
      modelStatus,
    }
  }

  /**
   * Send input to a session and return the daemon's `input_ack` exactly as
   * reported — status/delivery/retrySafe/dedupScope are NEVER reinterpreted
   * as success/failure by this client. `status: 'uncertain'` (this client's
   * own synthetic status, `ackTimedOut: true` or `disconnected: true`) means
   * no FINAL ack arrived in time — this is NOT a failure and NOT permission
   * to retry; the caller decides what to do with an unconfirmed send. An
   * intermediate ack carrying `reason: 'admission_pending'` (the provider
   * has not yet confirmed admission) is explicitly NOT treated as final —
   * this method keeps waiting for either a later, conclusive ack or the
   * deadline.
   *
   * When this session has a recorded model EXPECTATION (a `model` was passed
   * to `createSession`) and that expectation has resolved to `mismatch` or
   * `unknown`, this method REFUSES to send by default — sending an
   * implementation task under a falsely-claimed model is exactly the failure
   * this client exists to prevent. Pass `{ acknowledgeModelMismatch: true }`
   * to send anyway (e.g. once a human/planner has consciously decided the
   * mismatch is acceptable).
   *
   * @param {string} sessionId
   * @param {string} data
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   * @param {string} [opts.clientMessageId] - supply your own id to make a
   *   retry land on the daemon's dedup path (`dedupScope: 'process'`) instead
   *   of being treated as a brand-new send. Must be a non-empty string.
   * @param {boolean} [opts.acknowledgeModelMismatch]
   */
  async sendInput(sessionId, data, opts = {}) {
    this._assertMutationAllowed('sendInput')
    this._assertReady()
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sendInput requires sessionId')
    if (typeof data !== 'string') throw new Error('sendInput requires string data')

    // This client's whole correlated-ack contract depends on the daemon
    // actually supporting #7822's input_context_v1 negotiation (advertised,
    // unconditionally, in `auth_ok.capabilities.inputContextV1` on every
    // daemon that has it — see ws-history.js). A daemon that predates it
    // will never send a correlated `input_ack` at all, so every send would
    // silently degrade into an "uncertain" timeout on every call — refuse
    // up front instead, with a clear reason, rather than let that happen
    // silently.
    if (this._daemonMeta?.capabilities?.inputContextV1 !== true) {
      return {
        status: 'blocked',
        reason: 'input_context_v1_unsupported',
        sessionId,
        message: 'This daemon does not advertise input_context_v1 support (auth_ok.capabilities.inputContextV1) — correlated input_ack is not available, so this client refuses to send rather than silently time out on every call.',
      }
    }

    let clientMessageId
    if (opts.clientMessageId !== undefined) {
      if (typeof opts.clientMessageId !== 'string' || !CLIENT_MESSAGE_ID_PATTERN.test(opts.clientMessageId) || RESERVED_CLIENT_MESSAGE_IDS.has(opts.clientMessageId.toLowerCase())) {
        throw new Error(`sendInput: opts.clientMessageId must match ${CLIENT_MESSAGE_ID_PATTERN} and not be a reserved value`)
      }
      clientMessageId = opts.clientMessageId
    } else {
      clientMessageId = randomUUID()
    }

    const ackKey = this._inputAckKey(sessionId, clientMessageId)
    // Reserve the slot SYNCHRONOUSLY — before ANY `await` below — so two
    // concurrent sendInput calls racing on the same (sessionId,
    // clientMessageId) cannot both pass this check and then stomp each
    // other's pending entry once their awaits resolve. `has()`+`set()` with
    // no yield point in between is atomic under JS's single-threaded
    // execution; the SAME check re-run after an await would NOT be (that was
    // the bug this reservation replaces).
    if (this._pendingInputAcks.has(ackKey)) {
      throw new Error(`sendInput: a send with clientMessageId '${clientMessageId}' is already in flight for session ${sessionId} — supply a different id or await the first call`)
    }
    const reservation = { reserved: true, sessionId, clientMessageId }
    this._pendingInputAcks.set(ackKey, reservation)
    const releaseIfStillReserved = () => {
      if (this._pendingInputAcks.get(ackKey) === reservation) this._pendingInputAcks.delete(ackKey)
    }

    try {
      // Fresh, not cached: a model expectation is safety-critical (the whole
      // point of this gate is not sending an implementation task under a
      // falsely-claimed model), so this re-checks against the daemon rather
      // than trusting a snapshot that might predate a `model_changed`
      // broadcast this client hasn't processed yet.
      const modelGate = await this._checkModelGate(sessionId, opts)
      if (modelGate) { releaseIfStillReserved(); return modelGate }
      this._assertReady() // re-check: the await above could have outlived the connection

      // Subscription failures are FATAL here, not logged-and-ignored — an
      // unauthorized/denied/unknown-session subscription means this client
      // has no way to ever OBSERVE the outcome of the send it's about to
      // make, and silently proceeding would make `getEvents` return
      // misleadingly-empty "no new events" for a session this client was
      // never actually granted.
      await this._ensureSubscribed(sessionId)
      this._assertReady()
    } catch (err) {
      releaseIfStillReserved()
      throw err
    }

    const timeoutMs = opts.timeoutMs ?? this._requestTimeoutMs

    const ackPromise = new Promise((resolve) => {
      // Registered BEFORE the send below, so an ack that arrives even
      // pathologically fast can never race ahead of the listener. This
      // REPLACES the reservation above with the real waiting entry — the
      // reservation already guaranteed exclusivity for this
      // (sessionId, clientMessageId); this step attaches what to actually do
      // when the ack (or the timeout) arrives.
      const timer = setTimeout(() => {
        const pending = this._pendingInputAcks.get(ackKey)
        this._pendingInputAcks.delete(ackKey)
        resolve({
          status: 'uncertain',
          delivery: 'unknown',
          retrySafe: false,
          dedupScope: pending?.lastKnown?.dedupScope ?? 'process',
          // Read from the pending record, not the (sessionId::id) map key —
          // the map key is an internal correlation detail and must never
          // leak into a result field a caller reads as "the clientMessageId".
          clientMessageId: pending?.clientMessageId ?? clientMessageId,
          sessionId,
          ackTimedOut: true,
          lastKnownStatus: pending?.lastKnown ?? null,
          message: 'No FINAL input_ack received within the timeout. The server explicitly does not retry automatically on timeout — do not assume the input was or was not delivered.',
        })
      }, timeoutMs)
      this._pendingInputAcks.set(ackKey, { resolve, timer, sessionId, clientMessageId })
    })

    try {
      this._send({ type: 'input', sessionId, data, clientMessageId })
    } catch (err) {
      const pending = this._pendingInputAcks.get(ackKey)
      if (pending) {
        clearTimeout(pending.timer)
        this._pendingInputAcks.delete(ackKey)
      }
      throw err
    }

    return ackPromise
  }

  /**
   * Best-effort interrupt. The protocol defines no correlated ack for
   * `interrupt` (see ws-server.js protocol doc) — this resolves once a short
   * grace window passes with no `session_error` naming this session, or
   * immediately on such an error. It reports what was OBSERVED, not a
   * synthesized "the agent stopped".
   */
  async interrupt(sessionId) {
    this._assertMutationAllowed('interrupt')
    this._assertReady()
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('interrupt requires sessionId')

    // Fatal, not logged-and-ignored — interrupt's own grace-window
    // "was there a session_error" observation depends on actually being
    // subscribed; proceeding unsubscribed would silently make a real error
    // invisible to the caller.
    await this._ensureSubscribed(sessionId)
    this._assertReady()

    const graceMs = Math.min(DEFAULT_INTERRUPT_GRACE_MS, this._requestTimeoutMs)
    return new Promise((resolve) => {
      let settled = false
      const onMessage = (msg) => {
        if (msg.type !== 'session_error') return
        if (msg.sessionId && msg.sessionId !== sessionId) return
        settle({ sent: true, acknowledged: false, error: msg })
      }
      const onClose = () => settle({ sent: true, acknowledged: false, disconnected: true })
      const timer = setTimeout(() => settle({ sent: true, acknowledged: false }), graceMs)
      const settle = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.removeListener('message', onMessage)
        this.removeListener('close', onClose)
        this.removeListener('error', onClose)
        resolve(result)
      }
      // `AgentControlClient` itself (not `_eventLog`, which is a plain class
      // with no event emission) is the EventEmitter every dispatched message
      // is re-emitted on as 'message' — see `_dispatch`.
      this.on('message', onMessage)
      this.on('close', onClose)
      this.on('error', onClose)
      try {
        this._send({ type: 'interrupt', sessionId })
      } catch (err) {
        settle({ sent: false, acknowledged: false, error: { message: err.message } })
      }
    })
  }

  /**
   * Answer an OBSERVED, session-owned pending permission request with
   * `allow` or `deny` — never `allowAlways` (that persists a durable project
   * rule; out of scope for an external planner relay). Refuses, before any
   * network I/O, to answer a requestId this client has not itself seen as
   * pending (via a `permission_request` event) or that it has already seen
   * resolved/expired — "session-owned" here means owned by the CALLER's
   * session-scoped view of what THIS connection observed, not a claim about
   * server-side authority (the server's own binding/authority checks in
   * `handlePermissionResponse` still apply and are the actual floor).
   *
   * @param {string} sessionId
   * @param {string} requestId
   * @param {'allow'|'deny'} decision
   */
  async respondPermission(sessionId, requestId, decision) {
    this._assertMutationAllowed('respondPermission')
    this._assertReady()
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('respondPermission requires sessionId')
    if (typeof requestId !== 'string' || !requestId) throw new Error('respondPermission requires requestId')
    if (!ALLOWED_PERMISSION_DECISIONS.has(decision)) {
      throw new Error("respondPermission: decision must be 'allow' or 'deny' (allowAlways is not permitted through agent-control)")
    }

    const observed = this._observedPermissions.get(requestId)
    if (!observed) {
      return { status: 'rejected', requestId, reason: 'not_observed', message: 'This requestId was never observed as pending by this client — refusing to answer an unknown/unscoped permission.' }
    }
    if (observed.sessionId !== sessionId) {
      return { status: 'rejected', requestId, reason: 'sibling_session', message: `This permission belongs to session ${observed.sessionId}, not ${sessionId} — refusing.` }
    }
    // A second concurrent call for the SAME requestId must not silently
    // overwrite the first caller's pending entry — that would leak the
    // first caller's timer and permanently strand its promise (it would
    // never resolve, since its map entry was replaced and any later reply
    // now only reaches the second caller). Checked synchronously before any
    // mutation of `_pendingPermissionResponses`, matching `sendInput`'s
    // reservation discipline.
    if (this._pendingPermissionResponses.has(requestId)) {
      return { status: 'rejected', requestId, sessionId, reason: 'already_in_flight', message: 'A response to this requestId is already in flight — the first caller retains the pending correlation; await it instead of calling again.' }
    }

    const timeoutMs = this._requestTimeoutMs
    const ackPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pendingPermissionResponses.delete(requestId)
        resolve({
          status: 'uncertain',
          requestId,
          sessionId,
          ackTimedOut: true,
          message: 'No confirmation (permission_resolved/permission_expired/error) received within the timeout — do not assume the decision was or was not applied, and do not retry automatically.',
        })
      }, timeoutMs)
      // Registered BEFORE the send below.
      this._pendingPermissionResponses.set(requestId, { sessionId, resolve, timer })
    })

    try {
      this._send({ type: 'permission_response', requestId, decision })
    } catch (err) {
      const pending = this._pendingPermissionResponses.get(requestId)
      if (pending) {
        clearTimeout(pending.timer)
        this._pendingPermissionResponses.delete(requestId)
      }
      throw err
    }

    return ackPromise
  }

  /**
   * Bounded read of the retained, normalized event log for one session.
   * `waitMs` (default 0, clamped to MAX_WAIT_MS) long-polls for new events;
   * an empty result means no NEW retained events arrived — never "the
   * executor finished". See events.js for the retention/gap contract.
   */
  async getEvents(sessionId, opts = {}) {
    this._assertReady()
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('getEvents requires sessionId')
    // Fatal, not logged-and-ignored — an unauthorized/unknown session would
    // otherwise silently return an empty (but successful-looking) event log
    // forever, indistinguishable from "subscribed but genuinely idle".
    await this._ensureSubscribed(sessionId)
    this._assertReady()
    const waitMs = Math.min(Math.max(0, Number(opts.waitMs) || 0), MAX_WAIT_MS)
    return this._eventLog.waitAndRead(sessionId, { cursor: opts.cursor ?? null, limit: opts.limit, waitMs })
  }

  /**
   * Connection-level events whose broadcast carried no `sessionId` at all
   * (a legacy/unscoped reply path — see events.js `UNSCOPED_KEY`). These are
   * NEVER folded into a specific session's log (that would risk
   * misattributing an unscoped event to the wrong session); this is the
   * explicit, documented way to inspect them.
   */
  async getUnscopedEvents(opts = {}) {
    this._assertReady()
    const waitMs = Math.min(Math.max(0, Number(opts.waitMs) || 0), MAX_WAIT_MS)
    return this._eventLog.waitAndRead(null, { cursor: opts.cursor ?? null, limit: opts.limit, waitMs })
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  _assertReady() {
    if (this._state !== 'ready') throw new NotConnectedError(`client is in state '${this._state}', not 'ready'`)
  }

  _assertMutationAllowed(operation) {
    if (this.readOnly) throw new ReadOnlyModeError(operation)
  }

  /**
   * FRESH (not cached) model-mismatch gate. A model expectation is
   * safety-critical, so this pays a `list_sessions` round trip on every
   * `sendInput` for a session that has one, rather than trusting a snapshot
   * that could predate a `model_changed` broadcast, a reconnect, or simply
   * never having been checked (a fresh expectation with no `lastKnownStatus`
   * yet is treated as UNKNOWN, not as "nothing to block on" — fail closed).
   */
  async _checkModelGate(sessionId, opts) {
    if (opts.acknowledgeModelMismatch === true) return null
    if (!this._modelExpectations.has(sessionId)) return null

    let modelStatus
    try {
      const { sessions } = await this.listSessions()
      const row = sessions.find((s) => s.sessionId === sessionId)
      modelStatus = row ? row.modelStatus : { requested: this._modelExpectations.get(sessionId)?.requestedModel ?? null, observed: null, unknown: true, mismatch: false }
    } catch (err) {
      // Could not refresh — fail closed rather than fall back to a
      // possibly-stale cached status or, worse, silently proceed.
      modelStatus = { requested: this._modelExpectations.get(sessionId)?.requestedModel ?? null, observed: null, unknown: true, mismatch: false }
      this._log('sendInput: model-status refresh failed, treating as unknown:', err.message)
    }

    if (modelStatus.mismatch || modelStatus.unknown) {
      return {
        status: 'blocked',
        reason: modelStatus.mismatch ? 'model_mismatch' : 'model_unknown',
        sessionId,
        modelStatus,
        message: 'Refusing to send input: the session may not be running the requested model (see modelStatus). Pass acknowledgeModelMismatch:true to send anyway.',
      }
    }
    return null
  }

  _annotateModelStatus(sessionRow) {
    const expectation = this._modelExpectations.get(sessionRow.sessionId)
    const requested = expectation ? expectation.requestedModel : null
    const observed = sessionRow.model ?? null
    const unknown = observed === null
    const mismatch = !unknown && requested !== null && requested !== observed
    const modelStatus = { requested, observed, unknown, mismatch }
    if (expectation) expectation.lastKnownStatus = modelStatus
    return { ...sessionRow, modelStatus }
  }

  /**
   * Subscribes this connection to `sessionId`'s broadcasts (`subscribe_sessions`
   * / `subscriptions_updated` — see `handleSubscribeSessions`) and THROWS if
   * the daemon's reply does not actually include `sessionId` — a bound token
   * scoped to a different session, or a sessionId the daemon doesn't
   * recognize, causes `subscribe_sessions` to silently omit it from the
   * reply rather than erroring, so checking membership (not just "did we get
   * a reply") is the only way to detect a denied/unknown subscription.
   */
  async _ensureSubscribed(sessionId) {
    if (this._subscribedSessionIds.has(sessionId)) return
    const result = await this._runSerial('subscribe_sessions', this._requestTimeoutMs, () => {
      this._send({ type: 'subscribe_sessions', sessionIds: [sessionId] })
    })
    const granted = Array.isArray(result.subscribedSessionIds) ? result.subscribedSessionIds : []
    for (const sid of granted) this._subscribedSessionIds.add(sid)
    if (!granted.includes(sessionId)) {
      const err = new Error(`subscribe_sessions did not grant session ${sessionId} — it may not exist, or this token is not authorized for it`)
      err.code = 'SUBSCRIPTION_DENIED'
      throw err
    }
  }

  _waitForOpen(ws, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new TimeoutError('WebSocket open', timeoutMs))
      }, Math.max(1, timeoutMs))
      const onOpen = () => { cleanup(); resolve() }
      const onError = (err) => { cleanup(); reject(err) }
      const cleanup = () => {
        clearTimeout(timer)
        ws.removeListener('open', onOpen)
        ws.removeListener('error', onError)
      }
      ws.once('open', onOpen)
      ws.once('error', onError)
    })
  }

  /**
   * @param {string[]} types
   * @param {number} timeoutMs
   * @param {{ onMatch?: (msg: object) => any }} [opts] - `onMatch` runs
   *   SYNCHRONOUSLY in the message-handling call stack before this promise
   *   resolves — see the coalesced-frame comment in `connect()`. Its return
   *   value becomes the resolved value; a thrown error rejects.
   */
  _waitForOneOf(types, timeoutMs, opts = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new TimeoutError(types.join('|'), timeoutMs))
      }, Math.max(1, timeoutMs))
      const onMsg = (msg) => {
        if (!types.includes(msg.type)) return
        cleanup()
        try {
          const result = opts.onMatch ? opts.onMatch(msg) : msg
          resolve(result)
        } catch (err) {
          reject(err)
        }
      }
      const onAbort = (err) => { cleanup(); reject(err) }
      const cleanup = () => {
        clearTimeout(timer)
        this.removeListener('_handshake', onMsg)
        this._handshakeAbortListeners.delete(onAbort)
      }
      this.on('_handshake', onMsg)
      this._handshakeAbortListeners.add(onAbort)
    })
  }

  _abortHandshakeWaiters(err) {
    const listeners = [...this._handshakeAbortListeners]
    this._handshakeAbortListeners.clear()
    for (const onAbort of listeners) onAbort(err)
  }

  _runSerial(kind, timeoutMs, sendFn) {
    const run = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingSerialOp = null
        // "Invalidate the ambiguous connection after an uncorrelated
        // timeout": with no requestId on the wire for these operations, a
        // reply that arrives AFTER we gave up waiting could otherwise be
        // mistaken for the answer to a LATER call of the same kind. Rather
        // than accept that ambiguity, the whole connection is torn down —
        // callers must open a fresh one. This is deliberately conservative.
        this._failConnection(new TimeoutError(kind, timeoutMs))
        reject(new TimeoutError(kind, timeoutMs))
      }, timeoutMs)
      this._pendingSerialOp = { kind, resolve, reject, timer }
      try {
        sendFn()
      } catch (err) {
        clearTimeout(timer)
        this._pendingSerialOp = null
        reject(err)
      }
    })
    // Chain so a second caller's op waits for the first to resolve/timeout —
    // list_sessions/create_session/subscribe_sessions have no requestId, so
    // this connection only ever has ONE such op in flight (see class doc).
    const chained = this._serialQueue.then(run, run)
    this._serialQueue = chained.catch(() => {})
    return chained
  }

  _sendPlain(payload) {
    if (!this._ws || this._ws.readyState !== this._ws.OPEN) {
      throw new NotConnectedError('socket is not open')
    }
    this._ws.send(JSON.stringify(payload))
  }

  _send(payload) {
    if (!this._ws || this._ws.readyState !== this._ws.OPEN) {
      throw new NotConnectedError('socket is not open')
    }
    if (this._encryptionState) {
      const envelope = encrypt(JSON.stringify(payload), this._encryptionState.sharedKey, this._encryptionState.sendNonce, DIRECTION_CLIENT)
      this._encryptionState.sendNonce++
      this._ws.send(JSON.stringify(envelope))
    } else {
      this._ws.send(JSON.stringify(payload))
    }
  }

  _onRawMessage(raw) {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      this._log('dropping non-JSON frame')
      return
    }
    if (!msg || typeof msg !== 'object') return

    // True only for a frame that decrypted under the connection key — i.e.
    // one the daemon we key-exchanged with actually sent.
    let authenticated = false
    if (msg.type === 'encrypted') {
      if (!this._encryptionState) {
        this._log('received encrypted frame before key exchange completed — dropping')
        return
      }
      try {
        msg = decrypt(msg, this._encryptionState.sharedKey, this._encryptionState.recvNonce, DIRECTION_SERVER)
        this._encryptionState.recvNonce++
        authenticated = true
      } catch (err) {
        // Tamper or replay (Poly1305 MAC failure, or nonce mismatch) —
        // per the documented contract this is a hard failure: close the
        // connection rather than continue on a socket that has just proven
        // untrustworthy.
        this._log('decryption failed (tamper/replay) — closing connection:', err.message)
        this._failConnection(new ConnectionRefusedError('DECRYPTION_FAILED', `message decryption failed: ${err.message}`))
        return
      }
    } else if (this._encryptionRequired && (this._state === 'ready' || this._encryptionState)) {
      // Mirrors the server's own enforcement (ws-server.js #5614 test:
      // "REJECTS plaintext frames after encryption is established") in the
      // other direction — a daemon that starts sending PLAINTEXT after we
      // negotiated encryption is not behaving as documented and is treated
      // as a protocol failure, not silently accepted.
      this._log('plaintext frame received after encryption was established — closing connection')
      this._failConnection(new ConnectionRefusedError('ENCRYPTION_DOWNGRADE', 'daemon sent a plaintext frame after encryption was established'))
      return
    }

    this._dispatch(msg, authenticated)
  }

  /**
   * Record/retire a pending permission this client has OBSERVED. Called for
   * every live (ready-state) message, and for each pre-ready buffered message
   * that survives the flush's authentication filter — never directly on a
   * pre-ready arrival, because at that point the frame's provenance is not
   * yet known (see `connect()`'s flush).
   */
  _trackPermissionObservation(msg) {
    if (msg.type === 'permission_request' && typeof msg.requestId === 'string' && msg.sessionId) {
      this._observedPermissions.set(msg.requestId, { sessionId: msg.sessionId, seenAt: Date.now() })
    } else if ((msg.type === 'permission_resolved' || msg.type === 'permission_expired') && typeof msg.requestId === 'string') {
      this._observedPermissions.delete(msg.requestId)
    }
  }

  _dispatch(msg, authenticated = false) {
    if (this._state !== 'ready') {
      // During the handshake/startup fence, request/response correlation
      // (input acks, list/create/subscribe replies) is deliberately BLIND —
      // nothing we've sent yet could have a reply pending. But state-bearing
      // broadcasts the daemon replays right after auth (most importantly
      // `permission_request` for an already-pending permission) are real and
      // must not be silently lost just because they arrived before the
      // fence's `pong`. Buffer them (bounded), tagged with whether they
      // arrived under the connection key, and flush through the same path a
      // live message takes — observation included — immediately after
      // `reset()` mints the fresh epoch they'll be recorded under.
      // `respondPermission` requires the ready state, so deferring the
      // observation to the (synchronous) flush cannot make a real pending
      // request unanswerable.
      if (PRE_READY_BUFFERED_TYPES.has(msg.type)) {
        if (this._preReadyBuffer.length >= MAX_PRE_READY_BUFFER) this._preReadyBuffer.shift()
        this._preReadyBuffer.push({ msg, authenticated })
      }
      this.emit('_handshake', msg)
      return
    }

    // Ready state: a plaintext frame on an encryption-required connection
    // never gets here (`_onRawMessage` fails the connection first), so every
    // message reaching this point is as authenticated as the connection is.
    this._trackPermissionObservation(msg)
    this._processReadyMessage(msg)
  }

  /**
   * The "connection is ready" half of message processing — request/response
   * correlation, event-log recording, and the `message` re-emission. Shared
   * between live dispatch and the post-handshake flush of
   * `_preReadyBuffer` (see `_dispatch`), so a buffered pre-ready message is
   * processed through EXACTLY the same logic a live one would be.
   *
   * The FIRST thing this does is redact the message deeply, in place of the
   * original — every downstream consumer (serial-op resolution, input_ack
   * resolution, permission resolution, the retained event log, the
   * `message` re-emission every public method's promises ultimately resolve
   * from) therefore only ever sees the redacted copy. This is deliberately
   * BEFORE `classifyBroadcast`'s truncation — truncating first could split a
   * secret across the cut point and leave a still-recognizable fragment on
   * one side.
   */
  _processReadyMessage(rawMsg) {
    const msg = this._redactMessageDeep(rawMsg)
    if (msg.type === 'input_ack' && typeof msg.clientMessageId === 'string') {
      const key = this._inputAckKey(msg.sessionId, msg.clientMessageId)
      const pending = this._pendingInputAcks.get(key)
      // Exact sessionId match required — a MISSING sessionId on the ack is
      // NOT treated as a match (a legacy reply path that omits sessionId
      // must not be silently assumed to be about whichever session we
      // happen to be waiting on). `typeof pending.resolve === 'function'`
      // excludes a bare reservation (see sendInput) that hasn't reached the
      // "actually waiting" stage yet — see `_rejectAllPending` for why that
      // state can exist at all.
      if (pending && typeof pending.resolve === 'function' && msg.sessionId === pending.sessionId) {
        pending.lastKnown = msg
        if (msg.reason === 'admission_pending') {
          // Intermediate status update, not the final word — keep waiting
          // for a conclusive ack or the deadline.
        } else {
          this._pendingInputAcks.delete(key)
          clearTimeout(pending.timer)
          pending.resolve(msg)
        }
      }
      // An ack for an id/session we don't recognize (another connection's
      // message, or one we already timed out) is intentionally NOT
      // re-correlated — see class doc "never silently retry".
    } else if ((msg.type === 'permission_resolved' || msg.type === 'permission_expired' || (msg.type === 'error' && msg.requestId)) && typeof msg.requestId === 'string') {
      const pending = this._pendingPermissionResponses.get(msg.requestId)
      if (pending) {
        this._pendingPermissionResponses.delete(msg.requestId)
        clearTimeout(pending.timer)
        const status = msg.type === 'permission_resolved' ? 'resolved' : msg.type === 'permission_expired' ? 'expired' : 'rejected'
        pending.resolve({ status, requestId: msg.requestId, sessionId: pending.sessionId, decision: msg.decision, detail: msg })
      }
    } else if (msg.type === 'history_replay_start' && msg.sessionId) {
      this._replayingSessions.add(msg.sessionId)
    } else if (msg.type === 'history_replay_end' && msg.sessionId) {
      this._replayingSessions.delete(msg.sessionId)
    } else if (msg.type === 'model_changed' && msg.sessionId) {
      const expectation = this._modelExpectations.get(msg.sessionId)
      if (expectation) {
        const observed = msg.model ?? null
        const unknown = observed === null
        const mismatch = !unknown && expectation.requestedModel !== null && expectation.requestedModel !== observed
        expectation.lastKnownStatus = { requested: expectation.requestedModel, observed, unknown, mismatch }
      }
    }

    if (this._pendingSerialOp) {
      const acceptTypes = SERIAL_REPLY_TYPES[this._pendingSerialOp.kind]
      // A `create_session` failure reply (`session_error`) is UNSCOPED —
      // the session was never created, so `handleCreateSession`'s error
      // path never stamps a `sessionId` (see session-handlers.js). A
      // SCOPED `session_error` (one naming a sessionId) belongs to some
      // OTHER concurrent session-targeted operation on this connection
      // (e.g. a sibling `interrupt`/`sendInput` failure broadcast) and must
      // never be mistaken for this create's own result — accepting it would
      // let an unrelated sibling error falsely fail (or, worse, silently
      // settle) a create that is actually still pending or already succeeded.
      const matchesKind = acceptTypes && acceptTypes.includes(msg.type)
        && !(this._pendingSerialOp.kind === 'create_session' && msg.type === 'session_error' && msg.sessionId != null)
      if (matchesKind) {
        const op = this._pendingSerialOp
        this._pendingSerialOp = null
        clearTimeout(op.timer)
        op.resolve(msg)
      }
    }

    const events = classifyBroadcast(msg, this._streamAccumulator, { includeThinking: this._includeThinking })
    for (const evt of events) {
      const data = this._replayingSessions.has(evt.sessionId) && evt.data && typeof evt.data === 'object'
        ? { ...evt.data, replay: true }
        : evt.data
      this._eventLog.push(evt.sessionId, evt.type, data)
    }
    this.emit('message', msg)
  }

  _inputAckKey(sessionId, clientMessageId) {
    return `${sessionId}::${clientMessageId}`
  }

  /**
   * Deep-copy `value`, redacting every string for (a) an EXACT match of this
   * connection's own bearer token — the one secret this client actually
   * knows, so an exact match can never miss it regardless of length or
   * shape, (b) `redactValue`'s pattern-based heuristics for OTHER secret
   * shapes (API keys, JWTs, webhook URLs, …), and (c) whole-value redaction
   * for any key NAME in the shared `SENSITIVE_KEY_NAMES` set (token/
   * password/secret/credential/…) — a value under one of those keys is
   * masked outright regardless of its shape, matching the broadcast
   * sanitizer's own key-name rule (redaction.js) so a plaintext
   * password/credential field can't slip through just because it doesn't
   * match any of the VALUE-shape patterns. Applied only to post-handshake
   * application messages (see `_processReadyMessage`) — never to the
   * handshake's own crypto material (exchange keys / signatures), which
   * this must not risk mangling.
   *
   * Depth overflow returns a bounded MARKER, not the raw (unredacted, and
   * potentially attacker-controlled-depth) subtree — returning the raw value
   * would be exactly the kind of "the guard fires but hands back the
   * un-guarded content anyway" failure this exists to prevent.
   */
  _redactMessageDeep(value, depth = 0) {
    if (depth > 10) return '[max depth exceeded]'
    if (typeof value === 'string') return redactValue(redactToken(value, this._token))
    if (Array.isArray(value)) return value.map((v) => this._redactMessageDeep(v, depth + 1))
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) {
        // Mask WHOLE-VALUE under a sensitive key name regardless of shape —
        // an object/array value (a nested `{ credentials: { user, pass } }`
        // blob, say) under a sensitive key is exactly as much a leak as a
        // bare string one; recursing into it instead of masking it outright
        // would miss that.
        if (SENSITIVE_KEY_NAMES.has(k.toLowerCase()) && v !== null && v !== undefined) {
          out[k] = '[REDACTED]'
        } else {
          out[k] = this._redactMessageDeep(v, depth + 1)
        }
      }
      return out
    }
    return value
  }

  _onSocketClosed(code, reason) {
    if (this._state === 'closed') return
    const wasReady = this._state === 'ready'
    this._state = 'closed'
    this._teardownConnectionState()
    this._abortHandshakeWaiters(new NotConnectedError(`connection closed (code=${code})`))
    this._rejectAllPending(new NotConnectedError(`connection closed (code=${code})`))
    if (wasReady) this.emit('close', { code, reason: redactPublicText(reason?.toString?.() ?? '', this._token) })
  }

  /**
   * Every place a connection ends (explicit `close()`, an unexpected socket
   * close, or `_failConnection`) must wake/clear the SAME state — a
   * long-poll `getEvents` waiter left registered past disconnect would sit
   * until its own timeout fires instead of resolving immediately, and stale
   * stream/permission/subscription state would otherwise survive into
   * whatever the caller does next (which, for THIS client instance, is
   * nothing — `_assertReady()` blocks all further calls — but leaving it
   * live is still a real leak, not just cosmetic).
   */
  _teardownConnectionState() {
    this._eventLog.reset() // wakes every waiter (see SessionEventLog.reset) and clears retained events
    this._streamAccumulator.clear()
    this._observedPermissions.clear()
    this._replayingSessions.clear()
    this._subscribedSessionIds.clear()
    this._preReadyBuffer = [] // a connect() that failed mid-fence must not leave buffered messages referenced
  }

  _onSocketError(err) {
    err = this._safeError(err)
    this._log('socket error:', err.message)
    if (this._state !== 'closed') {
      this._abortHandshakeWaiters(err)
    }
    this.emit('error', err)
  }

  _failConnection(err) {
    err = this._safeError(err)
    this._state = 'closed'
    this._teardownConnectionState()
    this._abortHandshakeWaiters(err)
    this._rejectAllPending(err)
    try { this._ws?.close() } catch { /* already closing */ }
    this.emit('error', err)
  }

  _safeError(err) {
    const safe = new Error(redactPublicText(err?.message ?? String(err), this._token))
    if (err instanceof Error) Object.setPrototypeOf(safe, Object.getPrototypeOf(err))
    safe.name = redactPublicText(err?.name || 'Error', this._token)
    if (typeof err?.code === 'string') safe.code = redactPublicText(err.code, this._token)
    else if (typeof err?.code === 'number') safe.code = err.code
    if (typeof err?.stack === 'string') safe.stack = redactPublicText(err.stack, this._token)
    return safe
  }

  _rejectAllPending(err) {
    for (const pending of this._pendingInputAcks.values()) {
      // A bare RESERVATION (sendInput still awaiting its model/subscription
      // checks — see sendInput's reservation comment) has no `resolve`/timer
      // yet; the in-flight `sendInput` call's own catch block cleans it up
      // when the awaited failure propagates to it. Nothing to settle here.
      if (typeof pending.resolve !== 'function') continue
      clearTimeout(pending.timer)
      // sendInput's contract is "never throw on timeout/disconnect" — resolve
      // with an uncertain result instead of rejecting, matching the timeout path.
      pending.resolve({ status: 'uncertain', delivery: 'unknown', retrySafe: false, dedupScope: pending.lastKnown?.dedupScope ?? 'process', clientMessageId: pending.clientMessageId, sessionId: pending.sessionId, disconnected: true, lastKnownStatus: pending.lastKnown ?? null, message: err.message })
    }
    this._pendingInputAcks.clear()
    for (const [requestId, pending] of this._pendingPermissionResponses) {
      clearTimeout(pending.timer)
      pending.resolve({ status: 'uncertain', requestId, sessionId: pending.sessionId, disconnected: true, message: err.message })
    }
    this._pendingPermissionResponses.clear()
    if (this._pendingSerialOp) {
      clearTimeout(this._pendingSerialOp.timer)
      this._pendingSerialOp.reject(err)
      this._pendingSerialOp = null
    }
  }
}
