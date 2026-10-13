import { describe, it, expect } from 'vitest'
import { findModelEntry, modelChoices, formatActiveModelLabel, modelDisplayTarget } from './model-display'
import { mergeModelsByProvider, selectModelsForProvider } from './models-by-provider'

const models = [
  { id: 'haiku', fullId: 'haiku', label: 'Haiku 4.5' },
  { id: 'haiku-4-5', fullId: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { id: 'haiku-4-5-20251001', fullId: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

describe('model presentation (#8260)', () => {
  it('keeps distinct accepted aliases and pins with unambiguous labels and unchanged IDs', () => {
    const choices = modelChoices(models)
    expect(choices.map(m => m.id)).toEqual(models.map(m => m.id))
    expect(new Set(choices.map(m => m.label)).size).toBe(choices.length)
    expect(choices.map(m => m.label)).toEqual(['Haiku 4.5 (provider alias)', 'Haiku 4.5 (pinned 4.5)', 'Haiku 4.5 (pinned 20251001)'])
    expect(models[0]!.label).toBe('Haiku 4.5')
  })
  it('collapses only identical targets while preserving exact alias resolution', () => {
    const duplicate = { ...models[1]!, id: 'second-alias' }
    expect(modelChoices([...models, duplicate])).toHaveLength(3)
    expect(findModelEntry([...models, duplicate], 'second-alias')).toBe(duplicate)
  })
  it('resolves exact id before an earlier full-ID alias', () => {
    const collision = [{ id: 'other', fullId: 'haiku-4-5', label: 'Other' }, ...models]
    expect(findModelEntry(collision, 'haiku-4-5')).toBe(models[1])
    expect(findModelEntry(models, 'claude-haiku-4-5-20251001')).toBe(models[2])
  })
  it('labels unresolved provider defaults without Default(Default)', () => {
    expect(formatActiveModelLabel([{ id: 'default', fullId: 'default', label: 'Default' }], 'default', 'default')).toBe('Provider default')
    expect(formatActiveModelLabel([{ id: 'default', fullId: 'default', label: 'Opus 4.7' }], 'default', 'default')).toBe('Default (Opus 4.7)')
    expect(formatActiveModelLabel([{ id: 'default', fullId: 'claude-opus-4-7', label: 'Operator label' }], 'default')).toBe('Operator label')
    expect(formatActiveModelLabel(models, 'default')).toBe('Provider default')
    expect(formatActiveModelLabel(models, null)).toBe('Provider default')
    expect(formatActiveModelLabel(models, null, 'haiku')).toBe('Default (Haiku 4.5 (provider alias))')
  })
  it('matches the default by provider target when accepted aliases share a target', () => {
    const shared = [{ id: 'a', fullId: 'same-target', label: 'Shared' }, { id: 'b', fullId: 'same-target', label: 'Shared' }]
    expect(formatActiveModelLabel(shared, 'b', 'a')).toBe('Default (Shared)')
    expect(formatActiveModelLabel(shared, 'same-target', 'a')).toBe('Default (Shared)')
    expect(modelChoices(shared)).toHaveLength(1)
  })
  it('resolves a null active model to the known default target for display only', () => {
    const roster = [{ id: 'haiku', fullId: 'claude-haiku-4-5', label: 'Haiku 4.5' }]
    expect(modelDisplayTarget(roster, null, 'haiku')).toBe('claude-haiku-4-5')
    expect(formatActiveModelLabel(roster, null, 'haiku')).toBe('Default (Haiku 4.5)')
    expect(findModelEntry(roster, null)).toBeUndefined()
  })
  it('formats absent dated running IDs without selecting an undated row', () => {
    const dated = 'claude-haiku-4-5-20251101'
    expect(findModelEntry(models, dated)).toBeUndefined()
    expect(formatActiveModelLabel(models, dated, null, 'claude-sdk')).toBe('Haiku 4.5 (pinned 20251101)')
    expect(formatActiveModelLabel(models, dated, null, 'codex')).toBe(dated)
    expect(formatActiveModelLabel(models, 'claude-haiku-4-6', null, 'claude-sdk')).toBe('claude-haiku-4-6')
  })
  it('retains 1M targets separately and never borrows a base window label', () => {
    const long = { id: 'haiku-4-5[1m]', fullId: 'claude-haiku-4-5[1m]', label: 'Haiku 4.5' }
    expect(modelChoices([...models, long]).map(m => m.label)).toContain('Haiku 4.5 (pinned 4.5, 1M)')
    expect(formatActiveModelLabel(models, 'claude-haiku-4-5-20251101[1m]', null, 'claude-sdk')).toBe('Haiku 4.5 (pinned 20251101, 1M)')
  })
  it('uses only the selected provider roster', () => {
    let map = mergeModelsByProvider({}, 'claude-sdk', { models, defaultModelId: 'haiku' })
    map = mergeModelsByProvider(map, 'codex', { models: [{ id: 'gpt', fullId: 'gpt', label: 'GPT' }], defaultModelId: 'gpt' })
    const roster = selectModelsForProvider(map, 'codex')
    expect(formatActiveModelLabel(roster.models, 'haiku', roster.defaultModelId, 'codex')).toBe('haiku')
  })
})
