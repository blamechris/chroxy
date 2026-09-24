import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DockerByokSession, CONTAINER_WORKSPACE } from '../src/docker-byok-session.js'
import { buildConfinedGlobBody, splitWithheldTrailer } from '../src/built-in-tools/tool-transforms.js'
import { addLogListener, removeLogListener } from '../src/logger.js'

const pexec = promisify(execFile)

/**
 * Tests for #7355 (host/container case-sensitivity parity) and #7357
 * (dangling symlinks + embedded newlines) on the CONTAINER side.
 *
 * #7355 needed NO container-side fix: bash's own globbing has no case-folding
 * override, so `_containerGlob` was already case-sensitive — the bug was
 * host-only (byok-tool-executor.js). #7357's dangling-symlink half also needed
 * no container-side fix: `__cx_resolve`'s "a missing LEAF still resolves"
 * design (#7354/#7876) already treats a single-level dangling symlink the same
 * way the host's component-wise resolver does. The tests below marked "parity
 * pin" assert those two already-correct behaviors so a future change cannot
 * silently regress them; only the embedded-newline tests exercise an actual
 * fix (NUL-delimited transfer, in `buildConfinedGlobBody` / `splitWithheldTrailer`
 * / `docker-byok-session.js`'s `_containerGlob`).
 *
 * Same harness as docker-byok-symlink-containment.test.js: the daemon's
 * command runs through a REAL bash against a REAL temp directory, with
 * `/workspace` rewritten to it. No Docker daemon involved.
 */

/** Windows has no bash and no POSIX symlink semantics — see project memory. */
const POSIX_ONLY = process.platform === 'win32'

let fixtureRoot
let workspaceDir

function buildFixture() {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'chroxy-7355-7357-'))
  workspaceDir = join(fixtureRoot, 'ws')
  mkdirSync(workspaceDir, { recursive: true })
}

/** Same shape as docker-byok-symlink-containment.test.js's `bashBackend`. */
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
  session._containerId = 'CONTAINER_735577'
  return session
}

let originalHome
let originalConfigDir
let originalApiKey

