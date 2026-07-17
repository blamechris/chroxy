/**
 * Run report generation (epic #6691, step M-4). Pure functions deriving the
 * dogfood-measurement report from a run's ledger record: per-role /
 * per-model / per-subtask effective spend, cache-hit ratios, committee
 * overhead, and the delegated-vs-monolithic baseline comparison.
 *
 * Honesty rules: `effectiveUsd` is the one spend number (provider-reported
 * signed cost + server-priced fallback); `unknownCostTurns` and `meteringGaps`
 * are surfaced, never hidden — observed spend >= shown. The report is DERIVED
 * state (the journal is ground truth) and safe to regenerate at any time.
 */

const nz = (v) => (Number.isFinite(v) ? v : 0)
const usd = (v) => `$${nz(v).toFixed(4)}`
const pct = (v) => `${(nz(v) * 100).toFixed(1)}%`

// Cache-hit ratio: what fraction of prompt-side tokens were cache reads.
function cacheHitRatio(cell = {}) {
  const read = nz(cell.cacheReadTokens)
  const denom = nz(cell.inputTokens) + read
  return denom > 0 ? read / denom : 0
}

function cellSummary(cell = {}) {
  return {
    inputTokens: nz(cell.inputTokens),
    outputTokens: nz(cell.outputTokens),
    cacheReadTokens: nz(cell.cacheReadTokens),
    cacheCreationTokens: nz(cell.cacheCreationTokens),
    turns: nz(cell.turns),
    costUsd: nz(cell.costUsd),
    pricedCostUsd: nz(cell.pricedCostUsd),
    effectiveUsd: nz(cell.effectiveUsd),
    unknownCostTurns: nz(cell.unknownCostTurns),
    cacheHitRatio: cacheHitRatio(cell),
  }
}

/** Build the structured report object from a ledger record. */
export function buildRunReport(record) {
  const totals = record?.usageTotals || {}
  const overall = cellSummary(totals.overall)
  const byRole = Object.fromEntries(Object.entries(totals.byRole || {}).map(([k, v]) => [k, cellSummary(v)]))
  const byModel = Object.fromEntries(Object.entries(totals.byModel || {}).map(([k, v]) => [k, cellSummary(v)]))

  // Committee overhead: what the architect's REVIEW turns cost, on top of the
  // work itself (plan/synthesis are counted as architect, not overhead).
  const reviewUsd = nz(byRole['architect.review']?.effectiveUsd)
  const committeeOverhead = {
    effectiveUsd: reviewUsd,
    shareOfTotal: overall.effectiveUsd > 0 ? reviewUsd / overall.effectiveUsd : 0,
    reviewTurns: nz(byRole['architect.review']?.turns),
  }

  const subtasks = (record?.subtasks || []).map((st) => ({
    subtaskId: st.subtaskId,
    title: st.title,
    role: st.role,
    status: st.status,
    provider: st.provider ?? null,
    model: st.model ?? null,
    committeeIterations: Array.isArray(st.committee) ? st.committee.length : 0,
    verdicts: Array.isArray(st.committee) ? st.committee.map((c) => c.verdict) : [],
    numTurns: nz(st.numTurns),
    apiDurationMs: nz(st.apiDurationMs),
    modelDrift: st.modelDrift === true,
    usage: cellSummary(st.usage),
  }))

  // Baseline comparison (set via orchestration_run_annotate): the same epic run
  // as a single monolithic frontier session.
  let baseline = null
  if (record?.baseline && Number.isFinite(record.baseline.effectiveUsd)) {
    const b = record.baseline
    const delegated = overall.effectiveUsd
    baseline = {
      sessionId: b.sessionId ?? null,
      effectiveUsd: nz(b.effectiveUsd),
      deltaUsd: delegated - nz(b.effectiveUsd),
      // <1 = delegation was cheaper than the monolithic baseline
      ratio: nz(b.effectiveUsd) > 0 ? delegated / nz(b.effectiveUsd) : null,
      annotatedAt: b.annotatedAt ?? null,
    }
  }

  return {
    version: 1,
    runId: record?.runId ?? null,
    title: record?.title ?? '',
    preset: record?.preset ?? null,
    status: record?.status ?? null,
    createdAt: record?.createdAt ?? null,
    endedAt: record?.endedAt ?? null,
    totals: overall,
    byRole,
    byModel,
    committeeOverhead,
    subtasks,
    baseline,
    verdictQuality: record?.notes?.verdictQuality ?? null,
    // honesty surfaces
    unknownCostTurns: overall.unknownCostTurns,
    meteringGaps: Array.isArray(record?.meteringGaps) ? record.meteringGaps.slice() : [],
    droppedEvents: nz(record?.droppedEvents),
  }
}

