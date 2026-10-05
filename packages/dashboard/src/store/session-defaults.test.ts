/**
 * #8265 — persisted New Session defaults: legacy/inherited vs deliberate.
 *
 * The migration runs once per browser origin. After it, a present key is a
 * deliberate override and an absent key inherits; these tests pin which
 * legacy values cross that line and that the marker makes it one-time.
 */
import { describe, it, expect } from 'vitest'
import {
  migrateSessionDefaults,
  persistSessionDefault,
  clearSessionDefaultsNotice,
  isVersionedClaudeModelPin,
  DEFAULT_PROVIDER_KEY,
  DEFAULT_MODEL_KEY,
  SESSION_DEFAULTS_SCHEMA_KEY,
  SESSION_DEFAULTS_NOTICE_KEY,
} from './session-defaults'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)) },
    removeItem: (k: string) => { data.delete(k) },
  }
}

describe('isVersionedClaudeModelPin', () => {
  it.each(['opus-4-6', 'claude-opus-4-6', 'sonnet-4-6', 'claude-sonnet-4-20250514', 'claude-opus-4-7[1m]', 'opus-4-6[1m]', 'haiku-4-5', 'fable-5', 'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-7-sonnet-latest', 'claude-3-opus', 'Claude-Opus-4-6'])('%s is a pin', id => {
    expect(isVersionedClaudeModelPin(id)).toBe(true)
  })
  it.each(['default', 'opus', 'sonnet', 'haiku', 'fable', 'opus[1m]', 'gpt-5', 'gemini-2.5-pro', 'deepseek-chat', 'qwen3-coder', 'sonnet-latest', 'claude-sonnet-latest', 'opus-latest', 'claude-3.5-sonnet', ''])('%s is not a pin', id => {
    expect(isVersionedClaudeModelPin(id)).toBe(false)
  })
})

describe('migrateSessionDefaults', () => {
  it('fresh origin: nothing persisted → inherit everything, no notice, marker written', () => {
    const s = memoryStorage()
    expect(migrateSessionDefaults(s)).toEqual({ provider: null, model: '', notice: null })
    expect(s.data.get(SESSION_DEFAULTS_SCHEMA_KEY)).toBe('2')
  })

  it('the owner case: legacy claude-cli + opus-4-6 are both cleared, with a notice', () => {
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'claude-cli', [DEFAULT_MODEL_KEY]: 'opus-4-6' })
    expect(migrateSessionDefaults(s)).toEqual({
      provider: null,
      model: '',
      notice: { provider: 'claude-cli', model: 'opus-4-6' },
    })
    expect(s.data.has(DEFAULT_PROVIDER_KEY)).toBe(false)
    expect(s.data.has(DEFAULT_MODEL_KEY)).toBe(false)
    expect(JSON.parse(s.data.get(SESSION_DEFAULTS_NOTICE_KEY)!)).toEqual({ provider: 'claude-cli', model: 'opus-4-6' })
  })

  it('legacy claude-tui (the retired built-in default) is cleared', () => {
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'claude-tui' })
    expect(migrateSessionDefaults(s).provider).toBeNull()
    expect(migrateSessionDefaults(s).notice).toEqual({ provider: 'claude-tui' })
  })

  it('other legacy providers and alias models are kept as deliberate overrides', () => {
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'codex', [DEFAULT_MODEL_KEY]: 'sonnet' })
    expect(migrateSessionDefaults(s)).toEqual({ provider: 'codex', model: 'sonnet', notice: null })
    expect(s.data.get(DEFAULT_PROVIDER_KEY)).toBe('codex')
  })

  it('a legacy claude-sdk + default model survives unchanged', () => {
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'claude-sdk', [DEFAULT_MODEL_KEY]: 'default' })
    expect(migrateSessionDefaults(s)).toEqual({ provider: 'claude-sdk', model: 'default', notice: null })
  })

  it('a legacy empty model ("Server default" under the old setter) becomes absent, silently', () => {
    const s = memoryStorage({ [DEFAULT_MODEL_KEY]: '' })
    expect(migrateSessionDefaults(s)).toEqual({ provider: null, model: '', notice: null })
    expect(s.data.has(DEFAULT_MODEL_KEY)).toBe(false)
  })

  it('runs ONCE: a deliberate post-migration claude-cli / versioned pin is honoured', () => {
    const s = memoryStorage()
    migrateSessionDefaults(s)
    persistSessionDefault(DEFAULT_PROVIDER_KEY, 'claude-cli', s)
    persistSessionDefault(DEFAULT_MODEL_KEY, 'opus-4-6', s)
    expect(migrateSessionDefaults(s)).toEqual({ provider: 'claude-cli', model: 'opus-4-6', notice: null })
  })

  it('an explicit write before any load also stamps the schema (never re-migrated)', () => {
    const s = memoryStorage()
    persistSessionDefault(DEFAULT_PROVIDER_KEY, 'claude-tui', s)
    expect(migrateSessionDefaults(s).provider).toBe('claude-tui')
  })

  it('the notice persists until dismissed, then is gone', () => {
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'claude-cli' })
    migrateSessionDefaults(s)
    expect(migrateSessionDefaults(s).notice).toEqual({ provider: 'claude-cli' })
    clearSessionDefaultsNotice(s)
    expect(migrateSessionDefaults(s).notice).toBeNull()
  })

  it('persistSessionDefault with "" or null clears the override (back to inherit)', () => {
    const s = memoryStorage()
    persistSessionDefault(DEFAULT_PROVIDER_KEY, 'codex', s)
    persistSessionDefault(DEFAULT_PROVIDER_KEY, '', s)
    expect(s.data.has(DEFAULT_PROVIDER_KEY)).toBe(false)
  })

  it('throwing storage reads as nothing persisted', () => {
    const throwing = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    }
    expect(migrateSessionDefaults(throwing)).toEqual({ provider: null, model: '', notice: null })
    expect(migrateSessionDefaults(null)).toEqual({ provider: null, model: '', notice: null })
  })

  it('a storage failure part-way never loses a value silently, and the migration retries', () => {
    // removeItem is denied: the notice is already written, the marker is not,
    // and the legacy keys are still there for the next load.
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'claude-cli', [DEFAULT_MODEL_KEY]: 'opus-4-6' })
    const failing = { ...s, removeItem: () => { throw new Error('denied') } }
    expect(migrateSessionDefaults(failing)).toEqual({ provider: null, model: '', notice: null })
    expect(s.data.get(DEFAULT_PROVIDER_KEY)).toBe('claude-cli')
    expect(s.data.has(SESSION_DEFAULTS_SCHEMA_KEY)).toBe(false)
    expect(JSON.parse(s.data.get(SESSION_DEFAULTS_NOTICE_KEY)!)).toEqual({ provider: 'claude-cli', model: 'opus-4-6' })
    // Storage recovers: the retry completes and the notice survives.
    expect(migrateSessionDefaults(s)).toEqual({ provider: null, model: '', notice: { provider: 'claude-cli', model: 'opus-4-6' } })
  })

  it('a corrupt notice is ignored', () => {
    const s = memoryStorage({ [SESSION_DEFAULTS_SCHEMA_KEY]: '2', [SESSION_DEFAULTS_NOTICE_KEY]: '{not json' })
    expect(migrateSessionDefaults(s).notice).toBeNull()
  })
})
