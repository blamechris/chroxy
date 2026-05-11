/**
 * Read the OS clipboard image via the Tauri `read_clipboard_image` command
 * (#3748). The Rust side returns a base64-encoded PNG, which we pass through
 * unchanged so the caller can feed it straight into `processBase64Image`
 * without a base64 → File → base64 round-trip (#3796 review).
 *
 * Returns `null` when the clipboard does not currently hold an image or
 * when we are not running inside Tauri — callers should surface that case
 * as a "No image on clipboard" hint rather than a hard error.
 */
import { getTauriInvoke } from './tauri-bridge'

export interface ClipboardImage {
  base64: string
  mediaType: 'image/png'
  name: string
}

export async function readClipboardImage(): Promise<ClipboardImage | null> {
  const invoke = getTauriInvoke()
  if (!invoke) return null

  const base64 = (await invoke('read_clipboard_image')) as string | null
  if (!base64) return null

  return {
    base64,
    mediaType: 'image/png',
    name: `clipboard-${Date.now()}.png`,
  }
}
