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
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
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
      infoNotifications: [],
      serverErrors: [],
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
    expect(listeners.has('navigate_console')).toBe(true)
  })

  it('navigate_console event switches viewMode to console (#1821)', () => {
    renderHook(() => useTauriEvents())

    useConnectionStore.setState({ viewMode: 'chat' as const })
    emit('navigate_console')
    expect(useConnectionStore.getState().viewMode).toBe('console')
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

  it('navigates to dashboard URL on server_ready when not on dashboard', () => {
    // Mock window.location as not being on dashboard
    const originalHref = window.location.href
    Object.defineProperty(window, 'location', {
      value: { href: 'tauri://localhost', protocol: 'http:', host: 'localhost' },
      writable: true,
      configurable: true,
    })

    renderHook(() => useTauriEvents())
    emit('server_ready', { port: 9222, token: 'abc', url: 'http://localhost:9222/dashboard?token=abc' })

    expect(window.location.href).toBe('http://localhost:9222/dashboard?token=abc')

    // Restore
    Object.defineProperty(window, 'location', {
      value: new URL(originalHref),
      writable: true,
      configurable: true,
    })
  })

  it('reconnects via store on server_ready when already on dashboard', () => {
    // Mock being on the dashboard page
    Object.defineProperty(window, 'location', {
      value: { href: 'http://localhost:9222/dashboard?token=abc', protocol: 'http:', host: 'localhost:9222' },
      writable: true,
      configurable: true,
    })

    const connectSpy = vi.fn()
    useConnectionStore.setState({ connect: connectSpy } as unknown as Record<string, unknown>)

    renderHook(() => useTauriEvents())
    emit('server_ready', { port: 9333, token: 'newtoken', url: 'http://localhost:9333/dashboard?token=newtoken' })

    expect(connectSpy).toHaveBeenCalledWith('ws://localhost:9333/ws', 'newtoken')

    // Restore location
    Object.defineProperty(window, 'location', {
      value: new URL('http://localhost'),
      writable: true,
      configurable: true,
    })
  })

  it('disconnects on server_stopped event', () => {
    const disconnectSpy = vi.fn()
    useConnectionStore.setState({ disconnect: disconnectSpy } as unknown as Record<string, unknown>)

    renderHook(() => useTauriEvents())
    emit('server_stopped')

    expect(disconnectSpy).toHaveBeenCalled()
  })

  it('uses addInfoNotification for update_available event (#1946)', () => {
    renderHook(() => useTauriEvents())

    // Emit the event — the handler calls store.addInfoNotification at runtime
    emit('update_available', 'v1.5.0')

    // update_available should add to infoNotifications, not serverErrors
    const state = useConnectionStore.getState()
    expect(state.infoNotifications.length).toBe(1)
    expect(state.infoNotifications[0]!.message).toContain('v1.5.0')
    expect(state.serverErrors).toHaveLength(0)
  })

  it('uses addInfoNotification for update_installed event (#1946)', () => {
    renderHook(() => useTauriEvents())

    emit('update_installed', 'v1.5.0')

    const state = useConnectionStore.getState()
    expect(state.infoNotifications.length).toBe(1)
    expect(state.infoNotifications[0]!.message).toContain('v1.5.0')
    expect(state.infoNotifications[0]!.message).toContain('installed')
  })

  it('clears serverStartupLogs on server_ready (#2094)', () => {
    useConnectionStore.setState({ serverStartupLogs: ['old log line'] })

    // Put location on dashboard so server_ready reconnects
    Object.defineProperty(window, 'location', {
      value: { href: 'http://localhost:9222/dashboard?token=abc', protocol: 'http:', host: 'localhost:9222' },
      writable: true,
      configurable: true,
    })
    const connectSpy = vi.fn()
    useConnectionStore.setState({ connect: connectSpy } as unknown as Record<string, unknown>)

    renderHook(() => useTauriEvents())
    emit('server_ready', { port: 9222, token: 'abc', url: 'http://localhost:9222/dashboard?token=abc' })

    expect(useConnectionStore.getState().serverStartupLogs).toBeNull()

    Object.defineProperty(window, 'location', {
      value: new URL('http://localhost'),
      writable: true,
      configurable: true,
    })
  })

  it('fetches server logs on server_error via Tauri IPC (#2094)', async () => {
    const mockInvoke = vi.fn().mockResolvedValue(['[ERROR] EADDRINUSE', '[INFO] Exit 1'])
    // __TAURI__ provides event.listen (bridge getTauriListen path)
    // __TAURI_INTERNALS__ provides invoke (bridge getTauriInvoke path)
    Object.defineProperty(window, '__TAURI__', {
      value: {
        event: { listen: vi.fn(async (event: string, handler: Handler) => {
          if (!listeners.has(event)) listeners.set(event, [])
          listeners.get(event)!.push(handler)
          return unlisten
        })},
      },
      writable: true,
      configurable: true,
    })
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: mockInvoke },
      writable: true,
      configurable: true,
    })

    renderHook(() => useTauriEvents())
    emit('server_error', { message: 'Node not found' })

    // Wait for async invoke
    await new Promise(r => setTimeout(r, 10))

    expect(mockInvoke).toHaveBeenCalledWith('get_server_logs')
    expect(useConnectionStore.getState().serverStartupLogs).toEqual(['[ERROR] EADDRINUSE', '[INFO] Exit 1'])
  })

  it('unlistens on unmount', async () => {
    const { unmount } = renderHook(() => useTauriEvents())
    unmount()

    // Give promises time to resolve
    await new Promise(r => setTimeout(r, 10))
    expect(unlisten).toHaveBeenCalled()
  })
})
