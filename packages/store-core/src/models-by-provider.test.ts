import { describe, it, expect } from 'vitest'
import {
  UNTAGGED_MODELS_PROVIDER,
  EMPTY_MODEL_ROSTER,
  mergeModelsByProvider,
  selectModelsForProvider,
  selectOwnModelsForProvider,
  type ModelsByProvider,
} from './models-by-provider'
import type { ModelInfo } from './types'

const opus: ModelInfo = { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-8' }
const gpt: ModelInfo = { id: 'gpt-5.5', label: 'GPT-5.5', fullId: 'gpt-5.5' }

const roster = (models: ModelInfo[], defaultModelId: string | null = null) => ({ models, defaultModelId })

describe('mergeModelsByProvider (#7728)', () => {
  it('keys the roster by the broadcast provider tag', () => {
    const map = mergeModelsByProvider(undefined, 'codex', roster([gpt], 'gpt-5.5'))
    expect(map).toEqual({ codex: { models: [gpt], defaultModelId: 'gpt-5.5' } })
  })

  it('leaves every OTHER provider roster intact', () => {
    const first = mergeModelsByProvider(undefined, 'claude-sdk', roster([opus], 'opus'))
    const second = mergeModelsByProvider(first, 'codex', roster([gpt], 'gpt-5.5'))
    expect(Object.keys(second).sort()).toEqual(['claude-sdk', 'codex'])
    expect(second['claude-sdk'].models).toEqual([opus])
  })

  it('does not mutate the previous map (a store patch must be a new object)', () => {
    const first = mergeModelsByProvider(undefined, 'claude-sdk', roster([opus]))
    const second = mergeModelsByProvider(first, 'codex', roster([gpt]))
    expect(first).not.toBe(second)
    expect(Object.keys(first)).toEqual(['claude-sdk'])
  })

  it('replaces the SAME provider roster wholesale (a dropped model disappears)', () => {
    const first = mergeModelsByProvider(undefined, 'codex', roster([gpt, opus]))
    const second = mergeModelsByProvider(first, 'codex', roster([gpt]))
    expect(second.codex.models).toEqual([gpt])
  })

  for (const [label, tag] of [
    ['missing', undefined],
    ['null', null],
    ['non-string', 7],
    ['blank', '   '],
  ] as const) {
    it(`buckets a ${label} provider tag as UNTAGGED`, () => {
      const map = mergeModelsByProvider(undefined, tag, roster([opus]))
      expect(Object.keys(map)).toEqual([UNTAGGED_MODELS_PROVIDER])
    })
  }

  it('canonicalizes a padded tag so the bucket is reachable by the bare name', () => {
    // The write side decided "blank" with .trim() and then stored the RAW
    // string, so ' codex ' keyed a bucket no lookup for 'codex' could reach —
    // the roster arrived and was invisible (Copilot, PR #7758).
    const map = mergeModelsByProvider(undefined, ' codex ', roster([gpt], 'gpt-5.5'))
    expect(Object.keys(map)).toEqual(['codex'])
    expect(selectOwnModelsForProvider(map, 'codex')?.models).toEqual([gpt])
    expect(selectModelsForProvider(map, 'codex').models).toEqual([gpt])
  })

  it('a padded LOOKUP reaches the bucket written from the bare name', () => {
    const map = mergeModelsByProvider(undefined, 'codex', roster([gpt], 'gpt-5.5'))
    expect(selectOwnModelsForProvider(map, '  codex\t')?.models).toEqual([gpt])
    expect(selectModelsForProvider(map, '  codex\t').models).toEqual([gpt])
  })

  it('folds a PADDED spelling of the sentinel into the untagged bucket', () => {
    // Trimming widens the set of wire values that can spell the sentinel, so
    // the fold has to run on the canonical form, not the raw one.
    const map = mergeModelsByProvider(undefined, `  ${UNTAGGED_MODELS_PROVIDER}  `, roster([opus]))
    expect(Object.keys(map)).toEqual([UNTAGGED_MODELS_PROVIDER])
    expect(selectOwnModelsForProvider(map, `  ${UNTAGGED_MODELS_PROVIDER}  `)).toBeNull()
  })

  it('folds a wire tag that spells the sentinel into the untagged bucket', () => {
    // The sentinel carries a NUL byte precisely so no provider name can reach
    // it; if one somehow does, it must not be able to plant a roster that the
    // selector then serves to every OTHER provider under a different pretext.
    const map = mergeModelsByProvider(undefined, UNTAGGED_MODELS_PROVIDER, roster([opus]))
    expect(Object.keys(map)).toEqual([UNTAGGED_MODELS_PROVIDER])
  })
})

describe('selectOwnModelsForProvider (#7728)', () => {
  const withUntagged: ModelsByProvider = {
    [UNTAGGED_MODELS_PROVIDER]: roster([opus], 'opus'),
    codex: roster([gpt], 'gpt-5.5'),
  }

  it("returns the provider's OWN roster", () => {
    expect(selectOwnModelsForProvider(withUntagged, 'codex')?.models).toEqual([gpt])
  })

  it('does NOT fall back to the untagged roster (an untagged list proves nothing)', () => {
    expect(selectOwnModelsForProvider(withUntagged, 'gemini')).toBeNull()
  })

  it('returns null for an unknown/blank provider and for the sentinel itself', () => {
    expect(selectOwnModelsForProvider(withUntagged, null)).toBeNull()
    expect(selectOwnModelsForProvider(withUntagged, '  ')).toBeNull()
    expect(selectOwnModelsForProvider(withUntagged, UNTAGGED_MODELS_PROVIDER)).toBeNull()
  })
})

describe('selectModelsForProvider (#7728)', () => {
  const mixed: ModelsByProvider = {
    'claude-sdk': roster([opus], 'opus'),
    codex: roster([gpt], 'gpt-5.5'),
  }

  it("returns the active provider's own roster, whichever arrived last", () => {
    expect(selectModelsForProvider(mixed, 'codex').models).toEqual([gpt])
    expect(selectModelsForProvider(mixed, 'codex').defaultModelId).toBe('gpt-5.5')
    expect(selectModelsForProvider(mixed, 'claude-sdk').models).toEqual([opus])
  })

  it('returns NOTHING for a known provider with no roster yet', () => {
    // The load-bearing case: never fall back to another provider's ids.
    expect(selectModelsForProvider(mixed, 'gemini')).toBe(EMPTY_MODEL_ROSTER)
    expect(selectModelsForProvider(mixed, 'gemini').models).toEqual([])
    expect(selectModelsForProvider(mixed, 'gemini').defaultModelId).toBeNull()
  })

  it('falls back to an UNTAGGED roster for a provider with none of its own', () => {
    // An older daemon tags nothing and has one registry — its roster is global,
    // exactly as it was before #7728. "Nobody said which provider" is not the
    // same as "this provider has nothing".
    const withUntagged: ModelsByProvider = { [UNTAGGED_MODELS_PROVIDER]: roster([opus], 'opus') }
    expect(selectModelsForProvider(withUntagged, 'codex').models).toEqual([opus])
  })

  it('stops serving the untagged roster once a SECOND roster is in play', () => {
    // The #7728 headline case, reachable on a MODERN daemon: ws-history.js
    // sends `provider: activeProvider`, null on a post-auth connect with no
    // active session, and getRegistryForProvider(null) answers with the CLAUDE
    // default registry — so the Claude roster lands untagged. An unconditional
    // untagged fallback then served those Claude ids to a codex session that
    // had not yet heard its own roster. Server-side tagging is #7759.
    const claudeUntaggedPlusCodex: ModelsByProvider = {
      [UNTAGGED_MODELS_PROVIDER]: roster([opus], 'opus'),
      codex: roster([gpt], 'gpt-5.5'),
    }
    expect(selectModelsForProvider(claudeUntaggedPlusCodex, 'gemini')).toBe(EMPTY_MODEL_ROSTER)
    expect(selectModelsForProvider(claudeUntaggedPlusCodex, 'gemini').models).toEqual([])
    // ...and the untagged roster is still global while it is the only one.
    const onlyUntagged: ModelsByProvider = { [UNTAGGED_MODELS_PROVIDER]: roster([opus], 'opus') }
    expect(selectModelsForProvider(onlyUntagged, 'gemini').models).toEqual([opus])
  })

  it('prefers the provider-tagged roster over the untagged one', () => {
    const both: ModelsByProvider = {
      [UNTAGGED_MODELS_PROVIDER]: roster([opus], 'opus'),
      codex: roster([gpt], 'gpt-5.5'),
    }
    expect(selectModelsForProvider(both, 'codex').models).toEqual([gpt])
  })

  it('serves the only known roster when the provider is UNKNOWN', () => {
    // No active session, or a server that did not report the session's provider:
    // with one roster in play there is no other provider to leak from, so the
    // pre-#7728 single-provider behaviour is preserved.
    const only: ModelsByProvider = { 'claude-sdk': roster([opus], 'opus') }
    expect(selectModelsForProvider(only, null).models).toEqual([opus])
    expect(selectModelsForProvider(only, undefined).models).toEqual([opus])
    expect(selectModelsForProvider(only, '  ').models).toEqual([opus])
  })

  it('serves NOTHING when the provider is unknown and two rosters are in play', () => {
    expect(selectModelsForProvider(mixed, null)).toBe(EMPTY_MODEL_ROSTER)
  })

  it('serves nothing for an empty or absent map', () => {
    expect(selectModelsForProvider({}, 'codex')).toBe(EMPTY_MODEL_ROSTER)
    expect(selectModelsForProvider(undefined, 'codex')).toBe(EMPTY_MODEL_ROSTER)
    expect(selectModelsForProvider(null, null)).toBe(EMPTY_MODEL_ROSTER)
  })

  it('EMPTY_MODEL_ROSTER is a stable identity (React memo deps) and is frozen', () => {
    expect(selectModelsForProvider({}, 'a')).toBe(selectModelsForProvider({}, 'b'))
    expect(Object.isFrozen(EMPTY_MODEL_ROSTER)).toBe(true)
  })
})
