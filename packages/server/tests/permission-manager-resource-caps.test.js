import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionManager } from '../src/permission-manager.js'

/**
 * #6448 — resource-limit caps (DoS hardening) on PermissionManager:
 *   - concurrent pending permissions (bounds the maps + the per-request timers)
 *   - session-rules array length
 *   - raw tool-description length fed to redactValue (CPU)
 */
describe('PermissionManager resource-limit caps (#6448)', () => {
  it('auto-denies a new permission request once the pending cap is reached', async () => {
    const pm = new PermissionManager({ maxPendingPermissions: 2, timeoutMs: 60_000 })
    // Two requests stay pending (never answered).
    const p1 = pm.handlePermission('Bash', { command: 'a' }, null, 'approve')
    const p2 = pm.handlePermission('Bash', { command: 'b' }, null, 'approve')
    assert.equal(pm._pendingPermissions.size, 2, 'two requests are pending')

    // The third trips the cap → auto-denied immediately, NOT added to the map.
    const r3 = await pm.handlePermission('Bash', { command: 'c' }, null, 'approve')
    assert.equal(r3.behavior, 'deny')
    assert.match(r3.message, /too many pending/i)
    assert.equal(pm._pendingPermissions.size, 2, 'the over-cap request is not added')

    pm.destroy() // resolves p1/p2 (auto-deny) + clears their timers
    await Promise.all([p1, p2])
  })

  it('rejects setRules with more than the max session rules', () => {
    const pm = new PermissionManager()
    const tooMany = Array.from({ length: 101 }, () => ({ tool: 'Read', decision: 'allow' }))
    assert.throws(() => pm.setRules(tooMany), /too many rules/i)
    const atCap = Array.from({ length: 100 }, () => ({ tool: 'Read', decision: 'allow' }))
    assert.doesNotThrow(() => pm.setRules(atCap), 'exactly the cap is allowed')
    pm.destroy()
  })

  it('caps a huge tool description before redaction (output bounded + secret still redacted)', async () => {
    const pm = new PermissionManager({ timeoutMs: 60_000 })
    let emitted = null
    pm.on('permission_request', (p) => { emitted = p })
    // A 5MB description with a real-shape Anthropic key near the start — redaction
    // must run on the capped prefix, the shown window stays bounded, and the
    // secret (within the shown window) must still be redacted.
    const secret = 'sk-ant-api03-' + 'A1b2C3d4e5'.repeat(5) // >=40 chars after the prefix → matches the redact pattern
    const huge = secret + ' ' + 'x'.repeat(5 * 1024 * 1024)
    const p = pm.handlePermission('Bash', { description: huge }, null, 'approve')
    assert.ok(emitted, 'permission_request emitted synchronously')
    assert.ok(emitted.description.length <= 200, 'shown description stays bounded')
    assert.ok(!emitted.description.includes('sk-ant-api03'), 'the secret is redacted in the shown window')

    pm.destroy()
    await p
  })
})
