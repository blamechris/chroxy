import { describe, it, expect, afterEach } from 'vitest'
import { isTauri } from './tauri'

describe('isTauri() utility (#1943)', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    delete (window as unknown as Record<string, unknown>).__TAURI__
  })

  it('returns true when __TAURI_INTERNALS__ is present (Tauri v2)', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      writable: true,
      configurable: true,
    })
    expect(isTauri()).toBe(true)
  })

  it('returns true when __TAURI__ is present (Tauri v1 / v2 alias)', () => {
    Object.defineProperty(window, '__TAURI__', {
      value: {},
      writable: true,
      configurable: true,
    })
    expect(isTauri()).toBe(true)
  })

  it('returns false when neither Tauri global is present', () => {
    expect(isTauri()).toBe(false)
  })
})
