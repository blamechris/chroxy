import { describe, it, beforeEach, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { CodexSession, buildCodexArgs } from '../src/codex-session.js'
import { waitFor } from './test-helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect emitted events from a session into a plain array.
 */
function makeCollector(session) {
  const events = []
  const collect = (...names) => {
    for (const name of names) {
      session.on(name, (data) => events.push({ type: name, ...data }))
    }
  }
  return { events, collect }
}

// Shim binary path — a temporary node script that prints scripted JSONL lines.
const shimPath = join(tmpdir(), `codex-shim-${process.pid}.mjs`)

function writeShim(lines) {
  const payload = lines.map((l) => JSON.stringify(l)).join('\n')
  writeFileSync(shimPath, [
    '#!/usr/bin/env node',
    `process.stdout.write(${JSON.stringify(payload + '\n')})`,
    'process.exit(0)',
  ].join('\n'))
}

function writeExitShim(code) {
  writeFileSync(shimPath, [
    '#!/usr/bin/env node',
    `process.exit(${code})`,
  ].join('\n'))
}

function cleanupShim() {
  if (existsSync(shimPath)) unlinkSync(shimPath)
}

/**
 * Subclass of CodexSession that uses a shim binary instead of the real
 * `codex` CLI.  It mirrors the sendMessage() logic exactly so that the full
 * readline → event pipeline is exercised without needing the real binary.
 */
class ShimmedCodexSession extends CodexSession {
  constructor(opts, shimBin) {
    super(opts)
    this._shimBin = shimBin
  }

  async sendMessage(text) {
    if (!this._processReady) {
      this.emit('error', { message: 'Session is not running' })
      return
    }
    if (this._isBusy) {
      this.emit('error', { message: 'Session is busy' })
      return
    }

    this._isBusy = true
    this._currentMessageId = `codex-msg-${++this._messageCounter}`

    const proc = spawn(process.execPath, [this._shimBin], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this._process = proc
    let didStreamStart = false
    let didEmitResult = false

    const rl = createInterface({ input: proc.stdout })

    rl.on('line', (line) => {
      if (this._destroying) return
      const event = this._parseJsonLine(line)
      if (!event || !event.type) return

      switch (event.type) {
        case 'item.completed': {
          const item = event.item
          if (!item) break
          if (item.type === 'agent_message' && item.text) {
            if (!didStreamStart) {
              this.emit('stream_start', { messageId: this._currentMessageId })
              didStreamStart = true
            }
            this.emit('stream_delta', { messageId: this._currentMessageId, delta: item.text })
          } else if (item.type === 'tool_call') {
            const toolMessageId = `codex-tool-${++this._messageCounter}`
            this.emit('tool_start', {
              messageId: toolMessageId,
              toolUseId: item.id || toolMessageId,
              tool: item.name || 'unknown',
              input: item.arguments || item.input || {},
            })
          } else if (item.type === 'tool_output') {
            this.emit('tool_result', {
              toolUseId: item.call_id || item.id || `codex-tool-${this._messageCounter}`,
              result: item.output || item.text || '',
            })
          }
          break
        }
        case 'turn.completed': {
          didEmitResult = true
          if (didStreamStart) {
            this.emit('stream_end', { messageId: this._currentMessageId })
            didStreamStart = false
          }
          const usage = event.usage || {}
          this.emit('result', {
            cost: null,
            duration: null,
            usage: {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
            },
            sessionId: null,
          })
          break
        }
        default:
          break
      }
    })

    proc.stderr.on('data', () => {})

    proc.on('close', (code) => {
      this._process = null
      this._isBusy = false
      if (this._destroying) return
      if (didStreamStart) {
        this.emit('stream_end', { messageId: this._currentMessageId })
      }
      if (code !== 0 && code !== null) {
        this.emit('error', { message: `Codex process exited with code ${code}` })
      }
      if (!didEmitResult) {
        this.emit('result', { cost: null, duration: null, usage: null, sessionId: null })
      }
    })

    proc.on('error', (err) => {
      this._process = null
      this._isBusy = false
      if (this._destroying) return
      this.emit('error', { message: err.message || 'Failed to spawn codex' })
    })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexSession', () => {
  let savedApiKey
  before(() => {
    savedApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'test-key'
  })
  after(() => {
    if (savedApiKey !== undefined) process.env.OPENAI_API_KEY = savedApiKey
    else delete process.env.OPENAI_API_KEY
  })

  describe('capabilities', () => {
    it('exposes correct static capabilities', () => {
      const caps = CodexSession.capabilities
      assert.equal(caps.permissions, false)
      assert.equal(caps.inProcessPermissions, false)
      assert.equal(caps.modelSwitch, true)
      assert.equal(caps.permissionModeSwitch, false)
      assert.equal(caps.planMode, false)
      assert.equal(caps.resume, false)
      assert.equal(caps.terminal, false)
      assert.equal(caps.thinkingLevel, false)
    })
  })

  describe('constructor', () => {
    it('defers to Codex CLI default when no model is supplied (no hallucinated ID)', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      // We deliberately do NOT ship a hard-coded default like 'gpt-5.4' —
      // that was a hallucinated ID and pins the server to a specific Codex
      // release. A null model signals `sendMessage` to omit the `-m`/`-c
      // model=` flag, so Codex CLI picks its own configured default.
      assert.equal(session.model, null)
      assert.notEqual(session.model, 'gpt-5.4')
    })

    it('accepts a model override', () => {
      const session = new CodexSession({ cwd: '/tmp', model: 'o3' })
      assert.equal(session.model, 'o3')
    })

    it('sets cwd', () => {
      const session = new CodexSession({ cwd: '/some/dir' })
      assert.equal(session.cwd, '/some/dir')
    })

    it('initialises resumeSessionId to null', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      assert.equal(session.resumeSessionId, null)
    })

    it('initialises _process to null', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      assert.equal(session._process, null)
    })

    it('is not busy or ready after construction', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      assert.equal(session.isRunning, false)
      assert.equal(session.isReady, false)
    })
  })

  describe('start()', () => {
    it('emits ready on the next tick', async () => {
      const session = new CodexSession({ cwd: '/tmp', model: 'o3' })
      const events = []
      session.on('ready', (d) => events.push(d))

      session.start()
      assert.equal(events.length, 0, 'ready must not fire synchronously')

      await waitFor(() => events.length >= 1, { label: 'ready event' })
      assert.equal(events.length, 1)
      assert.equal(events[0].model, 'o3', 'ready payload should include model')
    })

    it('emits ready with null model when no model was supplied (Codex CLI picks default)', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const events = []
      session.on('ready', (d) => events.push(d))

      session.start()
      await waitFor(() => events.length >= 1, { label: 'ready event' })
      assert.equal(events[0].model, null)
    })

    it('sets _processReady so isReady becomes true', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session.start()
      await waitFor(() => session.isReady, { label: 'isReady' })
      assert.equal(session.isReady, true)
    })

    it('isRunning remains false after start (not yet sending)', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session.start()
      await waitFor(() => session.isReady, { label: 'isReady' })
      assert.equal(session.isRunning, false)
    })
  })

  describe('destroy()', () => {
    it('resets isReady and isRunning', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session.start()
      await waitFor(() => session.isReady, { label: 'isReady' })

      session.destroy()
      assert.equal(session.isReady, false)
      assert.equal(session.isRunning, false)
    })

    it('kills _process if one exists', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session.start()
      await waitFor(() => session.isReady, { label: 'isReady' })

      const mockProc = new EventEmitter()
      let killed = false
      mockProc.kill = () => { killed = true }
      session._process = mockProc

      session.destroy()
      assert.equal(killed, true)
      assert.equal(session._process, null)
    })

    it('removes all listeners', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session.start()
      await waitFor(() => session.isReady, { label: 'isReady' })
      session.on('result', () => {})

      session.destroy()
      assert.equal(session.listenerCount('result'), 0)
    })
  })

  describe('setModel()', () => {
    it('updates the model property when not busy', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session.setModel('o3')
      assert.equal(session.model, 'o3')
    })

    it('does not update the model when busy', () => {
      const session = new CodexSession({ cwd: '/tmp', model: 'o3' })
      session._isBusy = true
      session.setModel('gpt-5-codex')
      // Model should remain unchanged because base class guards on _isBusy
      assert.equal(session.model, 'o3')
    })

    it('model remains the same when setting the same value', () => {
      const session = new CodexSession({ cwd: '/tmp', model: 'o3' })
      session.setModel('o3')
      assert.equal(session.model, 'o3')
    })
  })

  describe('setPermissionMode()', () => {
    it('is callable without throwing', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      assert.doesNotThrow(() => session.setPermissionMode('auto'))
    })
  })

  describe('_parseJsonLine()', () => {
    let session

    beforeEach(() => {
      session = new CodexSession({ cwd: '/tmp' })
    })

    it('parses a valid JSON line', () => {
      const result = session._parseJsonLine('{"type":"thread.started","thread_id":"t1"}')
      assert.deepEqual(result, { type: 'thread.started', thread_id: 't1' })
    })

    it('returns null for invalid JSON', () => {
      assert.equal(session._parseJsonLine('not json'), null)
    })

    it('returns null for an empty string', () => {
      assert.equal(session._parseJsonLine(''), null)
    })

    it('returns null for whitespace-only string', () => {
      assert.equal(session._parseJsonLine('   '), null)
    })

    it('round-trips item.completed correctly', () => {
      const line = JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Hello from Codex' },
      })
      const parsed = session._parseJsonLine(line)
      assert.equal(parsed.type, 'item.completed')
      assert.equal(parsed.item.text, 'Hello from Codex')
    })

    it('round-trips turn.completed correctly', () => {
      const line = JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      const parsed = session._parseJsonLine(line)
      assert.equal(parsed.type, 'turn.completed')
      assert.equal(parsed.usage.input_tokens, 10)
    })

    it('round-trips tool_call item', () => {
      const line = JSON.stringify({
        type: 'item.completed',
        item: { type: 'tool_call', id: 'tc1', name: 'read_file', arguments: { path: 'a.txt' } },
      })
      const parsed = session._parseJsonLine(line)
      assert.equal(parsed.item.type, 'tool_call')
      assert.equal(parsed.item.name, 'read_file')
    })

    it('round-trips tool_output item', () => {
      const line = JSON.stringify({
        type: 'item.completed',
        item: { type: 'tool_output', call_id: 'tc1', output: 'file contents' },
      })
      const parsed = session._parseJsonLine(line)
      assert.equal(parsed.item.type, 'tool_output')
      assert.equal(parsed.item.output, 'file contents')
    })
  })

  describe('sendMessage() guards', () => {
    it('emits error when session is not running (_processReady false)', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const errors = []
      session.on('error', (e) => errors.push(e))

      await session.sendMessage('hello')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /not running/)
    })

    it('emits error when session is busy', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session._processReady = true
      session._isBusy = true
      const errors = []
      session.on('error', (e) => errors.push(e))

      await session.sendMessage('hello')
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /busy/)
    })

    it('emits error when attachments are supplied', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session._processReady = true
      session._isBusy = false
      const errors = []
      session.on('error', (e) => errors.push(e))

      await session.sendMessage('hello', [{ data: 'x' }])
      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /attachments/)
    })
  })

  describe('sendMessage() full pipeline (node shim)', () => {
    it('agent_message item emits stream_start → stream_delta → stream_end → result', async () => {
      writeShim([
        { type: 'item.completed', item: { type: 'agent_message', text: 'Hello!' } },
        { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } },
      ])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const { events, collect } = makeCollector(session)
      collect('stream_start', 'stream_delta', 'stream_end', 'result', 'error')

      await session.sendMessage('hi')
      await waitFor(() => events.find(e => e.type === 'result'), { label: 'result event' })

      const types = events.map((e) => e.type)
      assert.ok(types.includes('stream_start'), 'expected stream_start')
      assert.ok(types.includes('stream_delta'), 'expected stream_delta')
      assert.ok(types.includes('stream_end'), 'expected stream_end')
      assert.ok(types.includes('result'), 'expected result')

      const delta = events.find((e) => e.type === 'stream_delta')
      assert.equal(delta.delta, 'Hello!')

      cleanupShim()
    })

    it('turn.completed emits result with usage', async () => {
      writeShim([
        { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 42 } },
      ])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const results = []
      session.on('result', (d) => results.push(d))

      await session.sendMessage('hi')
      await waitFor(() => results.length >= 1, { label: 'result event' })

      assert.equal(results.length, 1)
      assert.equal(results[0].usage.input_tokens, 100)
      assert.equal(results[0].usage.output_tokens, 42)
      assert.equal(results[0].cost, null)
      assert.equal(results[0].sessionId, null)

      cleanupShim()
    })

    it('tool_call item emits tool_start', async () => {
      writeShim([
        {
          type: 'item.completed',
          item: { type: 'tool_call', id: 'tc-1', name: 'read_file', arguments: { path: 'a.txt' } },
        },
        { type: 'turn.completed', usage: {} },
      ])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const toolStarts = []
      session.on('tool_start', (d) => toolStarts.push(d))

      await session.sendMessage('hi')
      await waitFor(() => toolStarts.length >= 1, { label: 'tool_start event' })

      assert.equal(toolStarts.length, 1)
      assert.equal(toolStarts[0].tool, 'read_file')
      assert.equal(toolStarts[0].toolUseId, 'tc-1')
      assert.deepEqual(toolStarts[0].input, { path: 'a.txt' })

      cleanupShim()
    })

    it('tool_output item emits tool_result', async () => {
      writeShim([
        {
          type: 'item.completed',
          item: { type: 'tool_output', call_id: 'tc-1', output: 'file data' },
        },
        { type: 'turn.completed', usage: {} },
      ])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const toolResults = []
      session.on('tool_result', (d) => toolResults.push(d))

      await session.sendMessage('hi')
      await waitFor(() => toolResults.length >= 1, { label: 'tool_result event' })

      assert.equal(toolResults.length, 1)
      assert.equal(toolResults[0].toolUseId, 'tc-1')
      assert.equal(toolResults[0].result, 'file data')

      cleanupShim()
    })

    it('emits result with null usage when no turn.completed received', async () => {
      writeShim([])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const results = []
      session.on('result', (d) => results.push(d))

      await session.sendMessage('hi')
      await waitFor(() => results.length >= 1, { label: 'result event' })

      assert.equal(results.length, 1)
      assert.equal(results[0].usage, null)

      cleanupShim()
    })

    it('non-zero exit code emits error', async () => {
      writeExitShim(1)

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const errors = []
      session.on('error', (e) => errors.push(e))
      session.on('result', () => {})

      await session.sendMessage('hi')
      await waitFor(() => errors.length >= 1, { label: 'error event' })

      assert.equal(errors.length, 1)
      assert.match(errors[0].message, /code 1/)

      cleanupShim()
    })

    it('_isBusy is cleared after process closes', async () => {
      writeShim([
        { type: 'turn.completed', usage: {} },
      ])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true

      await session.sendMessage('hi')
      assert.equal(session.isRunning, true)

      await waitFor(() => !session.isRunning, { label: 'isRunning cleared' })
      assert.equal(session.isRunning, false)

      cleanupShim()
    })

    it('stream_start, stream_delta and stream_end share the same messageId', async () => {
      writeShim([
        { type: 'item.completed', item: { type: 'agent_message', text: 'A' } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'B' } },
        { type: 'turn.completed', usage: {} },
      ])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const { events, collect } = makeCollector(session)
      collect('stream_start', 'stream_delta', 'stream_end')

      await session.sendMessage('hi')
      await waitFor(() => events.find(e => e.type === 'stream_end'), { label: 'stream_end event' })

      const start = events.find((e) => e.type === 'stream_start')
      const deltas = events.filter((e) => e.type === 'stream_delta')
      const end = events.find((e) => e.type === 'stream_end')

      assert.ok(start, 'stream_start missing')
      assert.equal(deltas.length, 2)
      assert.ok(end, 'stream_end missing')

      for (const d of deltas) {
        assert.equal(d.messageId, start.messageId)
      }
      assert.equal(end.messageId, start.messageId)

      cleanupShim()
    })

    it('unknown JSONL types (thread.started, turn.started) are silently ignored', async () => {
      writeShim([
        { type: 'thread.started', thread_id: 't1' },
        { type: 'turn.started' },
        { type: 'turn.completed', usage: {} },
      ])

      const session = new ShimmedCodexSession({ cwd: '/tmp' }, shimPath)
      session._processReady = true
      const { events, collect } = makeCollector(session)
      const results = []
      session.on('result', (d) => results.push(d))
      collect('stream_start', 'stream_delta', 'error')

      await session.sendMessage('hi')
      // Wait for process to finish (result event confirms turn.completed was processed)
      await waitFor(() => results.length >= 1, { label: 'result event' })

      const streamEvents = events.filter((e) => e.type === 'stream_start' || e.type === 'stream_delta')
      const errors = events.filter((e) => e.type === 'error')
      assert.equal(streamEvents.length, 0, 'no stream events for unknown types')
      assert.equal(errors.length, 0, 'no errors for unknown types')

      cleanupShim()
    })

    it('model is included in ready event from start()', async () => {
      const session = new CodexSession({ cwd: '/tmp', model: 'o3' })
      const readyEvents = []
      session.on('ready', (d) => readyEvents.push(d))
      session.start()
      await waitFor(() => readyEvents.length >= 1, { label: 'ready event' })

      assert.equal(readyEvents.length, 1)
      assert.equal(readyEvents[0].model, 'o3')
    })
  })

  describe('start() API key validation', () => {
    afterEach(() => {
      process.env.OPENAI_API_KEY = 'test-key'
    })

    it('throws when OPENAI_API_KEY is not set', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      delete process.env.OPENAI_API_KEY
      assert.throws(() => session.start(), {
        message: /OPENAI_API_KEY.*not set/,
      })
    })

    it('succeeds when OPENAI_API_KEY is set', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      session.start()
      assert.equal(session._processReady, true)
      session.destroy()
    })
  })

  // ---------------------------------------------------------------------------
  // Argv construction — verifies we never spawn `codex` with a hallucinated
  // `-m` / `-c model=...` flag when no model was supplied.
  // ---------------------------------------------------------------------------
  describe('buildCodexArgs()', () => {
    it('always emits `exec <text> --json` as the first three args', () => {
      const args = buildCodexArgs('hello', null)
      assert.deepEqual(args.slice(0, 3), ['exec', 'hello', '--json'])
    })

    it('omits the -c model=... override when model is null', () => {
      const args = buildCodexArgs('hi', null)
      assert.ok(!args.includes('-c'), `unexpected -c in args: ${JSON.stringify(args)}`)
      const hasModelOverride = args.some((a) => typeof a === 'string' && a.startsWith('model='))
      assert.ok(!hasModelOverride, `unexpected model override: ${JSON.stringify(args)}`)
    })

    it('omits the -c model=... override when model is an empty string', () => {
      const args = buildCodexArgs('hi', '')
      assert.ok(!args.includes('-c'))
    })

    it('never references the hallucinated `gpt-5.4` when given no model', () => {
      const args = buildCodexArgs('hi', null)
      assert.ok(!args.some((a) => typeof a === 'string' && a.includes('gpt-5.4')),
        `args must not reference hallucinated model: ${JSON.stringify(args)}`)
    })

    it('appends -c model="X" when an explicit model is provided', () => {
      const args = buildCodexArgs('hi', 'o3')
      const idx = args.indexOf('-c')
      assert.ok(idx >= 0, '-c flag should be present when model is set')
      assert.equal(args[idx + 1], 'model="o3"')
    })
  })
})
