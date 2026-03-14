/**
 * useTauriIPC — hook for invoking Tauri IPC commands from the dashboard.
 *
 * Only works when running inside a Tauri webview. In browser context,
 * returns null for all queries and no-ops for commands.
 */

import { isTauri } from '../utils/tauri'

interface ServerInfo {
  port: number
  token: string | null
  status: string
  tunnelMode: string
  isRunning: boolean
}

/** Invoke a Tauri command (returns null if not in Tauri context) */
async function tauriInvoke<T>(cmd: string): Promise<T | null> {
  if (!isTauri()) return null
  try {
    // Use __TAURI_INTERNALS__ directly instead of importing @tauri-apps/api/core
    // to avoid bare module specifier resolution issues in non-Tauri browser contexts
    const w = window as Record<string, unknown>
    const internals = w.__TAURI_INTERNALS__ as { invoke?: (cmd: string) => Promise<T> } | undefined
    if (!internals?.invoke) return null
    return await internals.invoke(cmd)
  } catch {
    return null
  }
}

export async function getServerInfo(): Promise<ServerInfo | null> {
  return tauriInvoke<ServerInfo>('get_server_info')
}

export async function startServer(): Promise<void> {
  await tauriInvoke('start_server')
}

export async function stopServer(): Promise<void> {
  await tauriInvoke('stop_server')
}

export async function restartServer(): Promise<void> {
  await tauriInvoke('restart_server')
}
