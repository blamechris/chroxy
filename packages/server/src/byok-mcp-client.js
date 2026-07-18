/**
 * MCP client lifecycle for the claude-byok provider (#4077, #6821).
 *
 * Two transports live here behind one interface (state / tools / start() /
 * callTool() / destroy() + the same state/ready/dead events):
 *
 *   - MCPClient       — stdio: owns one MCP server CHILD PROCESS. Handles
 *     spawn, JSON-RPC handshake (initialize → initialized → tools/list), crash
 *     detection with exponential backoff between restart attempts (1s/2s/4s,
 *     #4453), and SIGTERM/SIGKILL grace on destroy.
 *   - MCPRemoteClient — network (#6821): speaks the MCP Streamable HTTP
 *     transport (POST JSON-RPC to a url, honour the Mcp-Session-Id header,
 *     read an SSE-upgraded response when the server streams one) with a
 *     legacy HTTP+SSE fallback for `type: 'sse'` servers. No child process,
 *     so the process-restart model does not apply — a network client makes a
 *     single connect attempt and surfaces a clear status on failure (notably
 *     `oauth-required` on a 401, deferred to #6822).
 *
 * `createMcpClient(config, opts)` picks the transport from the config shape
 * (a `url` selects the remote client) so the fleet stays transport-agnostic.
 *
 * Out of scope (next stages):
 *   - Materializing into Anthropic SDK tools[] (#4078).
 */

import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createLogger } from './logger.js'
import { isBlockedMetadataHost } from './byok-mcp-config.js'
import { CHROXY_SECRET_DENYLIST } from './utils/spawn-env.js'
import { prepareSpawn } from './utils/win-spawn.js'

// #4453: exponential restart backoff. The first restart still fires at ~1s
// after the death (no regression on the existing acceptance test); the
// second waits ~2s after that failure; the third waits ~4s. Total budget
// before DEAD is ~7s, up from the previous fixed 3s. This better matches
// "wedged dependency that needs a moment to recover" failure modes (e.g.
// a transient port conflict that resolves in ~5s would have been blown
// past by the previous 1/1/1 schedule).
//
// The array length is the authoritative max-attempt count — derive
// MAX_RESTART_ATTEMPTS from it so an operator who edits the schedule
// can't accidentally desync the two.
const RESTART_BACKOFF_MS = [1000, 2000, 4000]
const MAX_RESTART_ATTEMPTS = RESTART_BACKOFF_MS.length
const KILL_GRACE_MS = 1000
// #4454: handshake-request timeout. Some MCP servers (sandboxed containers,
// servers that download packages on startup) legitimately take >5s to reply
// to initialize / tools/list. Override per-config via `handshakeTimeoutMs`
// (preferred — sourced from ~/.claude.json → byok-mcp-config) or per-
// MCPClient via `opts.handshakeTimeoutMs` (used by tests). The export
// makes #4078 / future tooling able to read the default without
// re-deriving it. Both export and the override remain on the same
// "absolute upper bound for ONE handshake request" semantics — total
// handshake budget is up to 2× this (initialize + tools/list).
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000

// #4452: MCP spec version we request on initialize. Bumping this is a
// deliberate change — when MCP releases a new spec date and we adopt it,
// update this constant + verify against the negotiation log-warn output.
// Servers that don't recognise it should still accept the handshake
// (per spec) and reply with their own protocolVersion; the negotiation
// warn surfaces the mismatch without erroring.
export const MCP_PROTOCOL_VERSION = '2024-11-05'

// #4452: clientInfo.version on initialize. Derived from this package's
// package.json so MCP-server-side logs/debugging name a real chroxy
// version instead of the previous '1' placeholder. Synchronous read at
// module load is fine because the file is tiny and never changes
// mid-process.
function readPackageVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(here, '..', 'package.json')
    const raw = readFileSync(pkgPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.version === 'string' && parsed.version.length > 0) {
      return parsed.version
    }
  } catch {
    // Fall through — never block startup on a missing/unreadable package.json.
  }
  return '0.0.0'
}
export const MCP_CLIENT_VERSION = readPackageVersion()

export const MCP_STATES = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  READY: 'ready',
  RESTARTING: 'restarting',
  DEAD: 'dead',
  DESTROYED: 'destroyed',
})

