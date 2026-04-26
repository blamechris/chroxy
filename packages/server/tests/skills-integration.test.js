import { describe, it, beforeEach, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CliSession } from '../src/cli-session.js'
import { CodexSession } from '../src/codex-session.js'
import { GeminiSession } from '../src/gemini-session.js'
import { waitFor } from './test-helpers.js'

/**
 * Integration tests for shared skills system MVP (#2957) — true end-to-end (#2990).
 *
 * Verifies per-provider injection by exercising the real `sendMessage()` code
 * path and asserting on what actually reaches `spawn()`:
 *
 *   - Claude CLI: stub `_spawnPersistentProcess`, assert on capturedArgs
 *   - Codex:      override static `resolvedBinary` to a recording shim binary,
 *                 invoke real `sendMessage()`, assert recorded argv contains
 *                 the skill text prepended to the user message
 *   - Gemini:     same shim-binary pattern as Codex
 *
 * Why a shim binary instead of stubbing `_buildArgs` or `spawn`: the goal is to
 * verify that a refactor moving the prepend point would be caught. If we stub
 * `_buildArgs` we re-introduce the inline-reconstruction smell the issue
 * called out. The shim is a real subprocess that records its argv to a file —
 * that file is the closest thing to capturing real stdin/argv without the real
 * `codex`/`gemini` binary being installed.
 *
 * The Claude SDK path is exercised via the existing sdk-session tests — the
 * injection point is the `options.systemPrompt.append` assignment, covered
 * by `_buildSystemPrompt()` unit tests on BaseSession.
 */

// ---------------------------------------------------------------------------
// Recording shim binary
// ---------------------------------------------------------------------------
//
// A node script that, when executed, writes its argv to a file (path supplied
// via the CHROXY_SHIM_RECORD env var) and emits two JSONL lines: `turn.completed`
// for Codex and `result` for Gemini, so each provider's readline loop terminates
// cleanly without a fallback emit. The shim exits 0 to avoid an `error` emit
// racing with the test assertion.

