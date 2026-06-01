/**
 * E2E coverage for `chroxy init` via the CLI subprocess.
 *
 * The fully-interactive provider-picker happy path is covered by
 * `cli-init-cmd.test.js` (which stubs prompt/fs and exercises runInitCmd
 * directly). Here we focus on the spawn boundary: the binary launches,
 * prints its banner, advertises --force, and the overwrite-confirmation
 * prompt-and-decline path exits cleanly without touching disk.
 *
 * Why we don't drip-feed multiple newlines: shared.js creates a fresh
 * readline.createInterface() per prompt. When the first interface is
 * closed, buffered stdin bytes are not handed off to the next interface,
 * so any input intended for prompt #2 is silently dropped. The single-
 * prompt "decline overwrite" path sidesteps that quirk entirely.
 */
import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runCli, makeTempHome } from './__helpers/spawn-cli.js'

describe('chroxy init', () => {
  describe('with existing config', () => {
    const { home, cleanup } = makeTempHome()
    after(cleanup)

    const configPath = join(home, '.chroxy', 'config.json')
    const originalContents = JSON.stringify({ port: 9999, providers: ['claude-sdk'] }, null, 2)

    before(() => {
      mkdirSync(join(home, '.chroxy'), { recursive: true })
      writeFileSync(configPath, originalContents)
    })

    it('prompts to overwrite and exits cleanly when the user declines', async () => {
      const r = await runCli(['init'], { home, input: 'n\n', keepStdinOpen: true })
      assert.equal(r.code, 0, `init failed: ${r.stderr}`)
      assert.match(r.stdout, /Chroxy Setup/)
      assert.match(r.stdout, /Config already exists/)
      assert.match(r.stdout, /Keeping existing config/)
      // Config file must not have been modified.
      assert.ok(existsSync(configPath))
      const afterContents = readFileSync(configPath, 'utf-8')
      assert.equal(afterContents, originalContents)
    })
  })

  it('--help prints the expected flags', async () => {
    const { home, cleanup } = makeTempHome()
    try {
      const r = await runCli(['init', '--help'], { home })
      assert.equal(r.code, 0)
      assert.match(r.stdout, /--force/)
      assert.match(r.stdout, /Initialize Chroxy configuration/)
    } finally {
      cleanup()
    }
  })
})