export class MCPClient extends EventEmitter {
  constructor(config, opts = {}) {
    super()
    this.name = config.name
    this._config = config
    this._log = opts.log || createLogger('byok-mcp')
    // #4457: optional async gate consulted before EACH start() (not each
    // restart — a trust decision applies to the whole (name, command, args[0])
    // tuple, which doesn't change between restart attempts). Returns true →
    // proceed; false → state=DEAD permanently, no child is ever spawned.
    this._trustGate = opts.trustGate || null
    // #4454: per-instance handshake timeout. Precedence (high → low):
    //   1. opts.handshakeTimeoutMs (constructor; tests / fleet pass-through)
    //   2. config.handshakeTimeoutMs (per-MCP-server, sourced from ~/.claude.json)
    //   3. DEFAULT_HANDSHAKE_TIMEOUT_MS module constant
    // Same defensive guard as resultTimeoutMs in byok-session: non-finite
    // / non-positive (NaN, Infinity, 0, -1, '5s') falls through to the next
    // tier because setTimeout coerces those to 0ms and would make every
    // handshake look broken.
    this._handshakeTimeoutMs =
      (Number.isFinite(opts.handshakeTimeoutMs) && opts.handshakeTimeoutMs > 0 && opts.handshakeTimeoutMs) ||
      (Number.isFinite(config?.handshakeTimeoutMs) && config.handshakeTimeoutMs > 0 && config.handshakeTimeoutMs) ||
      DEFAULT_HANDSHAKE_TIMEOUT_MS
    this._state = MCP_STATES.IDLE
    this._tools = []
    this._child = null
    this._stdoutBuf = ''
    this._nextId = 1
    this._pending = new Map()
    this._restartTimer = null
    this._restartAttempts = 0
    this._destroyed = false
  }

  get state() { return this._state }
  get tools() { return this._tools }

  async start() {
    if (this._destroyed) throw new Error('MCPClient destroyed')
    if (this._state === MCP_STATES.READY) return
    if (this._state === MCP_STATES.DEAD) return
    // #4457: trust gate fires BEFORE spawn. Deny → permanent DEAD, no child
    // process is ever created. Trust gate throwing is treated as deny so
    // the spawn surface fails closed.
    if (this._trustGate) {
      let allowed
      try {
        allowed = await this._trustGate()
      } catch (err) {
        this._log.warn(`MCP server ${this.name}: trust gate threw: ${err?.message || err}`)
        allowed = false
      }
      if (!allowed) {
        this._setState(MCP_STATES.DEAD)
        this.emit('dead')
        return
      }
    }
    this._spawnAndHandshake()
    // Resolve when state stabilises — first READY (handshake success) or
    // DEAD (max restart attempts exhausted). RESTARTING intermediate states
    // are transparent to the caller; what they want is "is this thing
    // usable or not", and that's the steady-state answer.
    if (this._state !== MCP_STATES.READY && this._state !== MCP_STATES.DEAD) {
      await new Promise((resolve) => {
        const onState = ({ next }) => {
          if (next === MCP_STATES.READY || next === MCP_STATES.DEAD) {
            this.off('state', onState)
            resolve()
          }
        }
        this.on('state', onState)
      })
    }
  }

  /**
   * Build the env for the spawned MCP server child. Inherits the operator's
   * full process env plus any user-configured `_config.env`, then strips the
   * chroxy-owned daemon secrets (#6311) — the full-authority API_TOKEN must
   * never reach an MCP server subprocess, which could read it and seize the
   * daemon. Extracted so the strip is unit-testable without a real spawn.
   *
   * @returns {Record<string, string>}
   */
  _buildChildEnv() {
    const env = { ...process.env, ...this._config.env }
    for (const key of CHROXY_SECRET_DENYLIST) {
      delete env[key]
    }
    return env
  }

  _spawnAndHandshake() {
    this._setState(MCP_STATES.STARTING)
    let child
    try {
      // #6504 — route a user-configured .cmd/.bat MCP command through cmd.exe on
      // Windows (Node 24 rejects spawning a .cmd shim directly with EINVAL, e.g.
      // an npx-style shim). prepareSpawn is a no-op for .exe/POSIX, so non-Windows
      // behaviour is unchanged; its cross-spawn escaping passes the user-supplied
      // args verbatim through cmd.exe (round-tripped in win-spawn.test.js).
      const spawnSpec = prepareSpawn(this._config.command, this._config.args)
      child = spawn(spawnSpec.command, spawnSpec.args, {
        env: this._buildChildEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        ...spawnSpec.options,
      })
    } catch (err) {
      this._log.warn(`MCP server ${this.name}: spawn threw: ${err?.message || err}`)
      this._onExit(null, null)
      return
    }
    this._child = child
    child.on('error', (err) => {
      this._log.warn(`MCP server ${this.name}: child error: ${err?.message || err}`)
    })
    child.stderr.on('data', (chunk) => {
      this._log.debug(`MCP server ${this.name} stderr: ${chunk.toString().trimEnd()}`)
    })
    child.stdout.on('data', (chunk) => this._onStdoutChunk(chunk))
    child.on('exit', (code, signal) => this._onExit(code, signal))

    this._handshake().catch((err) => {
      this._log.warn(`MCP server ${this.name}: handshake failed: ${err?.message || err}`)
      this._killChild()
    })
  }

