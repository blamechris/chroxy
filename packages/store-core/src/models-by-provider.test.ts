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

  it('serves an UNTAGGED roster only to an UNKNOWN provider, never to a named one', () => {
    // A pre-provider daemon tags neither its rosters NOR its session entries,
    // so the lookup provider is null and the single-roster rule serves it —
    // exactly as it was served before #7728. A daemon that names the session's
    // provider is a different claim, and an untagged roster is no evidence
    // about it: "nobody said which provider" must not read as "said codex".
    const onlyUntagged: ModelsByProvider = { [UNTAGGED_MODELS_PROVIDER]: roster([opus], 'opus') }
    expect(selectModelsForProvider(onlyUntagged, null).models).toEqual([opus])
    expect(selectModelsForProvider(onlyUntagged, undefined).models).toEqual([opus])
    expect(selectModelsForProvider(onlyUntagged, 'codex')).toBe(EMPTY_MODEL_ROSTER)
    expect(selectModelsForProvider(onlyUntagged, 'codex').models).toEqual([])
  })

  it('never serves the untagged roster to a known provider, with or without a second roster', () => {
    // The #7728 headline case. It was reachable on the daemon of that release:
    // ws-history.js sent `provider: activeProvider`, null on a post-auth
    // connect with no active session, and getRegistryForProvider(null) answers
    // with the CLAUDE default registry — so the Claude roster landed untagged.
    // #7759 tags every server sender, so this shape now reaches a current
    // client only from a pre-provider daemon (or a sender that regresses), and
    // the rule is asserted here rather than inferred from the producer.
    const claudeUntaggedPlusCodex: ModelsByProvider = {
      [UNTAGGED_MODELS_PROVIDER]: roster([opus], 'opus'),
      codex: roster([gpt], 'gpt-5.5'),
    }
    expect(selectModelsForProvider(claudeUntaggedPlusCodex, 'gemini')).toBe(EMPTY_MODEL_ROSTER)
    expect(selectModelsForProvider(claudeUntaggedPlusCodex, 'gemini').models).toEqual([])
    // ...and the SOLE-untagged shape is the same answer, not a fallback. An
    // earlier revision gated the untagged fallback on "only one roster in play",
    // which this map satisfies — see the scenario cell below.
    const onlyUntagged: ModelsByProvider = { [UNTAGGED_MODELS_PROVIDER]: roster([opus], 'opus') }
    expect(selectModelsForProvider(onlyUntagged, 'gemini')).toBe(EMPTY_MODEL_ROSTER)
    expect(selectModelsForProvider(onlyUntagged, 'gemini').models).toEqual([])
  })

  it('SCENARIO: post-auth connect with no session, then a switch to codex, offers ZERO chips', () => {
    // The reachable leak, end to end, in the order the client actually sees it
    // (PR #7758 re-review). A client connects post-auth with no active session:
    // ws-history.js sends `provider: activeProvider` — null — and
    // getRegistryForProvider(null) answers with the CLAUDE default registry, so
    // the client's map is exactly one UNTAGGED Claude roster. The user then
    // opens a codex session; switchSession sets activeSessionId optimistically
    // and only THEN asks the server, so for one tunnel round trip the selector
    // is asked for 'codex' against that single untagged Claude roster.
    const afterPostAuthConnect = mergeModelsByProvider(undefined, null, roster([opus], 'opus'))
    expect(Object.keys(afterPostAuthConnect)).toEqual([UNTAGGED_MODELS_PROVIDER])

    const shown = selectModelsForProvider(afterPostAuthConnect, 'codex')
    expect(shown).toBe(EMPTY_MODEL_ROSTER)
    // No chip is rendered, so no Claude id can be tapped into `set_model` on a
    // codex session — the whole point of #7728.
    expect(shown.models.map(m => m.id)).toEqual([])
    expect(shown.defaultModelId).toBeNull()

    // ...and one round trip later the codex roster arrives and the picker fills.
    const afterCodexRoster = mergeModelsByProvider(afterPostAuthConnect, 'codex', roster([gpt], 'gpt-5.5'))
    expect(selectModelsForProvider(afterCodexRoster, 'codex').models).toEqual([gpt])
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
