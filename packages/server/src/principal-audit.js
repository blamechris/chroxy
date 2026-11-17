/**
 * The agent-principal audit trail (docs/security/agent-principals.md section 10.1).
 *
 * Every line is `[AUDIT] [agent-audit] <kind> {json}` written through
 * `auditOrRefuse` (logger.js), the one audit writer that reports whether the line
 * really reached the audit log. Two classes of line:
 *
 *   - `attempt`: written BEFORE a principal effect. If it cannot be written the effect
 *     does not happen (`withPrincipalEffect`, principal-effect.js). FAIL CLOSED.
 *   - `outcome`: one per transition (`delivered | queued | expired | dropped:<reason> |
 *     rejected:<reason> | killed | revoked | enabled`). Written after the fact, so it is
 *     best effort: it cannot un-do a transition. It reports whether it landed.
 *
 * What a line carries: `ts, principalId, label, action, sessionId, requestId, leaseId,
 * gen, result, reason`, and for any input text ONLY `sha256` and `length`. The text
 * itself is never logged: fields are an allowlist, and `text` is turned into a digest
 * and dropped. The transcript is the content record (contract D7).
 *
 * Repeated identical rejections within a minute collapse into one counter line, written when the window ends (a bounded, unref'd timer),
 * on graceful shutdown, or on the next flush if a write failed.
 */
import { createHash } from 'node:crypto'
import { auditOrRefuse as defaultAuditOrRefuse } from './logger.js'

export const AUDIT_COMPONENT = 'agent-audit'

/** The effect kinds the contract names (section 10.1): each gets an attempt line first. */
export const PRINCIPAL_EFFECT_KINDS = Object.freeze([
  'enqueue', 'send', 'interrupt', 'create', 'destroy', 'permission_answer', 'lease_change',
])

/** The outcome results the contract names. `dropped:` and `rejected:` carry a reason. */
export const PRINCIPAL_OUTCOME_RESULTS = Object.freeze(['delivered', 'queued', 'expired', 'killed', 'revoked', 'enabled'])

export const REJECT_COLLAPSE_WINDOW_MS = 60_000
const MAX_COLLAPSE_KEYS = 256
const MAX_FLUSH_FAILURES = 5

/** @param {string} text @returns {{ sha256: string, length: number }} */
export function inputDigest(text) {
  const s = typeof text === 'string' ? text : ''
  return { sha256: createHash('sha256').update(s, 'utf8').digest('hex'), length: s.length }
}

function clip(value, max = 128) {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

/**
 * Build the audit fields from a descriptor. An ALLOWLIST: an unknown key (a `content`, a
 * `body`, a token) is never copied. `text` becomes `{ sha256, length }`.
 */
function buildFields(kind, ts, principal, descriptor, extra) {
  const d = descriptor ?? {}
  const fields = {
    ts,
    principalId: clip(principal?.principalId ?? d.principalId),
    label: clip(principal?.label ?? d.label, 64),
    action: clip(d.action, 64),
    sessionId: clip(d.sessionId),
    requestId: clip(d.requestId ?? d.clientMessageId),
    leaseId: clip(d.leaseId),
    gen: Number.isSafeInteger(d.gen) ? d.gen : undefined,
    ...extra,
  }
  if (typeof d.text === 'string') {
    const { sha256, length } = inputDigest(d.text)
    fields.sha256 = sha256
    fields.length = length
  }
  for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k]
  return { kind, fields }
}

/**
 * @param {object} [opts]
 * @param {(component: string, msg: string) => { ok: boolean }} [opts.auditOrRefuse]  the writer; injectable
 * @param {() => number} [opts.now]
 * @param {number} [opts.collapseMs]
 */
