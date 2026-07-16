/**
 * Pure run-record shapes + the single event reducer (orchestration harness,
 * epic #6691, delivery step M-2). NO I/O, NO clock, NO randomness — everything
 * here is a deterministic function of its inputs so the live-recording path and
 * the crash-recovery replay path (run-ledger.js) produce byte-identical state.
 *
 * The one mutation primitive is `applyEvent(record, event)`: every ledger
 * mutation is expressed as a journal event, applied through this reducer. Live
 * recording appends the event then applies it; recovery replays journal events
 * with `seq > snapshot.lastSeq` through the same reducer. `record.lastSeq`
 * advances to `event.seq` as each event applies, so a replayed line can never
 * double-fold.
 *
 * Cost provenance is load-bearing: a turn's provider-reported `costUsd` (signed
 * — refunds subtract) is NEVER contaminated by the server-derived
 * `pricedCostUsd` fallback. `effectiveUsd = costUsd + pricedCostUsd` is the one
 * display/budget number, recomputed on every fold.
 */

export const RUN_RECORD_VERSION = 1

// Run statuses the ledger treats as terminal (no further work; report-eligible).
// The engine owns the full status vocabulary; the ledger only needs to know
// which ones end a run for GC / fsync / index purposes.
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status)
}

function nonNegInt(x) {
  const n = Number(x)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

function finiteOr(x, fallback) {
  const n = Number(x)
  return Number.isFinite(n) ? n : fallback
}

/** The one usage shape used everywhere (per-run/role/model/session/subtask). */
export function makeUsageCell() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    webSearchRequests: 0,
    turns: 0,
    costUsd: 0, // sum of provider-reported finite costs (signed)
    costKnownTurns: 0,
    unknownCostTurns: 0,
    pricedCostUsd: 0, // server-derived fallback for unknown-cost turns only
    effectiveUsd: 0, // costUsd + pricedCostUsd — recomputed, not authoritative
  }
}

/** Normalize a snake_case provider usage object into the cell's token fields. */
export function normalizeUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {}
  return {
    inputTokens: nonNegInt(u.input_tokens),
    outputTokens: nonNegInt(u.output_tokens),
    cacheReadTokens: nonNegInt(u.cache_read_input_tokens ?? u.cached_input_tokens),
    cacheCreationTokens: nonNegInt(u.cache_creation_input_tokens),
    webSearchRequests: nonNegInt(u.web_search_requests),
  }
}

// Fold one turn's numbers into a cell in place. `cost` is the provider-reported
// signed cost (null/undefined = unknown); `pricedCostUsd` is the server-derived
// fallback used ONLY when cost is unknown.
function foldCell(cell, tokens, cost, pricedCostUsd) {
  cell.inputTokens += tokens.inputTokens
  cell.outputTokens += tokens.outputTokens
  cell.cacheReadTokens += tokens.cacheReadTokens
  cell.cacheCreationTokens += tokens.cacheCreationTokens
  cell.webSearchRequests += tokens.webSearchRequests
  cell.turns += 1
  if (Number.isFinite(cost)) {
    cell.costUsd += cost
    cell.costKnownTurns += 1
  } else if (Number.isFinite(pricedCostUsd)) {
    cell.pricedCostUsd += pricedCostUsd
  } else {
    cell.unknownCostTurns += 1
  }
  cell.effectiveUsd = cell.costUsd + cell.pricedCostUsd
  return cell
}

function ensureCell(bucket, key) {
  if (!bucket[key]) bucket[key] = makeUsageCell()
  return bucket[key]
}

export function makeSubtask({ subtaskId, parentId = null, role, title }) {
  return {
    subtaskId,
    parentId,
    role,
    title: title ?? '',
    sessionId: null,
    provider: null,
    model: null,
    meterable: true,
    status: 'pending',
    createdAt: null,
    startedAt: null,
    endedAt: null,
    wallClockMs: null,
    apiDurationMs: 0,
    numTurns: 0,
    modelDrift: false,
    usage: makeUsageCell(),
    committee: [],
  }
}

/** An empty run-record shell. `run_created` (seq 1) seeds it via applyEvent. */
export function makeRunRecord({ runId }) {
  return {
    version: RUN_RECORD_VERSION,
    runId,
    title: '',
    preset: null,
    status: 'created',
    createdAt: null,
    startedAt: null,
    endedAt: null,
    lastSeq: 0,
    configSnapshot: null,
    budgetState: { warnedAt: null, capReachedAt: null, capLiftedAt: null, perRole: {} },
    subtasks: [],
    usageTotals: {
      overall: makeUsageCell(),
      byRole: {},
      byModel: {},
      bySession: {},
    },
    meteringGaps: [],
    notes: { verdictQuality: null },
    baseline: null,
    droppedEvents: 0,
  }
}

function findSubtask(record, subtaskId) {
  return record.subtasks.find((s) => s.subtaskId === subtaskId) || null
}

/**
 * The single pure reducer. Applies one journal event to the record in place and
 * advances `record.lastSeq` to `event.seq`. Unknown event types are ignored
 * (forward-compat) but still advance lastSeq. Returns the record.
 */
