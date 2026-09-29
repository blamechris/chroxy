/**
 * useTauriMenuWiring — plan-mode-toggle capability gating tests
 * (#8084 / #8087 review, Critical #2).
 *
 * `menuTogglePlanMode` (wired to the Tauri desktop menu's "Toggle Plan
 * Mode" item, `Shift+Alt+P` accelerator) used to carry its own copy of the
 * enter/leave logic `useShortcutDispatch.ts`'s `session.togglePlanMode`
 * case has. The shortcut got gated on the active provider's `planMode`
 * capability in #8084; this menu handler did not, so the native menu bar
 * could still force a `claude-tui` session (`planMode: false`) into plan
 * mode. Both now call the shared `resolveTogglePlanModeTarget` — these
 * tests pin the menu path the same way `useShortcutDispatch.test.ts` pins
 * the keyboard-shortcut path.
 *
 * Uses the real Tauri v2 event-bridge mock (mirrors
 * useTauriMenuEvents.test.ts) rather than mocking `useTauriMenuEvents`
 * itself, so the test exercises the actual `menu://view-toggle-plan-mode`
 * event → `useTauriMenuWiring` → `resolveTogglePlanModeTarget` →
 * `setPermissionMode` chain end to end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { useTauriMenuWiring, type UseTauriMenuWiringArgs } from './useTauriMenuWiring'
import { useConnectionStore } from '../store/connection'

type Handler = (event: { payload: unknown }) => void
let listeners: Map<string, Handler[]>

function setupTauriMock() {
  listeners = new Map()
  const mockListen = vi.fn(async (event: string, handler: Handler) => {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event)!.push(handler)
    return vi.fn()
  })
  Object.defineProperty(window, '__TAURI__', {
    value: { event: { listen: mockListen } },
    writable: true,
    configurable: true,
  })
}

function clearTauriMock() {
  delete (window as unknown as Record<string, unknown>).__TAURI__
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
}

function emitTogglePlanMode() {
  const handlers = listeners.get('menu://view-toggle-plan-mode') || []
  handlers.forEach(h => h({ payload: undefined }))
}

function makeProps(overrides: Partial<UseTauriMenuWiringArgs> = {}): UseTauriMenuWiringArgs {
  return {
    onNewSession: vi.fn(),
    onShowQr: vi.fn(),
    openSettings: vi.fn(),
    setSidebarOpen: vi.fn(),
    setPermissionMode: vi.fn(),
    ...overrides,
  }
}

describe('useTauriMenuWiring — plan-mode toggle capability gating (#8084 / #8087 review)', () => {
  beforeEach(() => {
    setupTauriMock()
  })

  afterEach(() => {
    clearTauriMock()
    cleanup()
    vi.restoreAllMocks()
  })

  it('is a no-op when planModeSupported is false and not already in plan (claude-tui-shaped session)', () => {
    const props = makeProps({ planModeSupported: false })
    const getStateSpy = vi.spyOn(useConnectionStore, 'getState').mockReturnValue({
      permissionMode: 'approve',
      previousPermissionMode: null,
    } as never)
    renderHook(() => useTauriMenuWiring(props))
    emitTogglePlanMode()
    expect(props.setPermissionMode).not.toHaveBeenCalled()
    getStateSpy.mockRestore()
  })

  it('still enters plan mode when planModeSupported is true (positive control)', () => {
    const props = makeProps({ planModeSupported: true })
    const getStateSpy = vi.spyOn(useConnectionStore, 'getState').mockReturnValue({
      permissionMode: 'approve',
      previousPermissionMode: null,
    } as never)
    renderHook(() => useTauriMenuWiring(props))
    emitTogglePlanMode()
    expect(props.setPermissionMode).toHaveBeenCalledWith('plan')
    getStateSpy.mockRestore()
  })

  it('still enters plan mode when planModeSupported is omitted (missing = capable, existing call sites unaffected)', () => {
    const props = makeProps()
    const getStateSpy = vi.spyOn(useConnectionStore, 'getState').mockReturnValue({
      permissionMode: 'approve',
      previousPermissionMode: null,
    } as never)
    renderHook(() => useTauriMenuWiring(props))
    emitTogglePlanMode()
    expect(props.setPermissionMode).toHaveBeenCalledWith('plan')
    getStateSpy.mockRestore()
  })

  it('still allows LEAVING plan mode from the menu even when planModeSupported is false', () => {
    const props = makeProps({ planModeSupported: false })
    const getStateSpy = vi.spyOn(useConnectionStore, 'getState').mockReturnValue({
      permissionMode: 'plan',
      previousPermissionMode: 'acceptEdits',
    } as never)
    renderHook(() => useTauriMenuWiring(props))
    emitTogglePlanMode()
    expect(props.setPermissionMode).toHaveBeenCalledWith('acceptEdits')
    getStateSpy.mockRestore()
  })

  it('leaving plan mode falls back to "approve" when no previous mode was stored', () => {
    const props = makeProps({ planModeSupported: false })
    const getStateSpy = vi.spyOn(useConnectionStore, 'getState').mockReturnValue({
      permissionMode: 'plan',
      previousPermissionMode: null,
    } as never)
    renderHook(() => useTauriMenuWiring(props))
    emitTogglePlanMode()
    expect(props.setPermissionMode).toHaveBeenCalledWith('approve')
    getStateSpy.mockRestore()
  })
})
