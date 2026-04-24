/**
 * Storage adapter factories — creates platform-specific storage adapters
 * for persisting connection credentials.
 *
 * Two factories:
 * - createStorageAdapter: for synchronous backends (localStorage)
 * - createAsyncStorageAdapter: for async backends (SecureStore)
 */
import type { StorageAdapter } from './platform'

const STORAGE_KEY_URL = 'chroxy_last_url'
const STORAGE_KEY_TOKEN = 'chroxy_last_token'

/**
 * Create a storage adapter backed by a synchronous key-value store (e.g. localStorage).
 */
export function createStorageAdapter(backend: {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
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
        if (url && token) {
          return { url, token }
        }
        return null
      } catch {
        return null
      }
    },

    clearSavedCredentials() {
      try {
        backend.removeItem(STORAGE_KEY_URL)
        backend.removeItem(STORAGE_KEY_TOKEN)
      } catch {
        // Storage not available
      }
    },
  }
}

/**
 * Create a storage adapter backed by an async key-value store (e.g. SecureStore).
 */
export function createAsyncStorageAdapter(backend: {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}): StorageAdapter {
  return {
    async saveConnection(url: string, token: string) {
      try {
        await backend.setItem(STORAGE_KEY_URL, url)
        await backend.setItem(STORAGE_KEY_TOKEN, token)
      } catch {
        // Storage not available
      }
    },

    async loadConnection() {
      try {
        const url = await backend.getItem(STORAGE_KEY_URL)
        const token = await backend.getItem(STORAGE_KEY_TOKEN)
        if (url && token) {
          return { url, token }
        }
        return null
      } catch {
        return null
      }
    },

    async clearSavedCredentials() {
      try {
        await backend.removeItem(STORAGE_KEY_URL)
        await backend.removeItem(STORAGE_KEY_TOKEN)
      } catch {
        // Storage not available
      }
    },
  }
}
