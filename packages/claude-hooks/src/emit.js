/**
 * Core emit path (#5413 Phase 4): stdin payload → IngestEventSchema
 * envelope → POST /api/events. Stateless, fail-fast, fail-SILENT:
 *
 *   - <100ms budget: one fetch with a short abort timeout (default 250ms),
 *     no retries, no spool, no fallback path
 *   - exit 0 always — a hook that exits non-zero or prints to stdout can
 *     break Claude Code's flow, so every failure mode here is a silent
 *     no-op (set CHROXY_HOOKS_DEBUG=1 to get stderr diagnostics)
 *   - never writes anywhere; the only reads are the chroxy config + ingest
 *     secret (see config.js)
 */

import { resolveIngestSecret, resolveIngestUrl } from './config.js'
import { classifyNonProjectCwd, deriveProject } from './project.js'
import { EMITTERS, HOOK_EVENT_FOR_TYPE } from './emitters.js'

export const SOURCE = 'claude-hooks'
export const DEFAULT_TIMEOUT_MS = 250

/** IngestEventSchema bounds (kept in sync with @chroxy/protocol ingest.ts). */
const MAX_DATA_KEYS = 32
const MAX_VALUE_CHARS = 4096
const MAX_PROJECT_CHARS = 256
const MAX_SESSION_ID_CHARS = 256

/**
 * Clamp a data bag to the schema's shape: flat primitives only (string /
 * finite number / boolean / null), strings truncated to the per-value cap,
 * at most MAX_DATA_KEYS keys. Anything else is dropped, never rejected —
 * the emitter must not fail on a surprising payload.
 */
export function sanitizeData(data) {
  const out = {}
  let keys = 0
  for (const [key, value] of Object.entries(data || {})) {
    if (keys >= MAX_DATA_KEYS) break
    if (typeof key !== 'string' || key.length === 0 || key.length > 128) continue
    if (typeof value === 'string') {
      out[key] = value.length > MAX_VALUE_CHARS ? value.slice(0, MAX_VALUE_CHARS) : value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
    } else if (typeof value === 'boolean' || value === null) {
      out[key] = value
    } else {
      continue
    }
    keys++
  }
  return out
}

/**
 * Build the normalized envelope for a hook event, or null when the event is
 * unknown. `project` is sent explicitly (cwd git-root walk, then
 * $CLAUDE_PROJECT_DIR) — the server's own cwd derivation is fallback only.
 */
export function buildEnvelope(hookEvent, payload = {}, { env = process.env, now = Date.now } = {}) {
  const emitter = EMITTERS[hookEvent]
  if (!emitter) return null
  const { type, data } = emitter(payload)
  const envelope = {
    source: SOURCE,
    type,
    data: sanitizeData(data),
    ts: now(),
  }
  const project = deriveProject(typeof payload.cwd === 'string' ? payload.cwd : null, env)
  if (project) envelope.project = project.slice(0, MAX_PROJECT_CHARS)
  const sessionId = typeof payload.session_id === 'string' && payload.session_id.length > 0
    ? payload.session_id
    : null
  if (sessionId) envelope.sessionId = sessionId.slice(0, MAX_SESSION_ID_CHARS)
  return envelope
}

/**
 * Normalize the CLI's event argument: accepts the hook event name
 * (`SessionStart`) or the snake_cased ingest type (`session_start`), falls
 * back to the payload's own `hook_event_name`. Returns null when nothing
 * resolves to a known hook.
 */
export function resolveHookEvent(arg, payload = {}) {
  if (typeof arg === 'string' && arg.length > 0) {
    if (EMITTERS[arg]) return arg
    if (HOOK_EVENT_FOR_TYPE[arg]) return HOOK_EVENT_FOR_TYPE[arg]
    return null
  }
  const fromPayload = payload.hook_event_name
  if (typeof fromPayload === 'string' && EMITTERS[fromPayload]) return fromPayload
  return null
}

function debugLog(env, message) {
  if (env.CHROXY_HOOKS_DEBUG === '1') {
    try { process.stderr.write(`chroxy-hooks: ${message}\n`) } catch { /* silent */ }
  }
}

/**
 * Full emit: parse → envelope → POST. Never throws, never writes to stdout.
 * Returns { sent: boolean, reason?: string } for tests; callers in hook
 * context ignore it and exit 0 regardless.
 */
export async function runEmit({
  hookEventArg = null,
  stdinText = '',
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  try {
    let payload = {}
    if (typeof stdinText === 'string' && stdinText.trim().length > 0) {
      try {
        const parsed = JSON.parse(stdinText)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed
      } catch {
        debugLog(env, 'invalid JSON on stdin; emitting without payload fields')
      }
    }

    const hookEvent = resolveHookEvent(hookEventArg, payload)
    if (!hookEvent) {
      debugLog(env, `unknown hook event "${hookEventArg}"`)
      return { sent: false, reason: 'unknown_event' }
    }

    // #5439 GAP B — non-project session filter (port of claude-notify.sh's
    // tmp / home / worktree cwd filter): temp-dir and home-root sessions are
    // suppressed outright; worktree-agent cwds pass ONLY subagent events
    // through (their counts belong to the parent project — deriveProject
    // remaps the name), so parallel agents don't thrash the parent embed's
    // lifecycle. CHROXY_HOOKS_SKIP_CWD_FILTER=1 bypasses (tests/debugging),
    // mirroring the bash CLAUDE_NOTIFY_SKIP_TMP_FILTER.
    if (env.CHROXY_HOOKS_SKIP_CWD_FILTER !== '1') {
      const cwdKind = classifyNonProjectCwd(typeof payload.cwd === 'string' ? payload.cwd : null, env)
      if (
        cwdKind === 'tmp' || cwdKind === 'home' ||
        (cwdKind === 'worktree' && hookEvent !== 'SubagentStart' && hookEvent !== 'SubagentStop')
      ) {
        debugLog(env, `suppressed ${hookEvent} from non-project cwd (${cwdKind})`)
        return { sent: false, reason: 'non_project_cwd' }
      }
    }

    const secret = resolveIngestSecret(env)
    if (!secret) {
      debugLog(env, 'no ingest secret available (is the chroxy daemon initialized?)')
      return { sent: false, reason: 'no_secret' }
    }

    const envelope = buildEnvelope(hookEvent, payload, { env, now })
    const url = resolveIngestUrl(env)

    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${secret}`,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      debugLog(env, `daemon responded ${res.status}`)
      return { sent: false, reason: `http_${res.status}` }
    }
    return { sent: true }
  } catch (err) {
    // Daemon down, timeout, DNS, anything — fail silent by design.
    debugLog(env, `emit failed: ${err?.message || err}`)
    return { sent: false, reason: 'error' }
  }
}
