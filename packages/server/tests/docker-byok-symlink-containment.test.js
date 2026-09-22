import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DockerByokSession, CONTAINER_WORKSPACE } from '../src/docker-byok-session.js'
import {
  CONTAINER_CONFINE_OK,
  CONTAINER_CONFINE_ESCAPE,
  CONTAINER_CONFINE_ERROR,
  CONTAINER_CONFINE_WITHHELD,
  parseConfinedContainerStdout,
  splitWithheldTrailer,
} from '../src/built-in-tools/tool-transforms.js'
import { addLogListener, removeLogListener } from '../src/logger.js'

const pexec = promisify(execFile)

/**
 * SECURITY (#7354) — container Glob/Grep/Read must not escape /workspace
 * through a SYMLINKED DIRECTORY inside it.
 *
 * `remapToContainerPath` and `globMatchEscapesRoot` are both LEXICAL, so
 * `esc/secret.txt` — where `/workspace/esc` is a symlink to a directory
 * outside the mount, in the CONTAINER's filesystem — has no leading `/`, no
 * `..` segment, and sails through both. The host cannot see that link: it is
 * not on the host's filesystem. So containment had to move INSIDE, and this
 * suite tests the thing that moved.
 *
 * HOW THE CONTAINER IS FAKED, and why it is barely a fake: the `_dockerBackend`
 * seam runs the daemon's `docker exec` script through a REAL `bash` on this
 * machine, against a REAL temp directory holding REAL symlinks, with the
 * literal `/workspace` rewritten to that directory. Nothing about symlink
 * resolution is emulated — `cd -P`, `readlink` and the physical-path
 * comparison are the same code paths the container runs. What the rewrite
 * gives up is only the container boundary itself, which is not what is under
 * test. No Docker daemon is started.
 *
 * That matters for the red-before-green claim. A stub that returned canned
 * stdout would have to be TOLD what the pre-fix container returns, which makes
 * the "before" half an assertion about the test author's beliefs. Here the
 * shell is executed either way: delete the in-container resolution and bash
 * genuinely hands back `esc/secret.txt`, exactly as a real container would.
 */

/** Windows has no bash and no POSIX symlink semantics — see project memory. */
const POSIX_ONLY = process.platform === 'win32'

let fixtureRoot
let workspaceDir

function buildFixture() {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'chroxy-7354-'))
  workspaceDir = join(fixtureRoot, 'ws')
  mkdirSync(join(workspaceDir, 'src'), { recursive: true })
  mkdirSync(join(workspaceDir, 'real'), { recursive: true })
  mkdirSync(join(fixtureRoot, 'outside'), { recursive: true })

  // OUTSIDE the mount — the thing that must never come back.
  writeFileSync(join(fixtureRoot, 'outside', 'secret.txt'), 'TOPSECRET_7354\n')
  writeFileSync(join(fixtureRoot, 'outside', 'other.txt'), 'TOPSECRET_7354 again\n')

  // Inside, legitimate.
  writeFileSync(join(workspaceDir, 'src', 'a.ts'), 'export const a = 1 // NEEDLE\n')
  writeFileSync(join(workspaceDir, 'real', 'b.ts'), 'export const b = 2 // NEEDLE\n')

  // The bug: a symlinked DIRECTORY inside the workspace.
  symlinkSync(join(fixtureRoot, 'outside'), join(workspaceDir, 'esc'))
  // The adjacent case: a symlinked FILE inside the workspace.
  symlinkSync(join(fixtureRoot, 'outside', 'secret.txt'), join(workspaceDir, 'leak.txt'))
  // The positive control: a symlink that stays inside.
  symlinkSync(join(workspaceDir, 'real'), join(workspaceDir, 'ok'))
}

/**
 * A `_dockerBackend` that executes the daemon's command in a real bash against
 * the fixture. `calls` records every command so a test can assert on the shape
 * the daemon SENT, not only on what came back.
 */
