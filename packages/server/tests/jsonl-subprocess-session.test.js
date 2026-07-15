import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync, existsSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonlSubprocessSession } from '../src/jsonl-subprocess-session.js'
import { isWindows } from '../src/platform.js'
import { addLogListener, removeLogListener } from '../src/logger.js'
import { waitFor } from './test-helpers.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// Shim binary — a tiny node script that writes scripted JSONL lines then
// exits. The subclass under test runs node against this shim.
const shimPath = join(tmpdir(), `jsonl-shim-${process.pid}-${Date.now()}.mjs`)

function writeShim(lines, { exitCode = 0, stderr = '' } = {}) {
  const payload = lines.map((l) => JSON.stringify(l)).join('\n')
  const body = [
    '#!/usr/bin/env node',
    `process.stdout.write(${JSON.stringify(payload + (payload ? '\n' : ''))})`,
    stderr ? `process.stderr.write(${JSON.stringify(stderr)})` : '',
    `process.exit(${exitCode})`,
  ].filter(Boolean).join('\n')
  writeFileSync(shimPath, body)
  chmodSync(shimPath, 0o755)
}

function cleanupShim() {
  if (existsSync(shimPath)) unlinkSync(shimPath)
}

/**
 * Minimal concrete subclass factory for exercising the base. Uses the node
 * binary and the shim script so we can drive the full stdin/stdout/stderr/exit
 * pipeline without a real CLI tool installed.
 */
