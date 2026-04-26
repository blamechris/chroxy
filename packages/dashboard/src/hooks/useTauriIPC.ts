/**
 * useTauriIPC — hook for invoking Tauri IPC commands from the dashboard.
 *
 * Only works when running inside a Tauri webview. In browser context,
 * returns null for all queries and no-ops for commands.
 */

import { getTauriInvoke } from '../utils/tauri-bridge'
import { isTauri } from '../utils/tauri'

interface ServerInfo {
  port: number
  token: string | null
  status: string
  tunnelMode: string
  isRunning: boolean
}

/** Invoke a Tauri command (returns null if not in Tauri context) */
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const invoke = getTauriInvoke()
  if (!invoke) return null
  try {
    return await invoke(cmd, args) as T
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

export async function getTunnelMode(): Promise<string | null> {
  return tauriInvoke<string>('get_tunnel_mode')
}

/** Set tunnel mode. Throws on error (e.g., cloudflared not found). */
export async function setTunnelMode(mode: string): Promise<void> {
  const invoke = getTauriInvoke()
  if (!invoke) return
  await invoke('set_tunnel_mode', { mode })
}

/**
 * Read `allowAutoPermissionMode` from `~/.chroxy/config.json`.
 *
 * Returns:
 *   - `null` when not in a Tauri context (browser/dev) — caller should fall
 *     back to a sensible default and skip rendering Tauri-only UI.
 *   - `false` when the key is unset or the file doesn't exist.
 *   - `true` when explicitly enabled.
 *
 * Throws when invoke is unavailable inside Tauri (corrupted webview state)
 * or when the Rust side surfaces an IO/parse error — `null` is reserved for
 * "not in Tauri" so the SettingsPanel `.catch()` can show real errors
 * instead of silently presenting the wrong toggle state.
 */
export async function getAllowAutoPermissionMode(): Promise<boolean | null> {
  if (!isTauri()) return null
  const invoke = getTauriInvoke()
  if (!invoke) {
    throw new Error('Tauri invoke is unavailable')
  }
  return await invoke('get_allow_auto_permission_mode', undefined) as boolean
}

/**
 * Write `allowAutoPermissionMode` to `~/.chroxy/config.json`.
 *
 * Throws when invoke is unavailable inside Tauri (so the SettingsPanel can
 * roll back the optimistic toggle state and surface the failure) or when
 * the Rust side surfaces an IO/parse error. No-ops only outside Tauri.
 */
export async function setAllowAutoPermissionMode(value: boolean): Promise<void> {
  if (!isTauri()) return
  const invoke = getTauriInvoke()
  if (!invoke) {
    throw new Error('Tauri invoke is unavailable')
  }
  await invoke('set_allow_auto_permission_mode', { value })
}
