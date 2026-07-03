/**
 * MCP child-process lifecycle for the claude-byok provider (#4077).
 *
 * One MCPClient owns one MCP server child. Handles spawn, JSON-RPC handshake
 * (initialize → initialized → tools/list), crash detection with exponential
 * backoff between restart attempts (1s/2s/4s, #4453), and SIGTERM/SIGKILL
 * grace on destroy.
 *
 * Per #4077 scope:
 *   - Lazy spawn: caller decides when to call start().
 *   - Crash detection on child exit / spawn error → schedule restart per the
 *     RESTART_BACKOFF_MS schedule (1s/2s/4s).
 *   - After MAX_RESTART_ATTEMPTS failures, state=dead and tools=[].
 *   - Session destroy sends SIGTERM, escalates to SIGKILL at KILL_GRACE_MS.
 *
 * Out of scope (next stages):
 *   - Materializing into Anthropic SDK tools[] (#4078).
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createLogger } from './logger.js'
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