function makeTestProviderClass({
  apiKey = 'TEST_API_KEY',
  providerName = 'fake',
  displayLabel = 'Fake',
  messageIdPrefix = 'fake',
  binary = process.execPath,
  emitFallbackResult,
  shouldSkipStderr,
} = {}) {
  return class TestProvider extends JsonlSubprocessSession {
    static get binaryCandidates() { return [binary] }
    static get resolvedBinary() { return binary }
    static get apiKeyEnv() { return apiKey }
    static get providerName() { return providerName }
    static get displayLabel() { return displayLabel }
    static get messageIdPrefix() { return messageIdPrefix }

    _buildArgs(text) {
      // Run the shim directly — node will execute it as argv[0].
      return [shimPath, text]
    }

    _buildChildEnv() {
      return process.env
    }

    _processJsonlLine(event, ctx) {
      if (event.type === 'text') {
        if (!ctx.didStreamStart) {
          this.emit('stream_start', { messageId: ctx.messageId })
          ctx.didStreamStart = true
        }
        this.emit('stream_delta', { messageId: ctx.messageId, delta: event.delta || '' })
      } else if (event.type === 'done') {
        ctx.didEmitResult = true
        if (ctx.didStreamStart) {
          this.emit('stream_end', { messageId: ctx.messageId })
          ctx.didStreamStart = false
        }
        this.emit('result', {
          cost: null,
          duration: null,
          usage: event.usage || null,
          sessionId: null,
        })
      }
    }

    _shouldSkipStderr(msg) {
      if (shouldSkipStderr) return shouldSkipStderr(msg)
      return super._shouldSkipStderr(msg)
    }

    _emitFallbackResult(ctx) {
      if (emitFallbackResult) return emitFallbackResult.call(this, ctx)
      return super._emitFallbackResult(ctx)
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JsonlSubprocessSession (base)', () => {
  const SAVED_ENV = process.env.TEST_API_KEY

  beforeEach(() => { process.env.TEST_API_KEY = 'value' })
  afterEach(() => {
    if (SAVED_ENV !== undefined) process.env.TEST_API_KEY = SAVED_ENV
    else delete process.env.TEST_API_KEY
    cleanupShim()
  })

  describe('static overrides', () => {
    it('base class throws when static overrides are missing', () => {
      assert.throws(() => JsonlSubprocessSession.binaryCandidates, /binaryCandidates must be overridden/)
      assert.throws(() => JsonlSubprocessSession.resolvedBinary, /resolvedBinary must be overridden/)
      assert.throws(() => JsonlSubprocessSession.apiKeyEnv, /apiKeyEnv must be overridden/)
      assert.throws(() => JsonlSubprocessSession.providerName, /providerName must be overridden/)
    })

    it('displayLabel defaults to providerName when not overridden', () => {
      class X extends JsonlSubprocessSession {
        static get providerName() { return 'foo' }
      }
      assert.equal(X.displayLabel, 'foo')
    })

    it('messageIdPrefix defaults to providerName when not overridden', () => {
      class X extends JsonlSubprocessSession {
        static get providerName() { return 'foo' }
      }
      assert.equal(X.messageIdPrefix, 'foo')
    })
  })

  describe('constructor', () => {
    it('initialises _process to null', () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      assert.equal(s._process, null)
    })

    it('initialises resumeSessionId to null', () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      assert.equal(s.resumeSessionId, null)
    })

    it('defaults permissionMode to "auto"', () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      assert.equal(s.permissionMode, 'auto')
    })

    it('is not busy/ready after construction', () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      assert.equal(s.isRunning, false)
      assert.equal(s.isReady, false)
    })

    // #3755: middle-layer pattern — every BaseSession opt must forward
    // through super(). resultTimeoutMs is not currently consumed by
    // JsonlSubprocessSession (no inactivity timer), but the plumbing must
    // be in place for when Codex/Gemini adopt the same pattern as
    // SdkSession/CliSession.
    it('forwards resultTimeoutMs to BaseSession (#3755)', () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp', resultTimeoutMs: 600_000 })
      assert.equal(s._resultTimeoutMs, 600_000,
        'JsonlSubprocessSession must forward resultTimeoutMs so Codex/Gemini can honour operator config')
    })

    it('defaults _resultTimeoutMs to 30 min when omitted (#3755 / #3884)', () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      assert.equal(s._resultTimeoutMs, 30 * 60 * 1000,
        'inherits BaseSession default when resultTimeoutMs is not provided')
    })

    // Mirrors sdk-session.test.js:80-89 — BaseSession's
    // `Number.isFinite && > 0` guard rejects nonsense values back to the
    // default. Pinning this at the middle layer guards against regression
    // if BaseSession ever drops the validation.
    it('falls back to the default when resultTimeoutMs is non-positive (#3755)', () => {
      const P = makeTestProviderClass()
      const s1 = new P({ cwd: '/tmp', resultTimeoutMs: 0 })
      const s2 = new P({ cwd: '/tmp', resultTimeoutMs: -1 })
      const s3 = new P({ cwd: '/tmp', resultTimeoutMs: 'oops' })
      assert.equal(s1._resultTimeoutMs, 30 * 60 * 1000)
      assert.equal(s2._resultTimeoutMs, 30 * 60 * 1000)
      assert.equal(s3._resultTimeoutMs, 30 * 60 * 1000)
    })

    // #4790: same middle-layer trap as #3755 / #3225 / #3805 / #4660 / #3899 —
    // SessionManager (PR #4745) wires per-provider streamStallTimeoutMs into
    // providerOpts but JsonlSubprocessSession dropped the key from its
    // destructure list, so Codex/Gemini sessions silently fell back to the
    // BaseSession default. Pin the forwarding at every layer.
    it('forwards streamStallTimeoutMs to BaseSession (#4790)', () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp', streamStallTimeoutMs: 900_000 })
      assert.equal(s._streamStallTimeoutMs, 900_000,
        'JsonlSubprocessSession must forward streamStallTimeoutMs so Codex/Gemini honour the per-provider override')
    })

    it('forwards streamStallTimeoutMs: 0 (explicit disable) to BaseSession (#4790)', () => {
      // BaseSession honours 0 (allowZero: true) as "disable active recovery".
      // The middle layer must preserve this — an operator opting out per
      // provider must not silently re-enable the default 5min timer.
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp', streamStallTimeoutMs: 0 })
      assert.equal(s._streamStallTimeoutMs, 0)
    })

    it('defaults _streamStallTimeoutMs to 5 min when omitted (#4790)', () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      assert.equal(s._streamStallTimeoutMs, 5 * 60 * 1000,
        'inherits BaseSession default when streamStallTimeoutMs is not provided')
    })
  })

  describe('start()', () => {
    it('throws if apiKeyEnv is not set', () => {
      const P = makeTestProviderClass({ apiKey: 'NOT_SET_ANYWHERE_I_HOPE' })
      delete process.env.NOT_SET_ANYWHERE_I_HOPE
      const s = new P({ cwd: '/tmp' })
      assert.throws(() => s.start(), /NOT_SET_ANYWHERE_I_HOPE.*not set/)
    })

    it('sets _processReady true and emits ready on next tick', async () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp', model: 'test-model' })
      const events = []
      s.on('ready', (d) => events.push(d))

      s.start()
      assert.equal(events.length, 0, 'ready must not fire synchronously')
      await waitFor(() => events.length >= 1, { label: 'ready event' })

      assert.equal(s.isReady, true)
      assert.equal(events[0].model, 'test-model')
    })
  })

  describe('destroy()', () => {
    it('kills _process and clears state', async () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      s.start()
      await waitFor(() => s.isReady, { label: 'isReady' })

      // #6643 — destroy() now routes through killProcessTree so a `.cmd`-shim
      // provider's node grandchild is reaped on Windows, not just the wrapper.
      // For this pid-less mock: POSIX still sends a graceful SIGTERM; on Windows
      // (no real pid to taskkill) it falls back to a direct kill. Either way the
      // child is terminated and state is cleared. The real Windows tree-kill is
      // covered by platform.test.js.
      let killed = null
      s._process = { kill: (sig) => { killed = sig } }
      s.destroy()
      assert.ok(killed, 'destroy() should terminate the child process')
      if (!isWindows) assert.equal(killed, 'SIGTERM', 'POSIX destroy uses a graceful SIGTERM')
      assert.equal(s._process, null)
      assert.equal(s.isReady, false)
      assert.equal(s.isRunning, false)
    })

    it('removes all listeners', () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      s.on('result', () => {})
      s.destroy()
      assert.equal(s.listenerCount('result'), 0)
    })

    it('swallows errors from kill() when process is already dead', () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      s._process = { kill: () => { throw new Error('ESRCH') } }
      assert.doesNotThrow(() => s.destroy())
    })
  })

  describe('interrupt()', () => {
    it('sends SIGINT to the running process', () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      let sig = null
      s._process = { kill: (signal) => { sig = signal } }
      s.interrupt()
      assert.equal(sig, 'SIGINT')
    })

    it('is safe to call when no process is running', () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      assert.doesNotThrow(() => s.interrupt())
    })
  })

  describe('setPermissionMode()', () => {
    it('does not throw (no-op by default)', () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      assert.doesNotThrow(() => s.setPermissionMode('auto'))
    })
  })

  describe('sendMessage() guards', () => {
    it('emits error when session is not ready', async () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      const errors = []
      s.on('error', (e) => errors.push(e))
      await s.sendMessage('hi')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /not running/)
    })

    it('emits error when session is busy', async () => {
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      s._processReady = true
      s._isBusy = true
      const errors = []
      s.on('error', (e) => errors.push(e))
      await s.sendMessage('hi')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /busy/)
    })

    it('emits provider-specific error when attachments are supplied', async () => {
      const P = makeTestProviderClass({ displayLabel: 'Fakey' })
      const s = new P({ cwd: '/tmp' })
      s._processReady = true
      const errors = []
      s.on('error', (e) => errors.push(e))
      await s.sendMessage('hi', [{ data: 'x' }])
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /Fakey.*attachments/)
    })
  })

  describe('sendMessage() spawn pipeline', () => {
    it('routes JSONL events through _processJsonlLine', async () => {
      writeShim([
        { type: 'text', delta: 'Hello ' },
        { type: 'text', delta: 'world' },
        { type: 'done', usage: { input_tokens: 7, output_tokens: 3 } },
      ])
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      s._processReady = true

      const seen = []
      s.on('stream_start', (d) => seen.push({ type: 'stream_start', ...d }))
      s.on('stream_delta', (d) => seen.push({ type: 'stream_delta', ...d }))
      s.on('stream_end', (d) => seen.push({ type: 'stream_end', ...d }))
      s.on('result', (d) => seen.push({ type: 'result', ...d }))

      await s.sendMessage('hi')
      await waitFor(() => seen.some(e => e.type === 'result'), { label: 'result' })

      const types = seen.map((e) => e.type)
      assert.deepEqual(types, ['stream_start', 'stream_delta', 'stream_delta', 'stream_end', 'result'])
      const deltas = seen.filter(e => e.type === 'stream_delta').map(e => e.delta)
      assert.deepEqual(deltas, ['Hello ', 'world'])
    })

    it('shares the same messageId across stream_start/delta/end for one turn', async () => {
      writeShim([
        { type: 'text', delta: 'A' },
        { type: 'done' },
      ])
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      s._processReady = true

      const seen = []
      s.on('stream_start', (d) => seen.push({ type: 'stream_start', ...d }))
      s.on('stream_delta', (d) => seen.push({ type: 'stream_delta', ...d }))
      s.on('stream_end', (d) => seen.push({ type: 'stream_end', ...d }))

      await s.sendMessage('hi')
      await waitFor(() => seen.some(e => e.type === 'stream_end'), { label: 'stream_end' })

      const ids = seen.map((e) => e.messageId)
      assert.equal(new Set(ids).size, 1, 'all stream events must share one messageId')
    })

    it('uses messageIdPrefix when generating the messageId', async () => {
      writeShim([
        { type: 'text', delta: 'A' },
        { type: 'done' },
      ])
      const P = makeTestProviderClass({ messageIdPrefix: 'quux' })
      const s = new P({ cwd: '/tmp' })
      s._processReady = true

      const starts = []
      s.on('stream_start', (d) => starts.push(d))
      await s.sendMessage('hi')
      await waitFor(() => starts.length >= 1, { label: 'stream_start' })

      assert.match(starts[0].messageId, /^quux-msg-/)
    })

    it('attaches a user error listener to stdout AND stderr (so a stream error is handled, not uncaught) (#5324)', async () => {
      // A shim that stays alive long enough for us to inspect its stdio streams.
      writeFileSync(shimPath, '#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 3000)\n')
      chmodSync(shimPath, 0o755)

      const P = makeTestProviderClass({ providerName: 'fake' })
      const s = new P({ cwd: '/tmp' })
      s._processReady = true
      s.on('error', () => {})
      s.sendMessage('hi') // not awaited — spawns then polls for the (sleeping) child
      await waitFor(() => s._process != null, { label: '_process spawned' })

      // A user 'error' listener on each pipe is what keeps a real stream error
      // (EPIPE on a dying child, a read fault) from reaching the process as an
      // unhandled 'error' and crashing the whole daemon. (We assert the listener
      // is wired rather than synthetically emitting: node attaches its own
      // internal stream-error handler that re-throws a *manually* emitted error
      // regardless, so a manual emit can't faithfully model a real I/O error.)
      assert.ok(s._process.stdout.listenerCount('error') >= 1, 'stdout has a user error listener')
      assert.ok(s._process.stderr.listenerCount('error') >= 1, 'stderr has a user error listener')

      await s.destroy()
    })

    it('logs (does not crash on) a stderr stream error via the wired listener (#5324)', async () => {
      // Verify the listener BODY: invoke it directly with a fake error and
      // assert it logs rather than throwing. This exercises the handler without
      // fighting node's internal manual-emit re-throw on a real pipe.
      const warns = []
      const logSpy = (e) => {
        if (e.component === 'jsonl-subprocess-session' && e.level === 'warn') warns.push(e.message)
      }
      addLogListener(logSpy)
      try {
        writeFileSync(shimPath, '#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 3000)\n')
        chmodSync(shimPath, 0o755)
        const P = makeTestProviderClass({ providerName: 'fake' })
        const s = new P({ cwd: '/tmp' })
        s._processReady = true
        s.on('error', () => {})
        s.sendMessage('hi')
        await waitFor(() => s._process != null, { label: '_process spawned' })

        // Pull the user listener (the last one registered — ours) and call it.
        const listeners = s._process.stderr.listeners('error')
        const mine = listeners[listeners.length - 1]
        assert.doesNotThrow(() => mine(new Error('boom-err')), 'listener swallows the error')
        assert.ok(warns.some((m) => /stderr stream error.*boom-err/.test(m)), 'stderr error logged')

        await s.destroy()
      } finally {
        removeLogListener(logSpy)
      }
    })

    it('reverts _skillsPrepended on a post-spawn proc error so the next send re-injects (#5382)', async () => {
      // #3225 deferral covers the SYNCHRONOUS spawn throw and the success flip.
      // This covers the third path: a `proc.on('error')` that arrives AFTER the
      // argv was committed (the flag already flipped true). The shared base
      // handler must revert _skillsPrepended to false so a retry re-injects the
      // skills bucket — a dropped revert would silently skip skills injection on
      // the next turn. The revert lives in JsonlSubprocessSession (the base), so
      // exercising it here covers every subclass (Codex/Gemini) that inherits it
      // unchanged.
      writeFileSync(shimPath, '#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 3000)\n')
      chmodSync(shimPath, 0o755)
      const P = makeTestProviderClass({ providerName: 'fake' })
      const s = new P({ cwd: '/tmp' })
      s._processReady = true

      const errors = []
      s.on('error', (e) => errors.push(e))
      s.sendMessage('hi') // not awaited — spawns then polls the sleeping child
      // Wait until the argv is committed and the flag has flipped true.
      await waitFor(() => s._process != null && s._skillsPrepended === true, {
        label: 'spawned + skills prepended', timeoutMs: 3000,
      })

      // Capture the real child BEFORE emitting: the base 'error' handler nulls
      // s._process, so destroy() could no longer SIGTERM the still-sleeping shim
      // and would leak a live child (and keep the runner open) for up to 3s
      // (#5391 review). We kill our captured reference explicitly below.
      const child = s._process
      // The ChildProcess already has the base handler as an 'error' listener, so
      // the emit is delivered (no re-throw) and the revert runs.
      child.emit('error', new Error('post-spawn boom'))

      assert.equal(s._skillsPrepended, false, 'flag reverts so the next send re-injects skills')
      assert.equal(s._isBusy, false, 'busy cleared so a retry is allowed')
      assert.ok(errors.some((e) => /post-spawn boom/.test(e.message)), 'surfaces the error to the session')

      try { child.kill('SIGKILL') } catch { /* already gone */ }
      await s.destroy()
    })

    it('non-zero exit emits an error that includes displayLabel and exit code', async () => {
      writeShim([], { exitCode: 7 })
      const P = makeTestProviderClass({ displayLabel: 'Quasar' })
      const s = new P({ cwd: '/tmp' })
      s._processReady = true

      const errs = []
      s.on('error', (e) => errs.push(e))
      s.on('result', () => {})

      await s.sendMessage('hi')
      await waitFor(() => errs.length >= 1, { label: 'error' })
      assert.match(errs[0].message, /Quasar process exited with code 7/)
    })

    it('captures stderr and appends it (sliced) to the exit error', async () => {
      writeShim([], { exitCode: 2, stderr: 'ERROR: totally broken\n' })
      const P = makeTestProviderClass({ displayLabel: 'Broken' })
      const s = new P({ cwd: '/tmp' })
      s._processReady = true

      const errs = []
      s.on('error', (e) => errs.push(e))
      s.on('result', () => {})

      await s.sendMessage('hi')
      await waitFor(() => errs.length >= 1, { label: 'error' })
      assert.match(errs[0].message, /totally broken/)
    })

    it('prefers non-skipped stderr lines over filtered ones in exit detail', async () => {
      // High-signal line takes priority — the skipped DeprecationWarning
      // must not crowd out the real ERROR line.
      writeShim([], {
        exitCode: 1,
        stderr: 'DeprecationWarning: ignore me\nERROR: real failure\n',
      })
      const P = makeTestProviderClass({
        displayLabel: 'Skippy',
        shouldSkipStderr: (msg) => msg.includes('DeprecationWarning'),
      })
      const s = new P({ cwd: '/tmp' })
      s._processReady = true

      const errs = []
      s.on('error', (e) => errs.push(e))
      s.on('result', () => {})

      await s.sendMessage('hi')
      await waitFor(() => errs.length >= 1, { label: 'error' })
      assert.match(errs[0].message, /real failure/)
      assert.doesNotMatch(errs[0].message, /DeprecationWarning/)
    })

    it('falls back to skipped stderr when no high-signal line was captured (#3834)', async () => {
      // When every stderr line gets filtered, the user must still see *some*
      // explanation rather than a bare "exited with code N".
      writeShim([], { exitCode: 1, stderr: 'DeprecationWarning: only signal we have' })
      const P = makeTestProviderClass({
        displayLabel: 'Skippy',
        shouldSkipStderr: (msg) => msg.includes('DeprecationWarning'),
      })
      const s = new P({ cwd: '/tmp' })
      s._processReady = true

      const errs = []
      s.on('error', (e) => errs.push(e))
      s.on('result', () => {})

      await s.sendMessage('hi')
      await waitFor(() => errs.length >= 1, { label: 'error' })
      assert.match(errs[0].message, /only signal we have/)
    })

    it('logs a warning when raw-stderr fallback supplies the only signal (#3841)', async () => {
      const { addLogListener, removeLogListener } = await import('../src/logger.js')
      const logs = []
      const listener = (entry) => logs.push(entry)
      addLogListener(listener)
      try {
        writeShim([], { exitCode: 1, stderr: 'DeprecationWarning: filtered' })
        const P = makeTestProviderClass({
          displayLabel: 'Skippy',
          providerName: 'skippy',
          shouldSkipStderr: (msg) => msg.includes('DeprecationWarning'),
        })
        const s = new P({ cwd: '/tmp' })
        s._processReady = true

        s.on('error', () => {})
        s.on('result', () => {})

        await s.sendMessage('hi')
        await waitFor(() => logs.some((e) => e.level === 'warn' && /filtered all stderr/.test(e.message)), {
          label: 'fallback warning',
        })

        const warn = logs.find((e) => e.level === 'warn' && /filtered all stderr/.test(e.message))
        assert.ok(warn, 'warn log fired')
        assert.match(warn.message, /\[skippy\]/, 'warning includes provider name')
        assert.match(warn.message, /exited 1/, 'warning includes exit code')
      } finally {
        removeLogListener(listener)
      }
    })

    it('does NOT log the raw-fallback warning on the happy path (#3841)', async () => {
      const { addLogListener, removeLogListener } = await import('../src/logger.js')
      const logs = []
      const listener = (entry) => logs.push(entry)
      addLogListener(listener)
      try {
        // High-signal line present → primary buffer wins → no fallback → no warn.
        writeShim([], { exitCode: 1, stderr: 'ERROR: a real failure' })
        const P = makeTestProviderClass({ displayLabel: 'Noisy', providerName: 'noisy' })
        const s = new P({ cwd: '/tmp' })
        s._processReady = true

        s.on('error', () => {})
        s.on('result', () => {})

        await s.sendMessage('hi')
        // Give the close handler a beat to run.
        await new Promise((r) => setTimeout(r, 50))

        const hit = logs.find((e) => e.level === 'warn' && /filtered all stderr/.test(e.message))
        assert.equal(hit, undefined, 'no fallback warning when high-signal stderr exists')
      } finally {
        removeLogListener(listener)
      }
    })

    it('clears _isBusy after the child exits', async () => {
      writeShim([{ type: 'done' }])
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      s._processReady = true

      await s.sendMessage('hi')
      assert.equal(s.isRunning, true)
      await waitFor(() => !s.isRunning, { label: 'isRunning false' })
      assert.equal(s.isRunning, false)
    })

    it('_emitFallbackResult fires only when the stream did not emit one', async () => {
      // Shim emits no `done` event → ctx.didEmitResult stays false → fallback runs.
      writeShim([{ type: 'text', delta: 'no done event' }])
      let fallbackCalled = false
      const P = makeTestProviderClass({
        emitFallbackResult(ctx) {
          fallbackCalled = true
          this.emit('result', { cost: null, duration: null, usage: null, sessionId: null, messageId: ctx.messageId })
        },
      })
      const s = new P({ cwd: '/tmp' })
      s._processReady = true

      const results = []
      s.on('result', (d) => results.push(d))

      await s.sendMessage('hi')
      await waitFor(() => results.length >= 1, { label: 'result' })
      assert.equal(fallbackCalled, true)
      assert.equal(results.length, 1)
    })

    it('_emitFallbackResult does NOT fire when the stream emitted a result', async () => {
      writeShim([{ type: 'done', usage: { input_tokens: 1, output_tokens: 2 } }])
      let fallbackCalled = false
      const P = makeTestProviderClass({
        emitFallbackResult() { fallbackCalled = true },
      })
      const s = new P({ cwd: '/tmp' })
      s._processReady = true

      const results = []
      s.on('result', (d) => results.push(d))
      await s.sendMessage('hi')
      await waitFor(() => results.length >= 1, { label: 'result' })
      // Let the close handler actually run before we assert.
      await waitFor(() => !s.isRunning, { label: 'close completes' })

      assert.equal(fallbackCalled, false)
      assert.equal(results.length, 1)
      assert.equal(results[0].usage.input_tokens, 1)
    })
  })

  describe('unknown JSONL events are delegated', () => {
    it('unknown event types are silently ignored by default mapper', async () => {
      writeShim([
        { type: 'unknown_event_we_do_not_handle', foo: 'bar' },
        { type: 'done' },
      ])
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      s._processReady = true

      const results = []
      const errors = []
      s.on('result', (d) => results.push(d))
      s.on('error', (e) => errors.push(e))

      await s.sendMessage('hi')
      await waitFor(() => results.length >= 1, { label: 'result' })
      assert.equal(errors.length, 0)
    })

    it('empty and invalid JSONL lines are filtered before _processJsonlLine', async () => {
      // Shim emits a blank line, raw text, and one valid JSONL object.
      // Only the valid object should reach _processJsonlLine.
      const shimBodyLines = [
        '#!/usr/bin/env node',
        `process.stdout.write('')`,          // emit blank line
        `process.stdout.write('\\n')`,        // another blank
        `process.stdout.write('not-json\\n')`, // invalid JSON
        `process.stdout.write(JSON.stringify({ type: 'done' }) + '\\n')`,
        `process.exit(0)`,
      ]
      writeFileSync(shimPath, shimBodyLines.join('\n'))
      chmodSync(shimPath, 0o755)

      const P = makeTestProviderClass()
      let processedCount = 0
      const original = P.prototype._processJsonlLine
      P.prototype._processJsonlLine = function (ev, ctx) {
        processedCount++
        original.call(this, ev, ctx)
      }

      const s = new P({ cwd: '/tmp' })
      s._processReady = true
      const results = []
      s.on('result', (d) => results.push(d))
      await s.sendMessage('hi')
      await waitFor(() => results.length >= 1, { label: 'result' })
      assert.equal(processedCount, 1, 'only the one valid JSONL line should reach the mapper')
    })
  })

  // -----------------------------------------------------------------------
  // #3225: `_skillsPrepended` must only flip after the spawn succeeds. If
  // spawn() throws synchronously (e.g. ENOENT for a missing binary), the
  // flag must stay false so a retry still injects the prepend bucket.
  // -----------------------------------------------------------------------

  describe('_skillsPrepended deferral (#3225)', () => {
    it('stays false when spawn() throws synchronously', async () => {
      // Pick a binary path that cannot exist; spawn should throw ENOENT.
      const missing = '/nonexistent/no/such/binary'
      const P = makeTestProviderClass({ binary: missing })
      const s = new P({ cwd: '/tmp' })
      s._processReady = true

      assert.equal(s._skillsPrepended, false, 'starts false')

      const errors = []
      s.on('error', (e) => errors.push(e))
      await s.sendMessage('hi')
      await waitFor(() => errors.length >= 1, { label: 'error', timeoutMs: 2000 })

      // Cleanup any spawned process from the failure path.
      assert.equal(s._skillsPrepended, false,
        'flag must stay false when spawn fails so the next retry re-injects skills')
      assert.equal(s._isBusy, false, 'busy flag must be cleared so retry is allowed')
    })

    it('flips to true after a successful spawn', async () => {
      writeShim([{ type: 'done' }])
      const P = makeTestProviderClass()
      const s = new P({ cwd: '/tmp' })
      s._processReady = true

      assert.equal(s._skillsPrepended, false, 'starts false')

      const results = []
      s.on('result', (d) => results.push(d))
      await s.sendMessage('hi')
      await waitFor(() => results.length >= 1, { label: 'result' })

      assert.equal(s._skillsPrepended, true,
        'flag must flip to true once spawn argv is committed')
    })
  })
})
