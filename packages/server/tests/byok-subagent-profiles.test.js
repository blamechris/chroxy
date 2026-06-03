import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SUBAGENT_PROFILES,
  SUBAGENT_PROFILE_NAMES,
  getSubagentProfile,
} from '../src/byok-subagent-profiles.js'

/**
 * #5018: subagent profile registry. The byok Task tool looks up profiles
 * by id when the model passes `subagent_type` on the tool input. These
 * tests pin the registry shape so a future addition can't silently change
 * a stable contract (id name, toolSet shape, frozen guarantee).
 */

describe('SUBAGENT_PROFILES (#5018)', () => {
  it('seeds at least the general-purpose profile (Phase 1 MVP)', () => {
    // The MVP scope-note in PR #5018 keeps the seed minimal (1-3 profiles).
    // general-purpose is the canonical default and MUST be present so a
    // model that requests "general-purpose" never falls into the unknown
    // path.
    assert.ok(SUBAGENT_PROFILES['general-purpose'],
      'general-purpose profile must be in the registry')
  })

  it('every profile has a non-empty systemPrompt and a toolSet', () => {
    for (const [id, profile] of Object.entries(SUBAGENT_PROFILES)) {
      assert.equal(typeof profile.systemPrompt, 'string',
        `profile ${id} must have a string systemPrompt`)
      assert.ok(profile.systemPrompt.length > 20,
        `profile ${id} systemPrompt is suspiciously short`)
      assert.ok(
        profile.toolSet === 'all' || Array.isArray(profile.toolSet),
        `profile ${id} toolSet must be the string 'all' or an array of tool names`,
      )
      if (Array.isArray(profile.toolSet)) {
        assert.ok(profile.toolSet.length > 0,
          `profile ${id} toolSet array must not be empty`)
        for (const name of profile.toolSet) {
          assert.equal(typeof name, 'string',
            `profile ${id} toolSet entries must be strings`)
        }
      }
    }
  })

  it('SUBAGENT_PROFILES is frozen at the top level', () => {
    assert.ok(Object.isFrozen(SUBAGENT_PROFILES),
      'SUBAGENT_PROFILES must be frozen so subagent code cannot mutate it')
  })

  it('each profile bundle is frozen', () => {
    for (const [id, profile] of Object.entries(SUBAGENT_PROFILES)) {
      assert.ok(Object.isFrozen(profile),
        `profile ${id} must be frozen`)
    }
  })

  it('SUBAGENT_PROFILE_NAMES is the sorted list of registry keys', () => {
    assert.deepEqual([...SUBAGENT_PROFILE_NAMES], Object.keys(SUBAGENT_PROFILES).sort())
  })

  it('SUBAGENT_PROFILE_NAMES is frozen', () => {
    assert.ok(Object.isFrozen(SUBAGENT_PROFILE_NAMES))
  })
})

describe('getSubagentProfile() (#5018)', () => {
  it('returns the profile bundle for a known id', () => {
    const profile = getSubagentProfile('general-purpose')
    assert.ok(profile)
    assert.equal(profile, SUBAGENT_PROFILES['general-purpose'],
      'getSubagentProfile must return the same frozen reference')
  })

  it('returns null for unknown ids', () => {
    assert.equal(getSubagentProfile('nope-never'), null)
  })

  it('returns null for empty string', () => {
    assert.equal(getSubagentProfile(''), null)
  })

  it('returns null for non-string inputs (defensive)', () => {
    assert.equal(getSubagentProfile(undefined), null)
    assert.equal(getSubagentProfile(null), null)
    assert.equal(getSubagentProfile(42), null)
    assert.equal(getSubagentProfile({}), null)
  })
})
