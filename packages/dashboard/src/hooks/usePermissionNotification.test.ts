/**
 * usePermissionNotification tests (#1114, #1565, #1566, #7351)
 *
 * Tests that native notifications fire for permission requests when the window
 * is not focused. Uses document.hasFocus() (#1566) and prunes stale notifiedRef
 * entries (#1565).
 *
 * ## #7351 — what changed here, and why
 *
 * This suite used to open with:
 *
 *     globalThis.Notification = mockNotification
 *     globalThis.Notification.permission = 'granted'
 *     globalThis.Notification.requestPermission = vi.fn()...
 *
 * Those three lines were the bug's camouflage. Production never granted the
 * permission — nothing in chroxy called `requestPermission()` at all — so the
 * hook's `permission === 'granted'` guard returned on every real invocation
 * and `new Notification` was unreachable. The suite passed continuously
 * because it hand-established the precondition, and stubbed the very function
 * whose absence was the defect. Success and never-running were the same
 * observable outcome.
 *
 * They are gone. The permission is now an explicit INPUT to the hook, supplied
 * by `useNotificationPermission` (which is what actually asks the user, and is
 * tested separately), and dispatch goes through `sendNativeNotification` —
 * whose own permission gate is covered in `utils/native-notifications.test.ts`.
 * Nothing here can pass by pretending a permission was granted, because
 * nothing here touches the global permission at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePermissionNotification } from './usePermissionNotification'
import { sendNativeNotification } from '../utils/native-notifications'

vi.mock('../utils/native-notifications', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/native-notifications')>()
  return { ...actual, sendNativeNotification: vi.fn(() => true) }
})

const mockSend = vi.mocked(sendNativeNotification)
let originalHasFocus: typeof document.hasFocus

beforeEach(() => {
  originalHasFocus = document.hasFocus
  mockSend.mockClear()
  // Default: window not focused (notifications should fire)
  document.hasFocus = () => false
  return () => {
    document.hasFocus = originalHasFocus
  }
})

function makePrompt(overrides: Partial<{ id: string; requestId: string; tool: string; description: string; expiresAt: number; answered: string | undefined }> = {}) {
  return {
    id: 'perm-1',
    requestId: 'req-1',
    tool: 'Bash',
    description: 'Run: npm install',
    expiresAt: Date.now() + 60000,
    answered: undefined,
    ...overrides,
  }
}

describe('usePermissionNotification', () => {
  it('fires notification when window is not focused and permission request appears', () => {
    renderHook(() => usePermissionNotification([makePrompt()], 'granted'))

    expect(mockSend).toHaveBeenCalledOnce()
    expect(mockSend).toHaveBeenCalledWith(
      'Chroxy: Permission Requested',
      expect.objectContaining({ body: 'Run: npm install' })
    )
  })

  it('does not fire notification when window is focused', () => {
    document.hasFocus = () => true

    renderHook(() => usePermissionNotification([makePrompt()], 'granted'))

    expect(mockSend).not.toHaveBeenCalled()
  })

  it('does not fire notification for already-answered prompts', () => {
    renderHook(() => usePermissionNotification([makePrompt({ answered: 'allow' })], 'granted'))

    expect(mockSend).not.toHaveBeenCalled()
  })

  it('does not fire notification for expired prompts', () => {
    renderHook(() => usePermissionNotification([makePrompt({ expiresAt: Date.now() - 1000 })], 'granted'))

    expect(mockSend).not.toHaveBeenCalled()
  })

  it('does not fire duplicate notification for the same request', () => {
    const { rerender } = renderHook(
      ({ p }) => usePermissionNotification(p, 'granted'),
      { initialProps: { p: [makePrompt()] } }
    )

    expect(mockSend).toHaveBeenCalledOnce()

    // New array instance with same requestId — effect reruns but should not re-notify
    rerender({ p: [makePrompt()] })
    expect(mockSend).toHaveBeenCalledOnce()
  })

  it('does not fire when permission is still default — the real production state', () => {
    // #7351: this is the state every browser profile is actually in until
    // something calls requestPermission(). The pre-fix suite could not express
    // this case, because its setup hand-set the permission to 'granted'.
    renderHook(() => usePermissionNotification([makePrompt()], 'default'))

    expect(mockSend).not.toHaveBeenCalled()
  })

  it('does not fire when Notification permission is denied', () => {
    renderHook(() => usePermissionNotification([makePrompt()], 'denied'))

    expect(mockSend).not.toHaveBeenCalled()
  })

  it('does not fire when no notification backend exists at all', () => {
    // Dashboard opened over the LAN at an http:// address: not a secure
    // context, so the browser exposes no Notification API to gate on.
    renderHook(() => usePermissionNotification([makePrompt()], 'unsupported'))

    expect(mockSend).not.toHaveBeenCalled()
  })

  it('fires for a still-pending prompt as soon as permission is granted mid-session', () => {
    // #7351: the grant arrives from useNotificationPermission, not from a
    // change to `prompts`. Passing the permission as a dependency is what
    // makes the pending prompt notify immediately instead of waiting for the
    // next unrelated prompt-list change.
    const prompts = [makePrompt()]
    const { rerender } = renderHook(
      ({ perm }) => usePermissionNotification(prompts, perm),
      { initialProps: { perm: 'default' as const } }
    )
    expect(mockSend).not.toHaveBeenCalled()

    rerender({ perm: 'granted' as unknown as 'default' })
    expect(mockSend).toHaveBeenCalledOnce()
  })

  it('prunes stale IDs when prompts are removed, allowing re-notification', () => {
    const prompt1 = makePrompt({ requestId: 'req-1' })

    const { rerender } = renderHook(
      ({ p }) => usePermissionNotification(p, 'granted'),
      { initialProps: { p: [prompt1] } }
    )

    expect(mockSend).toHaveBeenCalledOnce()

    // Prompt removed (answered/expired) — stale ID should be pruned
    rerender({ p: [] })

    // Same requestId reappears (e.g. re-requested) — should fire again
    rerender({ p: [makePrompt({ requestId: 'req-1' })] })
    expect(mockSend).toHaveBeenCalledTimes(2)
  })
})
