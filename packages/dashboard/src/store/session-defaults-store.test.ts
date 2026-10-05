/**
 * #8265 — the REAL store's wiring of session defaults (PR #8276 review S2).
 *
 * session-defaults.test.ts proves the migration in isolation and the modal /
 * Settings tests mock the store, so none of them would notice the store
 * dropping its migrateSessionDefaults() call, or a setter writing localStorage
 * directly again. These import the real store module after seeding storage.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULT_PROVIDER } from '@chroxy/protocol'

async function loadStore(seed: Record<string, string>) {
  localStorage.clear()
  for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v)
  vi.resetModules()
  const { useConnectionStore } = await import('./connection')
  return useConnectionStore
}

describe('session defaults through the real store (#8265)', () => {
  beforeEach(() => { localStorage.clear() })

  it('runs the legacy migration at store creation: claude-cli + opus-4-6 are inherited, with a notice', async () => {
    const store = await loadStore({ chroxy_default_provider: 'claude-cli', chroxy_default_model: 'opus-4-6' })
    const s = store.getState()
    expect(s.defaultProvider).toBe(DEFAULT_PROVIDER)
    expect(s.defaultProviderSource).toBe('builtin')
    expect(s.defaultModel).toBe('')
    expect(s.sessionDefaultsNotice).toEqual({ provider: 'claude-cli', model: 'opus-4-6' })
    expect(localStorage.getItem('chroxy_default_provider')).toBeNull()
  })

  it('seeds a deliberate (post-migration) override as the user\'s', async () => {
    const store = await loadStore({ chroxy_session_defaults_v: '2', chroxy_default_provider: 'codex', chroxy_default_model: 'sonnet' })
    const s = store.getState()
    expect(s.defaultProvider).toBe('codex')
    expect(s.defaultProviderSource).toBe('user')
    expect(s.defaultModel).toBe('sonnet')
  })

  it('setDefaultProvider("") clears the override and falls back to the server default, else the built-in one', async () => {
    const store = await loadStore({ chroxy_session_defaults_v: '2', chroxy_default_provider: 'codex' })
    store.setState({ serverDefaultProvider: 'gemini' })
    store.getState().setDefaultProvider('')
    expect(store.getState().defaultProvider).toBe('gemini')
    expect(store.getState().defaultProviderSource).toBe('server')
    expect(localStorage.getItem('chroxy_default_provider')).toBeNull()

    store.setState({ serverDefaultProvider: null })
    store.getState().setDefaultProvider('')
    expect(store.getState().defaultProvider).toBe(DEFAULT_PROVIDER)
    expect(store.getState().defaultProviderSource).toBe('builtin')
  })

  it('setDefaultProvider(x) persists a deliberate override and stamps the schema', async () => {
    const store = await loadStore({})
    store.getState().setDefaultProvider('claude-tui')
    expect(store.getState().defaultProviderSource).toBe('user')
    expect(localStorage.getItem('chroxy_default_provider')).toBe('claude-tui')
    expect(localStorage.getItem('chroxy_session_defaults_v')).toBe('2')
  })

  it('setDefaultModel("") removes the key; a model is persisted verbatim', async () => {
    const store = await loadStore({ chroxy_session_defaults_v: '2' })
    store.getState().setDefaultModel('default')
    expect(localStorage.getItem('chroxy_default_model')).toBe('default')
    store.getState().setDefaultModel('')
    expect(store.getState().defaultModel).toBe('')
    expect(localStorage.getItem('chroxy_default_model')).toBeNull()
  })

  it('dismissSessionDefaultsNotice clears the notice in state AND storage', async () => {
    const store = await loadStore({ chroxy_default_provider: 'claude-tui' })
    expect(store.getState().sessionDefaultsNotice).toEqual({ provider: 'claude-tui' })
    store.getState().dismissSessionDefaultsNotice()
    expect(store.getState().sessionDefaultsNotice).toBeNull()
    expect(localStorage.getItem('chroxy_session_defaults_notice')).toBeNull()
  })
})
