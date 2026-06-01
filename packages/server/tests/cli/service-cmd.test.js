/**
 * E2E coverage for `chroxy service`.
 *
 * Covers src/cli/service-cmd.js. We never actually install or start a
 * launchd/systemd service — that would mutate the user's machine. The
 * tests focus on the help output and the "not installed" path of the
 * status / start / stop subcommands.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { runCli, makeTempHome } from './__helpers/spawn-cli.js'

describe('chroxy service', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  it('--help lists the install / uninstall / start / stop / status subcommands', async () => {
    const r = await runCli(['service', '--help'], { home })
    assert.equal(r.code, 0, `stderr: ${r.stderr}`)
    for (const sub of ['install', 'uninstall', 'start', 'stop', 'status']) {
      assert.match(r.stdout, new RegExp(`\\b${sub}\\b`), `missing subcommand: ${sub}`)
    }
  })

  it('service status reports "Installed: No" on a fresh HOME', async () => {
    const r = await runCli(['service', 'status'], { home })
    // Status prints the banner and exits 0 even when not installed.
    assert.equal(r.code, 0, `stderr: ${r.stderr}`)
    assert.match(r.stdout, /Chroxy Service Status/)
    assert.match(r.stdout, /Installed:\s+No/)
  })

  it('service start fails with a helpful message when not installed', async () => {
    const r = await runCli(['service', 'start'], { home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /not installed/)
  })

  it('service stop fails with a helpful message when not installed', async () => {
    const r = await runCli(['service', 'stop'], { home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /not installed/)
  })

  it('service uninstall fails when nothing is installed', async () => {
    const r = await runCli(['service', 'uninstall'], { home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /not installed/)
  })

  // Skipped: actually installing a system service mutates ~/Library or
  // /etc/systemd. Re-enable manually when triaging install-cmd regressions.
  it.skip('service install registers a launchd plist', async () => {
    const r = await runCli(['service', 'install'], { home })
    assert.equal(r.code, 0)
  })
})
