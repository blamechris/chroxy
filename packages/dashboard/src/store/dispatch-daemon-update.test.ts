/**
 * Daily-daemon update banner — store dispatch + actions (#8331).
 *
 *   - `daemon_update_status` REPLACES the held status; a malformed frame is
 *     dropped without blanking a good one.
 *   - `daemon_update_confirm_required` opens the confirm dialog ONLY for the
 *     request this client has in flight.
 *   - `daemon_update_action_result` releases that request (by requestId), closes
 *     the dialog on success, and says in words why a refusal happened.
 *   - `requestDaemonUpdateAction` sends the wire message, refuses a second request
 *     while one is in flight, and a watchdog releases a request nobody answers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'mock-salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}))

import {
  handleMessage, setStore, clearDeltaBuffers, clearPermissionSplits, stopHeartbeat, resetReplayFlags,
} from './message-handler'
import type { ConnectionState } from './types'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

const status = (over: Record<string, unknown> = {}) => ({
  type: 'daemon_update_status',
  running: A,
  pending: { target: B, from: A, subject: 'feat: x', commitsAhead: 1, queuedAt: '2026-10-07T12:00:00.000Z', reason: 'busy' },
  lastDeploy: null,
  postponedUntil: null,
  requestPending: false,
  ...over,
})

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s
      state = { ...state, ...patch }
    },
  }
}

describe('daemon update dispatch (#8331)', () => {
  let store: ReturnType<typeof createMockStore>
  const socket = { send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket, isReconnect: false, silent: false })
  const inFlight = { requestId: 'req-1', action: 'restart-now' as const, target: B }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers(); clearPermissionSplits()
    store = createMockStore({ connectionPhase: 'connected', daemonUpdate: null, daemonUpdateAction: null, daemonUpdateConfirm: null, daemonUpdateError: null })
    setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('stores a status and REPLACES it on the next one', () => {
    handleMessage(status() as never, ctx() as never)
    expect(store.getState().daemonUpdate?.pending?.target).toBe(B)
    handleMessage(status({ pending: null }) as never, ctx() as never)
    expect(store.getState().daemonUpdate?.pending).toBeNull()
  })

  it('drops a malformed status without blanking the held one', () => {
    handleMessage(status() as never, ctx() as never)
    handleMessage(status({ pending: { target: 'nope' } }) as never, ctx() as never)
    handleMessage({ type: 'daemon_update_status', running: 5 } as never, ctx() as never)
    expect(store.getState().daemonUpdate?.pending?.target).toBe(B)
  })

  it('confirm_required opens the dialog only for the request in flight', () => {
    const frame = { type: 'daemon_update_confirm_required', requestId: 'req-1', target: B, reasons: ['session "api" busy: turn'], sessions: [] }
    handleMessage(frame as never, ctx() as never)
    expect(store.getState().daemonUpdateConfirm, 'nothing in flight: ignored').toBeNull()

    store.setState({ daemonUpdateAction: inFlight })
    handleMessage({ ...frame, requestId: 'someone-else' } as never, ctx() as never)
    expect(store.getState().daemonUpdateConfirm, 'foreign requestId: ignored').toBeNull()

    handleMessage(frame as never, ctx() as never)
    expect(store.getState().daemonUpdateConfirm?.reasons).toEqual(['session "api" busy: turn'])
    expect(store.getState().daemonUpdateAction, 'released').toBeNull()
  })

  it('an ok result releases the request and closes the dialog', () => {
    store.setState({ daemonUpdateAction: inFlight, daemonUpdateConfirm: { type: 'daemon_update_confirm_required', requestId: 'req-1', target: B, reasons: [], sessions: [] } })
    handleMessage({ type: 'daemon_update_action_result', requestId: 'req-1', action: 'restart-now', ok: true, force: true } as never, ctx() as never)
    expect(store.getState().daemonUpdateAction).toBeNull()
    expect(store.getState().daemonUpdateConfirm).toBeNull()
    expect(store.getState().daemonUpdateError).toBeNull()
  })

  it('a refusal releases the request and says why; an unknown code falls back to the server message', () => {
    store.setState({ daemonUpdateAction: inFlight })
    handleMessage({ type: 'daemon_update_action_result', requestId: 'req-1', action: 'restart-now', ok: false, code: 'NOT_AUTHORIZED' } as never, ctx() as never)
    expect(store.getState().daemonUpdateAction).toBeNull()
    expect(store.getState().daemonUpdateError).toMatch(/primary connection/)

    store.setState({ daemonUpdateAction: inFlight, daemonUpdateError: null })
    handleMessage({ type: 'daemon_update_action_result', requestId: 'req-1', action: 'restart-now', ok: false, code: 'WEIRD', message: 'the disk is on fire' } as never, ctx() as never)
    expect(store.getState().daemonUpdateError).toBe('the disk is on fire')
  })

  it('a result for a request that is not in flight changes nothing', () => {
    store.setState({ daemonUpdateAction: inFlight })
    handleMessage({ type: 'daemon_update_action_result', requestId: 'old', action: 'postpone', ok: false, code: 'STALE_TARGET' } as never, ctx() as never)
    expect(store.getState().daemonUpdateAction).toEqual(inFlight)
    expect(store.getState().daemonUpdateError).toBeNull()
  })
})

describe('requestDaemonUpdateAction (#8331)', () => {
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { vi.useRealTimers() })

  async function seed(readyState: number = WebSocket.OPEN) {
    const { useConnectionStore } = await import('./connection')
    const sent: Record<string, unknown>[] = []
    const socket = {
      send: vi.fn((raw: string) => { try { sent.push(JSON.parse(raw)) } catch { /* noop */ } }),
      close: vi.fn(), readyState, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    } as unknown as WebSocket
    useConnectionStore.setState({ socket, daemonUpdateAction: null, daemonUpdateError: 'old' })
    return { useConnectionStore, sent }
  }

  it('sends the action with a requestId, tracks it, and clears the old error', async () => {
    const { useConnectionStore, sent } = await seed()
    expect(useConnectionStore.getState().requestDaemonUpdateAction('restart-now', B)).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'daemon_update_action', action: 'restart-now', target: B })
    expect(typeof sent[0]!.requestId).toBe('string')
    expect('confirmBusy' in sent[0]!).toBe(false)
    expect(useConnectionStore.getState().daemonUpdateAction?.requestId).toBe(sent[0]!.requestId)
    expect(useConnectionStore.getState().daemonUpdateError).toBeNull()
  })

  it('only the confirm path sends confirmBusy', async () => {
    const { useConnectionStore, sent } = await seed()
    useConnectionStore.getState().requestDaemonUpdateAction('restart-now', B, { confirmBusy: true })
    expect(sent[0]!.confirmBusy).toBe(true)
  })

  it('refuses a second request while one is in flight, and a closed socket', async () => {
    const { useConnectionStore, sent } = await seed()
    expect(useConnectionStore.getState().requestDaemonUpdateAction('postpone', B)).toBe(true)
    expect(useConnectionStore.getState().requestDaemonUpdateAction('restart-now', B)).toBe(false)
    expect(sent).toHaveLength(1)
    const closed = await seed(WebSocket.CLOSED)
    expect(closed.useConnectionStore.getState().requestDaemonUpdateAction('postpone', B)).toBe(false)
    expect(closed.sent).toHaveLength(0)
  })

  it('the watchdog releases a request nobody answers, with a message', async () => {
    vi.useFakeTimers()
    const { useConnectionStore } = await seed()
    useConnectionStore.getState().requestDaemonUpdateAction('postpone', B)
    vi.advanceTimersByTime(14_000)
    expect(useConnectionStore.getState().daemonUpdateAction).not.toBeNull()
    vi.advanceTimersByTime(2_000)
    expect(useConnectionStore.getState().daemonUpdateAction).toBeNull()
    expect(useConnectionStore.getState().daemonUpdateError).toMatch(/did not answer/)
  })

  it('cancel and clear-error only touch their own field', async () => {
    const { useConnectionStore } = await seed()
    useConnectionStore.setState({ daemonUpdateConfirm: { type: 'daemon_update_confirm_required', requestId: 'r', target: B, reasons: [], sessions: [] } })
    useConnectionStore.getState().cancelDaemonUpdateConfirm()
    expect(useConnectionStore.getState().daemonUpdateConfirm).toBeNull()
    expect(useConnectionStore.getState().daemonUpdateError).toBe('old')
    useConnectionStore.getState().clearDaemonUpdateError()
    expect(useConnectionStore.getState().daemonUpdateError).toBeNull()
  })

  it('the queued update dies with the connection: disconnect, forgetSession and _resetSessionMemory each clear it', async () => {
    const { useConnectionStore } = await seed()
    const dirty = () => useConnectionStore.setState({
      daemonUpdate: { type: 'daemon_update_status', running: A, pending: null, lastDeploy: null, postponedUntil: null, requestPending: false },
      daemonUpdateAction: { requestId: 'r', action: 'postpone', target: B },
      daemonUpdateConfirm: { type: 'daemon_update_confirm_required', requestId: 'r', target: B, reasons: [], sessions: [] },
      daemonUpdateError: 'from server A',
    })
    for (const action of ['disconnect', 'forgetSession', '_resetSessionMemory'] as const) {
      dirty()
      useConnectionStore.getState()[action]()
      const s = useConnectionStore.getState()
      expect([action, s.daemonUpdate, s.daemonUpdateAction, s.daemonUpdateConfirm, s.daemonUpdateError]).toEqual([action, null, null, null, null])
    }
  })
})
