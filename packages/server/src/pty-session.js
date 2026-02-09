import { EventEmitter } from 'events'
import { PtyManager } from './pty-manager.js'
import { OutputParser } from './output-parser.js'

/**
 * Wraps a tmux session attachment with the same event interface as CliSession.
 *
 * Connects to an existing tmux session running Claude, feeding raw PTY output
 * through OutputParser to produce structured chat messages. Supports both
 * terminal view (raw data) and chat view (parsed messages).
 *
 * Events emitted (same as CliSession):
 *   ready        {}
 *   message      { type, content, tool, timestamp }
 *   error        { message }
 *
 * PTY-specific events:
 *   raw          data (string)  — raw terminal data for terminal view
 */
export class PtySession extends EventEmitter {
  constructor({ tmuxSession, cols, rows }) {
    super()
    this.tmuxSession = tmuxSession
    this._cols = cols || 120
    this._rows = rows || 40
    this._ptyManager = null
    this._outputParser = null
    this._isReady = false
    this._trustAccepted = false
  }

  get isRunning() {
    return this._ptyManager?.ptyProcess != null
  }

  get isReady() {
    return this._isReady
  }

  get model() {
    return null
  }

  get permissionMode() {
    return null
  }

  async start() {
    this._ptyManager = new PtyManager({
      sessionName: this.tmuxSession,
      resume: true, // always attach, never create
      cols: this._cols,
      rows: this._rows,
    })

    // For attached sessions, skip the 5s grace period — Claude is already running.
    // Suppress scrollback burst to avoid flooding chat with stale messages.
    this._outputParser = new OutputParser({ assumeReady: true, suppressScrollback: true })

    // Wire PTY data through parser
    this._ptyManager.on('data', (data) => {
      this._outputParser.feed(data)

      // Auto-accept trust dialog (same logic as server.js)
      const clean = data.replace(
        // eslint-disable-next-line no-control-regex
        /\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07]*\x07?|\x1b[()#][A-Z0-2]|\x1b[A-Za-z]|\x9b[0-9;?]*[A-Za-z~]/g,
        ''
      )
      if (/trust\s*this\s*folder/i.test(clean) || /Yes.*trust/i.test(clean)) {
        if (!this._trustAccepted) {
          this._trustAccepted = true
          console.log(`[pty-session] Auto-accepting trust dialog (${this.tmuxSession})`)
          setTimeout(() => {
            if (this._ptyManager) {
              this._ptyManager.write('\r')
            }
          }, 300)
        }
      }
    })

    // Forward raw data for terminal view
    this._outputParser.on('raw', (data) => {
      this.emit('raw', data)
    })

    // Forward parsed messages for chat view
    this._outputParser.on('message', (message) => {
      this.emit('message', message)
    })

    // Forward status bar metadata
    this._outputParser.on('status_update', (status) => {
      this.emit('status_update', status)
    })

    this._outputParser.on('claude_ready', () => {
      this._isReady = true
      this.emit('ready', {})
    })

    this._ptyManager.on('exit', ({ exitCode }) => {
      console.log(`[pty-session] PTY exited (code ${exitCode}) for ${this.tmuxSession}`)
      this.emit('error', { message: `PTY session exited (code ${exitCode})` })
    })

    // Handle crash detection from PtyManager health checks
    this._ptyManager.on('crashed', ({ reason, error }) => {
      console.log(`[pty-session] Session crashed (${reason}) for ${this.tmuxSession}`)
      const errorMsg = error ? `${reason}: ${error}` : reason
      this.emit('session_crashed', { reason, error: errorMsg })
    })

    // Start the PTY (attach to existing tmux session) and wait for success
    await this._ptyManager.start()

    // Mark ready immediately for attached sessions (Claude is already running)
    this._isReady = true
    this.emit('ready', {})
  }

  /** Send a chat-style message (adds \r for submission) */
  sendMessage(text) {
    if (this._ptyManager) {
      this._ptyManager.write(text + '\r')
    }
  }

  /** Write raw input to the PTY (keystrokes, escape sequences, etc.) */
  writeRaw(data) {
    if (this._ptyManager) {
      this._ptyManager.write(data)
    }
  }

  /** Register text expected to echo back from the PTY */
  expectEcho(text) {
    if (this._outputParser) {
      this._outputParser.expectEcho(text)
    }
  }

  interrupt() {
    if (this._ptyManager) {
      this._ptyManager.write('\x03')
    }
  }

  resize(cols, rows) {
    if (this._ptyManager) {
      this._ptyManager.resize(cols, rows)
    }
  }

  setModel() {
    // Not supported in PTY mode
  }

  setPermissionMode() {
    // Not supported in PTY mode
  }

  /** Detach from tmux session (does NOT kill the tmux session) */
  destroy() {
    if (this._ptyManager) {
      this._ptyManager.destroy()
      this._ptyManager = null
    }
    this._outputParser = null
    this._isReady = false
    this.removeAllListeners()
  }
}
