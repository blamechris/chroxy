/**
 * #8151 round-2 review (Critical 1) — exercises the PRODUCTION
 * `ptyMod = await import('node-pty')` branch of `_spawnPty` (claude-tui) and
 * `start()` (user-shell), not just the `_ptyModOverride` test seam.
 *
 * The round-2 review found that claude-tui-session.test.js's and
 * user-shell-session.test.js's "start() rejects with the actionable
 * node-pty-unavailable message" tests only ever set `_ptyModOverride` to a
 * throwing function — they never made the REAL dynamic import fail. The
 * reviewer proved this by reverting ONLY the production catch block in each
 * file (restoring the pre-#8151 bare rethrow) and running the full suite:
 * 51 files / 2229 tests stayed green, because nothing exercised that branch.
 *
 * Fixed here by running the real `start()` in a CHILD PROCESS with a
 * `node:module` `registerHooks` resolve hook that makes `import('node-pty')`
 * reject — see `fixtures/reject-node-pty-import.mjs` — loaded via `--import`
 * ahead of `fixtures/production-pty-import-child.mjs`, which constructs the
 * real session class (no override) and calls its real `start()`.
 *
 * The child process ALSO loads `tests/_setup.mjs` first (same sandboxed
 * test runner as every other server test — fs write sandbox +
 * CHROXY_CONFIG_DIR redirect) so this exercise never touches real user
 * state, per the review's explicit requirement.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SETUP = join(__dirname, '_setup.mjs')
const HOOK = join(__dirname, 'fixtures', 'reject-node-pty-import.mjs')
const CHILD = join(__dirname, 'fixtures', 'production-pty-import-child.mjs')

function runChild(target) {
  const stdout = execFileSync(
    process.execPath,
    ['--import', SETUP, '--import', HOOK, CHILD, target],
    { encoding: 'utf8' },
  )
  // The child may log a WARN line (e.g. the sandboxed ensureCwdTrusted
  // best-effort write) ahead of its one JSON result line — take the LAST
  // non-blank line, not the whole stdout blob.
  const lines = stdout.trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

describe("production import('node-pty') failure — real child process, no _ptyModOverride (#8151 round-2 Critical 1)", () => {
  it('ClaudeTuiSession.start() rejects with the actionable message when the REAL import(\'node-pty\') rejects', () => {
    const result = runChild('claude-tui')
    assert.equal(result.unexpectedSuccess, undefined, 'the real import must actually fail under the resolve hook')
    assert.equal(result.code, 'PTY_UNAVAILABLE')
    assert.match(result.message, /^node-pty is unavailable/)
    assert.match(result.message, /claude-sdk/)
    assert.match(result.message, /simulated by reject-node-pty-import\.mjs/)
  })

  it('UserShellSession.start() rejects with the actionable message when the REAL import(\'node-pty\') rejects', () => {
    const result = runChild('user-shell')
    assert.equal(result.unexpectedSuccess, undefined, 'the real import must actually fail under the resolve hook')
    assert.equal(result.code, 'PTY_UNAVAILABLE')
    assert.match(result.message, /^node-pty is unavailable/)
    assert.match(result.message, /claude-sdk/)
    assert.match(result.message, /simulated by reject-node-pty-import\.mjs/)
  })
})
