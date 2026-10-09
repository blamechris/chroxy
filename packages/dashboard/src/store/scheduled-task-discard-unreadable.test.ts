/**
 * #7079 — the `discard_unreadable` sender. A stored entry the loader refused is
 * addressed by an opaque server-derived HANDLE, never by `taskId`: its own id may
 * be absent or over the wire cap. The sender must put `handle` on the wire, must
 * not put a taskId there, and must track the request like every other mutation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useConnectionStore } from './connection'
import { hasPendingSchedulerRequests, resetSchedulerRequestsForTest } from './scheduledTaskRequests'

type State = ReturnType<typeof useConnectionStore.getState>

describe('sendScheduledTaskAction(discard_unreadable) (#7079)', () => {
  let send: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetSchedulerRequestsForTest()
    send = vi.fn()
    useConnectionStore.setState({
      connectionPhase: 'connected',
      socket: { send, close: vi.fn(), readyState: 1, onclose: null } as unknown as WebSocket,
      scheduledTaskPendingActions: {},
      scheduledTaskActionResults: {},
    } as unknown as Partial<State>)
  })
  afterEach(() => { resetSchedulerRequestsForTest() })

  const sent = () => JSON.parse(send.mock.calls[0]![0] as string) as Record<string, unknown>

  it('puts the handle on the wire, with no taskId, and tracks the request', () => {
    const reqId = useConnectionStore.getState().sendScheduledTaskAction('discard_unreadable', { handle: '0123456789abcdef' })
    expect(reqId).toBeTruthy()
    expect(sent()).toMatchObject({ type: 'scheduled_task_action', action: 'discard_unreadable', handle: '0123456789abcdef', requestId: reqId })
    expect('taskId' in sent()).toBe(false)
    expect(useConnectionStore.getState().scheduledTaskPendingActions[reqId!]).toMatchObject({ kind: 'discard_unreadable' })
    expect(hasPendingSchedulerRequests(), 'armed, so a lost reply cannot spin forever').toBe(true)
  })

  it('refuses to send without a handle (nothing goes on the wire, nothing is tracked)', () => {
    expect(useConnectionStore.getState().sendScheduledTaskAction('discard_unreadable')).toBeNull()
    expect(useConnectionStore.getState().sendScheduledTaskAction('discard_unreadable', { handle: '' })).toBeNull()
    expect(useConnectionStore.getState().sendScheduledTaskAction('discard_unreadable', { taskId: 'abc' })).toBeNull()
    expect(send).not.toHaveBeenCalled()
    expect(useConnectionStore.getState().scheduledTaskPendingActions).toEqual({})
  })

  it('an over-cap handle is refused client-side rather than sent to be rejected without a requestId', () => {
    expect(useConnectionStore.getState().sendScheduledTaskAction('discard_unreadable', { handle: 'x'.repeat(65) })).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })
})