export function applyEvent(record, event) {
  if (!event || typeof event !== 'object') return record
  switch (event.type) {
    case 'run_created':
      record.title = event.title ?? ''
      record.preset = event.preset ?? null
      record.configSnapshot = event.configSnapshot ?? null
      record.createdAt = finiteOr(event.ts, record.createdAt)
      record.status = 'created'
      break

    case 'run_status_changed':
      record.status = event.status
      if (event.status === 'executing' && record.startedAt == null) {
        record.startedAt = finiteOr(event.ts, null)
      }
      if (isTerminalStatus(event.status)) record.endedAt = finiteOr(event.ts, record.endedAt)
      break

    case 'subtask_created':
      if (!findSubtask(record, event.subtaskId)) {
        const st = makeSubtask({
          subtaskId: event.subtaskId,
          parentId: event.parentId ?? null,
          role: event.role,
          title: event.title,
        })
        st.createdAt = finiteOr(event.ts, null)
        record.subtasks.push(st)
      }
      break

    case 'subtask_updated': {
      const st = findSubtask(record, event.subtaskId)
      if (st) {
        if (typeof event.status === 'string') st.status = event.status
        if (event.status === 'briefing' && st.startedAt == null) st.startedAt = finiteOr(event.ts, null)
        if (isTerminalStatus(event.status) || ['done', 'skipped', 'interrupted'].includes(event.status)) {
          st.endedAt = finiteOr(event.ts, st.endedAt)
          if (st.startedAt != null && st.endedAt != null) st.wallClockMs = st.endedAt - st.startedAt
        }
      }
      break
    }

    case 'session_attached': {
      const st = findSubtask(record, event.subtaskId)
      if (st) {
        st.sessionId = event.sessionId ?? null
        st.provider = event.provider ?? null
        st.model = event.model ?? null
        st.meterable = event.meterable !== false
      }
      break
    }

    case 'turn_usage': {
      const tokens = normalizeUsage(event.usage)
      const cost = Number.isFinite(event.cost) ? event.cost : undefined
      const priced = Number.isFinite(event.pricedCostUsd) ? event.pricedCostUsd : undefined
      // Defense-in-depth: the engine is expected to gate on "finite cost OR
      // finite tokens" before recording (the single-counting invariant), but a
      // both-null synthetic (stream-stall recovery) must never inflate turn
      // counts / unknownCostTurns even if one slips through. Deterministic, so
      // live and replay skip identically.
      const hasTokens = tokens.inputTokens > 0 || tokens.outputTokens > 0
        || tokens.cacheReadTokens > 0 || tokens.cacheCreationTokens > 0
        || tokens.webSearchRequests > 0
      if (cost === undefined && priced === undefined && !hasTokens) break
      foldCell(record.usageTotals.overall, tokens, cost, priced)
      if (event.role) foldCell(ensureCell(record.usageTotals.byRole, event.role), tokens, cost, priced)
      if (event.model) foldCell(ensureCell(record.usageTotals.byModel, event.model), tokens, cost, priced)
      if (event.sessionId) {
        const cell = ensureCell(record.usageTotals.bySession, event.sessionId)
        foldCell(cell, tokens, cost, priced)
        cell.role = event.role ?? cell.role ?? null
        cell.model = event.model ?? cell.model ?? null
        cell.meterable = event.meterable !== false
      }
      if (event.meterable === false && event.sessionId && !record.meteringGaps.includes(event.sessionId)) {
        record.meteringGaps.push(event.sessionId)
      }
      const st = event.subtaskId ? findSubtask(record, event.subtaskId) : null
      if (st) {
        foldCell(st.usage, tokens, cost, priced)
        st.apiDurationMs += nonNegInt(event.apiDurationMs)
        st.numTurns += nonNegInt(event.numTurns)
        // A model on the turn that differs from the attached model = drift
        // (user flipped the model, or an SDK Task sub-model). The per-model
        // split stays exact; the flag just surfaces it for the report.
        if (event.model && st.model && event.model !== st.model) st.modelDrift = true
      }
      break
    }

    case 'committee_review': {
      const st = findSubtask(record, event.subtaskId)
      if (st) {
        st.committee.push({
          phase: event.phase,
          verdict: event.verdict,
          reviewerSessionId: event.reviewerSessionId ?? null,
          notesSeq: event.seq, // the body lives on this journal line
          ts: finiteOr(event.ts, null),
        })
      }
      break
    }

    case 'run_note':
      if (event.patch && typeof event.patch === 'object') {
        if ('verdictQuality' in event.patch) record.notes.verdictQuality = event.patch.verdictQuality ?? null
      }
      break

    case 'budget_warning':
      // one-shot latch: only the first crossing stamps the time
      if (record.budgetState.warnedAt == null) record.budgetState.warnedAt = finiteOr(event.ts, null)
      break

    case 'budget_cap_reached':
      if (record.budgetState.capReachedAt == null) record.budgetState.capReachedAt = finiteOr(event.ts, null)
      break

    case 'budget_lifted':
      // An explicit setBudget RAISE brought a capped run back under. Record
      // when it lifted (capLiftedAt is the "was capped, then lifted" history
      // marker) and RE-ARM the one-shot latches so the new, higher ceiling can
      // warn/cap freshly. This is distinct from a REFUND-driven un-cap (signed
      // cost drop), where latches are deliberately kept to avoid warning spam.
      record.budgetState.capLiftedAt = finiteOr(event.ts, record.budgetState.capLiftedAt)
      record.budgetState.warnedAt = null
      record.budgetState.capReachedAt = null
      break

    case 'budget_updated':
      if (event.budget && typeof event.budget === 'object') {
        // configSnapshot defaults to null on a run created without one; a
        // setBudget on such a run must still take effect, so initialize it.
        if (!record.configSnapshot) record.configSnapshot = { budget: event.budget }
        else record.configSnapshot.budget = event.budget
      }
      break

    case 'delegation_blocked_budget':
      // audit-only: the engine records that a delegation was refused at the cap.
      // No state change beyond the journal line.
      break

    case 'events_dropped':
      record.droppedEvents += nonNegInt(event.count)
      break

    default:
      break // forward-compat: unknown event types still advance lastSeq
  }
  record.lastSeq = Number.isFinite(event.seq) ? event.seq : record.lastSeq
  return record
}