function writeShim(shimPath) {
  writeFileSync(shimPath, [
    '#!/usr/bin/env node',
    'import { writeFileSync } from "fs"',
    'const recordTo = process.env.CHROXY_SHIM_RECORD',
    'if (recordTo) {',
    '  writeFileSync(recordTo, JSON.stringify(process.argv.slice(2)))',
    '}',
    '// Emit one event for each provider so both Codex (turn.completed) and',
    '// Gemini (result) close out cleanly without a fallback emit.',
    'process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\\n")',
    'process.stdout.write(JSON.stringify({ type: "result", usage: {} }) + "\\n")',
    'process.exit(0)',
  ].join('\n'))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('skills integration — true end-to-end', () => {
  let skillsDir
  let shimDir
  let shimBin
  let recordPath
  let savedOpenAi
  let savedGemini
  // Track every session created in a test so afterEach can destroy() any that
  // a failing test left running — otherwise an orphaned shim subprocess can
  // keep the node:test worker alive past timeout.
  let activeSessions

  before(() => {
    savedOpenAi = process.env.OPENAI_API_KEY
    savedGemini = process.env.GEMINI_API_KEY
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.GEMINI_API_KEY = 'test-key'
  })

  after(() => {
    if (savedOpenAi !== undefined) process.env.OPENAI_API_KEY = savedOpenAi
    else delete process.env.OPENAI_API_KEY
    if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini
    else delete process.env.GEMINI_API_KEY
  })

  beforeEach(() => {
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-skills-int-'))
    writeFileSync(
      join(skillsDir, 'alpha.md'),
      '# Alpha skill\n\nAlways prefer single quotes. SKILL_MARKER_ALPHA\n'
    )
    writeFileSync(join(skillsDir, 'beta.disabled.md'), 'should not appear')

    shimDir = mkdtempSync(join(tmpdir(), 'chroxy-skills-shim-'))
    shimBin = join(shimDir, 'shim.mjs')
    recordPath = join(shimDir, 'recorded-argv.json')
    writeShim(shimBin)

    activeSessions = []
  })

  afterEach(() => {
    // Destroy any session a failing test left behind so the spawned shim
    // subprocess doesn't outlive the test and pin the node:test worker open.
    for (const session of activeSessions) {
      try { session.destroy() } catch { /* already destroyed */ }
    }
    activeSessions = []
    rmSync(skillsDir, { recursive: true, force: true })
    rmSync(shimDir, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // CliSession: existing pattern (issue says this is the gold standard).
  // -----------------------------------------------------------------------

  describe('CliSession start args', () => {
    it('passes --append-system-prompt when skills are present', () => {
      const session = new CliSession({ cwd: '/tmp', skillsDir })

      let capturedArgs = null
      session._spawnPersistentProcess = (args) => { capturedArgs = args }
      session._hookManager = null

      session.start()

      assert.ok(Array.isArray(capturedArgs), 'spawn args should have been captured')
      const flagIdx = capturedArgs.indexOf('--append-system-prompt')
      assert.ok(flagIdx >= 0, '--append-system-prompt should be in argv')
      const value = capturedArgs[flagIdx + 1]
      assert.ok(typeof value === 'string' && value.length > 0, 'flag value should be non-empty')
      assert.ok(value.includes('Alpha'), 'skill content should be in flag value')
      assert.ok(!value.includes('should not appear'), 'disabled skill should be excluded')
    })

    it('omits --append-system-prompt when skills dir is empty', () => {
      const empty = mkdtempSync(join(tmpdir(), 'chroxy-skills-empty-'))
      try {
        const session = new CliSession({ cwd: '/tmp', skillsDir: empty })
        let capturedArgs = null
        session._spawnPersistentProcess = (args) => { capturedArgs = args }
        session._hookManager = null

        session.start()

        assert.ok(!capturedArgs.includes('--append-system-prompt'),
          'flag should be absent when no skills')
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
    })
  })

  // -----------------------------------------------------------------------
  // Codex: real sendMessage() through a recording shim binary.
  // -----------------------------------------------------------------------

  describe('CodexSession sendMessage e2e', () => {
    /**
     * Build a CodexSession subclass whose static resolvedBinary points at the
     * shim. The shim records its argv so the test can assert on what the real
     * spawn() call received.
     */
    function makeShimmedCodex(opts) {
      // Override `resolvedBinary` to node so the shim script becomes the
      // actual program executed; the wrapped `_buildArgs` below prepends the
      // shim path so node runs it with the real codex argv as its argv.
      class ShimCodex extends CodexSession {
        static get resolvedBinary() { return process.execPath }
      }
      const session = new ShimCodex(opts)
      // Force every spawn() to go through node + the shim script + recorder.
      // CodexSession._buildArgs returns `['exec', text, '--json', ...]` which
      // becomes the script's argv when prefixed with the shim path.
      const origBuildArgs = session._buildArgs.bind(session)
      session._buildArgs = (text) => [shimBin, ...origBuildArgs(text)]
      // Inject the recording file path via env. _buildChildEnv returns a
      // sanitized env, so wrap it to include CHROXY_SHIM_RECORD.
      const origBuildEnv = session._buildChildEnv.bind(session)
      session._buildChildEnv = () => ({ ...origBuildEnv(), CHROXY_SHIM_RECORD: recordPath })
      activeSessions.push(session)
      // Use the real start() — exercises the API-key env-var check and sets
      // _processReady through the public path rather than poking the flag.
      session.start()
      return session
    }

    it('first sendMessage spawns codex with skill text prepended to user message', async () => {
      const session = makeShimmedCodex({ cwd: '/tmp', skillsDir })

      await session.sendMessage('hello world')

      // Wait for the shim to record argv and exit, releasing _isBusy.
      await waitFor(() => existsSync(recordPath), {
        label: 'shim recorded argv',
        timeoutMs: 3000,
      })
      await waitFor(() => !session.isRunning, {
        label: 'subprocess closed',
        timeoutMs: 3000,
      })

      const recordedArgv = JSON.parse(readFileSync(recordPath, 'utf-8'))
      // The shim records `process.argv.slice(2)`, so `recordedArgv` is the
      // actual Codex args: ['exec', <effectiveText>, '--json', ...]
      assert.equal(recordedArgv[0], 'exec', 'first arg should be `exec`')
      assert.equal(recordedArgv[2], '--json', 'third arg should be `--json`')

      const sentText = recordedArgv[1]
      assert.ok(typeof sentText === 'string' && sentText.length > 0,
        'spawn must have been called with a non-empty prompt arg')
      assert.ok(sentText.includes('SKILL_MARKER_ALPHA'),
        `skill text must be present in spawned argv; got: ${sentText.slice(0, 200)}`)
      assert.ok(sentText.endsWith('hello world'),
        'user prompt must be preserved at the end of the prepended message')
      assert.ok(sentText.includes('---'),
        'skills/user separator should be present')
      assert.ok(!sentText.includes('should not appear'),
        'disabled skills must not leak into the spawned argv')
    })

    it('second sendMessage does NOT re-prepend skill text', async () => {
      const session = makeShimmedCodex({ cwd: '/tmp', skillsDir })

      // First call — prepends.
      await session.sendMessage('first')
      await waitFor(() => existsSync(recordPath), { label: 'first record' })
      await waitFor(() => !session.isRunning, { label: 'first close' })

      // Wipe the record and fire a second message.
      rmSync(recordPath, { force: true })
      await session.sendMessage('second')
      await waitFor(() => existsSync(recordPath), { label: 'second record' })
      await waitFor(() => !session.isRunning, { label: 'second close' })

      const recordedArgv = JSON.parse(readFileSync(recordPath, 'utf-8'))
      const sentText = recordedArgv[1]
      assert.equal(sentText, 'second',
        'second message must pass through unmodified — skills already prepended once')
      assert.ok(!sentText.includes('SKILL_MARKER_ALPHA'),
        'skill text must not appear in subsequent messages')
    })

    it('sendMessage with empty skills dir spawns with the unmodified user message', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'chroxy-skills-empty-codex-'))
      try {
        const session = makeShimmedCodex({ cwd: '/tmp', skillsDir: empty })

        await session.sendMessage('plain message')
        await waitFor(() => existsSync(recordPath), { label: 'shim record' })
        await waitFor(() => !session.isRunning, { label: 'subprocess closed' })

        const recordedArgv = JSON.parse(readFileSync(recordPath, 'utf-8'))
        assert.equal(recordedArgv[1], 'plain message',
          'with no skills, the spawned argv must contain only the user message')
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
    })
  })

  // -----------------------------------------------------------------------
  // Gemini: real sendMessage() through the same recording shim.
  // -----------------------------------------------------------------------

  describe('GeminiSession sendMessage e2e', () => {
    function makeShimmedGemini(opts) {
      // See makeShimmedCodex — same pattern: node-as-binary + shim-as-script.
      class ShimGemini extends GeminiSession {
        static get resolvedBinary() { return process.execPath }
      }
      const session = new ShimGemini(opts)
      const origBuildArgs = session._buildArgs.bind(session)
      session._buildArgs = (text) => [shimBin, ...origBuildArgs(text)]
      const origBuildEnv = session._buildChildEnv.bind(session)
      session._buildChildEnv = () => ({ ...origBuildEnv(), CHROXY_SHIM_RECORD: recordPath })
      activeSessions.push(session)
      // Use the real start() — exercises the API-key env-var check and sets
      // _processReady through the public path rather than poking the flag.
      session.start()
      return session
    }

    it('first sendMessage spawns gemini with skill text prepended to user message', async () => {
      const session = makeShimmedGemini({ cwd: '/tmp', skillsDir })

      await session.sendMessage('hello world')

      await waitFor(() => existsSync(recordPath), {
        label: 'shim recorded argv',
        timeoutMs: 3000,
      })
      await waitFor(() => !session.isRunning, {
        label: 'subprocess closed',
        timeoutMs: 3000,
      })

      const recordedArgv = JSON.parse(readFileSync(recordPath, 'utf-8'))
      // The shim records `process.argv.slice(2)`, so `recordedArgv` is the
      // actual Gemini args: ['-p', <text>, '--output-format', 'stream-json', '-y', ...]
      assert.equal(recordedArgv[0], '-p', 'first arg must be `-p`')
      const sentText = recordedArgv[1]
      assert.equal(recordedArgv[2], '--output-format')
      assert.equal(recordedArgv[3], 'stream-json')

      assert.ok(typeof sentText === 'string' && sentText.length > 0)
      assert.ok(sentText.includes('SKILL_MARKER_ALPHA'),
        `skill text must be present in spawned argv; got: ${sentText.slice(0, 200)}`)
      assert.ok(sentText.endsWith('hello world'),
        'user prompt must be preserved at the end of the prepended message')
      assert.ok(!sentText.includes('should not appear'),
        'disabled skills must not leak into the spawned argv')
    })

    it('second sendMessage does NOT re-prepend skill text', async () => {
      const session = makeShimmedGemini({ cwd: '/tmp', skillsDir })

      await session.sendMessage('first')
      await waitFor(() => existsSync(recordPath), { label: 'first record' })
      await waitFor(() => !session.isRunning, { label: 'first close' })

      rmSync(recordPath, { force: true })
      await session.sendMessage('second')
      await waitFor(() => existsSync(recordPath), { label: 'second record' })
      await waitFor(() => !session.isRunning, { label: 'second close' })

      const recordedArgv = JSON.parse(readFileSync(recordPath, 'utf-8'))
      assert.equal(recordedArgv[1], 'second',
        'second message must pass through unmodified — skills already prepended once')
      assert.ok(!recordedArgv[1].includes('SKILL_MARKER_ALPHA'),
        'skill text must not appear in subsequent messages')
    })

    it('sendMessage with empty skills dir spawns with the unmodified user message', async () => {
      const empty = mkdtempSync(join(tmpdir(), 'chroxy-skills-empty-gem-'))
      try {
        const session = makeShimmedGemini({ cwd: '/tmp', skillsDir: empty })

        await session.sendMessage('plain message')
        await waitFor(() => existsSync(recordPath), { label: 'shim record' })
        await waitFor(() => !session.isRunning, { label: 'subprocess closed' })

        const recordedArgv = JSON.parse(readFileSync(recordPath, 'utf-8'))
        assert.equal(recordedArgv[1], 'plain message',
          'with no skills, the spawned argv must contain only the user message')
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
    })
  })
})
