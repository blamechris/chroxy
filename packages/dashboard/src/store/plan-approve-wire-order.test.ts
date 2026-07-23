/**
 * #6895 — client-level wire-ordering guard for the combined "approve plan +
 * auto-accept edits" action (follow-up from the #6893 / #6774 review).
 *
 * `packages/store-core/src/plan-approval.test.ts` pins the SHARED HELPER's
 * call order, but with `setPermissionMode`/`approve` replaced by plain
 * `vi.fn()` mocks — it proves `approvePlanWithAcceptEdits` invokes them in
 * the right order, but says nothing about what either call actually puts on
 * the wire, or when. The real guarantee (documented in `plan-approval.ts`
 * and `App.tsx`'s `handlePlanApproveAcceptEdits`) is that the dashboard's
 * REAL `setPermissionMode` action sends the `set_permission_mode` frame
 * SYNCHRONOUSLY before `sendInput('approve')` sends the `input` frame —
 * because the server drops a mid-turn permission-mode change once the
 * implementation turn has started (`PERMISSION_MODE_NOT_APPLIED`).
 *
 * This test wires the combined action to the store's REAL setPermissionMode
 * and sendInput (mirroring `App.tsx`'s `handlePlanApproveAcceptEdits`
 * exactly), with a socket stub that records frames in send order, and
 * asserts `set_permission_mode` lands strictly before the approve `input`
 * frame. If a future refactor of either action deferred its `wsSend` call
 * behind a microtask/await, this test — unlike the store-core helper test —
 * would catch the reordering, because it observes the actual wire, not just
 * the order the two functions were called in.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { approvePlanWithAcceptEdits } from '@chroxy/store-core'
import type { SessionState } from './types'

/** Healthy OPEN socket that records sent frames in order (mirrors #6308's liveSocket helper). */
function liveSocket(sent: Array<Record<string, unknown>>): WebSocket {
  return {
    send: vi.fn((raw: string) => {
      try {
        sent.push(JSON.parse(raw))
      } catch {
        /* noop */
      }
    }),
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

describe('#6895 — dashboard combined plan-approve+acceptEdits wire order', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('sends set_permission_mode(acceptEdits) strictly before the approve input frame', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: Array<Record<string, unknown>> = []
    const socket = liveSocket(sent)
    const sessionId = 'sess-plan-1'
    useConnectionStore.setState({
      activeSessionId: sessionId,
      sessions: [{ sessionId, name: sessionId, provider: 'claude-sdk' }],
      sessionStates: {
        [sessionId]: {
          ...createEmptySessionState(),
          permissionMode: 'plan',
          isPlanPending: true,
        } as unknown as SessionState,
      },
      permissionMode: 'plan',
      socket,
    } as never)

    const { setPermissionMode, sendInput } = useConnectionStore.getState()
    // Mirrors App.tsx's handlePlanApprove exactly, minus the UI-only scroll
    // signal (setScrollToBottomSignal), which has no wire effect.
    const approve = (): void => {
      sendInput('approve')
    }

    approvePlanWithAcceptEdits({ setPermissionMode, approve })

    // Strict order: exactly two frames, mode change first.
    expect(sent.map((f) => f.type)).toEqual(['set_permission_mode', 'input'])
    expect(sent[0]).toMatchObject({ type: 'set_permission_mode', mode: 'acceptEdits' })
    expect(sent[1]).toMatchObject({ type: 'input', data: 'approve' })
  })
})
