import '@testing-library/jest-dom/vitest'

// jsdom 28 provides a localStorage object but without functional methods.
// Polyfill with an in-memory Storage implementation for tests.
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.clear !== 'function') {
  const store = new Map<string, string>()
  const storage: Storage = {
    get length() { return store.size },
    clear() { store.clear() },
    getItem(key: string) { return store.get(key) ?? null },
    key(index: number) { return [...store.keys()][index] ?? null },
    removeItem(key: string) { store.delete(key) },
    setItem(key: string, value: string) { store.set(key, String(value)) },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, writable: true })
}