function bashBackend() {
  const calls = []
  return {
    calls,
    async execInEnvironment(containerId, opts) {
      calls.push({ containerId, ...opts })
      const parts = opts.cmd.split(CONTAINER_WORKSPACE)
      // Never let a silent no-op masquerade as a pass: if the rewrite matched
      // nothing the script would run against a /workspace that does not exist
      // here, and every assertion below would be about the wrong thing.
      assert.ok(parts.length > 1, 'fixture rewrite matched no /workspace in the command')
      const local = parts.join(workspaceDir)
      try {
        // stderr is passed through UNFILTERED. An earlier draft stripped
        // bash 3.2's `shopt: globstar: invalid shell option name` here, which
        // hid a real defect: that line made the caller's "no stdout AND
        // stderr" branch turn every empty Glob into `Glob failed`. The script
        // silences the option itself now (`2>/dev/null`), so there is nothing
        // to strip, and a harness that filtered would have kept it hidden.
        const { stdout, stderr } = await pexec('bash', ['-c', local], { maxBuffer: 8 << 20 })
        return { stdout, stderr }
      } catch (err) {
        // Mirrors execInEnvironment's contract closely enough for these tools:
        // it rejects on a non-zero exit. Every path the fix adds exits 0.
        throw err
      }
    },
  }
}

function buildSession(backend) {
  const execFileStub = (cmd, args, optsArg, callback) => {
    if (typeof callback === 'function') callback(null, '', '')
  }
  const session = new DockerByokSession({
    cwd: '/host/cwd',
    _execFile: execFileStub,
    _dockerBackend: backend,
  })
  session._containerReady = true
  session._containerId = 'CONTAINER_7354'
  return session
}

let originalHome
let originalConfigDir
let originalApiKey

