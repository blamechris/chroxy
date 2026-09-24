import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, chmodSync, existsSync,
  readFileSync, readdirSync, lstatSync, realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DockerByokSession, CONTAINER_WORKSPACE } from '../src/docker-byok-session.js'
import {
  CONTAINER_CONFINE_OK,
  CONTAINER_CONFINE_ESCAPE,
  CONTAINER_CONFINE_ERROR,
  CONTAINER_CONFINE_WITHHELD,
  buildConfinedContainerCommand,
  parseConfinedContainerStdout,
  splitWithheldTrailer,
} from '../src/built-in-tools/tool-transforms.js'
import { addLogListener, removeLogListener } from '../src/logger.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

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
 *
 * `pathPrefix` is prepended to `PATH` for the bash run, which is how a test
 * swaps in a stand-in for one of the external programs the script reaches for
 * (currently only `readlink`). Without it the run inherits this machine's
 * environment unchanged.
 *
 * `root` replaces the directory `/workspace` is rewritten to (default: this
 * suite's `workspaceDir`), so the #7876 block below can run the same harness
 * against its own fixture.
 */
function bashBackend({ pathPrefix, root } = {}) {
  const calls = []
  const env = pathPrefix ? { ...process.env, PATH: `${pathPrefix}:${process.env.PATH}` } : undefined
  return {
    calls,
    async execInEnvironment(containerId, opts) {
      calls.push({ containerId, ...opts })
      const parts = opts.cmd.split(CONTAINER_WORKSPACE)
      // Never let a silent no-op masquerade as a pass: if the rewrite matched
      // nothing the script would run against a /workspace that does not exist
      // here, and every assertion below would be about the wrong thing.
      assert.ok(parts.length > 1, 'fixture rewrite matched no /workspace in the command')
      const local = parts.join(root ?? workspaceDir)
      try {
        // stderr is passed through UNFILTERED. An earlier draft stripped
        // bash 3.2's `shopt: globstar: invalid shell option name` here, which
        // hid a real defect: that line made the caller's "no stdout AND
        // stderr" branch turn every empty Glob into `Glob failed`. The script
        // silences the option itself now (`2>/dev/null`), so there is nothing
        // to strip, and a harness that filtered would have kept it hidden.
        const { stdout, stderr } = await pexec('bash', ['-c', local], { maxBuffer: 8 << 20, env })
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
          // #7357 — NUL-terminated match, matching buildConfinedGlobBody's
          // real delimiter; the trailer is what's absent here, not the NUL.
          return { stdout: `${CONTAINER_CONFINE_OK}\nsrc/a.ts\0`, stderr: '' }
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
    //
    // This RUNS that fallback rather than asserting its spelling: a regex over
    // the emitted script is the shape `docs/false-safety-guards.md` catalogues
    // (`#7646`), and the whole claim here is about a program this machine's
    // `readlink` does not behave like. So the program is replaced.
    //
    // A symlinked FILE is the only thing that reaches `readlink` at all — a
    // symlinked DIRECTORY is resolved by `cd -P`, a shell builtin.
    const realReadlink = ['/usr/bin/readlink', '/bin/readlink'].find((p) => existsSync(p))
    assert.ok(realReadlink, 'no system readlink to build the stand-in on — this test would prove nothing')

    const shimDir = join(fixtureRoot, 'busybox-bin')
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(join(shimDir, 'readlink'), [
      '#!/bin/sh',
      '# BusyBox shape: no `--` terminator, and a leading `-` operand is an option.',
      'case "$1" in',
      '  --) echo "readlink: --: No such file or directory" >&2; exit 1 ;;',
      '  -*) echo "readlink: unrecognized option: $1" >&2; exit 1 ;;',
      'esac',
      `exec ${realReadlink} "$1"`,
      '',
    ].join('\n'))
    chmodSync(join(shimDir, 'readlink'), 0o755)

    // Named so the stand-in would reject it as an option if the resolver ever
    // handed `readlink` a RELATIVE name — which is the guarantee the fallback
    // rests on, and the one thing that would make dropping `--` a repeat of
    // `#7295` rather than a harmless widening.
    symlinkSync(join(workspaceDir, 'real', 'b.ts'), join(workspaceDir, '-n'))

    const session = buildSession(bashBackend({ pathPrefix: shimDir }))
    const inside = await session._dispatchBuiltinTool({ toolName: 'Read', input: { file_path: '-n' } })
    assert.equal(inside.isError, false, `a dash-named in-bounds symlink was refused: ${inside.content}`)
    assert.ok(inside.content.includes('export const b = 2'), `wrong body: ${inside.content}`)

    // ... and the fallback opened no hole: a symlinked file pointing OUT is
    // still an ESCAPE, not an unresolvable error and not a read.
    const outside = await session._dispatchBuiltinTool({ toolName: 'Read', input: { file_path: 'leak.txt' } })
    assert.equal(outside.isError, true)
    assert.ok(/resolves outside the workspace/.test(outside.content), `wrong refusal: ${outside.content}`)
    assert.equal(outside.content.includes('TOPSECRET_7354'), false, 'leaked the file it refused')
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

// ── #7876 — container Write/Edit through a symlinked directory ─────────────
//
// Same harness as the #7354 block above (real bash, real symlinks, `/workspace`
// rewritten to a temp dir), so the red half of every escape below is a real
// shell run and not a fixture. A separate `describe` with its own fixture
// rather than more entries in the one above: these cases add a DANGLING link
// and a leaf alias to the workspace root, and the Glob tests above assert the
// exact listing and withheld count of that root.

let wfRoot
let wfWs
let wfOut

function buildWriteFixture() {
  wfRoot = mkdtempSync(join(tmpdir(), 'chroxy-7876-'))
  wfWs = join(wfRoot, 'ws')
  wfOut = join(wfRoot, 'outside')
  mkdirSync(join(wfWs, 'real'), { recursive: true })
  mkdirSync(wfOut, { recursive: true })
  writeFileSync(join(wfOut, 'hosts'), 'ORIGINAL_HOSTS_7876\n')
  writeFileSync(join(wfOut, 'target.txt'), 'ORIGINAL_TARGET_7876\n')
  writeFileSync(join(wfWs, 'plain.txt'), 'hello plain world\n')
  // The bug: a symlinked DIRECTORY inside the workspace pointing out.
  symlinkSync(wfOut, join(wfWs, 'esc'))
  // A symlinked LEAF pointing out.
  symlinkSync(join(wfOut, 'target.txt'), join(wfWs, 'alias.txt'))
  // A DANGLING directory link whose target cannot be created.
  symlinkSync(join(wfRoot, 'nonexistent', 'dir'), join(wfWs, 'dangling'))
  // A DANGLING leaf link pointing out — `>` follows it and CREATES the target.
  symlinkSync(join(wfOut, 'created.txt'), join(wfWs, 'dleaf.txt'))
  // The positive control: a link that stays inside.
  symlinkSync(join(wfWs, 'real'), join(wfWs, 'alias'))
}

/** `bashBackend`, pointed at this block's fixture. */
function wfBackend(opts = {}) {
  return bashBackend({ ...opts, root: wfWs })
}

function outsideListing() {
  return readdirSync(wfOut).sort()
}

describe('container Write/Edit symlink containment (#7876)', { skip: POSIX_ONLY || SKIP_NO_SYMLINK }, () => {
  let savedHome
  let savedConfigDir
  let savedApiKey

  beforeEach(() => {
    buildWriteFixture()
    savedHome = process.env.HOME
    savedConfigDir = process.env.CHROXY_CONFIG_DIR
    savedApiKey = process.env.ANTHROPIC_API_KEY
    process.env.HOME = wfRoot
    process.env.CHROXY_CONFIG_DIR = join(wfRoot, '.chroxy')
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-fixture'
  })

  afterEach(() => {
    if (savedHome) process.env.HOME = savedHome
    else delete process.env.HOME
    if (savedConfigDir) process.env.CHROXY_CONFIG_DIR = savedConfigDir
    else delete process.env.CHROXY_CONFIG_DIR
    if (savedApiKey) process.env.ANTHROPIC_API_KEY = savedApiKey
    else delete process.env.ANTHROPIC_API_KEY
    rmSync(wfRoot, { recursive: true, force: true })
  })

  // ── Escapes ──────────────────────────────────────────────────────────────

  it('ESCAPE — Write through a symlinked directory is refused and creates nothing outside', async () => {
    const session = buildSession(wfBackend())
    const result = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'esc/hosts', content: 'PWNED_7876\n' },
    })
    assert.equal(result.isError, true, `Write escaped: ${result.content}`)
    assert.equal(readFileSync(join(wfOut, 'hosts'), 'utf8'), 'ORIGINAL_HOSTS_7876\n', 'overwrote a file outside')
    assert.deepEqual(outsideListing(), ['hosts', 'target.txt'])
    assert.ok(/resolves outside the workspace/.test(result.content), `wrong refusal: ${result.content}`)
    // Existence-oracle rule (#7341/#7354): say THAT it resolves outside, never WHERE.
    assert.equal(result.content.includes(wfRoot), false, 'the refusal revealed the resolved path')
    assert.equal(result.content.includes(realpathSync(wfRoot)), false, 'the refusal revealed the resolved path')
    assert.equal(result.content.includes('outside/'), false, 'the refusal revealed the resolved path')
  })

  it('ESCAPE — Write to a NOT-YET-EXISTING deep path through a symlinked directory is refused', async () => {
    // The case that needs the deepest-existing-ancestor walk: `esc/new/deeper`
    // does not exist, so resolving the whole path fails, and `mkdir -p` of the
    // lexical parent would create `new/deeper` OUTSIDE.
    const session = buildSession(wfBackend())
    const result = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'esc/new/deeper/file.txt', content: 'PWNED_7876\n' },
    })
    assert.equal(result.isError, true, `Write escaped: ${result.content}`)
    assert.deepEqual(outsideListing(), ['hosts', 'target.txt'], 'created a directory outside')
    assert.equal(existsSync(join(wfWs, 'new')), false, 'created `new/` inside instead')
    assert.equal(existsSync(join(wfWs, 'real', 'new')), false, 'created `new/` under another dir')
    assert.ok(/resolves outside the workspace/.test(result.content), `wrong refusal: ${result.content}`)
    assert.equal(result.content.includes(realpathSync(wfRoot)), false, 'the refusal revealed the resolved path')
  })

  it('ESCAPE — Edit through a symlinked directory neither reads nor writes', async () => {
    const backend = wfBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Edit',
      input: { file_path: 'esc/hosts', old_string: 'ORIGINAL', new_string: 'PWNED' },
    })
    assert.equal(result.isError, true, `Edit escaped: ${result.content}`)
    assert.equal(result.content.includes('ORIGINAL_HOSTS_7876'), false, 'leaked the file contents')
    assert.equal(readFileSync(join(wfOut, 'hosts'), 'utf8'), 'ORIGINAL_HOSTS_7876\n', 'wrote through the link')
    assert.equal(backend.calls.length, 1, 'Edit went on to a write-back after the refused read')
    assert.equal(backend.calls[0].cmd.includes('base64 -d'), false, 'the read call carried a write')
    assert.ok(/resolves outside the workspace/.test(result.content), `wrong refusal: ${result.content}`)
    assert.equal(result.content.includes(realpathSync(wfRoot)), false, 'the refusal revealed the resolved path')
  })

  it('ESCAPE — Write to a symlinked LEAF pointing outside is refused', async () => {
    const session = buildSession(wfBackend())
    const result = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'alias.txt', content: 'PWNED_7876\n' },
    })
    assert.equal(result.isError, true, `Write escaped: ${result.content}`)
    assert.equal(readFileSync(join(wfOut, 'target.txt'), 'utf8'), 'ORIGINAL_TARGET_7876\n', 'overwrote the link target')
    assert.ok(/resolves outside the workspace/.test(result.content), `wrong refusal: ${result.content}`)
  })

  it('ESCAPE — Write to a DANGLING leaf link pointing outside does not create its target', async () => {
    // `>` follows a dangling link and CREATES what it names. The walk must
    // treat the dangling link as EXISTING (`-e || -L`): with `-e` alone it
    // walks past it, resolves only the workspace, and the write then lands
    // wherever the link pointed.
    const session = buildSession(wfBackend())
    const result = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'dleaf.txt', content: 'PWNED_7876\n' },
    })
    assert.equal(result.isError, true, `Write escaped: ${result.content}`)
    assert.equal(existsSync(join(wfOut, 'created.txt')), false, 'created the dangling link target outside')
    assert.deepEqual(outsideListing(), ['hosts', 'target.txt'])
  })

  it('FAIL CLOSED — Write through a DANGLING directory link is an error and creates nothing', async () => {
    const session = buildSession(wfBackend())
    const result = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'dangling/x.txt', content: 'PWNED_7876\n' },
    })
    assert.equal(result.isError, true, `Write succeeded through a dangling link: ${result.content}`)
    assert.equal(existsSync(join(wfRoot, 'nonexistent')), false, 'created the dangling link target')
    assert.equal(lstatSync(join(wfWs, 'dangling')).isSymbolicLink(), true, 'the link itself was replaced')
  })

  it('TOCTOU — a link swapped AFTER the check cannot redirect the write (body uses the resolved path)', async () => {
    // Simulates the race the issue names: the harness swaps `alias` from
    // `real` to `outside` at the instant the body's `mkdir` runs, i.e. after
    // the containment check passed. A body that used the lexical alias would
    // follow the swapped link out; one that uses `"$__cx_target"` never goes
    // through `alias` again. (A swap INSIDE the resolved prefix is the
    // accepted check-then-use residual — this is the swap that is not.)
    const realMkdir = ['/bin/mkdir', '/usr/bin/mkdir'].find((p) => existsSync(p))
    assert.ok(realMkdir, 'no system mkdir to build the stand-in on — this test would prove nothing')
    const shimDir = join(wfRoot, 'swap-bin')
    const marker = join(wfRoot, 'swapped')
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(join(shimDir, 'mkdir'), [
      '#!/bin/sh',
      `if [ ! -e '${marker}' ]; then`,
      `  : > '${marker}'`,
      `  rm -f '${join(wfWs, 'alias')}' && ln -s '${wfOut}' '${join(wfWs, 'alias')}'`,
      'fi',
      `exec ${realMkdir} "$@"`,
      '',
    ].join('\n'))
    chmodSync(join(shimDir, 'mkdir'), 0o755)

    const session = buildSession(wfBackend({ pathPrefix: shimDir }))
    const result = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'alias/new/file.txt', content: 'RACED_7876\n' },
    })
    assert.ok(existsSync(marker), 'the swap never happened — this test proved nothing')
    assert.deepEqual(outsideListing(), ['hosts', 'target.txt'], 'the write followed the swapped link out')
    assert.equal(result.isError, false, `in-bounds write failed: ${result.content}`)
    assert.equal(readFileSync(join(wfWs, 'real', 'new', 'file.txt'), 'utf8'), 'RACED_7876\n')
  })

  it('TOCTOU — a link swapped AFTER the check cannot redirect Edit\'s read (cat uses the resolved path)', async () => {
    // The read half of the test above. The harness swaps `alias` from `real`
    // to `outside` at the instant the body's `cat` runs. `old_string` occurs
    // ONLY in the outside file, so the tool_result is the observable: a `cat`
    // that went back through the lexical alias reads the outside file, finds a
    // match, and gets as far as the write-back (which the second resolution
    // then refuses) — a content oracle on a file outside the workspace. A
    // `cat "$__cx_target"` reads `real/hosts` and reports no match.
    const realCat = ['/bin/cat', '/usr/bin/cat'].find((p) => existsSync(p))
    assert.ok(realCat, 'no system cat to build the stand-in on — this test would prove nothing')
    writeFileSync(join(wfWs, 'real', 'hosts'), 'INSIDE_HOSTS_7876\n')
    const shimDir = join(wfRoot, 'swap-bin')
    const marker = join(wfRoot, 'swapped')
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(join(shimDir, 'cat'), [
      '#!/bin/sh',
      `if [ ! -e '${marker}' ]; then`,
      `  : > '${marker}'`,
      `  rm -f '${join(wfWs, 'alias')}' && ln -s '${wfOut}' '${join(wfWs, 'alias')}'`,
      'fi',
      `exec ${realCat} "$@"`,
      '',
    ].join('\n'))
    chmodSync(join(shimDir, 'cat'), 0o755)

    const session = buildSession(wfBackend({ pathPrefix: shimDir }))
    const result = await session._dispatchBuiltinTool({
      toolName: 'Edit',
      input: { file_path: 'alias/hosts', old_string: 'ORIGINAL_HOSTS', new_string: 'PWNED' },
    })
    assert.ok(existsSync(marker), 'the swap never happened — this test proved nothing')
    assert.equal(readFileSync(join(wfOut, 'hosts'), 'utf8'), 'ORIGINAL_HOSTS_7876\n', 'wrote through the swapped link')
    assert.equal(result.isError, true, result.content)
    assert.ok(/old_string not found/.test(result.content), `Edit read the file behind the swapped link: ${result.content}`)
  })

  // ── Positive controls ────────────────────────────────────────────────────

  it('POSITIVE — Write and Edit through a symlink that stays INSIDE the workspace work', async () => {
    // A fix that refused every symlink would be a regression, not a fix.
    const session = buildSession(wfBackend())
    const w = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'alias/new/file.txt', content: 'inside alpha\n' },
    })
    assert.equal(w.isError, false, `in-bounds link write refused: ${w.content}`)
    assert.equal(readFileSync(join(wfWs, 'real', 'new', 'file.txt'), 'utf8'), 'inside alpha\n')
    const e = await session._dispatchBuiltinTool({
      toolName: 'Edit',
      input: { file_path: 'alias/new/file.txt', old_string: 'alpha', new_string: 'beta' },
    })
    assert.equal(e.isError, false, `in-bounds link edit refused: ${e.content}`)
    assert.equal(readFileSync(join(wfWs, 'real', 'new', 'file.txt'), 'utf8'), 'inside beta\n')
  })

  it('POSITIVE — plain Write (new deep path, overwrite, empty) and Edit still work', async () => {
    const session = buildSession(wfBackend())
    const deep = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'a/b/c/new.txt', content: 'deep\n' },
    })
    assert.equal(deep.isError, false, deep.content)
    assert.ok(/Wrote 5 bytes to a\/b\/c\/new\.txt/.test(deep.content), deep.content)
    assert.equal(readFileSync(join(wfWs, 'a', 'b', 'c', 'new.txt'), 'utf8'), 'deep\n')

    const over = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'plain.txt', content: 'replaced\n' },
    })
    assert.equal(over.isError, false, over.content)
    assert.equal(readFileSync(join(wfWs, 'plain.txt'), 'utf8'), 'replaced\n')

    const empty = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'plain.txt', content: '' },
    })
    assert.equal(empty.isError, false, empty.content)
    assert.ok(/Wrote 0 bytes/.test(empty.content), empty.content)
    assert.equal(readFileSync(join(wfWs, 'plain.txt'), 'utf8'), '')

    writeFileSync(join(wfWs, 'edit.txt'), 'one two three')
    const edit = await session._dispatchBuiltinTool({
      toolName: 'Edit',
      input: { file_path: 'edit.txt', old_string: 'two', new_string: 'TWO' },
    })
    assert.equal(edit.isError, false, edit.content)
    // No trailing newline in, none out: the sentinel split must not eat or add bytes.
    assert.equal(readFileSync(join(wfWs, 'edit.txt'), 'utf8'), 'one TWO three')
  })

  it('POSITIVE — Edit of a missing file is the tool error, not a containment error', async () => {
    // Both depths: a missing leaf under an existing parent, and a missing leaf
    // whose PARENTS are missing too. The second is what separates the create-
    // mode walk Edit's read uses from the read-mode resolver, which needs the
    // parent to exist and would answer "could not resolve" instead — the
    // behaviour `_containerEdit`'s JSDoc promises ("at any depth").
    for (const file_path of ['real/nope.txt', 'nodir/deeper/nope.txt']) {
      const session = buildSession(wfBackend())
      const result = await session._dispatchBuiltinTool({
        toolName: 'Edit',
        input: { file_path, old_string: 'a', new_string: 'b' },
      })
      assert.equal(result.isError, true, `${file_path}: ${result.content}`)
      assert.equal(/resolves outside the workspace/.test(result.content), false, `${file_path}: ${result.content}`)
      assert.equal(/could not resolve/.test(result.content), false, `${file_path}: ${result.content}`)
      assert.ok(/No such file/.test(result.content), `${file_path}: wrong error: ${result.content}`)
    }
    assert.equal(existsSync(join(wfWs, 'nodir')), false, 'a refused Edit created a directory')
  })

  // ── Fail closed on a reply the host cannot account for ───────────────────

  it('an unparseable container reply is an error for Write and Edit, never a success', async () => {
    for (const [toolName, input] of [
      ['Write', { file_path: 'x.txt', content: 'hello' }],
      ['Edit', { file_path: 'x.txt', old_string: 'hello', new_string: 'bye' }],
    ]) {
      const calls = []
      const backend = {
        async execInEnvironment(id, opts) {
          calls.push(opts)
          return { stdout: 'hello\n', stderr: '' }
        },
      }
      const session = buildSession(backend)
      const result = await session._dispatchBuiltinTool({ toolName, input })
      assert.equal(result.isError, true, `${toolName} accepted an unguarded reply: ${result.content}`)
      assert.ok(/no valid confinement verdict/.test(result.content), `${toolName}: ${result.content}`)
      assert.equal(calls.length, 1, `${toolName} went on after an unguarded reply`)
    }
  })

  it('an empty container reply to Write is an error', async () => {
    const backend = { async execInEnvironment() { return { stdout: '', stderr: '' } } }
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Write',
      input: { file_path: 'x.txt', content: 'hello' },
    })
    assert.equal(result.isError, true)
  })

  it('a refused Write/Edit is logged for the operator', async () => {
    for (const [toolName, input] of [
      ['Write', { file_path: 'esc/hosts', content: 'x' }],
      ['Edit', { file_path: 'esc/hosts', old_string: 'ORIGINAL', new_string: 'x' }],
    ]) {
      const lines = []
      const listener = (entry) => lines.push(typeof entry === 'string' ? entry : (entry?.msg ?? JSON.stringify(entry)))
      addLogListener(listener)
      try {
        await buildSession(wfBackend())._dispatchBuiltinTool({ toolName, input })
        const hit = lines.find((l) => l.includes('[container-confine]') && l.includes(`${toolName}: refused a path (escape)`))
        assert.ok(hit, `${toolName} logged no refusal; saw ${JSON.stringify(lines)}`)
        assert.equal(hit.includes(realpathSync(wfRoot)), false, 'logged the resolved path')
      } finally {
        removeLogListener(listener)
      }
    }
  })

  it('every container Write/Edit carries the create-mode resolver and writes only the resolved path', async () => {
    // Booleans, not assert.match: the subject is a multi-KB script (#7340).
    for (const [toolName, input, lexical] of [
      ['Write', { file_path: 'src/new.js', content: 'hello' }, "'/workspace/src/new.js'"],
      ['Edit', { file_path: 'plain.txt', old_string: 'plain', new_string: 'PLAIN' }, "'/workspace/plain.txt'"],
    ]) {
      const backend = wfBackend()
      await buildSession(backend)._dispatchBuiltinTool({ toolName, input })
      assert.ok(backend.calls.length >= 1, `${toolName} issued no docker exec`)
      for (const { cmd } of backend.calls) {
        assert.ok(cmd.includes('__cx_resolve_new()'), `${toolName} lost the create-mode resolver`)
        assert.ok(cmd.includes(CONTAINER_CONFINE_OK), `${toolName} lost the OK sentinel`)
        assert.ok(cmd.includes(CONTAINER_CONFINE_ESCAPE), `${toolName} lost the escape sentinel`)
        assert.ok(cmd.includes('"$__cx_target"'), `${toolName} does not use the resolved path`)
        // The lexical path appears exactly once — as the resolver's argument.
        assert.equal(cmd.split(lexical).length - 1, 1, `${toolName} uses the lexical path outside the resolver`)
      }
    }
  })
})

