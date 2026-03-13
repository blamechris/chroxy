/**
 * useTauriEvents — Listen for Tauri desktop events to sync server state.
 *
 * Events emitted by Rust (window.rs):
 * - server_ready:      { port, token, url }  — server is running
 * - server_stopped:    (no payload)           — server was stopped by user
 * - server_restarting: { attempt, max_attempts, backoff_secs } — auto-restart in progress
 * - server_error:      { message }            — server hit an error
 *
 * Only active when running inside Tauri (detected via shared isTauri utility).
 * In browser context, this hook is a no-op.
 */
import { useEffect } from 'react'
import { useConnectionStore } from '../store/connection'
import { isTauri } from '../utils/tauri'

interface TauriEvent<T> {
  payload: T
}

interface ServerReadyPayload {
  port: number
  token: string
  url: string
}

interface ServerRestartingPayload {
  attempt: number
  max_attempts: number
  backoff_secs: number
}

interface ServerErrorPayload {
  message: string
}

type UnlistenFn = () => void

function getTauriEvent(): { listen: <T>(event: string, handler: (e: TauriEvent<T>) => void) => Promise<UnlistenFn> } | null {
  if (!isTauri()) return null
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__ as Record<string, unknown>
  return tauri.event as { listen: <T>(event: string, handler: (e: TauriEvent<T>) => void) => Promise<UnlistenFn> }
}

export function useTauriEvents() {
  useEffect(() => {
    const tauriEvent = getTauriEvent()
    if (!tauriEvent) return

    const unlisteners: Promise<UnlistenFn>[] = []

    // Server ready — navigate to dashboard URL (or reconnect if already there)
    unlisteners.push(
      tauriEvent.listen<ServerReadyPayload>('server_ready', (event) => {
        const { url, token, port } = event.payload
        // If we're already on the dashboard, reconnect via the store
        if (window.location.href.includes('/dashboard')) {
          // Derive WS URL from the event payload so reconnect works even if the port changed
          const wsUrl = `ws://localhost:${port}/ws`
          useConnectionStore.getState().connect(wsUrl, token)
        } else {
          // Still on loading page — navigate to dashboard
          window.location.href = url
        }
      })
    )

    // Server stopped — disconnect cleanly (prevents reconnect attempts)
    unlisteners.push(
      tauriEvent.listen('server_stopped', () => {
        useConnectionStore.getState().disconnect()
      })
    )

    // Server restarting — set phase to server_restarting
    unlisteners.push(
      tauriEvent.listen<ServerRestartingPayload>('server_restarting', () => {
        useConnectionStore.setState({ connectionPhase: 'server_restarting' })
      })
    )

    // Server error — disconnect and set error
    unlisteners.push(
      tauriEvent.listen<ServerErrorPayload>('server_error', (event) => {
        useConnectionStore.getState().disconnect()
        useConnectionStore.setState({ connectionError: event.payload.message })
      })
    )

    // Navigate to console — triggered by tray menu "Console" item
    unlisteners.push(
      tauriEvent.listen('navigate_console', () => {
        useConnectionStore.getState().setViewMode('console')
      })
    )

    // Update available — show info toast notification (not error)
    unlisteners.push(
      tauriEvent.listen<string>('update_available', (event) => {
        const store = useConnectionStore.getState()
        store.addInfoNotification(`Chroxy ${event.payload} is available.`)
      })
    )

    // Update installed — show info toast with restart prompt
    unlisteners.push(
      tauriEvent.listen<string>('update_installed', (event) => {
        const store = useConnectionStore.getState()
        store.addInfoNotification(`Chroxy ${event.payload} installed. Restart to apply.`)
      })
    )

    return () => {
      unlisteners.forEach(p => p.then(fn => fn()).catch(() => {}))
    }
  }, [])
}
