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
    // Access Tauri invoke via window globals instead of importing @tauri-apps/api/core
    // to avoid bare module specifier resolution issues in non-Tauri browser contexts.
    // Matches the pattern used in useTauriEvents.ts — try __TAURI__.core.invoke first,
    // then __TAURI__.invoke as fallback.
    const w = window as unknown as Record<string, unknown>
    const tauri = w.__TAURI__ as Record<string, unknown> | undefined
    if (!tauri) return null
    const core = tauri.core as Record<string, unknown> | undefined
    const invokeFn = (core?.invoke ?? tauri.invoke) as ((cmd: string) => Promise<T>) | undefined
    if (!invokeFn) return null
    return await invokeFn(cmd)
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
