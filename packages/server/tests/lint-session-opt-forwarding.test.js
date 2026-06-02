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
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LINT_SCRIPT = resolve(__dirname, '..', 'scripts', 'lint-session-opt-forwarding.mjs')

// Minimal BaseSession fixture that mimics the real signature shape — the
// lint extracts the opt-name set from the destructure inside the constructor.
const BASE_SESSION_SRC = `
import { EventEmitter } from 'events'

export class BaseSession extends EventEmitter {
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
    super()
    this.cwd = cwd
    this.model = model
  }
}
`

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

function setupFixtureTree(extraFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-lint-opt-fwd-'))
  const srcDir = join(dir, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'base-session.js'), BASE_SESSION_SRC, 'utf8')
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
    // Class can opt-out a specific key via a marker comment placed above
    // the constructor. Use case: a future provider deliberately does not
    // need a particular opt (e.g. a stub session for testing). The
    // allowlist is per-key so missing a different opt still fails.
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
