/**
 * `withPrincipalEffect` (docs/security/agent-principals.md §3.0 item 3).
 *
 * A principal mutation handler awaits (the session manager, a lease, a disk write)
 * between "the frame was admitted" and "the effect lands". The credential can be revoked,
 * expire or be killed in any of those awaits, and a handler that only checked at entry
 * would still act. This wrapper is the commit point: it runs `check` and then `fn` in
 * the SAME synchronous step, so nothing can interleave between the verdict and the
 * effect. Every principal mutation handler runs its effect inside it; the handlers that
 * need one are S8 and later, and S2's refuse every mutation today.
 *
 * `check` is an injectable function `(client) => { ok: true } | { ok: false, reason }`.
 * `credentialCheck(ctx)` is the default S1 supplies (credential live, not expired, not
 * revoked, loopback origin retained). Later checks (kill switch, "agents off", lease and
 * `gen`) are composed with `allChecks` and refuse in the same way.
 *
 * `check` and `fn` are synchronous on purpose. An async `check` would reopen the very gap
 * this closes, so a thenable verdict is treated as a refusal.
 */

import { PRINCIPAL_EFFECT_KINDS } from './principal-audit.js'

/** @typedef {{ ok: true } | { ok: false, reason: string }} PrincipalCheckVerdict */

/**
 * Re-validate the credential through the transport's own check (the one WsServer wires
 * to `_isConnectionAuthorized`, which ends the connection when the credential is dead).
 * @param {{ transport?: { isConnectionAuthorized?: (client: object) => boolean } }} ctx
 * @returns {(client: object) => PrincipalCheckVerdict}
 */
export function credentialCheck(ctx) {
  return (client) => (ctx?.transport?.isConnectionAuthorized?.(client) === true
    ? { ok: true }
    : { ok: false, reason: 'credential' })
}

/**
 * The first refusing check wins; all must pass.
 * @param {...(client: object) => PrincipalCheckVerdict} checks
 * @returns {(client: object) => PrincipalCheckVerdict}
 */
export function allChecks(...checks) {
  return (client) => {
    for (const check of checks) {
      const verdict = check(client)
      if (verdict?.ok !== true) return verdict?.ok === false ? verdict : { ok: false, reason: 'check' }
    }
    return { ok: true }
  }
}

/**
 * Run `fn` only if `check(client)` passes at this instant AND the pre-effect audit
 * attempt line was written (contract section 10.1). The order is fixed: check, then the
 * attempt line, then `fn`, all in one synchronous step. If the line cannot be written
 * (file logging off, ENOSPC, EBADF) there is NO effect and the verdict is
 * `{ ok: false, reason: 'audit_unavailable' }`, which the caller turns into an error ack.
 *
 * `audit` is REQUIRED: a mutation that names no audit descriptor, an unknown effect kind
 * or no auditor is refused (`audit_unavailable` / `bad_effect`), never run unaudited.
 *
 * A refused check writes a (collapsed, best-effort) `rejected` line; an `fn` that throws
 * writes a best-effort `rejected:effect_error` outcome and the throw propagates.
 *
 * @template T
 * @param {object} client
 * @param {(client: object) => PrincipalCheckVerdict} check
 * @param {{ auditor: ReturnType<import('./principal-audit.js').createPrincipalAuditor>, action: string, sessionId?: string, requestId?: string, leaseId?: string, gen?: number, text?: string }} audit
 * @param {() => T} fn  the effect; runs synchronously after the verdict and the attempt line
 * @returns {{ ok: true, value: T } | { ok: false, reason: string }}
 */
export function withPrincipalEffect(client, check, audit, fn) {
  const auditor = audit?.auditor
  const principal = client?.principal ?? null
  let verdict
  try {
    verdict = check(client)
  } catch {
    return { ok: false, reason: 'check_error' }
  }
  if (verdict == null || typeof verdict.then === 'function' || verdict.ok !== true) {
    const reason = typeof verdict?.reason === 'string' ? verdict.reason : 'check'
    try { auditor?.rejected?.(principal, audit, reason) } catch { /* a refusal line is best effort */ }
    return { ok: false, reason }
  }
  if (!PRINCIPAL_EFFECT_KINDS.includes(audit?.action)) return { ok: false, reason: 'bad_effect' }
  if (typeof auditor?.attempt !== 'function') return { ok: false, reason: 'audit_unavailable' }
  let attempt
  try {
    attempt = auditor.attempt(principal, audit)
  } catch {
    attempt = null
  }
  if (attempt?.ok !== true) return { ok: false, reason: 'audit_unavailable' }
  try {
    return { ok: true, value: fn() }
  } catch (err) {
    try { auditor.outcome(principal, audit, 'rejected:effect_error', err?.code || 'error') } catch { /* best effort */ }
    throw err
  }
}
