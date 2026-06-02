import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync, existsSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonlSubprocessSession } from '../src/jsonl-subprocess-session.js'
import { CodexSession } from '../src/codex-session.js'
import { GeminiSession } from '../src/gemini-session.js'
import { waitFor } from './test-helpers.js'

/**
 * Tests for the `_intentionalStop` flag added to JsonlSubprocessSession in
 * #4881 — adds provider parity with CliSession's #4602 emit so Codex and
 * Gemini sessions also surface a quiet `stopped` confirmation when the
 * user clicks Stop (instead of the loud "{provider} process exited with
 * code N" error toast).
 *
 * Codex + Gemini both extend JsonlSubprocessSession, so the flag + close-
 * handler branch land in the base class once and both subclasses inherit
 * the behaviour. The subclass tests below pin that inheritance directly
 * (no per-provider override allowed).
 *
 * Invariants pinned here:
 *   1. `_intentionalStop` starts false on every constructor (base + Codex +
 *      Gemini).
 *   2. `interrupt()` sets `_intentionalStop = true` AND SIGINTs the child.
 *      Old behaviour ONLY SIGINTed — pin that interrupt() now also arms
 *      the flag.
 *   3. `proc.on('close')`, when `_intentionalStop` is true:
 *        - suppresses the "exited with code N" error emit
 *        - emits a single `stopped` event with the exit `code`
 *        - clears the flag (single-use)
 *   4. A subsequent natural non-zero exit (flag already cleared) still
 *      flows through the normal error-emit path — regression guard.
 *   5. `destroy()` always clears the flag.
 *   6. interrupt() is a no-op (flag stays false) when no child process
 *      exists.
 */

// ---------------------------------------------------------------------------
// Test fixtures (mirrors jsonl-subprocess-session.test.js)
// ---------------------------------------------------------------------------

const shimPath = join(tmpdir(), `jsonl-stop-shim-${process.pid}-${Date.now()}.mjs`)

function writeShim(lines, { exitCode = 0, stderr = '', exitDelayMs = 0 } = {}) {
  const payload = lines.map((l) => JSON.stringify(l)).join('\n')
  // exitDelayMs: defer process.exit so the parent test can arm flags
  // (_intentionalStop, _destroying) AFTER `await s.sendMessage(...)` resolves
  // but BEFORE the shim closes. Without the delay the shim exits synchronously
  // after spawn, racing the post-await flag assignments and intermittently
  // firing the close handler with stale (unset) flags.
  const exitCall = exitDelayMs > 0
    ? `setTimeout(() => process.exit(${exitCode}), ${exitDelayMs})`
    : `process.exit(${exitCode})`
  const body = [
    '#!/usr/bin/env node',
    `process.stdout.write(${JSON.stringify(payload + (payload ? '\n' : ''))})`,
    stderr ? `process.stderr.write(${JSON.stringify(stderr)})` : '',
    exitCall,
  ].filter(Boolean).join('\n')
  writeFileSync(shimPath, body)
  chmodSync(shimPath, 0o755)
}

function cleanupShim() {
  if (existsSync(shimPath)) unlinkSync(shimPath)
}

