/**
 * Tests for platform adapter interfaces and default implementations.
 */
import { describe, it, expect, vi } from 'vitest'
import { noopHaptic, consoleAlert, noopPush } from './platform'
import { createStorageAdapter, createAsyncStorageAdapter } from './storage'

describe('noopHaptic', () => {
  it('has all haptic methods as no-ops', () => {
    expect(() => noopHaptic.light()).not.toThrow()
    expect(() => noopHaptic.medium()).not.toThrow()
    expect(() => noopHaptic.warning()).not.toThrow()
    expect(() => noopHaptic.success()).not.toThrow()
  })
})

describe('consoleAlert', () => {
  it('logs to console.warn with formatted message', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    consoleAlert.alert('Test Title', 'Test message')
    expect(spy).toHaveBeenCalledWith('[chroxy] Test Title: Test message')
    spy.mockRestore()
  })
})

describe('noopPush', () => {
  it('registerPushToken resolves without error', async () => {
    const mockSocket = {} as WebSocket
    await expect(noopPush.registerPushToken(mockSocket)).resolves.toBeUndefined()
  })
})

describe('createStorageAdapter', () => {
  it('saves and loads connection', () => {
    const store = new Map<string, string>()
    const adapter = createStorageAdapter({
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v) },
      removeItem: (k) => { store.delete(k) },
    })

    adapter.saveConnection('wss://example.com', 'token123')
    const result = adapter.loadConnection()
    expect(result).toEqual({ url: 'wss://example.com', token: 'token123' })
  })

  it('returns null when no connection saved', () => {
    const adapter = createStorageAdapter({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    })

    expect(adapter.loadConnection()).toBeNull()
  })

  it('clears saved connection', () => {
    const store = new Map<string, string>()
    const adapter = createStorageAdapter({
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v) },
      removeItem: (k) => { store.delete(k) },
    })

    adapter.saveConnection('wss://example.com', 'token123')
    adapter.clearConnection()
    expect(adapter.loadConnection()).toBeNull()
  })

  it('handles storage errors gracefully', () => {
    const adapter = createStorageAdapter({
      getItem: () => { throw new Error('no storage') },
      setItem: () => { throw new Error('no storage') },
      removeItem: () => { throw new Error('no storage') },
    })

    expect(() => adapter.saveConnection('url', 'token')).not.toThrow()
    expect(adapter.loadConnection()).toBeNull()
    expect(() => adapter.clearConnection()).not.toThrow()
  })
})

describe('createAsyncStorageAdapter', () => {
  it('saves and loads connection with async backend', async () => {
    const store = new Map<string, string>()
    const adapter = createAsyncStorageAdapter({
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v) },
      removeItem: async (k: string) => { store.delete(k) },
    })

    await adapter.saveConnection('wss://example.com', 'token123')
    const result = await adapter.loadConnection()
    expect(result).toEqual({ url: 'wss://example.com', token: 'token123' })
  })

  it('returns null when no connection saved', async () => {
    const adapter = createAsyncStorageAdapter({
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    })

    expect(await adapter.loadConnection()).toBeNull()
  })

  it('clears saved connection', async () => {
    const store = new Map<string, string>()
    const adapter = createAsyncStorageAdapter({
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v) },
      removeItem: async (k: string) => { store.delete(k) },
    })

    await adapter.saveConnection('wss://example.com', 'token123')
    await adapter.clearConnection()
    expect(await adapter.loadConnection()).toBeNull()
  })

  it('handles async storage errors gracefully', async () => {
    const adapter = createAsyncStorageAdapter({
      getItem: async () => { throw new Error('no storage') },
      setItem: async () => { throw new Error('no storage') },
      removeItem: async () => { throw new Error('no storage') },
    })

    await expect(adapter.saveConnection('url', 'token')).resolves.not.toThrow()
    expect(await adapter.loadConnection()).toBeNull()
    await expect(adapter.clearConnection()).resolves.not.toThrow()
  })
})
