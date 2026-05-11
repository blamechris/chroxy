/**
 * Tests for the Tauri clipboard-image bridge (#3748, #3796).
 *
 * Covers the three call shapes used by App.tsx's Ctrl+V handler:
 *   - non-Tauri / no invoke → null (web dashboard falls through to native paste)
 *   - Tauri returns null    → null ("no image on clipboard" toast path)
 *   - Tauri returns base64  → pass-through with PNG media type + timestamp name
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('readClipboardImage', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    if (typeof window !== 'undefined') {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    }
  })

  it('returns null outside Tauri', async () => {
    const { readClipboardImage } = await import('./clipboard-image')
    expect(await readClipboardImage()).toBeNull()
  })

  it('returns null when the Tauri command reports no image', async () => {
    const invoke = vi.fn().mockResolvedValue(null)
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke }

    const { readClipboardImage } = await import('./clipboard-image')
    const result = await readClipboardImage()

    expect(invoke).toHaveBeenCalledWith('read_clipboard_image')
    expect(result).toBeNull()
  })

  it('passes the base64 payload through with PNG media type and a timestamped name', async () => {
    const base64 = 'iVBORw0KGgo='
    const invoke = vi.fn().mockResolvedValue(base64)
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke }

    const { readClipboardImage } = await import('./clipboard-image')
    const result = await readClipboardImage()

    expect(result).not.toBeNull()
    expect(result?.base64).toBe(base64)
    expect(result?.mediaType).toBe('image/png')
    expect(result?.name).toMatch(/^clipboard-\d+\.png$/)
  })
})
