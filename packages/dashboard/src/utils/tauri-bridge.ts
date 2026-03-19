/**
 * tauri-bridge — canonical Tauri v2 access helpers.
 *
 * Tauri v2 exposes IPC via `window.__TAURI_INTERNALS__.invoke` and events via
 * `window.__TAURI__.event.listen`. All three dashboard hooks previously had
 * their own ad-hoc access paths, leading to a mixed `__TAURI_INTERNALS__` /
 * `__TAURI__` pattern that broke event listeners in pure Tauri v2. This module
 * is the single source of truth for both access paths.
 *
 * Usage:
 *   const invoke = getTauriInvoke()    // null when not in Tauri
 *   const listen  = getTauriListen()   // null when not in Tauri
 */
import { isTauri } from './tauri'

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
type UnlistenFn = () => void
type ListenFn = <T>(event: string, handler: (e: { payload: T }) => void) => Promise<UnlistenFn>

/**
 * Returns the Tauri v2 invoke function, or null outside of Tauri.
 *
 * Access path: `window.__TAURI_INTERNALS__.invoke` (Tauri v2 canonical).
 * No fallback to `__TAURI__.core.invoke` — callers must be running in Tauri v2.
 */
export function getTauriInvoke(): InvokeFn | null {
  if (!isTauri()) return null
  const w = window as unknown as Record<string, unknown>
  const internals = w.__TAURI_INTERNALS__ as { invoke?: InvokeFn } | undefined
  return internals?.invoke ?? null
}

/**
 * Returns the Tauri v2 event.listen function, or null outside of Tauri.
 *
 * Access path: `window.__TAURI__.event.listen` (Tauri v2 JS API layer).
 * This is the correct path for event subscriptions — __TAURI_INTERNALS__ does
 * not expose `listen` directly; the JS API wraps the internals for events.
 */
export function getTauriListen(): ListenFn | null {
  if (!isTauri()) return null
  const w = window as unknown as Record<string, unknown>
  const tauri = w.__TAURI__ as Record<string, unknown> | undefined
  const event = tauri?.event as { listen?: ListenFn } | undefined
  return event?.listen ?? null
}
