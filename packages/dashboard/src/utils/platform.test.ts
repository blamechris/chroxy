/**
 * platform utilities tests (#2883)
 *
 * Covers platform detection and shortcut-label formatting used by the
 * keyboard-shortcut help modal and inline hints.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { isMacPlatform, formatShortcutKeys } from './platform'

const ORIGINAL_NAVIGATOR = globalThis.navigator

afterEach(() => {
  // Restore the real navigator after each test
  Object.defineProperty(globalThis, 'navigator', {
    value: ORIGINAL_NAVIGATOR,
    configurable: true,
    writable: true,
  })
  vi.restoreAllMocks()
})

function setUserAgent(ua: string | undefined) {
  if (ua === undefined) {
    Object.defineProperty(globalThis, 'navigator', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    return
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua },
    configurable: true,
    writable: true,
  })
}

describe('isMacPlatform', () => {
  it('returns true for Mac user agents', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    expect(isMacPlatform()).toBe(true)
  })

  it('returns true for iPad user agents', () => {
    setUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')
    expect(isMacPlatform()).toBe(true)
  })

  it('returns false for Windows user agents', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    expect(isMacPlatform()).toBe(false)
  })

  it('returns false for Linux user agents', () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
    expect(isMacPlatform()).toBe(false)
  })

  it('returns false when navigator is undefined (SSR safety)', () => {
    setUserAgent(undefined)
    expect(isMacPlatform()).toBe(false)
  })
})

describe('formatShortcutKeys', () => {
  it('replaces Cmd with Ctrl on non-Mac platforms', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    expect(formatShortcutKeys('Cmd+Y')).toBe('Ctrl+Y')
    expect(formatShortcutKeys('Cmd+Shift+Y')).toBe('Ctrl+Shift+Y')
    expect(formatShortcutKeys('Cmd+1-9')).toBe('Ctrl+1-9')
    expect(formatShortcutKeys('Cmd+,')).toBe('Ctrl+,')
    expect(formatShortcutKeys('Cmd+\\')).toBe('Ctrl+\\')
    expect(formatShortcutKeys('Cmd+Enter')).toBe('Ctrl+Enter')
  })

  it('keeps Cmd label on Mac platforms', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    expect(formatShortcutKeys('Cmd+Y')).toBe('Cmd+Y')
    expect(formatShortcutKeys('Cmd+Shift+Y')).toBe('Cmd+Shift+Y')
    expect(formatShortcutKeys('Cmd+Enter')).toBe('Cmd+Enter')
  })

  it('passes through labels that do not contain Cmd', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    expect(formatShortcutKeys('?')).toBe('?')
    expect(formatShortcutKeys('Escape')).toBe('Escape')
    expect(formatShortcutKeys('Shift+Tab')).toBe('Shift+Tab')
  })

  it('does not replace Cmd substring inside other words', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    // Guard against a naive replace that would mangle e.g. "Cmdr" or similar.
    expect(formatShortcutKeys('Cmdr')).toBe('Cmdr')
  })
})
