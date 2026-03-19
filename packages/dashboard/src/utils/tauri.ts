/**
 * Shared Tauri detection utility.
 *
 * Checks for __TAURI_INTERNALS__ (Tauri v2) first, falls back to
 * __TAURI__ (Tauri v1 / v2 JS API alias) for backwards compatibility.
 */
export function isTauri(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as Record<string, unknown>
  return '__TAURI_INTERNALS__' in w || '__TAURI__' in w
}
