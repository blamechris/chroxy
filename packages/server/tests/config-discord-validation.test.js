import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../src/config.js'

// #5453: validateConfig warns on unrecognised notifications.discord keys so a
// typo'd knob (silently ignored → default behavior) or a test-injection seam
// (spread into the sink → fails it closed) surfaces instead of silently no-op'ing.
function discordWarnings(discord) {
  return validateConfig({ notifications: { discord } }).warnings.filter(w => w.includes('notifications.discord'))
}

describe('validateConfig — notifications.discord unknown keys (#5453)', () => {
  it("warns on a typo'd knob, naming the key and the supported set", () => {
    const ws = discordWarnings({ botname: 'oops' }) // typo of botName
    const w = ws.find(x => x.includes("'notifications.discord.botname'"))
    assert.ok(w, 'expected an unknown-key warning for the typo')
    assert.match(w, /unknown key/)
    assert.match(w, /botName/) // names the supported set
  })

  it('warns on a test-injection seam key spread into the sink', () => {
    const ws = discordWarnings({ resolveWebhookUrl: 'x', sleepImpl: 1, now: 2 })
    for (const seam of ['resolveWebhookUrl', 'sleepImpl', 'now']) {
      assert.ok(ws.some(w => w.includes(`'notifications.discord.${seam}'`) && w.includes('unknown key')), `expected unknown-key warning for ${seam}`)
    }
  })

  it('uses non-fatal "Invalid value"-style wording and never throws (cosmetic typo must not abort startup)', () => {
    let result
    assert.doesNotThrow(() => { result = validateConfig({ notifications: { discord: { botname: 'x' } } }) })
    assert.ok(result.warnings.some(w => w.startsWith("Invalid value for 'notifications.discord.botname'")))
  })

  it('does NOT warn-as-unknown for recognised knobs (incl. #5676 watchdog tunables)', () => {
    const ws = discordWarnings({
      botName: 'Bot', billingAlerts: true, defaultColor: 0, permissionColor: 1, errorColor: 2,
      colors: {}, updateThrottleMs: 0, heartbeatIntervalMs: 0, pruneAfterMs: 0,
      staleAfterMs: 600000, offlineAfterMs: 1800000,
    })
    assert.ok(!ws.some(w => w.includes('unknown key')), `recognised knobs should not warn as unknown, got: ${JSON.stringify(ws)}`)
  })

  it('validates the #5676 watchdog tunables as numbers >= 0 (not unknown)', () => {
    const ws = discordWarnings({ staleAfterMs: -1, offlineAfterMs: 'nope' })
    assert.ok(ws.some(w => w.includes("'notifications.discord.staleAfterMs'") && w.includes('number >= 0')))
    assert.ok(ws.some(w => w.includes("'notifications.discord.offlineAfterMs'") && w.includes('number >= 0')))
    assert.ok(!ws.some(w => w.includes('unknown key')), 'known-but-invalid knobs get a value warning, not unknown-key')
  })

  it('an empty or non-object discord block produces no unknown-key warnings', () => {
    assert.ok(!discordWarnings({}).some(w => w.includes('unknown key')), 'empty block → no unknown keys')
    // a non-object block early-returns with a type warning and never enters the key loop
    assert.doesNotThrow(() => discordWarnings('nope'))
    assert.ok(!discordWarnings('nope').some(w => w.includes('unknown key')))
  })

  it('does NOT double-warn secret keys as unknown (they get their own secret warning)', () => {
    const ws = discordWarnings({ webhookUrl: 'https://x', webhook: 'y', url: 'z' })
    assert.ok(!ws.some(w => w.includes('unknown key')), 'secret keys must not be reported as unknown')
    // …but they still get the specific "it's a secret" warning.
    assert.ok(ws.some(w => w.includes("'notifications.discord.webhookUrl'") && w.includes('secret')))
  })
})
