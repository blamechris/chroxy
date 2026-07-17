/**
 * Wire projection layer (epic #6691, step E-4). Pure functions that project a
 * durable RunLedger record + the manager's live engine extras (gates, timeline,
 * epic prompt, per-node worktree/branch/plan/result) into the @chroxy/protocol
 * wire shapes (RunSummary / RunDetail / RunNode / RunGate / RunUsage / ...).
 *
 * Kept OUT of the manager and the ledger so it can be unit-tested against the
 * protocol schemas in isolation: every projection here must satisfy
 * `<Schema>.safeParse(...)`. Projections are defensive — a missing/degraded
 * field defaults to a schema-valid zero rather than throwing, so a snapshot
 * request can never crash on a half-built run.
 *
 * The `extras` bag carries what the ledger record does not hold (the manager
 * owns it live): { epicPrompt, gates: [RunGate], timeline: [RunTimelineEntry],
 * report, nodeExtras: { [subtaskId]: { branch, worktreePath, planSummary,
 * resultSummary, attempt, committeeIterations } } }.
 */

import { RUN_GATE_KIND_VALUES, COMMITTEE_VERDICT_VALUES } from './run-model.js'

const num = (v, d = 0) => (Number.isFinite(v) ? v : d)
const str = (v, d = '') => (typeof v === 'string' ? v : d)
const nstr = (v) => (typeof v === 'string' ? v : null)

// Subtask statuses that end the node's life, split for nodeCounts buckets.
const NODE_DONE = new Set(['done'])
const NODE_FAILED = new Set(['failed', 'cancelled', 'interrupted'])
const NODE_OTHER_TERMINAL = new Set(['skipped'])

/** A ledger usage cell → RunUsage. Null-safe (a null element must not throw). */
export function usageToWire(cellArg) {
  const cell = cellArg || {}
  return {
    inputTokens: num(cell.inputTokens),
    outputTokens: num(cell.outputTokens),
    cacheReadTokens: num(cell.cacheReadTokens),
    cacheCreationTokens: num(cell.cacheCreationTokens),
    costUsd: num(cell.costUsd),
    pricedCostUsd: num(cell.pricedCostUsd),
    effectiveUsd: num(cell.effectiveUsd),
    unknownCostTurns: num(cell.unknownCostTurns),
  }
}

/** record.budgetState + configSnapshot.budget + overall usage → RunBudget. */
export function budgetToWire(record) {
  const cap = record?.configSnapshot?.budget?.maxUsd
  const bs = record?.budgetState || {}
  const state = bs.capReachedAt != null ? 'capped' : bs.warnedAt != null ? 'warned' : 'ok'
  return {
    capUsd: Number.isFinite(cap) && cap > 0 ? cap : null,
    spentUsd: num(record?.usageTotals?.overall?.effectiveUsd),
    state,
  }
}

/** A manager gate object → RunGate (mostly passthrough with schema-safe defaults). */
export function gateToWire(gateArg) {
  const gate = gateArg || {}
  const out = {
    gateId: str(gate.gateId),
    runId: str(gate.runId),
    nodeId: nstr(gate.nodeId),
    kind: str(gate.kind),
    status: str(gate.status, 'pending'),
    summary: str(gate.summary),
    openedAt: num(gate.openedAt),
    resolvedAt: Number.isFinite(gate.resolvedAt) ? gate.resolvedAt : null,
    resolvedBy: gate.resolvedBy === 'user' || gate.resolvedBy === 'policy' ? gate.resolvedBy : null,
  }
  if (gate.detail != null) out.detail = String(gate.detail)
  if (Number.isFinite(gate.budgetUsd) && gate.budgetUsd > 0) out.budgetUsd = gate.budgetUsd
  if (gate.note != null) out.note = String(gate.note)
  return out
}

/** A manager timeline entry → RunTimelineEntry. */
export function timelineEntryToWire(entryArg) {
  const entry = entryArg || {}
  const out = {
    seq: num(entry.seq),
    at: num(entry.at),
    kind: str(entry.kind),
    summary: str(entry.summary),
  }
  if (entry.nodeId != null) out.nodeId = String(entry.nodeId)
  if (entry.gateId != null) out.gateId = String(entry.gateId)
  // verdict is optional AND enum-constrained — only pass a valid one through, else
  // omit it (an out-of-enum string would make safeParse reject the whole entry).
  if (COMMITTEE_VERDICT_VALUES.includes(entry.verdict)) out.verdict = entry.verdict
  if (entry.detail != null) out.detail = String(entry.detail)
  return out
}

// A gate is projectable only with a schema-valid `kind` (a required enum with no
// safe default). A malformed gate is dropped from a run's gate list rather than
// emitted as an invalid RunGate — from the real path makeGate guarantees a valid
// kind, so this only guards a corrupted/hand-built gate.
function isProjectableGate(gate) {
  return gate && RUN_GATE_KIND_VALUES.includes(gate.kind)
}

