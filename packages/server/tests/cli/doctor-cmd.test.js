/**
 * E2E coverage for `chroxy doctor`.
 *
 * Covers src/cli/doctor-cmd.js.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pickPort, runCli, makeTempHome } from './__helpers/spawn-cli.js'

describe('chroxy doctor', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  it('prints the Chroxy Doctor banner and a summary line', async () => {
    // Pass a high random port (not reserved, just unlikely-to-be-bound)
    // so the "port in use" probe doesn't flag the default 8765 when a
    // local dev server is already listening there.
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

  it('checks the port selected by config, then env, then the flag', async () => {
    const configPort = pickPort()
    const envPort = configPort + 1
    const flagPort = configPort + 2
    mkdirSync(join(home, '.chroxy'), { recursive: true })
    writeFileSync(join(home, '.chroxy', 'config.json'), JSON.stringify({ port: configPort }))

    const cases = [
      { args: ['doctor'], env: {}, port: configPort },
      { args: ['doctor'], env: { PORT: String(envPort) }, port: envPort },
      { args: ['doctor', '--port', String(flagPort)], env: { PORT: String(envPort) }, port: flagPort },
    ]
    for (const { args, env, port } of cases) {
      const r = await runCli(args, { home, env })
      assert.equal(r.timedOut, false)
      assert.ok(new RegExp(`Port\\s+${port} is (?:available|in use)`).test(r.stdout), `doctor checked port ${port}`)
    }
  })
})
