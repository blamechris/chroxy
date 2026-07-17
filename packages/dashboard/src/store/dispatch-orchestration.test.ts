/**
 * Integration test for the orchestration Runs-tab data wiring (#6691, S-3
 * #6702). Guards: list snapshot REPLACES + clears loading (degraded shape
 * valid; malformed dropped without clearing loading); run detail seeds the
 * store-core HeldRunDetail; deltas apply via the shared reducer under the
 * seq===held+1 contract (gap → stale + one resync re-request); action ack and
 * session_error{ORCHESTRATION_ACTION_FAILED} both clear the pending entry.
 * Mirrors dispatch-repo-events.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'mock-salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0, DIRECTION_SERVER: 1,
}))
vi.mock('./persistence', () => ({ clearPersistedSession: vi.fn() }))

import { handleMessage, setStore, clearDeltaBuffers, clearPermissionSplits, stopHeartbeat, resetReplayFlags } from './message-handler'
import type { ConnectionState } from './types'
import type { RunSummary, RunDetail } from '@chroxy/protocol'

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      state = { ...state, ...(typeof s === 'function' ? s(state) : s) }
    },
  }
}
function createMockSocket(): WebSocket {
  return { send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as WebSocket
}

const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.1, pricedCostUsd: 0, effectiveUsd: 0.1, unknownCostTurns: 0 }
const BUDGET = { capUsd: null, spentUsd: 0.1, state: 'ok' as const }

function runSummary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'run_1', title: 'Audit', preset: 'repo-audit', status: 'executing', cwd: '/repo',
    epicPromptPreview: 'Audit the repo', architect: { provider: 'claude-sdk', model: 'fable' },
    budget: BUDGET, usage: USAGE,
    nodeCounts: { total: 2, running: 1, done: 1, failed: 0 },
    pendingUserGates: 0, createdAt: 1000, updatedAt: 2000,
    ...over,
  } as RunSummary
}
function runDetail(over: Partial<RunDetail> = {}): RunDetail {
  return {
    ...runSummary(), epicPrompt: 'Audit the repo thoroughly',
    nodes: [], gates: [], timeline: [],
    usageRollup: { total: USAGE, byRole: {}, byModel: {} },
    meteringGaps: [],
    ...over,
  } as RunDetail
}
const GATE = { gateId: 'g1', runId: 'run_1', nodeId: null, kind: 'epic_plan' as const, status: 'pending' as const, summary: 'Approve the plan', openedAt: 1000, resolvedAt: null, resolvedBy: null }

function baseState(): Partial<ConnectionState> {
  return {
    connectionPhase: 'connected', socket: null, sessions: [], activeSessionId: null, sessionStates: {}, messages: [],
    orchestrationRuns: null, orchestrationRunsLoading: true,
    orchestrationRunDetails: {}, orchestrationRunDetailLoading: new Set<string>(),
    orchestrationRunDetailErrors: {}, orchestrationRunDetailStale: {},
    orchestrationPendingActions: {}, orchestrationActionResults: {},
    selectedRunId: null,
    requestOrchestrationRuns: vi.fn(() => true) as never,
    requestOrchestrationRunDetail: vi.fn(() => true) as never,
    // the generic session_error fall-through raises the server-error banner
    addServerError: vi.fn() as never,
  }
}

describe('orchestration dispatch (#6691 S-3)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('runs_snapshot REPLACES the list and clears loading; degraded shape is valid', () => {
    handleMessage({ type: 'orchestration_runs_snapshot', generatedAt: '2026-07-17T00:00:00.000Z', runs: [runSummary()] }, ctx() as never)
    let s = store.getState()
    expect(s.orchestrationRuns!.runs).toHaveLength(1)
    expect(s.orchestrationRunsLoading).toBe(false)
    // degraded: empty + error — still stored (the section renders the error)
    handleMessage({ type: 'orchestration_runs_snapshot', generatedAt: '2026-07-17T00:01:00.000Z', runs: [], error: { code: 'UNAVAILABLE', message: 'engine off' } }, ctx() as never)
    s = store.getState()
    expect(s.orchestrationRuns!.runs).toHaveLength(0)
    expect(s.orchestrationRuns!.error!.code).toBe('UNAVAILABLE')
  })

  it('malformed runs_snapshot is dropped WITHOUT clearing loading', () => {
    handleMessage({ type: 'orchestration_runs_snapshot', runs: 'nope' }, ctx() as never)
    expect(store.getState().orchestrationRunsLoading).toBe(true)
    expect(store.getState().orchestrationRuns).toBeNull()
  })

  it('run_snapshot seeds { detail, seq }; run:null degraded reply clears loading', () => {
    store.setState({ orchestrationRunDetailLoading: new Set(['run_1']) })
    handleMessage({ type: 'orchestration_run_snapshot', generatedAt: '2026-07-17T00:00:00.000Z', seq: 5, run: runDetail() }, ctx() as never)
    const s = store.getState()
    expect(s.orchestrationRunDetails.run_1!.seq).toBe(5)
    expect(s.orchestrationRunDetails.run_1!.detail.epicPrompt).toBe('Audit the repo thoroughly')
    expect(s.orchestrationRunDetailLoading.has('run_1')).toBe(false)
    // degraded run:null with the `detail:<runId>` echo routes to THAT run only
    store.setState({ orchestrationRunDetailLoading: new Set(['run_x', 'run_y']) })
    handleMessage({ type: 'orchestration_run_snapshot', requestId: 'detail:run_x', generatedAt: '2026-07-17T00:00:00.000Z', seq: 0, run: null, error: { code: 'RUN_NOT_FOUND', message: 'nope' } }, ctx() as never)
    const s2 = store.getState()
    expect(s2.orchestrationRunDetailLoading.has('run_x')).toBe(false)
    expect(s2.orchestrationRunDetailLoading.has('run_y')).toBe(true, )
    expect(s2.orchestrationRunDetailErrors.run_x!.code).toBe('RUN_NOT_FOUND')
    // no parseable echo → fall back to clearing ALL loading (nothing spins forever)
    handleMessage({ type: 'orchestration_run_snapshot', generatedAt: '2026-07-17T00:00:00.000Z', seq: 0, run: null, error: { code: 'UNAVAILABLE', message: 'engine off' } }, ctx() as never)
    expect(store.getState().orchestrationRunDetailLoading.size).toBe(0)
  })

  it('a resync request preserves the stale flag until a valid snapshot lands', () => {
    // simulate: gap marked the run stale, resync issued, snapshot arrives
    store.setState({
      orchestrationRunDetailStale: { run_1: true },
      orchestrationRunDetailLoading: new Set(['run_1']),
    })
    handleMessage({ type: 'orchestration_run_snapshot', generatedAt: '2026-07-17T00:02:00.000Z', seq: 7, run: runDetail(), requestId: 'detail:run_1' }, ctx() as never)
    const s = store.getState()
    expect(s.orchestrationRunDetailStale.run_1).toBeUndefined()
    expect(s.orchestrationRunDetails.run_1!.seq).toBe(7)
  })

  it('in-order delta applies via the reducer (gate upsert + header update)', () => {
    store.setState({
      orchestrationRuns: { type: 'orchestration_runs_snapshot', generatedAt: '2026-07-17T00:00:00.000Z', runs: [runSummary()] } as never,
      orchestrationRunDetails: { run_1: { detail: runDetail(), seq: 1 } },
    })
    handleMessage({
      type: 'orchestration_run_delta', runId: 'run_1', seq: 2, generatedAt: '2026-07-17T00:01:00.000Z',
      run: runSummary({ status: 'plan_review', pendingUserGates: 1 }), gate: GATE,
    }, ctx() as never)
    const s = store.getState()
    expect(s.orchestrationRunDetails.run_1!.seq).toBe(2)
    expect(s.orchestrationRunDetails.run_1!.detail.gates).toHaveLength(1)
    expect(s.orchestrationRunDetails.run_1!.detail.status).toBe('plan_review')
    // list row upserted too
    expect(s.orchestrationRuns!.runs[0]!.pendingUserGates).toBe(1)
  })

  it('a seq gap marks the run stale and issues exactly one resync re-request', () => {
    store.setState({ orchestrationRunDetails: { run_1: { detail: runDetail(), seq: 1 } } })
    handleMessage({ type: 'orchestration_run_delta', runId: 'run_1', seq: 5, generatedAt: '2026-07-17T00:01:00.000Z', run: runSummary() }, ctx() as never)
    const s = store.getState()
    expect(s.orchestrationRunDetailStale.run_1).toBe(true)
    expect(s.orchestrationRunDetails.run_1!.seq).toBe(1, )
    expect(s.requestOrchestrationRunDetail).toHaveBeenCalledTimes(1)
    expect(s.requestOrchestrationRunDetail).toHaveBeenCalledWith('run_1')
  })

  it('a stale/duplicate seq is ignored (no state change, no re-request)', () => {
    store.setState({ orchestrationRunDetails: { run_1: { detail: runDetail(), seq: 3 } } })
    handleMessage({ type: 'orchestration_run_delta', runId: 'run_1', seq: 2, generatedAt: '2026-07-17T00:01:00.000Z', gate: GATE }, ctx() as never)
    const s = store.getState()
    expect(s.orchestrationRunDetails.run_1!.seq).toBe(3)
    expect(s.orchestrationRunDetails.run_1!.detail.gates).toHaveLength(0)
    expect(s.requestOrchestrationRunDetail).not.toHaveBeenCalled()
  })

  it('a delta with no list held and pendingUserGates>0 triggers one list fetch', () => {
    store.setState({ orchestrationRunsLoading: false })
    handleMessage({ type: 'orchestration_run_delta', runId: 'run_1', seq: 1, generatedAt: '2026-07-17T00:01:00.000Z', run: runSummary({ pendingUserGates: 1 }) }, ctx() as never)
    expect(store.getState().requestOrchestrationRuns).toHaveBeenCalledTimes(1)
  })

  it('action_ack clears the pending entry and records success', () => {
    store.setState({ orchestrationPendingActions: { 'orch-1': { kind: 'gate_response', runId: 'run_1', gateId: 'g1', at: 1 } } })
    handleMessage({ type: 'orchestration_action_ack', requestId: 'orch-1', action: 'gate_response', runId: 'run_1', gateId: 'g1' }, ctx() as never)
    const s = store.getState()
    expect(s.orchestrationPendingActions['orch-1']).toBeUndefined()
    expect(s.orchestrationActionResults['orch-1']!.ok).toBe(true)
  })

  it('session_error{ORCHESTRATION_ACTION_FAILED} clears pending and records the reason', () => {
    store.setState({ orchestrationPendingActions: { 'orch-2': { kind: 'start', runId: 'run_1', at: 1 } } })
    handleMessage({ type: 'session_error', code: 'ORCHESTRATION_ACTION_FAILED', message: 'gate already resolved', requestId: 'orch-2' }, ctx() as never)
    const s = store.getState()
    expect(s.orchestrationPendingActions['orch-2']).toBeUndefined()
    expect(s.orchestrationActionResults['orch-2']!.ok).toBe(false)
    expect(s.orchestrationActionResults['orch-2']!.error).toMatch(/already resolved/)
  })
})
