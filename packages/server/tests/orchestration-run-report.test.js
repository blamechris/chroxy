// Tests for M-4 (#6701): report generation + baseline annotation. The report is
// derived from records driven through the REAL RunLedger write path, and the
// manager's annotate() is exercised live and terminal.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RunLedger } from '../src/orchestration/run-ledger.js'
import { buildRunReport, renderReportMarkdown } from '../src/orchestration/run-report.js'

function mkLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'runreport-'))
  const ledger = new RunLedger({ baseDir: dir })
  return { dir, ledger, cleanup: () => { ledger.dispose?.(); rmSync(dir, { recursive: true, force: true }) } }
}

// Drive a realistic 2-subtask run through the real ledger.
function buildRecord(ledger) {
  const rec = ledger.createRun({
    title: 'Audit run', preset: 'repo-audit',
    configSnapshot: { cwd: '/repo', roleModels: { architect: { provider: 'claude-sdk', model: 'fable' }, worker: { provider: 'codex', model: 'codex-m' } }, budget: { maxUsd: null } },
  })
  const id = rec.runId
  ledger.setStatus(id, 'executing')
  for (const [st, cost] of [['st_a', 0.05], ['st_b', 0.03]]) {
    ledger.createSubtask(id, { subtaskId: st, role: 'worker.audit', title: `Task ${st}` })
    ledger.attachSession(id, st, { sessionId: `sess_${st}`, provider: 'codex', model: 'codex-m', meterable: true })
    ledger.recordTurnUsage(id, { subtaskId: st, sessionId: `sess_${st}`, role: 'worker.audit', turnLabel: 'execute', terminalEvent: 'result', data: { model: 'codex-m', cost, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 3000 } } })
    ledger.recordCommitteeReview(id, st, { phase: 'result', verdict: 'approve', reviewerSessionId: 'arch', notes: 'ok' })
    ledger.updateSubtask(id, st, { status: 'done' })
  }
  // architect: plan + synthesis (role architect) and 2 reviews (architect.review)
  ledger.recordTurnUsage(id, { subtaskId: null, sessionId: 'arch', role: 'architect', turnLabel: 'plan', terminalEvent: 'result', data: { model: 'fable', cost: 0.5, usage: { input_tokens: 5000, output_tokens: 800 } } })
  ledger.recordTurnUsage(id, { subtaskId: null, sessionId: 'arch', role: 'architect.review', turnLabel: 'result_review', terminalEvent: 'result', data: { model: 'fable', cost: 0.2, usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 6000 } } })
  ledger.recordTurnUsage(id, { subtaskId: null, sessionId: 'arch', role: 'architect.review', turnLabel: 'result_review', terminalEvent: 'result', data: { model: 'fable', cost: 0.2, usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 6000 } } })
  ledger.setStatus(id, 'completed')
  return ledger.getRun(id)
}

test('buildRunReport derives totals, roles, models, committee overhead, cache-hit', () => {
  const { ledger, cleanup } = mkLedger()
  try {
    const record = buildRecord(ledger)
    const r = buildRunReport(record)
    // totals: 0.05+0.03+0.5+0.2+0.2 = 0.98 across 5 turns
    assert.ok(Math.abs(r.totals.effectiveUsd - 0.98) < 1e-9, `total ${r.totals.effectiveUsd}`)
    assert.equal(r.totals.turns, 5)
    // committee overhead = the two review turns
    assert.ok(Math.abs(r.committeeOverhead.effectiveUsd - 0.4) < 1e-9)
    assert.equal(r.committeeOverhead.reviewTurns, 2)
    assert.ok(Math.abs(r.committeeOverhead.shareOfTotal - 0.4 / 0.98) < 1e-9)
    // per-role + per-model splits
    assert.ok(Math.abs(r.byRole['worker.audit'].effectiveUsd - 0.08) < 1e-9)
    assert.ok(Math.abs(r.byModel.fable.effectiveUsd - 0.9) < 1e-9)
    assert.ok(Math.abs(r.byModel['codex-m'].effectiveUsd - 0.08) < 1e-9)
    // cache-hit ratio for a worker cell: 3000/(1000+3000) = 0.75
    assert.ok(Math.abs(r.byRole['worker.audit'].cacheHitRatio - 0.75) < 1e-9)
    // subtasks carried through with verdicts
    assert.equal(r.subtasks.length, 2)
    assert.deepEqual(r.subtasks[0].verdicts, ['approve'])
    // no baseline annotated yet
    assert.equal(r.baseline, null)
    assert.equal(r.unknownCostTurns, 0)
  } finally {
    cleanup()
  }
})

test('baseline_set flows into the report with delta + ratio', () => {
  const { ledger, cleanup } = mkLedger()
  try {
    const record0 = buildRecord(ledger)
    ledger.setBaseline(record0.runId, { sessionId: 'mono', effectiveUsd: 2.0, inputTokens: 9000, outputTokens: 1500 })
    const r = buildRunReport(ledger.getRun(record0.runId))
    assert.equal(r.baseline.sessionId, 'mono')
    assert.equal(r.baseline.effectiveUsd, 2.0)
    assert.ok(Math.abs(r.baseline.deltaUsd - (0.98 - 2.0)) < 1e-9, 'delta = delegated - baseline')
    assert.ok(Math.abs(r.baseline.ratio - 0.98 / 2.0) < 1e-9, 'ratio < 1 = delegation cheaper')
  } finally {
    cleanup()
  }
})

