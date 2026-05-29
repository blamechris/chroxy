/**
 * MCP child-process lifecycle for the claude-byok provider (#4077).
 *
 * One MCPClient owns one MCP server child. Handles spawn, JSON-RPC handshake
 * (initialize → initialized → tools/list), crash detection with a constant 1s
 * backoff up to MAX_RESTART_ATTEMPTS, and SIGTERM/SIGKILL grace on destroy.
 *
 * Per #4077 scope:
 *   - Lazy spawn: caller decides when to call start().
 *   - Crash detection on child exit / spawn error → schedule restart at 1s.
 *   - After MAX_RESTART_ATTEMPTS failures, state=dead and tools=[].
 *   - Session destroy sends SIGTERM, escalates to SIGKILL at KILL_GRACE_MS.
 *
 * Out of scope (next stages):
 *   - Materializing into Anthropic SDK tools[] (#4078).
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createLogger } from './logger.js'

const MAX_RESTART_ATTEMPTS = 3
const RESTART_DELAY_MS = 1000
const KILL_GRACE_MS = 1000
const HANDSHAKE_TIMEOUT_MS = 5000
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000

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

  _spawnAndHandshake() {
    this._setState(MCP_STATES.STARTING)
    let child
    try {
      child = spawn(this._config.command, this._config.args, {
        env: { ...process.env, ...this._config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
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
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'chroxy-byok', version: '1' },
    }, HANDSHAKE_TIMEOUT_MS)
    if (!initResult || typeof initResult !== 'object') {
      throw new Error('initialize returned non-object result')
    }
    this._notify('notifications/initialized')
    const toolsResult = await this._request('tools/list', {}, HANDSHAKE_TIMEOUT_MS)
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
      if (msg.id != null && this._pending.has(msg.id)) {
        const settle = this._pending.get(msg.id)
        if (msg.error) settle(new Error(msg.error.message || 'MCP RPC error'))
        else settle(null, msg.result)
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
    if (this._restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this._log.warn(`MCP server ${this.name}: dead after ${this._restartAttempts} failed attempts (last exit code=${code} signal=${signal})`)
      this._setState(MCP_STATES.DEAD)
      this.emit('dead')
      return
    }

    this._setState(MCP_STATES.RESTARTING)
    this.emit('restart', { attempt: this._restartAttempts, code, signal })
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null
      if (this._destroyed) return
      this._spawnAndHandshake()
    }, RESTART_DELAY_MS)
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
