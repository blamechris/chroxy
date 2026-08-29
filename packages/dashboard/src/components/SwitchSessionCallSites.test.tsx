/**
 * #7475 matrix cells 2 and 3 — the two UI callers that hand `switchSession` an
 * id from a record that outlives the session.
 *
 * The dead-id BEHAVIOUR is proven once, at the choke point, in
 * `store/switch-session-membership.test.ts`. What these two cells have to prove
 * is the other half, and it is the half that made #7475 a bug in the first
 * place: that each caller actually goes through the default door. Once
 * `switchSession` membership-checks by default, the only way one of these
 * callers can regress is by opting OUT — so that is exactly what is asserted.
 *
 * `toHaveBeenCalledWith(id)` is an exact-arity assertion in vitest: a call site
 * that grew a second argument (`{ allowUnlisted: true }`) fails it. That is the
 * whole regression surface for these two, stated as one assertion each.
 *
 * These use the repo's mocked-store convention for component tests
 * (ControlRoomView.test.tsx / OrchestrationRunsSection.test.tsx both do), which
 * is deliberate and not laziness: those files record that rendering the REAL
 * store hooks under testing-library risks a dual-React-instance hazard. The
 * trade is stated plainly — these cells prove the WIRING, the store test proves
 * the BEHAVIOUR, and neither one alone would close #7475.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ActivityEntry, ActivityState } from '@chroxy/store-core'
import { createEmptyActivityState, applyActivitySnapshot } from '@chroxy/store-core'

const switchSessionMock = vi.fn()
let storeState: Record<string, unknown> = {}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector?: (s: Record<string, unknown>) => unknown) =>
    typeof selector === 'function' ? selector(storeState) : storeState,
}))

import { OrchestrationRunsSection } from './OrchestrationRunsSection'
import { ControlRoomView } from './ControlRoomView'

const T0 = 1_800_000_000_000

function activityWithBlockedAgent(sessionId: string): ActivityState {
  const entry: ActivityEntry = {
    id: 'agent1',
    kind: 'agent',
    label: 'blocked agent',
    status: 'blocked',
    startedAt: T0,
  }
  return applyActivitySnapshot(createEmptyActivityState(), {
    type: 'activity_snapshot',
    sessionId,
    schemaVersion: 1,
    entries: [entry],
  })
}

const USAGE = {
  inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0,
  costUsd: 0.1, pricedCostUsd: 0, effectiveUsd: 0.1234, unknownCostTurns: 0,
}
const BUDGET = { capUsd: 5, spentUsd: 0.1234, state: 'ok' }

function runDetail() {
  return {
    runId: 'run_1', title: 'Repo audit', preset: 'repo-audit', status: 'done', cwd: '/repo',
    epicPromptPreview: 'Audit', epicPrompt: 'Audit the repo thoroughly',
    architect: { provider: 'claude-sdk', model: 'fable' },
    budget: BUDGET, usage: USAGE, nodeCounts: { total: 1, running: 0, done: 1, failed: 0 },
    pendingUserGates: 0, createdAt: 1000, updatedAt: 2000,
    nodes: [{
      nodeId: 'st_a', runId: 'run_1', title: 'Audit auth', role: 'worker.audit',
      provider: 'codex', model: 'm', status: 'done', attempt: 0, committeeIterations: 0,
      // A COMPLETED run's node still records the sub-session id, and the button
      // is gated only on the id being present — not on the session still
      // existing. That is #7475's own repro.
      sessionId: 'sess_gone', worktreePath: null, branch: null, planSummary: null,
      resultSummary: null, usage: USAGE, createdAt: 1000, updatedAt: 1500,
    }],
    gates: [], timeline: [],
    usageRollup: { total: USAGE, byRole: {}, byModel: {} },
    meteringGaps: [],
  }
}

function baseStore(over: Record<string, unknown> = {}) {
  return {
    connectionPhase: 'connected',
    serverCapabilities: { orchestration: true },
    switchSession: switchSessionMock,
    // Orchestration surface
    orchestrationRuns: { generatedAt: new Date(T0).toISOString(), runs: [runDetail()], error: null },
    orchestrationRunsLoading: false,
    orchestrationRunDetails: { run_1: { detail: runDetail(), seq: 3 } },
    orchestrationRunDetailLoading: new Set<string>(),
    orchestrationRunDetailErrors: {},
    orchestrationRunDetailStale: {},
    orchestrationPendingActions: {},
    orchestrationActionResults: {},
    selectedRunId: 'run_1',
    requestOrchestrationRuns: vi.fn(() => true),
    requestOrchestrationRunDetail: vi.fn(() => true),
    selectRun: vi.fn(),
    startOrchestrationRun: vi.fn(() => 'orch-start-1'),
    sendOrchestrationGateResponse: vi.fn(() => 'orch-gate-1'),
    sendOrchestrationRunAction: vi.fn(() => 'orch-action-1'),
    sendOrchestrationRunAnnotate: vi.fn(() => 'orch-annotate-1'),
    // Control Room shell + mission-control tab
    hostStatus: null, runnerStatus: null, integrationStatus: null,
    hostStatusLoading: false, runnerStatusLoading: false, integrationStatusLoading: false,
    requestHostStatus: vi.fn(() => true),
    requestRunnerStatus: vi.fn(() => true),
    requestIntegrationStatus: vi.fn(() => true),
    sessions: [{ sessionId: 'sess_gone', cwd: '/home/u/repo-a', name: 'A1' }],
    activity: activityWithBlockedAgent('sess_gone'),
    externalSessionsSnapshot: null,
    requestExternalSessions: vi.fn(() => true),
    sendCancelActivity: vi.fn(),
    cancellingActivityIds: new Set<string>(),
    ...over,
  }
}

beforeEach(() => {
  switchSessionMock.mockClear()
  localStorage.clear()
  storeState = baseStore()
})
afterEach(cleanup)

describe('#7475 cell 2 — OrchestrationRunsSection "Open session"', () => {
  it('routes through the DEFAULT door: no allowUnlisted opt-out', () => {
    render(<OrchestrationRunsSection now={() => T0} />)
    fireEvent.click(screen.getByTestId('orch-node-open-session'))
    // Exact arity: a second argument would fail this.
    expect(switchSessionMock).toHaveBeenCalledWith('sess_gone')
    expect(switchSessionMock.mock.calls[0]).toHaveLength(1)
  })
})

describe('#7475 cell 3 — ControlRoomView jump-to-intervene', () => {
  it('routes through the DEFAULT door: no allowUnlisted opt-out', () => {
    render(<ControlRoomView initialTab="mission-control" />)
    fireEvent.click(screen.getByTestId('mission-control-session-toggle-sess_gone'))
    fireEvent.click(screen.getByTestId('control-room-jump-agent1'))
    expect(switchSessionMock).toHaveBeenCalledWith('sess_gone')
    expect(switchSessionMock.mock.calls[0]).toHaveLength(1)
  })
})
