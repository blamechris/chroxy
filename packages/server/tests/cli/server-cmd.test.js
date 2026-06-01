/**
 * E2E coverage for `chroxy start` and `chroxy dev`.
 *
 * Covers src/cli/server-cmd.js. We never let the real server run — we
 * either pass --help, or rely on the missing-config / bad-flag error
 * paths so the CLI exits in milliseconds.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { runCli, makeTempHome } from './__helpers/spawn-cli.js'

describe('chroxy start / dev', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  it('start --help lists the shared server flags', async () => {
    const r = await runCli(['start', '--help'], { home })
    assert.equal(r.code, 0, `stderr: ${r.stderr}`)
    assert.match(r.stdout, /Start the Chroxy server/)
    assert.match(r.stdout, /--config/)
    assert.match(r.stdout, /--tunnel/)
    assert.match(r.stdout, /--port|--config/) // sanity: at least one shared opt
  })

  it('dev --help describes development mode', async () => {
    const r = await runCli(['dev', '--help'], { home })
    assert.equal(r.code, 0)
    assert.match(r.stdout, /development mode/i)
  })

  it('start exits 1 when no config exists (missing init)', async () => {
    // Fresh HOME → no ~/.chroxy/config.json → loadAndMergeConfig() will
    // print "No config found" and process.exit(1) immediately.
    const r = await runCli(['start'], { home, timeoutMs: 10000 })
    assert.equal(r.code, 1, `stdout: ${r.stdout} stderr: ${r.stderr}`)
    assert.match(r.stderr, /No config found/)
  })

  it('start with --config pointing at a missing file errors and exits 1', async () => {
    const r = await runCli(
      ['start', '--config', '/tmp/definitely-not-a-real-config-12345.json'],
      { home, timeoutMs: 10000 },
    )
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Config file not found/)
  })
})
