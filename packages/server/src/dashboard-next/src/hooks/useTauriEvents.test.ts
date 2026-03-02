import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTauriEvents } from './useTauriEvents'
import { useConnectionStore } from '../store/connection'

// Mock Tauri event system
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
}

function emit(event: string, payload?: unknown) {
  const handlers = listeners.get(event) || []
  handlers.forEach(h => h({ payload }))
}

describe('useTauriEvents', () => {
  beforeEach(() => {
    setupTauriMock()
    // Reset store state
    useConnectionStore.setState({
      connectionPhase: 'connected',
      connectionError: null,
    })
  })

  afterEach(() => {
    clearTauriMock()
  })

  it('registers listeners for all server events in Tauri context', () => {
    renderHook(() => useTauriEvents())

    expect(listeners.has('server_ready')).toBe(true)
    expect(listeners.has('server_stopped')).toBe(true)
    expect(listeners.has('server_restarting')).toBe(true)
    expect(listeners.has('server_error')).toBe(true)
  })

  it('does nothing when not in Tauri context', () => {
    clearTauriMock()
    renderHook(() => useTauriEvents())
    // No listeners should be registered since __TAURI__ is not available
    expect(listeners.size).toBe(0)
  })

  it('sets phase to server_restarting on server_restarting event', () => {
    renderHook(() => useTauriEvents())
    emit('server_restarting', { attempt: 1, max_attempts: 3, backoff_secs: 2 })

    expect(useConnectionStore.getState().connectionPhase).toBe('server_restarting')
  })

  it('sets connectionError on server_error event', () => {
    renderHook(() => useTauriEvents())
    emit('server_error', { message: 'Node not found' })

    expect(useConnectionStore.getState().connectionError).toBe('Node not found')
  })

  it('unlistens on unmount', async () => {
    const { unmount } = renderHook(() => useTauriEvents())
    unmount()

    // Give promises time to resolve
    await new Promise(r => setTimeout(r, 10))
    expect(unlisten).toHaveBeenCalled()
  })
})
