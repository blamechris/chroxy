/**
 * Tests for scripts/lint-tests-state-file-path.mjs (#4633, hardened in #7567).
 *
 * The lint is the CI guard behind #4633: every `new SessionManager(...)` (and
 * `new CheckpointManager(...)`) in tests must pass an explicit tmp-path option,
 * or the constructor defaults to `~/.chroxy/` and the test clobbers the real
 * user/CI-runner state.
 *
 * #7567 — the guard had a false-safety hole. Its paren walk toggled string
 * state on any quote with NO awareness of comments, so a single apostrophe in a
 * comment inside the call's paren range opened a phantom string that never
 * closed, the walk returned -1, and the caller SILENTLY dropped the site
 * (`if (closeParen === -1) continue`). A `new SessionManager(...)` missing
 * `stateFilePath` next to an apostrophe-in-a-comment therefore passed the guard.
 *
 * Strategy (matches lint-config-dir.test.js / lint-session-opt-forwarding.test.js):
 * run the lint as a child process against a temp `--tests-dir` of fixture files
 * and assert the EXIT CODE, not the printed output. Every "passes" is paired
 * with a POSITIVE CONTROL that fails — a bare "this passes" would pass just as
 * happily against a lint that detects nothing, which is the exact false-safety
 * class docs/false-safety-guards.md exists to prevent.
 *
 * Exit codes under test: 0 = clean, 1 = offender, 2 = the lint could not do its
 * job (bad flags, empty/missing dir, or an unparseable construction site).
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LINT_SCRIPT = resolve(__dirname, '..', 'scripts', 'lint-tests-state-file-path.mjs')

const tmpRoots = []
after(() => {
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

/**
 * Write a fixture tests/ tree and run the lint against it.
 * @param {Record<string,string>} files fixture name -> source (name must end .test.js to be walked)
 * @param {{ env?: Record<string,string>, extraArgs?: string[] }} [opts]
 */
function runLint(files, { env, extraArgs = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'chroxy-lint-statefile-'))
  tmpRoots.push(root)
  for (const [name, source] of Object.entries(files)) {
    const full = join(root, name)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, source)
  }
  const res = spawnSync(
    process.execPath,
    [LINT_SCRIPT, '--tests-dir', root, ...extraArgs],
    { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env },
  )
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

// The #7567 fixture: missing `stateFilePath`, with a single apostrophe in a
// comment INSIDE the paren range. `cwd: '/tmp'` contributes two apostrophes
// (balanced); "don't" contributes one — an odd total, so the pre-fix walk's
// phantom string stayed open past the real `)` and the site was dropped.
const RED_APOSTROPHE_IN_COMMENT = `
import { SessionManager } from '../src/session-manager.js'

const m = new SessionManager({
  cwd: '/tmp',
  // don't clobber real user state here
})
`

// The same call, correctly written (stateFilePath present) — the apostrophe in
// the comment is still there.
const CONTROL_APOSTROPHE_IN_COMMENT = `
import { SessionManager } from '../src/session-manager.js'

const m = new SessionManager({
  stateFilePath: tmpStateFile(),
  cwd: '/tmp',
  // don't clobber real user state here
})
`

