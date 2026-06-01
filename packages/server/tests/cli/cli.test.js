/**
 * Top-level chroxy CLI entry tests — version, help, unknown commands.
 *
 * Covers src/cli.js (the Commander dispatch root).
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { runCli, makeTempHome } from './__helpers/spawn-cli.js'

const __filename = fileURLToPath(import.meta.url)
const SERVER_PKG = join(dirname(__filename), '..', '..')
const pkg = JSON.parse(readFileSync(join(SERVER_PKG, 'package.json'), 'utf-8'))

describe('chroxy CLI entry (cli.js)', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  it('prints help with --help and exits 0', async () => {
    const r = await runCli(['--help'], { home })
    assert.equal(r.code, 0, `stderr: ${r.stderr}`)
    assert.match(r.stdout, /Usage: chroxy/)
    assert.match(r.stdout, /Remote terminal for Claude Code/)
    // All 12 registered commands should appear in help output.
    for (const cmd of [
      'init', 'start', 'dev', 'config', 'tunnel', 'doctor',
      'deploy', 'sessions', 'resume', 'service', 'update', 'status',
    ]) {
      assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `help missing command: ${cmd}`)
    }
  })

  it('prints the package.json version with --version', async () => {
    const r = await runCli(['--version'], { home })
    assert.equal(r.code, 0, `stderr: ${r.stderr}`)
    assert.equal(r.stdout.trim(), pkg.version)
  })

  it('rejects unknown commands with non-zero exit', async () => {
    const r = await runCli(['definitely-not-a-real-command'], { home })
    assert.notEqual(r.code, 0)
    // Commander writes the error to stderr.
    assert.match(r.stderr + r.stdout, /unknown command|error/i)
  })
})