export function createPrincipalAuditor({ auditOrRefuse = defaultAuditOrRefuse, now = Date.now, collapseMs = REJECT_COLLAPSE_WINDOW_MS } = {}) {
  /** @type {Map<string, { firstAt: number, suppressed: number, principal: object, descriptor: object, reason: string }>} */
  const rejections = new Map()

  function write(kind, fields) {
    let verdict
    try {
      verdict = auditOrRefuse(AUDIT_COMPONENT, `${kind} ${JSON.stringify(fields)}`)
    } catch {
      return { ok: false, reason: 'audit_unavailable' }
    }
    // Only the boolean `true` counts as written.
    return verdict?.ok === true ? { ok: true } : { ok: false, reason: 'audit_unavailable' }
  }

  function drop(key, entry) {
    if (entry.timer) clearTimeout(entry.timer)
    if (rejections.get(key) === entry) rejections.delete(key)
  }

  /**
   * Write the entry's collapsed count (if any) and retire it. A FAILED counter write keeps
   * the entry, unless `force` (eviction) or the retry budget is spent, so the count is not
   * lost to one bad write. Returns true when the entry was retired.
   */
  function flushCollapsed(key, entry, force = false) {
    if (entry.suppressed > 0) {
      const { kind, fields } = buildFields('outcome', new Date(now()).toISOString(), entry.principal, entry.descriptor, {
        result: `rejected:${entry.reason}`, count: entry.suppressed, collapsed: true,
      })
      if (write(kind, fields).ok !== true && !force && ++entry.failures < MAX_FLUSH_FAILURES) {
        arm(key, entry)
        return false
      }
    }
    drop(key, entry)
    return true
  }

  /** A bounded, unref'd timer: silence after a burst still records the count. */
  function arm(key, entry) {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => { entry.timer = null; if (rejections.get(key) === entry) flushCollapsed(key, entry) }, collapseMs)
    entry.timer.unref?.()
  }

  return {
    /**
     * The pre-effect line. `{ ok: false }` means it was NOT written: do not act.
     * @param {{ principalId?: string, label?: string }} principal
     * @param {{ action: string, sessionId?: string, requestId?: string, leaseId?: string, gen?: number, text?: string }} descriptor
     */
    attempt(principal, descriptor) {
      const { kind, fields } = buildFields('attempt', new Date(now()).toISOString(), principal, descriptor, { result: 'attempt' })
      return write(kind, fields)
    },

    /**
     * An outcome line, best effort. `result` is one of PRINCIPAL_OUTCOME_RESULTS or
     * `dropped:<reason>` / `rejected:<reason>`; `reason` is free text (a short code).
     * @returns {{ ok: boolean }} whether it landed
     */
    outcome(principal, descriptor, result, reason) {
      const { kind, fields } = buildFields('outcome', new Date(now()).toISOString(), principal, descriptor, {
        result: clip(result, 96), reason: clip(reason, 96),
      })
      return write(kind, fields)
    },

    /**
     * A refusal line. Identical refusals (same principal, action, reason) inside the
     * collapse window are counted, not logged; the count is written as one line when the
     * window ends (a window-end timer, or `flushRejections` at shutdown). Best effort.
     */
    rejected(principal, descriptor, reason) {
      const r = clip(String(reason ?? 'rejected'), 64)
      const key = `${principal?.principalId ?? descriptor?.principalId ?? ''}\u0000${descriptor?.action ?? ''}\u0000${r}`
      const t = now()
      const existing = rejections.get(key)
      if (existing && t - existing.firstAt < collapseMs) {
        existing.suppressed++
        return { ok: true, collapsed: true }
      }
      if (existing) flushCollapsed(key, existing, true)
      if (rejections.size >= MAX_COLLAPSE_KEYS) {
        const oldest = rejections.keys().next().value
        flushCollapsed(oldest, rejections.get(oldest), true)
      }
      const entry = { firstAt: t, suppressed: 0, failures: 0, timer: null, principal, descriptor, reason: r }
      rejections.set(key, entry)
      arm(key, entry)
      const { kind, fields } = buildFields('outcome', new Date(t).toISOString(), principal, descriptor, { result: `rejected:${r}` })
      return write(kind, fields)
    },

    /**
     * Write every pending collapsed-count line now (graceful shutdown, tests). A failed write
     * keeps its entry for the next flush.
     * @returns {{ pending: number }} entries still holding an unwritten count
     */
    flushRejections() {
      for (const [key, entry] of [...rejections]) flushCollapsed(key, entry)
      return { pending: [...rejections.values()].filter((e) => e.suppressed > 0).length }
    },
  }
}

/** The process-wide auditor over the real audit log. */
export const principalAuditor = createPrincipalAuditor()