describe('__cx_resolve_new — the create-mode walk, driven directly (#7876)', { skip: POSIX_ONLY || SKIP_NO_SYMLINK }, () => {
  // The remainder refusals cannot be reached from the tool input:
  // `remapToContainerPath` runs `posix.join`, which collapses `.`, `..` and
  // `//` before the path ever reaches the container. The walk refuses them
  // anyway so its safety does not rest on that caller — and a refusal no
  // input can reach is only proven by driving the function itself.
  beforeEach(() => { buildWriteFixture() })
  afterEach(() => { rmSync(wfRoot, { recursive: true, force: true }) })

  async function run(target, body = 'printf \'%s\\n\' "$__cx_target"') {
    const cmd = buildConfinedContainerCommand({ target, body, mode: 'create' })
    const local = cmd.split(CONTAINER_WORKSPACE).join(wfWs)
    const { stdout } = await pexec('bash', ['-c', local])
    return parseConfinedContainerStdout(stdout)
  }

  const writeBody = 'mkdir -p "${__cx_target%/*}" && printf x > "$__cx_target"'

  it('a `..` in the not-yet-existing remainder is refused, not walked out of the workspace', async () => {
    const r = await run('/workspace/newdir/../../outside/x.txt', writeBody)
    assert.equal(r.ok, false, 'a `..` remainder passed containment')
    assert.equal(existsSync(join(wfOut, 'x.txt')), false, 'wrote outside through a `..` remainder')
    assert.equal(existsSync(join(wfWs, 'newdir')), false, 'created the remainder\'s first component')
  })

  it('`.` and empty remainder components are refused', async () => {
    for (const t of ['/workspace/newdir/./x.txt', '/workspace/newdir//x.txt', '/workspace/newdir/x.txt/']) {
      const r = await run(t)
      assert.deepEqual(r, { ok: false, reason: 'error' }, `accepted ${t}`)
    }
  })

  it('re-appends the remainder to the PHYSICAL deepest existing ancestor', async () => {
    const r = await run('/workspace/alias/new/deeper/file.txt')
    assert.equal(r.ok, true)
    assert.equal(r.body, `${realpathSync(wfWs)}/real/new/deeper/file.txt\n`)
  })

  it('degenerates to the read resolver when the whole path exists', async () => {
    const r = await run('/workspace/alias')
    assert.equal(r.ok, true)
    assert.equal(r.body, `${realpathSync(wfWs)}/real\n`)
  })

  it('refuses a RELATIVE target instead of looping forever', async () => {
    // The walk's termination rests on its absolute-path guard: `${p%/*}` of a
    // path with no `/` is the path itself, so a relative target that does not
    // exist is peeled forever. No caller passes one (`remapToContainerPath`
    // always yields `/workspace/...`), so only driving the function proves the
    // guard — and its failure mode is a HANG, which reads as flake rather than
    // red (docs/false-safety-guards.md, #7340). Bound the run so a missing
    // guard goes red, legibly, in seconds.
    const cmd = buildConfinedContainerCommand({ target: 'nope-7876/x.txt', body: 'true', mode: 'create' })
    const local = cmd.split(CONTAINER_WORKSPACE).join(wfWs)
    let stdout
    try {
      ({ stdout } = await pexec('bash', ['-c', local], { cwd: wfRoot, timeout: 5000 }))
    } catch (err) {
      assert.fail(`the walk did not terminate on a relative target (killed=${err.killed}, signal=${err.signal})`)
    }
    assert.deepEqual(parseConfinedContainerStdout(stdout), { ok: false, reason: 'error' })
  })
})

