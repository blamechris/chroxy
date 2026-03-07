/**
 * usePermissionNotification tests (#1114)
 *
 * Tests that native notifications fire for permission requests when the window is not focused.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePermissionNotification } from './usePermissionNotification'

// Mock Notification API
const mockNotification = vi.fn()
let originalNotification: typeof globalThis.Notification

beforeEach(() => {
  originalNotification = globalThis.Notification
  // @ts-expect-error — mock
  globalThis.Notification = mockNotification
  // @ts-expect-error — mock
  globalThis.Notification.permission = 'granted'
  globalThis.Notification.requestPermission = vi.fn().mockResolvedValue('granted')
  mockNotification.mockClear()
})

afterEach(() => {
  globalThis.Notification = originalNotification
})

describe('usePermissionNotification', () => {
  it('fires notification when document is hidden and permission request appears', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })

    renderHook(() =>
      usePermissionNotification([
        {
          id: 'perm-1',
          requestId: 'req-1',
          tool: 'Bash',
          description: 'Run: npm install',
          expiresAt: Date.now() + 60000,
          answered: undefined,
        },
      ])
    )

    expect(mockNotification).toHaveBeenCalledOnce()
    expect(mockNotification).toHaveBeenCalledWith(
      'Chroxy: Permission Requested',
      expect.objectContaining({
        body: 'Run: npm install',
      })
    )

    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  })

  it('does not fire notification when document is visible', () => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })

    renderHook(() =>
      usePermissionNotification([
        {
          id: 'perm-1',
          requestId: 'req-1',
          tool: 'Bash',
          description: 'Run: npm install',
          expiresAt: Date.now() + 60000,
          answered: undefined,
        },
      ])
    )

    expect(mockNotification).not.toHaveBeenCalled()
  })

  it('does not fire notification for already-answered prompts', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })

    renderHook(() =>
      usePermissionNotification([
        {
          id: 'perm-1',
          requestId: 'req-1',
          tool: 'Bash',
          description: 'Run: npm install',
          expiresAt: Date.now() + 60000,
          answered: 'allow',
        },
      ])
    )

    expect(mockNotification).not.toHaveBeenCalled()
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  })

  it('does not fire duplicate notification for the same request', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })

    const prompts = [
      {
        id: 'perm-1',
        requestId: 'req-1',
        tool: 'Bash',
        description: 'Run: npm install',
        expiresAt: Date.now() + 60000,
        answered: undefined,
      },
    ]

    const { rerender } = renderHook(
      ({ p }) => usePermissionNotification(p),
      { initialProps: { p: prompts } }
    )

    expect(mockNotification).toHaveBeenCalledOnce()

    // Re-render with same prompts
    rerender({ p: prompts })
    expect(mockNotification).toHaveBeenCalledOnce()

    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  })

  it('does not fire when Notification permission is denied', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    // @ts-expect-error — mock
    globalThis.Notification.permission = 'denied'

    renderHook(() =>
      usePermissionNotification([
        {
          id: 'perm-1',
          requestId: 'req-1',
          tool: 'Bash',
          description: 'Run: npm install',
          expiresAt: Date.now() + 60000,
          answered: undefined,
        },
      ])
    )

    expect(mockNotification).not.toHaveBeenCalled()
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  })
})
