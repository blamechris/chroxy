/**
 * Orchestration permission gate (engine, epic #6691, step E-2) — a scoped
 * headless approver for the sessions a run OWNS. The engine spawns workers with
 * a permission posture (audit workers get read-allow / write-deny rules via
 * setPermissionRules, so file tools are settled before they ever prompt); this
 * gate handles what's left — chiefly Bash, which can NEVER be rule-allowed
 * (permission-manager NEVER_AUTO_ALLOW). It answers ONLY for owned sessions,
 * never a user's session.
 *
 * Security posture:
 *  - Scope: acts only when `isOwnedSession(sessionId)` is true.
 *  - Same trust position as a human clicking Allow — it answers each request
 *    individually via `session.respondToPermission`, so there is no standing
 *    Bash whitelist (the NEVER_AUTO_ALLOW invariant is preserved).
 *  - Fail-closed: any tool with no explicit allow decision is denied (audit
 *    workers) or escalated to the user (implement workers, a later step).
 *  - Never uses permissionMode:'auto' / skipPermissions for workers.
 */

// Tools a worker must never be allowed to use headlessly: sub-delegation and
// network fetches (the committee owns the delegation tree; keeps cost flat).
const ALWAYS_DENY = new Set(['Task', 'WebFetch', 'WebSearch'])

export class OrchestrationPermissionGate {
  /**
   * @param {{
   *   sessionManager: import('node:events').EventEmitter,
   *   isOwnedSession: (sessionId: string) => boolean,
   *   policyForSession: (sessionId: string) => ('audit'|'implement'|null),
   *   emitEscalation?: (info: object) => void,
   *   log?: object,
   * }} opts
   */
  constructor({ sessionManager, isOwnedSession, policyForSession, emitEscalation = null, bashAllowlist = [], log = null }) {
    if (!sessionManager || typeof sessionManager.on !== 'function') {
      throw new Error('OrchestrationPermissionGate requires a sessionManager EventEmitter')
    }
    if (typeof isOwnedSession !== 'function') throw new Error('isOwnedSession is required')
    if (typeof policyForSession !== 'function') throw new Error('policyForSession is required')
    this._sm = sessionManager
    this._isOwned = isOwnedSession
    this._policyForSession = policyForSession
    this._emitEscalation = emitEscalation
    this._log = log
    // Compile the implement-worker Bash allowlist once (strings → anchored regex,
    // regex passed through). A Bash command that matches is auto-approved; a
    // non-match is escalated to the user. There is NEVER a standing whitelist —
    // each request is still answered per-request via respondToPermission.
    this._bashAllowlist = (bashAllowlist || []).map((p) => (p instanceof RegExp ? p : new RegExp(p)))
    this._onEvent = this._handleSessionEvent.bind(this)
    this._sm.on('session_event', this._onEvent)
  }

  dispose() {
    this._sm.off?.('session_event', this._onEvent)
  }

  _handleSessionEvent({ sessionId, event, data } = {}) {
    if (event !== 'permission_request') return
    if (!this._isOwned(sessionId)) return // never answer a user's session
    const role = this._policyForSession(sessionId)
    if (!role) return
    const toolName = data?.toolName ?? data?.tool ?? ''
    const requestId = data?.requestId ?? data?.id ?? null
    if (requestId == null) return
    const decision = this._decide(role, toolName, data?.input ?? {})
    if (decision === 'escalate') {
      // Implement-worker Bash that isn't allowlisted: surface to the user. Until
      // the run's escalation UX resolves it, deny so the worker never blocks
      // indefinitely (a later step wires a real hold + user response).
      this._emitEscalation?.({ sessionId, toolName, input: data?.input ?? null, requestId })
      this._respond(sessionId, requestId, 'deny')
      return
    }
    this._respond(sessionId, requestId, decision)
  }

  _decide(role, toolName, input) {
    if (ALWAYS_DENY.has(toolName)) return 'deny'
    // Audit workers are read-only: file reads are already allowed via session
    // rules, so anything reaching the gate (Bash, shell) is denied.
    if (role === 'audit') return 'deny'
    // Implement workers: Bash (never rule-eligible — NEVER_AUTO_ALLOW) is matched
    // against the compiled allowlist. Match → allow; anything else → escalate.
    // Fail-closed: an empty allowlist escalates every Bash command.
    if (toolName === 'Bash' || toolName === 'shell') {
      const command = typeof input?.command === 'string' ? input.command : ''
      if (command && this._bashAllowlist.some((re) => re.test(command))) return 'allow'
      return 'escalate'
    }
    return 'deny'
  }

  _respond(sessionId, requestId, decision) {
    const entry = this._sm.getSession?.(sessionId)
    const session = entry?.session
    if (!session || typeof session.respondToPermission !== 'function') {
      this._log?.warn?.(`permission-gate: cannot answer ${sessionId} (no respondToPermission)`)
      return
    }
    try {
      session.respondToPermission(requestId, decision === 'allow' ? 'allow' : 'deny')
    } catch (err) {
      this._log?.warn?.(`permission-gate: respond failed for ${sessionId}: ${err?.message || err}`)
    }
  }
}