/** Render the report object as a human-readable markdown document. */
export function renderReportMarkdown(report) {
  const lines = []
  lines.push(`# Orchestration run report — ${report.title || report.runId}`)
  lines.push('')
  lines.push(`- **Run**: \`${report.runId}\`${report.preset ? ` (preset: ${report.preset})` : ''}`)
  lines.push(`- **Status**: ${report.status}`)
  lines.push(`- **Total effective spend**: ${usd(report.totals.effectiveUsd)} across ${report.totals.turns} turns`)
  lines.push(`- **Cache-hit ratio (overall)**: ${pct(report.totals.cacheHitRatio)}`)
  if (report.verdictQuality != null) lines.push(`- **Verdict quality**: ${report.verdictQuality}`)
  lines.push('')

  if (report.baseline) {
    lines.push('## Delegated vs monolithic baseline')
    lines.push('')
    lines.push('| | Effective USD |')
    lines.push('|---|---|')
    lines.push(`| Delegated (this run) | ${usd(report.totals.effectiveUsd)} |`)
    lines.push(`| Monolithic baseline | ${usd(report.baseline.effectiveUsd)} |`)
    lines.push(`| **Delta** | **${usd(report.baseline.deltaUsd)}** ${report.baseline.ratio != null ? `(${(report.baseline.ratio * 100).toFixed(0)}% of baseline)` : ''} |`)
    lines.push('')
  }

  lines.push('## Spend by role')
  lines.push('')
  lines.push('| Role | Effective USD | Turns | Cache-hit |')
  lines.push('|---|---|---|---|')
  for (const [role, cell] of Object.entries(report.byRole)) {
    lines.push(`| ${role} | ${usd(cell.effectiveUsd)} | ${cell.turns} | ${pct(cell.cacheHitRatio)} |`)
  }
  lines.push('')
  lines.push(`Committee overhead (architect.review): ${usd(report.committeeOverhead.effectiveUsd)} — ${pct(report.committeeOverhead.shareOfTotal)} of total, ${report.committeeOverhead.reviewTurns} review turns.`)
  lines.push('')

  lines.push('## Spend by model')
  lines.push('')
  lines.push('| Model | Effective USD | Turns | Cache-hit |')
  lines.push('|---|---|---|---|')
  for (const [model, cell] of Object.entries(report.byModel)) {
    lines.push(`| ${model} | ${usd(cell.effectiveUsd)} | ${cell.turns} | ${pct(cell.cacheHitRatio)} |`)
  }
  lines.push('')

  lines.push('## Subtasks')
  lines.push('')
  lines.push('| Subtask | Role | Status | Iterations | Effective USD | Drift |')
  lines.push('|---|---|---|---|---|---|')
  for (const st of report.subtasks) {
    lines.push(`| ${st.title || st.subtaskId} | ${st.role} | ${st.status} | ${st.committeeIterations} | ${usd(st.usage.effectiveUsd)} | ${st.modelDrift ? '⚠ model drift' : '—'} |`)
  }
  lines.push('')

  const gaps = []
  if (report.unknownCostTurns > 0) gaps.push(`${report.unknownCostTurns} turn(s) with unknown cost`)
  if (report.meteringGaps.length > 0) gaps.push(`unmetered sessions: ${report.meteringGaps.join(', ')}`)
  if (report.droppedEvents > 0) gaps.push(`${report.droppedEvents} journal event(s) dropped`)
  if (gaps.length) {
    lines.push('## Metering gaps (observed spend ≥ shown)')
    lines.push('')
    for (const g of gaps) lines.push(`- ${g}`)
    lines.push('')
  }

  return lines.join('\n')
}
