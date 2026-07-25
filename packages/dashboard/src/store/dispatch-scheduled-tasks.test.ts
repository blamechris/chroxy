/**
 * #6871 — `scheduled_tasks` dispatch + the scheduled-task failure branch.
 *
 * Drives the REAL dashboard handleMessage against a mock store (mirrors
 * dispatch-orchestration.test.ts) to pin:
 *   - a valid snapshot is held wholesale and clears loading
 *   - a MALFORMED payload is dropped WITHOUT clearing loading and never blanks a
 *     good snapshot (an empty task list must never be manufactured from garbage —
 *     "no scheduled tasks" and "the payload was broken" are different facts)
 *   - the snapshot doubles as the mutation ACK when it echoes a requestId
 *   - every scheduler error code releases the pending entry and records why
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

const GATE = { enabled: false, engineArmed: false, restartRequired: false, source: 'default' as const }

function snapshot(over: Record<string, unknown> = {}) {
  return {
    type: 'scheduled_tasks',
    generatedAt: '2026-07-24T00:00:00.000Z',
    scheduler: GATE,
    schedulableProviders: ['claude-sdk'],
    defaultProvider: 'claude-sdk',
    defaultProviderRefusal: null,
    tasks: [],
    ...over,
  }
}

function mkTask(over: Record<string, unknown> = {}) {
  return {
    id: 't1', name: null, enabled: true, prompt: 'p', target: {},
    cadence: { kind: 'cron', expression: '* * * * *' },
    nextRun: 1, lastRun: null, createdAt: 1, updatedAt: 1,
    providerRefusal: null, effectiveProvider: 'claude-sdk',
    effectivePermissionMode: 'approve', permissionModeClamped: false, quarantined: false,
    ...over,
  }
}

function baseState(): Partial<ConnectionState> {
  return {
    connectionPhase: 'connected', socket: null, sessions: [], activeSessionId: null,
    sessionStates: {}, messages: [],
    scheduledTasks: null, scheduledTasksLoading: true,
    scheduledTaskPendingActions: {}, scheduledTaskActionResults: {},
    selectedScheduledTaskId: null,
    requestScheduledTasks: vi.fn(() => true) as never,
    // the generic session_error fall-through raises the server-error banner
    addServerError: vi.fn() as never,
  }
}

describe('scheduled_tasks dispatch (#6871)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('holds a valid snapshot and clears loading', () => {
    handleMessage(snapshot() as never, ctx() as never)
    const s = store.getState()
    expect(s.scheduledTasks).not.toBeNull()
    expect(s.scheduledTasksLoading).toBe(false)
    expect(s.scheduledTasks!.scheduler.enabled).toBe(false)
  })

  it('holds the task list and the engine verdicts VERBATIM', () => {
    const task = mkTask({
      lastRun: { at: 1, status: 'refused', error: 'quarantined until daemon restart: disk full' },
      providerRefusal: "provider 'claude-tui' routes permission prompts through the permission hook",
      effectiveProvider: 'claude-tui', permissionModeClamped: true, quarantined: true,
    })
    handleMessage(snapshot({ tasks: [task] }) as never, ctx() as never)
    expect(store.getState().scheduledTasks!.tasks[0]).toEqual(task)
  })

  it('stores a DEGRADED snapshot (empty + error) — the panel renders the error', () => {
    handleMessage(
      snapshot({ tasks: [], error: { code: 'SCHEDULER_REGISTRY_UNAVAILABLE', message: 'no registry' } }) as never,
      ctx() as never,
    )
    const s = store.getState()
    expect(s.scheduledTasks!.tasks).toHaveLength(0)
    expect(s.scheduledTasks!.error!.code).toBe('SCHEDULER_REGISTRY_UNAVAILABLE')
    expect(s.scheduledTasksLoading).toBe(false)
  })

  it('DROPS a malformed payload without clearing loading', () => {
    // `scheduler` is required — a payload missing it is not a valid snapshot.
    handleMessage({ type: 'scheduled_tasks', generatedAt: 'nope', tasks: [] } as never, ctx() as never)
    const s = store.getState()
    expect(s.scheduledTasks).toBeNull()
    expect(s.scheduledTasksLoading).toBe(true)
  })

  it('a malformed payload never blanks a GOOD held snapshot', () => {
    handleMessage(snapshot({ tasks: [mkTask()] }) as never, ctx() as never)
    const good = store.getState().scheduledTasks
    expect(good!.tasks).toHaveLength(1)
    handleMessage({ type: 'scheduled_tasks', tasks: 'not-an-array' } as never, ctx() as never)
    expect(store.getState().scheduledTasks).toBe(good)
  })

  it('acks a pending mutation when the snapshot echoes its requestId', () => {
    store.setState({ scheduledTaskPendingActions: { 'sched-action-1': { kind: 'pause', taskId: 't1', at: 1 } } })
    handleMessage(snapshot({ requestId: 'sched-action-1' }) as never, ctx() as never)
    const s = store.getState()
    expect(s.scheduledTaskPendingActions).toEqual({})
    expect(s.scheduledTaskActionResults['sched-action-1']!.ok).toBe(true)
  })

  it('leaves unrelated pending entries alone', () => {
    store.setState({
      scheduledTaskPendingActions: {
        'sched-action-1': { kind: 'pause', taskId: 't1', at: 1 },
        'sched-action-2': { kind: 'delete', taskId: 't2', at: 1 },
      },
    })
    handleMessage(snapshot({ requestId: 'sched-action-1' }) as never, ctx() as never)
    expect(Object.keys(store.getState().scheduledTaskPendingActions)).toEqual(['sched-action-2'])
  })

  it('a snapshot with no requestId does not touch the pending map', () => {
    store.setState({ scheduledTaskPendingActions: { 'sched-action-1': { kind: 'pause', taskId: 't1', at: 1 } } })
    handleMessage(snapshot() as never, ctx() as never)
    expect(Object.keys(store.getState().scheduledTaskPendingActions)).toEqual(['sched-action-1'])
  })
})

describe('scheduled-task failure branch (#6871)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  const CODES = [
    'SCHEDULED_TASK_ACTION_FAILED',
    'SCHEDULED_TASK_INVALID',
    'SCHEDULED_TASK_NOT_FOUND',
    'SCHEDULER_FORBIDDEN_NON_PRIMARY_CLIENT',
    'SCHEDULER_FORBIDDEN_BOUND_CLIENT',
    'SCHEDULER_GATE_FAILED',
    'SCHEDULER_GATE_ENV_FORCED',
    'SCHEDULER_REGISTRY_UNAVAILABLE',
  ]

  it('EVERY scheduler error code releases the pending entry and records the reason', () => {
    for (const code of CODES) {
      store = createMockStore({
        ...baseState(),
        scheduledTaskPendingActions: { 'sched-action-1': { kind: 'create', taskId: null, at: 1 } },
      })
      setStore(store)
      handleMessage(
        { type: 'session_error', code, message: `boom: ${code}`, requestId: 'sched-action-1' } as never,
        ctx() as never,
      )
      const s = store.getState()
      expect(s.scheduledTaskPendingActions, code).toEqual({})
      expect(s.scheduledTaskActionResults['sched-action-1']!.ok, code).toBe(false)
      expect(s.scheduledTaskActionResults['sched-action-1']!.error, code).toContain(code)
    }
  })

  it('clears a stuck loading flag when a READ is refused', () => {
    // A rejected read never produces the snapshot that would clear loading, so
    // the error path must — otherwise Refresh spins forever.
    handleMessage(
      { type: 'session_error', code: 'SCHEDULER_FORBIDDEN_BOUND_CLIENT', message: 'no', requestId: 'r-1' } as never,
      ctx() as never,
    )
    expect(store.getState().scheduledTasksLoading).toBe(false)
  })

  it('an unrelated error code does not clear scheduler pending state', () => {
    store.setState({ scheduledTaskPendingActions: { 'sched-action-1': { kind: 'create', taskId: null, at: 1 } } })
    handleMessage(
      { type: 'session_error', code: 'CONTAINER_ACTION_FAILED', message: 'x', requestId: 'sched-action-1' } as never,
      ctx() as never,
    )
    expect(Object.keys(store.getState().scheduledTaskPendingActions)).toEqual(['sched-action-1'])
  })
})
