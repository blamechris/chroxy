/**
 * Tests for scripts/lint-session-opt-forwarding.mjs
 *
 * The lint guards the "middle-layer trap" documented in project memory as
 * `feedback_jsonl_subprocess_middle_layer.md`: provider session classes that
 * extend `BaseSession` (or `JsonlSubprocessSession`) destructure a fixed key
 * list in their constructor and forward via `super({...})`. When a new
 * BaseSession opt is added, the middle layers silently drop it unless
 * updated — see #3224, #3231, #4790.
 *
 * Strategy: run the lint as a child process against a temp directory of
 * fixture files. Each fixture mimics the real provider-session shape so we
 * can verify the regex parser flags the trap (and accepts the good case).
 *
 * Issue: #4797. Trap that motivated this lint: #4790 (fixed in #4795).
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LINT_SCRIPT = resolve(__dirname, '..', 'scripts', 'lint-session-opt-forwarding.mjs')

// Minimal BaseSession fixture that mimics the real signature shape — the
// lint extracts the opt-name set from the destructure inside the constructor
// AND asserts it equals the exported BASE_SESSION_OPT_KEYS array (#5367).
// `mkBaseSession` lets a test deliberately desync the array from the ctor to
// exercise the drift guard.
function mkBaseSession({ ctorKeys, arrayKeys } = {}) {
  const ctor = ctorKeys || [
    'cwd', 'model', 'permissionMode', 'skillsDir', 'repoSkillsDir',
    'maxSkillBytes', 'chroxyContextHint', 'streamStallTimeoutMs',
    'resultTimeoutMs', 'hardTimeoutMs',
  ]
  const arr = arrayKeys || ctor
  return `
import { EventEmitter } from 'events'

export const BASE_SESSION_OPT_KEYS = [
${arr.map(k => `  '${k}',`).join('\n')}
]

export function buildBaseSessionOpts(fullOpts = {}, overrides = {}) {
  const out = {}
  for (const k of BASE_SESSION_OPT_KEYS) {
    if (k in fullOpts) out[k] = fullOpts[k]
  }
  return { ...out, ...overrides }
}

export class BaseSession extends EventEmitter {
  constructor({
${ctor.map(k => `    ${k},`).join('\n')}
  } = {}) {
    super()
    this.cwd = cwd
    this.model = model
  }
}
`
}

const BASE_SESSION_SRC = mkBaseSession()

// A "good" middle layer — every BaseSession opt is destructured and
// forwarded through super(). The real JsonlSubprocessSession looks like
// this (modulo the much longer key list).
const GOOD_MIDDLE_LAYER_SRC = `
import { BaseSession } from './base-session.js'

export class JsonlSubprocessSession extends BaseSession {
  constructor({
    cwd,
    model,
    permissionMode,
    skillsDir,
    repoSkillsDir,
    maxSkillBytes,
    chroxyContextHint,
    streamStallTimeoutMs,
    resultTimeoutMs,
    hardTimeoutMs,
    resumeSessionId,
  } = {}) {
    super({
      cwd,
      model,
      permissionMode,
      skillsDir,
      repoSkillsDir,
      maxSkillBytes,
      chroxyContextHint,
      streamStallTimeoutMs,
      resultTimeoutMs,
      hardTimeoutMs,
    })
    this.resumeSessionId = resumeSessionId
  }
}
`

// A "bad" middle layer — drops `streamStallTimeoutMs` from BOTH the
// destructure and the super() forward. Reproduces the #4790 trap exactly.
const BAD_MIDDLE_LAYER_SRC = `
import { BaseSession } from './base-session.js'

export class CodexSession extends BaseSession {
  constructor({
    cwd,
    model,
    permissionMode,
    skillsDir,
    repoSkillsDir,
    maxSkillBytes,
    chroxyContextHint,
    resultTimeoutMs,
    hardTimeoutMs,
    resumeSessionId,
  } = {}) {
    super({
      cwd,
      model,
      permissionMode,
      skillsDir,
      repoSkillsDir,
      maxSkillBytes,
      chroxyContextHint,
      resultTimeoutMs,
      hardTimeoutMs,
    })
    this.resumeSessionId = resumeSessionId
  }
}
`

// A "destructure-only" bad case — the opt is destructured (so it's
// pulled out of opts) but never forwarded via super(). This is the
// silent variant of the trap: the key looks plumbed in code review
// because it's in the destructure list, but it never reaches BaseSession.
const BAD_FORWARD_ONLY_SRC = `
import { BaseSession } from './base-session.js'

export class GeminiSession extends BaseSession {
  constructor({
    cwd,
    model,
    permissionMode,
    skillsDir,
    repoSkillsDir,
    maxSkillBytes,
    chroxyContextHint,
    streamStallTimeoutMs,
    resultTimeoutMs,
    hardTimeoutMs,
  } = {}) {
    super({
      cwd,
      model,
      permissionMode,
      skillsDir,
      repoSkillsDir,
      maxSkillBytes,
      chroxyContextHint,
      resultTimeoutMs,
      hardTimeoutMs,
    })
  }
}
`

// Rest-spread style — `super({ ...opts, ... })`. Naturally immune to the
// trap because every opt is forwarded by reference. The lint should
// accept this without complaint (no enumeration to compare).
const REST_SPREAD_SRC = `
import { BaseSession } from './base-session.js'

export class ClaudeByokSession extends BaseSession {
  constructor(opts = {}) {
    super({ ...opts, provider: opts.provider || 'claude-byok' })
  }
}
`

// #5367: the sanctioned picker shape. A single-arg ctor forwarding via
// `super(buildBaseSessionOpts(opts, { ...overrides }))`. The lint treats this
// as compliant-by-construction (coverage proven by the array-vs-ctor assertion
// + the picker copying every key) — it must NOT be skipped vacuously.
const PICKER_SRC = `
import { BaseSession, buildBaseSessionOpts } from './base-session.js'

export class SdkSession extends BaseSession {
  constructor(opts = {}) {
    super(buildBaseSessionOpts(opts, { provider: opts.provider || 'claude-sdk' }))
    const { resumeSessionId } = opts
    this.resumeSessionId = resumeSessionId
  }
}
`

// #5367: a single-arg ctor that hand-rolls `super({ cwd })` and silently drops
// every other BaseSession opt. Pre-#5367 the lint skipped single-arg ctors
// blanket-style, so this regression slipped through. The inverted lint must
// flag it.
const SINGLE_ARG_HANDROLLED_DROP_SRC = `
import { BaseSession } from './base-session.js'

export class CliSession extends BaseSession {
  constructor(opts = {}) {
    super({ cwd: opts.cwd })
  }
}
`

// #5367: an unrecognized super() forwarder — wraps opts in some other function
// that the lint cannot prove preserves every key. Must be flagged.
const UNRECOGNIZED_SUPER_SRC = `
import { BaseSession } from './base-session.js'

function mungeOpts(o) { return o }

export class CliSession extends BaseSession {
  constructor(opts = {}) {
    super(mungeOpts(opts))
  }
}
`

function setupFixtureTree(extraFiles = {}, baseSessionSrc = BASE_SESSION_SRC) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-lint-opt-fwd-'))
  const srcDir = join(dir, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'base-session.js'), baseSessionSrc, 'utf8')
  for (const [name, src] of Object.entries(extraFiles)) {
    writeFileSync(join(srcDir, name), src, 'utf8')
  }
  return { dir, srcDir }
}

function runLint(srcDir) {
  const result = spawnSync(
    process.execPath,
    [LINT_SCRIPT, '--src-dir', srcDir],
    { encoding: 'utf8' },
  )
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

describe('lint-session-opt-forwarding', () => {
  const cleanups = []
  after(() => {
    for (const dir of cleanups) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  test('passes when every BaseSession opt is destructured + forwarded', () => {
    const { dir, srcDir } = setupFixtureTree({
      'jsonl-subprocess-session.js': GOOD_MIDDLE_LAYER_SRC,
    })
    cleanups.push(dir)
    const { code, stdout, stderr } = runLint(srcDir)
    assert.equal(code, 0, `lint should pass on good fixture\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  })

  test('fails when an opt is dropped from both destructure and super()', () => {
    const { dir, srcDir } = setupFixtureTree({
      'codex-session.js': BAD_MIDDLE_LAYER_SRC,
    })
    cleanups.push(dir)
    const { code, stderr } = runLint(srcDir)
    assert.equal(code, 1, 'lint should fail when an opt is dropped')
    assert.match(stderr, /streamStallTimeoutMs/, 'error should name the missing opt')
    assert.match(stderr, /codex-session\.js/, 'error should name the offending file')
  })

  test('fails when an opt is destructured but not forwarded via super()', () => {
    const { dir, srcDir } = setupFixtureTree({
      'gemini-session.js': BAD_FORWARD_ONLY_SRC,
    })
    cleanups.push(dir)
    const { code, stderr } = runLint(srcDir)
    assert.equal(code, 1, 'lint should fail on destructure-only opts')
    assert.match(stderr, /streamStallTimeoutMs/, 'error should name the missing opt')
    assert.match(stderr, /gemini-session\.js/, 'error should name the offending file')
  })

  test('accepts rest-spread super({ ...opts }) without complaint', () => {
    const { dir, srcDir } = setupFixtureTree({
      'byok-session.js': REST_SPREAD_SRC,
    })
    cleanups.push(dir)
    const { code, stdout, stderr } = runLint(srcDir)
    assert.equal(code, 0, `rest-spread is naturally immune\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  })

  test('accepts the buildBaseSessionOpts() picker (single-arg ctor) — #5367', () => {
    // The sanctioned migration target. Must be analyzed-and-ok (compliant by
    // construction), NOT skipped vacuously — the latter would re-arm the trap.
    const { dir, srcDir } = setupFixtureTree({
      'sdk-session.js': PICKER_SRC,
    })
    cleanups.push(dir)
    const { code, stdout, stderr } = runLint(srcDir)
    assert.equal(code, 0, `picker should pass\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    // Prove it was actually counted (not silently skipped to "0 subclasses").
    assert.match(stdout, /1 session subclass/, 'picker class must be counted as analyzed')
  })

  test('fails (exit 2) when BASE_SESSION_OPT_KEYS drifts from the ctor — #5367', () => {
    // The new primary drift guard: the array the picker iterates must equal the
    // ctor destructure. Drop a key from the array only → the picker would
    // silently stop forwarding it. Lint must hard-error (exit 2).
    const driftedBase = mkBaseSession({
      ctorKeys: [
        'cwd', 'model', 'permissionMode', 'skillsDir', 'repoSkillsDir',
        'maxSkillBytes', 'chroxyContextHint', 'streamStallTimeoutMs',
        'resultTimeoutMs', 'hardTimeoutMs',
      ],
      // streamStallTimeoutMs intentionally MISSING from the array.
      arrayKeys: [
        'cwd', 'model', 'permissionMode', 'skillsDir', 'repoSkillsDir',
        'maxSkillBytes', 'chroxyContextHint',
        'resultTimeoutMs', 'hardTimeoutMs',
      ],
    })
    const { dir, srcDir } = setupFixtureTree({ 'sdk-session.js': PICKER_SRC }, driftedBase)
    cleanups.push(dir)
    const { code, stderr } = runLint(srcDir)
    assert.equal(code, 2, 'drift between array and ctor must hard-error (exit 2)')
    assert.match(stderr, /drifted/i, 'error should explain the drift')
    assert.match(stderr, /streamStallTimeoutMs/, 'error should name the drifted key')
  })

  test('fails when a single-arg ctor hand-rolls super({ cwd }) and drops keys — #5367', () => {
    // Pre-#5367 single-arg ctors were blanket-skipped; this is the hole the
    // picker would have slipped through. The inverted lint must flag it.
    const { dir, srcDir } = setupFixtureTree({
      'cli-session.js': SINGLE_ARG_HANDROLLED_DROP_SRC,
    })
    cleanups.push(dir)
    const { code, stderr } = runLint(srcDir)
    assert.equal(code, 1, 'hand-rolled super({ cwd }) in a single-arg ctor must fail')
    assert.match(stderr, /cli-session\.js/, 'error should name the offending file')
    assert.match(stderr, /model|permissionMode|streamStallTimeoutMs/, 'error should name dropped opts')
  })

  test('flags an unrecognized super() forwarder shape — #5367', () => {
    // super(someOtherFn(opts)) cannot be proven safe → offense (pre-#5367 this
    // was silently skipped, which is exactly the hole that re-armed the trap).
    const { dir, srcDir } = setupFixtureTree({
      'cli-session.js': UNRECOGNIZED_SUPER_SRC,
    })
    cleanups.push(dir)
    const { code, stderr } = runLint(srcDir)
    assert.equal(code, 1, 'unrecognized super() shape must fail')
    assert.match(stderr, /cli-session\.js/, 'error should name the offending file')
    assert.match(stderr, /[Uu]nrecognized super/, 'error should explain the unrecognized shape')
  })

  test('passes against the real packages/server/src tree (acceptance criterion)', () => {
    // No --src-dir override → the lint walks the real source tree. This is
    // the regression-prevention contract: after #4795, all three middle
    // layers (jsonl-subprocess, codex, gemini) forward every BaseSession
    // opt. Future opt additions must come with matching middle-layer plumbing,
    // or this test will flip red here AND in CI.
    const result = spawnSync(
      process.execPath,
      [LINT_SCRIPT],
      { encoding: 'utf8' },
    )
    assert.equal(
      result.status,
      0,
      `lint must pass on the real tree — middle layers must forward every BaseSession opt.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  })

  test('per-key allowlist comment suppresses a specific drop', () => {
    // Class can opt-out a specific key via a marker comment placed
    // immediately above the class declaration. Use case: a future
    // provider deliberately does not need a particular opt (e.g. a stub
    // session for testing). The allowlist is per-key so missing a
    // different opt still fails.
    const SUPPRESS_SRC = `
import { BaseSession } from './base-session.js'

// lint-ignore-opt-forwarding: streamStallTimeoutMs
export class TestStubSession extends BaseSession {
  constructor({
    cwd,
    model,
    permissionMode,
    skillsDir,
    repoSkillsDir,
    maxSkillBytes,
    chroxyContextHint,
    resultTimeoutMs,
    hardTimeoutMs,
  } = {}) {
    super({
      cwd,
      model,
      permissionMode,
      skillsDir,
      repoSkillsDir,
      maxSkillBytes,
      chroxyContextHint,
      resultTimeoutMs,
      hardTimeoutMs,
    })
  }
}
`
    const { dir, srcDir } = setupFixtureTree({
      'test-stub-session.js': SUPPRESS_SRC,
    })
    cleanups.push(dir)
    const { code, stdout, stderr } = runLint(srcDir)
    assert.equal(code, 0, `allowlist should suppress streamStallTimeoutMs\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  })
})
