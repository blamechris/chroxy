/**
 * PtyMirror — spawns claude in a real PTY for 1:1 terminal mirroring.
 *
 * Provides raw terminal bytes (ANSI codes, cursor movement, colors) that
 * can be streamed to xterm.js via WebSocket for a true terminal experience.
 *
 * Used alongside SdkSession (dual-channel architecture):
 *   - SDK channel: structured events → chat view (message bubbles, tool cards)
 *   - PTY channel: raw bytes → terminal view (identical to local terminal)
 *
 * The PTY session is read-only from the dashboard's perspective — user input
 * goes through the SDK channel. The PTY shows what claude outputs in its TUI.
 */
import { EventEmitter } from 'events'

let pty
try {
  pty = await import('node-pty')
} catch {
  pty = null
}

/** Default PTY dimensions */
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40

/** Max bytes to buffer before flushing (backpressure) */
const WRITE_BATCH_SIZE = 16384
const WRITE_BATCH_INTERVAL = 50 // ms

export class PtyMirror extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} options.cwd — working directory for the PTY
   * @param {number} [options.cols] — terminal columns (default 120)
   * @param {number} [options.rows] — terminal rows (default 40)
   * @param {string} [options.conversationId] — resume a specific conversation
   * @param {string} [options.model] — model to use
   * @param {string} [options.permissionMode] — permission mode
   */
  constructor({ cwd, cols, rows, conversationId, model, permissionMode } = {}) {
    super()
    this._cwd = cwd || process.cwd()
    this._cols = cols || DEFAULT_COLS
    this._rows = rows || DEFAULT_ROWS
    this._conversationId = conversationId || null
    this._model = model || null
    this._permissionMode = permissionMode || null
    this._process = null
    this._buffer = ''
    this._batchTimer = null
    this._destroyed = false
  }

  /** Check if node-pty is available */
  static get available() {
    return pty !== null
  }

  /**
   * Spawn the claude CLI in a PTY.
   * @returns {boolean} true if spawned successfully
   */
  spawn() {
    if (this._destroyed) {
      this.emit('error', { message: 'Cannot spawn — PTY instance has been destroyed' })
      return false
    }

    if (!pty) {
      this.emit('error', { message: 'node-pty is not installed — PTY mirroring unavailable' })
      return false
    }

    if (this._process) {
      this.emit('error', { message: 'PTY already spawned' })
      return false
    }

    const args = []
    if (this._conversationId) {
      args.push('--resume', this._conversationId)
    }
    if (this._model) {
      args.push('--model', this._model)
    }
    if (this._permissionMode) {
      args.push('--permission-mode', this._permissionMode)
    }

    try {
      // Find claude binary
      const claudePath = process.env.CLAUDE_PATH || 'claude'

      this._process = pty.spawn(claudePath, args, {
        name: 'xterm-256color',
        cols: this._cols,
        rows: this._rows,
        cwd: this._cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
      })

      // Stream output with batching for backpressure control
      this._process.onData((data) => {
        if (this._destroyed) return
        this._buffer += data
        if (this._buffer.length >= WRITE_BATCH_SIZE) {
          this._flush()
        } else if (!this._batchTimer) {
          this._batchTimer = setTimeout(() => this._flush(), WRITE_BATCH_INTERVAL)
        }
      })

      this._process.onExit(({ exitCode, signal }) => {
        if (this._destroyed) return
        this._flush()
        this.emit('exit', { exitCode, signal })
        this._cleanup()
      })

      this.emit('spawned', { pid: this._process.pid, cols: this._cols, rows: this._rows })
      return true
    } catch (err) {
      this.emit('error', { message: `Failed to spawn PTY: ${err.message}` })
      return false
    }
  }

  /** Flush buffered output */
  _flush() {
    if (this._batchTimer) {
      clearTimeout(this._batchTimer)
      this._batchTimer = null
    }
    if (this._buffer.length > 0) {
      const data = this._buffer
      this._buffer = ''
      this.emit('data', data)
    }
  }

  /**
   * Write data to the PTY stdin (user input forwarding).
   * @param {string} data — raw input bytes
   */
  write(data) {
    if (this._process && !this._destroyed) {
      this._process.write(data)
    }
  }

  /**
   * Resize the PTY.
   * @param {number} cols
   * @param {number} rows
   */
  resize(cols, rows) {
    if (this._process && !this._destroyed) {
      this._cols = cols
      this._rows = rows
      try {
        this._process.resize(cols, rows)
      } catch {
        // Process may have exited
      }
    }
  }

  /** Get current dimensions */
  get dimensions() {
    return { cols: this._cols, rows: this._rows }
  }

  /** Get the PTY process PID */
  get pid() {
    return this._process?.pid ?? null
  }

  /** Check if the PTY is alive */
  get alive() {
    return this._process !== null && !this._destroyed
  }

  /** Clean up resources */
  _cleanup() {
    if (this._batchTimer) {
      clearTimeout(this._batchTimer)
      this._batchTimer = null
    }
    this._process = null
  }

  /** Kill the PTY process and clean up */
  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this._flush()
    if (this._process) {
      try {
        this._process.kill()
      } catch {
        // Already dead
      }
    }
    this._cleanup()
    this.removeAllListeners()
  }
}
