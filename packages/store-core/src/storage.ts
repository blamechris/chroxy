/**
 * Storage adapter factory — creates platform-specific storage adapters
 * for persisting connection credentials.
 */
import type { StorageAdapter } from './platform'

const STORAGE_KEY_URL = 'chroxy_last_url'
const STORAGE_KEY_TOKEN = 'chroxy_last_token'

/**
 * Create a storage adapter backed by a key-value store.
 *
 * @param backend - get/set/remove functions matching localStorage or SecureStore APIs
 */
export function createStorageAdapter(backend: {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}): StorageAdapter {
  return {
    saveConnection(url: string, token: string) {
      try {
        backend.setItem(STORAGE_KEY_URL, url)
        backend.setItem(STORAGE_KEY_TOKEN, token)
      } catch {
        // Storage not available
      }
    },

    loadConnection() {
      try {
        const url = backend.getItem(STORAGE_KEY_URL)
        const token = backend.getItem(STORAGE_KEY_TOKEN)
        if (url && typeof url === 'string' && token && typeof token === 'string') {
          return { url, token }
        }
        return null
      } catch {
        return null
      }
    },

    clearConnection() {
      try {
        backend.removeItem(STORAGE_KEY_URL)
        backend.removeItem(STORAGE_KEY_TOKEN)
      } catch {
        // Storage not available
      }
    },
  }
}

/** Create a localStorage-backed adapter (web dashboard). */
export function createLocalStorageAdapter(): StorageAdapter {
  return createStorageAdapter(localStorage)
}
