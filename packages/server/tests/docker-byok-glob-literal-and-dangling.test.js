import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DockerByokSession, CONTAINER_WORKSPACE } from '../src/docker-byok-session.js'
import { addLogListener, removeLogListener } from '../src/logger.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

const pexec = promisify(execFile)

/**
 * Tests for #7896 (a purely literal Glob pattern with no match returns a
 * phantom nonexistent path) and #7897 (container Glob withholds a dangling
 * symlink the host would keep, when the target's own parent also doesn't
 * exist) — both container-side parity gaps in `buildConfinedGlobBody` /
 * `__cx_resolve` (`built-in-tools/tool-transforms.js`), filed while
 * implementing #7355/#7357's host/container Glob parity.
 *
 * Same harness as `docker-byok-symlink-containment.test.js` /
 * `docker-byok-glob-case-newline.test.js`: the daemon's command runs through a
 * REAL bash against a REAL temp directory, with the literal `/workspace`
 * rewritten to it. Nothing about `nullglob`, `cd -P`, or symlink resolution is
 * emulated — no Docker daemon is started.
 *
 * The oracle for "what should this return" is the HOST Glob's already-correct
 * behaviour for both shapes: #7896 mirrors `fs.glob`'s unconditional existence
 * check (see `byok-tool-executor.js`'s `runGlob`); #7897 mirrors
 * `resolveTargetComponentwiseAsync`'s (`utils/componentwise-resolver.js`)
 * "ENOENT stops filesystem access, lexically append the rest" rule, which the
 * issue's own investigation measured directly against the host.
 */

/** Windows has no bash and no POSIX symlink semantics — see project memory. */
const POSIX_ONLY = process.platform === 'win32'

let fixtureRoot
let workspaceDir

function buildFixture() {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'chroxy-7896-7897-'))
  workspaceDir = join(fixtureRoot, 'ws')
  mkdirSync(join(workspaceDir, 'deep'), { recursive: true })
}

