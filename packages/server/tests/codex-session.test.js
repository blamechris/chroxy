import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { CodexSession } from '../src/codex-session.js'

describe('CodexSession', () => {
  it('exposes correct capabilities', () => {
    const caps = CodexSession.capabilities
    assert.equal(caps.permissions, false)
    assert.equal(caps.inProcessPermissions, false)
    assert.equal(caps.modelSwitch, true)
    assert.equal(caps.permissionModeSwitch, false)
    assert.equal(caps.planMode, false)
    assert.equal(caps.resume, false)
    assert.equal(caps.terminal, false)
  })

  it('constructs with default values', () => {
    const session = new CodexSession({ cwd: '/tmp' })
    assert.equal(session.cwd, '/tmp')
    assert.ok(session.model)
    assert.equal(session.isRunning, false)
    assert.equal(session.resumeSessionId, null)
  })

  it('accepts model override in constructor', () => {
    const session = new CodexSession({ cwd: '/tmp', model: 'o3' })
    assert.equal(session.model, 'o3')
  })

  it('setModel updates the model property', () => {
    const session = new CodexSession({ cwd: '/tmp' })
    session.setModel('o3-mini')
    assert.equal(session.model, 'o3-mini')
  })

  it('setPermissionMode is a no-op (no throw)', () => {
    const session = new CodexSession({ cwd: '/tmp' })
    assert.doesNotThrow(() => session.setPermissionMode('auto'))
  })

  it('start sets isRunning and emits ready when codex is available', async () => {
    const session = new CodexSession({ cwd: '/tmp' })
    const events = []
    const errors = []
    session.on('ready', (data) => events.push(data))
    session.on('error', (data) => errors.push(data))

    session.start()
    // Allow event to fire
    await new Promise(r => setTimeout(r, 50))

    // If codex is not installed, start() emits error instead of ready
    if (errors.length > 0) {
      assert.ok(errors[0].message.includes('not found'))
      assert.equal(session.isReady, false)
    } else {
      assert.equal(session.isReady, true)
      assert.equal(session.isRunning, false) // Not busy until sendMessage
      assert.equal(events.length, 1)
      assert.ok(events[0].model)
    }
  })

  it('destroy resets isReady and isRunning', async () => {
    const session = new CodexSession({ cwd: '/tmp' })
    session.start()
    await new Promise(r => setTimeout(r, 50))

    session.destroy()
    assert.equal(session.isReady, false)
    assert.equal(session.isRunning, false)
  })

  describe('_parseCodexLine', () => {
    it('parses thread.started event', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const result = session._parseCodexLine('{"type":"thread.started","thread_id":"abc123"}')
      assert.equal(result.type, 'thread.started')
      assert.equal(result.thread_id, 'abc123')
    })

    it('parses agent_message item.completed', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const result = session._parseCodexLine('{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hello"}}')
      assert.equal(result.type, 'item.completed')
      assert.equal(result.item.type, 'agent_message')
      assert.equal(result.item.text, 'Hello')
    })

    it('parses turn.completed with usage', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const result = session._parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}')
      assert.equal(result.type, 'turn.completed')
      assert.equal(result.usage.input_tokens, 100)
      assert.equal(result.usage.output_tokens, 50)
    })

    it('returns null for invalid JSON', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const result = session._parseCodexLine('not json')
      assert.equal(result, null)
    })
  })

  describe('_interpretError', () => {
    it('detects API key errors', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const msg = session._interpretError(1, 'Error: API key not set')
      assert.ok(msg.includes('OPENAI_API_KEY'))
    })

    it('detects credit/billing errors', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const msg = session._interpretError(1, 'Error: Credit balance is too low')
      assert.ok(msg.includes('credit'))
    })

    it('detects rate limit errors', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const msg = session._interpretError(1, 'Rate limit exceeded')
      assert.ok(msg.includes('rate limit'))
    })

    it('detects command not found', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const msg = session._interpretError(1, 'codex: command not found')
      assert.ok(msg.includes('Install'))
    })

    it('shows first line of stderr when no pattern matches', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const msg = session._interpretError(1, 'some unknown error\nsecond line')
      assert.ok(msg.includes('some unknown error'))
      assert.ok(!msg.includes('second line'))
    })

    it('falls back to exit code when no stderr', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const msg = session._interpretError(1, '')
      assert.ok(msg.includes('code 1'))
    })

    it('truncates long stderr to 200 chars', () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const longMsg = 'x'.repeat(300)
      const msg = session._interpretError(1, longMsg)
      assert.ok(msg.length < 220)
    })
  })

  describe('event mapping', () => {
    it('maps agent_message to stream events', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const events = []
      session.on('stream_start', (d) => events.push({ type: 'stream_start', ...d }))
      session.on('stream_delta', (d) => events.push({ type: 'stream_delta', ...d }))
      session.on('stream_end', (d) => events.push({ type: 'stream_end', ...d }))

      session._processCodexEvent({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'Hello world' },
      })

      assert.equal(events.length, 3)
      assert.equal(events[0].type, 'stream_start')
      assert.equal(events[1].type, 'stream_delta')
      assert.equal(events[1].delta, 'Hello world')
      assert.equal(events[2].type, 'stream_end')
    })

    it('maps turn.completed to result event', async () => {
      const session = new CodexSession({ cwd: '/tmp' })
      const events = []
      session.on('result', (d) => events.push(d))

      session._processCodexEvent({
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 80 },
      })

      assert.equal(events.length, 1)
      assert.ok(events[0].usage)
    })
  })
})
