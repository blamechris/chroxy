// permission-scope.js (#8517) -- the one rule for the scope a permission answer
// carries.
//
// "Allow for Session" is a client-side choice: the wire decision is `allow`, and the
// session rule comes from a separate `set_permission_rules`. The answer therefore
// used to look like a one-time allow everywhere downstream of the wire, and the
// permission_resolved broadcast and the permission journal recorded it as one. A
// client now adds `scope: 'session'` to the `permission_response`.
//
// The scope is a LABEL. Nothing here, and nothing that reads it, grants, widens or
// skips anything: whether a tool runs, and what rule exists afterwards, are decided
// by the decision and by set_permission_rules exactly as before. It is read for two
// things only, the `scope` on the permission_resolved broadcast and the decision
// token the journal keeps.

/** The scopes a client may name. Kept equal to the protocol's `PermissionScopeSchema`. */
export const PERMISSION_SCOPES = Object.freeze(['session'])

/**
 * The scope of an answer, or `undefined`: `session` only beside the wire decision
 * `allow`. Beside `deny` it means nothing; beside `allowAlways` the answer already
 * writes a rule that outlives the session, so it keeps that token rather than being
 * narrowed to a session one. Any other value is dropped, never passed on.
 *
 * @param {unknown} decision the wire decision
 * @param {unknown} scope what the client sent
 * @returns {'session'|undefined}
 */
export function permissionScope(decision, scope) {
  return decision === 'allow' && PERMISSION_SCOPES.includes(scope) ? scope : undefined
}

/**
 * The decision token an answer is recorded and shown under: `allowSession` for a
 * session-scoped allow, otherwise the decision itself.
 *
 * @param {string} decision
 * @param {unknown} scope
 * @returns {string}
 */
export function permissionDecisionToken(decision, scope) {
  return permissionScope(decision, scope) === 'session' ? 'allowSession' : decision
}
