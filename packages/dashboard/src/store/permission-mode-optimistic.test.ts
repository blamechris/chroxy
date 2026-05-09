/**
 * setPermissionMode / setModel optimistic-update tests (#3693)
 *
 * Verifies that the controlled <select> in ChatSettingsDropdown does not
 * snap back to the prior value while the WS round-trip to the server is in
 * flight — the store action mutates local state immediately so React's
 * next render reflects the new selection. The server's eventual
 * permission_mode_changed / model_changed broadcast re-confirms the same
 * value (idempotent).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createEmptySessionState } from './utils'

describe('#3693 — optimistic permission/model update', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('setPermissionMode updates active sessionState immediately', async () => {
    const { useConnectionStore } = await import('./connection')
    const sessionId = 'sess-1'
    const ss = createEmptySessionState()
    ss.permissionMode = 'approve'
    useConnectionStore.setState({
      activeSessionId: sessionId,
      sessionStates: { [sessionId]: ss },
      // No socket — action should still update local state.
      socket: null,
    })

    useConnectionStore.getState().setPermissionMode('plan')

    const after = useConnectionStore.getState().sessionStates[sessionId]!
    expect(after.permissionMode).toBe('plan')
  })

  it('setPermissionMode falls through to flat state when no active session', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({
      activeSessionId: null,
      sessionStates: {},
      permissionMode: 'approve',
      socket: null,
    })

    useConnectionStore.getState().setPermissionMode('acceptEdits')

    expect(useConnectionStore.getState().permissionMode).toBe('acceptEdits')
  })

  it('setPermissionMode prompts before switching to auto and skips on cancel', async () => {
    const { useConnectionStore } = await import('./connection')
    const sessionId = 'sess-2'
    const ss = createEmptySessionState()
    ss.permissionMode = 'approve'
    useConnectionStore.setState({
      activeSessionId: sessionId,
      sessionStates: { [sessionId]: ss },
      socket: null,
    })

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    useConnectionStore.getState().setPermissionMode('auto')
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(useConnectionStore.getState().sessionStates[sessionId]!.permissionMode).toBe('approve')

    confirmSpy.mockReturnValue(true)
    useConnectionStore.getState().setPermissionMode('auto')
    expect(useConnectionStore.getState().sessionStates[sessionId]!.permissionMode).toBe('auto')

    confirmSpy.mockRestore()
  })

  it('cancelling auto-confirm does not mutate previousPermissionMode (Shift+Tab toggle target)', async () => {
    const { useConnectionStore } = await import('./connection')
    const sessionId = 'sess-toggle'
    const ss = createEmptySessionState()
    ss.permissionMode = 'plan'
    useConnectionStore.setState({
      activeSessionId: sessionId,
      sessionStates: { [sessionId]: ss },
      // Top-level fields used by the toggle are tracked on the root store.
      permissionMode: 'plan',
      previousPermissionMode: 'approve',
      socket: null,
    })

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    useConnectionStore.getState().setPermissionMode('auto')
    expect(confirmSpy).toHaveBeenCalledOnce()

    // Mode unchanged (cancel was respected) AND previousPermissionMode untouched
    // so Shift+Tab still flips back to the real prior mode (`approve`), not to
    // `plan` itself which would no-op the toggle.
    expect(useConnectionStore.getState().sessionStates[sessionId]!.permissionMode).toBe('plan')
    expect(useConnectionStore.getState().previousPermissionMode).toBe('approve')

    confirmSpy.mockRestore()
  })

  it('setModel updates active sessionState immediately', async () => {
    const { useConnectionStore } = await import('./connection')
    const sessionId = 'sess-3'
    const ss = createEmptySessionState()
    ss.activeModel = null
    useConnectionStore.setState({
      activeSessionId: sessionId,
      sessionStates: { [sessionId]: ss },
      socket: null,
    })

    useConnectionStore.getState().setModel('claude-opus-4-7')

    const after = useConnectionStore.getState().sessionStates[sessionId]!
    expect(after.activeModel).toBe('claude-opus-4-7')
  })
})
