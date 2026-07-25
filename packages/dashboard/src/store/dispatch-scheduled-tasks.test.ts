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
import { armSchedulerRequest, hasPendingSchedulerRequests, resetSchedulerRequestsForTest } from './scheduledTaskRequests'
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
    scheduledTasks: null, scheduledTasksLoading: true, scheduledTasksError: null,
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

  it('DROPS a malformed payload but CLEARS loading and surfaces why (#6871 review)', () => {
    // `scheduler` is required — a payload missing it is not a valid snapshot.
    //
    // This used to leave `scheduledTasksLoading` true, which BRICKED the tab: the
    // flag gates both recovery paths (Refresh is disabled while loading, and the
    // Control Room survey effect bails on it), so the panel sat on "Loading…"
    // with no error until a full page reload. Reachable from a merely
    // store-legal task, because the store enforces no length caps and the wire
    // schema does. The payload is still dropped; the READ is now released.
    handleMessage({ type: 'scheduled_tasks', generatedAt: 'nope', tasks: [] } as never, ctx() as never)
    const s = store.getState()
    expect(s.scheduledTasks).toBeNull()
    expect(s.scheduledTasksLoading).toBe(false)
    expect(s.scheduledTasksError).toMatch(/could not read/i)
  })

  it('a wire-ILLEGAL task (over-cap name) releases the read instead of hanging', () => {
    // The exact shape the server now clamps: store-legal, wire-illegal.
    handleMessage(snapshot({ tasks: [mkTask({ name: 'x'.repeat(300) })] }) as never, ctx() as never)
    const s = store.getState()
    expect(s.scheduledTasksLoading).toBe(false)
    expect(s.scheduledTasksError).not.toBeNull()
  })

  it('a good snapshot clears a previously-surfaced read error', () => {
    store.setState({ scheduledTasksError: 'stale failure' })
    handleMessage(snapshot() as never, ctx() as never)
    expect(store.getState().scheduledTasksError).toBeNull()
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

  it('clears the spinner and surfaces the reason when a read is refused with NO requestId (#6871 review S1)', () => {
    // The original S1 bug, pinned at the dispatch layer. The read sent no
    // requestId, so the refusal echoed `requestId: null` and this branch —
    // which required a string — did nothing at all: Refresh stayed disabled
    // reading "Refreshing…" forever with no error shown. The read now mints a
    // requestId, but the branch must not DEPEND on correlation to release a
    // refusal that is unambiguously about this surface.
    handleMessage(
      { type: 'session_error', code: 'SCHEDULER_FORBIDDEN_BOUND_CLIENT', message: 'bound clients may not read the registry', requestId: null } as never,
      ctx() as never,
    )
    const s = store.getState()
    expect(s.scheduledTasksLoading).toBe(false)
    expect(s.scheduledTasksError).toMatch(/bound clients may not read/)
  })

  it('a refusal that DOES correlate to a mutation records it per-requestId, not as a read error', () => {
    store.setState({ scheduledTaskPendingActions: { 'sched-action-1': { kind: 'create', taskId: null, at: 1 } } })
    handleMessage(
      { type: 'session_error', code: 'SCHEDULED_TASK_INVALID', message: 'cadence.expression: invalid cron', requestId: 'sched-action-1' } as never,
      ctx() as never,
    )
    const s = store.getState()
    expect(s.scheduledTaskActionResults['sched-action-1']!.error).toContain('invalid cron')
    // Not misfiled as a read failure — the form shows it inline.
    expect(s.scheduledTasksError).toBeNull()
  })

  // #6871 review round 2 (BLOCKING 1) — a `scheduled_tasks` snapshot is ALSO the
  // mutation ack, so an UNPARSEABLE one is the ack for whatever mutation is in
  // flight. The branch that handles it used to only settle the watchdog, which
  // disarmed the sole mechanism that would ever release the request while leaving
  // the pending entry in place — converting a bounded 30s stall into a permanent
  // "Working…" / "Saving…" button. It must fail the request instead.
  it('an UNPARSEABLE ack releases the in-flight mutation with a terminal failure', () => {
    store.setState({ scheduledTaskPendingActions: { 'sched-action-9': { kind: 'pause', taskId: 't1', at: 1 } } })
    // A snapshot echoing the mutation's requestId but failing safeParse (no
    // `scheduler` block) — i.e. the ack arrived and was unreadable.
    handleMessage({ type: 'scheduled_tasks', requestId: 'sched-action-9', generatedAt: 'nope', tasks: [] } as never, ctx() as never)
    const s = store.getState()
    // The pending entry must be GONE, not merely un-watchdogged.
    expect(s.scheduledTaskPendingActions).toEqual({})
    // ...and it must carry a verdict, so the button renders an error rather than
    // spinning with no explanation.
    expect(s.scheduledTaskActionResults['sched-action-9']!.ok).toBe(false)
    expect(s.scheduledTaskActionResults['sched-action-9']!.error).toMatch(/could not read/i)
    // Honest about the uncertainty: the mutation may have applied server-side —
    // the ack is precisely the thing that could not be read.
    expect(s.scheduledTaskActionResults['sched-action-9']!.error).toMatch(/may or may not have been applied/i)
  })

  it('an unparseable ack for an UNKNOWN requestId still releases the read', () => {
    store.setState({ scheduledTaskPendingActions: { 'sched-action-1': { kind: 'pause', taskId: 't1', at: 1 } } })
    handleMessage({ type: 'scheduled_tasks', requestId: 'not-tracked', tasks: 'bad' } as never, ctx() as never)
    const s = store.getState()
    expect(s.scheduledTasksLoading).toBe(false)
    expect(s.scheduledTasksError).not.toBeNull()
    // An unrelated in-flight mutation is left for its own watchdog, not swept.
    expect(Object.keys(s.scheduledTaskPendingActions)).toEqual(['sched-action-1'])
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

/**
 * #6871 review round 2 (BLOCKING 2) — `INVALID_MESSAGE` is a GLOBAL frame.
 *
 * ws-server emits it for ANY client message failing `ClientMessageSchema`, with
 * `correlationId` + `details` but never a `requestId`. An earlier version of this
 * delta called `failAllSchedulerRequests()` on it, which meant an unrelated
 * surface's rejection (e.g. an over-cap `add_mcp_server` name) marked an in-flight
 * scheduled-task mutation as REJECTED. Worse, because the success path only records
 * a result while the requestId is still pending, the genuine ack that followed
 * recorded nothing — so the modal never closed, the operator retried, and a
 * DUPLICATE unattended scheduled task was created. Reporting failure for work that
 * actually happened is the inverse of what this panel exists to prevent.
 */
describe('INVALID_MESSAGE must not be attributed to the scheduler (#6871 review round 2)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  // The request must be ARMED IN THE REGISTRY, not merely present in
  // `scheduledTaskPendingActions` — `failAllSchedulerRequests` iterates the
  // registry and early-returns on an empty map, so seeding only the store map
  // makes these assertions VACUOUS (they passed against the defective source).
  // This mirrors what connection.ts's senders actually do: arm the watchdog with
  // an onFail that releases the pending entry.
  function armMutation(requestId: string) {
    store.setState({ scheduledTaskPendingActions: { [requestId]: { kind: 'create', taskId: null, at: 1 } } })
    armSchedulerRequest(requestId, (reason) => {
      const pending = { ...store.getState().scheduledTaskPendingActions }
      if (!(requestId in pending)) return
      delete pending[requestId]
      store.setState({
        scheduledTaskPendingActions: pending,
        scheduledTaskActionResults: {
          ...store.getState().scheduledTaskActionResults,
          [requestId]: { ok: false, error: reason, at: Date.now() },
        },
      })
    })
  }

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    resetSchedulerRequestsForTest()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => {
    stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags()
    resetSchedulerRequestsForTest()
  })

  it('leaves an in-flight scheduler mutation untouched', () => {
    armMutation('sched-action-1')
    // A rejection caused by a DIFFERENT surface's message entirely.
    handleMessage(
      { type: 'error', code: 'INVALID_MESSAGE', correlationId: 'c-1', details: 'String must contain at most 64 character(s)' } as never,
      ctx() as never,
    )
    const s = store.getState()
    // Still pending — the daemon never answered OUR request, so the watchdog owns
    // it. Nothing here can know the frame was about the scheduler.
    expect(Object.keys(s.scheduledTaskPendingActions)).toEqual(['sched-action-1'])
    expect(s.scheduledTaskActionResults['sched-action-1']).toBeUndefined()
    // Still armed, so the bounded fallback is intact rather than consumed.
    expect(hasPendingSchedulerRequests()).toBe(true)
  })

  it('does not surface another surface\'s zod message as a scheduler READ error', () => {
    // Arms the READ the way connection.ts's requestScheduledTasks does (its onFail
    // writes scheduledTasksError), so this pins the read-path half of the
    // mis-attribution: an over-cap add_mcp_server name must not appear as the
    // scheduled-tasks panel's own read failure.
    store.setState({ scheduledTasksLoading: true })
    armSchedulerRequest('sched-read-1', (reason) => {
      store.setState({ scheduledTasksLoading: false, scheduledTasksError: reason })
    })
    handleMessage(
      { type: 'error', code: 'INVALID_MESSAGE', correlationId: 'c-1', details: 'String must contain at most 64 character(s)' } as never,
      ctx() as never,
    )
    // Null is the whole assertion — the defective version wrote the foreign zod
    // text here. (Deliberately not a `not.toMatch(/64 character/)` follow-up:
    // toMatch throws on null, so it would fail on the CORRECT behaviour.)
    expect(store.getState().scheduledTasksError).toBeNull()
  })

  it('the genuine ack still succeeds after an unrelated INVALID_MESSAGE', () => {
    // The duplicate-task path, pinned end to end: the mutation must still be able
    // to report SUCCESS, so the modal closes and the operator does not retry.
    armMutation('sched-action-1')
    handleMessage(
      { type: 'error', code: 'INVALID_MESSAGE', correlationId: 'c-1', details: 'unrelated' } as never,
      ctx() as never,
    )
    handleMessage(snapshot({ requestId: 'sched-action-1' }) as never, ctx() as never)
    const s = store.getState()
    expect(s.scheduledTaskActionResults['sched-action-1']!.ok).toBe(true)
    expect(s.scheduledTaskPendingActions).toEqual({})
  })
})