  async _handshake() {
    const initResult = await this._request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'chroxy-byok', version: MCP_CLIENT_VERSION },
    }, this._handshakeTimeoutMs)
    if (!initResult || typeof initResult !== 'object') {
      throw new Error('initialize returned non-object result')
    }
    // #4452: negotiation log-warn. If the server replies with a different
    // protocolVersion than we requested, log it once so a future spec
    // mismatch is debuggable. Per spec the server's value wins — we don't
    // error, both sides are expected to interoperate at the server's
    // declared version. Bumping MCP_PROTOCOL_VERSION should silence the
    // warn for the matching server.
    const serverVersion = initResult.protocolVersion
    if (typeof serverVersion === 'string' && serverVersion !== MCP_PROTOCOL_VERSION) {
      this._log.warn(`MCP server ${this.name}: protocolVersion mismatch — requested=${MCP_PROTOCOL_VERSION} server=${serverVersion} (negotiating to server value)`)
    }
    this._notify('notifications/initialized')
    const toolsResult = await this._request('tools/list', {}, this._handshakeTimeoutMs)
    const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : []
    this._tools = Object.freeze(tools.map((t) => Object.freeze({ ...t })))
    this._restartAttempts = 0
    this._setState(MCP_STATES.READY)
    this.emit('ready', this._tools)
  }

  async callTool(toolName, args, timeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS) {
    if (this._state !== MCP_STATES.READY) {
      throw new Error(`MCP server ${this.name} not ready (state=${this._state})`)
    }
    return this._request('tools/call', { name: toolName, arguments: args || {} }, timeoutMs)
  }

  _request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      let timer = null
      const settle = (err, val) => {
        if (timer) clearTimeout(timer)
        this._pending.delete(id)
        if (err) reject(err); else resolve(val)
      }
      this._pending.set(id, settle)
      timer = setTimeout(() => settle(new Error(`MCP ${method} timeout`)), timeoutMs)
      if (!this._child?.stdin?.writable) {
        settle(new Error('MCP child stdin not writable'))
        return
      }
      this._child.stdin.write(payload, (err) => {
        if (err) settle(err)
      })
    })
  }

  _notify(method, params) {
    if (!this._child?.stdin?.writable) return
    this._child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  _onStdoutChunk(chunk) {
    this._stdoutBuf += chunk.toString('utf8')
    const lines = this._stdoutBuf.split('\n')
    this._stdoutBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch (err) {
        this._log.warn(`MCP server ${this.name}: non-JSON line: ${line.slice(0, 80)}`)
        continue
      }
      if (msg.id == null) {
        // Notification from the server (per JSON-RPC spec: `id` is required
        // on responses, absent on notifications). Ignored silently — they
        // are a normal part of the protocol (e.g. `notifications/cancelled`,
        // server-initiated progress events) and would only add log noise.
        continue
      }
      if (this._pending.has(msg.id)) {
        const settle = this._pending.get(msg.id)
        if (msg.error) settle(new Error(msg.error.message || 'MCP RPC error'))
        else settle(null, msg.result)
      } else {
        // #4455: orphan response — server emitted a response with an id we
        // never sent (or one we already settled). Could be a buggy server
        // emitting a stale id after restart, a state-machine bug on the
        // server side, or a duplicate. Not necessarily an error (don't
        // warn); but without a log we'd have no audit trail when debugging
        // "why doesn't my MCP tool respond". Capture the unmatched id and
        // a small shape marker so future investigation has something to
        // grep for.
        const shape = msg.error ? 'error' : 'result'
        this._log.debug(`MCP server ${this.name}: orphan JSON-RPC response id=${msg.id} shape=${shape}`)
      }
    }
  }

  _onExit(code, signal) {
    const wasStartingOrReady = this._state === MCP_STATES.STARTING || this._state === MCP_STATES.READY
    for (const settle of this._pending.values()) settle(new Error('MCP child exited'))
    this._pending.clear()
    this._stdoutBuf = ''
    this._child = null

    if (this._destroyed) {
      this._setState(MCP_STATES.DESTROYED)
      return
    }
    if (!wasStartingOrReady) return

    this._tools = []
    this._restartAttempts += 1
    // #4453: gate on `>` (not `>=`) so the FULL RESTART_BACKOFF_MS schedule
    // is consumed before declaring DEAD. Pre-#4453 the gate fired on `>=`
    // and MAX_RESTART_ATTEMPTS=3 — meaning only 2 restart delays were
    // actually applied (the 3rd post-spawn-death went straight to DEAD with
    // the 3rd entry of the schedule unused). Under `>`, MAX=3 yields 3
    // applied delays (1s/2s/4s), and DEAD fires after the 4th post-death
    // count crosses the bound. Issue framing: "max 3 attempts before
    // declaring dead" means 3 restarts actually happen, then DEAD.
    if (this._restartAttempts > MAX_RESTART_ATTEMPTS) {
      this._log.warn(`MCP server ${this.name}: dead after ${this._restartAttempts - 1} failed attempts (last exit code=${code} signal=${signal})`)
      this._setState(MCP_STATES.DEAD)
      this.emit('dead')
      return
    }

    this._setState(MCP_STATES.RESTARTING)
    this.emit('restart', { attempt: this._restartAttempts, code, signal })
    // #4453: pick the delay for this attempt from the backoff schedule.
    // _restartAttempts was bumped above; subtract 1 to index. Defensive
    // fallback to the last entry guards against a future refactor that
    // diverges MAX_RESTART_ATTEMPTS from the array length.
    const delayIdx = Math.min(this._restartAttempts - 1, RESTART_BACKOFF_MS.length - 1)
    const delay = RESTART_BACKOFF_MS[delayIdx]
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null
      if (this._destroyed) return
      this._spawnAndHandshake()
    }, delay)
  }

  _killChild() {
    if (!this._child) return
    try { this._child.kill('SIGTERM') } catch {}
  }

  destroy() {
    if (this._destroyed) return Promise.resolve()
    this._destroyed = true
    if (this._restartTimer) {
      clearTimeout(this._restartTimer)
      this._restartTimer = null
    }
    const child = this._child
    if (!child) {
      this._setState(MCP_STATES.DESTROYED)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const onExit = () => {
        clearTimeout(killTimer)
        resolve()
      }
      child.once('exit', onExit)
      try { child.kill('SIGTERM') } catch {}
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
      }, KILL_GRACE_MS)
    })
  }

  _setState(next) {
    if (this._state === next) return
    const prev = this._state
    this._state = next
    this.emit('state', { prev, next })
  }
}

