/**
 * Orchestration state machines + gate registry (engine foundations, epic
 * #6691, step E-1). Pure — no I/O, no clock. The canonical state/verdict
 * vocabularies come from @chroxy/protocol (the wire contract is the single
 * source of truth); this module adds the LEGAL-TRANSITION guards and the
 * user-gate registry model the engine (E-2) drives.
 *
 * Distinct from run-record.js (M-2), which is the durable-persistence reducer.
 * run-model owns "is this transition legal?"; run-record owns "fold this event
 * into the stored record".
 */

import {
  RUN_STATUS_VALUES,
  RUN_NODE_STATUS_VALUES,
  RUN_GATE_KIND_VALUES,
  RUN_GATE_STATUS_VALUES,
  COMMITTEE_VERDICT_VALUES,
} from '@chroxy/protocol'

export {
  RUN_STATUS_VALUES,
  RUN_NODE_STATUS_VALUES,
  RUN_GATE_KIND_VALUES,
  RUN_GATE_STATUS_VALUES,
  COMMITTEE_VERDICT_VALUES,
}

const RUN_STATUSES = new Set(RUN_STATUS_VALUES)
const NODE_STATUSES = new Set(RUN_NODE_STATUS_VALUES)

export const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])
export const TERMINAL_NODE_STATUSES = new Set(['done', 'skipped', 'failed', 'cancelled', 'interrupted'])

// Legal run-state transitions. `cancelling` and `suspended` are reachable from
// any non-terminal state (cancel request / daemon restart), handled specially
// in assertRunTransition rather than enumerated on every row.
const RUN_TRANSITIONS = {
  created: ['planning'],
  planning: ['plan_review', 'executing', 'failed'], // executing when autoApprovePlan skips the gate
  plan_review: ['executing', 'cancelled'],
  executing: ['plan_review', 'paused', 'budget_paused', 'synthesizing', 'executing', 'failed'],
  paused: ['executing', 'cancelling'],
  budget_paused: ['executing', 'synthesizing', 'cancelling'],
  synthesizing: ['completed', 'failed'],
  suspended: ['planning', 'plan_review', 'executing', 'budget_paused', 'paused', 'synthesizing', 'cancelled', 'failed'],
  cancelling: ['cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

// Legal subtask transitions (the committee loop). `respawning` re-enters
// `briefing`; a revise loops back to `briefing` (poa) or `executing` (result).
const NODE_TRANSITIONS = {
  pending: ['spawning', 'skipped', 'cancelled'],
  spawning: ['briefing', 'failed', 'respawning'],
  briefing: ['poa_review', 'failed'],
  poa_review: ['executing', 'briefing', 'respawning', 'escalated', 'failed'],
  executing: ['result_review', 'failed'],
  result_review: ['merging', 'done', 'executing', 'respawning', 'escalated', 'failed'],
  respawning: ['briefing', 'spawning', 'failed'],
  merging: ['done', 'conflict_fixup', 'escalated', 'failed'],
  conflict_fixup: ['merging', 'escalated', 'failed'],
  escalated: ['briefing', 'done', 'skipped', 'failed'],
  done: [],
  skipped: [],
  failed: [],
  cancelled: [],
  interrupted: ['briefing', 'cancelled', 'failed'], // resume re-drives; else cancelled
}

export class TransitionError extends Error {
  constructor(kind, from, to) {
    super(`illegal ${kind} transition: ${from} -> ${to}`)
    this.name = 'TransitionError'
    this.code = 'ILLEGAL_TRANSITION'
    this.from = from
    this.to = to
  }
}

/** Throw unless `from -> to` is a legal RUN transition. cancelling/suspended are
 *  reachable from any non-terminal state; a self-loop on executing is allowed. */
export function assertRunTransition(from, to) {
  if (!RUN_STATUSES.has(to)) throw new TransitionError('run', from, `${to} (unknown state)`)
  if (from === to && to === 'executing') return true
  if ((to === 'cancelling' || to === 'suspended') && !TERMINAL_RUN_STATUSES.has(from)) return true
  const allowed = RUN_TRANSITIONS[from]
  if (!allowed || !allowed.includes(to)) throw new TransitionError('run', from, to)
  return true
}

/** Throw unless `from -> to` is a legal SUBTASK transition. cancelled/interrupted
 *  are reachable from any non-terminal state (run cancel / restart). */
export function assertNodeTransition(from, to) {
  if (!NODE_STATUSES.has(to)) throw new TransitionError('node', from, `${to} (unknown state)`)
  if ((to === 'cancelled' || to === 'interrupted') && !TERMINAL_NODE_STATUSES.has(from)) return true
  const allowed = NODE_TRANSITIONS[from]
  if (!allowed || !allowed.includes(to)) throw new TransitionError('node', from, to)
  return true
}

export function isTerminalRunStatus(s) { return TERMINAL_RUN_STATUSES.has(s) }
export function isTerminalNodeStatus(s) { return TERMINAL_NODE_STATUSES.has(s) }

// --- Gate registry --------------------------------------------------------

// Which committee verdict maps to which user-facing gate resolution. Architect
// reviews that come back `approve` need no user gate; only the escalating
// verdicts open a gate.
export const GATE_DECISIONS = ['approve', 'reject', 'revise', 'skip']

let _gateSeq = 0
/** Deterministic-per-process gate id. `now`-free (the caller stamps openedAt). */
export function nextGateId(runId) {
  _gateSeq += 1
  return `gate_${runId}_${_gateSeq}`
}

/**
 * Build a user gate. Only the four RUN_GATE_KIND_VALUES kinds are user gates;
 * architect-internal reviews are timeline entries, not gates (see design).
 */
export function makeGate({ gateId, runId, kind, nodeId = null, summary, detail = null, budgetUsd = null, openedAt }) {
  if (!RUN_GATE_KIND_VALUES.includes(kind)) throw new Error(`unknown gate kind: ${kind}`)
  return {
    gateId,
    runId,
    nodeId,
    kind,
    status: 'pending',
    summary: summary ?? '',
    detail,
    budgetUsd,
    openedAt: openedAt ?? null,
    resolvedAt: null,
    resolvedBy: null,
    note: null,
  }
}

const GATE_STATUS_FOR_DECISION = {
  approve: 'approved',
  reject: 'rejected',
  revise: 'revise_requested',
  skip: 'skipped',
}

/**
 * Resolve a pending gate. Returns a NEW gate object (pure). Throws if the gate
 * is already resolved (idempotency is the caller's concern — a double-resolve
 * is a real error worth surfacing) or the decision is unknown.
 */
export function resolveGate(gate, { decision, note = null, budgetUsd = null, resolvedBy = 'user', resolvedAt }) {
  if (!GATE_DECISIONS.includes(decision)) throw new Error(`unknown gate decision: ${decision}`)
  if (gate.status !== 'pending') {
    const err = new Error(`gate ${gate.gateId} already resolved (${gate.status})`)
    err.code = 'GATE_ALREADY_RESOLVED'
    throw err
  }
  return {
    ...gate,
    status: GATE_STATUS_FOR_DECISION[decision],
    resolvedAt: resolvedAt ?? null,
    resolvedBy,
    note,
    // an approve-with-raise on a budget_overrun gate carries the new cap
    budgetUsd: budgetUsd != null ? budgetUsd : gate.budgetUsd,
  }
}

/** Expire a pending gate (timeout). Resolved gates are returned unchanged. */
export function expireGate(gate, { resolvedAt } = {}) {
  if (gate.status !== 'pending') return gate
  return { ...gate, status: 'expired', resolvedAt: resolvedAt ?? null, resolvedBy: 'policy' }
}
