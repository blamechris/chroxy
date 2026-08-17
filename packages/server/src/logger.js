/**
 * Structured logger with optional file output and rotation.
 *
 * Console-only by default (foreground mode). Call initFileLogging()
 * on daemon startup to enable file output with automatic rotation.
 *
 * Usage:
 *   import { createLogger, initFileLogging, closeFileLogging } from './logger.js'
 *
 *   // Optional — enable file logging for daemon mode
 *   initFileLogging({ level: 'debug', logDir: '/custom/path' })
 *
 *   const log = createLogger('supervisor')
 *   log.info('Server ready')
 *   // => 2026-02-22T12:34:56.789Z [INFO] [supervisor] Server ready
 */

import {
  appendFileSync, statSync, renameSync, mkdirSync, chmodSync,
  openSync, readSync, closeSync, writeFileSync, truncateSync,
} from 'fs'
import { join } from 'path'
import { SENSITIVE_PATTERNS, API_KEY_PATTERNS, redactValue } from './redaction.js'
import { configPath } from './config-dir.js'

function defaultLogDir() {
  return configPath('logs')
}
const MAX_LOG_SIZE = 5 * 1024 * 1024  // 5MB
const MAX_LOG_FILES = 3
const ROTATION_CHECK_INTERVAL = 100  // check every N writes

// #7162: audit retention floor (discord-return-path.md §9.1). [AUDIT] lines are
// dual-written to a dedicated chroxy-audit.log with its own rotation budget, so
// the audit trail's lifetime is bounded by AUDIT volume alone — a noisy debug
// period churning chroxy.log through its 5MB×3 cascade can never displace an
// audit line. Budget: 10MB live + 4 archives ≈ 50MB ceiling; §9.1's rate
// ceilings and reject-collapse bound audit volume, so this is years of trail.
const AUDIT_LOG_NAME = 'chroxy-audit.log'
const MAX_AUDIT_LOG_SIZE = 10 * 1024 * 1024  // 10MB
const MAX_AUDIT_LOG_FILES = 4

// #7162: bounds for the service-manager stdout/stderr capture files
// (launchd StandardOutPath / systemd StandardOutput=file: / cmd `>>`), which
// no service manager rotates. Capped at daemon boot by capStdioCaptureLogs().
const STDIO_CAPTURE_MAX_SIZE = 5 * 1024 * 1024   // 5MB
const STDIO_CAPTURE_TAIL_KEEP = 1 * 1024 * 1024  // preserved to *.old.log

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

// #6029: the value-SHAPE patterns (SENSITIVE_PATTERNS / API_KEY_PATTERNS) and
// the contiguous redaction logic now live in redaction.js as the single source
// of truth, shared with the tool-broadcast sanitizer (ws-permissions.js). The
// constants are imported here for redactSensitivePreservingEscapes (the
// escape-aware PTY-dump pass that still needs the raw pattern list).

/**
 * Redact sensitive data from a log message. Delegates to the shared
 * `redactValue` (redaction.js) so the logger and the tool-broadcast path apply
 * identical patterns and replacement rules.
 * @param {string} msg
 * @returns {string}
 */
export function redactSensitive(msg) {
  return redactValue(msg)
}

// #5358: escape/control sequences a TUI can interleave INTO a token while
// styling it (e.g. `sk-ant-oat01-AAAA\x1b[1mBBBB`), splitting the run so the
// contiguous patterns above miss it. Mirrors the claude-tui ANSI_STRIP set,
// kept local so logger.js stays dependency-free.
const TOKEN_SPLITTING_ESCAPE = new RegExp(
  [
    '\\x1b\\[[0-9;?]*[\\x40-\\x7E]', // CSI
    '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC ... BEL/ST
    '\\x1bO.', // SS3
    '\\x1b[=>cN]', // single-char terminal-mode codes
    '[\\x00-\\x08\\x0b-\\x1f\\x7f]', // stray C0 controls (except \t and \n)
  ].join('|'),
  'g',
)

/**
 * #5358: redact tokens from a string that may have escape sequences interleaved
 * MID-TOKEN — the PTY hex-dump source. The contiguous `redactSensitive` misses
 * a token split by an escape; this detects tokens in an escape-STRIPPED copy,
 * then redacts the corresponding characters in the ORIGINAL while LEAVING the
 * escape bytes in place. So a hex dump keeps the escape structure it exists to
 * show, but the token leaks in neither the hex nor the ASCII column.
 *
 * Length-preserving (each token char → 'X'), so escape-byte offsets in the dump
 * stay meaningful. Intended to be layered AFTER redactSensitive (which handles
 * the contiguous case + key-name preservation); this pass only changes a string
 * when a split token survived.
 *
 * NOTE: a generic high-entropy "any token-shaped string" heuristic is
 * deliberately NOT added — on a diagnostic dump it would redact UUIDs, git
 * SHAs, and base64 payloads (the very content the dump exists to show). The
 * marker-prefixed patterns (sk-/AIza/Bearer/JWT/key=value) are the safe set.
 *
 * @param {string} s latin1/utf8 string (one char per byte for the dump path)
 * @returns {string}
 */