// ---------------------------------------------------------------------------
// Remote transport (#6821): MCP Streamable HTTP + legacy HTTP+SSE.
// ---------------------------------------------------------------------------

/**
 * Iterate a fetch response body as chunks. Node's `fetch` returns a web
 * ReadableStream (undici); prefer async iteration when available, else fall
 * back to an explicit reader so the SSE loop works across node versions.
 */
async function* iterateStream(stream) {
  if (!stream) return
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    yield* stream
    return
  }
  const reader = stream.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    try { reader.releaseLock() } catch { /* stream already closed */ }
  }
}

/**
 * Parse one SSE event block into `{ event, data }`. Per the SSE grammar a
 * `data:` field drops a single leading space and multiple `data:` lines join
 * with newlines; `id:`/`retry:`/comment (`:`) lines are ignored — we only
 * need the event name and its JSON-RPC data payload.
 */
function parseSseEvent(rawEvent) {
  let event = 'message'
  const dataLines = []
  for (const line of rawEvent.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '').trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  return { event, data: dataLines.length > 0 ? dataLines.join('\n') : null }
}

/** Parse a POST body (single object or JSON-RPC batch array) for the response matching `id`. */
function extractJsonRpcResponse(text, id) {
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.find((m) => m && m.id === id) || null
}

export class MCPRemoteClient extends EventEmitter {
  constructor(config, opts = {}) {
    super()
    this.name = config.name
    this._config = config
    this._log = opts.log || createLogger('byok-mcp')
    // Injectable HTTP client (defaults to the global fetch), mirroring the
    // fetchImpl seam in get-public-ip / discord-webhook-client so tests can
    // drive the transport against an in-process http server. fetch is a node
    // primitive — no new npm dependency, consistent with the hand-rolled
    // stdio client above.
    this._fetchImpl = opts.fetchImpl || globalThis.fetch
    // #4457 parity: optional async trust gate consulted before the first
    // connect. true → proceed; false / throw → permanent DEAD, no request
    // ever leaves the process.
    this._trustGate = opts.trustGate || null
    // #4454 parity: per-request handshake timeout. Same precedence + defensive
    // guard as the stdio client (opts > config > module default).
    this._handshakeTimeoutMs =
      (Number.isFinite(opts.handshakeTimeoutMs) && opts.handshakeTimeoutMs > 0 && opts.handshakeTimeoutMs) ||
      (Number.isFinite(config?.handshakeTimeoutMs) && config.handshakeTimeoutMs > 0 && config.handshakeTimeoutMs) ||
      DEFAULT_HANDSHAKE_TIMEOUT_MS
    this._url = config.url
    // 'sse' → legacy HTTP+SSE two-endpoint transport; anything else → modern
    // Streamable HTTP (single endpoint, POST + optional SSE-upgraded response).
    this._transportType = config.type === 'sse' ? 'sse' : 'http'
    this._headers = config.headers || {}
    this._state = MCP_STATES.IDLE
    this._tools = []
    this._nextId = 1
    this._sessionId = null
    this._negotiatedProtocolVersion = null
    // 'oauth-required' after a 401/407 (needs the OAuth flow from #6822), else
    // null. Read for status surfacing — never carries any header/token value.
    this._statusReason = null
    this._destroyed = false
    // In-flight AbortControllers, aborted on destroy() so a hung request or a
    // persistent SSE stream cannot keep the process alive after teardown.
    this._controllers = new Set()
    // Legacy-SSE only: resolved POST endpoint + pending-request registry
    // (streamable HTTP awaits each POST inline, so it leaves these empty).
    this._endpointUrl = null
    this._pending = new Map()
    this._endpointTimer = null
    this._endpointResolve = null
    this._endpointReject = null
  }