describe('container Glob/Grep/Read symlink containment (#7354)', { skip: POSIX_ONLY }, () => {
  // Scoped INSIDE the skip: `symlinkSync` needs a privilege the Windows CI
  // runner does not have (project memory: measure_as_the_ci_account_not_yours),
  // so a module-level hook would red the Windows leg on the fixture rather than
  // on anything under test.
  beforeEach(() => {
    buildFixture()
    originalHome = process.env.HOME
    originalConfigDir = process.env.CHROXY_CONFIG_DIR
    originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.HOME = fixtureRoot
    process.env.CHROXY_CONFIG_DIR = join(fixtureRoot, '.chroxy')
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-fixture'
  })

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    if (originalConfigDir) process.env.CHROXY_CONFIG_DIR = originalConfigDir
    else delete process.env.CHROXY_CONFIG_DIR
    if (originalApiKey) process.env.ANTHROPIC_API_KEY = originalApiKey
    else delete process.env.ANTHROPIC_API_KEY
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  before(async () => {
    // A harness that cannot run bash must go RED, not quietly green.
    const { stdout } = await pexec('bash', ['-c', 'printf ok'])
    assert.equal(stdout, 'ok', 'the local bash harness must work, or this suite proves nothing')
  })

  // ── The four escape routes from the issue ────────────────────────────────

  it('ESCAPE 1/4 — Glob via `pattern` cannot read through a symlinked directory', async () => {
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Glob',
      input: { pattern: 'esc/*' },
    })
    // Withheld matches read as NO MATCH, deliberately — #7341's no-oracle rule.
    // Distinguishing "matched, but outside" from "matched nothing" would be an
    // existence oracle on a tool `ACCEPT_EDITS_TOOLS` auto-approves. The `path`
    // ARGUMENT is different (see 2/4): the caller named that directory itself.
    assert.equal(result.isError, false)
    assert.equal(result.content.includes('secret'), false, 'leaked a name from outside')
    assert.equal(result.content.includes('other'), false, 'leaked a name from outside')
    assert.match(result.content, /^No matches for/)
  })

  it('ESCAPE 2/4 — Glob via `path` cannot read through a symlinked directory', async () => {
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Glob',
      input: { pattern: '*', path: 'esc' },
    })
    assert.equal(result.isError, true)
    assert.equal(result.content.includes('secret'), false, 'leaked a name from outside')
    assert.match(result.content, /resolves outside the workspace/)
  })

  it('ESCAPE 3/4 — Grep via `path` cannot search through a symlinked directory', async () => {
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Grep',
      input: { pattern: 'TOPSECRET_7354', path: 'esc' },
    })
    assert.equal(result.isError, true)
    assert.equal(result.content.includes('TOPSECRET_7354'), false, 'leaked file contents')
    assert.match(result.content, /resolves outside the workspace/)
  })

  it('ESCAPE 4/4 — Read via `file_path` cannot read through a symlinked directory', async () => {
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Read',
      input: { file_path: 'esc/secret.txt' },
    })
    assert.equal(result.isError, true)
    assert.equal(result.content.includes('TOPSECRET_7354'), false, 'leaked file contents')
    assert.match(result.content, /resolves outside the workspace/)
  })

  // ── The adjacent case: a symlinked FILE, not directory ───────────────────

  it('Read cannot follow a symlinked FILE out of the workspace', async () => {
    // Not in the issue's four routes, and the same defect one field over —
    // `/workspace/leak.txt -> <outside>/secret.txt` is lexically spotless too.
    // Fixing the directory case and walking past this one is the pattern in
    // project memory as adjacent_field_wire_cap_pattern.
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Read',
      input: { file_path: 'leak.txt' },
    })
    assert.equal(result.isError, true)
    assert.equal(result.content.includes('TOPSECRET_7354'), false, 'leaked file contents')
  })

  it('Glob withholds a symlinked FILE that points out of the workspace', async () => {
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Glob',
      input: { pattern: '*' },
    })
    assert.equal(result.isError, false)
    assert.equal(result.content.includes('leak.txt'), false, 'emitted an escaping symlink')
    assert.equal(result.content.includes('esc'), false, 'emitted an escaping symlink')
    // POSITIVE CONTROL in the SAME call — a refuse-everything Glob fails here.
    assert.match(result.content, /(^|\n)src(\n|$)/)
    assert.match(result.content, /(^|\n)ok(\n|$)/)
  })

  it('a glob whose LAST match is withheld still exits 0', async () => {
    // `execInEnvironment` REJECTS on a non-zero exit, and a `for` loop's status
    // is that of the last command it ran. If the final iteration ended on the
    // withhold branch and that branch reported failure, every such Glob would
    // arrive as a thrown container error instead of "No matches" — a refusal
    // that looks like a broken container rather than like containment working.
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Glob',
      input: { pattern: 'esc*' },      // matches only `esc`, which is withheld
    })
    assert.equal(result.isError, false)
    assert.match(result.content, /^No matches for/)
  })

  // ── Positive controls ────────────────────────────────────────────────────
  //
  // Each asserts the MATCHES themselves, not merely the absence of an error, so
  // a "fix" that refused everything (or returned an empty success) goes red.

  it('POSITIVE — Glob still returns a nested in-workspace pattern', async () => {
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Glob',
      input: { pattern: 'src/*.ts' },
    })
    assert.equal(result.isError, false)
    assert.equal(result.content.trim(), 'src/a.ts')
  })

  it('POSITIVE — Glob still honours an in-workspace `path` argument', async () => {
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Glob',
      input: { pattern: '*.ts', path: 'src' },
    })
    assert.equal(result.isError, false)
    assert.equal(result.content.trim(), 'a.ts')
  })

  it('POSITIVE — Glob follows a symlink that stays INSIDE the workspace', async () => {
    // `ok -> real`. A fix that refused every symlink outright would be a
    // functional regression (node_modules/.bin is symlinks all the way down),
    // so containment must be about where a link LANDS, not that it is a link.
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Glob',
      input: { pattern: 'ok/*.ts' },
    })
    assert.equal(result.isError, false)
    assert.equal(result.content.trim(), 'ok/b.ts')
  })

  it('POSITIVE — Grep still searches an in-workspace `path`', async () => {
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Grep',
      input: { pattern: 'NEEDLE', path: 'src' },
    })
    assert.equal(result.isError, false)
    assert.match(result.content, /a\.ts/)
    assert.match(result.content, /NEEDLE/)
  })

  it('POSITIVE — Read still returns an in-workspace file, line-numbered', async () => {
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Read',
      input: { file_path: 'src/a.ts' },
    })
    assert.equal(result.isError, false)
    assert.match(result.content, /1→export const a = 1 \/\/ NEEDLE/)
  })

  it('POSITIVE — Read through an in-workspace symlinked directory still works', async () => {
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Read',
      input: { file_path: 'ok/b.ts' },
    })
    assert.equal(result.isError, false)
    assert.match(result.content, /1→export const b = 2 \/\/ NEEDLE/)
  })

  it('POSITIVE — a missing file still reports the tool error, not a containment error', async () => {
    // A leaf that does not exist resolves (its PARENT does), so "not found"
    // must keep arriving as `sed`'s message. Collapsing it into the
    // containment error would make every typo look like an attack.
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Read',
      input: { file_path: 'src/nope.ts' },
    })
    assert.equal(result.isError, true)
    assert.equal(/resolves outside the workspace/.test(result.content), false)
    assert.match(result.content, /No such file/)
  })

  // ── The command the daemon actually sends ────────────────────────────────

  it('every container Glob/Grep/Read carries the in-container resolver', async () => {
    // The guard that catches a route added later and wired to nothing. Booleans,
    // not assert.match: the subject is a multi-KB script and a failing
    // assert.match carries the whole of it into the TAP stream (#7340).
    const cases = [
      ['Glob', { pattern: 'src/*.ts' }],
      ['Grep', { pattern: 'NEEDLE' }],
      ['Read', { file_path: 'src/a.ts' }],
    ]
    for (const [toolName, input] of cases) {
      const backend = bashBackend()
      const session = buildSession(backend)
      await session._dispatchBuiltinTool({ toolName, input })
      assert.equal(backend.calls.length, 1, `${toolName} should issue one docker exec`)
      const cmd = backend.calls[0].cmd
      assert.ok(cmd.includes('__cx_resolve()'), `${toolName} lost the resolver`)
      assert.ok(cmd.includes('cd -P --'), `${toolName} lost the physical cd`)
      assert.ok(cmd.includes(CONTAINER_CONFINE_OK), `${toolName} lost the OK sentinel`)
      assert.ok(cmd.includes(CONTAINER_CONFINE_ESCAPE), `${toolName} lost the escape sentinel`)
      // The body must use the RESOLVED path, not the lexical one it was handed
      // — the host does the same (buildGrepCommand gets safeResolveRoot's
      // realpath, never the alias).
      assert.ok(cmd.includes('"$__cx_target"'), `${toolName} searches the unresolved path`)
    }
  })

  it('the Glob script silences globstar so an old bash cannot turn containment into an error', async () => {
    // A guard for a defect that is INVISIBLE on the CI runner: bash 5 accepts
    // `globstar` silently, so dropping the redirect reds nothing on Linux. The
    // image is the variable, not the runner — assert the emitted text.
    const backend = bashBackend()
    const session = buildSession(backend)
    await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: 'src/*.ts' } })
    const cmd = backend.calls[0].cmd
    assert.ok(cmd.includes('shopt -s globstar 2>/dev/null'), 'globstar is not silenced')
    assert.ok(cmd.includes('shopt -s nullglob'), 'nullglob lost')
  })

  // ── The operator's trace for a silent withhold (#7354) ───────────────────

  it('a withheld match is silent to the MODEL and logged for the OPERATOR', async () => {
    // The whole reason the withhold is silent is the no-oracle rule, and the
    // whole reason that is not false safety is this line. A containment whose
    // only successful outcome is an ordinary success is indistinguishable from
    // one that was never wired up.
    const lines = []
    const listener = (entry) => lines.push(typeof entry === 'string' ? entry : (entry?.msg ?? JSON.stringify(entry)))
    addLogListener(listener)
    try {
      const backend = bashBackend()
      const session = buildSession(backend)
      session._sourceSessionId = 'sess-7354'
      const result = await session._dispatchBuiltinTool({
        toolName: 'Glob',
        input: { pattern: 'esc/*' },
      })
      assert.equal(result.isError, false)
      assert.match(result.content, /^No matches for/)
      const hit = lines.find((l) => l.includes('[container-confine]') && l.includes('withheld'))
      assert.ok(hit, `no containment log line; saw ${JSON.stringify(lines)}`)
      assert.ok(/withheld 2 match\(es\)/.test(hit), `wrong count in ${JSON.stringify(hit)}`)
      assert.ok(hit.includes('session=sess-7354'), 'log line lost the session id')
      assert.ok(hit.includes('container=CONTAINER_73'), 'log line lost the container id')
      // The thing containment refused must not reappear in the log.
      assert.equal(hit.includes('secret'), false, 'logged a withheld path')
      assert.equal(hit.includes('/etc'), false, 'logged a resolved target')
    } finally {
      removeLogListener(listener)
    }
  })

  it('a clean Glob logs nothing and never forwards the withheld trailer', async () => {
    const lines = []
    const listener = (entry) => lines.push(typeof entry === 'string' ? entry : (entry?.msg ?? JSON.stringify(entry)))
    addLogListener(listener)
    try {
      const backend = bashBackend()
      const session = buildSession(backend)
      const result = await session._dispatchBuiltinTool({
        toolName: 'Glob',
        input: { pattern: 'src/*.ts' },
      })
      assert.equal(result.content.trim(), 'src/a.ts')
      assert.equal(result.content.includes(CONTAINER_CONFINE_WITHHELD), false, 'trailer reached the model')
      assert.equal(lines.some((l) => l.includes('[container-confine]')), false, 'logged a clean Glob')
    } finally {
      removeLogListener(listener)
    }
  })

  it('a container reply with no withheld trailer is logged as UNKNOWN, not as zero', async () => {
    // "Cannot measure this" must not read as "nothing to measure" — the second
    // recurring cause in docs/false-safety-guards.md, one register down.
    const lines = []
    const listener = (entry) => lines.push(typeof entry === 'string' ? entry : (entry?.msg ?? JSON.stringify(entry)))
    addLogListener(listener)
    try {
      const backend = {
        calls: [],
        async execInEnvironment() {
          return { stdout: `${CONTAINER_CONFINE_OK}\nsrc/a.ts\n`, stderr: '' }
        },
      }
      const session = buildSession(backend)
      const result = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: '*' } })
      assert.equal(result.content.trim(), 'src/a.ts')
      assert.ok(
        lines.some((l) => l.includes('[container-confine]') && l.includes('withheld-count unavailable')),
        `no unavailable-count line; saw ${JSON.stringify(lines)}`,
      )
    } finally {
      removeLogListener(listener)
    }
  })

  it('a refused path is logged for the operator on all three tools', async () => {
    const cases = [
      ['Glob', { pattern: '*', path: 'esc' }],
      ['Grep', { pattern: 'TOPSECRET_7354', path: 'esc' }],
      ['Read', { file_path: 'esc/secret.txt' }],
    ]
    for (const [toolName, input] of cases) {
      const lines = []
      const listener = (entry) => lines.push(typeof entry === 'string' ? entry : (entry?.msg ?? JSON.stringify(entry)))
      addLogListener(listener)
      try {
        const session = buildSession(bashBackend())
        await session._dispatchBuiltinTool({ toolName, input })
        assert.ok(
          lines.some((l) => l.includes('[container-confine]') && l.includes(`${toolName}: refused a path (escape)`)),
          `${toolName} logged no refusal; saw ${JSON.stringify(lines)}`,
        )
      } finally {
        removeLogListener(listener)
      }
    }
  })

  // ── Fail-closed on a reply the host cannot account for ───────────────────

  it('resolves a symlink even where readlink does not honour `--` (BusyBox/Alpine)', async () => {
    // The image is a user opt and there is no allowlist, so an Alpine container
    // is reachable. A `readlink` that read `--` as a path would refuse every
    // legitimate symlink — the resolver falls back to the bare form, which is
    // safe here because `$__p` is always absolute by that line.
    const backend = bashBackend()
    const session = buildSession(backend)
    await session._dispatchBuiltinTool({ toolName: 'Read', input: { file_path: 'ok/b.ts' } })
    const cmd = backend.calls[0].cmd
    assert.ok(cmd.includes('readlink -- "$__p" 2>/dev/null || readlink "$__p"'), 'no readlink fallback')
  })

  it('an unparseable container reply is an error for all three tools, not "no matches"', async () => {
    // "cannot check this" silently treated as "nothing to check" is the second
    // recurring cause in docs/false-safety-guards.md. A reply with no sentinel
    // means the guard's verdict is unknown, and unknown is refused.
    const cases = [
      ['Glob', { pattern: 'src/*.ts' }],
      ['Grep', { pattern: 'NEEDLE' }],
      ['Read', { file_path: 'src/a.ts' }],
    ]
    for (const [toolName, input] of cases) {
      const backend = {
        calls: [],
        async execInEnvironment() {
          return { stdout: 'src/a.ts\nsrc/b.ts\n', stderr: '' }
        },
      }
      const session = buildSession(backend)
      const result = await session._dispatchBuiltinTool({ toolName, input })
      assert.equal(result.isError, true, `${toolName} accepted an unguarded reply`)
      assert.equal(result.content.includes('src/b.ts'), false, `${toolName} emitted the payload`)
      // An unparseable reply is a fact about the CONTAINER, not about the path.
      // Reporting it as "could not resolve <path>" sends an operator to look at
      // the file when the thing to look at is the guard.
      assert.match(result.content, /no valid confinement verdict/)
      assert.equal(/could not resolve/.test(result.content), false, `${toolName} blamed the path`)
    }
  })

  it('an empty container reply is an error, not a silent success', async () => {
    const backend = {
      calls: [],
      async execInEnvironment() {
        return { stdout: '', stderr: '' }
      },
    }
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: '*' } })
    assert.equal(result.isError, true)
  })

  it('the error sentinel surfaces as a resolution failure, distinct from an escape', async () => {
    const backend = {
      calls: [],
      async execInEnvironment() {
        return { stdout: `${CONTAINER_CONFINE_ERROR}\n`, stderr: '' }
      },
    }
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({ toolName: 'Read', input: { file_path: 'a.ts' } })
    assert.equal(result.isError, true)
    assert.match(result.content, /could not resolve/)
    assert.equal(/resolves outside the workspace/.test(result.content), false)
    // ... and distinct from an unparseable reply: the error sentinel means the
    // container DID answer, about the path.
    assert.equal(/no valid confinement verdict/.test(result.content), false)
  })
})