/** Same shape as the sibling docker-byok-glob-*.test.js / docker-byok-symlink-containment.test.js files. */
function bashBackend({ root } = {}) {
  const calls = []
  return {
    calls,
    async execInEnvironment(containerId, opts) {
      calls.push({ containerId, ...opts })
      const parts = opts.cmd.split(CONTAINER_WORKSPACE)
      assert.ok(parts.length > 1, 'fixture rewrite matched no /workspace in the command')
      const local = parts.join(root ?? workspaceDir)
      const { stdout, stderr } = await pexec('bash', ['-c', local], { maxBuffer: 8 << 20 })
      return { stdout, stderr }
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
  session._containerId = 'CONTAINER_78967897'
  return session
}

let originalHome
let originalConfigDir
let originalApiKey

describe('container Glob literal-match existence + deep dangling-symlink parity (#7896 / #7897)', { skip: POSIX_ONLY }, () => {
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

  // ── #7896 — a purely literal pattern is never existence-checked ──────────

  it('#7896 — a purely literal pattern with no match reports no matches, not a phantom path', async () => {
    const session = buildSession(bashBackend())
    const result = await session._dispatchBuiltinTool({
      toolName: 'Glob',
      input: { pattern: 'totally-nonexistent-literal.ts' },
    })
    assert.equal(result.isError, false)
    // Exact equality, not just a prefix match: `_containerGlob`'s own "no
    // matches" message legitimately echoes the pattern text
    // (`No matches for ${pattern}`), so a substring check for the pattern
    // here would pass whether or not the bug was fixed. Exact equality is
    // what actually distinguishes "no matches" from "matched the phantom
    // path" (which would render as the bare path, with no such prefix).
    assert.equal(result.content, 'No matches for totally-nonexistent-literal.ts')
  })

  it('#7896 — a nested purely literal pattern with no match is withheld too', async () => {
    const session = buildSession(bashBackend())
    const result = await session._dispatchBuiltinTool({
      toolName: 'Glob',
      input: { pattern: 'deep/also-nonexistent.ts' },
    })
    assert.equal(result.isError, false)
    assert.match(result.content, /^No matches for/)
  })

  it('#7896 — a nonexistent literal match is counted in the withheld trailer, for the operator', async () => {
    const lines = []
    const listener = (entry) => lines.push(typeof entry === 'string' ? entry : (entry?.msg ?? JSON.stringify(entry)))
    addLogListener(listener)
    try {
      const session = buildSession(bashBackend())
      session._sourceSessionId = 'sess-7896'
      const result = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: 'nope.ts' } })
      assert.equal(result.isError, false)
      const hit = lines.find((l) => l.includes('[container-confine]') && l.includes('withheld'))
      assert.ok(hit, `no containment log line; saw ${JSON.stringify(lines)}`)
      assert.ok(/withheld 1 match\(es\)/.test(hit), `wrong count in ${JSON.stringify(hit)}`)
    } finally {
      removeLogListener(listener)
    }
  })

  it('#7896 — POSITIVE: an existing literal pattern still matches exactly', async () => {
    writeFileSync(join(workspaceDir, 'real.ts'), '1')
    const session = buildSession(bashBackend())
    const result = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: 'real.ts' } })
    assert.equal(result.isError, false)
    assert.equal(result.content, 'real.ts')
  })

  // ── #7897 — a dangling symlink whose target's own parent is also missing ─

  it('#7897 — a dangling symlink whose target\'s own PARENT is also missing still matches (host parity)', { skip: SKIP_NO_SYMLINK }, async () => {
    symlinkSync('./nonexistent-dir/nonexistent-file.ts', join(workspaceDir, 'deep', 'multi-broken.ts'))
    const session = buildSession(bashBackend())
    const result = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: 'deep/*.ts' } })
    assert.equal(result.isError, false)
    assert.equal(result.content, 'deep/multi-broken.ts')
  })

  it('#7897 — PARITY PIN: the single-level dangling case (target\'s own parent exists) is unaffected', { skip: SKIP_NO_SYMLINK }, async () => {
    // #7355/#7357's already-correct fixture shape, re-pinned here alongside
    // the new deeper one so a future change to __cx_resolve's lenient branch
    // cannot silently regress the case that never needs it (`$__n` stays 0
    // throughout this resolution — the fallback never triggers).
    symlinkSync('./nonexistent-single.ts', join(workspaceDir, 'deep', 'broken.ts'))
    const session = buildSession(bashBackend())
    const result = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: 'deep/*.ts' } })
    assert.equal(result.isError, false)
    assert.equal(result.content, 'deep/broken.ts')
  })

  it('#7897 — ESCAPE: a deep dangling symlink whose target points OUTSIDE the workspace stays withheld', { skip: SKIP_NO_SYMLINK }, async () => {
    // Containment must hold even though resolution is now lenient: the
    // lexically-reconstructed path is still checked against $__cx_target
    // exactly as any other symlink target is, so a missing-parent dangling
    // link pointing outside must be withheld just like an existing one is.
    symlinkSync(
      '/definitely-outside-7897-does-not-exist/nonexistent-dir/nonexistent-file.ts',
      join(workspaceDir, 'deep', 'escape.ts'),
    )
    const session = buildSession(bashBackend())
    const result = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: 'deep/*.ts' } })
    assert.equal(result.isError, false)
    assert.equal(result.content.includes('escape'), false, 'leaked an outside-pointing dangling symlink')
    assert.equal(result.content.includes('outside-7897'), false, 'leaked the outside path')
    assert.match(result.content, /^No matches for/)
  })

  it('#7897 — FAIL CLOSED: a `..` inside the missing tail is refused, never walked out of the workspace', { skip: SKIP_NO_SYMLINK }, async () => {
    // The container's fallback (__cx_resolve_new's peel loop) REFUSES any
    // peeled, not-yet-existing component that is literally `..` rather than
    // trying to give it kernel `..` semantics with nothing on disk to pop
    // against. That is a conservative UNDERMATCH versus the host (whose
    // componentwise resolver does apply `..` lexically once its own walk hits
    // ENOENT) — accepted deliberately, and proven here as a containment
    // property: this must never become a route out of the workspace, whatever
    // it does or doesn't match.
    symlinkSync('./nonexistent-dir/../../../outside-via-dotdot', join(workspaceDir, 'deep', 'dotdot.ts'))
    const session = buildSession(bashBackend())
    const result = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: 'deep/*.ts' } })
    assert.equal(result.isError, false)
    assert.equal(result.content.includes('dotdot'), false, 'a `..`-bearing dangling tail was accepted')
    assert.match(result.content, /^No matches for/)
  })

  it('POSITIVE — Glob still returns an ordinary nested match, untouched by either fix', async () => {
    writeFileSync(join(workspaceDir, 'deep', 'plain.ts'), '1')
    const session = buildSession(bashBackend())
    const result = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: 'deep/*.ts' } })
    assert.equal(result.isError, false)
    assert.equal(result.content, 'deep/plain.ts')
  })

  it('POSITIVE — a Glob mixing a real match, a withheld literal miss, and a resolved deep-dangling match', { skip: SKIP_NO_SYMLINK }, async () => {
    // Both fixes exercised together in one call, against the SAME withheld
    // trailer — proves #7896's withhold and #7897's now-successful resolution
    // don't interfere with each other's counting or the model-facing listing.
    writeFileSync(join(workspaceDir, 'deep', 'plain.ts'), '1')
    symlinkSync('./nonexistent-dir/nonexistent-file.ts', join(workspaceDir, 'deep', 'multi-broken.ts'))
    const session = buildSession(bashBackend())
    const result = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: 'deep/*.ts' } })
    assert.equal(result.isError, false)
    assert.deepEqual(result.content.split('\n').sort(), ['deep/multi-broken.ts', 'deep/plain.ts'])
  })
})
