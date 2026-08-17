/**
 * Tests for scripts/lint-config-dir.mjs (#7052).
 *
 * The lint guards the single-resolver rule: `~/.chroxy` is resolved by
 * `src/config-dir.js` and nowhere else. Two shapes are banned — a hardcoded
 * `join(homedir(), '.chroxy', …)` (ignores CHROXY_CONFIG_DIR outright) and an
 * inline `process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')` copy of
 * the resolver itself.
 *
 * Strategy: run the lint as a child process against a temp fixture `src/` tree
 * (via `--src-dir` / `--baseline`) and assert the EXIT CODE, not the output.
 *
 * Every exemption below is asserted with a POSITIVE CONTROL — the same source
 * WITHOUT the thing that is supposed to exempt it, proving the case would have
 * failed and that the exemption is what saved it. A bare "this passes" would
 * pass just as happily against a lint that detects nothing at all, which is the
 * false-safety class docs/false-safety-guards.md exists to prevent.
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LINT_SCRIPT = resolve(__dirname, '..', 'scripts', 'lint-config-dir.mjs')

const tmpRoots = []
after(() => {
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

/**
 * Build a fixture src/ tree and run the lint against it.
 * @param {Record<string,string>} files repo-relative path -> source
 * @param {string[]|null} baseline lines for the baseline file, or null for none
 */
