import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { createLogger } from './logger.js'

const log = createLogger('codex-app-server')

/**
 * JSON-RPC 2.0 transport for `codex app-server` (newline-delimited over stdio).
 *
 * Spawns the app-server child, performs the `initialize` / `initialized`
 * handshake, correlates client requests to their responses by id, and surfaces:
 *   - `notification` { method, params } — server → client events (streaming, items)
 *   - `serverRequest` { id, method, params } — server → client REQUESTS that need a
 *     reply (approvals / elicitation); the caller answers with respond()/respondError()
 *   - `exit` { code, signal, error? } — the child went away
 *
 * Protocol validated against codex-cli 0.128.0. This is pure transport — it maps
 * nothing onto Chroxy's session contract; CodexAppServerSession does that.
 */
export class CodexAppServerClient extends EventEmitter {
  constructor({ bin, cwd, env, logger } = {}) {
    super()
    this._bin = bin
    this._cwd = cwd
    this._env = env
    this._log = logger || log
    this._child = null
    this._buf = ''
    this._nextId = 1
    this._pending = new Map() // id -> { resolve, reject }
    this._closed = false
  }

  get pid() { return this._child?.pid ?? null }

  /**
   * Spawn the app-server and complete the handshake. Resolves with the
   * `initialize` result (userAgent, codexHome, ...). Rejects if the child
   * dies or the handshake errors.
   */
  async initialize(clientInfo = { name: 'chroxy', version: '1' }) {
    this._child = spawn(this._bin, ['app-server'], { cwd: this._cwd, env: this._env })
    this._child.stdout.on('data', (d) => this._onData(d))
    this._child.stderr.on('data', (d) => this._onStderr(d))
    this._child.on('exit', (code, signal) => this._onExit(code, signal))
    this._child.on('error', (err) => this._onError(err))
    const res = await this.request('initialize', { clientInfo })
    this.notify('initialized')
    return res
  }

  /** Send a JSON-RPC request; returns a Promise resolving with the result. */
  request(method, params) {
    if (this._closed) return Promise.reject(new Error('codex app-server is closed'))
    const id = this._nextId++
    const p = new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }))
    this._write({ jsonrpc: '2.0', id, method, params })
    return p
  }

  /** Send a fire-and-forget JSON-RPC notification. */
  notify(method, params) {
    if (this._closed) return
    this._write({ jsonrpc: '2.0', method, params })
  }

  /** Answer a server → client request (e.g. an approval) with a result. */
  respond(id, result) {
    if (this._closed) return
    this._write({ jsonrpc: '2.0', id, result })
  }

  /** Answer a server → client request with a JSON-RPC error. */
  respondError(id, code, message) {
    if (this._closed) return
    this._write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  _write(msg) {
    try { this._child?.stdin.write(JSON.stringify(msg) + '\n') }
    catch (err) { this._log.warn(`codex app-server write failed: ${err.message}`) }
  }

  _onData(d) {
    this._buf += String(d)
    let nl
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl)
      this._buf = this._buf.slice(nl + 1)
      if (!line.trim()) continue
      let m
      try { m = JSON.parse(line) } catch { continue } // ignore non-JSON lines (banners)
      this._dispatch(m)
    }
  }

  /** Route one parsed JSON-RPC message. Exported shape is exercised by tests. */
  _dispatch(m) {
    // Response to one of OUR requests: has id + (result|error) and NO method.
    if (m.id !== undefined && m.method === undefined && (m.result !== undefined || m.error !== undefined)) {
      const pend = this._pending.get(m.id)
      if (!pend) return
      this._pending.delete(m.id)
      if (m.error) pend.reject(new Error(m.error.message || JSON.stringify(m.error)))
      else pend.resolve(m.result)
      return
    }
    // Server → client REQUEST (id + method): approvals / elicitation. Needs a reply.
    if (m.id !== undefined && m.method) {
      this.emit('serverRequest', { id: m.id, method: m.method, params: m.params || {} })
      return
    }
    // Notification (method, no id): streaming + item events.
    if (m.method) this.emit('notification', { method: m.method, params: m.params || {} })
  }

  _onStderr(d) {
    const s = String(d).trim()
    if (s) this._log.debug(`codex app-server stderr: ${s.slice(0, 500)}`)
  }

  _onExit(code, signal) {
    if (this._closed) return
    this._closed = true
    this._rejectAllPending(new Error(`codex app-server exited (code=${code}${signal ? ` signal=${signal}` : ''})`))
    this.emit('exit', { code, signal })
  }

  _onError(err) {
    if (this._closed) return
    this._log.warn(`codex app-server process error: ${err.message}`)
    this._closed = true
    this._rejectAllPending(err)
    this.emit('exit', { code: null, signal: null, error: err })
  }

  _rejectAllPending(err) {
    for (const { reject } of this._pending.values()) reject(err)
    this._pending.clear()
  }

  /** Terminate the child and fail any in-flight requests. Idempotent. */
  kill() {
    if (!this._closed) this._rejectAllPending(new Error('codex app-server killed'))
    this._closed = true
    try { this._child?.kill('SIGKILL') } catch { /* already gone */ }
  }
}
