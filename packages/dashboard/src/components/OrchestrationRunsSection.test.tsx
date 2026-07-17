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
let storeState: Record<string, unknown> = {}

function resetStore(over: Record<string, unknown> = {}) {
  requestRunsMock.mockClear(); requestDetailMock.mockClear(); selectRunMock.mockClear(); switchSessionMock.mockClear()
  storeState = {
    connectionPhase: 'connected',
    orchestrationRuns: null,
    orchestrationRunsLoading: false,
    orchestrationRunDetails: {},
    orchestrationRunDetailLoading: new Set<string>(),
    orchestrationRunDetailErrors: {},
    orchestrationRunDetailStale: {},
    selectedRunId: null,
    requestOrchestrationRuns: requestRunsMock,
    requestOrchestrationRunDetail: requestDetailMock,
    selectRun: selectRunMock,
    switchSession: switchSessionMock,
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
})