  get state() { return this._state }
  get tools() { return this._tools }
  get statusReason() { return this._statusReason }

  async start() {
    if (this._destroyed) throw new Error('MCPRemoteClient destroyed')
    if (this._state === MCP_STATES.READY || this._state === MCP_STATES.DEAD) return
    // #6834 sharp edge, folded in pre-merge: unconditionally refuse
    // cloud-metadata / link-local targets at REQUEST time too (parse already
    // rejects them; this guards configs constructed programmatically). Checked
    // before the trust gate so the user is never prompted to trust a URL we
    // will refuse regardless.
    const refusal = await this._refuseMetadataTarget()
    if (refusal) {
      this._log.warn(`MCP server ${this.name}: ${refusal}`)
      this._toDead()
      return
    }
    // #4457 parity: trust gate fires BEFORE any network request. Deny/throw →
    // permanent DEAD, fail-closed.
    if (this._trustGate) {
      let allowed
      try {
        allowed = await this._trustGate()
      } catch (err) {
        this._log.warn(`MCP server ${this.name}: trust gate threw: ${err?.message || err}`)
        allowed = false
      }
      if (!allowed) {
        this._toDead()
        return
      }
    }
    this._setState(MCP_STATES.STARTING)
    try {
      if (this._transportType === 'sse') await this._connectLegacySse()
      else await this._handshakeStreamableHttp()
      if (this._destroyed) { this._setState(MCP_STATES.DESTROYED); return }
      this._setState(MCP_STATES.READY)
      this.emit('ready', this._tools)
    } catch (err) {
      if (this._destroyed) { this._setState(MCP_STATES.DESTROYED); return }
      if (err && err._oauthRequired) {
        // Deferred to #6822 — surface a clear status instead of crashing.
        this._statusReason = 'oauth-required'
        this._log.warn(`MCP server ${this.name}: requires OAuth — not yet supported (#6822)`)
      } else {
        this._log.warn(`MCP server ${this.name}: connect failed: ${err?.message || err}`)
      }
      this._toDead()
    }
  }

  async callTool(toolName, args, timeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS) {
    if (this._state !== MCP_STATES.READY) {
      throw new Error(`MCP server ${this.name} not ready (state=${this._state})`)
    }
    const params = { name: toolName, arguments: args || {} }
    return this._transportType === 'sse'
      ? this._rpcViaEndpoint('tools/call', params, timeoutMs)
      : this._rpcPost('tools/call', params, timeoutMs)
  }

  async destroy() {
    if (this._destroyed) return
    this._destroyed = true
    if (this._endpointTimer) { clearTimeout(this._endpointTimer); this._endpointTimer = null }
    this._rejectAllPending(new Error('MCP remote client destroyed'))
    for (const c of this._controllers) { try { c.abort() } catch { /* already settled */ } }
    this._controllers.clear()
    // Best-effort Streamable HTTP session teardown (spec: DELETE with the
    // session header). Bounded by KILL_GRACE_MS and fully error-swallowed —
    // it must never make destroy() hang or throw.
    if (this._transportType === 'http' && this._sessionId && typeof this._fetchImpl === 'function') {
      const controller = new AbortController()
      const timer = setTimeout(() => { try { controller.abort() } catch {} }, KILL_GRACE_MS)
      try {
        const res = await this._fetchImpl(this._url, {
          method: 'DELETE',
          headers: this._buildHeaders(),
          redirect: 'manual', // #6834: never follow a redirect off-origin
          signal: controller.signal,
        })
        await this._discardBody(res)
      } catch { /* teardown is best-effort */ } finally {
        clearTimeout(timer)
      }
    }
    this._setState(MCP_STATES.DESTROYED)
  }

  // --- Streamable HTTP -----------------------------------------------------

