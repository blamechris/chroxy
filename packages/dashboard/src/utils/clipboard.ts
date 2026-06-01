/**
 * Clipboard helper (#4673).
 *
 * In Tauri 2 / WKWebView, `navigator.clipboard.writeText()` resolves
 * successfully but the OS clipboard is never actually written — so the
 * dashboard's "Copied!" check mark fires while the user's clipboard stays
 * empty. The Tauri shell exposes a real clipboard plugin via
 * `window.__TAURI__.clipboardManager.writeText` (enabled by
 * `withGlobalTauri: true` + `clipboard-manager:allow-write-text` capability),
 * which writes through to the native clipboard.
 *
 * This helper routes writes through the Tauri plugin first when running
 * under the desktop shell, and falls back to `navigator.clipboard` for the
 * browser-dashboard path. Returns `true` only when the write actually
 * succeeded, so callers can avoid flashing a false success indicator.
 */
import { isTauri } from './tauri'

type TauriClipboardManager = {
  writeText?: (text: string) => Promise<void>
}

function getTauriClipboardManager(): TauriClipboardManager | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  const tauri = w.__TAURI__ as Record<string, unknown> | undefined
  const cm = tauri?.clipboardManager as TauriClipboardManager | undefined
  return cm ?? null
}

/**
 * Writes `text` to the OS clipboard. Returns `true` on success, `false` when
 * the write failed (rejection, missing API, non-secure context, etc.).
 * Never throws.
 */
export async function writeText(text: string): Promise<boolean> {
  if (isTauri()) {
    const cm = getTauriClipboardManager()
    if (cm?.writeText) {
      try {
        await cm.writeText(text)
        return true
      } catch {
        // Tauri plugin rejected — fall through to navigator.clipboard so the
        // user still gets a chance to copy if the JS API happens to work in
        // this build.
      }
    }
  }

  // Browser-dashboard path (also the Tauri fallback if the plugin isn't
  // reachable for some reason). navigator.clipboard is undefined in
  // non-secure contexts and some embedded webviews — guard before .writeText.
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
