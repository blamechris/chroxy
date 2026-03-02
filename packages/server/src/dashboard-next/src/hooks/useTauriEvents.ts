/**
 * useTauriEvents — Listen for Tauri desktop events to sync server state.
 *
 * Events emitted by Rust (window.rs):
 * - server_ready:      { port, token, url }  — server is running
 * - server_stopped:    (no payload)           — server was stopped by user
 * - server_restarting: { attempt, max_attempts, backoff_secs } — auto-restart in progress
 * - server_error:      { message }            — server hit an error
 *
 * Only active when running inside Tauri (window.__TAURI__ exists).
 * In browser context, this hook is a no-op.
 */
import { useEffect } from 'react'
import { useConnectionStore } from '../store/connection'

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

function isTauri(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).__TAURI__
}

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

    return () => {
      unlisteners.forEach(p => p.then(fn => fn()).catch(() => {}))
    }
  }, [])
}
