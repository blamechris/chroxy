/**
 * UserShellSession (#5983, epic #5982) — a PTY-only session that spawns the
 * operator's `$SHELL` for a general-purpose terminal inside Chroxy, independent
 * of any Claude session.
 *
 * This is the provider that ACTIVATES the security foundation built behind it:
 *   - `userShell.enabled` config gate (default OFF) — SessionManager.createSession (#5985a)
 *   - WS primary-token gate on create + every terminal_* op (#5985b)
 *   - excluded from the mailbox / isTui PTY-injection path (#5984)
 *
 * It deliberately does NOT inherit ClaudeTuiSession's machinery (resume,
 * auto-respawn, conversation recovery, permission hook). A user shell has no
 * "turns" and MUST NOT auto-respawn — per the #5985 swarm-audit (Guardian),
 * typing `exit` resurrecting a fresh root shell is a footgun. Exit means gone.
 */

import { realpathSync, existsSync } from 'fs'
import { USER_SHELL_PROVIDER } from '@chroxy/protocol'
import { BaseSession, buildBaseSessionOpts } from './base-session.js'
import { createLogger } from './logger.js'
import { CHROXY_SECRET_DENYLIST } from './utils/spawn-env.js'

const log = createLogger('user-shell-session')

// Match the claude-tui mirror grid so the dashboard renders shells at the same
// default size; a client resize overrides it via resizeTerminal.
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30
// Coalesce PTY bytes into one terminal_output per tick (bounds broadcast churn).
const MIRROR_FLUSH_MS = 50
// SIGTERM → grace → SIGKILL the process group on destroy.
const DESTROY_GRACE_MS = 3000

/**
 * Resolve the shell to spawn: `$SHELL` if it exists, then common fallbacks.
 * Returns the first path that exists; if none do (a truly unusual host), falls
 * back to `/bin/sh` as a last resort — start() then surfaces a clean spawn error
 * if that path is also missing.
 */
function resolveShell() {
  const shell = process.env.SHELL
  if (typeof shell === 'string' && shell && existsSync(shell)) return shell
  for (const cand of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (existsSync(cand)) return cand
  }
  return '/bin/sh'
}

export class UserShellSession extends BaseSession {
  static get displayLabel() {
    return 'Shell'
  }

  // #5985b: this IS the general-purpose user shell — activates the WS
  // primary-token terminal_* gates (create / subscribe / resize / input).
  static get isUserShell() {
    return true
  }

  // #5984: NOT the claude-tui PTY mirror — stays false (inherited), so the
  // mailbox wakeup / Control Room isTui path never targets a shell.

  static get capabilities() {
    return {
      // No Claude semantics: no permission engine, model switch, plan mode,
      // resume, thinking budget, streaming, or tool events. It is purely a PTY.
      permissions: false,
      inProcessPermissions: false,
      modelSwitch: false,
      permissionModeSwitch: false,
      planMode: false,
      resume: false,
      terminal: true,
      thinkingLevel: false,
      streaming: false,
      tools: false,
    }
  }

  constructor(opts = {}) {
    // Picker forwards every BaseSession opt; `provider` is fixed to user-shell.
    super(buildBaseSessionOpts(opts, { provider: USER_SHELL_PROVIDER }))
    this._term = null
    this._ptyExited = false
    this._destroying = false
    this._shellAlive = false
    // #5985 audit — the resolved shell path and the last exit code/reason (set
    // when the PTY exits), surfaced to the shell-audit trail. resolveShell() is
    // synchronous, so resolve it HERE (not in async start()) — the create-audit
    // in the WS handler reads this right after createSession returns, before the
    // fire-and-forget start() microtask has run, so a start()-set value would
    // always be null on the audit line (agent review).
    this._shellPath = resolveShell()
    this._exitCode = null
    this._exitReason = null
    this._ptyCols = DEFAULT_COLS
    this._ptyRows = DEFAULT_ROWS
    this._mirrorBuffer = ''
    this._mirrorTimer = null
    this._terminalMirrorActive = false
    this._killTimer = null
  }

  /**
   * A shell with a live PTY is "running" — keeps SessionTimeoutManager from
   * reaping an open shell as idle and lets the UI show the tab as live. Turn-
   * based `_isBusy` never flips for a shell, so the base getter would always be
   * false; this reflects PTY liveness instead.
   */
  get isRunning() {
    return this._shellAlive
  }

  /**
   * Build the env for the spawned interactive shell PTY. Inherits the operator's
   * full process env (it IS their shell) with TERM forced, then strips the
   * chroxy-owned daemon secrets (#6311) — defence in depth so a command, script,
   * or tool the user runs in the shell can't read the daemon's full-authority
   * primary bearer token from the environment. Extracted so the strip is
   * unit-testable without a real PTY spawn.
   *
   * @returns {Record<string, string>}
   */
  _buildShellEnv() {
    const env = { ...process.env, TERM: 'xterm-256color' }
    for (const key of CHROXY_SECRET_DENYLIST) {
      delete env[key]
    }
    return env
  }