describe('parseConfinedContainerStdout (#7354)', () => {
  it('splits the OK sentinel off the body', () => {
    assert.deepEqual(
      parseConfinedContainerStdout(`${CONTAINER_CONFINE_OK}\nsrc/a.ts\n`),
      { ok: true, body: 'src/a.ts\n' },
    )
  })

  it('reports an OK sentinel with no body as an empty body, not a failure', () => {
    assert.deepEqual(
      parseConfinedContainerStdout(`${CONTAINER_CONFINE_OK}\n`),
      { ok: true, body: '' },
    )
  })

  it('maps each failure sentinel to its own reason', () => {
    assert.deepEqual(
      parseConfinedContainerStdout(`${CONTAINER_CONFINE_ESCAPE}\n`),
      { ok: false, reason: 'escape' },
    )
    assert.deepEqual(
      parseConfinedContainerStdout(`${CONTAINER_CONFINE_ERROR}\n`),
      { ok: false, reason: 'error' },
    )
  })

  it('refuses anything else', () => {
    for (const bad of ['', 'src/a.ts\n', `x${CONTAINER_CONFINE_OK}\n`, `${CONTAINER_CONFINE_OK}x\n`, null, undefined, 42]) {
      assert.deepEqual(
        parseConfinedContainerStdout(bad),
        { ok: false, reason: 'unparseable' },
        `accepted ${JSON.stringify(bad)}`,
      )
    }
  })
})

