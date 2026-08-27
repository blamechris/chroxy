/**
 * CALL-SITE coverage for the `--test-force-exit` refusal in THIS package's
 * `tests/_setup.mjs` (#7400).
 *
 * The module and its behaviour are covered once, in
 * `scripts/__tests__/no-test-force-exit.test.mjs`. What is package-local — and
 * what silently rots if nobody asserts it — is whether this package's setup
 * still calls it. Same reasoning as the server's copy: spawn the real command,
 * and keep a control so an unrelated spawn failure cannot pass for a guard.
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SETUP = resolve(HERE, '_setup.mjs')

const dir = mkdtempSync(join(tmpdir(), 'chroxy-hooks-force-exit-'))
const probe = join(dir, 'probe.test.js')
writeFileSync(probe, "import { test } from 'node:test'\ntest('probe ran', () => {})\n")

after(() => { rmSync(dir, { recursive: true, force: true }) })

// NODE_TEST_CONTEXT is set on this process by the runner; a child that
// inherits it skips running files entirely and exits 0 — a false pass for the
// refusal cases. Strip it. (Same reasoning as the server's copy.)
const childEnv = () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return env
}

const run = (extraArgs = []) => {
  const r = spawnSync(
    process.execPath,
    ['--import', SETUP, '--test', ...extraArgs, probe],
    { encoding: 'utf8', cwd: dir, env: childEnv() },
  )
  return { ...r, all: (r.stdout || '') + (r.stderr || '') }
}

describe('tests/_setup.mjs refuses --test-force-exit (#7400)', () => {
  it('CONTROL: green without the flag, probe reported', () => {
    const r = run()
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.all.slice(0, 2000)}`)
    assert.ok(r.stdout.includes('# pass 1'), `probe should have run:\n${r.stdout.slice(0, 2000)}`)
  })

  it('refuses with the flag, non-zero, and runs nothing', () => {
    const r = run(['--test-force-exit'])
    assert.notEqual(r.status, 0, `expected a non-zero exit:\n${r.all.slice(0, 2000)}`)
    assert.ok(r.all.includes('CHROXY_TEST_FORCE_EXIT'), `expected the refusal:\n${r.all.slice(0, 2000)}`)
    assert.ok(!r.stdout.includes('# pass 1'), `no test should have passed:\n${r.stdout.slice(0, 2000)}`)
  })
})