export function redactSensitivePreservingEscapes(s) {
  // Walk s, skipping escape runs, building a stripped copy + index map back to s.
  let stripped = ''
  const map = []
  let i = 0
  while (i < s.length) {
    TOKEN_SPLITTING_ESCAPE.lastIndex = i
    const m = TOKEN_SPLITTING_ESCAPE.exec(s)
    if (m && m.index === i) { i += m[0].length || 1; continue }
    stripped += s[i]
    map.push(i)
    i++
  }
  const chars = s.split('')
  let changed = false
  for (const pattern of [...SENSITIVE_PATTERNS, ...API_KEY_PATTERNS]) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(stripped)) !== null) {
      for (let k = match.index; k < match.index + match[0].length; k++) chars[map[k]] = 'X'
      changed = true
      if (match[0].length === 0) pattern.lastIndex++ // guard against a zero-width match
    }
  }
  return changed ? chars.join('') : s
}

let _logLevel = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info
let _jsonMode = false
let _logToFile = false
let _logDir = defaultLogDir()
let _logPath = null
let _auditLogPath = null
let _writeCount = 0
let _quietConsole = false

/** Set of callbacks for broadcasting log entries (supports multiple WsServer instances) */
const _logListeners = new Set()

/**
 * Enable or disable JSON log output format.
 * When enabled, log lines are emitted as JSON objects instead of human-readable strings.
 * @param {boolean} enabled
 */
export function setJsonMode(enabled) {
  _jsonMode = !!enabled
}

/**
 * Set a listener that receives every log entry as a structured object.
 * @deprecated Use addLogListener/removeLogListener instead
 * @param {((entry: {component: string, level: string, message: string, timestamp: number}) => void) | null} listener
 */
export function setLogListener(listener) {
  _logListeners.clear()
  if (listener) _logListeners.add(listener)
}

/**
 * Add a log listener. Each WsServer instance registers its own.
 * @param {(entry: {component: string, level: string, message: string, timestamp: number}) => void} listener
 */
export function addLogListener(listener) {
  _logListeners.add(listener)
}

/**
 * Remove a previously added log listener.
 * @param {(entry: {component: string, level: string, message: string, timestamp: number}) => void} listener
 */
export function removeLogListener(listener) {
  _logListeners.delete(listener)
}

/**
 * Initialize file logging. Called once on daemon startup.
 * @param {object} options
 * @param {string} [options.level='info'] - Minimum log level
 * @param {string} [options.logDir] - Log directory (default ~/.chroxy/logs)
 */
export function initFileLogging({ level = 'info', logDir } = {}) {
  _logLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info
  _logToFile = true
  _writeCount = 0
  if (logDir) _logDir = logDir
  // #3734 review (Copilot): create the log directory at mode 0700, and
  // chmod existing dirs the same way. Logs may contain sensitive data
  // (tool inputs, tokens that slip past the redactor), so they must not
  // be readable by group/world. mkdirSync's `mode` is subject to umask,
  // but the explicit chmodSync afterward defeats umask AND tightens any
  // pre-existing dir created at a looser mode by an earlier code path.
  // Failures (read-only home, missing perms) propagate up — initFileLogging
  // is wrapped in a try/catch at the boot site (server-cli.js).
  mkdirSync(_logDir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(_logDir, 0o700)
  } catch {
    // Best-effort — if we can't chmod (e.g. dir owned by another user),
    // we keep going. The mkdir mode bit covers fresh-create.
  }
  _logPath = join(_logDir, 'chroxy.log')
  _auditLogPath = join(_logDir, AUDIT_LOG_NAME)
}

/**
 * #7162: quiet the console mirror in daemon mode. Under a service manager the
 * console streams are captured to chroxy-stdout/stderr.log, which nothing
 * rotates — mirroring every file-logged line there is how the capture reached
 * 32MB in a month. When quiet, info/debug/audit lines skip the console (the
 * rotated file log is authoritative); warn/error still print, so crash-adjacent
 * output keeps landing in chroxy-stderr.log.
 *
 * Fail-safe: quieting only ever suppresses a line that was ALSO written to the
 * file log — if file logging is off or the path is unset, the console mirror
 * stays on regardless of this flag (see write()).
 * @param {boolean} enabled
 */
