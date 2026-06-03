import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SUBAGENT_PROFILES,
  SUBAGENT_PROFILE_NAMES,
  getSubagentProfile,
} from '../src/byok-subagent-profiles.js'
import { SESSION_PREAMBLE_MAX_LENGTH } from '../src/base-session.js'

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

  it('every profile systemPrompt fits under SESSION_PREAMBLE_MAX_LENGTH (#5073)', () => {
    // #5073: the byok Task tool applies a profile to a child session via
    // direct field assignment (`child.sessionPreamble = profile.systemPrompt`)
    // rather than the `setSessionPreamble` setter, intentionally bypassing
    // the 4000-char user-preamble cap for in-source profiles we control.
    // That's fine for today's seed (~200-400 chars each), but a future
    // contributor could add a profile with a multi-kilobyte systemPrompt
    // and the implicit "fits in the system-prompt slot" invariant would
    // break silently — `_buildSystemPrompt` joins the preamble with the
    // chroxy context hint + skills text, and an over-long preamble could
    // push the combined prompt past Anthropic's token budget.
    //
    // Pinning every profile under SESSION_PREAMBLE_MAX_LENGTH here makes
    // that invariant explicit so a future profile addition fails at CI
    // rather than at runtime.
    for (const [id, profile] of Object.entries(SUBAGENT_PROFILES)) {
      assert.ok(
        profile.systemPrompt.length <= SESSION_PREAMBLE_MAX_LENGTH,
        `profile ${id} systemPrompt (${profile.systemPrompt.length} chars) `
        + `exceeds SESSION_PREAMBLE_MAX_LENGTH (${SESSION_PREAMBLE_MAX_LENGTH})`,
      )
    }
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
