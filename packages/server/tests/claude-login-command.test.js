import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAUDE_LOGIN_COMMAND } from '../src/utils/claude-login-command.js'
// claude-tui-session.js first: pty-driver.js and it import each other, and only this
// order evaluates cleanly (every other test that touches either follows it).
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { AUTH_REQUIRED_MESSAGE } from '../src/claude-tui/pty-driver.js'
import { SdkSession } from '../src/sdk-session.js'

// #8223 — one spelling of the command that signs `claude` in. The server defines it
// once (utils/claude-login-command.js); the dashboard and the app read the copy in
// @chroxy/store-core. The two packages cannot share a module, so this test is what
// keeps them equal — and keeps the server's own messages built from the constant
// rather than from a hand-typed copy.
describe('CLAUDE_LOGIN_COMMAND (#8223)', () => {
  it('is the current spelling, claude 2.1.x `auth login`', () => {
    assert.equal(CLAUDE_LOGIN_COMMAND, 'claude auth login')
  })

  it('equals the constant @chroxy/store-core hands to both client chips', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store-core', 'src', 'error-presentation.ts'), 'utf8')
    const m = /export const CLAUDE_LOGIN_COMMAND = '([^']+)'/.exec(src)
    assert.ok(m, 'store-core must export CLAUDE_LOGIN_COMMAND as a string literal')
    assert.equal(m[1], CLAUDE_LOGIN_COMMAND)
  })

  it('is what the server messages and hints tell the user to run', () => {
    assert.ok(AUTH_REQUIRED_MESSAGE.includes(`\`${CLAUDE_LOGIN_COMMAND}\``), AUTH_REQUIRED_MESSAGE)
    assert.ok(SdkSession.preflight.credentials.hint.includes(CLAUDE_LOGIN_COMMAND), SdkSession.preflight.credentials.hint)
    assert.ok(ClaudeTuiSession.preflight.credentials.hint.includes(CLAUDE_LOGIN_COMMAND), ClaudeTuiSession.preflight.credentials.hint)
    for (const text of [AUTH_REQUIRED_MESSAGE, SdkSession.preflight.credentials.hint, ClaudeTuiSession.preflight.credentials.hint]) {
      assert.ok(!/claude login/.test(text), `stale command in: ${text}`)
    }
  })
})
