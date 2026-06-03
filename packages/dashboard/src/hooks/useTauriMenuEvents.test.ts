/**
 * useTauriMenuEvents — bridge tests for macOS menu-bar item dispatch
 * (#4695 / #4942).
 *
 * Mirrors useTauriEvents.test.ts mocking pattern: stub the Tauri v2 event
 * bridge (`window.__TAURI__.event.listen`) and assert the hook subscribes
 * to / dispatches the right event names.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTauriMenuEvents } from './useTauriMenuEvents'

type Handler = (event: { payload: unknown }) => void
let listeners: Map<string, Handler[]>
let unlisten: ReturnType<typeof vi.fn>

function setupTauriMock() {
  listeners = new Map()
  unlisten = vi.fn()
  const mockListen = vi.fn(async (event: string, handler: Handler) => {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event)!.push(handler)
    return unlisten
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

function emit(event: string, payload?: unknown) {
  const handlers = listeners.get(event) || []
  handlers.forEach(h => h({ payload }))
}

describe('useTauriMenuEvents (#4695 / #4942)', () => {
  beforeEach(() => {
    setupTauriMock()
  })

  afterEach(() => {
    clearTauriMock()
  })

  // The Rust app-menu emits `menu://<action>` events with the prefix
  // matching the `app_menu:<action>` id. This test pins the contract
  // both sides depend on (rename either side and it breaks).
  it('subscribes to menu://new-session when running in Tauri', () => {
    const onNewSession = vi.fn()
    renderHook(() => useTauriMenuEvents({ onNewSession }))
    expect(listeners.has('menu://new-session')).toBe(true)
  })

  it('invokes onNewSession when the menu event fires', () => {
    const onNewSession = vi.fn()
    renderHook(() => useTauriMenuEvents({ onNewSession }))
    expect(onNewSession).not.toHaveBeenCalled()
    emit('menu://new-session')
    expect(onNewSession).toHaveBeenCalledTimes(1)
  })

  it('is a no-op outside Tauri (web dashboard)', () => {
    clearTauriMock()
    const onNewSession = vi.fn()
    renderHook(() => useTauriMenuEvents({ onNewSession }))
    expect(listeners.size).toBe(0)
    // Trying to emit when no listener is registered must not call back.
    emit('menu://new-session')
    expect(onNewSession).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount (prevents stale-handler dispatch)', async () => {
    const onNewSession = vi.fn()
    const { unmount } = renderHook(() => useTauriMenuEvents({ onNewSession }))
    unmount()
    // The unlisten fn returned by mockListen must be invoked. The hook
    // awaits the listen() Promise so the unsubscribe is queued via .then;
    // flush microtasks before asserting.
    await Promise.resolve()
    await Promise.resolve()
    expect(unlisten).toHaveBeenCalled()
  })

  // #4942 — Additional submenu items added per the menu-bar layout
  // proposal. Each entry has a dedicated subscription / dispatch test
  // so a rename on either side surfaces here, not silently in
  // production.
  describe('#4942 — Shell / View / Tunnel / Window submenu dispatch', () => {
    // Every menu item that flows through this hook (i.e. dispatches to
    // a dashboard handler) is enumerated here. Items the Rust side
    // handles directly (Shell > Start/Stop/Restart/Open Console/Open in
    // Finder, Tunnel > Quick/Named/None, Help > Documentation/Report
    // Issue/Check for Updates) intentionally do NOT appear in this list
    // — they never reach the dashboard.
    const ENUMERATED_MENU_ROUTES: Array<{
      event: string
      prop:
        | 'onConnectToServer'
        | 'onDisconnect'
        | 'onToggleSidebar'
        | 'onTogglePlanMode'
        | 'onShowQr'
        | 'onReload'
        | 'onTunnelSettings'
        | 'onPreferences'
        | 'onBringAllToFront'
    }> = [
      { event: 'menu://connect-to-server', prop: 'onConnectToServer' },
      { event: 'menu://disconnect', prop: 'onDisconnect' },
      { event: 'menu://view-toggle-sidebar', prop: 'onToggleSidebar' },
      { event: 'menu://view-toggle-plan-mode', prop: 'onTogglePlanMode' },
      { event: 'menu://view-show-qr', prop: 'onShowQr' },
      { event: 'menu://view-reload', prop: 'onReload' },
      { event: 'menu://tunnel-settings', prop: 'onTunnelSettings' },
      { event: 'menu://preferences', prop: 'onPreferences' },
      { event: 'menu://window-bring-all-to-front', prop: 'onBringAllToFront' },
    ]

    for (const { event, prop } of ENUMERATED_MENU_ROUTES) {
      it(`subscribes to ${event} and dispatches to ${prop}`, () => {
        const onNewSession = vi.fn()
        const cb = vi.fn()
        renderHook(() =>
          useTauriMenuEvents({ onNewSession, [prop]: cb } as never),
        )
        expect(listeners.has(event)).toBe(true)
        emit(event)
        expect(cb).toHaveBeenCalledTimes(1)
        // The other menu items should not have fired the same callback.
        expect(onNewSession).not.toHaveBeenCalled()
      })
    }

    it('does not crash if an emitted event has no bound handler', () => {
      // Wire only onNewSession; emit other events anyway.
      const onNewSession = vi.fn()
      renderHook(() => useTauriMenuEvents({ onNewSession }))
      expect(() => {
        for (const { event } of ENUMERATED_MENU_ROUTES) {
          emit(event)
        }
      }).not.toThrow()
      expect(onNewSession).not.toHaveBeenCalled()
    })
  })
})
