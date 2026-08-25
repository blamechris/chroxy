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
 *
 * ## Two harness rules this file has to hold
 *
 * **Unmount every render.** This package sets `globals: false` and its
 * `test-setup.ts` does not call `cleanup()`, so React Testing Library's
 * automatic teardown is NOT registered. A hook left mounted keeps its pending
 * probe promise alive; that promise then resolves during a LATER test, against
 * that test's freshly-installed mocks, and fails it perhaps one run in seven.
 * `afterEach(cleanup)` below plus explicit `unmount()` is what keeps this file
 * deterministic.
 *
 * **Settle before asserting "did not ask".** `waitFor(isPermissionGranted was
 * called)` is satisfied synchronously — the call happens in the mount effect,
 * long before the probe resolves and `probed` flips. Asserting non-request at
 * that point passes no matter what the gate does, which is the same
 * never-ran-and-called-it-success shape as the original bug. `renderSettled`
 * drains the microtask queue first, and each negative case is paired with a
 * positive control that DOES ask under the same harness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor, cleanup } from '@testing-library/react'
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
  return ctor as unknown as ReturnType<typeof vi.fn> & { requestPermission: ReturnType<typeof vi.fn>; permission: string }
}

/**
 * Render the hook and wait until the initial async probe has fully settled —
 * i.e. `probed` has flipped and the auto-request effect has had its chance to
 * run. Anything asserting that the hook did NOT ask must go through this, or
 * it asserts against a moment before the gate was ever reached.
 */
async function renderSettled(autoRequest: boolean) {
  const view = renderHook(() => useNotificationPermission({ autoRequest }))
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  return view
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
  cleanup()
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

    const { result } = await renderSettled(true)

    await waitFor(() => expect(api.requestPermission).toHaveBeenCalledOnce())
    await waitFor(() => expect(result.current.permission).toBe('granted'))
    // And the ask is recorded, so a reload does not re-prompt.
    expect(localStorage.getItem(ASKED_KEY)).toBe('true')
  })

  it('asks only once even as the hook re-renders', async () => {
    const api = installTauriBackend({ granted: false, requestResult: 'default' })

    const { rerender, unmount } = renderHook(
      ({ auto }) => useNotificationPermission({ autoRequest: auto }),
      { initialProps: { auto: true } },
    )
    await waitFor(() => expect(api.requestPermission).toHaveBeenCalledOnce())

    // Permission is STILL 'default' (user dismissed the dialog without
    // choosing) — the exact state that would otherwise loop forever.
    rerender({ auto: true })
    rerender({ auto: true })
    expect(api.requestPermission).toHaveBeenCalledOnce()
    unmount()
  })
})

