/**
 * Read the OS clipboard image via the Tauri `read_clipboard_image` command
 * (#3748). The Rust side returns a base64-encoded PNG, or `null` when the
 * clipboard does not currently hold an image — callers should surface the
 * null case as a "No image on clipboard" hint rather than a hard error.
 */
import { getTauriInvoke } from './tauri-bridge'

const FILENAME_PREFIX = 'clipboard-'

export async function readClipboardImageAsFile(): Promise<File | null> {
  const invoke = getTauriInvoke()
  if (!invoke) return null

  const base64 = (await invoke('read_clipboard_image')) as string | null
  if (!base64) return null

  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  const blob = new Blob([bytes], { type: 'image/png' })
  return new File([blob], `${FILENAME_PREFIX}${Date.now()}.png`, { type: 'image/png' })
}
