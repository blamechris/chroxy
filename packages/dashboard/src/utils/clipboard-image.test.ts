/**
 * Tests for the Tauri clipboard-image bridge (#3748).
 *
 * Covers the three call shapes used by App.tsx's Ctrl+V handler:
 *   - non-Tauri / no invoke → null (web dashboard falls through to native paste)
 *   - Tauri returns null    → null ("no image on clipboard" toast path)
 *   - Tauri returns base64  → properly decoded PNG File
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('readClipboardImageAsFile', () => {
  const realWindow = globalThis.window

  beforeEach(() => {
    // Reset the module cache so getTauriInvoke re-reads window state.
    vi.resetModules()
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__
    if (typeof window !== 'undefined') {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    }
    Object.defineProperty(globalThis, 'window', { value: realWindow, configurable: true })
  })

  it('returns null outside Tauri', async () => {
    const { readClipboardImageAsFile } = await import('./clipboard-image')
    const result = await readClipboardImageAsFile()
    expect(result).toBeNull()
  })

  it('returns null when the Tauri command reports no image', async () => {
    const invoke = vi.fn().mockResolvedValue(null)
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke }

    const { readClipboardImageAsFile } = await import('./clipboard-image')
    const result = await readClipboardImageAsFile()

    expect(invoke).toHaveBeenCalledWith('read_clipboard_image')
    expect(result).toBeNull()
  })

  it('returns a PNG File when the Tauri command returns a base64 payload', async () => {
    // Tiny 1x1 transparent PNG header bytes — the actual payload shape
    // isn't checked, just that base64 decoding produces a File.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    let binary = ''
    for (const b of png) binary += String.fromCharCode(b)
    const base64 = btoa(binary)

    const invoke = vi.fn().mockResolvedValue(base64)
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke }

    const { readClipboardImageAsFile } = await import('./clipboard-image')
    const result = await readClipboardImageAsFile()

    expect(result).toBeInstanceOf(File)
    expect(result?.type).toBe('image/png')
    expect(result?.name).toMatch(/^clipboard-\d+\.png$/)
    expect(result?.size).toBe(png.length)
  })
})
