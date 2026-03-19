/**
 * useTauriIPC — hook for invoking Tauri IPC commands from the dashboard.
 *
 * Only works when running inside a Tauri webview. In browser context,
 * returns null for all queries and no-ops for commands.
 */

import { getTauriInvoke } from '../utils/tauri-bridge'

interface ServerInfo {
  port: number
  token: string | null
  status: string
  tunnelMode: string
  isRunning: boolean
}

/** Invoke a Tauri command (returns null if not in Tauri context) */
async function tauriInvoke<T>(cmd: string): Promise<T | null> {
  const invoke = getTauriInvoke()
  if (!invoke) return null
  try {
    return await invoke(cmd) as T
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