export function setConsoleQuiet(enabled) {
  _quietConsole = !!enabled
}

/**
 * Return the current on-disk log path, or `null` if file logging is disabled.
 * Used by /diagnostics (#3732) to point operators at the log file.
 *
 * @returns {string|null}
 */
export function getLogPath() {
  return _logToFile ? _logPath : null
}

/**
 * Return the on-disk audit log path (#7162), or `null` if file logging is
 * disabled. #7169's fail-closed audit writer gates on this being non-null —
 * it is the "file-backed logging" precondition §9.1 requires `enable` to check.
 * @returns {string|null}
 */
export function getAuditLogPath() {
  return _logToFile ? _auditLogPath : null
}

/**
 * #7162: bound the service-manager capture files (launchd StandardOutPath /
 * systemd StandardOutput=file: / the Windows wrapper's `>>`), which no service
 * manager rotates. Called once at daemon boot.
 *
 * Mechanics are copy-tail-then-truncate, NEVER rename: the service manager
 * (and this process, as fd 1/2) holds an open descriptor on the inode, so a
 * rename would silently divert the live stream into the archive until the next
 * restart. launchd opens the capture with O_APPEND, so writes after the
 * truncate land at the new end. On systemd (`file:` — non-append fd) the
 * truncate is safe ONLY while the fd offset is ~0, which is why the single
 * call site is the `start` command (server-cmd.js), in the process the
 * service manager spawned, BEFORE any supervisor fork — a supervised child
 * restart re-entering this would truncate under the supervisor's live
 * offset. Windows is excluded outright: the Task Scheduler wrapper redirects
 * with cmd `>>`, whose handle does not have POSIX append semantics, and the
 * next write would re-extend the file with a NUL-padded gap — the generated
 * .cmd wrapper rotates the captures itself before the redirect handle exists
 * (see generateWindowsServiceWrapper).
 *
 * @param {object} [options]
 * @param {string} [options.logDir] - defaults to defaultLogDir(): the capture
 *   location is baked into the plist/unit by `service install` (always
 *   `~/.chroxy/logs`), so it deliberately does NOT follow a custom
 *   CHROXY_LOG_DIR, which only moves the logger's own files
 * @param {number} [options.maxSize] - cap before truncation kicks in
 * @param {number} [options.tailKeep] - bytes preserved to `<name>.old.log`
 * @returns {Array<{file: string, archive: string, preservedBytes: number}>}
 *   one entry per file that was capped (empty when nothing exceeded the cap)
 */
export function capStdioCaptureLogs({
  logDir,
  maxSize = STDIO_CAPTURE_MAX_SIZE,
  tailKeep = STDIO_CAPTURE_TAIL_KEEP,
} = {}) {
  if (process.platform === 'win32') return []
  const dir = logDir || defaultLogDir()
  const capped = []
  for (const name of ['chroxy-stdout.log', 'chroxy-stderr.log']) {
    const filePath = join(dir, name)
    try {
      const stats = statSync(filePath)
      if (stats.size <= maxSize) continue
      const archive = filePath.replace(/\.log$/, '.old.log')
      const keep = Math.min(tailKeep, stats.size)
      const fd = openSync(filePath, 'r')
      let tail
      try {
        const buf = Buffer.alloc(keep)
        const read = readSync(fd, buf, 0, keep, stats.size - keep)
        tail = buf.subarray(0, read)
      } finally {
        closeSync(fd)
      }
      // Start the archive on a whole line when the tail begins mid-line
      // (when keep < size, byte 0 is almost certainly a truncated line).
      if (keep < stats.size) {
        const nl = tail.indexOf(0x0a)
        if (nl !== -1 && nl < tail.length - 1) tail = tail.subarray(nl + 1)
      }
      writeFileSync(archive, tail)
      truncateSync(filePath, 0)
      capped.push({ file: filePath, archive, preservedBytes: tail.length })
    } catch {
      // Capture file absent, or unreadable — nothing to bound. Never let a
      // capping failure interfere with boot (#746 spirit).
    }
  }
  return capped
}

/**
 * Close file logging. Used in tests for cleanup.
 */
export function closeFileLogging() {
  _logToFile = false
  _jsonMode = false
  _logLevel = LOG_LEVELS.info
  _logDir = defaultLogDir()
  _logPath = null
  _auditLogPath = null
  _writeCount = 0
  _quietConsole = false
  _logListeners.clear()
}