  async _handshakeStreamableHttp() {
    const initResult = await this._rpcPost('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'chroxy-byok', version: MCP_CLIENT_VERSION },
    }, this._handshakeTimeoutMs, { captureSession: true })
    this._applyInitResult(initResult)
    await this._notifyPost('notifications/initialized')
    const toolsResult = await this._rpcPost('tools/list', {}, this._handshakeTimeoutMs)
    this._setTools(toolsResult)
  }

  /** POST one JSON-RPC request; resolve its result from a JSON or SSE-upgraded response. */
  async _rpcPost(method, params, timeoutMs, { captureSession = false } = {}) {
    const id = this._nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const controller = new AbortController()
    this._controllers.add(controller)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { controller.abort() } catch {} }, timeoutMs)
    try {
      let res
      try {
        res = await this._fetchImpl(this._url, {
          method: 'POST',
          headers: this._buildHeaders({ json: true, acceptStream: true }),
          body: payload,
          // #6834: never auto-follow — a redirect must not carry our
          // credentialed headers to a different origin. 3xx → _checkStatus throws.
          redirect: 'manual',
          signal: controller.signal,
        })
      } catch (err) {
        if (timedOut) throw new Error(`MCP ${method} timeout`)
        throw err
      }
      this._checkStatus(res, method)
      if (captureSession) {
        const sid = res.headers.get('mcp-session-id')
        if (sid) this._sessionId = sid
      }
      const contentType = (res.headers.get('content-type') || '').toLowerCase()
      let message
      if (contentType.includes('text/event-stream')) {
        message = await this._readSseUntilId(res.body, id)
      } else {
        let text
        try { text = await res.text() } catch (err) {
          if (timedOut) throw new Error(`MCP ${method} timeout`)
          throw err
        }
        message = extractJsonRpcResponse(text, id)
      }
      if (message == null) {
        if (timedOut) throw new Error(`MCP ${method} timeout`)
        throw new Error(`MCP ${method}: no matching JSON-RPC response`)
      }
      if (message.error) throw new Error(message.error?.message || `MCP ${method} RPC error`)
      return message.result
    } finally {
      clearTimeout(timer)
      this._controllers.delete(controller)
    }
  }

  /** POST a JSON-RPC notification (no id, no response expected). Best-effort but honours a 401. */
  async _notifyPost(method, params) {
    const controller = new AbortController()
    this._controllers.add(controller)
    const timer = setTimeout(() => { try { controller.abort() } catch {} }, this._handshakeTimeoutMs)
    try {
      let res
      try {
        res = await this._fetchImpl(this._url, {
          method: 'POST',
          headers: this._buildHeaders({ json: true, acceptStream: true }),
          body: JSON.stringify({ jsonrpc: '2.0', method, params }),
          redirect: 'manual', // #6834: never follow a redirect off-origin
          signal: controller.signal,
        })
      } catch {
        return // initialize already succeeded; a lost `initialized` is non-fatal
      }
      if (res.status === 401 || res.status === 407) {
        const err = new Error(`MCP server ${this.name} requires OAuth (HTTP ${res.status})`)
        err._oauthRequired = true
        throw err
      }
      await this._discardBody(res)
    } finally {
      clearTimeout(timer)
      this._controllers.delete(controller)
    }
  }

  /** Read an SSE stream until the JSON-RPC response with `id` arrives (or the stream ends). */
  async _readSseUntilId(body, id) {
    if (!body) return null
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of iterateStream(body)) {
      buf += decoder.decode(chunk, { stream: true })
      buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const { data } = parseSseEvent(buf.slice(0, idx))
        buf = buf.slice(idx + 2)
        if (data == null) continue
        let msg
        try { msg = JSON.parse(data) } catch { continue }
        if (msg && msg.id === id) return msg
        // Server-initiated notifications/requests before the response: ignore.
      }
    }
    return null
  }

  // --- Legacy HTTP+SSE (type: 'sse') ---------------------------------------

  async _connectLegacySse() {
    const controller = new AbortController()
    this._controllers.add(controller)
    let res
    try {
      res = await this._fetchImpl(this._url, {
        method: 'GET',
        headers: { ...this._headers, Accept: 'text/event-stream' },
        redirect: 'manual', // #6834: never follow a redirect off-origin
        signal: controller.signal,
      })
    } catch (err) {
      this._controllers.delete(controller)
      throw err
    }
    if (res.status === 401 || res.status === 407) {
      const err = new Error(`MCP server ${this.name} requires OAuth (HTTP ${res.status})`)
      err._oauthRequired = true
      throw err
    }
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`MCP server ${this.name} HTTP ${res.status} redirect opening SSE stream — refused (redirects are not followed)`)
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`MCP server ${this.name} HTTP ${res.status} opening SSE stream`)
    }
    const endpointReady = new Promise((resolve, reject) => {
      this._endpointResolve = resolve
      this._endpointReject = reject
      this._endpointTimer = setTimeout(
        () => reject(new Error(`MCP server ${this.name}: timeout waiting for SSE endpoint`)),
        this._handshakeTimeoutMs,
      )
    })
    // Background dispatch loop: resolves the endpoint, then routes responses.
    this._runSseDispatchLoop(res.body)
    await endpointReady
    await this._legacyHandshake()
  }

  async _legacyHandshake() {
    const initResult = await this._rpcViaEndpoint('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'chroxy-byok', version: MCP_CLIENT_VERSION },
    }, this._handshakeTimeoutMs)
    this._applyInitResult(initResult)
    await this._notifyViaEndpoint('notifications/initialized')
    const toolsResult = await this._rpcViaEndpoint('tools/list', {}, this._handshakeTimeoutMs)
    this._setTools(toolsResult)
  }

  async _runSseDispatchLoop(body) {
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for await (const chunk of iterateStream(body)) {
        buf += decoder.decode(chunk, { stream: true })
        buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          this._handleLegacyEvent(buf.slice(0, idx))
          buf = buf.slice(idx + 2)
        }
      }
    } catch (err) {
      if (!this._destroyed) this._log.debug(`MCP server ${this.name}: SSE stream error: ${err?.message || err}`)
    } finally {
      if (!this._destroyed) this._rejectAllPending(new Error('SSE stream closed'))
    }
  }

  _handleLegacyEvent(rawEvent) {
    const { event, data } = parseSseEvent(rawEvent)
    if (event === 'endpoint') {
      if (!this._endpointResolve) return
      let endpoint = null
      try { endpoint = new URL(data, this._url) } catch { endpoint = null }
      if (this._endpointTimer) { clearTimeout(this._endpointTimer); this._endpointTimer = null }
      // #6834 sharp edge: the endpoint event is SERVER-SUPPLIED — an absolute
      // url here could pivot our credentialed POSTs (headers carry auth)
      // anywhere. Enforce SAME-ORIGIN (scheme+host+port, via URL.origin)
      // against the configured url; a cross-origin endpoint warns + rejects,
      // which fails the connect → DEAD. Origins are creds/query-free, so
      // logging them leaks nothing.
      let configuredOrigin = null
      try { configuredOrigin = new URL(this._url).origin } catch { /* refused below */ }
      if (endpoint && configuredOrigin && endpoint.origin === configuredOrigin) {
        this._endpointUrl = endpoint.toString()
        this._endpointResolve()
      } else if (endpoint && configuredOrigin) {
        this._log.warn(`MCP server ${this.name}: SSE endpoint origin ${endpoint.origin} != configured origin ${configuredOrigin} — refusing cross-origin endpoint`)
        this._endpointReject?.(new Error(`MCP server ${this.name}: cross-origin SSE endpoint refused`))
      } else {
        this._endpointReject?.(new Error(`MCP server ${this.name}: invalid SSE endpoint event`))
      }
      this._endpointResolve = null
      this._endpointReject = null
      return
    }
    if (data == null) return
    let msg
    try { msg = JSON.parse(data) } catch { return }
    if (msg && msg.id != null && this._pending.has(msg.id)) {
      const settle = this._pending.get(msg.id)
      settle(msg)
    }
  }

  /** POST a JSON-RPC request to the legacy endpoint; await the response off the persistent SSE stream. */
  async _rpcViaEndpoint(method, params, timeoutMs) {
    if (!this._endpointUrl) throw new Error(`MCP server ${this.name}: no SSE endpoint`)
    const id = this._nextId++
    const responsePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        resolve({ id, error: { message: `MCP ${method} timeout` } })
      }, timeoutMs)
      this._pending.set(id, (msg) => { clearTimeout(timer); this._pending.delete(id); resolve(msg) })
    })
    const controller = new AbortController()
    this._controllers.add(controller)
    const postTimer = setTimeout(() => { try { controller.abort() } catch {} }, timeoutMs)
    try {
      const res = await this._fetchImpl(this._endpointUrl, {
        method: 'POST',
        headers: this._buildHeaders({ json: true }),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        redirect: 'manual', // #6834: never follow a redirect off-origin
        signal: controller.signal,
      })
      this._checkStatus(res, method)
      await this._discardBody(res)
    } catch (err) {
      this._pending.delete(id)
      throw err
    } finally {
      clearTimeout(postTimer)
      this._controllers.delete(controller)
    }
    const msg = await responsePromise
    if (msg.error) throw new Error(msg.error?.message || `MCP ${method} RPC error`)
    return msg.result
  }

  async _notifyViaEndpoint(method, params) {
    if (!this._endpointUrl) return
    const controller = new AbortController()
    this._controllers.add(controller)
    const timer = setTimeout(() => { try { controller.abort() } catch {} }, this._handshakeTimeoutMs)
    try {
      let res
      try {
        res = await this._fetchImpl(this._endpointUrl, {
          method: 'POST',
          headers: this._buildHeaders({ json: true }),
          body: JSON.stringify({ jsonrpc: '2.0', method, params }),
          redirect: 'manual', // #6834: never follow a redirect off-origin
          signal: controller.signal,
        })
      } catch {
        return // network-level failure is best-effort — initialize already succeeded
      }
      // Same status semantics as every other call site (_checkStatus): 401/407
      // → oauth-required (propagates → DEAD), redirect/other non-2xx → error →
      // DEAD. Pre-fix this swallowed ALL statuses, letting the handshake
      // proceed past `initialized` while the server was rejecting our requests.
      this._checkStatus(res, method)
      await this._discardBody(res)
    } finally {
      clearTimeout(timer)
      this._controllers.delete(controller)
    }
  }

  // --- shared helpers ------------------------------------------------------

  /**
   * Return a refusal reason when the configured url targets the cloud
   * metadata service / link-local range (#6834 sharp edge), else null.
   * Literal hosts are checked directly (the URL parser already canonicalized
   * hex/decimal tricks); DNS names get a best-effort lookup so a name
   * resolving into the blocked range is refused too. Lookup ERRORS pass
   * through — fetch will surface them as ordinary connect failures. Full
   * resolution pinning / DNS-rebinding defence stays in #6834.
   */
  async _refuseMetadataTarget() {
    let hostname
    try {
      hostname = new URL(this._url).hostname
    } catch {
      return null // fetch will surface the malformed url as a connect failure
    }
    if (isBlockedMetadataHost(hostname)) {
      return 'refusing cloud-metadata / link-local endpoint (never a legitimate MCP server)'
    }
    const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
    const isLiteral = /^[\d.]+$/.test(bare) || bare.includes(':')
    if (!isLiteral) {
      try {
        const addrs = await lookup(bare, { all: true })
        if (addrs.some(({ address }) => isBlockedMetadataHost(address))) {
          return 'refusing DNS name resolving to a cloud-metadata / link-local address'
        }
      } catch { /* resolution failures surface via fetch */ }
    }
    return null
  }

  _applyInitResult(initResult) {
    if (!initResult || typeof initResult !== 'object') {
      throw new Error('initialize returned non-object result')
    }
    const serverVersion = initResult.protocolVersion
    if (typeof serverVersion === 'string') {
      this._negotiatedProtocolVersion = serverVersion
      if (serverVersion !== MCP_PROTOCOL_VERSION) {
        this._log.warn(`MCP server ${this.name}: protocolVersion mismatch — requested=${MCP_PROTOCOL_VERSION} server=${serverVersion} (negotiating to server value)`)
      }
    }
  }

  _setTools(toolsResult) {
    const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : []
    this._tools = Object.freeze(tools.map((t) => Object.freeze({ ...t })))
  }

  _buildHeaders({ json = false, acceptStream = false } = {}) {
    const headers = { ...this._headers }
    if (acceptStream) headers.Accept = 'application/json, text/event-stream'
    if (json) headers['Content-Type'] = 'application/json'
    // #6821 Streamable HTTP: echo the session id + negotiated protocol version
    // on every post-initialize request per the 2025-03-26 / 2025-06-18 spec.
    if (this._sessionId) headers['Mcp-Session-Id'] = this._sessionId
    if (this._negotiatedProtocolVersion) headers['MCP-Protocol-Version'] = this._negotiatedProtocolVersion
    return headers
  }

  _checkStatus(res, method) {
    const status = res.status
    if (status === 401 || status === 407) {
      const err = new Error(`MCP server ${this.name} requires OAuth (HTTP ${status})`)
      err._oauthRequired = true
      throw err
    }
    // #6834: with redirect:'manual' a 3xx surfaces here as-is. Refuse it
    // explicitly — following would replay our credentialed headers against
    // whatever origin the Location header names.
    if (status >= 300 && status < 400) {
      throw new Error(`MCP server ${this.name} HTTP ${status} redirect on ${method} — refused (redirects are not followed)`)
    }
    if (status === 404) {
      // Session expired / endpoint gone — drop the session so a future connect
      // re-initializes; this request still fails below.
      this._sessionId = null
    }
    if (status < 200 || status >= 300) {
      throw new Error(`MCP server ${this.name} HTTP ${status} on ${method}`)
    }
  }

  async _discardBody(res) {
    try {
      if (res?.body && typeof res.body.cancel === 'function') await res.body.cancel()
      else if (res && typeof res.arrayBuffer === 'function') await res.arrayBuffer()
    } catch { /* nothing to drain */ }
  }

  _rejectAllPending(err) {
    for (const settle of this._pending.values()) {
      try { settle({ id: null, error: { message: err.message } }) } catch { /* already settled */ }
    }
    this._pending.clear()
  }

  _toDead() {
    this._tools = []
    this._rejectAllPending(new Error('MCP remote client dead'))
    this._setState(MCP_STATES.DEAD)
    this.emit('dead')
  }

  _setState(next) {
    if (this._state === next) return
    const prev = this._state
    this._state = next
    this.emit('state', { prev, next })
  }
}

/**
 * Pick the transport for a parsed MCP server config (#6821). A `url` selects
 * the remote (Streamable HTTP / SSE) client; otherwise the stdio child-process
 * client. Keeps byok-mcp-fleet.js transport-agnostic — it just calls this.
 */
export function createMcpClient(config, opts = {}) {
  const isRemote = typeof config?.url === 'string' && config.url.length > 0
  return isRemote ? new MCPRemoteClient(config, opts) : new MCPClient(config, opts)
}