  /**
   * Spawn the shell under node-pty and wire its I/O. Async + rejects on failure
   * so SessionManager's _handleAsyncStartFailure tears down the phantom session
   * (same contract claude-tui relies on).
   */
  async start() {
    let ptyMod
    try {
      ptyMod = await import('node-pty')
    } catch (err) {
      throw new Error(`node-pty unavailable: ${err.message}`)
    }

    // Resolved in the constructor (see _shellPath) so the create-audit can read
    // it synchronously; reuse it here for the actual spawn.
    const shell = this._shellPath
    let cwdReal
    try {
      cwdReal = realpathSync(this.cwd)
    } catch {
      // Fall back to the raw cwd; the spawn below surfaces a clean error if it's
      // truly unusable. Never default to '/' silently (Tauri/launchd cwd trap).
      cwdReal = this.cwd
    }
    const env = this._buildShellEnv()

    try {
      this._term = ptyMod.spawn(shell, [], {
        name: 'xterm-256color',
        cols: this._ptyCols,
        rows: this._ptyRows,
        cwd: cwdReal,
        env,
      })
    } catch (err) {
      throw new Error(`Failed to spawn user shell (${shell}): ${err.message}`)
    }

    // destroy() can race the spawn (it set _destroying while we awaited the
    // import): kill the fresh PTY so it isn't orphaned, then bail.
    if (this._destroying) {
      try { this._term.kill('SIGTERM') } catch { /* already gone */ }
      this._term = null
      return
    }

    this._shellAlive = true
    log.info(`user-shell spawned (${shell} pid=${this._term.pid} ${this._ptyCols}x${this._ptyRows} cwd=${cwdReal})`)

    this._term.onData((data) => this._feedTerminalMirror(data))
    this._term.onExit((info) => this._onShellExit(info, 'exit'))
    // #5311 parity: keep a per-session PTY fault from crashing the whole daemon.
    // node-pty rethrows a socket error unless the Terminal has >= 2 'error'
    // listeners; drive teardown off 'close'/'error' and register a second no-op
    // 'error' listener to clear the rethrow threshold. _onShellExit is
    // idempotent (guards on _ptyExited) so any firing order tears down once.
    this._term.on('error', (err) => this._onShellExit(null, `error: ${err?.message || 'unknown'}`))
    this._term.on('error', () => {})
    this._term.on('close', () => this._onShellExit(null, 'close'))
  }

  /**
   * The shell process ended (clean `exit`, close, or socket error). Idempotent.
   * Tears the PTY down WITHOUT respawning — exit means gone (#5985 Guardian) —
   * surfaces a final frame so the viewer sees it ended, and flips isRunning off.
   */
  _onShellExit(info, reason) {
    if (this._ptyExited) return
    this._ptyExited = true
    this._shellAlive = false
    const code = info && typeof info.exitCode === 'number' ? info.exitCode : null
    // #5985 audit — preserve the natural exit code/reason so the destroy audit
    // entry can report how the shell ended (vs. a SIGTERM-killed null).
    this._exitCode = code
    this._exitReason = reason
    log.info(`user-shell exited (reason=${reason}${code != null ? ` code=${code}` : ''})`)
    // Flush any buffered bytes, then a terminal marker so a live viewer sees the
    // shell ended rather than a frozen prompt. Kept out of history (it's a
    // terminal_output, transient by wiring).
    this._flushTerminalMirror()
    // Only surface the marker when a viewer is actually subscribed — consistent
    // with the coalescer's mirror-active gate (an unwatched shell does no work).
    if (this._terminalMirrorActive) {
      const marker = `\r\n[chroxy] shell exited${code != null ? ` (code ${code})` : ''}\r\n`
      this.emit('terminal_output', { data: marker })
    }
    this._clearKillTimer()
    // #5982 — signal a NATURAL exit so SessionManager can auto-remove the dead
    // session (no lingering zombie shells). Emitted only here, so an explicit
    // destroy() — which detaches listeners first — never triggers auto-remove.
    this.emit('shell_exited', { code })
  }

  /**
   * Append a raw PTY chunk to the coalescing buffer and arm a single flush
   * timer. Gated on an active mirror (a subscriber present) so an unwatched
   * shell does no per-byte work. Bytes are NOT transformed — faithful render.
   */
  _feedTerminalMirror(data) {
    if (!this._terminalMirrorActive) return
    this._mirrorBuffer += String(data)
    if (this._mirrorTimer) return
    this._mirrorTimer = setTimeout(() => this._flushTerminalMirror(), MIRROR_FLUSH_MS)
    if (typeof this._mirrorTimer.unref === 'function') this._mirrorTimer.unref()
  }

  /** Emit the coalesced buffer as one terminal_output and reset. No-op if empty. */
  _flushTerminalMirror() {
    if (this._mirrorTimer) {
      clearTimeout(this._mirrorTimer)
      this._mirrorTimer = null
    }
    const data = this._mirrorBuffer
    if (!data) return
    this._mirrorBuffer = ''
    this.emit('terminal_output', { data })
  }