function makeTestProviderClass({
  apiKey = 'TEST_API_KEY',
  providerName = 'fake',
  displayLabel = 'Fake',
  messageIdPrefix = 'fake',
  binary = process.execPath,
} = {}) {
  return class TestProvider extends JsonlSubprocessSession {
    static get binaryCandidates() { return [binary] }
    static get resolvedBinary() { return binary }
    static get apiKeyEnv() { return apiKey }
    static get providerName() { return providerName }
    static get displayLabel() { return displayLabel }
    static get messageIdPrefix() { return messageIdPrefix }

    _buildArgs(text) { return [shimPath, text] }
    _buildChildEnv() { return process.env }

    _processJsonlLine(event, ctx) {
      if (event.type === 'done') {
        ctx.didEmitResult = true
        this.emit('result', { cost: null, duration: null, usage: null, sessionId: null })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JsonlSubprocessSession _intentionalStop — constructor initialises to false (#4881)', () => {
  it('base subclass starts with _intentionalStop=false', () => {
    const P = makeTestProviderClass()
    const s = new P({ cwd: '/tmp' })
    assert.equal(s._intentionalStop, false)
  })

  it('CodexSession starts with _intentionalStop=false (inherits)', () => {
    const s = new CodexSession({ cwd: '/tmp' })
    assert.equal(s._intentionalStop, false,
      'Codex must inherit the parity flag — provider-parity emit is gated on it')
  })

  it('GeminiSession starts with _intentionalStop=false (inherits)', () => {
    const s = new GeminiSession({ cwd: '/tmp' })
    assert.equal(s._intentionalStop, false,
      'Gemini must inherit the parity flag — provider-parity emit is gated on it')
  })
})

describe('JsonlSubprocessSession interrupt() arms _intentionalStop + SIGINTs child (#4881)', () => {
  it('sets flag AND sends SIGINT when a child is running', () => {
    const P = makeTestProviderClass()
    const s = new P({ cwd: '/tmp' })
    let sig = null
    s._process = { kill: (signal) => { sig = signal } }

    s.interrupt()

    assert.equal(s._intentionalStop, true,
      'interrupt() must arm the flag so the close handler emits stopped instead of error')
    assert.equal(sig, 'SIGINT', 'interrupt() must SIGINT the child (existing behaviour)')
  })

  it('is a no-op when no child exists (flag stays false)', () => {
    const P = makeTestProviderClass()
    const s = new P({ cwd: '/tmp' })
    s._process = null

    s.interrupt()

    assert.equal(s._intentionalStop, false,
      'no child → no flag change (matches CliSession.interrupt() guard)')
  })

  it('Codex.interrupt() arms the flag (parity test through real subclass)', () => {
    const s = new CodexSession({ cwd: '/tmp' })
    let sig = null
    s._process = { kill: (signal) => { sig = signal } }

    s.interrupt()

    assert.equal(s._intentionalStop, true)
    assert.equal(sig, 'SIGINT')
  })

  it('Gemini.interrupt() arms the flag (parity test through real subclass)', () => {
    const s = new GeminiSession({ cwd: '/tmp' })
    let sig = null
    s._process = { kill: (signal) => { sig = signal } }

    s.interrupt()

    assert.equal(s._intentionalStop, true)
    assert.equal(sig, 'SIGINT')
  })

  it('swallows kill() errors but still arms the flag', () => {
    const P = makeTestProviderClass()
    const s = new P({ cwd: '/tmp' })
    s._process = { kill: () => { throw new Error('ESRCH') } }

    assert.doesNotThrow(() => s.interrupt())
    assert.equal(s._intentionalStop, true,
      'flag is set BEFORE kill() so a throwing already-dead child still arms the close branch')
  })
})

describe('JsonlSubprocessSession proc.on(close) — intentional stop emits `stopped` not `error` (#4881)', () => {
  const SAVED_ENV = process.env.TEST_API_KEY
  beforeEach(() => { process.env.TEST_API_KEY = 'value' })
  afterEach(() => {
    if (SAVED_ENV !== undefined) process.env.TEST_API_KEY = SAVED_ENV
    else delete process.env.TEST_API_KEY
    cleanupShim()
  })

  it('emits `stopped` with the SIGINT exit code when flag is set', async () => {
    // Shim exits 130 (SIGINT convention) WITHOUT emitting `done` so we
    // can both pin that the error branch is suppressed AND that the
    // exit code reaches the stopped payload.
    writeShim([], { exitCode: 130 })
    const P = makeTestProviderClass({ displayLabel: 'Quasar' })
    const s = new P({ cwd: '/tmp' })
    s._processReady = true

    const errors = []
    const stopped = []
    s.on('error', (e) => errors.push(e))
    s.on('stopped', (e) => stopped.push(e))
    s.on('result', () => {})

    // Arm the flag before the child closes — simulates the user-clicked-Stop
    // path: interrupt() arms the flag before SIGINT, then SIGINT kills the
    // child, then the close handler observes the flag and emits stopped.
    s._intentionalStop = true
    await s.sendMessage('hi')
    await waitFor(() => stopped.length >= 1, { label: 'stopped event' })

    assert.equal(errors.length, 0,
      'intentional stop must suppress the "exited with code N" error emit')
    assert.equal(stopped.length, 1, 'exactly one stopped event')
    assert.equal(stopped[0].code, 130, 'stopped payload carries the SIGINT exit code')
    assert.equal(s._intentionalStop, false,
      'single-use: flag clears after the close handler consumes it')
  })

  it('clears the flag even when _destroying short-circuits (no leak)', async () => {
    // exitDelayMs=50: shim defers process.exit so the close handler can NOT
    // fire before the post-await flag assignments below land. Without the
    // delay, the immediate-exit shim races the test's `_intentionalStop = true`
    // / `_destroying = true` lines and the close handler observes the unset
    // flags, intermittently masking the leak this test is meant to catch.
    writeShim([], { exitCode: 0, exitDelayMs: 50 })
    const P = makeTestProviderClass()
    const s = new P({ cwd: '/tmp' })
    s._processReady = true

    const errors = []
    const stopped = []
    s.on('error', (e) => errors.push(e))
    s.on('stopped', (e) => stopped.push(e))

    // Send message THEN both arm the flag and flip _destroying. The close
    // handler must clear the flag even though _destroying skips the emits.
    // The shim's exitDelayMs guarantees this assignment lands before close.
    await s.sendMessage('hi')
    s._intentionalStop = true
    s._destroying = true
    await waitFor(() => !s.isRunning, { label: 'isRunning false' })

    assert.equal(s._intentionalStop, false,
      'flag MUST clear even when _destroying suppresses emits — no leak')
    assert.equal(stopped.length, 0, '_destroying suppresses stopped')
    assert.equal(errors.length, 0, '_destroying suppresses error')
  })
})

describe('JsonlSubprocessSession proc.on(close) — natural non-zero exit still emits error (regression #4881)', () => {
  const SAVED_ENV = process.env.TEST_API_KEY
  beforeEach(() => { process.env.TEST_API_KEY = 'value' })
  afterEach(() => {
    if (SAVED_ENV !== undefined) process.env.TEST_API_KEY = SAVED_ENV
    else delete process.env.TEST_API_KEY
    cleanupShim()
  })

  it('non-zero exit with flag=false emits error (existing behaviour preserved)', async () => {
    writeShim([], { exitCode: 7 })
    const P = makeTestProviderClass({ displayLabel: 'Crashy' })
    const s = new P({ cwd: '/tmp' })
    s._processReady = true

    const errors = []
    const stopped = []
    s.on('error', (e) => errors.push(e))
    s.on('stopped', (e) => stopped.push(e))
    s.on('result', () => {})

    await s.sendMessage('hi')
    await waitFor(() => errors.length >= 1, { label: 'error event' })

    assert.equal(errors.length, 1, 'natural crash must emit error')
    assert.match(errors[0].message, /Crashy process exited with code 7/,
      'standard crash message preserved')
    assert.equal(stopped.length, 0, 'crash must NOT emit stopped')
  })

  it('zero exit with flag=false emits neither error nor stopped (happy path)', async () => {
    writeShim([{ type: 'done' }], { exitCode: 0 })
    const P = makeTestProviderClass()
    const s = new P({ cwd: '/tmp' })
    s._processReady = true

    const errors = []
    const stopped = []
    const results = []
    s.on('error', (e) => errors.push(e))
    s.on('stopped', (e) => stopped.push(e))
    s.on('result', (r) => results.push(r))

    await s.sendMessage('hi')
    await waitFor(() => results.length >= 1, { label: 'result' })
    await waitFor(() => !s.isRunning, { label: 'close completes' })

    assert.equal(errors.length, 0)
    assert.equal(stopped.length, 0,
      'clean turn end must NOT emit stopped — stopped is for user-initiated interrupts only')
    assert.equal(results.length, 1)
  })
})

describe('JsonlSubprocessSession destroy() always clears _intentionalStop (#4881)', () => {
  it('flag cleared after destroy() (base subclass)', () => {
    const P = makeTestProviderClass()
    const s = new P({ cwd: '/tmp' })
    s._intentionalStop = true

    s.destroy()

    assert.equal(s._intentionalStop, false,
      'destroy() must clear the flag — matches CliSession.destroy()')
  })

  it('flag cleared after destroy() (CodexSession)', () => {
    const s = new CodexSession({ cwd: '/tmp' })
    s._intentionalStop = true

    s.destroy()

    assert.equal(s._intentionalStop, false)
  })

  it('flag cleared after destroy() (GeminiSession)', () => {
    const s = new GeminiSession({ cwd: '/tmp' })
    s._intentionalStop = true

    s.destroy()

    assert.equal(s._intentionalStop, false)
  })
})