describe('splitWithheldTrailer (#7354)', () => {
  it('strips the trailer and returns the count', () => {
    assert.deepEqual(
      splitWithheldTrailer(`src/a.ts\nsrc/b.ts\n${CONTAINER_CONFINE_WITHHELD} 3\n`),
      { body: 'src/a.ts\nsrc/b.ts\n', withheld: 3 },
    )
  })

  it('handles a body that is ONLY the trailer', () => {
    assert.deepEqual(
      splitWithheldTrailer(`${CONTAINER_CONFINE_WITHHELD} 2\n`),
      { body: '', withheld: 2 },
    )
  })

  it('reports zero as zero, not as absent', () => {
    assert.deepEqual(
      splitWithheldTrailer(`${CONTAINER_CONFINE_WITHHELD} 0\n`),
      { body: '', withheld: 0 },
    )
  })

  it('reports an ABSENT trailer as null, never as zero', () => {
    for (const body of ['src/a.ts\n', '', 'x', null, undefined]) {
      assert.equal(splitWithheldTrailer(body).withheld, null, `claimed a count for ${JSON.stringify(body)}`)
    }
  })

  it('only the LAST line can be the trailer', () => {
    // A file named like the trailer, in the middle of the results, must stay a
    // result — and must not hand the log a number the container never sent.
    const body = `${CONTAINER_CONFINE_WITHHELD} 9\nsrc/a.ts\n`
    assert.deepEqual(splitWithheldTrailer(body), { body, withheld: null })
  })

  it('rejects a malformed count rather than coercing it', () => {
    const body = `src/a.ts\n${CONTAINER_CONFINE_WITHHELD} -1\n`
    assert.deepEqual(splitWithheldTrailer(body), { body, withheld: null })
  })
})
