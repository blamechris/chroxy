/**
 * Tests for the per-provider built-in slash command registry (#3856).
 *
 * Locks the contract that listSlashCommands relies on:
 *   - per-provider keying (no cross-pollination between Claude & Codex)
 *   - `requiresModelSwitch` is gated on the runtime capability flag
 *   - `source: 'builtin'` is stamped on every emitted entry
 *   - unknown providers return [] (safe default — see browser.js)
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_COMMANDS, getBuiltinCommands } from '../src/builtin-commands.js'

describe('builtin-commands registry', () => {
  it('exposes a non-empty list for every shipped provider', () => {
    const expected = ['claude-sdk', 'claude-cli', 'claude-tui', 'claude-byok', 'codex', 'gemini']
    for (const name of expected) {
      assert.ok(Array.isArray(BUILTIN_COMMANDS[name]), `missing registry for ${name}`)
      assert.ok(BUILTIN_COMMANDS[name].length > 0, `${name} registry is empty`)
    }
  })

  it('every Claude provider exposes /clear, /compact, /cost', () => {
    for (const name of ['claude-sdk', 'claude-cli', 'claude-tui', 'claude-byok']) {
      const names = BUILTIN_COMMANDS[name].map(c => c.name)
      assert.ok(names.includes('clear'), `${name} missing /clear`)
      assert.ok(names.includes('compact'), `${name} missing /compact`)
      assert.ok(names.includes('cost'), `${name} missing /cost`)
    }
  })

  it('codex exposes /clear and /new but NOT /compact', () => {
    const names = BUILTIN_COMMANDS['codex'].map(c => c.name)
    assert.ok(names.includes('clear'))
    assert.ok(names.includes('new'))
    assert.ok(!names.includes('compact'), 'codex should not surface Claude-only /compact')
  })
})

describe('getBuiltinCommands()', () => {
  it('returns an empty list for null/unknown providers', () => {
    assert.deepEqual(getBuiltinCommands(null), [])
    assert.deepEqual(getBuiltinCommands(''), [])
    assert.deepEqual(getBuiltinCommands('not-a-real-provider'), [])
  })

  it('stamps source=builtin on every entry', () => {
    const out = getBuiltinCommands('claude-sdk', { modelSwitch: true })
    assert.ok(out.length > 0)
    for (const cmd of out) {
      assert.equal(cmd.source, 'builtin')
      assert.equal(typeof cmd.name, 'string')
      assert.equal(typeof cmd.description, 'string')
    }
  })

  it('includes /model when capabilities.modelSwitch is true', () => {
    const out = getBuiltinCommands('claude-sdk', { modelSwitch: true })
    assert.ok(out.find(c => c.name === 'model'), 'should include /model')
  })

  it('omits /model when capabilities.modelSwitch is false (claude-tui)', () => {
    // Mirrors claude-tui-session.js:225 — TUI cannot hot-swap models.
    const out = getBuiltinCommands('claude-tui', { modelSwitch: false })
    assert.ok(!out.find(c => c.name === 'model'), 'should omit /model when capability is off')
    // But the other commands should still be there.
    assert.ok(out.find(c => c.name === 'clear'))
  })

  it('omits /model when capabilities object is missing entirely', () => {
    const out = getBuiltinCommands('claude-sdk', null)
    assert.ok(!out.find(c => c.name === 'model'))
  })

  it('codex and Claude do not cross-pollinate', () => {
    const claude = getBuiltinCommands('claude-sdk', { modelSwitch: true }).map(c => c.name)
    const codex = getBuiltinCommands('codex', { modelSwitch: true }).map(c => c.name)
    assert.ok(claude.includes('compact'), 'claude should have /compact')
    assert.ok(!codex.includes('compact'), 'codex should not have /compact')
    assert.ok(codex.includes('new'), 'codex should have /new')
    assert.ok(!claude.includes('new'), 'claude should not have /new')
  })
})
