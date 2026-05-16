import { existsSync, statSync, openSync, readSync, closeSync } from 'fs'
import { metrics } from './metrics.js'
import { getLogPath } from './logger.js'

/**
 * Build a diagnostics snapshot of the server's runtime state (#3732).
 *
 * Designed for triaging stuck sessions: when a session hangs and the user
 * sees "Response timed out after 5 minutes", `/diagnostics` lets the operator
 * pull the live values that determined the outcome — `_isBusy`,
 * `_resultTimeoutPaused`, the pending-permission queue with timestamps, and
 * the tail of the on-disk log (#3731).
 *
 * Tool inputs are NOT echoed in the snapshot. Permission entries surface
 * `tool` + `description` only — never the raw `input` object — so that
 * triaging a stuck Bash prompt doesn't leak the command. The full input is
 * already in the on-disk log (which is auth-gated like every other endpoint
 * in this server).
 *
 * @param {object} args
 * @param {object} args.server - WsServer instance for global state.
 * @param {string} args.serverVersion - Static version string from package.json.
 * @param {number} [args.logTailBytes=8192] - Max bytes to read from the tail
 *   of the log file. Hard ceiling so a wedged session doesn't have us slurp
 *   a 5MB rotated file into JSON.
 * @returns {object}
 */
export function buildDiagnosticsSnapshot({ server, serverVersion, logTailBytes = 8192 } = {}) {
  const now = Date.now()
  const mem = process.memoryUsage()

  const sessions = []
  const sm = server?.sessionManager
  if (sm?._sessions instanceof Map) {
    for (const [id, entry] of sm._sessions) {
      const session = entry?.session
      if (!session) continue
      sessions.push({
        id,
        name: entry.name ?? null,
        provider: entry.provider ?? null,
        cwd: entry.cwd ?? null,
        isBusy: !!session._isBusy,
        permissionMode: session.permissionMode ?? null,
        currentMessageId: session._currentMessageId ?? null,
        // Inactivity-timer pause bookkeeping from #2831 — this is the
        // signal that tells you "is the 5-min RESULT_TIMEOUT armed right
        // now or not?" If paused with no permissions, you've found a leak.
        resultTimeoutPaused: !!session._resultTimeoutPaused,
        permissionPauseCount: session._permissionPauseCount ?? 0,
        pendingPermissions: collectPendingPermissions(session),
        // Last activity timestamp written by SessionManager in restoreState
        // / serializeState — reading it from the same source the persistence
        // layer trusts, rather than a fresh derivation.
        lastActivityAt: entry.lastActivityAt ?? null,
      })
    }
  }

  return {
    server: {
      version: serverVersion,
      mode: server?.serverMode ?? null,
      uptime: Math.round((now - (server?._startedAt || now)) / 1000),
      pid: process.pid,
      nodeVersion: process.version,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    },
    clients: {
      connected: server?._clientManager?.clients?.size ?? 0,
      authenticated: server?._clientManager?.authenticatedCount ?? 0,
    },
    counters: metrics.snapshot ? metrics.snapshot() : {},
    rateLimiters: collectRateLimiters(server),
    sessions,
    logs: collectLogTail(logTailBytes),
  }
}

/**
 * Snapshot eviction stats for every RateLimiter the server holds (#3996, #4005).
 *
 * Returns an array (not a keyed object) so the surface is uniform regardless
 * of which limiters happen to exist on a given server build — operators
 * scanning for trouble look for any entry with `evictionCount > 0` (cumulative)
 * or `evictionsInWindow > 0` (live signal). Each entry already carries `name`
 * from the limiter constructor.
 *
 * Resilient to partial server objects (tests may pass mocks without every
 * limiter wired up): a missing or malformed limiter is silently skipped.
 *
 * @param {object} server - WsServer instance.
 * @returns {Array<{ name: string, evictionCount: number, lastEvictionAt: number|null, mapSize: number, maxEntries: number, evictionsInWindow: number, evictionWindowMs: number, evictionWindowSaturated: boolean }>}
 */
function collectRateLimiters(server) {
  const out = []
  const candidates = [
    server?._rateLimiter,
    server?._permissionRateLimiter,
    server?._diagnosticsRateLimiter,
    // The HTTP-permission limiter lives inside the permission handler
    // closure and is re-exported on the handler object for this purpose.
    server?._permissions?._httpPermissionLimiter,
  ]
  for (const limiter of candidates) {
    if (limiter && typeof limiter.getEvictionStats === 'function') {
      try {
        out.push(limiter.getEvictionStats())
      } catch {
        // Defensive — never let a misbehaving limiter crash /diagnostics.
      }
    }
  }
  return out
}

/**
 * Collect pending permission requests for a session, with sensitive fields
 * stripped. Returns the empty array when the session has no permission
 * manager (CLI-mode sessions route via the HTTP hook path instead).
 */
function collectPendingPermissions(session) {
  const out = []
  const pendingMap = session?._pendingPermissions
  if (!(pendingMap instanceof Map) || pendingMap.size === 0) return out
  const lastData = session?._lastPermissionData
  for (const [requestId] of pendingMap) {
    const meta = (lastData instanceof Map) ? lastData.get(requestId) : null
    out.push({
      requestId,
      tool: meta?.tool ?? null,
      // Description only — `input` is intentionally omitted to avoid
      // leaking command strings into the diagnostics surface. The full
      // input lives in the on-disk log already.
      description: typeof meta?.description === 'string'
        ? meta.description.slice(0, 200)
        : null,
      createdAt: meta?.createdAt ?? null,
      ageMs: typeof meta?.createdAt === 'number'
        ? Math.max(0, Date.now() - meta.createdAt)
        : null,
    })
  }
  return out
}

/**
 * Read up to `maxBytes` from the tail of the on-disk log, if file logging
 * is enabled. Returns metadata even when no log is configured so callers
 * can tell the difference between "no logging" and "logging on, no content".
 */
function collectLogTail(maxBytes) {
  const path = getLogPath()
  if (!path) {
    return { source: 'disabled', path: null, lines: [] }
  }
  if (!existsSync(path)) {
    return { source: 'file', path, lines: [], note: 'log file not yet written' }
  }
  let fd
  try {
    const stats = statSync(path)
    const start = Math.max(0, stats.size - maxBytes)
    const length = stats.size - start
    fd = openSync(path, 'r')
    // #3734 review (Copilot): Buffer.alloc (zero-filled) + respect
    // bytesRead. The earlier Buffer.allocUnsafe + ignoring readSync's
    // return value would have disclosed uninitialized heap memory if
    // the log file shrank between statSync and readSync — rare but
    // possible during log rotation. Slicing on bytesRead also covers
    // partial reads on slow filesystems.
    const buf = Buffer.alloc(length)
    const bytesRead = readSync(fd, buf, 0, length, start)
    const text = buf.toString('utf8', 0, bytesRead)
    // Drop the first line if we sliced into the middle of one — preserves
    // the JSON-line guarantee in JSON-mode logs.
    const lines = text.split('\n').filter(Boolean)
    if (start > 0 && lines.length > 0) lines.shift()
    return { source: 'file', path, lines }
  } catch (err) {
    return { source: 'file', path, lines: [], error: err?.message || String(err) }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
  }
}
