import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync, existsSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonlSubprocessSession } from '../src/jsonl-subprocess-session.js'
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

      let killed = null
      s._process = { kill: (sig) => { killed = sig } }
      s.destroy()
      assert.equal(killed, 'SIGTERM')
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

    it('respects _shouldSkipStderr to drop ignored stderr lines', async () => {
      writeShim([], { exitCode: 1, stderr: 'DeprecationWarning: ignore me' })
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
      assert.doesNotMatch(errs[0].message, /DeprecationWarning/)
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
})
