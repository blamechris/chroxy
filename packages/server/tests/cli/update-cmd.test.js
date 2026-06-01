/**
 * E2E coverage for `chroxy update`.
 *
 * Covers src/cli/update-cmd.js. The real update command hits the GitHub
 * Releases API, which we don't want to depend on in tests, so we only
 * exercise the --help path. A full happy-path test would need to stub
 * global.fetch, which isn't possible across a subprocess boundary.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { runCli, makeTempHome } from './__helpers/spawn-cli.js'

describe('chroxy update', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  it('--help describes the update command', async () => {
    const r = await runCli(['update', '--help'], { home })
    assert.equal(r.code, 0, `stderr: ${r.stderr}`)
    assert.match(r.stdout, /Check for available updates/)
  })

  // Skipped: the live update check makes an outbound HTTPS request to
  // GitHub. Re-enable manually when triaging update-cmd regressions.
  it.skip('chroxy update queries the GitHub Releases API', async () => {
    const r = await runCli(['update'], { home, timeoutMs: 20000 })
    assert.ok(r.code === 0 || r.code === 1, `unexpected code: ${r.code}`)
    assert.match(r.stdout + r.stderr, /Chroxy v|Update available|Failed to check/)
  })
})
