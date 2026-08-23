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
import { existsSync } from 'node:fs'
import { buildGrepArgs, buildGrepCommand } from '../../src/built-in-tools/tool-transforms.js'
import { SECRET_READ_FLOOR_TOOLS } from '../../src/permission-floor.js'
import { ELIGIBLE_TOOLS, NEVER_AUTO_ALLOW } from '../../src/permission-manager.js'

/** Locate an executable on PATH without shelling out. */
function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

const RG_PATH = findOnPath('rg')
const GREP_PATH = findOnPath('grep')
const BASH_PATH = findOnPath('bash') || '/bin/bash'

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

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

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
  assert.ok(GREP_PATH, 'grep must be on PATH for the fallback-branch tests')
  assert.ok(BASH_PATH, 'bash must be on PATH for the fallback-branch tests')
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
    it('NEGATIVE CONTROL: a `--pre=` pattern must not execute a program', async (t) => {
      if (!RG_PATH) {
        t.skip('ripgrep is not installed on this machine — the rg-branch execution proof did NOT run. The grep-branch and command-shape tests below still cover the fix.')
        return
      }
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

    it('NEGATIVE CONTROL: a `--pre=` pattern must terminate, not hang on stdin', async (t) => {
      if (!RG_PATH) {
        t.skip('ripgrep is not installed on this machine — the rg-branch hang proof did NOT run.')
        return
      }
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

    it('POSITIVE CONTROL: a legitimately dash-leading pattern (`-Wall`) still matches as text', async (t) => {
      if (!RG_PATH) {
        t.skip('ripgrep is not installed on this machine — the rg-branch positive control did NOT run.')
        return
      }
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
    it('NEGATIVE CONTROL: a `--pre=` pattern is searched as text, not parsed as an option', async () => {
      const fx = await makeFixture()
      try {
        const bin = await makeGrepOnlyPath(fx.dir)
        const cmd = build(`--pre=${fx.script}`, fx.root)
        const res = await runBuilt(cmd, {
          cwd: fx.root,
          env: { ...process.env, PATH: bin },
        })
        assert.equal(res.spawnError, undefined, `bash failed to spawn: ${res.spawnError}`)
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

    it('POSITIVE CONTROL: `-Wall` still matches as text through the grep fallback', async () => {
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
      assert.match(cmd, /rg .*--no-heading -e '--pre=\/tmp\/evil\.sh' '\/work'/)
      assert.match(cmd, /grep -r .* -e '--pre=\/tmp\/evil\.sh' '\/work'/)
    })

    it('keeps `-e` immediately before the pattern even with a glob filter present', () => {
      const cmd = build('-Wall', '/work', { glob: '*.c' })
      assert.match(cmd, /--no-heading --glob '\*\.c' -e '-Wall' '\/work'/)
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
      assert.ok(ELIGIBLE_TOOLS.has('Grep'), 'premise: Grep is eligible for a session auto-allow rule')
      assert.ok(NEVER_AUTO_ALLOW.has('Bash'), 'premise: Bash is too dangerous to whitelist')

      // Every dash-leading shape a model could send must land as the operand of
      // `-e`, never in a slot rg or grep would option-parse.
      for (const pattern of ['--pre=/tmp/evil.sh', '-Wall', '--force', '-f/etc/passwd', '--']) {
        const cmd = build(pattern, '/work')
        assert.match(
          cmd,
          new RegExp(`-e '${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
          `pattern ${pattern} is not bound to -e — Grep would exceed its read-only classification`,
        )
      }
    })
  })
})
