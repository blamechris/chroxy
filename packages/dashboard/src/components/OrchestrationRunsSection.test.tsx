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
import fs from 'node:fs'
import path from 'node:path'

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
    // #7536 — the node gate reads the SAME `sessions` roster `switchSession`
    // membership-checks against, so the fixture has to carry one. Filled with
    // the session `runDetail()`'s node points at, which makes every pre-existing
    // case a LIVE-node case (what they were written against) instead of
    // silently flipping them to the gone branch.
    sessions: [{ sessionId: 'sess_9', name: 'Audit auth', cwd: '/repo' }],
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

  it('#6733: a resource_paused run renders a warn chip and NO Resume button', () => {
    resetStore({
      orchestrationRuns: snapshot([runSummary({ status: 'resource_paused' })]),
      selectedRunId: 'run_1',
      orchestrationRunDetails: { run_1: { detail: runDetail({ status: 'resource_paused' }), seq: 3 } },
    })
    render(<OrchestrationRunsSection />)
    const chip = screen.getAllByTestId('orch-run-status')[0] as HTMLElement
    // POSITIVE CONTROL: the row really rendered this status, so the accent
    // assertion below is reading the right chip.
    expect(chip.textContent).toBe('resource paused')
    // a stall the operator must notice — not the neutral in-flight accent
    expect(chip.getAttribute('data-accent')).toBe('warn')
    // the engine clears this itself when a slot frees; a Resume button would
    // either no-op or race it
    expect(screen.queryByTestId('orch-action-resume')).toBeNull()
    expect(screen.getByTestId('orch-action-cancel')).toBeTruthy()
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

// ---------------------------------------------------------------------------
// #7536 — a run node's "Open session" button, gated on roster membership
// ---------------------------------------------------------------------------
/**
 * `orchestrationRuns[].nodes[].sessionId` is PROVENANCE, not a live handle. A
 * node's session is closed the moment the node finishes; the run record keeps
 * the id long afterwards, which is the point of a run record. The render gate
 * was `node.sessionId` being TRUTHY — "this node ever had a session" — so a
 * completed node kept a link-styled, clickable "Open session" button that
 * `switchSession` has refused in silence since #7511. A finished run is the
 * NORMAL state of this panel, so that was not an edge case: it was most of the
 * rows.
 *
 * Same defect class and same remedy as the notification surfaces (#7516 /
 * PR #7528), and deliberately the SAME predicate — `isSessionListed` over the
 * store's `sessions` — because a second `sessions.some(...)` written here is
 * the copy that drifts away from the door it is supposed to mirror (#7475).
 *
 * ## The inert shape, and where it diverges from the banner
 *
 * The button goes (the banner's shape, not the widget's): a closed node session
 * does not come back under the same id, and #7466's criterion is that an
 * unrecoverable state loses the control rather than keeping a disabled one.
 * Unlike the widget row, this button carries no second duty — it is not a
 * mark-read affordance and not a menu anchor — so there is nothing to preserve.
 *
 * A marker says WHY, in the banner's own vocabulary ("No longer open"), because
 * a silently affordance-less row reads as a rendering bug. It is NOT a
 * `role="status"` live region, and that is the one place this surface argues
 * away from the banner precedent: the banner shows at most a few rows and the
 * gone state is its exception, whereas a run detail renders one node row per
 * subtask and the gone state is the terminal state of every one of them. A live
 * region per list item is unbounded simultaneous announcement for a read-only
 * observer panel — the row's own status chip already moved to `completed` in the
 * same render, which is the change worth hearing.
 */
describe('#7536 — the orchestration node session-jump is gated on roster membership', () => {
  const node = (over: Record<string, unknown> = {}) => ({
    nodeId: 'st_a', runId: 'run_1', title: 'Audit auth', role: 'worker.audit',
    provider: 'codex', model: 'm', status: 'completed', attempt: 0,
    committeeIterations: 1, sessionId: 'sess_9', worktreePath: null, branch: 'feat/x',
    planSummary: null, resultSummary: null, usage: USAGE, createdAt: 1000, updatedAt: 1500,
    ...over,
  })

  function renderWithNodes(nodes: unknown[], sessions: unknown[]) {
    resetStore({
      sessions,
      orchestrationRuns: snapshot([runSummary()]),
      selectedRunId: 'run_1',
      orchestrationRunDetails: { run_1: { detail: runDetail({ nodes }), seq: 3 } },
    })
    render(<OrchestrationRunsSection />)
  }

  it('CONTROL: a LISTED session keeps its button, and it still switches', () => {
    renderWithNodes([node()], [{ sessionId: 'sess_9' }])
    fireEvent.click(screen.getByTestId('orch-node-open-session'))
    expect(switchSessionMock).toHaveBeenCalledWith('sess_9')
    expect(screen.queryByTestId('orch-node-session-gone')).toBeNull()
  })

  it('an ABSENT session presents no jump affordance', () => {
    renderWithNodes([node()], [])
    expect(screen.queryByTestId('orch-node-open-session')).toBeNull()
    // Enumerated rather than "the jump one is missing", so a control appearing
    // or vanishing inside the node row is red rather than unnoticed.
    const row = screen.getByTestId('orch-node-row')
    expect(row.querySelectorAll('button').length).toBe(0)
  })

  it('KEEPS the record: title, role, status and branch all still render', () => {
    // The issue's own acceptance criterion — a gate, not a dismissal. A fix
    // that dropped the whole row would satisfy "no dead click" and destroy the
    // provenance the run detail exists to show.
    renderWithNodes([node()], [])
    const row = screen.getByTestId('orch-node-row')
    expect(row.textContent).toContain('Audit auth')
    expect(screen.getByTestId('orch-node-role').textContent).toBe('worker.audit')
    // Scoped to the row: `StatusChip` carries `orch-run-status` on the run row
    // and the detail header too, so an unscoped query matches three elements.
    expect(row.querySelector('[data-testid="orch-run-status"]')?.textContent).toContain('completed')
    expect(screen.getByTestId('orch-node-branch').textContent).toBe('feat/x')
  })

  it('says WHY, rather than going silently affordance-less', () => {
    renderWithNodes([node()], [])
    expect(screen.getByTestId('orch-node-session-gone').textContent).toBe('No longer open')
  })

  it('a node that NEVER had a session gets neither the button nor the marker', () => {
    // The two absences are different facts and must not collapse. "No longer
    // open" against a node that never ran a session would be a false claim,
    // and it is the shape a naive `!listed` gate produces.
    renderWithNodes([node({ sessionId: null })], [])
    expect(screen.queryByTestId('orch-node-open-session')).toBeNull()
    expect(screen.queryByTestId('orch-node-session-gone')).toBeNull()
  })

  it('gates PER NODE: a live sibling keeps its button', () => {
    // The predicate is asked per node. A single run-level "something is gone"
    // flag would disarm every row in a run whose first node finished — which is
    // every run.
    renderWithNodes(
      [node({ nodeId: 'st_a', sessionId: 'sess_dead' }), node({ nodeId: 'st_b', sessionId: 'sess_9' })],
      [{ sessionId: 'sess_9' }],
    )
    const buttons = screen.getAllByTestId('orch-node-open-session')
    expect(buttons.length).toBe(1)
    expect(screen.getAllByTestId('orch-node-session-gone').length).toBe(1)
    fireEvent.click(buttons[0]!)
    expect(switchSessionMock).toHaveBeenCalledWith('sess_9')
    expect(switchSessionMock).toHaveBeenCalledTimes(1)
  })

  it('no dead id reaches the choke point: there is nothing left to click', () => {
    // The whole harm: `switchSession` refusing in silence is what made the
    // click dead, and App's handler used to apply half a switch on the way to
    // that refusal (#7535). The gate means the question is never asked.
    //
    // The row's remaining controls are CLICKED rather than merely counted. A
    // bare `expect(switchSessionMock).not.toHaveBeenCalled()` after a render
    // nothing clicked is green against the unfixed component too — the
    // "negative assertion with no positive control" shape.
    renderWithNodes([node()], [])
    const row = screen.getByTestId('orch-node-row')
    row.querySelectorAll('button').forEach((b) => fireEvent.click(b))
    expect(switchSessionMock).not.toHaveBeenCalled()
  })

  it('flips LIVE when the roster drops the node session under the cursor', () => {
    // Roster membership changes only by a store WRITE, which re-renders — the
    // same argument NotificationBanners makes for having no click-time
    // re-check. Pinned here so the argument is tested, not merely asserted.
    resetStore({
      sessions: [{ sessionId: 'sess_9' }],
      orchestrationRuns: snapshot([runSummary()]),
      selectedRunId: 'run_1',
      orchestrationRunDetails: { run_1: { detail: runDetail({ nodes: [node()] }), seq: 3 } },
    })
    const { rerender } = render(<OrchestrationRunsSection />)
    expect(screen.getByTestId('orch-node-open-session')).toBeTruthy()
    storeState = { ...storeState, sessions: [] }
    rerender(<OrchestrationRunsSection />)
    expect(screen.queryByTestId('orch-node-open-session')).toBeNull()
    expect(screen.getByTestId('orch-node-session-gone')).toBeTruthy()
  })

  it('uses the SHARED predicate, not a second sessions.some() in this file', () => {
    // #7475 collapsed four call-site membership copies into one door precisely
    // so that "looks clickable" and "will work" cannot disagree. A hand-rolled
    // `.some()` here would be copy number two, and it would pass every
    // behavioural cell above on the day it was written.
    //
    // Collapsed to a boolean before asserting: a failing `toContain` against a
    // 20KB source file dumps the whole subject into the failure report
    // (docs/false-safety-guards.md entry 17).
    //
    // Comments are stripped first, and that is not tidiness: the first cut of
    // this guard went red against the component's OWN docstring, whose sentence
    // "never a second `sessions.some(...)`" is itself a match. A guard a
    // comment can satisfy — or violate — is reading prose, not code.
    const raw = fs.readFileSync(path.resolve(__dirname, './OrchestrationRunsSection.tsx'), 'utf-8')
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // Positive controls for the stripper, both directions: it must remove the
    // prose and keep the code. Without these a stripper that returned '' would
    // make every assertion below pass.
    expect(code.includes('#7536')).toBe(false)
    expect(code.includes("data-testid=\"orch-node-session-gone\"")).toBe(true)
    expect(code.includes("import { isSessionListed } from '../store/utils'")).toBe(true)
    expect(/sessions\.some\s*\(/.test(code)).toBe(false)
  })
})
