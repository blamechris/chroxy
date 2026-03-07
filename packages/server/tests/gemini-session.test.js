import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GeminiSession } from '../src/gemini-session.js'

describe('GeminiSession', () => {
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

  describe('_parseGeminiLine', () => {
    it('parses valid JSON', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const result = session._parseGeminiLine('{"type":"content_block_start"}')
      assert.deepEqual(result, { type: 'content_block_start' })
    })

    it('returns null for invalid JSON', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      const result = session._parseGeminiLine('not json')
      assert.equal(result, null)
    })

    it('returns null for empty line', () => {
      const session = new GeminiSession({ cwd: '/tmp' })
      assert.equal(session._parseGeminiLine(''), null)
      assert.equal(session._parseGeminiLine('   '), null)
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
})
