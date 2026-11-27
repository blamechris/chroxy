/**
 * Make a localStorage method throw, and PROVE it did. A spy that silently does not take
 * effect (a different Storage implementation on another Node) would turn every failure test
 * into a vacuous pass, so each call asserts the fault is live and falls back to replacing
 * `window.localStorage` with a faulting wrapper when the prototype spy is not enough.
 */
import { expect, vi } from 'vitest'

type Method = 'getItem' | 'setItem' | 'removeItem'

let original: PropertyDescriptor | null = null

function throws(method: Method): boolean {
  try {
    ;(localStorage as unknown as Record<Method, (k: string, v?: string) => unknown>)[method]('__probe__', 'v')
    return false
  } catch {
    return true
  }
}

export function failStorage(method: Method, message = 'storage fault'): void {
  vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error(message) })
  if (!throws(method)) {
    // The prototype spy did not take effect here: wrap the instance instead.
    original = original ?? Object.getOwnPropertyDescriptor(window, 'localStorage') ?? null
    const real = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: new Proxy(real, {
        get(target, prop) {
          if (prop === method) return () => { throw new Error(message) }
          const v = Reflect.get(target, prop, target) as unknown
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
        },
      }),
    })
  }
  expect(throws(method), `storage fault for ${method} must be live`).toBe(true)
}

/** Undo any instance replacement (spies are undone by vi.restoreAllMocks). */
export function restoreStorage(): void {
  vi.restoreAllMocks()
  if (original) {
    Object.defineProperty(window, 'localStorage', original)
    original = null
  }
}
