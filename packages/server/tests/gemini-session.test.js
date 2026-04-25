import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GeminiSession } from '../src/gemini-session.js'
import { waitFor } from './test-helpers.js'

describe('GeminiSession', () => {
  let savedApiKey
  beforeEach(() => {
    savedApiKey = process.env.GEMINI_API_KEY
    process.env.GEMINI_API_KEY = 'test-key'
  })
  afterEach(() => {
    if (savedApiKey !== undefined) process.env.GEMINI_API_KEY = savedApiKey
    else delete process.env.GEMINI_API_KEY
  })

  it('exposes correct capabilities', () => {
    const caps = GeminiSession.capabilities
    assert.equal(caps.permissions, false)
    assert.equal(caps.inProcessPermissions, false)
    assert.equal(caps.modelSwitch, true)
    assert.equal(caps.permissionModeSwitch, false)
    assert.equal(caps.planMode, false)
    assert.equal(caps.resume, false)
    assert.equal(caps.terminal, false)
  })

  it('constructs with default values', () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    assert.equal(session.cwd, '/tmp')
    assert.ok(session.model)
    assert.equal(session.isRunning, false)
    assert.equal(session.resumeSessionId, null)
  })

  it('accepts model override in constructor', () => {
    const session = new GeminiSession({ cwd: '/tmp', model: 'gemini-2.5-pro' })
    assert.equal(session.model, 'gemini-2.5-pro')
  })

  it('setModel updates the model property', () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    session.setModel('gemini-2.5-flash')
    assert.equal(session.model, 'gemini-2.5-flash')
  })

  it('setModel is a no-op when busy', () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    session._isBusy = true
    const before = session.model
    session.setModel('gemini-2.5-flash')
    assert.equal(session.model, before)
  })

  it('setModel is a no-op when model is unchanged', () => {
    const session = new GeminiSession({ cwd: '/tmp', model: 'gemini-2.5-pro' })
    session.setModel('gemini-2.5-pro')
    assert.equal(session.model, 'gemini-2.5-pro')
  })

  it('setPermissionMode is a no-op (no throw)', () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    assert.doesNotThrow(() => session.setPermissionMode('auto'))
  })

  it('start sets isRunning and emits ready', async () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    const events = []
    session.on('ready', (data) => events.push(data))

    session.start()
    await new Promise(r => setTimeout(r, 50))

    assert.equal(session.isReady, true)
    assert.equal(session.isRunning, false) // Not busy until sendMessage
    assert.equal(events.length, 1)
    assert.ok(events[0].model)
  })

  it('destroy resets isReady and isRunning', async () => {
    const session = new GeminiSession({ cwd: '/tmp' })
    session.start()
    await new Promise(r => setTimeout(r, 50))

    session.destroy()
    assert.equal(session.isReady, false)
    assert.equal(session.isRunning, false)
  })

  describe('_parseJsonLine', () => {
    it('parses valid JSON', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const result = session._parseJsonLine('{"type":"content_block_start"}')
      assert.deepEqual(result, { type: 'content_block_start' })
    })

    it('returns null for invalid JSON', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const result = session._parseJsonLine('not json')
      assert.equal(result, null)
    })

    it('returns null for empty line', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      assert.equal(session._parseJsonLine(''), null)
      assert.equal(session._parseJsonLine('   '), null)
    })
  })

  describe('event mapping', () => {
    it('_processGeminiEvent skips assistant text (handled in sendMessage)', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const events = []
      session.on('stream_start', (d) => events.push({ type: 'stream_start', ...d }))
      session.on('stream_delta', (d) => events.push({ type: 'stream_delta', ...d }))
      session.on('stream_end', (d) => events.push({ type: 'stream_end', ...d }))

      // Text blocks are now handled inline in sendMessage, not _processGeminiEvent
      session._processGeminiEvent({
        type: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      })

      assert.equal(events.length, 0) // No stream events from _processGeminiEvent
    })

    it('maps result event with usage to result', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const events = []
      session.on('result', (d) => events.push(d))

      session._processGeminiEvent({
        type: 'result',
        usage: { input_tokens: 100, output_tokens: 50 },
      })

      assert.equal(events.length, 1)
      assert.ok(events[0].usage)
    })

    it('maps tool_use to tool_start', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const events = []
      session.on('tool_start', (d) => events.push(d))

      session._processGeminiEvent({
        type: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool-1',
          name: 'read_file',
          input: { path: 'test.txt' },
        }],
      })

      assert.equal(events.length, 1)
      assert.equal(events[0].tool, 'read_file')
    })
  })

  describe('start() API key validation', () => {
    it('throws when GEMINI_API_KEY is not set', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      delete process.env.GEMINI_API_KEY
      assert.throws(() => session.start(), {
        message: /GEMINI_API_KEY.*not set/,
      })
    })

    it('succeeds when GEMINI_API_KEY is set', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      session.start()
      assert.equal(session._processReady, true)
      session.destroy()
    })
  })

  describe('binary candidate list', () => {
    // Regression: the Tauri GUI launch path bug that bit claude (#2891) also
    // affects gemini when installed via curl|sh to ~/.local/bin or via
    // `npm install -g` to ~/.npm-global. Candidate list must cover both.
    it('includes ~/.local/bin/gemini, Homebrew, /usr/local, and ~/.npm-global/bin', async () => {
      const { homedir } = await import('node:os')
      const { join } = await import('node:path')
      const { GeminiSession } = await import('../src/gemini-session.js')
      const candidates = GeminiSession.binaryCandidates

      assert.ok(
        candidates.includes(join(homedir(), '.local/bin/gemini')),
        'candidate list must include ~/.local/bin/gemini')
      assert.ok(
        candidates.includes('/opt/homebrew/bin/gemini'),
        'candidate list must include /opt/homebrew/bin/gemini')
      assert.ok(
        candidates.includes('/usr/local/bin/gemini'),
        'candidate list must include /usr/local/bin/gemini')
      assert.ok(
        candidates.includes(join(homedir(), '.npm-global/bin/gemini')),
        'candidate list must include ~/.npm-global/bin/gemini')
    })

    it('uses homedir() for user-local candidate paths', async () => {
      const { readFileSync } = await import('node:fs')
      const { dirname, join } = await import('node:path')
      const { fileURLToPath } = await import('node:url')
      const dir = dirname(fileURLToPath(import.meta.url))
      const source = readFileSync(join(dir, '../src/gemini-session.js'), 'utf-8')

      assert.ok(/import\s*\{[^}]*homedir[^}]*\}\s*from\s*'os'/.test(source),
        'gemini-session.js must import homedir from os')
      assert.ok(/import\s*\{[^}]*join[^}]*\}\s*from\s*'path'/.test(source),
        'gemini-session.js must import join from path')
    })
  })

  // ---------------------------------------------------------------------------
  // sendMessage() through the FULL spawn pipeline of the JsonlSubprocessSession
  // base class — closes #2991.
  //
  // The pre-existing tests above only call `_processGeminiEvent` in isolation.
  // Below we override only the static `resolvedBinary` (point it at node) and
  // `_buildArgs()` (point node at our shim script) so the real
  // `JsonlSubprocessSession.sendMessage()` runs through the real
  // `GeminiSession._processJsonlLine()` mapper.
  // ---------------------------------------------------------------------------
  describe('sendMessage() via JsonlSubprocessSession base (#2991)', () => {
    const baseShimPath = join(tmpdir(), `gemini-base-shim-${process.pid}-${Date.now()}.mjs`)

    function writeBaseShim(body) {
      writeFileSync(baseShimPath, body)
    }

    function writeBaseShimJsonl(lines, { exitCode = 0, stderr = '' } = {}) {
      const payload = lines.map((l) => JSON.stringify(l)).join('\n')
      const parts = [
        '#!/usr/bin/env node',
        `process.stdout.write(${JSON.stringify(payload + (payload ? '\n' : ''))})`,
      ]
      if (stderr) parts.push(`process.stderr.write(${JSON.stringify(stderr)})`)
      parts.push(`process.exit(${exitCode})`)
      writeBaseShim(parts.join('\n'))
    }

    function cleanupBaseShim() {
      if (existsSync(baseShimPath)) unlinkSync(baseShimPath)
    }

    /**
     * GeminiSession but with the binary swapped for `node` and argv overridden
     * to invoke the shim script. _buildChildEnv, _processJsonlLine,
     * _shouldSkipStderr all flow from the real subclass.
     */
    class BaseShimmedGemini extends GeminiSession {
      static get resolvedBinary() {
        return process.execPath
      }

      _buildArgs(text) {
        return [baseShimPath, text]
      }
    }

    afterEach(() => {
      cleanupBaseShim()
    })

    it('successful round-trip: assistant text + result → stream + result', async () => {
      writeBaseShimJsonl([
        { type: 'assistant', content: [{ type: 'text', text: 'Greetings, ' }] },
        { type: 'assistant', content: [{ type: 'text', text: 'Earthling.' }] },
        { type: 'result', usage: { input_tokens: 8, output_tokens: 3 } },
      ])

      const session = new BaseShimmedGemini({ cwd: '/tmp' })
      session._processReady = true
      const seen = []
      session.on('stream_start', (d) => seen.push({ type: 'stream_start', ...d }))
      session.on('stream_delta', (d) => seen.push({ type: 'stream_delta', ...d }))
      session.on('stream_end', (d) => seen.push({ type: 'stream_end', ...d }))
      session.on('result', (d) => seen.push({ type: 'result', ...d }))
      session.on('error', (d) => seen.push({ type: 'error', ...d }))

      await session.sendMessage('hello')
      await waitFor(() => seen.find(e => e.type === 'result'), { label: 'result event' })

      const types = seen.map((e) => e.type)
      assert.deepEqual(types, ['stream_start', 'stream_delta', 'stream_delta', 'stream_end', 'result'])

      const deltas = seen.filter(e => e.type === 'stream_delta').map(e => e.delta)
      assert.deepEqual(deltas, ['Greetings, ', 'Earthling.'])

      const start = seen.find(e => e.type === 'stream_start')
      const end = seen.find(e => e.type === 'stream_end')
      assert.equal(end.messageId, start.messageId, 'stream_end shares stream_start id')
      assert.match(start.messageId, /^gemini-msg-/, 'gemini prefix preserved by base class')

      const result = seen.find(e => e.type === 'result')
      assert.equal(result.usage.input_tokens, 8)
      assert.equal(result.usage.output_tokens, 3)
    })

    it('abort mid-stream: interrupt() kills the subprocess and clears busy', async () => {
      writeBaseShim([
        '#!/usr/bin/env node',
        `process.stdout.write(JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'starting...' }] }) + '\\n')`,
        // Hang waiting for SIGINT — interrupt() should kill us.
        `setInterval(() => {}, 1000)`,
      ].join('\n'))

      const session = new BaseShimmedGemini({ cwd: '/tmp' })
      session._processReady = true
      const deltas = []
      const errors = []
      const results = []
      session.on('stream_delta', (d) => deltas.push(d))
      session.on('error', (e) => errors.push(e))
      session.on('result', (r) => results.push(r))

      await session.sendMessage('hello')
      await waitFor(() => deltas.length >= 1, { label: 'first delta before interrupt' })
      assert.equal(session.isRunning, true, 'session must be busy mid-stream')

      session.interrupt()

      // After SIGINT the subprocess exits; close handler clears busy and
      // emits a fallback result (turn.completed/result never arrived).
      await waitFor(() => !session.isRunning, { label: 'isRunning cleared after interrupt' })
      assert.equal(session._process, null, '_process cleared after close')
      assert.ok(results.length >= 1, 'fallback result fired after abort')
    })

    it('subprocess crash: non-zero exit emits error with displayLabel + code', async () => {
      writeBaseShimJsonl([], { exitCode: 5, stderr: 'gemini: fatal error\n' })

      const session = new BaseShimmedGemini({ cwd: '/tmp' })
      session._processReady = true
      const errors = []
      const results = []
      session.on('error', (e) => errors.push(e))
      session.on('result', (r) => results.push(r))

      await session.sendMessage('hi')
      await waitFor(() => errors.length >= 1, { label: 'error event' })

      assert.equal(errors.length, 1)
      // Gemini uses displayLabel 'Google Gemini'.
      assert.match(errors[0].message, /Google Gemini.*code 5/)
      assert.match(errors[0].message, /fatal error/)
    })

    it('subprocess crash mid-stream: stream_end + error + fallback result', async () => {
      writeBaseShimJsonl([
        { type: 'assistant', content: [{ type: 'text', text: 'partial...' }] },
      ], { exitCode: 1, stderr: 'fatal: pipe closed' })

      const session = new BaseShimmedGemini({ cwd: '/tmp' })
      session._processReady = true
      const events = []
      session.on('stream_start', (d) => events.push({ type: 'stream_start', ...d }))
      session.on('stream_delta', (d) => events.push({ type: 'stream_delta', ...d }))
      session.on('stream_end', (d) => events.push({ type: 'stream_end', ...d }))
      session.on('error', (d) => events.push({ type: 'error', ...d }))
      session.on('result', (d) => events.push({ type: 'result', ...d }))

      await session.sendMessage('hi')
      await waitFor(() => events.find(e => e.type === 'result'), { label: 'result event' })

      const types = events.map(e => e.type)
      const endIdx = types.indexOf('stream_end')
      const errIdx = types.indexOf('error')
      const resIdx = types.indexOf('result')
      assert.notEqual(endIdx, -1, 'stream_end emitted on close when stream was open')
      assert.notEqual(errIdx, -1, 'error emitted for non-zero exit')
      assert.notEqual(resIdx, -1, 'fallback result emitted on close')
      assert.ok(endIdx < errIdx, 'stream_end before error')
    })

    it('multi-message sequencing: rejects second sendMessage while first is busy', async () => {
      writeBaseShim([
        '#!/usr/bin/env node',
        `process.stdout.write(JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'first' }] }) + '\\n')`,
        // Stay busy briefly so the second sendMessage hits while busy.
        `setTimeout(() => {`,
        `  process.stdout.write(JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n')`,
        `  process.exit(0)`,
        `}, 100)`,
      ].join('\n'))

      const session = new BaseShimmedGemini({ cwd: '/tmp' })
      session._processReady = true
      const results = []
      const errors = []
      const deltas = []
      session.on('result', (r) => results.push(r))
      session.on('error', (e) => errors.push(e))
      session.on('stream_delta', (d) => deltas.push(d))

      await session.sendMessage('first')
      await waitFor(() => deltas.length >= 1, { label: 'first delta' })
      assert.equal(session.isRunning, true, 'first message keeps session busy')

      // Second sendMessage MUST be rejected with a busy error.
      await session.sendMessage('second')
      assert.equal(errors.length, 1, 'second send emitted exactly one error')
      assert.match(errors[0].message, /busy/)

      // First completes normally.
      await waitFor(() => results.length >= 1, { label: 'first result' })
      await waitFor(() => !session.isRunning, { label: 'busy cleared' })

      // Third send succeeds — fully exercises the real mapper again.
      writeBaseShimJsonl([
        { type: 'assistant', content: [{ type: 'text', text: 'third' }] },
        { type: 'result', usage: {} },
      ])
      const seenAfter = []
      session.on('stream_delta', (d) => seenAfter.push(d))
      await session.sendMessage('third')
      await waitFor(() => results.length >= 2, { label: 'third result' })
      assert.ok(seenAfter.some(d => d.delta === 'third'), 'third message went through mapper')
    })

    it('drives the real GeminiSession._processJsonlLine via the base sendMessage', async () => {
      // Tool-flavoured events — confirms the real subclass mapper handles
      // tool_use blocks and standalone tool_result events through the full
      // spawn pipeline.
      writeBaseShimJsonl([
        { type: 'assistant', content: [{ type: 'tool_use', id: 'g-tool-7', name: 'search', input: { q: 'hello' } }] },
        { type: 'tool_result', tool_use_id: 'g-tool-7', content: 'matched 1 doc' },
        { type: 'result', usage: {} },
      ])

      const session = new BaseShimmedGemini({ cwd: '/tmp' })
      session._processReady = true
      const toolStarts = []
      const toolResults = []
      const results = []
      session.on('tool_start', (d) => toolStarts.push(d))
      session.on('tool_result', (d) => toolResults.push(d))
      session.on('result', (d) => results.push(d))

      await session.sendMessage('use a tool')
      await waitFor(() => results.length >= 1, { label: 'result' })

      assert.equal(toolStarts.length, 1)
      assert.equal(toolStarts[0].tool, 'search')
      assert.equal(toolStarts[0].toolUseId, 'g-tool-7')
      assert.deepEqual(toolStarts[0].input, { q: 'hello' })

      assert.equal(toolResults.length, 1)
      assert.equal(toolResults[0].toolUseId, 'g-tool-7')
      assert.equal(toolResults[0].result, 'matched 1 doc')
    })
  })
})
