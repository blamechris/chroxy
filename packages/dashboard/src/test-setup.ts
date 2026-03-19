import '@testing-library/jest-dom/vitest'

// jsdom 28 provides a localStorage object but without functional methods.
// Polyfill with an in-memory Storage implementation for tests.
if (
  typeof globalThis.localStorage === 'undefined' ||
  typeof globalThis.localStorage.clear !== 'function' ||
  typeof globalThis.localStorage.getItem !== 'function' ||
  typeof globalThis.localStorage.setItem !== 'function' ||
  typeof globalThis.localStorage.removeItem !== 'function' ||
  typeof globalThis.localStorage.key !== 'function'
) {
  const store = new Map<string, string>()
  const storage: Storage = {
    get length() { return store.size },
    clear() { store.clear() },
    getItem(key: string) { return store.get(key) ?? null },
    key(index: number) {
      if (index < 0 || index >= store.size) return null
      let i = 0
      for (const k of store.keys()) {
        if (i === index) return k
        i++
      }
      return null
    },
    removeItem(key: string) { store.delete(key) },
    setItem(key: string, value: string) { store.set(key, String(value)) },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true })
}
