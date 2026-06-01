/**
 * E2E coverage for `chroxy doctor`.
 *
 * Covers src/cli/doctor-cmd.js.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { pickPort, runCli, makeTempHome } from './__helpers/spawn-cli.js'

describe('chroxy doctor', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  it('prints the Chroxy Doctor banner and a summary line', async () => {
    // Bind to a random free port to avoid flagging "port in use" on the
    // default 8765 if some other dev server is listening there locally.
    const r = await runCli(['doctor', '--port', String(pickPort())], { home })
    // Exit code can be 0 or 1 depending on whether cloudflared/other
    // optional deps are installed on the test machine, so don't assert
    // on it directly.
    assert.match(r.stdout, /Chroxy Doctor/)
    // Final summary line is one of these two messages.
    assert.match(r.stdout, /(All checks passed\.|Some checks failed\.)/)
  })

  it('prints --help with the expected flags', async () => {
    const r = await runCli(['doctor', '--help'], { home })
    assert.equal(r.code, 0)
    assert.match(r.stdout, /--port/)
    assert.match(r.stdout, /--provider/)
  })
})
