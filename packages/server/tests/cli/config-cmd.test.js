/**
 * E2E coverage for `chroxy config`.
 *
 * Covers src/cli/config-cmd.js. There's no `set` subcommand — `chroxy
 * config` just prints the resolved config — so we exercise both the
 * "no config" error path and the happy "config exists" path.
 *
 * NB: The shared.js CONFIG_FILE is resolved from os.homedir() at module
 * load time, so we exercise the path via the spawn helper which sets HOME.
 */
import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runCli, makeTempHome } from './__helpers/spawn-cli.js'

describe('chroxy config', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  it('errors when no config file exists', async () => {
    const r = await runCli(['config'], { home })
    assert.equal(r.code, 1)
    assert.match(r.stdout, /No config found/)
  })

  describe('with config present', () => {
    const populatedHome = makeTempHome()
    after(populatedHome.cleanup)

    before(() => {
      const configDir = join(populatedHome.home, '.chroxy')
      mkdirSync(configDir, { recursive: true })
      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({
          port: 9876,
          apiToken: 'test-token-xyz',
          providers: ['claude-sdk'],
          tunnel: 'quick',
        }, null, 2),
      )
    })

    it('prints the configured port, tunnel mode, and token', async () => {
      const r = await runCli(['config'], { home: populatedHome.home })
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)
      assert.match(r.stdout, /Current Configuration/)
      assert.match(r.stdout, /Port: 9876/)
      assert.match(r.stdout, /Tunnel: Quick/)
      assert.match(r.stdout, /test-token-xyz/)
    })
  })
})
