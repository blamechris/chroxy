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

export interface PrivateNoItAllStatus {
  enabled: boolean
  available: boolean
  repoPath: string | null
  reason: string | null
}

export interface PrivateNoItAllLaunchResult {
  appPath: string
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
 * Read whether the embedded server is set to bind all interfaces (LAN) or
 * loopback-only (#5356). Returns `null` outside Tauri. `false` (loopback) is
 * the safe default.
 */
export async function getExposeOnLan(): Promise<boolean | null> {
  return tauriInvoke<boolean>('get_expose_on_lan')
}

/**
 * Toggle LAN exposure for the embedded server (#5356). Persisted; takes effect
 * on the next server restart (bind address is fixed at spawn). Throws on error.
 */
export async function setExposeOnLan(expose: boolean): Promise<void> {
  if (!isTauri()) return
  const invoke = getTauriInvoke()
  if (!invoke) {
    throw new Error('Tauri invoke is unavailable')
  }
  await invoke('set_expose_on_lan', { expose })
}

/**
 * Read the configured global summon hotkey accelerator (#5294).
 *
 * Returns `null` outside Tauri, or when no hotkey is set (the Rust side returns
 * `None` for unset/blank). A non-empty string is the active accelerator.
 */
export async function getSummonHotkey(): Promise<string | null> {
  return tauriInvoke<string | null>('get_summon_hotkey')
}

/**
 * Set or clear the global summon hotkey and re-register it immediately (#5294).
 * Pass `null` or an empty string to clear it. No-ops outside Tauri.
 *
 * Throws when invoke is unavailable inside Tauri, or when the Rust side rejects
 * the accelerator (malformed / OS-conflicting) — so the SettingsPanel can show
 * the failure instead of silently leaving the old binding in place.
 */
export async function setSummonHotkey(accelerator: string | null): Promise<void> {
  if (!isTauri()) return
  const invoke = getTauriInvoke()
  if (!invoke) {
    throw new Error('Tauri invoke is unavailable')
  }
  await invoke('set_summon_hotkey', { accelerator })
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

/**
 * Probe the private no-it-all dev launcher. The Rust side only reports
 * `available=true` for local debug builds with a sibling no-it-all checkout.
 */
export async function getPrivateNoItAllStatus(): Promise<PrivateNoItAllStatus | null> {
  if (!isTauri()) return null
  const invoke = getTauriInvoke()
  if (!invoke) {
    throw new Error('Tauri invoke is unavailable')
  }
  return await invoke('private_no_it_all_status', undefined) as PrivateNoItAllStatus
}

/**
 * Build and open the local no-it-all dev app. Throws on unavailable/release
 * builds or when the sibling checkout build fails.
 */
export async function launchPrivateNoItAll(): Promise<PrivateNoItAllLaunchResult | null> {
  if (!isTauri()) return null
  const invoke = getTauriInvoke()
  if (!invoke) {
    throw new Error('Tauri invoke is unavailable')
  }
  return await invoke('launch_private_no_it_all', undefined) as PrivateNoItAllLaunchResult
}

/**
 * Reveal a path in the OS file manager (Finder / Explorer / xdg-open) via
 * the `reveal_in_finder` Tauri command (#4045). Used by the sidebar
 * right-click "Open in Finder" item.
 *
 * Tauri-only — returns silently in the browser dashboard so callers can wrap
 * `isTauri()` for visibility gating without an extra try/catch. Throws when
 * the Rust side errors (path missing, spawn failed) so the caller can show
 * a toast.
 */
export async function revealInFinder(path: string): Promise<void> {
  if (!isTauri()) return
  const invoke = getTauriInvoke()
  if (!invoke) {
    throw new Error('Tauri invoke is unavailable')
  }
  await invoke('reveal_in_finder', { path })
}