function runLint(files, baseline = null) {
  const root = mkdtempSync(join(tmpdir(), 'chroxy-lint-configdir-'))
  tmpRoots.push(root)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })

  for (const [rel, source] of Object.entries(files)) {
    const full = join(srcDir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, source)
  }

  const args = ['--src-dir', srcDir]
  if (baseline !== null) {
    const baselinePath = join(root, 'baseline.txt')
    writeFileSync(baselinePath, baseline.join('\n') + '\n')
    args.push('--baseline', baselinePath)
  } else {
    args.push('--baseline', join(root, 'does-not-exist.txt'))
  }

  const res = spawnSync(process.execPath, [LINT_SCRIPT, ...args], { encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

const HARDCODED = `
import { homedir } from 'os'
import { join } from 'path'
export function statePath() {
  return join(homedir(), '.chroxy', 'session-state.json')
}
`

const INLINE_COPY = `
import { homedir } from 'os'
import { join } from 'path'
export function statePath() {
  const dir = process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
  return join(dir, 'session-state.json')
}
`

const CLEAN = `
import { configPath } from './config-dir.js'
export function statePath() {
  return configPath('session-state.json')
}
`

const OWNER = `
import { homedir } from 'os'
import { join } from 'path'
export function configDir() {
  return process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
}
`

describe('lint-config-dir', () => {
  describe('detection', () => {
    test('a clean file that uses configPath() passes', () => {
      const r = runLint({ 'clean.js': CLEAN })
      assert.equal(r.status, 0, r.stderr)
    })

    test('a hardcoded join(homedir(), .chroxy) path fails', () => {
      const r = runLint({ 'offender.js': HARDCODED })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /offender\.js:5\s+\[hardcoded-home-path\]/)
    })

    test('an inline resolver copy fails, and is reported as such', () => {
      const r = runLint({ 'offender.js': INLINE_COPY })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /offender\.js:5\s+\[inline-resolver-copy\]/)
    })

    test('reports every offending site, not just the first', () => {
      const r = runLint({ 'a.js': HARDCODED, 'b.js': INLINE_COPY, 'c.js': HARDCODED })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /3 un-baselined site\(s\)/)
    })

    test('finds offenders in subdirectories', () => {
      const r = runLint({ 'notifications/sink.js': HARDCODED })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /notifications\/sink\.js:5/)
    })
  })

  describe('the owner file is exempt', () => {
    test('config-dir.js may resolve the env itself', () => {
      const r = runLint({ 'config-dir.js': OWNER })
      assert.equal(r.status, 0, r.stderr)
    })

    test('POSITIVE CONTROL: the identical source under another name fails', () => {
      // Proves the pass above came from the owner exemption, not from the lint
      // failing to see this shape at all.
      const r = runLint({ 'not-the-owner.js': OWNER })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /not-the-owner\.js:5\s+\[inline-resolver-copy\]/)
    })
  })

  describe('comments are not code', () => {
    test('a line comment quoting the pattern is not an offense', () => {
      const r = runLint({
        'doc.js': `
// Historically this read join(homedir(), '.chroxy', 'config.json') directly.
export const x = 1
`,
      })
      assert.equal(r.status, 0, r.stderr)
    })

    test('a block comment quoting the pattern is not an offense', () => {
      // The real case: cli/schedule-cmd.js's doc block quotes the banned
      // pattern across several lines while explaining the migration.
      const r = runLint({
        'doc.js': `
/**
 * Deliberately rooted at homedir()/.chroxy, because:
 *   1. it falls back to join(homedir(), '.chroxy', 'session-state.json').
 */
export const x = 1
`,
      })
      assert.equal(r.status, 0, r.stderr)
    })

    test('POSITIVE CONTROL: the same text as live code fails', () => {
      // Without this, both cases above would pass against a lint whose comment
      // stripper had eaten the entire file.
      const r = runLint({
        'doc.js': `
export const x = join(homedir(), '.chroxy', 'session-state.json')
`,
      })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /doc\.js:2\s+\[hardcoded-home-path\]/)
    })

    test('code AFTER a closed block comment is still linted', () => {
      const r = runLint({
        'doc.js': `
/* a note about join(homedir(), '.chroxy') */
export const x = join(homedir(), '.chroxy', 'config.json')
`,
      })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /doc\.js:3/)
    })

    test('code on the same line after a block comment closes is still linted', () => {
      const r = runLint({
        'doc.js': `
/* note */ export const x = join(homedir(), '.chroxy', 'config.json')
`,
      })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /doc\.js:2/)
    })
  })

  describe('non-chroxy home paths are out of scope', () => {
    test('a Windows AppData credential path is not an offense', () => {
      // keychain.js:36
      const r = runLint({
        'keychain.js': `
export function dir() {
  return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Chroxy')
}
`,
      })
      assert.equal(r.status, 0, r.stderr)
    })

    test("Claude Code's own ~/.claude.json is not an offense", () => {
      // byok-mcp-config.js:43 — chroxy reads this file but does not own it.
      const r = runLint({
        'byok-mcp-config.js': `
export function p() {
  return process.env.CHROXY_CLAUDE_CONFIG || join(homedir(), '.claude.json')
}
`,
      })
      assert.equal(r.status, 0, r.stderr)
    })

    test('POSITIVE CONTROL: the same shapes with .chroxy DO fail', () => {
      // Proves the two passes above came from the path segment differing, not
      // from the lint ignoring `homedir()` in those files by name.
      const rKeychain = runLint({
        'keychain.js': `
export function dir() {
  return join(process.env.LOCALAPPDATA || join(homedir(), '.chroxy'), 'Chroxy')
}
`,
      })
      assert.equal(rKeychain.status, 1)

      const rMcp = runLint({
        'byok-mcp-config.js': `
export function p() {
  return process.env.CHROXY_CLAUDE_CONFIG || join(homedir(), '.chroxy')
}
`,
      })
      assert.equal(rMcp.status, 1)
    })
  })

  describe('the lint-ignore marker', () => {
    test('exempts the line immediately below it', () => {
      const r = runLint({
        'legacy.js': `
export function p() {
  // lint-ignore-config-dir
  return join(homedir(), '.chroxy', 'legacy.json')
}
`,
      })
      assert.equal(r.status, 0, r.stderr)
    })

    test('POSITIVE CONTROL: the identical source without the marker fails', () => {
      const r = runLint({
        'legacy.js': `
export function p() {
  return join(homedir(), '.chroxy', 'legacy.json')
}
`,
      })
      assert.equal(r.status, 1)
    })

    test('does NOT exempt a line two below it', () => {
      const r = runLint({
        'legacy.js': `
export function p() {
  // lint-ignore-config-dir
  const a = 1
  return join(homedir(), '.chroxy', 'legacy.json')
}
`,
      })
      assert.equal(r.status, 1)
    })
  })

  describe('the baseline ratchet', () => {
    test('a baselined file is exempt', () => {
      const r = runLint({ 'offender.js': HARDCODED }, ['offender.js'])
      assert.equal(r.status, 0, r.stderr)
    })

    test('POSITIVE CONTROL: the identical file with an EMPTY baseline fails', () => {
      // Proves the pass above came from the baseline entry, not from the lint
      // silently skipping the file for some other reason.
      const r = runLint({ 'offender.js': HARDCODED }, [])
      assert.equal(r.status, 1)
    })

    test('baselining one file does not exempt another', () => {
      const r = runLint({ 'a.js': HARDCODED, 'b.js': HARDCODED }, ['a.js'])
      assert.equal(r.status, 1)
      assert.match(r.stderr, /b\.js:5/)
      assert.doesNotMatch(r.stderr, /a\.js:5/)
    })

    test('a NEW offender in a non-baselined file fails even when others are baselined', () => {
      // The ratchet's whole purpose: the list may shrink, never grow.
      const r = runLint({ 'old.js': HARDCODED, 'new.js': INLINE_COPY }, ['old.js'])
      assert.equal(r.status, 1)
      assert.match(r.stderr, /new\.js:5/)
    })

    test('a stale baseline entry — file now clean — fails', () => {
      // Otherwise the entry keeps granting an exemption nothing needs, and the
      // next regression in that file lands silently.
      const r = runLint({ 'clean.js': CLEAN }, ['clean.js'])
      assert.equal(r.status, 1)
      assert.match(r.stderr, /clean\.js: listed in the baseline but now clean/)
    })

    test('comments and blank lines in the baseline are ignored', () => {
      const r = runLint({ 'offender.js': HARDCODED }, [
        '# a comment',
        '',
        'offender.js',
        '',
      ])
      assert.equal(r.status, 0, r.stderr)
    })
  })

  // Rule 3 shipped with NO tests. Deleting its body left the suite 25/25 green,
  // which is the false-safety pattern this repo has hit seven times — a guard
  // whose output is correct and whose coverage is what is wrong. Worse, the
  // migration then created a live evader it could not see (logger.js's
  // `let _logDir = defaultLogDir()`), so the lint reported the tree clean while
  // half the defect survived. These are the tests that were missing.
  describe('module-scope capture (rule 3)', () => {
    const WRAPPER = `
import { configPath } from './config-dir.js'
function defaultLogDir() {
  return configPath('logs')
}
`
    test('a module-scope const initialized from configPath() fails', () => {
      const r = runLint({
        'frozen.js': `
import { configPath } from './config-dir.js'
const STATE = configPath('session-state.json')
export function p() { return STATE }
`,
      })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /frozen\.js:3\s+\[module-scope-capture\]/)
    })

    test('an EXPORTED module-scope const fails too', () => {
      const r = runLint({
        'frozen.js': `
import { configDir } from './config-dir.js'
export const ROOT = configDir()
`,
      })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /\[module-scope-capture\]/)
    })

    test('`let` and `var` are caught, not just `const`', () => {
      for (const kw of ['let', 'var']) {
        const r = runLint({
          'frozen.js': `
import { configPath } from './config-dir.js'
${kw} p = configPath('x.json')
export function get() { return p }
`,
        })
        assert.equal(r.status, 1, `${kw} declaration should be caught`)
      }
    })

    test('an initializer on the following line is caught', () => {
      const r = runLint({
        'frozen.js': `
import { configPath } from './config-dir.js'
const STATE =
  configPath('session-state.json')
`,
      })
      assert.equal(r.status, 1)
    })

    test('capture through a same-file wrapper is caught (the logger.js regression)', () => {
      // The shape that evaded the first version of this rule: the initializer
      // calls a local one-liner that calls the accessor, so matching the
      // accessor name alone missed it — and the migration had just replaced a
      // detectable `join(homedir(), …)` const with exactly this.
      const r = runLint({ 'logger.js': `${WRAPPER}let _logDir = defaultLogDir()\n` })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /logger\.js:6\s+\[module-scope-capture\]/)
    })

    test('POSITIVE CONTROL: the same wrapper resolved lazily is clean', () => {
      // Proves the case above is flagged for WHERE the call happens, not merely
      // for the wrapper existing in the file.
      const r = runLint({
        'logger.js': `${WRAPPER}let _logDir = null
export function init(dir) {
  _logDir = dir || defaultLogDir()
  return _logDir
}
`,
      })
      assert.equal(r.status, 0, r.stderr)
    })

    test('POSITIVE CONTROL: the identical call inside a function is clean', () => {
      // Indentation is the signal for "not module scope". Without this control,
      // the rule could be matching the accessor call anywhere in the file.
      const r = runLint({
        'fine.js': `
import { configPath } from './config-dir.js'
export function statePath() {
  const p = configPath('session-state.json')
  return p
}
`,
      })
      assert.equal(r.status, 0, r.stderr)
    })

    test('a module-scope binding NOT calling the accessor is clean', () => {
      const r = runLint({
        'fine.js': `
const MAX = 50
const NAME = 'chroxy'
export function get() { return NAME }
`,
      })
      assert.equal(r.status, 0, r.stderr)
    })
  })

  describe('--dry-run', () => {
    test('reports offenders but exits 0', () => {
      const root = mkdtempSync(join(tmpdir(), 'chroxy-lint-configdir-dry-'))
      tmpRoots.push(root)
      const srcDir = join(root, 'src')
      mkdirSync(srcDir, { recursive: true })
      writeFileSync(join(srcDir, 'offender.js'), HARDCODED)

      const res = spawnSync(
        process.execPath,
        [LINT_SCRIPT, '--src-dir', srcDir, '--baseline', join(root, 'none.txt'), '--dry-run'],
        { encoding: 'utf8' }
      )
      assert.equal(res.status, 0)
      assert.match(res.stderr, /offender\.js:5/)
    })
  })
})
