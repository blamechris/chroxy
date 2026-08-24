/**
 * Argv option-injection guard for the Grep built-in tool (#7295).
 *
 * `buildGrepCommand` puts a model-controlled `pattern` into the argv of `rg`
 * (and the `grep -r` fallback). `shellQuote` closes SHELL injection — bash
 * consumes the quotes — but the resulting argv element still begins with `-`,
 * and rg/grep run their own option parser over it. `rg --pre=<path>` executes
 * `<path>` as a preprocessor for every file it searches, so a bare positional
 * pattern slot is **arbitrary program execution**.
 *
 * That matters more here than in a normal argv bug because `Grep` is
 * classified read-only across the permission system (`SECRET_READ_FLOOR_TOOLS`,
 * `ACCEPT_EDITS_TOOLS`, `ELIGIBLE_TOOLS`) — it is auto-approved in acceptEdits
 * mode and eligible for a standing auto-allow rule, while `Bash` is
 * deliberately excluded as too dangerous to whitelist. The fix must therefore
 * live in the builder, not in the permission layer.
 *
 * These tests SPAWN the built command rather than only asserting on its text,
 * because a string assertion is only as good as the reviewer's model of rg's
 * parser. Measured against ripgrep 15.1.0 on the unfixed builder:
 *
 *   rg -n --no-heading '--pre=/tmp/marker.sh' <root>     rc=1, marker WRITTEN
 *   rg -n --no-heading -e '--pre=/tmp/marker.sh' <root>  rc=1, marker absent
 *
 * The fix is `-e <pattern>` (argv-safety.js fix shape 3), NOT rejecting a
 * leading dash: `-Wall` and `--force` are legitimate search patterns, and
 * rejecting them would be a functional regression. The `-Wall` positive
 * control below pins that.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, access, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { existsSync, statSync, accessSync, constants } from 'node:fs'
import { buildGrepArgs, buildGrepCommand } from '../../src/built-in-tools/tool-transforms.js'
import { SECRET_READ_FLOOR_TOOLS } from '../../src/permission-floor.js'
import { ACCEPT_EDITS_TOOLS, ELIGIBLE_TOOLS, NEVER_AUTO_ALLOW } from '../../src/permission-manager.js'

/**
 * Locate an EXECUTABLE FILE on PATH without shelling out. `existsSync` alone is
 * not enough: a directory or a non-executable file named `rg` would read as
 * "present" and make the rg tests fail for an unrelated reason.
 */
function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

const RG_PATH = findOnPath('rg')
const GREP_PATH = findOnPath('grep')
// No `|| '/bin/bash'` fallback: that would make the `assert.ok(BASH_PATH)` guard
// below unfireable, and silently shim to a bash that may not exist.
const BASH_PATH = findOnPath('bash')

/**
 * Run a built command the way the real sinks do (`bash -c`), with a hard
 * timeout so a HANGING command is a reportable outcome rather than a stuck
 * test run.
 *
 * `stdin: 'pipe'` leaves the child's stdin OPEN and never writes to it. That
 * is deliberate: when the injected option eats the pattern slot, the root
 * becomes the pattern, rg is left with zero paths, and its stdin heuristic
 * makes it read a readable stdin — blocking until EOF. With stdin held open
 * that block is unbounded, which is the "hung tool call" half of #7295.
 */
