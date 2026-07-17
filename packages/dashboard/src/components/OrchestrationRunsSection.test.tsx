/**
 * OrchestrationRunsSection (#6691 S-3b) — the Runs tab component.
 *
 * Covers: empty/error/list states, selection pulls the detail (effect), the
 * detail panel renders nodes/gates/timeline, "Open session" jumps via
 * switchSession, the stale (resyncing) chip, and the terminal report render.
 * The store is mocked (codebase convention) so the test drives plain state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const requestRunsMock = vi.fn(() => true)
const requestDetailMock = vi.fn(() => true)
const selectRunMock = vi.fn()
const switchSessionMock = vi.fn()
const startRunMock = vi.fn(() => 'orch-start-1')
const gateResponseMock = vi.fn(() => 'orch-gate-1')
const runActionMock = vi.fn(() => 'orch-action-1')
const annotateMock = vi.fn(() => 'orch-annotate-1')
let storeState: Record<string, unknown> = {}

function resetStore(over: Record<string, unknown> = {}) {
  requestRunsMock.mockClear(); requestDetailMock.mockClear(); selectRunMock.mockClear(); switchSessionMock.mockClear()
  startRunMock.mockClear(); gateResponseMock.mockClear(); runActionMock.mockClear(); annotateMock.mockClear()
  storeState = {
    connectionPhase: 'connected',
    orchestrationRuns: null,
    orchestrationRunsLoading: false,
    orchestrationRunDetails: {},
    orchestrationRunDetailLoading: new Set<string>(),
    orchestrationRunDetailErrors: {},
    orchestrationRunDetailStale: {},
    orchestrationPendingActions: {},
    orchestrationActionResults: {},
    selectedRunId: null,
    requestOrchestrationRuns: requestRunsMock,
    requestOrchestrationRunDetail: requestDetailMock,
    selectRun: selectRunMock,
    switchSession: switchSessionMock,
    startOrchestrationRun: startRunMock,
    sendOrchestrationGateResponse: gateResponseMock,
    sendOrchestrationRunAction: runActionMock,
    sendOrchestrationRunAnnotate: annotateMock,
    ...over,
  }
}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector?: (s: Record<string, unknown>) => unknown) =>
    typeof selector === 'function' ? selector(storeState) : storeState,
}))

import { OrchestrationRunsSection } from './OrchestrationRunsSection'

const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.1, pricedCostUsd: 0, effectiveUsd: 0.1234, unknownCostTurns: 0 }
const BUDGET = { capUsd: 5, spentUsd: 0.1234, state: 'ok' }

function runSummary(over: Record<string, unknown> = {}) {
  return {
    runId: 'run_1', title: 'Repo audit', preset: 'repo-audit', status: 'executing', cwd: '/repo',
    epicPromptPreview: 'Audit', architect: { provider: 'claude-sdk', model: 'fable' },
    budget: BUDGET, usage: USAGE, nodeCounts: { total: 2, running: 1, done: 1, failed: 0 },
    pendingUserGates: 1, createdAt: 1000, updatedAt: 2000, ...over,
  }
}
function runDetail(over: Record<string, unknown> = {}) {
  return {
    ...runSummary(), epicPrompt: 'Audit the repo thoroughly',
    nodes: [{
      nodeId: 'st_a', runId: 'run_1', title: 'Audit auth', role: 'worker.audit', provider: 'codex', model: 'm',
      status: 'executing', attempt: 0, committeeIterations: 1, sessionId: 'sess_9', worktreePath: null,
      branch: null, planSummary: null, resultSummary: null, usage: USAGE, createdAt: 1000, updatedAt: 1500,
    }],
    gates: [{ gateId: 'g1', runId: 'run_1', nodeId: null, kind: 'epic_plan', status: 'pending', summary: 'Approve the 2-subtask plan', openedAt: 900, resolvedAt: null, resolvedBy: null }],
    timeline: [{ seq: 1, at: 950, kind: 'gate_opened', summary: 'plan gate opened' }],
    usageRollup: { total: USAGE, byRole: {}, byModel: {} },
    meteringGaps: [], ...over,
  }
}

const snapshot = (runs: unknown[]) => ({ type: 'orchestration_runs_snapshot', generatedAt: '2026-07-17T00:00:00.000Z', runs })

beforeEach(() => resetStore())
afterEach(() => cleanup())

describe('OrchestrationRunsSection (#6691 S-3b)', () => {
  it('renders the not-loaded and empty states', () => {
    const { rerender } = render(<OrchestrationRunsSection />)
    expect(screen.getByTestId('orch-runs-empty').textContent).toMatch(/Not loaded yet/)
    resetStore({ orchestrationRuns: snapshot([]) })
    rerender(<OrchestrationRunsSection />)
    expect(screen.getByTestId('orch-runs-empty').textContent).toMatch(/No orchestration runs yet/)
  })

  it('renders the degraded snapshot error', () => {
    resetStore({ orchestrationRuns: { ...snapshot([]), error: { code: 'UNAVAILABLE', message: 'engine off' } } })
    render(<OrchestrationRunsSection />)
    expect(screen.getByTestId('orch-runs-error').textContent).toMatch(/UNAVAILABLE/)
  })

  it('renders run rows with status, gate chip, and server-authored spend', () => {
    resetStore({ orchestrationRuns: snapshot([runSummary()]) })
    render(<OrchestrationRunsSection />)
    expect(screen.getByTestId('orch-run-title').textContent).toBe('Repo audit')
    expect(screen.getByTestId('orch-run-gate-chip').textContent).toMatch(/1 gate awaiting you/)
    expect(screen.getByTestId('orch-run-spend').textContent).toContain('$0.1234')
  })

  it('clicking a run selects it', () => {
    resetStore({ orchestrationRuns: snapshot([runSummary()]) })
    render(<OrchestrationRunsSection />)
    fireEvent.click(screen.getByTestId('orch-run-row'))
    expect(selectRunMock).toHaveBeenCalledWith('run_1')
  })

  it('an unheld selection pulls the detail via the effect', () => {
    resetStore({ orchestrationRuns: snapshot([runSummary()]), selectedRunId: 'run_1' })
    render(<OrchestrationRunsSection />)
    expect(requestDetailMock).toHaveBeenCalledWith('run_1')
    expect(requestDetailMock).toHaveBeenCalledTimes(1)
  })

  it('renders the detail panel: nodes, pending gate, timeline; Open session jumps', () => {
    resetStore({
      orchestrationRuns: snapshot([runSummary()]),
      selectedRunId: 'run_1',
      orchestrationRunDetails: { run_1: { detail: runDetail(), seq: 3 } },
    })
    render(<OrchestrationRunsSection />)
    expect(screen.getByTestId('orch-detail-title').textContent).toBe('Repo audit')
    expect(screen.getByTestId('orch-node-row').textContent).toContain('Audit auth')
    expect(screen.getByTestId('orch-gate-summary').textContent).toMatch(/Approve the 2-subtask plan/)
    expect(screen.getByTestId('orch-timeline-entry').textContent).toContain('plan gate opened')
    fireEvent.click(screen.getByTestId('orch-node-open-session'))
    expect(switchSessionMock).toHaveBeenCalledWith('sess_9')
  })

  it('shows the resyncing chip while the held detail is stale', () => {
    resetStore({
      orchestrationRuns: snapshot([runSummary()]),
      selectedRunId: 'run_1',
      orchestrationRunDetails: { run_1: { detail: runDetail(), seq: 3 } },
      orchestrationRunDetailStale: { run_1: true },
    })
    render(<OrchestrationRunsSection />)
    expect(screen.getByTestId('orch-detail-stale')).toBeTruthy()
  })

  it('renders the per-run detail error state', () => {
    resetStore({
      orchestrationRuns: snapshot([runSummary()]),
      selectedRunId: 'run_1',
      orchestrationRunDetailErrors: { run_1: { code: 'RUN_NOT_FOUND', message: 'gone' } },
    })
    render(<OrchestrationRunsSection />)
    expect(screen.getByTestId('orch-detail-error').textContent).toMatch(/RUN_NOT_FOUND/)
  })

  it('renders the report markdown (and raw JSON) at terminal state', () => {
    resetStore({
      orchestrationRuns: snapshot([runSummary({ status: 'completed' })]),
      selectedRunId: 'run_1',
      orchestrationRunDetails: { run_1: { detail: runDetail({ status: 'completed', report: { json: '{"ok":true}', markdown: '# Audit report' } }), seq: 9 } },
    })
    render(<OrchestrationRunsSection />)
    // rendered through the sanitized markdown pipeline → an <h1>, so the '#' is
    // gone from textContent but the heading text remains
    expect(screen.getByTestId('orch-report-markdown').textContent).toContain('Audit report')
    expect(screen.getByTestId('orch-report-markdown').querySelector('h1')).toBeTruthy()
    expect(screen.getByTestId('orch-report-json').textContent).toContain('"ok"')
  })

  it('Refresh dispatches the runs request and disables while loading', () => {
    resetStore({ orchestrationRuns: snapshot([]) })
    const { rerender } = render(<OrchestrationRunsSection />)
    fireEvent.click(screen.getByTestId('orch-refresh'))
    expect(requestRunsMock).toHaveBeenCalledTimes(1)
    resetStore({ orchestrationRuns: snapshot([]), orchestrationRunsLoading: true })
    rerender(<OrchestrationRunsSection />)
    expect((screen.getByTestId('orch-refresh') as HTMLButtonElement).disabled).toBe(true)
  })

  // ---- S-3c mutating affordances ----

  it('GateBanner: approve sends a gate response; request-changes requires a note', () => {
    resetStore({
      orchestrationRuns: snapshot([runSummary()]),
      selectedRunId: 'run_1',
      orchestrationRunDetails: { run_1: { detail: runDetail(), seq: 3 } },
    })
    render(<OrchestrationRunsSection />)
    // request-changes disabled until a note is typed
    expect((screen.getByTestId('orch-gate-revise') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('orch-gate-approve'))
    expect(gateResponseMock).toHaveBeenCalledWith('run_1', 'g1', 'approve', undefined, undefined)
    // typing a note enables revise
    fireEvent.change(screen.getByTestId('orch-gate-note'), { target: { value: 'tighten scope' } })
    fireEvent.click(screen.getByTestId('orch-gate-revise'))
    expect(gateResponseMock).toHaveBeenCalledWith('run_1', 'g1', 'revise', 'tighten scope', undefined)
  })

  it('GateBanner: after a success ack the buttons lock and show "Response sent" (no duplicate response)', () => {
    resetStore({
      orchestrationRuns: snapshot([runSummary()]),
      selectedRunId: 'run_1',
      orchestrationRunDetails: { run_1: { detail: runDetail(), seq: 3 } },
      // the ack already landed: pending cleared, result ok — the delta hasn't
      // yet flipped gate.status off 'pending' (the banner is still mounted)
      orchestrationPendingActions: {},
      orchestrationActionResults: { 'orch-gate-1': { ok: true, error: null, at: 1 } },
    })
    gateResponseMock.mockReturnValue('orch-gate-1')
    render(<OrchestrationRunsSection />)
    fireEvent.click(screen.getByTestId('orch-gate-approve'))
    expect(gateResponseMock).toHaveBeenCalledTimes(1)
    // its result is now ok → buttons lock, "Response sent" shows, re-click is a no-op
    expect(screen.getByTestId('orch-gate-sent')).toBeTruthy()
    expect((screen.getByTestId('orch-gate-approve') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('orch-gate-approve'))
    expect(gateResponseMock).toHaveBeenCalledTimes(1) // still 1 — locked
  })

  it('GateBanner: a 0 or empty budget is not sent as a cap', () => {
    const gate = { gateId: 'g2', runId: 'run_1', nodeId: null, kind: 'budget_overrun', status: 'pending', summary: 'Raise?', openedAt: 1, resolvedAt: null, resolvedBy: null, budgetUsd: 10 }
    resetStore({
      orchestrationRuns: snapshot([runSummary()]),
      selectedRunId: 'run_1',
      orchestrationRunDetails: { run_1: { detail: runDetail({ gates: [gate] }), seq: 3 } },
    })
    render(<OrchestrationRunsSection />)
    fireEvent.change(screen.getByTestId('orch-gate-budget-input'), { target: { value: '0' } })
    fireEvent.click(screen.getByTestId('orch-gate-approve'))
    expect(gateResponseMock).toHaveBeenCalledWith('run_1', 'g2', 'approve', undefined, undefined)
  })

  it('GateBanner: a budget_overrun gate exposes the new-cap input on approve', () => {
    const gate = { gateId: 'g2', runId: 'run_1', nodeId: null, kind: 'budget_overrun', status: 'pending', summary: 'Raise the cap?', openedAt: 1, resolvedAt: null, resolvedBy: null, budgetUsd: 10 }
    resetStore({
      orchestrationRuns: snapshot([runSummary()]),
      selectedRunId: 'run_1',
      orchestrationRunDetails: { run_1: { detail: runDetail({ gates: [gate] }), seq: 3 } },
    })
    render(<OrchestrationRunsSection />)
    fireEvent.change(screen.getByTestId('orch-gate-budget-input'), { target: { value: '12.5' } })
    fireEvent.click(screen.getByTestId('orch-gate-approve'))
    expect(gateResponseMock).toHaveBeenCalledWith('run_1', 'g2', 'approve', undefined, 12.5)
  })

  it('RunControls: cancel confirms then sends; pause shown for an executing run', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    resetStore({
      orchestrationRuns: snapshot([runSummary()]),
      selectedRunId: 'run_1',
      orchestrationRunDetails: { run_1: { detail: runDetail({ status: 'executing' }), seq: 3 } },
    })
    render(<OrchestrationRunsSection />)
    expect(screen.getByTestId('orch-action-pause')).toBeTruthy()
    fireEvent.click(screen.getByTestId('orch-action-cancel'))
    expect(confirmSpy).toHaveBeenCalled()
    expect(runActionMock).toHaveBeenCalledWith('run_1', 'cancel')
    confirmSpy.mockRestore()
  })

  it('RunControls: resume shown for a paused run, hidden at terminal state', () => {
    resetStore({
      orchestrationRuns: snapshot([runSummary({ status: 'paused' })]),
      selectedRunId: 'run_1',
      orchestrationRunDetails: { run_1: { detail: runDetail({ status: 'paused' }), seq: 3 } },
    })
    const { rerender } = render(<OrchestrationRunsSection />)
    fireEvent.click(screen.getByTestId('orch-action-resume'))
    expect(runActionMock).toHaveBeenCalledWith('run_1', 'resume')
    // terminal → no controls at all
    resetStore({
      orchestrationRuns: snapshot([runSummary({ status: 'completed' })]),
      selectedRunId: 'run_1',
      orchestrationRunDetails: { run_1: { detail: runDetail({ status: 'completed' }), seq: 9 } },
    })
    rerender(<OrchestrationRunsSection />)
    expect(screen.queryByTestId('orch-run-controls')).toBeNull()
  })

  it('AnnotateForm: submits baseline + verdict quality at terminal state', () => {
    resetStore({
      orchestrationRuns: snapshot([runSummary({ status: 'completed' })]),
      selectedRunId: 'run_1',
      orchestrationRunDetails: { run_1: { detail: runDetail({ status: 'completed' }), seq: 9 } },
    })
    render(<OrchestrationRunsSection />)
    fireEvent.change(screen.getByTestId('orch-annotate-baseline'), { target: { value: 'sess_mono' } })
    fireEvent.change(screen.getByTestId('orch-annotate-quality'), { target: { value: 'excellent' } })
    fireEvent.click(screen.getByTestId('orch-annotate-submit'))
    expect(annotateMock).toHaveBeenCalledWith('run_1', { baselineSessionId: 'sess_mono', verdictQuality: 'excellent' })
  })

  it('NewRunModal: opens, requires cwd, and starts a preset run', () => {
    resetStore({ orchestrationRuns: snapshot([]) })
    render(<OrchestrationRunsSection />)
    fireEvent.click(screen.getByTestId('orch-new-run'))
    expect(screen.getByTestId('orch-new-run-modal')).toBeTruthy()
    // submit disabled until cwd is provided
    expect((screen.getByTestId('orch-new-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('orch-new-cwd'), { target: { value: '/repo' } })
    fireEvent.click(screen.getByTestId('orch-new-autoapprove'))
    fireEvent.click(screen.getByTestId('orch-new-submit'))
    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo', preset: 'repo-audit', autoApprovePlan: true }))
  })

  it('NewRunModal: custom epic prompt path (no preset)', () => {
    resetStore({ orchestrationRuns: snapshot([]) })
    render(<OrchestrationRunsSection />)
    fireEvent.click(screen.getByTestId('orch-new-run'))
    fireEvent.change(screen.getByTestId('orch-new-preset'), { target: { value: '' } })
    fireEvent.change(screen.getByTestId('orch-new-cwd'), { target: { value: '/repo' } })
    fireEvent.change(screen.getByTestId('orch-new-epic'), { target: { value: 'Refactor the auth module' } })
    fireEvent.click(screen.getByTestId('orch-new-submit'))
    expect(startRunMock).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo', epicPrompt: 'Refactor the auth module', preset: undefined }))
  })
})