test('baseline survives journal replay (recoverRuns)', () => {
  const { dir, ledger, cleanup } = mkLedger()
  try {
    const record0 = buildRecord(ledger)
    ledger.setBaseline(record0.runId, { sessionId: 'mono', effectiveUsd: 3.5 })
    ledger.dispose()
    const ledger2 = new RunLedger({ baseDir: dir })
    ledger2.recoverRuns()
    const rec = ledger2.getRun(record0.runId)
    assert.equal(rec.baseline.effectiveUsd, 3.5, 'baseline recovered from journal')
    ledger2.dispose()
  } finally {
    try { cleanup() } catch { /* ledger already disposed */ }
  }
})

test('renderReportMarkdown produces the tables + honesty section', () => {
  const { ledger, cleanup } = mkLedger()
  try {
    const record0 = buildRecord(ledger)
    ledger.setBaseline(record0.runId, { sessionId: 'mono', effectiveUsd: 2.0 })
    // an unmetered session → meteringGaps
    ledger.createSubtask(record0.runId, { subtaskId: 'st_c', role: 'worker.audit', title: 'unmetered' })
    ledger.attachSession(record0.runId, 'st_c', { sessionId: 'sess_c', provider: 'codex', model: 'codex-m', meterable: false })
    ledger.recordTurnUsage(record0.runId, { subtaskId: 'st_c', sessionId: 'sess_c', role: 'worker.audit', turnLabel: 'execute', terminalEvent: 'result', data: { usage: { input_tokens: 10 } } })
    const report = buildRunReport(ledger.getRun(record0.runId))
    const md = renderReportMarkdown(report)
    assert.match(md, /# Orchestration run report — Audit run/)
    assert.match(md, /## Delegated vs monolithic baseline/)
    assert.match(md, /\| Delegated \(this run\) \| \$0\.98\d* \|/)
    assert.match(md, /## Spend by role/)
    assert.match(md, /architect\.review/)
    assert.match(md, /Committee overhead \(architect\.review\): \$0\.4000/)
    assert.match(md, /## Spend by model/)
    assert.match(md, /## Subtasks/)
    assert.match(md, /## Metering gaps/)
    assert.match(md, /unmetered sessions: sess_c/)
  } finally {
    cleanup()
  }
})

test('writeReport/readReport round-trip persists report.{json,md}', () => {
  const { dir, ledger, cleanup } = mkLedger()
  try {
    const record = buildRecord(ledger)
    const report = buildRunReport(record)
    const json = JSON.stringify(report)
    const markdown = renderReportMarkdown(report)
    assert.equal(ledger.writeReport(record.runId, { json, markdown }), true)
    assert.ok(existsSync(join(dir, 'runs', record.runId, 'report.json')))
    assert.ok(existsSync(join(dir, 'runs', record.runId, 'report.md')))
    const back = ledger.readReport(record.runId)
    assert.equal(back.json, json)
    assert.equal(back.markdown, markdown)
    assert.equal(JSON.parse(back.json).totals.turns, 5)
    // absent run → null
    assert.equal(ledger.readReport('run_nope'), null)
  } finally {
    cleanup()
  }
})

test('an unmetered baseline suppresses the money delta and surfaces the gap', () => {
  const { ledger, cleanup } = mkLedger()
  try {
    const record0 = buildRecord(ledger)
    ledger.setBaseline(record0.runId, { sessionId: 'tui', effectiveUsd: 0, unmetered: true, inputTokens: 90000, outputTokens: 12000 })
    const r = buildRunReport(ledger.getRun(record0.runId))
    assert.equal(r.baseline.unmetered, true)
    assert.equal(r.baseline.deltaUsd, null, 'no money delta against a $0 subscription baseline')
    assert.equal(r.baseline.ratio, null)
    const md = renderReportMarkdown(r)
    assert.match(md, /unmetered.*subscription-billed/i, 'warning surfaced')
    assert.ok(!md.includes('| **Delta** |'), 'delta row suppressed')
    assert.match(md, /\| Monolithic baseline \| 90000 \| 12000 \|/, 'token comparison shown instead')
    assert.match(md, /## Metering gaps/, 'gap section present')
  } finally {
    cleanup()
  }
})

test('markdown table cells escape pipes/newlines in titles', () => {
  const { ledger, cleanup } = mkLedger()
  try {
    const rec = ledger.createRun({ title: 't', preset: null, configSnapshot: { cwd: '/r', roleModels: { architect: { provider: 'a', model: 'm' } }, budget: { maxUsd: null } } })
    ledger.createSubtask(rec.runId, { subtaskId: 's1', role: 'worker.audit', title: 'evil | title\nwith newline' })
    ledger.updateSubtask(rec.runId, 's1', { status: 'done' })
    const md = renderReportMarkdown(buildRunReport(ledger.getRun(rec.runId)))
    assert.match(md, /evil \\\| title with newline/, 'pipe escaped, newline flattened')
  } finally {
    cleanup()
  }
})

test('a report from a degraded/empty record never throws', () => {
  const r = buildRunReport({})
  assert.equal(r.totals.effectiveUsd, 0)
  const md = renderReportMarkdown(r)
  assert.match(md, /# Orchestration run report/)
  assert.match(md, /Total effective spend/)
})