function runBuilt(cmd, { cwd, env, stdin = 'ignore', timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd,
      env: env || process.env,
      stdio: [stdin, 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, timedOut, spawnError: err })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (child.stdin && !child.stdin.destroyed) child.stdin.destroy()
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

/**
 * Workspace fixture: a `work/` tree with one searchable file, plus a marker
 * script parked OUTSIDE that tree. The script is what `--pre=` would execute.
 */
async function makeFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'chroxy-grep-argv-'))
  const root = path.join(dir, 'work')
  await mkdir(root)
  await writeFile(path.join(root, 'a.txt'), 'compile with -Wall enabled\nplain TODO line\n')
  const marker = path.join(dir, 'MARKER')
  const script = path.join(dir, 'pre.sh')
  // `--pre` hands the preprocessor the filename as $1 and reads its stdout, so
  // the script has to cat the file through for rg to behave normally. The
  // marker write is the side effect that proves execution.
  await writeFile(script, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexec cat "$1"\n`)
  await chmod(script, 0o755)
  return { dir, root, marker, script, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Single-quote a path for the hand-built positive-control command. */
function shellQuoteForTest(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * The rg tests carry the whole EXECUTION proof; the rest of the file can only
 * assert on command text, which is exactly what this file's docblock argues is
 * insufficient. So "ripgrep is missing" must not be silently equivalent to
 * "nothing to check" — that is the second recurring cause in
 * `docs/false-safety-guards.md`. On a developer machine without rg a loud skip
 * is reasonable; in CI it is a FAILURE, because a green CI log is the thing
 * nobody reads.
 *
 * Returns true when the caller should bail out of the test.
 */
function requireRgOrSkip(t, what) {
  if (RG_PATH) return false
  if (process.env.CI) {
    assert.fail(
      `ripgrep is not installed on this CI runner, so ${what} did not run. ` +
      'This proof must not be skipped in CI — install ripgrep in the Server Tests job (#7295).',
    )
  }
  t.skip(`ripgrep is not installed on this machine — ${what} did NOT run (it is enforced in CI).`)
  return true
}

/**
 * Same contract as {@link requireRgOrSkip}, for the grep-fallback branch, which
 * needs a real `grep` and a real `bash` to shim onto a PATH. Absence must not be
 * silently equivalent to "nothing to check", and must not hard-fail everywhere
 * either — that is what reddened the Windows job.
 *
 * Returns true when the caller should bail out of the test.
 */
function requireGrepShimOrSkip(t) {
  const missing = [GREP_PATH ? null : 'grep', BASH_PATH ? null : 'bash'].filter(Boolean)
  if (missing.length === 0) return false
  const what = `${missing.join(' and ')} not found on PATH`
  if (process.env.CI) {
    assert.fail(`${what} — the grep-fallback branch proof cannot run in CI (#7295).`)
  }
  t.skip(`${what} — the grep-fallback proof did NOT run (it is enforced in CI).`)
  return true
}

/**
 * The spawning tests need a POSIX shell: the sinks under test are literally
 * `spawn('bash', ['-c', cmd])` and `docker exec … bash -c`, and the fixtures are
 * `#!/bin/sh` scripts with exec bits. None of that is meaningful on Windows, and
 * the self-hosted Windows runner's bash is a distro-less WSL stub. Skipping the
 * five spawning tests keeps the file IN the derived Windows run set (`run =
 * all - WINDOWS_EXEMPT`, #7270) so the three command-shape/coupling tests still
 * provide real Windows coverage — strictly better than exempting the whole file.
 */
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX shell required (spawns bash + /bin/sh fixtures)' : false }

/** Build exactly what `runGrep` / the container Grep build for this pattern. */
function build(pattern, root, input = {}) {
  const { ci, ln, globArg } = buildGrepArgs(input)
  return buildGrepCommand({ pattern, root, ci, ln, globArg })
}

/**
 * A PATH that resolves `bash` and `grep` but NOT `rg`, to force the `grep -r`
 * fallback branch deterministically on a machine that has ripgrep installed.
 * Shims rather than a real directory so the PATH can be exhaustive: any real
 * bin dir added here might also contain `rg` and silently take the other
 * branch, which would make this test pass for the wrong reason.
 */
async function makeGrepOnlyPath(dir) {
  // Reachable only from a caller that forgot `requireGrepShimOrSkip` — the
  // environment gate lives in the tests, so a missing tool SKIPS on a dev box and
  // FAILS in CI. These two are a programming-error guard, and they are fireable:
  // proven by setting BASH_PATH to null and calling this helper ungated. The
  // `|| '/bin/bash'` default they used to sit behind made that impossible.
  assert.ok(GREP_PATH, 'makeGrepOnlyPath called without requireGrepShimOrSkip: grep is not on PATH')
  assert.ok(BASH_PATH, 'makeGrepOnlyPath called without requireGrepShimOrSkip: bash is not on PATH')
  const bin = path.join(dir, 'bin')
  await mkdir(bin, { recursive: true })
  for (const [name, target] of [['grep', GREP_PATH], ['bash', BASH_PATH]]) {
    const shim = path.join(bin, name)
    await writeFile(shim, `#!/bin/sh\nexec ${JSON.stringify(target)} "$@"\n`)
    await chmod(shim, 0o755)
  }
  return bin
}

