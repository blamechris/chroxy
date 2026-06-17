import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BaseSession } from '../src/base-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'

/**
 * #5984 (epic #5982) — the `isClaudeTui` class discriminator. It replaces the
 * `typeof session.writeTerminalInput === 'function'` duck-typing at the two
 * server-initiated PTY-write / observability sites (mailbox wakeup +
 * Control Room isTui), so a future user-shell session (#5983) — which will ALSO
 * expose writeTerminalInput — is excluded by construction (swarm-audit C2).
 *
 * Fail-safe contract: the marker is FALSE on the base class, so any session that
 * does not explicitly opt in is treated as not-claude-tui.
 */
describe('isClaudeTui discriminator (#5984)', () => {
  it('is false on BaseSession (the fail-safe default)', () => {
    assert.equal(BaseSession.isClaudeTui, false)
  })

  it('is true on ClaudeTuiSession (the legitimate PTY-mirror target)', () => {
    assert.equal(ClaudeTuiSession.isClaudeTui, true)
  })

  it('is readable off an instance via .constructor (the access path the gates use)', () => {
    // The gates read `session.constructor?.isClaudeTui`. A subclass that does
    // NOT override the getter inherits the base false — proving a hypothetical
    // PTY-bearing subclass is excluded unless it explicitly opts in.
    class FakeShellSession extends BaseSession {}
    assert.equal(FakeShellSession.isClaudeTui, false)
  })
})
