/**
 * Tests for scripts/lint-claude-family-explicit.mjs
 *
 * The lint guards the residual Claude-family drift mode (#5858/#5891): a new
 * class that `extends ClaudeByokSession` and forgets `static claudeFamily =
 * false` silently inherits `true` from the base and is mis-classified as
 * Claude-family (soft-falling-back stale model ids instead of validating
 * strictly).
 *
 * Strategy: run the lint as a child process against a temp directory of fixture
 * files via `--src-dir`, asserting it flags an undeclared subclass and accepts
 * explicitly-declared ones. A final case runs it against the REAL src to prove
 * the tree is currently compliant.
 *
 * Issue: #5891 (follow-up from #5890/#5858).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LINT_SCRIPT = resolve(__dirname, '..', 'scripts', 'lint-claude-family-explicit.mjs')
const REAL_SRC = resolve(__dirname, '..', 'src')

function runLint(srcDir, extra = []) {
  // process.execPath (not a bare 'node' on PATH) — robust + consistent with the
  // other lint tests in this repo.
  return spawnSync(process.execPath, [LINT_SCRIPT, '--src-dir', srcDir, ...extra], { encoding: 'utf8' })
}

function withFixtureDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-cf-lint-'))
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents)
    }
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const COMPLIANT_FALSE = `
export class DeepSeekSession extends ClaudeByokSession {
  static claudeFamily = false
}
`
const COMPLIANT_TRUE = `
export class DockerByokSession extends ClaudeByokSession {
  static claudeFamily = true
  static get displayLabel() { return 'x' }
}
`
const OFFENDER = `
export class ForgotToDeclareSession extends ClaudeByokSession {
  static get displayLabel() { return 'oops' }
}
`

describe('lint-claude-family-explicit', () => {
  test('passes when every subclass declares static claudeFamily', () => {
    withFixtureDir({ 'a.js': COMPLIANT_FALSE, 'b.js': COMPLIANT_TRUE }, (dir) => {
      const r = runLint(dir)
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /2 ClaudeByokSession subclass\(es\) declare static claudeFamily/)
    })
  })

  test('fails (exit 1) and names a subclass missing static claudeFamily', () => {
    withFixtureDir({ 'a.js': COMPLIANT_TRUE, 'bad.js': OFFENDER }, (dir) => {
      const r = runLint(dir)
      assert.equal(r.status, 1)
      assert.match(r.stderr, /ForgotToDeclareSession/)
      assert.match(r.stderr, /without an explicit `static claudeFamily`/)
    })
  })

  test('--dry-run reports the offender but exits 0', () => {
    withFixtureDir({ 'bad.js': OFFENDER }, (dir) => {
      const r = runLint(dir, ['--dry-run'])
      assert.equal(r.status, 0)
      assert.match(r.stderr, /ForgotToDeclareSession/)
    })
  })

  test('does not flag the base ClaudeByokSession (it does not extend itself)', () => {
    withFixtureDir({
      'base.js': 'export class ClaudeByokSession extends JsonlSubprocessSession {\n  static claudeFamily = true\n}\n',
    }, (dir) => {
      const r = runLint(dir)
      assert.equal(r.status, 0, r.stderr)
      // No `extends ClaudeByokSession` subclass present → 0 counted.
      assert.match(r.stdout, /0 ClaudeByokSession subclass/)
    })
  })

  test('does not match a subclass declaration written inside a comment', () => {
    const commented = `
// Example from the docs: class DocExample extends ClaudeByokSession { ... }
/* class BlockExample extends ClaudeByokSession {
     static get x() { return 1 }
   } */
export class RealOne extends ClaudeByokSession {
  static claudeFamily = false
}
`
    withFixtureDir({ 'c.js': commented }, (dir) => {
      const r = runLint(dir)
      assert.equal(r.status, 0, r.stderr)
      // Only RealOne is a real subclass; the commented ones are ignored.
      assert.match(r.stdout, /1 ClaudeByokSession subclass/)
    })
  })

  test('the real src tree is compliant', () => {
    const r = runLint(REAL_SRC)
    assert.equal(r.status, 0, r.stderr)
  })
})
