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

  start() {
    this._ptyManager = new PtyManager({
      sessionName: this.tmuxSession,
      resume: true, // always attach, never create
      cols: this._cols,
      rows: this._rows,
    })

    this._outputParser = new OutputParser()
    // For attached sessions, skip the 5s grace period — the session is already running
    this._outputParser._startTime = 0
    this._outputParser._ready = true
    this._outputParser.claudeReady = true

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
          setTimeout(() => this._ptyManager.write('\r'), 300)
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

    this._outputParser.on('claude_ready', () => {
      this._isReady = true
      this.emit('ready', {})
    })

    this._ptyManager.on('exit', ({ exitCode }) => {
      console.log(`[pty-session] PTY exited (code ${exitCode}) for ${this.tmuxSession}`)
      this.emit('error', { message: `PTY session exited (code ${exitCode})` })
    })

    // Start the PTY (attach to existing tmux session)
    this._ptyManager.start()

    // Mark ready immediately for attached sessions (Claude is already running)
    this._isReady = true
    this.emit('ready', {})
  }

  sendMessage(text) {
    if (this._ptyManager) {
      this._ptyManager.write(text + '\r')
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
