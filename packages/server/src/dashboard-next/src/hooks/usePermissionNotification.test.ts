/**
 * usePermissionNotification tests (#1114, #1565, #1566)
 *
 * Tests that native notifications fire for permission requests when the window is not focused.
 * Uses document.hasFocus() (#1566) and prunes stale notifiedRef entries (#1565).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePermissionNotification } from './usePermissionNotification'

// Mock Notification API
const mockNotification = vi.fn()
let originalNotification: typeof globalThis.Notification
let originalHasFocus: typeof document.hasFocus

beforeEach(() => {
  originalNotification = globalThis.Notification
  originalHasFocus = document.hasFocus
  // @ts-expect-error — mock
  globalThis.Notification = mockNotification
  // @ts-expect-error — mock
  globalThis.Notification.permission = 'granted'
  globalThis.Notification.requestPermission = vi.fn().mockResolvedValue('granted')
  mockNotification.mockClear()
  // Default: window not focused (notifications should fire)
  document.hasFocus = () => false
})

afterEach(() => {
  globalThis.Notification = originalNotification
  document.hasFocus = originalHasFocus
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
    renderHook(() => usePermissionNotification([makePrompt()]))

    expect(mockNotification).toHaveBeenCalledOnce()
    expect(mockNotification).toHaveBeenCalledWith(
      'Chroxy: Permission Requested',
      expect.objectContaining({ body: 'Run: npm install' })
    )
  })

  it('does not fire notification when window is focused', () => {
    document.hasFocus = () => true

    renderHook(() => usePermissionNotification([makePrompt()]))

    expect(mockNotification).not.toHaveBeenCalled()
  })

  it('does not fire notification for already-answered prompts', () => {
    renderHook(() => usePermissionNotification([makePrompt({ answered: 'allow' })]))

    expect(mockNotification).not.toHaveBeenCalled()
  })

  it('does not fire notification for expired prompts', () => {
    renderHook(() => usePermissionNotification([makePrompt({ expiresAt: Date.now() - 1000 })]))

    expect(mockNotification).not.toHaveBeenCalled()
  })

  it('does not fire duplicate notification for the same request', () => {
    const { rerender } = renderHook(
      ({ p }) => usePermissionNotification(p),
      { initialProps: { p: [makePrompt()] } }
    )

    expect(mockNotification).toHaveBeenCalledOnce()

    // New array instance with same requestId — effect reruns but should not re-notify
    rerender({ p: [makePrompt()] })
    expect(mockNotification).toHaveBeenCalledOnce()
  })

  it('does not fire when Notification permission is denied', () => {
    // @ts-expect-error — mock
    globalThis.Notification.permission = 'denied'

    renderHook(() => usePermissionNotification([makePrompt()]))

    expect(mockNotification).not.toHaveBeenCalled()
  })

  it('prunes stale IDs when prompts are removed, allowing re-notification', () => {
    const prompt1 = makePrompt({ requestId: 'req-1' })

    const { rerender } = renderHook(
      ({ p }) => usePermissionNotification(p),
      { initialProps: { p: [prompt1] } }
    )

    expect(mockNotification).toHaveBeenCalledOnce()

    // Prompt removed (answered/expired) — stale ID should be pruned
    rerender({ p: [] })

    // Same requestId reappears (e.g. re-requested) — should fire again
    rerender({ p: [makePrompt({ requestId: 'req-1' })] })
    expect(mockNotification).toHaveBeenCalledTimes(2)
  })
})
