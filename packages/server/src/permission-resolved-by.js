// permission-resolved-by.js (#9119, S4 of #9112) -- the one definition of WHO or WHAT
// resolved a permission prompt, carried on `permission_resolved` as `resolvedBy`
// (docs/security/agent-principals.md section 9).
//
// `resolvedBy` is a CLASS, never an identity: { kind, label? }.
//   user       a person answered (any client: the dashboard, the app, the HTTP fallback)
//   agent      an agent principal answered; `label` is the operator-authored principal
//              label. RESERVED: principals cannot answer until S15, so nothing produces it
//   rule       a permission rule decided it. Rules resolve before a prompt exists and
//              emit no `permission_resolved` (see PermissionManager._auditPersistedRule
//              AutoApprove), so nothing produces it today either
//   timeout    nobody answered in time
//   auto_mode  the session's auto mode resolved a pending prompt
//   abort      the turn was stopped or aborted, or the request was cancelled
//   cleared    the daemon drained it (message completion, session teardown, a newer
//              question superseding an older one)
//
// It never carries a token, a client id, a device name or a principal id. The emit sites
// use the frozen constants below, and the event normalizer rebuilds the wire value through
// `normalizeResolvedBy`, so a producer that added a field would still not put it on the wire.

/** The closed set of kinds (the protocol's `PermissionResolvedByKindValues`). */
export const RESOLVED_BY_KINDS = Object.freeze(['user', 'agent', 'rule', 'timeout', 'auto_mode', 'abort', 'cleared'])

/** The longest label that crosses the wire (the principal label cap, principal-store.js). */
export const RESOLVED_BY_LABEL_MAX = 64

/** The label-free kinds, frozen, ready to put on an emit. `agent` has no constant: it needs a label. */
export const RESOLVED_BY = Object.freeze({
  user: Object.freeze({ kind: 'user' }),
  rule: Object.freeze({ kind: 'rule' }),
  timeout: Object.freeze({ kind: 'timeout' }),
  auto_mode: Object.freeze({ kind: 'auto_mode' }),
  abort: Object.freeze({ kind: 'abort' }),
  cleared: Object.freeze({ kind: 'cleared' }),
})

/**
 * The `resolvedBy` for a PermissionManager resolution `reason`. The reasons are the ones the
 * manager already puts on `permission_resolved`; anything it does not know is `cleared`, the
 * kind that claims nothing about a person.
 *
 * @param {unknown} reason
 * @returns {Readonly<{ kind: string }>}
 */
export function resolvedByForReason(reason) {
  switch (reason) {
    case 'user': return RESOLVED_BY.user
    case 'timeout': return RESOLVED_BY.timeout
    case 'stopped':
    case 'aborted':
    case 'cancelled': return RESOLVED_BY.abort
    case 'auto_mode':
    case 'auto_mode_mcp_trust_bypass': return RESOLVED_BY.auto_mode
    default: return RESOLVED_BY.cleared
  }
}

/**
 * The wire `resolvedBy` for a value an emitter supplied, rebuilt from scratch: `kind` must be
 * a known one, `label` survives only on `agent` and only as a bounded string with no control
 * characters, and every other key is dropped. Returns undefined for anything else, so the
 * field is simply absent rather than carrying something unvetted.
 *
 * @param {unknown} value
 * @returns {{ kind: string, label?: string } | undefined}
 */
export function normalizeResolvedBy(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const kind = value.kind
  if (typeof kind !== 'string' || !RESOLVED_BY_KINDS.includes(kind)) return undefined
  if (kind !== 'agent') return { kind }
  const label = value.label
  if (typeof label === 'string' && label.length > 0 && label.length <= RESOLVED_BY_LABEL_MAX && !/[\u0000-\u001f\u007f]/.test(label)) {
    return { kind, label }
  }
  return { kind }
}

/**
 * `{ resolvedBy }` for a spread into a wire frame, or `{}` when the emitter supplied nothing
 * usable (an older producer, a relayed event): the field is additive and optional.
 * @param {unknown} value
 * @returns {{ resolvedBy: { kind: string, label?: string } } | {}}
 */
export function resolvedByField(value) {
  const normalized = normalizeResolvedBy(value)
  return normalized ? { resolvedBy: normalized } : {}
}
