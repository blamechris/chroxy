/**
 * E2E coverage for `chroxy deploy`.
 *
 * Covers src/cli/deploy-cmd.js. The real deploy command shells out to
 * `git status` and inspects the supervisor PID file; we only exercise
 * the help and dirty-tree paths to avoid mutating git state or signaling
 * a real supervisor.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { runCli, makeTempHome } from './__helpers/spawn-cli.js'

describe('chroxy deploy', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  it('--help advertises --dry-run and --skip-tests', async () => {
    const r = await runCli(['deploy', '--help'], { home })
    assert.equal(r.code, 0, `stderr: ${r.stderr}`)
    assert.match(r.stdout, /--dry-run/)
    assert.match(r.stdout, /--skip-tests/)
  })

  it('exits non-zero outside a git repo (cwd: temp HOME)', async () => {
    // home is a fresh tmpdir with no .git — `git status --porcelain` will
    // fail, which deploy treats as a fatal pre-check.
    const r = await runCli(
      ['deploy', '--dry-run', '--skip-tests'],
      { home, cwd: home, timeoutMs: 15000 },
    )
    assert.notEqual(r.code, 0)
    // The exact wording differs ("not a git repo" vs git's own error),
    // so just check the deploy preamble printed.
    assert.match(r.stdout + r.stderr, /\[deploy\]|not a git/i)
  })
})