describe('container Glob case-sensitivity + dangling-symlink parity, and embedded newlines (#7355 / #7357)', { skip: POSIX_ONLY }, () => {
  // Scoped INSIDE the skip: `symlinkSync` and a `\n`-bearing filename both need
  // things the Windows CI runner doesn't have (symlink privilege — #7288 — and
  // control characters in a Win32 filename, respectively), and there is no bash
  // to run the container script through either way.
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
    const { stdout } = await pexec('bash', ['-c', 'printf ok'])
    assert.equal(stdout, 'ok', 'the local bash harness must work, or this suite proves nothing')
  })

  it('container Glob is ALREADY case-sensitive (parity pin — bash has no nocase override)', async () => {
    writeFileSync(join(workspaceDir, 'Upper.TS'), '1')
    const session = buildSession(bashBackend())
    const wrong = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: '*.ts' } })
    assert.equal(wrong.isError, false)
    assert.match(wrong.content, /^No matches for/)

    const right = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: '*.TS' } })
    assert.equal(right.isError, false)
    assert.equal(right.content, 'Upper.TS')
  })

  // #7898 round 4 — globPatternComplexityReason (tool-transforms.js) is
  // shared between the host (byok-tool-executor.js's runGlob) and the
  // container (_containerGlob), so an over-cap pattern is refused here too,
  // BEFORE _execAsContainerUser / docker exec ever runs — proven by the
  // absence of any backend call, not just the error text.
  it('container Glob refuses an over-depth pattern before ever reaching docker exec', async () => {
    const backend = bashBackend()
    const session = buildSession(backend)
    let pattern = 'z'
    for (let i = 0; i < 40; i++) pattern = `{a,${pattern}}`
    const result = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern } })
    assert.equal(result.isError, true)
    assert.match(result.content, /EINVAL: glob pattern is too complex/)
    assert.match(result.content, /nesting deeper than 32/)
    assert.equal(backend.calls.length, 0, 'must be refused before any container exec call')
  })

  it('container Glob refuses an over-length pattern before ever reaching docker exec', async () => {
    const backend = bashBackend()
    const session = buildSession(backend)
    const result = await session._dispatchBuiltinTool({
      toolName: 'Glob',
      input: { pattern: '{*a,*b}'.repeat(300) }, // 2100 chars
    })
    assert.equal(result.isError, true)
    assert.match(result.content, /EINVAL: glob pattern is too complex/)
    assert.match(result.content, /longer than 2000 characters/)
    assert.equal(backend.calls.length, 0, 'must be refused before any container exec call')
  })

  it('container Glob ALREADY lists a dangling symlink whose target is inside the workspace (parity pin)', async () => {
    symlinkSync('./nonexistent-7357', join(workspaceDir, 'broken.ts'))
    const session = buildSession(bashBackend())
    const result = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: '*.ts' } })
    assert.equal(result.isError, false)
    assert.equal(result.content, 'broken.ts')
  })

  it('container Glob ALREADY withholds a dangling symlink whose target points outside the workspace (parity pin)', async () => {
    symlinkSync('/definitely-nonexistent-outside-7357', join(workspaceDir, 'broken.ts'))
    const session = buildSession(bashBackend())
    const result = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: '*.ts' } })
    assert.equal(result.isError, false)
    assert.match(result.content, /^No matches for/)
  })

  it('a match whose name contains a newline transfers as ONE entry and is dropped from the model-facing output', async () => {
    writeFileSync(join(workspaceDir, 'keep.ts'), '1')
    writeFileSync(join(workspaceDir, 'nl\nSECRET.ts'), '1')
    const session = buildSession(bashBackend())
    const lines = []
    const listener = (entry) => lines.push(typeof entry === 'string' ? entry : (entry?.msg ?? JSON.stringify(entry)))
    addLogListener(listener)
    try {
      const result = await session._dispatchBuiltinTool({ toolName: 'Glob', input: { pattern: '*.ts' } })
      assert.equal(result.isError, false)
      // Exact equality: proves the newline-bearing name is gone entirely, not
      // that only its fabricated second line ("SECRET.ts") is gone — a
      // half-fixed split (NUL-delimited transfer, no newline drop on output)
      // would still fail this because it would keep BOTH real entries and
      // this asserts there is exactly one.
      assert.equal(result.content, 'keep.ts')
      const hit = lines.find((l) => l.includes('[container-confine]') && l.includes('embedded newline'))
      assert.ok(hit, `no newline-drop log line; saw ${JSON.stringify(lines)}`)
      assert.match(hit, /dropped 1 match\(es\)/)
      // The security-relevant withheld-count log must stay untouched by this —
      // a newline-drop is a display decision, not a containment one, and
      // folding it into "withheld ... resolving outside" would be a false
      // claim about a match that was never outside the workspace.
      assert.equal(lines.some((l) => l.includes('resolving outside')), false)
    } finally {
      removeLogListener(listener)
    }
  })

  // Explicit builder+parser PAIR test, as instructed: feed
  // buildConfinedGlobBody's own output FORMAT straight into
  // splitWithheldTrailer, without a docker exec / bash round trip. This is
  // what actually pins the delimiter contract between the two functions.
  it('builder + parser pair: NUL-delimited matches keep an embedded newline as ONE entry', () => {
    const body = buildConfinedGlobBody('*.ts')
    assert.ok(body.includes("printf '%s\\0' \"$f\""), 'the body must NUL-delimit each match')
    assert.ok(!body.includes("printf '%s\\n' \"$f\""), 'must not still newline-delimit matches')

    // A stream shaped exactly like what the body above would print for two
    // real matches, one with an embedded newline.
    const simulated = 'keep.ts\0nl\nSECRET.ts\0__chroxy_confine_withheld__ 0\n'
    const { body: matches, withheld } = splitWithheldTrailer(simulated)
    assert.equal(withheld, 0)
    assert.deepEqual(matches.split('\0').filter(Boolean), ['keep.ts', 'nl\nSECRET.ts'])
  })

  it('builder + parser pair: the trailer is still found with matches present and withheld', () => {
    const simulated = 'a.ts\0b.ts\0__chroxy_confine_withheld__ 3\n'
    const { body: matches, withheld } = splitWithheldTrailer(simulated)
    assert.equal(withheld, 3)
    assert.deepEqual(matches.split('\0').filter(Boolean), ['a.ts', 'b.ts'])
  })

  it('builder + parser pair: the trailer is found with ZERO matches (no leading NUL at all)', () => {
    const simulated = '__chroxy_confine_withheld__ 0\n'
    const { body: matches, withheld } = splitWithheldTrailer(simulated)
    assert.equal(withheld, 0)
    assert.equal(matches, '')
  })
})