/**
 * Size-gated rename-cascade rotation, shared by the main log and the audit log.
 * Rotate: base.N.log (overwritten) <- ... <- base.1.log <- base.log
 */
function _maybeRotateAt(logPath, maxSize, maxFiles) {
  if (!logPath) return
  try {
    const stats = statSync(logPath)
    if (stats.size < maxSize) return
  } catch (err) {
    if (err?.code !== 'ENOENT') console.error('[logger] stat failed:', err?.message)
    return
  }

  // #7162: anchored to the FINAL '.log' — a first-occurrence string replace
  // would rewrite a '.log' embedded in the directory path (e.g. a log dir
  // named 'my.logs'), aiming every rename at a nonexistent sibling dir and
  // silently disabling rotation (the ENOENT is swallowed below by design).
  for (let i = maxFiles; i >= 1; i--) {
    const from = i === 1 ? logPath : logPath.replace(/\.log$/, `.${i - 1}.log`)
    const to = logPath.replace(/\.log$/, `.${i}.log`)
    try {
      renameSync(from, to)
    } catch (err) {
      if (err?.code !== 'ENOENT') console.error('[logger] rename failed:', err?.message)
    }
  }
}

function _maybeRotate() {
  _maybeRotateAt(_logPath, MAX_LOG_SIZE, MAX_LOG_FILES)
}

/**
 * Change the minimum log level at runtime.
 * Useful for --verbose CLI flags to enable debug output. (#747)
 * @param {string} level - One of 'debug', 'info', 'warn', 'error'
 */
export function setLogLevel(level) {
  if (level in LOG_LEVELS) {
    _logLevel = LOG_LEVELS[level]
  }
}

/**
 * Get the current minimum log level as a string.
 * Useful for tests that need to round-trip the level across
 * `beforeEach`/`afterEach` without clobbering a non-default
 * `LOG_LEVEL` env configuration. (#2889)
 * @returns {'debug' | 'info' | 'warn' | 'error'}
 */
export function getLogLevel() {
  for (const [name, value] of Object.entries(LOG_LEVELS)) {
    if (value === _logLevel) return name
  }
  return 'info'
}

/**
 * Create a component logger. Backward-compatible with existing API.
 * @param {string} component - Component name for log prefix
 * @param {object} [context] - Optional context (e.g. { sessionId })
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function, audit: Function, log: Function, withSession: Function }}
 */
export function createLogger(component, context = {}) {
  const write = (level, msg, { always = false, toConsole = true } = {}) => {
    // `always` bypasses the configured level gate (#6001) so an audit trail is
    // never dropped by LOG_LEVEL. Everything else (redaction, console routing,
    // listener broadcast, file write) is identical to a normal line.
    if (!always && LOG_LEVELS[level] < _logLevel) return

    const safeMsg = redactSensitive(msg)
    const timestamp = new Date().toISOString()
    const line = _jsonMode
      ? JSON.stringify({ ts: timestamp, level, component, msg: safeMsg })
      : `${timestamp} [${level.toUpperCase()}] [${component}] ${safeMsg}`

    // #7162: the file write happens FIRST so console quieting can key on this
    // line's ACTUAL fate rather than on configuration: a quieted line whose
    // file append fails (disk full, permissions) falls back to the console
    // mirror, so no line — audit lines above all — is ever lost to both
    // sinks at once.
    let fileWriteOk = false
    if (_logToFile && _logPath) {
      try {
        appendFileSync(_logPath, line + '\n')
        fileWriteOk = true
        _writeCount++
        if (_writeCount % ROTATION_CHECK_INTERVAL === 0) {
          _maybeRotate()
        }
      } catch {
        // Silently ignore write failures (disk full, permission denied, etc.)
        // to prevent logging errors from crashing the server (#746).
        // fileWriteOk stays false, which re-enables the console mirror below.
      }
    }

    // Write to console (for foreground mode). #6566: `toConsole:false` suppresses
    // the console write while keeping the file + listener paths — used by the
    // supervisor to log a REDACTED connect-block line to disk while printing the
    // un-redacted line to the operator's terminal separately under --show-token.
    // #7162: daemon-mode quieting drops info/debug/audit console mirrors, but
    // only for a line the file log verifiably recorded (fileWriteOk).
    const quieted = _quietConsole && fileWriteOk
      && level !== 'warn' && level !== 'error'
    if (toConsole && !quieted) {
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    }

    // Notify listeners (for WS broadcast to dashboard)
    if (_logListeners.size > 0) {
      const entry = { component, level, message: safeMsg, timestamp: Date.now() }
      if (context.sessionId) entry.sessionId = context.sessionId
      for (const listener of _logListeners) {
        try {
          listener(entry)
        } catch {
          // Never let listener errors break logging
        }
      }
    }

    // #7162: audit lines additionally land in the dedicated audit log — the
    // §9.1 retention floor. Gated on the level itself (only audit() produces
    // it), NOT on `always`, so a future caller passing {always:true} to
    // info()/warn() cannot write non-audit content into the forensic file.
    // Rotation is size-checked on every audit write (audit volume is
    // rate-ceiling-bounded, so the per-write stat is cheap). The line stays
    // in chroxy.log above ("in the daemon log", §9.1); this copy is the one
    // whose retention noise can't touch. Kept fire-and-forget here — #7169's
    // fail-closed audit writer layers its success-reporting on top of this
    // sink rather than replacing the level-independent path.
    if (level === 'audit' && _logToFile && _auditLogPath) {
      try {
        appendFileSync(_auditLogPath, line + '\n')
        _maybeRotateAt(_auditLogPath, MAX_AUDIT_LOG_SIZE, MAX_AUDIT_LOG_FILES)
      } catch {
        // Same #746 rationale as above.
      }
    }
  }

  return {
    debug(msg) { write('debug', msg) },
    info(msg, opts) { write('info', msg, opts) },
    warn(msg, opts) { write('warn', msg, opts) },
    error(msg, opts) { write('error', msg, opts) },
    /**
     * Always-on audit line (#6001) — bypasses the configured LOG_LEVEL so a
     * security audit trail (e.g. shell-audit) is never suppressed by a quiet
     * production log level. Tagged `[AUDIT]`; still redacted, broadcast to log
     * listeners, and written to the daemon log file like any other line.
     */
    audit(msg) { write('audit', msg, { always: true }) },
    // Backward compat alias
    log(msg) { write('info', msg) },
    /** Create a child logger tagged with a session ID. */
    withSession(sessionId) { return createLogger(component, { ...context, sessionId }) },
  }
}