describe('buildConfinedContainerCommand modes (#7876)', () => {
  it('the default mode emits the read resolver only, unchanged by create mode existing', () => {
    const cmd = buildConfinedContainerCommand({ target: '/workspace/a', body: 'true' })
    assert.equal(cmd.includes('__cx_resolve_new'), false, 'read mode picked up the create-mode walk')
    assert.ok(cmd.includes(`__cx_target=$(__cx_resolve '/workspace/a')`), 'read mode lost __cx_resolve')
    assert.deepEqual(
      cmd,
      buildConfinedContainerCommand({ target: '/workspace/a', body: 'true', mode: 'read' }),
    )
  })

  it('create mode resolves the target with the walk and the workspace with __cx_resolve', () => {
    const cmd = buildConfinedContainerCommand({ target: '/workspace/a', body: 'true', mode: 'create' })
    assert.ok(cmd.includes(`__cx_target=$(__cx_resolve_new '/workspace/a')`), 'create mode lost the walk')
    assert.ok(cmd.includes(`__cx_ws=$(__cx_resolve '/workspace')`), 'create mode changed the workspace resolution')
  })

  it('an unknown mode throws instead of silently picking a resolver', () => {
    assert.throws(
      () => buildConfinedContainerCommand({ target: '/workspace/a', body: 'true', mode: 'write' }),
      /unknown mode/,
    )
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

describe('splitWithheldTrailer (#7354 / #7357)', () => {
  // #7357 — matches are NUL-delimited (buildConfinedGlobBody), not '\n'-joined:
  // a filename may legally contain a newline, and joining on '\n' cannot tell
  // "one match with an embedded newline" apart from "two matches". The
  // trailer stays its own '\n'-terminated line — fixed host-authored text,
  // never a filename, so it carries no such ambiguity.
  it('strips the trailer and returns the NUL-delimited matches', () => {
    assert.deepEqual(
      splitWithheldTrailer(`src/a.ts\0src/b.ts\0${CONTAINER_CONFINE_WITHHELD} 3\n`),
      { body: 'src/a.ts\0src/b.ts\0', withheld: 3 },
    )
  })

  it('handles a body that is ONLY the trailer (zero matches — no NUL at all)', () => {
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
    for (const body of ['src/a.ts\0', '', 'x', null, undefined]) {
      assert.equal(splitWithheldTrailer(body).withheld, null, `claimed a count for ${JSON.stringify(body)}`)
    }
  })

  it('only what follows the LAST NUL can be the trailer', () => {
    // A MATCH whose name happens to look exactly like the trailer text — a
    // real file could be named that — must stay a match, and only the true
    // final trailer (after the last NUL) is stripped. Getting this backwards
    // would hand the log a number the container never sent (a match text
    // mistaken for the trailer) or leak the trailer into the model-facing
    // body (the true trailer mistaken for a match).
    const body = `${CONTAINER_CONFINE_WITHHELD} 9\0src/a.ts\0${CONTAINER_CONFINE_WITHHELD} 3\n`
    assert.deepEqual(splitWithheldTrailer(body), {
      body: `${CONTAINER_CONFINE_WITHHELD} 9\0src/a.ts\0`,
      withheld: 3,
    })
  })

  it('rejects a malformed count rather than coercing it', () => {
    const body = `src/a.ts\0${CONTAINER_CONFINE_WITHHELD} -1\n`
    assert.deepEqual(splitWithheldTrailer(body), { body, withheld: null })
  })

  it('an embedded newline inside a match survives as part of ONE entry', () => {
    // The whole point of the NUL delimiter: `nl\nSECRET.ts` must come back as
    // a single match, not split into `nl` and `SECRET.ts` by anything that
    // still keys off '\n'.
    assert.deepEqual(
      splitWithheldTrailer(`nl\nSECRET.ts\0keep.ts\0${CONTAINER_CONFINE_WITHHELD} 0\n`),
      { body: 'nl\nSECRET.ts\0keep.ts\0', withheld: 0 },
    )
  })
})