  /**
   * WsServer toggles the coalescer when the terminal-subscriber count crosses
   * 0↔1 (#5837). When turning OFF, drop the pending buffer/timer (nobody's
   * watching, so a trailing flush is waste).
   */
  setTerminalMirrorActive(active) {
    const next = !!active
    if (next === this._terminalMirrorActive) return
    this._terminalMirrorActive = next
    if (!next) {
      if (this._mirrorTimer) {
        clearTimeout(this._mirrorTimer)
        this._mirrorTimer = null
      }
      this._mirrorBuffer = ''
    }
  }

  /** The live PTY's current grid, for a newly-subscribing viewer to letterbox to. */
  getTerminalSize() {
    return { cols: this._ptyCols, rows: this._ptyRows }
  }

  /**
   * Resize the live PTY. Clamps to the protocol bounds (so a bad caller can't
   * throw inside node-pty), records the size, applies it when a PTY is alive,
   * and emits terminal_resize (broadcast back as terminal_size). Returns the
   * applied size or null on a no-op.
   */
  resizeTerminal(cols, rows) {
    const c = Math.max(1, Math.min(1000, Math.floor(Number(cols))))
    const r = Math.max(1, Math.min(1000, Math.floor(Number(rows))))
    if (!Number.isFinite(c) || !Number.isFinite(r)) return null
    if (c === this._ptyCols && r === this._ptyRows) return null
    this._ptyCols = c
    this._ptyRows = r
    if (this._term && !this._ptyExited) {
      try {
        this._term.resize(c, r)
      } catch (err) {
        log.warn(`user-shell resize failed (${c}x${r}): ${err?.message || err}`)
      }
    }
    this.emit('terminal_resize', { cols: c, rows: r })
    return { cols: c, rows: r }
  }

  /**
   * Write raw client keystrokes to the live PTY. The WS handler enforces
   * authority (PRIMARY token + viewer); this just writes. No-op (false) when
   * there is no live PTY.
   * @returns {boolean}
   */
  writeTerminalInput(data) {
    if (typeof data !== 'string' || data.length === 0) return false
    if (!this._term || this._ptyExited || this._destroying) return false
    try {
      this._term.write(data)
      return true
    } catch (err) {
      log.warn(`user-shell terminal input write failed: ${err?.message || err}`)
      return false
    }
  }

  // ── ProviderSession contract stubs ────────────────────────────────────────
  // A user shell has no chat/turn semantics. These exist only to satisfy the
  // REQUIRED_METHODS interface check; setModel/setPermissionMode are inherited
  // from BaseSession (harmless no-ops here).

  /** No-op: a shell takes raw keystrokes via writeTerminalInput, not messages. */
  sendMessage() {
    return false
  }

  /** No-op: there is no turn to interrupt; Ctrl-C is a keystroke (terminal_input). */
  interrupt() {
    return false
  }

  /**
   * Kill the PTY (no respawn) and clear all timers. SIGTERM, then after a grace
   * window SIGKILL the whole process group so backgrounded jobs die too. The
   * liveness probe + _ptyExited latch narrow escalation to a genuinely-hung
   * shell (never a recycled pid).
   */
  destroy() {
    // Idempotent: a second destroy() (or a destroy racing the exit path) is a
    // no-op — the first call already armed teardown (SIGTERM + the escalation
    // timer), and re-running would do nothing useful and risks cancelling a
    // still-pending SIGKILL escalation.
    if (this._destroying) return
    this._destroying = true

    if (this._mirrorTimer) {
      clearTimeout(this._mirrorTimer)
      this._mirrorTimer = null
    }
    this._mirrorBuffer = ''

    const term = this._term
    const pid = term?.pid
    if (term && !this._ptyExited) {
      try { term.kill('SIGTERM') } catch { /* already gone */ }
      if (Number.isInteger(pid) && pid > 0) {
        this._killTimer = setTimeout(() => {
          this._killTimer = null
          if (this._ptyExited) return
          try { process.kill(pid, 0) } catch { return /* already exited */ }
          log.warn(`user-shell PTY (pid=${pid}) did not exit ${DESTROY_GRACE_MS}ms after SIGTERM — escalating to SIGKILL`)
          let killed = false
          if (process.platform !== 'win32') {
            try { process.kill(-pid, 'SIGKILL'); killed = true } catch { /* group gone */ }
          }
          if (!killed) {
            try { term.kill('SIGKILL') } catch {
              try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
            }
          }
        }, DESTROY_GRACE_MS)
        if (typeof this._killTimer.unref === 'function') this._killTimer.unref()
      }
    }
    this._term = null
    this._shellAlive = false

    // BaseSession teardown (background-shell tracker, activity registry, pending
    // maps). Mirrors the other providers' destroy() tail.
    this._destroyPendingBackgroundShells()
    this.removeAllListeners()
  }

  _clearKillTimer() {
    if (this._killTimer) {
      clearTimeout(this._killTimer)
      this._killTimer = null
    }
  }
}
