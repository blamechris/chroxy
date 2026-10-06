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
    // and the legacy keys are still there for the next load. This load still
    // inherits (claude-cli / opus-4-6 are never applied) and shows the notice.
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'claude-cli', [DEFAULT_MODEL_KEY]: 'opus-4-6' })
    const failing = { ...s, removeItem: () => { throw new Error('denied') } }
    expect(migrateSessionDefaults(failing)).toEqual({ provider: null, model: '', notice: { provider: 'claude-cli', model: 'opus-4-6' } })
    expect(s.data.get(DEFAULT_PROVIDER_KEY)).toBe('claude-cli')
    expect(s.data.has(SESSION_DEFAULTS_SCHEMA_KEY)).toBe(false)
    expect(JSON.parse(s.data.get(SESSION_DEFAULTS_NOTICE_KEY)!)).toEqual({ provider: 'claude-cli', model: 'opus-4-6' })
    // Storage recovers: the retry completes and the notice survives.
    expect(migrateSessionDefaults(s)).toEqual({ provider: null, model: '', notice: { provider: 'claude-cli', model: 'opus-4-6' } })
    expect(s.data.has(DEFAULT_PROVIDER_KEY)).toBe(false)
    expect(s.data.get(SESSION_DEFAULTS_SCHEMA_KEY)).toBe('2')
  })

  // #8276 acceptance review P2 — reads work, every write throws (quota).
  it('a failed migration WRITE keeps readable deliberate defaults (codex / gpt-5)', () => {
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'codex', [DEFAULT_MODEL_KEY]: 'gpt-5' })
    const quota = () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e }
    const failing = { ...s, setItem: quota }
    expect(migrateSessionDefaults(failing)).toEqual({ provider: 'codex', model: 'gpt-5', notice: null })
    expect(s.data.get(DEFAULT_PROVIDER_KEY)).toBe('codex')
    expect(s.data.has(SESSION_DEFAULTS_SCHEMA_KEY)).toBe(false)
  })

  it('a failed migration WRITE still inherits legacy values and keeps the notice in memory', () => {
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'claude-cli', [DEFAULT_MODEL_KEY]: 'opus-4-6' })
    const failing = { ...s, setItem: () => { throw new Error('quota') } }
    expect(migrateSessionDefaults(failing)).toEqual({ provider: null, model: '', notice: { provider: 'claude-cli', model: 'opus-4-6' } })
    // Nothing was removed (the notice write failed first), so nothing is lost.
    expect(s.data.get(DEFAULT_PROVIDER_KEY)).toBe('claude-cli')
    expect(s.data.get(DEFAULT_MODEL_KEY)).toBe('opus-4-6')
  })

  // #8276 acceptance review P3 — the provider removal succeeds, the model
  // removal fails, then the next load retries.
  it('a retry MERGES the undismissed notice instead of replacing it', () => {
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'claude-cli', [DEFAULT_MODEL_KEY]: 'opus-4-6' })
    const failModelRemoval = {
      ...s,
      removeItem: (k: string) => { if (k === DEFAULT_MODEL_KEY) throw new Error('denied'); s.removeItem(k) },
    }
    expect(migrateSessionDefaults(failModelRemoval).notice).toEqual({ provider: 'claude-cli', model: 'opus-4-6' })
    expect(s.data.has(DEFAULT_PROVIDER_KEY)).toBe(false)
    expect(s.data.get(DEFAULT_MODEL_KEY)).toBe('opus-4-6')
    const retry = migrateSessionDefaults(s)
    expect(retry).toEqual({ provider: null, model: '', notice: { provider: 'claude-cli', model: 'opus-4-6' } })
    expect(JSON.parse(s.data.get(SESSION_DEFAULTS_NOTICE_KEY)!)).toEqual({ provider: 'claude-cli', model: 'opus-4-6' })
  })

  it('an unreadable notice does not cost the readable defaults', () => {
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'codex', [DEFAULT_MODEL_KEY]: 'gpt-5' })
    const noticeUnreadable = {
      ...s,
      getItem: (k: string) => { if (k === SESSION_DEFAULTS_NOTICE_KEY) throw new Error('denied'); return s.getItem(k) },
    }
    expect(migrateSessionDefaults(noticeUnreadable)).toEqual({ provider: 'codex', model: 'gpt-5', notice: null })
  })

  it('a Settings write never stamps the marker over a legacy key a failed migration left behind', () => {
    // Legacy claude-cli + opus-4-6, and removals fail: the migration cannot
    // finish. The user then picks codex in Settings.
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'claude-cli', [DEFAULT_MODEL_KEY]: 'opus-4-6' })
    const failingRemove = { ...s, removeItem: () => { throw new Error('denied') } }
    migrateSessionDefaults(failingRemove)
    persistSessionDefault(DEFAULT_PROVIDER_KEY, 'codex', failingRemove)
    expect(s.data.get(DEFAULT_PROVIDER_KEY)).toBe('codex')
    expect(s.data.get(DEFAULT_MODEL_KEY)).toBe('opus-4-6')
    expect(s.data.has(SESSION_DEFAULTS_SCHEMA_KEY)).toBe(false)
    // Storage recovers: the deliberate codex is kept, the stale pin is not applied.
    expect(migrateSessionDefaults(s)).toEqual({ provider: 'codex', model: '', notice: { provider: 'claude-cli', model: 'opus-4-6' } })
  })

  it('a Settings write on an unmigrated store finishes the migration first', () => {
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'claude-cli', [DEFAULT_MODEL_KEY]: 'opus-4-6' })
    persistSessionDefault(DEFAULT_PROVIDER_KEY, 'codex', s)
    expect(migrateSessionDefaults(s)).toEqual({ provider: 'codex', model: '', notice: { provider: 'claude-cli', model: 'opus-4-6' } })
  })

  // #8276 acceptance review (ac6b9600): only CREATING the notice fails
  // (quota), overwriting an existing key succeeds, and the user then makes a
  // deliberate Settings choice that itself looks legacy.
  function noticeCreationFails(initial: Record<string, string>) {
    const s = memoryStorage(initial)
    const failing = {
      ...s,
      setItem: (k: string, v: string) => { if (k === SESSION_DEFAULTS_NOTICE_KEY) throw new Error('quota'); s.setItem(k, v) },
    }
    return { s, failing }
  }

  it('a deliberate claude-tui chosen during a pending migration survives the next load', () => {
    const { s, failing } = noticeCreationFails({ [DEFAULT_PROVIDER_KEY]: 'claude-cli', [DEFAULT_MODEL_KEY]: 'opus-4-6' })
    migrateSessionDefaults(failing)
    persistSessionDefault(DEFAULT_PROVIDER_KEY, 'claude-tui', failing)
    expect(s.data.get(SESSION_DEFAULTS_SCHEMA_KEY)).toBe('2')
    const recovered = migrateSessionDefaults(s)
    expect(recovered.provider).toBe('claude-tui')
    expect(recovered.model).toBe('')
    expect(s.data.has(DEFAULT_MODEL_KEY)).toBe(false)
    // The notice could never be created here, so nothing is (mis)reported.
    expect(recovered.notice).toBeNull()
  })

  it.each([
    ['a removal throws', (k: string) => k === DEFAULT_MODEL_KEY ? 'remove' : null],
    ['the marker write throws', (k: string) => k === SESSION_DEFAULTS_SCHEMA_KEY ? 'set' : null],
  ])('when %s, a legacy-looking choice is not persisted unmarked (never deleted and named as cleared)', (_label, failOn) => {
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'claude-cli', [DEFAULT_MODEL_KEY]: 'opus-4-6' })
    const failing = {
      ...s,
      setItem: (k: string, v: string) => { if (failOn(k) === 'set') throw new Error('quota'); s.setItem(k, v) },
      removeItem: (k: string) => { if (failOn(k) === 'remove') throw new Error('denied'); s.removeItem(k) },
    }
    persistSessionDefault(DEFAULT_PROVIDER_KEY, 'claude-tui', failing)
    expect(s.data.get(DEFAULT_PROVIDER_KEY)).not.toBe('claude-tui')
    const next = migrateSessionDefaults(s)
    expect(next.provider).toBeNull()
    expect(next.notice?.provider).not.toBe('claude-tui')
    // A non-legacy choice under the same failure is still written and kept.
    persistSessionDefault(DEFAULT_PROVIDER_KEY, 'codex', failing)
    expect(migrateSessionDefaults(s).provider).toBe('codex')
  })

  it('a deliberate version-pinned model chosen during a pending migration survives the next load', () => {
    const { s, failing } = noticeCreationFails({ [DEFAULT_PROVIDER_KEY]: 'claude-cli', [DEFAULT_MODEL_KEY]: 'opus-4-6' })
    migrateSessionDefaults(failing)
    persistSessionDefault(DEFAULT_MODEL_KEY, 'opus-4-7', failing)
    const recovered = migrateSessionDefaults(s)
    expect(recovered).toMatchObject({ provider: null, model: 'opus-4-7' })
    expect(s.data.has(DEFAULT_PROVIDER_KEY)).toBe(false)
  })

  it('when storage recovers, a Settings write records the notice for what it cleared', () => {
    // The notice failed during load, then space frees up (first write fails only).
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'claude-cli', [DEFAULT_MODEL_KEY]: 'opus-4-6' })
    let noticeFailures = 1
    const flaky = {
      ...s,
      setItem: (k: string, v: string) => { if (k === SESSION_DEFAULTS_NOTICE_KEY && noticeFailures-- > 0) throw new Error('quota'); s.setItem(k, v) },
    }
    persistSessionDefault(DEFAULT_PROVIDER_KEY, 'claude-tui', flaky)
    expect(migrateSessionDefaults(s)).toEqual({ provider: 'claude-tui', model: '', notice: { provider: 'claude-cli', model: 'opus-4-6' } })
  })

  it('a failed READ is the only "nothing persisted"', () => {
    const s = memoryStorage({ [DEFAULT_PROVIDER_KEY]: 'codex' })
    const unreadable = { ...s, getItem: () => { throw new Error('denied') } }
    expect(migrateSessionDefaults(unreadable)).toEqual({ provider: null, model: '', notice: null })
  })

  it('a corrupt notice is ignored', () => {
    const s = memoryStorage({ [SESSION_DEFAULTS_SCHEMA_KEY]: '2', [SESSION_DEFAULTS_NOTICE_KEY]: '{not json' })
    expect(migrateSessionDefaults(s).notice).toBeNull()
  })
})