describe('useNotificationPermission — positive controls on NOT asking', () => {
  it('does not ask before a session exists', async () => {
    const api = installTauriBackend({ granted: false })

    const view = await renderSettled(false)
    expect(api.isPermissionGranted).toHaveBeenCalled()
    expect(api.requestPermission).not.toHaveBeenCalled()
    view.unmount()

    // Positive control: same backend, same settled harness, autoRequest true —
    // proves the negative above is about `autoRequest` and not about the test
    // never reaching the gate.
    const view2 = await renderSettled(true)
    await waitFor(() => expect(api.requestPermission).toHaveBeenCalledOnce())
    view2.unmount()
  })

  it('does not ask when permission is already granted', async () => {
    const api = installTauriBackend({ granted: true })
    const { result, unmount } = await renderSettled(true)
    expect(result.current.permission).toBe('granted')
    expect(api.requestPermission).not.toHaveBeenCalled()
    unmount()
  })

  it('does not re-ask after a denial — no prompt spam', async () => {
    const api = installTauriBackend({ granted: false, requestResult: 'denied' })
    const { rerender, result, unmount } = renderHook(
      ({ auto }) => useNotificationPermission({ autoRequest: auto }),
      { initialProps: { auto: true } },
    )
    await waitFor(() => expect(result.current.permission).toBe('denied'))

    rerender({ auto: true })
    rerender({ auto: true })
    expect(api.requestPermission).toHaveBeenCalledOnce()
    unmount()
  })

  it('does not ask again on a later page load once this device has been asked', async () => {
    // Simulates a reload: the module cache is fresh, the permission is back to
    // 'default' (user dismissed), but localStorage remembers the ask.
    localStorage.setItem(ASKED_KEY, 'true')
    const api = installTauriBackend({ granted: false })

    const view = await renderSettled(true)
    expect(api.isPermissionGranted).toHaveBeenCalled()
    expect(api.requestPermission).not.toHaveBeenCalled()
    view.unmount()

    // Positive control: clear the flag and nothing else, and the very same
    // settled harness DOES ask. Without this, deleting the
    // loadNotificationPermissionAsked() gate would leave the test green.
    localStorage.clear()
    resetNativeNotificationStateForTests()
    const view2 = await renderSettled(true)
    await waitFor(() => expect(api.requestPermission).toHaveBeenCalledOnce())
    view2.unmount()
  })

  it('never auto-requests on the web backend — browsers require a user gesture', async () => {
    // Auto-requesting here does not just fail, it wastes the origin's one
    // chance to ask: Chrome rejects a gesture-less request outright.
    const ctor = installWebBackend('default')
    const { result, unmount } = await renderSettled(true)
    expect(result.current.backend).toBe('web')
    expect(ctor.requestPermission).not.toHaveBeenCalled()
    expect(result.current.permission).toBe('default')
    unmount()

    // Positive control: the same settled harness on the TAURI backend does
    // ask, so the negative above is about the backend, not about the harness.
    resetNativeNotificationStateForTests()
    const api = installTauriBackend({ granted: false })
    const view2 = await renderSettled(true)
    await waitFor(() => expect(api.requestPermission).toHaveBeenCalledOnce())
    view2.unmount()
  })
})

describe('useNotificationPermission — the explicit Settings request', () => {
  it('requests on the web backend when the user clicks, and reports the result', async () => {
    const ctor = installWebBackend('default')
    const { result, unmount } = await renderSettled(true)
    expect(result.current.backend).toBe('web')

    await act(async () => {
      await result.current.request()
    })

    expect(ctor.requestPermission).toHaveBeenCalledOnce()
    expect(result.current.permission).toBe('granted')
    unmount()
  })

  it('honours an explicit click even after this device was already asked', async () => {
    // The "asked" flag suppresses the AUTOMATIC prompt only. A user who
    // deliberately clicks Enable must be able to ask again.
    localStorage.setItem(ASKED_KEY, 'true')
    const ctor = installWebBackend('default')
    const { result, unmount } = await renderSettled(true)
    expect(result.current.backend).toBe('web')

    await act(async () => {
      await result.current.request()
    })
    expect(ctor.requestPermission).toHaveBeenCalledOnce()
    unmount()
  })
})

describe('useNotificationPermission — picks up an out-of-band grant', () => {
  it('re-probes when the window loses focus, so a grant made in site settings is seen', async () => {
    // The user grants in Chrome's site-settings panel while the tab is
    // focused, then switches away — which is exactly when notifications start
    // mattering. Probing only once per page load would leave React state at
    // 'default' for the life of the page and silently drop every notification.
    const ctor = installWebBackend('default')
    const { result, unmount } = await renderSettled(true)
    expect(result.current.permission).toBe('default')

    ctor.permission = 'granted'
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(result.current.permission).toBe('granted')
    unmount()
  })

  it('re-probes on focus and on visibilitychange too', async () => {
    const api = installTauriBackend({ granted: false })
    const { result, unmount } = await renderSettled(false)
    expect(result.current.permission).toBe('default')

    api.isPermissionGranted.mockResolvedValue(true)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(result.current.permission).toBe('granted')

    api.isPermissionGranted.mockResolvedValue(false)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    // A Tauri probe reporting "not granted" cannot distinguish default from
    // denied, so it settles on 'default' — never a stale 'granted'.
    expect(result.current.permission).toBe('default')
    unmount()
  })
})

describe('useNotificationPermission — no backend', () => {
  it("reports 'unsupported' without crashing or asking", async () => {
    const { result, unmount } = await renderSettled(true)
    expect(result.current.permission).toBe('unsupported')
    expect(result.current.backend).toBe('unsupported')
    unmount()
  })
})