/**
 * Create a session-scoped component logger.
 *
 * This is the preferred factory for any code that operates within session
 * context (`ClaudeTuiSession`, `SdkSession`, `CliSession`, per-session
 * handlers in `handlers/*`, etc.). It guarantees that every log entry
 * the returned logger emits is tagged with `sessionId`, which the
 * WsServer `_logListener` (#4787) uses to route log entries to the
 * correct bound client. An unscoped `createLogger(component)` in a
 * session-aware module silently drops to "global only" fan-out, leaking
 * PTY hex dumps and prompt sizes to operators on other sessions.
 *
 * Equivalent to `createLogger(component).withSession(sessionId)` but
 * explicit at the call site. Throws if either argument is missing — the
 * whole point of the helper is to prevent unscoped session logs, so a
 * silent fallback would defeat its purpose.
 *
 * @example
 *   // In a per-session class constructor:
 *   this._log = loggerForSession('claude-tui-session', this._sessionId)
 *   this._log.info('sendMessage start')  // entry.sessionId is set
 *
 * @param {string} component - Component tag (same as createLogger).
 * @param {string} sessionId - Session id to bind. Required.
 * @returns {ReturnType<typeof createLogger>}
 */
export function loggerForSession(component, sessionId) {
  if (typeof component !== 'string' || component.length === 0) {
    throw new TypeError('loggerForSession: component must be a non-empty string')
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('loggerForSession: sessionId must be a non-empty string')
  }
  return createLogger(component, { sessionId })
}

/**
 * #5378 — pick a session-scoped logger when `sessionId` is present, else the
 * unscoped component logger. Centralizes the
 * `sessionId ? loggerForSession('ws', sessionId) : log` ternary that was
 * hand-written across the WS handlers (#4828), where inlining it everywhere
 * invited picking the wrong sessionId variable or inverting the condition — and
 * emitting an operator log to the wrong scope is silent.
 *
 * Semantics match that ternary EXACTLY: a falsy `sessionId` (null / undefined /
 * empty string — the legitimate single-session fallback) uses the unscoped
 * logger, while a truthy value is passed to `loggerForSession`, which THROWS on
 * a non-string. That deliberate throw is preserved (not swallowed) so a
 * programming error — e.g. passing an object/number — fails loudly instead of
 * silently reintroducing the wrong-scope logging this helper exists to prevent
 * (#5390 review).
 *
 * @param {string|null|undefined} sessionId
 * @param {string} [component='ws']
 * @returns {ReturnType<typeof createLogger>}
 */
export function sessionLogger(sessionId, component = 'ws') {
  return sessionId ? loggerForSession(component, sessionId) : createLogger(component)
}
