/**
 * E2E coverage for `chroxy tunnel`.
 *
 * Covers src/cli/tunnel-cmd.js. The setup flow is fully interactive and
 * shells out to `cloudflared`, so we only smoke-test help output here.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { runCli, makeTempHome } from './__helpers/spawn-cli.js'

describe('chroxy tunnel', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  it('prints --help showing the setup subcommand', async () => {
    const r = await runCli(['tunnel', '--help'], { home })
    assert.equal(r.code, 0, `stderr: ${r.stderr}`)
    assert.match(r.stdout, /tunnel/)
    assert.match(r.stdout, /setup/)
  })

  it('tunnel setup --help describes the setup flow', async () => {
    const r = await runCli(['tunnel', 'setup', '--help'], { home })
    assert.equal(r.code, 0)
    assert.match(r.stdout, /Interactive Cloudflare Named Tunnel setup/)
  })
})
