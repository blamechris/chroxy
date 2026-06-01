import { describe, it, expect, vi, afterEach } from 'vitest'
import { writeText } from './clipboard'

function setTauri(clipboardManager: unknown) {
  Object.defineProperty(window, '__TAURI__', {
    value: { clipboardManager },
    writable: true,
    configurable: true,
  })
}

function clearTauri() {
  delete (window as unknown as Record<string, unknown>).__TAURI__
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
}

function setNavigatorClipboard(clipboard: unknown) {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: clipboard,
    writable: true,
    configurable: true,
  })
}

function clearNavigatorClipboard() {
  // Some jsdom builds make `clipboard` non-configurable once defined; setting
  // to undefined gets us the same observable "not present" branch.
  try {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true,
    })
  } catch {
    // ignore — afterEach resets via setNavigatorClipboard in each test
  }
}

describe('writeText() clipboard helper (#4673)', () => {
  afterEach(() => {
    clearTauri()
    clearNavigatorClipboard()
    vi.restoreAllMocks()
  })

  it('returns true when the Tauri plugin write succeeds', async () => {
    const tauriWrite = vi.fn().mockResolvedValue(undefined)
    setTauri({ writeText: tauriWrite })

    const result = await writeText('hello')

    expect(result).toBe(true)
    expect(tauriWrite).toHaveBeenCalledWith('hello')
  })

  it('returns false when the Tauri plugin write rejects and no navigator clipboard fallback exists', async () => {
    const tauriWrite = vi.fn().mockRejectedValue(new Error('plugin denied'))
    setTauri({ writeText: tauriWrite })
    clearNavigatorClipboard()

    const result = await writeText('hello')

    expect(result).toBe(false)
    expect(tauriWrite).toHaveBeenCalledWith('hello')
  })

  it('falls back to navigator.clipboard.writeText when not in Tauri', async () => {
    clearTauri()
    const navWrite = vi.fn().mockResolvedValue(undefined)
    setNavigatorClipboard({ writeText: navWrite })

    const result = await writeText('hello')

    expect(result).toBe(true)
    expect(navWrite).toHaveBeenCalledWith('hello')
  })

  it('returns false when navigator.clipboard is undefined (non-secure context)', async () => {
    clearTauri()
    setNavigatorClipboard(undefined)

    const result = await writeText('hello')

    expect(result).toBe(false)
  })

  it('returns false when navigator.clipboard.writeText rejects', async () => {
    clearTauri()
    const navWrite = vi.fn().mockRejectedValue(new DOMException('NotAllowedError'))
    setNavigatorClipboard({ writeText: navWrite })

    const result = await writeText('hello')

    expect(result).toBe(false)
    expect(navWrite).toHaveBeenCalledWith('hello')
  })

  it('prefers the Tauri plugin path even when navigator.clipboard is present', async () => {
    const tauriWrite = vi.fn().mockResolvedValue(undefined)
    const navWrite = vi.fn().mockResolvedValue(undefined)
    setTauri({ writeText: tauriWrite })
    setNavigatorClipboard({ writeText: navWrite })

    const result = await writeText('hello')

    expect(result).toBe(true)
    expect(tauriWrite).toHaveBeenCalledWith('hello')
    expect(navWrite).not.toHaveBeenCalled()
  })
})