describe('Grep argv option injection (#7295)', () => {
  describe('ripgrep branch', () => {
    // ARMS THE NEGATIVE CONTROL BELOW. Without this, `marker was not written`
    // passes for free the moment the fixture stops taking effect — a failed
    // chmod, a noexec tmpdir, a future rg that drops `--pre`, a cwd with no
    // files to preprocess. Proven necessary: with the fix reverted AND the
    // script mode changed to 0o644, the negative control went GREEN while the
    // vulnerability was live. A negative assertion with no positive control is
    // not evidence (`docs/false-safety-guards.md`).
    it('POSITIVE CONTROL: the marker mechanism really does fire when --pre IS a genuine flag', POSIX_ONLY, async (t) => {
      if (requireRgOrSkip(t, 'the marker-mechanism positive control')) return
      const fx = await makeFixture()
      try {
        // Deliberately NOT via buildGrepCommand: this is the armed control, so
        // it must reach rg's real `--pre` flag by construction.
        const cmd = `rg -n --no-heading --pre=${shellQuoteForTest(fx.script)} -e 'compile' ${shellQuoteForTest(fx.root)}`
        const res = await runBuilt(cmd, { cwd: fx.root })
        assert.equal(
          await exists(fx.marker),
          true,
          `the fixture is INERT: rg did not execute the preprocessor even when --pre was a real flag, so the negative control below proves nothing. rc=${res.code} stderr=${res.stderr} cmd=${cmd}`,
        )
      } finally {
        await fx.cleanup()
      }
    })

    it('NEGATIVE CONTROL: a `--pre=` pattern must not execute a program', POSIX_ONLY, async (t) => {
      if (requireRgOrSkip(t, 'the rg-branch execution proof')) return
      const fx = await makeFixture()
      try {
        const cmd = build(`--pre=${fx.script}`, fx.root)
        // cwd is the workspace root because rg, given zero paths, falls back to
        // searching `./` — which is how the preprocessor gets reached at all.
        const res = await runBuilt(cmd, { cwd: fx.root })
        assert.equal(
          await exists(fx.marker),
          false,
          `pattern was option-parsed: rg executed the --pre preprocessor. cmd=${cmd} rc=${res.code} stderr=${res.stderr}`,
        )
      } finally {
        await fx.cleanup()
      }
    })

    it('NEGATIVE CONTROL: a `--pre=` pattern must terminate, not hang on stdin', POSIX_ONLY, async (t) => {
      if (requireRgOrSkip(t, 'the rg-branch hang proof')) return
      const fx = await makeFixture()
      try {
        const cmd = build(`--pre=${fx.script}`, fx.root)
        const res = await runBuilt(cmd, { cwd: fx.root, stdin: 'pipe', timeoutMs: 8_000 })
        assert.equal(
          res.timedOut,
          false,
          `command hung: the injected option consumed the pattern slot, leaving rg zero paths so it blocked reading stdin. cmd=${cmd}`,
        )
      } finally {
        await fx.cleanup()
      }
    })

    it('POSITIVE CONTROL: a legitimately dash-leading pattern (`-Wall`) still matches as text', POSIX_ONLY, async (t) => {
      if (requireRgOrSkip(t, 'the rg-branch positive control')) return
      const fx = await makeFixture()
      try {
        const cmd = build('-Wall', fx.root)
        const res = await runBuilt(cmd, { cwd: fx.root })
        assert.equal(res.code, 0, `expected a match, got rc=${res.code} stderr=${res.stderr} cmd=${cmd}`)
        assert.match(res.stdout, /compile with -Wall enabled/)
      } finally {
        await fx.cleanup()
      }
    })
  })

  describe('grep fallback branch', () => {
    it('NEGATIVE CONTROL: a `--pre=` pattern is searched as text, not parsed as an option', POSIX_ONLY, async (t) => {
      if (requireGrepShimOrSkip(t)) return
      const fx = await makeFixture()
      try {
        const bin = await makeGrepOnlyPath(fx.dir)
        const cmd = build(`--pre=${fx.script}`, fx.root)
        const res = await runBuilt(cmd, {
          cwd: fx.root,
          env: { ...process.env, PATH: bin },
        })
        assert.equal(res.spawnError, undefined, `bash failed to spawn: ${res.spawnError}`)
        // Belt-and-braces only: grep has no `--pre` analogue, so this can never
        // fire. The rc assertion below is what actually carries this test.
        assert.equal(await exists(fx.marker), false, 'grep must not execute anything')
        // grep's exit codes: 0 = matched, 1 = no match, 2 = usage/other error.
        // Pre-fix the unknown `--pre` long option makes this a usage error (2);
        // post-fix it is an ordinary no-match (1).
        assert.equal(
          res.code,
          1,
          `expected a clean no-match (1), got rc=${res.code} — the pattern was option-parsed. stderr=${res.stderr} cmd=${cmd}`,
        )
      } finally {
        await fx.cleanup()
      }
    })

    it('POSITIVE CONTROL: `-Wall` still matches as text through the grep fallback', POSIX_ONLY, async (t) => {
      if (requireGrepShimOrSkip(t)) return
      const fx = await makeFixture()
      try {
        const bin = await makeGrepOnlyPath(fx.dir)
        const cmd = build('-Wall', fx.root)
        const res = await runBuilt(cmd, {
          cwd: fx.root,
          env: { ...process.env, PATH: bin },
        })
        assert.equal(res.code, 0, `expected a match, got rc=${res.code} stderr=${res.stderr} cmd=${cmd}`)
        assert.match(res.stdout, /compile with -Wall enabled/)
      } finally {
        await fx.cleanup()
      }
    })
  })

  describe('command shape', () => {
    it('binds the pattern to `-e` in BOTH branches, so it can never fill a bare positional slot', () => {
      const cmd = build('--pre=/tmp/evil.sh', '/work')
      assert.match(cmd, /rg --no-config .*--no-heading -e '--pre=\/tmp\/evil\.sh' -- '\/work'/)
      assert.match(cmd, /grep -r .* -e '--pre=\/tmp\/evil\.sh' -- '\/work'/)
    })

    it('keeps `-e` immediately before the pattern even with a glob filter present', () => {
      const cmd = build('-Wall', '/work', { glob: '*.c' })
      assert.match(cmd, /--no-heading --glob '\*\.c' -e '-Wall' -- '\/work'/)
    })
  })

  describe('the root slot (#7295 follow-through)', () => {
    // The fix bound the PATTERN. `root` is the builder's other interpolation and
    // was still bare. Both callers happen to guarantee an absolute path today
    // (safeResolveRoot / remapToContainerPath), so this is not a live hole — but
    // the builder must not rest on an invariant it neither states nor tests.
    // This is the adjacent-field shape: fix the field in the report, walk past
    // its neighbour.
    it('NEGATIVE CONTROL: a dash-leading root must not execute a program either', POSIX_ONLY, async (t) => {
      if (requireRgOrSkip(t, 'the root-slot execution proof')) return
      const fx = await makeFixture()
      try {
        const cmd = build('TODO', `--pre=${fx.script}`)
        const res = await runBuilt(cmd, { cwd: fx.root })
        assert.equal(
          await exists(fx.marker),
          false,
          `the ROOT slot was option-parsed and rg executed the preprocessor. rc=${res.code} stderr=${res.stderr} cmd=${cmd}`,
        )
      } finally {
        await fx.cleanup()
      }
    })

    it('terminates option parsing with `--` before the root in BOTH branches', () => {
      const cmd = build('TODO', '/work')
      assert.match(cmd, /rg --no-config .* -e 'TODO' -- '\/work'/)
      assert.match(cmd, /grep -r .* -e 'TODO' -- '\/work'/)
    })

    it('POSITIVE CONTROL: an ordinary root still searches normally', POSIX_ONLY, async (t) => {
      if (requireRgOrSkip(t, 'the ordinary-root positive control')) return
      const fx = await makeFixture()
      try {
        const res = await runBuilt(build('-Wall', fx.root), { cwd: fx.root })
        assert.equal(res.code, 0, `expected a match, got rc=${res.code} stderr=${res.stderr}`)
        assert.match(res.stdout, /compile with -Wall enabled/)
      } finally {
        await fx.cleanup()
      }
    })
  })

  describe('rg config isolation', () => {
    // Not only hardening: rg applies RIPGREP_CONFIG_PATH as flags, so a developer
    // config can silently CHANGE RESULTS of a machine-parsed search. Measured: a
    // config of `--pre=/bin/echo` turns a matching search into rc=1 no-match.
    it('ignores RIPGREP_CONFIG_PATH, which can both inject --pre and corrupt results', POSIX_ONLY, async (t) => {
      if (requireRgOrSkip(t, 'the rg config-isolation proof')) return
      const fx = await makeFixture()
      try {
        const cfg = path.join(fx.dir, 'rgcfg')
        await writeFile(cfg, `--pre=${fx.script}\n`)
        const res = await runBuilt(build('-Wall', fx.root), {
          cwd: fx.root,
          env: { ...process.env, RIPGREP_CONFIG_PATH: cfg },
        })
        assert.equal(await exists(fx.marker), false, 'a config-supplied --pre must not execute')
        assert.equal(res.code, 0, `a hostile/ordinary rg config changed the RESULT: rc=${res.code} stderr=${res.stderr}`)
        assert.match(res.stdout, /compile with -Wall enabled/)
      } finally {
        await fx.cleanup()
      }
    })
  })

  describe('permission-model coupling', () => {
    // The severity of #7295 comes from WHERE the sink sits, not from rg alone.
    // `Grep` is classified read-only, so it is auto-approved in acceptEdits mode
    // and can carry a standing auto-allow rule — while `Bash`, which has the same
    // capability honestly, is refused a whitelist outright. This test pins that
    // asymmetry to the builder: as long as Grep enjoys the read-only exemption,
    // its command must not let a pattern reach an option parser.
    it('Grep keeps its read-only exemption ONLY because the builder binds the pattern to `-e`', () => {
      assert.ok(SECRET_READ_FLOOR_TOOLS.has('Grep'), 'premise: Grep gets the reduced secret-read floor')
      assert.ok(ACCEPT_EDITS_TOOLS.has('Grep'), 'premise: Grep is auto-approved in acceptEdits mode')
      assert.ok(ELIGIBLE_TOOLS.has('Grep'), 'premise: Grep is eligible for a session auto-allow rule')
      assert.ok(NEVER_AUTO_ALLOW.has('Bash'), 'premise: Bash is too dangerous to whitelist')

      // Assert PER BRANCH. Matching the whole `if … then rg …; else grep …; fi`
      // string is satisfied by EITHER branch, so it stayed green under each
      // single-branch mutant while that branch was fully exploitable — a check
      // whose name claims more than its code verifies, which is the very defect
      // class this file was written for.
      for (const pattern of ['--pre=/tmp/evil.sh', '-Wall', '--force', '-f/etc/passwd', '--']) {
        const cmd = build(pattern, '/work')
        const [rgHalf, grepHalf] = cmd.split('; else ')
        assert.ok(rgHalf.includes('rg ') && grepHalf.includes('grep -r '), `unexpected builder shape: ${cmd}`)
        const quoted = `-e '${pattern}'`
        for (const [branch, half] of [['rg', rgHalf], ['grep', grepHalf]]) {
          assert.ok(
            half.includes(quoted),
            `pattern ${pattern} is not bound to -e in the ${branch} branch — Grep would exceed its read-only classification. half=${half}`,
          )
        }
      }
    })
  })
})