/** A ledger subtask record (+ per-node extras) → RunNode. Null-safe. */
export function nodeToWire(subtaskArg, runId, nodeExtraArg) {
  const subtask = subtaskArg || {}
  const nodeExtra = nodeExtraArg || {}
  const created = num(subtask.createdAt)
  return {
    nodeId: str(subtask.subtaskId),
    runId: str(runId),
    title: str(subtask.title),
    role: str(subtask.role),
    provider: nstr(subtask.provider),
    model: nstr(subtask.model),
    status: str(subtask.status, 'pending'),
    attempt: num(nodeExtra.attempt),
    committeeIterations: num(nodeExtra.committeeIterations ?? (Array.isArray(subtask.committee) ? subtask.committee.length : 0)),
    sessionId: nstr(subtask.sessionId),
    worktreePath: nstr(nodeExtra.worktreePath),
    branch: nstr(nodeExtra.branch),
    planSummary: nstr(nodeExtra.planSummary),
    resultSummary: nstr(nodeExtra.resultSummary),
    usage: usageToWire(subtask.usage),
    createdAt: created,
    updatedAt: num(subtask.endedAt ?? subtask.startedAt ?? subtask.createdAt),
  }
}

// nodeCounts semantics for the UI consumer: 'skipped' is terminal-but-neither
// (subtracted from running, counted in none of done/failed) so the three buckets
// do NOT sum to total when skipped nodes exist; 'interrupted' counts as failed
// (it shows failed until a resume moves it back to briefing).
function nodeCounts(subtasksArg) {
  const subtasks = subtasksArg || []
  let done = 0
  let failed = 0
  let other = 0
  for (const s of subtasks) {
    const status = s?.status
    if (NODE_DONE.has(status)) done += 1
    else if (NODE_FAILED.has(status)) failed += 1
    else if (NODE_OTHER_TERMINAL.has(status)) other += 1
  }
  const total = subtasks.length
  return { total, done, failed, running: Math.max(0, total - done - failed - other) }
}

function updatedAtOf(record) {
  return num(record.endedAt ?? record.startedAt ?? record.createdAt)
}

/** A ledger record (+ extras) → RunSummary. */
export function recordToRunSummary(record = {}, extras = {}) {
  const cfg = record.configSnapshot || {}
  const architect = cfg.roleModels?.architect || {}
  const gates = (extras.gates || []).filter(isProjectableGate)
  return {
    runId: str(record.runId),
    title: str(record.title),
    preset: nstr(record.preset),
    status: str(record.status, 'created'),
    cwd: str(cfg.cwd),
    epicPromptPreview: str(extras.epicPrompt).slice(0, 280),
    architect: { provider: str(architect.provider), model: str(architect.model) },
    budget: budgetToWire(record),
    usage: usageToWire(record.usageTotals?.overall),
    nodeCounts: nodeCounts(record.subtasks),
    pendingUserGates: gates.filter((g) => g.status === 'pending').length,
    createdAt: num(record.createdAt),
    updatedAt: updatedAtOf(record),
  }
}

/** A ledger record (+ extras) → RunDetail. */
export function recordToRunDetail(record = {}, extras = {}) {
  const nodeExtras = extras.nodeExtras || {}
  const rollup = {
    total: usageToWire(record.usageTotals?.overall),
    byRole: Object.fromEntries(Object.entries(record.usageTotals?.byRole || {}).map(([k, v]) => [k, usageToWire(v)])),
    byModel: Object.fromEntries(Object.entries(record.usageTotals?.byModel || {}).map(([k, v]) => [k, usageToWire(v)])),
  }
  const detail = {
    ...recordToRunSummary(record, extras),
    epicPrompt: str(extras.epicPrompt),
    // filter falsy elements — a null in a manager-supplied array must not throw.
    nodes: (record.subtasks || []).filter(Boolean).map((s) => nodeToWire(s, record.runId, nodeExtras[s.subtaskId] || {})),
    gates: (extras.gates || []).filter(isProjectableGate).map(gateToWire),
    timeline: (extras.timeline || []).filter(Boolean).slice(-500).map(timelineEntryToWire),
    usageRollup: rollup,
    meteringGaps: Array.isArray(record.meteringGaps) ? record.meteringGaps.slice() : [],
  }
  const baseline = record.baseline?.effectiveUsd
  if (Number.isFinite(baseline)) detail.baselineEffectiveUsd = baseline
  if (record.notes?.verdictQuality != null) detail.verdictQuality = String(record.notes.verdictQuality)
  if (extras.report && typeof extras.report === 'object') {
    detail.report = { json: str(extras.report.json), markdown: str(extras.report.markdown) }
  }
  return detail
}
