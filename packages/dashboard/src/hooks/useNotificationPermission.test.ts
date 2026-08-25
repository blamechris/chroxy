/**
 * useNotificationPermission tests (#7351).
 *
 * These are the tests that would have caught the original bug. The defect was
 * that `Notification.requestPermission()` was never called ANYWHERE in chroxy,
 * so `Notification.permission` stayed `'default'` forever and the dashboard's
 * only `new Notification` call was unreachable. The pre-existing suite could
 * not catch it, because it hand-set `Notification.permission = 'granted'` in
 * `beforeEach` — establishing by fiat the precondition production never met.
 *
 * So the central case below starts from `'default'` — the real production
 * state — and asserts that the app ASKS. Everything else here is a positive
 * control on not-asking, because a fix that prompts too eagerly is its own bug
 * (browsers permanently block origins that spam the notification prompt).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useNotificationPermission } from './useNotificationPermission'
import { resetNativeNotificationStateForTests } from '../utils/native-notifications'

const originalNotification = Object.getOwnPropertyDescriptor(globalThis, 'Notification')
const originalTauri = Object.getOwnPropertyDescriptor(window, '__TAURI__')

function installTauriBackend(opts: { granted?: boolean; requestResult?: string } = {}) {
  const api = {
    isPermissionGranted: vi.fn().mockResolvedValue(opts.granted ?? false),
    requestPermission: vi.fn().mockResolvedValue(opts.requestResult ?? 'granted'),
    sendNotification: vi.fn(),
  }
  // @ts-expect-error — test double
  window.__TAURI__ = { notification: api }
  return api
}

function installWebBackend(permission: 'default' | 'granted' | 'denied') {
  const ctor = vi.fn()
  // @ts-expect-error — test double
  ctor.permission = permission
  // @ts-expect-error — test double
  ctor.requestPermission = vi.fn().mockResolvedValue('granted')
  // @ts-expect-error — test double
  globalThis.Notification = ctor
  return ctor as unknown as ReturnType<typeof vi.fn> & { requestPermission: ReturnType<typeof vi.fn> }
}

const ASKED_KEY = 'chroxy_persist_notification_permission_asked'

beforeEach(() => {
  resetNativeNotificationStateForTests()
  localStorage.clear()
  // @ts-expect-error — clearing the global
  delete globalThis.Notification
  // @ts-expect-error — clearing the global
  delete window.__TAURI__
})

afterEach(() => {
  if (originalNotification) Object.defineProperty(globalThis, 'Notification', originalNotification)
  // @ts-expect-error — clearing the global
  else delete globalThis.Notification
  if (originalTauri) Object.defineProperty(window, '__TAURI__', originalTauri)
  // @ts-expect-error — clearing the global
  else delete window.__TAURI__
  localStorage.clear()
})

describe('useNotificationPermission — the request that never happened', () => {
  it('REQUESTS permission when the state is the production default and a session exists', async () => {
    // The regression test for #7351. Before the fix nothing in chroxy called
    // requestPermission() at all; with permission stuck at 'default' the whole
    // notification feature was unreachable. Asking here is the entire point.
    const api = installTauriBackend({ granted: false, requestResult: 'granted' })

    const { result } = renderHook(() => useNotificationPermission({ autoRequest: true }))

    await waitFor(() => expect(api.requestPermission).toHaveBeenCalledOnce())
    await waitFor(() => expect(result.current.permission).toBe('granted'))
    // And the ask is recorded, so a reload does not re-prompt.
    expect(localStorage.getItem(ASKED_KEY)).toBe('true')
  })

  it('asks only once even as the hook re-renders', async () => {
    const api = installTauriBackend({ granted: false, requestResult: 'default' })

    const { rerender } = renderHook(
      ({ auto }) => useNotificationPermission({ autoRequest: auto }),
      { initialProps: { auto: true } },
    )
    await waitFor(() => expect(api.requestPermission).toHaveBeenCalledOnce())

    // Permission is STILL 'default' (user dismissed the dialog without
    // choosing) — the exact state that would otherwise loop forever.
    rerender({ auto: true })
    rerender({ auto: true })
    expect(api.requestPermission).toHaveBeenCalledOnce()
  })
})

describe('useNotificationPermission — positive controls on NOT asking', () => {
  it('does not ask before a session exists', async () => {
    const api = installTauriBackend({ granted: false })
    renderHook(() => useNotificationPermission({ autoRequest: false }))
    await waitFor(() => expect(api.isPermissionGranted).toHaveBeenCalled())
    expect(api.requestPermission).not.toHaveBeenCalled()
  })

  it('does not ask when permission is already granted', async () => {
    const api = installTauriBackend({ granted: true })
    const { result } = renderHook(() => useNotificationPermission({ autoRequest: true }))
    await waitFor(() => expect(result.current.permission).toBe('granted'))
    expect(api.requestPermission).not.toHaveBeenCalled()
  })

  it('does not re-ask after a denial — no prompt spam', async () => {
    const api = installTauriBackend({ granted: false, requestResult: 'denied' })
    const { rerender, result } = renderHook(
      ({ auto }) => useNotificationPermission({ autoRequest: auto }),
      { initialProps: { auto: true } },
    )
    await waitFor(() => expect(result.current.permission).toBe('denied'))

    rerender({ auto: true })
    rerender({ auto: true })
    expect(api.requestPermission).toHaveBeenCalledOnce()
  })

  it('does not ask again on a later page load once this device has been asked', async () => {
    // Simulates a reload: the module cache is fresh, the permission is back to
    // 'default' (user dismissed), but localStorage remembers the ask.
    localStorage.setItem(ASKED_KEY, 'true')
    const api = installTauriBackend({ granted: false })

    renderHook(() => useNotificationPermission({ autoRequest: true }))
    await waitFor(() => expect(api.isPermissionGranted).toHaveBeenCalled())
    expect(api.requestPermission).not.toHaveBeenCalled()
  })

  it('never auto-requests on the web backend — browsers require a user gesture', async () => {
    // Auto-requesting here does not just fail, it wastes the origin's one
    // chance to ask: Chrome rejects a gesture-less request outright.
    const ctor = installWebBackend('default')
    const { result } = renderHook(() => useNotificationPermission({ autoRequest: true }))
    await waitFor(() => expect(result.current.backend).toBe('web'))
    expect(ctor.requestPermission).not.toHaveBeenCalled()
    expect(result.current.permission).toBe('default')
  })
})

describe('useNotificationPermission — the explicit Settings request', () => {
  it('requests on the web backend when the user clicks, and reports the result', async () => {
    const ctor = installWebBackend('default')
    const { result } = renderHook(() => useNotificationPermission({ autoRequest: true }))
    await waitFor(() => expect(result.current.backend).toBe('web'))

    await act(async () => {
      await result.current.request()
    })

    expect(ctor.requestPermission).toHaveBeenCalledOnce()
    expect(result.current.permission).toBe('granted')
  })

  it('honours an explicit click even after this device was already asked', async () => {
    // The "asked" flag suppresses the AUTOMATIC prompt only. A user who
    // deliberately clicks Enable must be able to ask again.
    localStorage.setItem(ASKED_KEY, 'true')
    const ctor = installWebBackend('default')
    const { result } = renderHook(() => useNotificationPermission({ autoRequest: true }))
    await waitFor(() => expect(result.current.backend).toBe('web'))

    await act(async () => {
      await result.current.request()
    })
    expect(ctor.requestPermission).toHaveBeenCalledOnce()
  })
})

describe('useNotificationPermission — no backend', () => {
  it("reports 'unsupported' without crashing or asking", async () => {
    const { result } = renderHook(() => useNotificationPermission({ autoRequest: true }))
    await waitFor(() => expect(result.current.permission).toBe('unsupported'))
    expect(result.current.backend).toBe('unsupported')
  })
})
