/**
 * #7728 — `resolveCreateSessionModel` applies the persisted default model only
 * when the CHOSEN provider's own catalog proves it accepts that model.
 *
 * The dashboard's "default model" setting is one string, not a per-provider
 * one, so creating a codex session while `defaultModel` holds a Claude id must
 * forward nothing. That check used to be "does the single global roster's
 * provider tag equal this provider?"; it is now a lookup in that provider's own
 * roster, which answers the same question without depending on which provider
 * broadcast last.
 *
 * `selectOwnModelsForProvider` is deliberate here: an UNTAGGED roster (an older
 * daemon that labels nothing) is good enough to DISPLAY, and not good enough to
 * prove which provider a model belongs to. A cannot-check must not read as a
 * yes.
 */
import { describe, it, expect } from 'vitest'
import { UNTAGGED_MODELS_PROVIDER } from '@chroxy/store-core'
import type { ModelsByProvider } from '@chroxy/store-core'
import { resolveCreateSessionModel } from './CreateSessionModal'

const CLAUDE_MODELS = [
  { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-6' },
  { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-7' },
]
const CODEX_MODELS = [{ id: 'gpt-5.5', label: 'GPT-5.5', fullId: 'gpt-5.5' }]

const BOTH: ModelsByProvider = {
  'claude-sdk': { models: CLAUDE_MODELS, defaultModelId: 'sonnet' },
  codex: { models: CODEX_MODELS, defaultModelId: 'gpt-5.5' },
}

describe('resolveCreateSessionModel (#7728)', () => {
  it("forwards the default model when the chosen provider's own catalog has it", () => {
    expect(resolveCreateSessionModel('claude-sdk', 'opus', BOTH)).toBe('opus')
    expect(resolveCreateSessionModel('codex', 'gpt-5.5', BOTH)).toBe('gpt-5.5')
  })

  it('matches on the full id as well as the short id', () => {
    expect(resolveCreateSessionModel('claude-sdk', 'claude-opus-4-7', BOTH)).toBe('claude-opus-4-7')
  })

  it("forwards NOTHING when the model belongs to a DIFFERENT provider's catalog", () => {
    // The bug this guards: `opus` is a real model, just not one codex runs.
    expect(resolveCreateSessionModel('codex', 'opus', BOTH)).toBeUndefined()
  })

  it('forwards nothing when the chosen provider has broadcast no roster at all', () => {
    expect(resolveCreateSessionModel('gemini', 'flash', BOTH)).toBeUndefined()
  })

  it('forwards nothing on an UNTAGGED roster, even one that contains the model', () => {
    // Displaying that roster is fine (`selectModelsForProvider` serves it); it
    // cannot PROVE the model is this provider's, so the default is not applied.
    const untagged: ModelsByProvider = {
      [UNTAGGED_MODELS_PROVIDER]: { models: CLAUDE_MODELS, defaultModelId: 'sonnet' },
    }
    expect(resolveCreateSessionModel('claude-sdk', 'opus', untagged)).toBeUndefined()
  })

  it('forwards nothing for an empty, whitespace, or absent default model', () => {
    expect(resolveCreateSessionModel('claude-sdk', '', BOTH)).toBeUndefined()
    expect(resolveCreateSessionModel('claude-sdk', '   ', BOTH)).toBeUndefined()
    expect(resolveCreateSessionModel('claude-sdk', null, BOTH)).toBeUndefined()
    expect(resolveCreateSessionModel('claude-sdk', undefined, BOTH)).toBeUndefined()
  })

  it('trims the stored default before matching', () => {
    expect(resolveCreateSessionModel('claude-sdk', '  opus  ', BOTH)).toBe('opus')
  })
})
