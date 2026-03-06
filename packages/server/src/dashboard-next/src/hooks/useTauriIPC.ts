/**
 * useTauriIPC — hook for invoking Tauri IPC commands from the dashboard.
 *
 * Only works when running inside a Tauri webview. In browser context,
 * returns null for all queries and no-ops for commands.
 */

interface ServerInfo {
  port: number
  token: string | null
  status: string
  tunnelMode: string
  isRunning: boolean
}

/** Check if running inside Tauri webview */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Invoke a Tauri command (returns null if not in Tauri context) */
async function tauriInvoke<T>(cmd: string): Promise<T | null> {
  if (!isTauri()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<T>(cmd)
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
