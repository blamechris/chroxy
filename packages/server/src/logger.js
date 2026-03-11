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

import { appendFileSync, statSync, renameSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const DEFAULT_LOG_DIR = join(homedir(), '.chroxy', 'logs')
const MAX_LOG_SIZE = 5 * 1024 * 1024  // 5MB
const MAX_LOG_FILES = 3
const ROTATION_CHECK_INTERVAL = 100  // check every N writes

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

// Sensitive patterns to redact from log messages
const SENSITIVE_PATTERNS = [
  // Bearer tokens in headers
  /Bearer\s+[A-Za-z0-9_\-./+=]{8,}/gi,
  // API tokens (base64url, UUID, hex) after common key names
  /(?:token|password|secret|apiKey|api_key|authorization|credential|private_key)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{8,}["']?/gi,
]

/**
 * Redact sensitive data from a log message.
 * @param {string} msg
 * @returns {string}
 */
export function redactSensitive(msg) {
  let result = msg
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // Keep the key name, redact the value
      const colonIdx = match.indexOf(':')
      const eqIdx = match.indexOf('=')
      const sepIdx = colonIdx >= 0 ? (eqIdx >= 0 ? Math.min(colonIdx, eqIdx) : colonIdx) : eqIdx
      if (sepIdx >= 0) {
        return match.slice(0, sepIdx + 1) + ' [REDACTED]'
      }
      // For Bearer tokens
      if (match.startsWith('Bearer')) return 'Bearer [REDACTED]'
      return '[REDACTED]'
    })
  }
  return result
}

let _logLevel = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info
let _logToFile = false
let _logDir = DEFAULT_LOG_DIR
let _logPath = null
let _writeCount = 0

/** Optional callback for broadcasting log entries (set by ws-server) */
let _logListener = null

/**
 * Set a listener that receives every log entry as a structured object.
 * Used by ws-server to broadcast log entries to dashboard clients.
 * @param {((entry: {component: string, level: string, message: string, timestamp: number}) => void) | null} listener
 */
export function setLogListener(listener) {
  _logListener = listener
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
  mkdirSync(_logDir, { recursive: true })
  _logPath = join(_logDir, 'chroxy.log')
}

/**
 * Close file logging. Used in tests for cleanup.
 */
export function closeFileLogging() {
  _logToFile = false
  _logLevel = LOG_LEVELS.info
  _logDir = DEFAULT_LOG_DIR
  _logPath = null
  _writeCount = 0
  _logListener = null
}

function _maybeRotate() {
  if (!_logPath) return
  try {
    const stats = statSync(_logPath)
    if (stats.size < MAX_LOG_SIZE) return
  } catch (err) {
    if (err?.code !== 'ENOENT') console.error('[logger] stat failed:', err?.message)
    return
  }

  // Rotate: chroxy.3.log (overwritten) <- chroxy.2.log <- chroxy.1.log <- chroxy.log
  for (let i = MAX_LOG_FILES; i >= 1; i--) {
    const from = i === 1 ? _logPath : _logPath.replace('.log', `.${i - 1}.log`)
    const to = _logPath.replace('.log', `.${i}.log`)
    try {
      renameSync(from, to)
    } catch (err) {
      if (err?.code !== 'ENOENT') console.error('[logger] rename failed:', err?.message)
    }
  }
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
 * Create a component logger. Backward-compatible with existing API.
 * @param {string} component - Component name for log prefix
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function, log: Function }}
 */
export function createLogger(component) {
  const write = (level, msg) => {
    if (LOG_LEVELS[level] < _logLevel) return

    const safeMsg = redactSensitive(msg)
    const timestamp = new Date().toISOString()
    const line = `${timestamp} [${level.toUpperCase()}] [${component}] ${safeMsg}`

    // Always write to console (for foreground mode)
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)

    // Notify listener (for WS broadcast to dashboard)
    if (_logListener) {
      try {
        _logListener({ component, level, message: safeMsg, timestamp: Date.now() })
      } catch {
        // Never let listener errors break logging
      }
    }

    // Write to file in daemon mode
    if (_logToFile && _logPath) {
      try {
        appendFileSync(_logPath, line + '\n')
        _writeCount++
        if (_writeCount % ROTATION_CHECK_INTERVAL === 0) {
          _maybeRotate()
        }
      } catch {
        // Silently ignore write failures (disk full, permission denied, etc.)
        // to prevent logging errors from crashing the server (#746)
      }
    }
  }

  return {
    debug(msg) { write('debug', msg) },
    info(msg) { write('info', msg) },
    warn(msg) { write('warn', msg) },
    error(msg) { write('error', msg) },
    // Backward compat alias
    log(msg) { write('info', msg) },
  }
}