describe('lint-tests-state-file-path', () => {
  describe('the #7567 apostrophe-in-comment hole', () => {
    test('CATCHES a missing stateFilePath next to an apostrophe-in-a-comment', () => {
      // Pre-fix this exited 0 (the phantom string from the comment apostrophe
      // ran the paren walk off the end → closeParen === -1 → silent `continue`).
      // The comment-aware walk now sees the real `)` and flags the missing opt.
      const r = runLint({ 'red.test.js': RED_APOSTROPHE_IN_COMMENT })
      assert.equal(r.status, 1, `should flag the missing opt\n${r.stdout}\n${r.stderr}`)
      assert.match(r.stderr, /red\.test\.js:4\s+\(missing stateFilePath/)
    })

    test('POSITIVE CONTROL: the same call WITH stateFilePath (same comment) passes', () => {
      // Proves the catch above comes from the missing option, not from the
      // apostrophe-in-comment causing a blanket failure of everything near it.
      const r = runLint({ 'control.test.js': CONTROL_APOSTROPHE_IN_COMMENT })
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    })
  })

  describe('the base rule still holds', () => {
    test('a plain offender (missing stateFilePath, no comment) fails', () => {
      const r = runLint({
        'plain.test.js': `
import { SessionManager } from '../src/session-manager.js'
const m = new SessionManager({ cwd: '/tmp' })
`,
      })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /plain\.test\.js:3\s+\(missing stateFilePath/)
    })

    test('a correctly-written call passes', () => {
      const r = runLint({
        'ok.test.js': `
import { SessionManager } from '../src/session-manager.js'
const m = new SessionManager({ stateFilePath: tmpStateFile(), cwd: '/tmp' })
`,
      })
      assert.equal(r.status, 0, r.stderr)
    })

    test('the CheckpointManager rule fires too (missing checkpointsDir)', () => {
      const r = runLint({
        'ckpt.test.js': `
import { CheckpointManager } from '../src/checkpoint-manager.js'
const c = new CheckpointManager({ sessionId: 'x' })
`,
      })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /ckpt\.test\.js:3\s+\(missing checkpointsDir in new CheckpointManager/)
    })

    test('a multi-line call passes when the opt is present', () => {
      const r = runLint({
        'multiline.test.js': `
import { SessionManager } from '../src/session-manager.js'
const m = new SessionManager({
  stateFilePath: tmpStateFile(),
  cwd: '/tmp',
})
`,
      })
      assert.equal(r.status, 0, r.stderr)
    })
  })

  describe('a needle inside a STRING literal is not a construction site (#7567)', () => {
    // The real shape that made this necessary: environment-session-wiring.test.js
    // has an assertion message containing the text `new SessionManager({`. Once
    // the walk became loud (2), matching the needle there would fail the real
    // tree. Strings are blanked (parser-backed) before the search.
    test('an assertion message quoting `new SessionManager({` is ignored', () => {
      const r = runLint({
        'msg.test.js': `
const slice = ''
assert.ok(slice, 'no \\\`new SessionManager({\\\` in server-cli.js — find where it moved')
`,
      })
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    })

    test('POSITIVE CONTROL: the same construction as real code IS caught', () => {
      // Proves the pass above came from string-awareness, not from the lint
      // failing to recognize the construction at all.
      const r = runLint({
        'msg.test.js': `
const m = new SessionManager({ cwd: '/tmp' })
`,
      })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /msg\.test\.js:2\s+\(missing stateFilePath/)
    })
  })

  describe('a needle inside a COMMENT is not a construction site (#7567)', () => {
    test('a commented-out offender is ignored', () => {
      const r = runLint({
        'commented.test.js': `
import { SessionManager } from '../src/session-manager.js'
// const m = new SessionManager({ cwd: '/tmp' })
export const x = 1
`,
      })
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    })

    test('POSITIVE CONTROL: the same line un-commented IS caught', () => {
      const r = runLint({
        'commented.test.js': `
import { SessionManager } from '../src/session-manager.js'
const m = new SessionManager({ cwd: '/tmp' })
export const x = 1
`,
      })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /commented\.test\.js:3/)
    })
  })

  describe('an unparseable construction site is LOUD, never silent (#7567)', () => {
    test('a genuinely unbalanced call exits 2 and names the site', () => {
      // No comment/string trick — the parens are actually unbalanced (the source
      // is truncated). Pre-fix this exited 0 (silent `continue` on -1). The guard
      // must now fail: "cannot check this" is not "nothing to check here".
      const r = runLint({
        'broken.test.js': `
import { SessionManager } from '../src/session-manager.js'
const m = new SessionManager({ cwd: '/tmp'
`,
      })
      assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`)
      assert.match(r.stderr, /broken\.test\.js:3\s+\(new SessionManager\(\.\.\.\) — unbalanced parens/)
      assert.match(r.stderr, /cannot check.*is not.*nothing to check/i)
    })

    test('POSITIVE CONTROL: the same call, balanced, does NOT exit 2', () => {
      // Proves the exit 2 above came from the imbalance, not from the fixture
      // being broken in some other way. (It is still an offender — exit 1 — since
      // it lacks stateFilePath; the point is that it is NOT the unparseable path.)
      const r = runLint({
        'broken.test.js': `
import { SessionManager } from '../src/session-manager.js'
const m = new SessionManager({ cwd: '/tmp' })
`,
      })
      assert.notEqual(r.status, 2)
      assert.equal(r.status, 1)
    })

    test('DRY_RUN does NOT silence an unparseable site', () => {
      // DRY_RUN downgrades a plain offender to exit 0, but "cannot check" must
      // stay loud regardless — that is the whole point of the loud path.
      const r = runLint(
        { 'broken.test.js': `
import { SessionManager } from '../src/session-manager.js'
const m = new SessionManager({ cwd: '/tmp'
` },
        { env: { DRY_RUN: '1' } },
      )
      assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`)
    })
  })

  describe('DRY_RUN lists offenders without failing (base behavior preserved)', () => {
    test('an offender is reported but the exit is 0 under DRY_RUN=1', () => {
      const r = runLint(
        { 'plain.test.js': `
import { SessionManager } from '../src/session-manager.js'
const m = new SessionManager({ cwd: '/tmp' })
` },
        { env: { DRY_RUN: '1' } },
      )
      assert.equal(r.status, 0)
      assert.match(r.stderr, /plain\.test\.js:3\s+\(missing stateFilePath/)
    })
  })

  describe('the guard cannot silently no-op', () => {
    test('an unknown flag is rejected (exit 2), not ignored', () => {
      // `--testdir` (a typo) must not be dropped so the lint scans the real
      // tests/ and reports on the wrong tree.
      const res = spawnSync(process.execPath, [LINT_SCRIPT, '--testdir', '/tmp'], { encoding: 'utf8' })
      assert.equal(res.status, 2)
      assert.match(res.stderr, /unknown argument/)
    })

    test('a flag missing its value is rejected (exit 2)', () => {
      const res = spawnSync(process.execPath, [LINT_SCRIPT, '--tests-dir'], { encoding: 'utf8' })
      assert.equal(res.status, 2)
      assert.match(res.stderr, /requires a value/)
    })

    test('a nonexistent tests dir fails (exit 2), not reports clean', () => {
      const res = spawnSync(
        process.execPath,
        [LINT_SCRIPT, '--tests-dir', join(tmpdir(), 'chroxy-does-not-exist-7567')],
        { encoding: 'utf8' },
      )
      assert.equal(res.status, 2)
      assert.match(res.stderr, /does not exist/)
    })

    test('scanning zero .test.js files fails (exit 2), not reports clean', () => {
      // A dir that exists but holds no .test.js files must not exit 0 — that is
      // indistinguishable from a clean tree.
      const r = runLint({ 'not-a-test.js': 'export const x = 1\n' })
      assert.equal(r.status, 2)
      assert.match(r.stderr, /scanned 0 .test.js files/)
    })
  })

  test('passes against the real packages/server/tests tree (acceptance)', () => {
    // No --tests-dir override → the lint walks the real tests/. This is the
    // regression contract: the comment/string-awareness and loud-unparseable
    // changes must introduce NO false positive on the real, correctly-written
    // tree. If a real site flips this red, it is a genuine finding to fix, not
    // something to suppress here.
    const res = spawnSync(process.execPath, [LINT_SCRIPT], { encoding: 'utf8' })
    assert.equal(
      res.status,
      0,
      `lint must pass on the real tests tree.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    )
  })
})
