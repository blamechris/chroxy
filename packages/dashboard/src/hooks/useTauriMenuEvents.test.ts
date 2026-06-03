/**
 * useTauriMenuEvents — bridge tests for macOS menu-bar item dispatch (#4695).
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

describe('useTauriMenuEvents (#4695)', () => {
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
})
