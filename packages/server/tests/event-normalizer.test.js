import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventNormalizer, EVENT_MAP } from '../src/event-normalizer.js'

// -- Helper to create a standard multi-session context --
function makeCtx(overrides = {}) {
  return {
    sessionId: 'sess-1',
    mode: 'multi',
    getSessionEntry: () => ({
      session: { model: 'claude-sonnet-4-20250514', permissionMode: 'approve' },
      name: 'Test Session',
      cwd: '/tmp/test',
    }),
    ...overrides,
  }
}

describe('EventNormalizer', () => {
  let normalizer

  beforeEach(() => {
    normalizer = new EventNormalizer({ flushIntervalMs: 10 })
  })

  afterEach(() => {
    normalizer.destroy()
  })

  // ---- normalize() basic behavior ----

  describe('normalize()', () => {
    it('returns null for unknown events', () => {
      const result = normalizer.normalize('unknown_event', {}, makeCtx())
      assert.equal(result, null)
    })

    it('returns messages array for known events', () => {
      const result = normalizer.normalize('plan_started', {}, makeCtx())
      assert.ok(result)
      assert.ok(Array.isArray(result.messages))
      assert.equal(result.messages[0].msg.type, 'plan_started')
    })
  })

  // ---- EVENT_MAP: ready ----

  describe('ready event', () => {
    it('emits claude_ready + model_changed + permission_mode_changed in multi mode', () => {
      const result = normalizer.normalize('ready', {}, makeCtx())
      assert.equal(result.messages.length, 3)
      assert.equal(result.messages[0].msg.type, 'claude_ready')
      assert.equal(result.messages[1].msg.type, 'model_changed')
      assert.equal(result.messages[1].msg.model, 'sonnet')
      assert.equal(result.messages[2].msg.type, 'permission_mode_changed')
      assert.equal(result.messages[2].msg.mode, 'approve')
    })

    it('emits claude_ready + model_changed + permission_mode_changed in legacy-cli mode', () => {
      const ctx = makeCtx({ mode: 'legacy-cli' })
      const result = normalizer.normalize('ready', {}, ctx)
      assert.equal(result.messages.length, 3)
      assert.equal(result.messages[0].msg.type, 'claude_ready')
    })

    it('handles missing session entry gracefully', () => {
      const ctx = makeCtx({ getSessionEntry: () => null })
      const result = normalizer.normalize('ready', {}, ctx)
      assert.equal(result.messages.length, 1)
      assert.equal(result.messages[0].msg.type, 'claude_ready')
    })
  })

  // ---- EVENT_MAP: conversation_id ----

  describe('conversation_id event', () => {
    it('emits conversation_id message and session_list side effect', () => {
      const result = normalizer.normalize('conversation_id', { conversationId: 'conv-123' }, makeCtx())
      assert.equal(result.messages[0].msg.type, 'conversation_id')
      assert.equal(result.messages[0].msg.conversationId, 'conv-123')
      assert.equal(result.messages[0].msg.sessionId, 'sess-1')
      assert.ok(result.sideEffects.some(se => se.type === 'session_list'))
    })
  })

  // ---- EVENT_MAP: stream_start ----

  describe('stream_start event', () => {
    it('emits stream_start + agent_busy + session_list side effect', () => {
      const result = normalizer.normalize('stream_start', { messageId: 'msg-1' }, makeCtx())
      assert.equal(result.messages.length, 2)
      assert.equal(result.messages[0].msg.type, 'stream_start')
      assert.equal(result.messages[0].msg.messageId, 'msg-1')
      assert.equal(result.messages[1].msg.type, 'agent_busy')
      assert.ok(result.sideEffects.some(se => se.type === 'session_list'))
      assert.ok(result.sideEffects.some(se => se.type === 'log'))
    })
  })

  // ---- EVENT_MAP: stream_delta ----

  describe('stream_delta event', () => {
    it('returns buffer flag', () => {
      const result = normalizer.normalize('stream_delta', { messageId: 'msg-1', delta: 'hello' }, makeCtx())
      assert.equal(result.buffer, true)
      assert.equal(result.messages[0].msg.delta, 'hello')
    })
  })

  // ---- EVENT_MAP: stream_end ----

  describe('stream_end event', () => {
    it('emits stream_end with flush_deltas side effect', () => {
      const result = normalizer.normalize('stream_end', { messageId: 'msg-1' }, makeCtx())
      assert.equal(result.messages[0].msg.type, 'stream_end')
      assert.equal(result.messages[0].msg.messageId, 'msg-1')
      assert.ok(result.sideEffects.some(se => se.type === 'flush_deltas'))
    })
  })

  // ---- EVENT_MAP: message ----

  describe('message event', () => {
    it('maps data fields to WS message', () => {
      const data = { type: 'response', content: 'Hello!', tool: null, options: null, timestamp: 1000 }
      const result = normalizer.normalize('message', data, makeCtx())
      const msg = result.messages[0].msg
      assert.equal(msg.type, 'message')
      assert.equal(msg.messageType, 'response')
      assert.equal(msg.content, 'Hello!')
      assert.equal(msg.timestamp, 1000)
    })

    it('has no filter in multi mode', () => {
      const data = { type: 'response', content: 'Hi', timestamp: 5000 }
      const result = normalizer.normalize('message', data, makeCtx())
      assert.equal(result.messages[0].filter, undefined)
    })
  })

  // ---- EVENT_MAP: tool_start / tool_result ----

  describe('tool_start event', () => {
    it('maps all fields', () => {
      const data = { messageId: 'm1', toolUseId: 'tu1', tool: 'Read', input: '/tmp' }
      const result = normalizer.normalize('tool_start', data, makeCtx())
      const msg = result.messages[0].msg
      assert.equal(msg.type, 'tool_start')
      assert.equal(msg.messageId, 'm1')
      assert.equal(msg.toolUseId, 'tu1')
      assert.equal(msg.tool, 'Read')
      assert.equal(msg.input, '/tmp')
    })

    it('includes serverName for MCP tools', () => {
      const data = { messageId: 'm2', toolUseId: 'tu2', tool: 'mcp__github__list_repos', input: null, serverName: 'github' }
      const result = normalizer.normalize('tool_start', data, makeCtx())
      const msg = result.messages[0].msg
      assert.equal(msg.serverName, 'github')
    })

    it('omits serverName for built-in tools', () => {
      const data = { messageId: 'm3', toolUseId: 'tu3', tool: 'Bash', input: null }
      const result = normalizer.normalize('tool_start', data, makeCtx())
      const msg = result.messages[0].msg
      assert.equal(msg.serverName, undefined)
    })
  })

  // ---- EVENT_MAP: mcp_servers ----

  describe('mcp_servers event', () => {
    it('maps server list', () => {
      const data = { servers: [{ name: 'filesystem', status: 'connected' }, { name: 'github', status: 'connected' }] }
      const result = normalizer.normalize('mcp_servers', data, makeCtx())
      const msg = result.messages[0].msg
      assert.equal(msg.type, 'mcp_servers')
      assert.equal(msg.servers.length, 2)
      assert.equal(msg.servers[0].name, 'filesystem')
    })
  })

  describe('tool_result event', () => {
    it('maps all fields', () => {
      const data = { toolUseId: 'tu1', result: 'file contents', truncated: false }
      const result = normalizer.normalize('tool_result', data, makeCtx())
      const msg = result.messages[0].msg
      assert.equal(msg.type, 'tool_result')
      assert.equal(msg.toolUseId, 'tu1')
      assert.equal(msg.result, 'file contents')
      assert.equal(msg.truncated, false)
    })

    it('forwards images when present', () => {
      const images = [{ mediaType: 'image/png', data: 'abc=' }]
      const data = { toolUseId: 'tu1', result: 'screenshot', truncated: false, images }
      const result = normalizer.normalize('tool_result', data, makeCtx())
      const msg = result.messages[0].msg
      assert.deepEqual(msg.images, images)
    })

    it('omits images when not present', () => {
      const data = { toolUseId: 'tu1', result: 'text only', truncated: false }
      const result = normalizer.normalize('tool_result', data, makeCtx())
      const msg = result.messages[0].msg
      assert.equal(msg.images, undefined)
    })
  })

  // ---- EVENT_MAP: agent_spawned / agent_completed ----

  describe('agent_spawned event', () => {
    it('maps fields', () => {
      const data = { toolUseId: 'tu1', description: 'Explore code', startedAt: 1000 }
      const result = normalizer.normalize('agent_spawned', data, makeCtx())
      assert.equal(result.messages[0].msg.type, 'agent_spawned')
      assert.equal(result.messages[0].msg.description, 'Explore code')
    })
  })

  describe('agent_completed event', () => {
    it('maps fields', () => {
      const data = { toolUseId: 'tu1' }
      const result = normalizer.normalize('agent_completed', data, makeCtx())
      assert.equal(result.messages[0].msg.type, 'agent_completed')
      assert.equal(result.messages[0].msg.toolUseId, 'tu1')
    })
  })

  // ---- EVENT_MAP: plan_started / plan_ready ----

  describe('plan_started event', () => {
    it('emits plan_started', () => {
      const result = normalizer.normalize('plan_started', {}, makeCtx())
      assert.equal(result.messages[0].msg.type, 'plan_started')
    })
  })

  describe('plan_ready event', () => {
    it('includes allowedPrompts', () => {
      const data = { allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }] }
      const result = normalizer.normalize('plan_ready', data, makeCtx())
      assert.deepEqual(result.messages[0].msg.allowedPrompts, data.allowedPrompts)
    })
  })

  // ---- EVENT_MAP: result ----

  describe('result event', () => {
    it('emits result + agent_idle + session_list + refresh_context in multi mode', () => {
      const data = { cost: 0.05, duration: 3000, usage: {}, sessionId: 'sdk-1' }
      const result = normalizer.normalize('result', data, makeCtx())
      assert.equal(result.messages.length, 2)
      assert.equal(result.messages[0].msg.type, 'result')
      assert.equal(result.messages[0].msg.cost, 0.05)
      assert.equal(result.messages[1].msg.type, 'agent_idle')
      assert.ok(result.sideEffects.some(se => se.type === 'session_list'))
      assert.ok(result.sideEffects.some(se => se.type === 'refresh_context'))
    })

    it('omits refresh_context in legacy-cli mode', () => {
      const data = { cost: 0.01, duration: 1000, usage: {} }
      const result = normalizer.normalize('result', data, makeCtx({ mode: 'legacy-cli' }))
      assert.ok(!result.sideEffects.some(se => se.type === 'refresh_context'))
    })
  })

  // ---- EVENT_MAP: user_question ----

  describe('user_question event', () => {
    it('emits message and registers in question map', () => {
      const data = { toolUseId: 'tu1', questions: [{ question: 'Pick one', options: [] }] }
      const result = normalizer.normalize('user_question', data, makeCtx())
      assert.equal(result.messages[0].msg.type, 'user_question')
      assert.equal(result.registrations[0].map, 'question')
      assert.equal(result.registrations[0].key, 'tu1')
      assert.equal(result.registrations[0].value, 'sess-1')
    })
  })

  // ---- EVENT_MAP: permission_request ----

  describe('permission_request event', () => {
    it('emits message, registers in permission map, and triggers push', () => {
      const data = { requestId: 'req-1', tool: 'Bash', description: 'run ls', input: 'ls', remainingMs: 60000 }
      const result = normalizer.normalize('permission_request', data, makeCtx())
      assert.equal(result.messages[0].msg.type, 'permission_request')
      assert.equal(result.messages[0].msg.requestId, 'req-1')
      assert.equal(result.registrations[0].map, 'permission')
      assert.equal(result.registrations[0].key, 'req-1')
      assert.ok(result.sideEffects.some(se => se.type === 'push'))
      const pushEffect = result.sideEffects.find(se => se.type === 'push')
      assert.equal(pushEffect.category, 'permission')
      assert.ok(pushEffect.body.includes('Bash'))
    })
  })

  // ---- EVENT_MAP: error ----

  describe('error event', () => {
    it('wraps error as a message', () => {
      const data = { message: 'Something went wrong' }
      const result = normalizer.normalize('error', data, makeCtx())
      assert.equal(result.messages[0].msg.type, 'message')
      assert.equal(result.messages[0].msg.messageType, 'error')
      assert.equal(result.messages[0].msg.content, 'Something went wrong')
    })
  })

  // ---- Delta buffering ----

  describe('delta buffering', () => {
    it('buffers deltas by key and returns them on flushSession', () => {
      normalizer.bufferDelta('sess-1', 'msg-1', 'Hello')
      normalizer.bufferDelta('sess-1', 'msg-1', ' World')
      const entries = normalizer.flushSession('sess-1')
      assert.equal(entries.length, 1)
      assert.equal(entries[0].delta, 'Hello World')
      assert.equal(entries[0].messageId, 'msg-1')
      assert.equal(entries[0].sessionId, 'sess-1')
    })

    it('flushSession only flushes the targeted session', () => {
      normalizer.bufferDelta('sess-1', 'msg-1', 'A')
      normalizer.bufferDelta('sess-2', 'msg-2', 'B')
      const entries = normalizer.flushSession('sess-1')
      assert.equal(entries.length, 1)
      assert.equal(entries[0].sessionId, 'sess-1')
      // sess-2 should still be buffered
      const entries2 = normalizer.flushSession('sess-2')
      assert.equal(entries2.length, 1)
    })

    it('flushSession(null) flushes everything (legacy mode)', () => {
      normalizer.bufferDelta(null, 'msg-1', 'A')
      normalizer.bufferDelta(null, 'msg-2', 'B')
      const entries = normalizer.flushSession(null)
      assert.equal(entries.length, 2)
    })

    it('fires onFlush callback on timer', async () => {
      let flushed = null
      normalizer.onFlush = (entries) => { flushed = entries }
      normalizer.bufferDelta('sess-1', 'msg-1', 'hello')
      // Wait for the flush timer to fire
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.ok(flushed)
      assert.equal(flushed.length, 1)
      assert.equal(flushed[0].delta, 'hello')
    })

    it('cancels timer when buffer emptied by flushSession', () => {
      normalizer.bufferDelta('sess-1', 'msg-1', 'x')
      normalizer.flushSession('sess-1')
      // Timer should have been cancelled
      assert.equal(normalizer._deltaFlushTimer, null)
    })

    it('destroy cleans up timer and buffer', () => {
      normalizer.bufferDelta('sess-1', 'msg-1', 'x')
      normalizer.destroy()
      assert.equal(normalizer._deltaBuffer.size, 0)
      assert.equal(normalizer._deltaFlushTimer, null)
    })
  })
})

// ---- registerEventType() ----

describe('registerEventType()', () => {
  let normalizer

  beforeEach(() => {
    normalizer = new EventNormalizer({ flushIntervalMs: 10 })
  })

  afterEach(() => {
    normalizer.destroy()
    // Remove any test-registered event types from the shared map
    delete EVENT_MAP['test_custom_event']
    delete EVENT_MAP['provider_status']
  })

  it('registers a new event type and normalize() returns its result', () => {
    normalizer.registerEventType('test_custom_event', (data) => ({
      messages: [{ msg: { type: 'custom_ws_msg', payload: data.payload } }],
    }))

    const result = normalizer.normalize('test_custom_event', { payload: 42 }, makeCtx())
    assert.ok(result)
    assert.equal(result.messages[0].msg.type, 'custom_ws_msg')
    assert.equal(result.messages[0].msg.payload, 42)
  })

  it('overwrites an existing registration for the same event name', () => {
    normalizer.registerEventType('test_custom_event', () => ({
      messages: [{ msg: { type: 'first' } }],
    }))
    normalizer.registerEventType('test_custom_event', () => ({
      messages: [{ msg: { type: 'second' } }],
    }))

    const result = normalizer.normalize('test_custom_event', {}, makeCtx())
    assert.equal(result.messages[0].msg.type, 'second')
  })

  it('throws when name is not a non-empty string', () => {
    assert.throws(() => normalizer.registerEventType('', () => {}), /non-empty string/)
    assert.throws(() => normalizer.registerEventType(null, () => {}), /non-empty string/)
    assert.throws(() => normalizer.registerEventType(42, () => {}), /non-empty string/)
  })

  it('throws when handler is not a function', () => {
    assert.throws(() => normalizer.registerEventType('provider_status', 'not-a-fn'), /function/)
    assert.throws(() => normalizer.registerEventType('provider_status', null), /function/)
  })

  it('registered handler receives data and ctx correctly', () => {
    let capturedData = null
    let capturedCtx = null
    normalizer.registerEventType('provider_status', (data, ctx) => {
      capturedData = data
      capturedCtx = ctx
      return { messages: [{ msg: { type: 'provider_status_update' } }] }
    })

    const ctx = makeCtx()
    normalizer.normalize('provider_status', { status: 'online' }, ctx)
    assert.deepEqual(capturedData, { status: 'online' })
    assert.equal(capturedCtx.sessionId, 'sess-1')
  })
})

// ---- EVENT_MAP completeness ----

describe('EVENT_MAP', () => {
  it('has handlers for all expected events', () => {
    const expectedEvents = [
      'ready', 'conversation_id', 'stream_start', 'stream_delta', 'stream_end',
      'message', 'tool_start', 'tool_result', 'agent_spawned', 'agent_completed',
      'mcp_servers', 'plan_started', 'plan_ready', 'result',
      'user_question', 'permission_request', 'error',
    ]
    for (const event of expectedEvents) {
      assert.ok(EVENT_MAP[event], `EVENT_MAP missing handler for '${event}'`)
      assert.equal(typeof EVENT_MAP[event], 'function')
    }
  })

  it('all handlers return an object with messages array', () => {
    const ctx = makeCtx()
    const testData = {
      ready: {},
      conversation_id: { conversationId: 'c1' },
      stream_start: { messageId: 'm1' },
      stream_delta: { messageId: 'm1', delta: 'x' },
      stream_end: { messageId: 'm1' },
      message: { type: 'response', content: 'hi', timestamp: 1 },
      tool_start: { messageId: 'm1', toolUseId: 'tu1', tool: 'Read', input: '/' },
      tool_result: { toolUseId: 'tu1', result: 'ok', truncated: false },
      agent_spawned: { toolUseId: 'tu1', description: 'd', startedAt: 1 },
      agent_completed: { toolUseId: 'tu1' },
      mcp_servers: { servers: [{ name: 'fs', status: 'connected' }] },
      plan_started: {},
      plan_ready: { allowedPrompts: [] },
      result: { cost: 0, duration: 0, usage: {} },
      user_question: { toolUseId: 'tu1', questions: [] },
      permission_request: { requestId: 'r1', tool: 'Bash', description: 'd', input: 'i', remainingMs: 60000 },
      error: { message: 'err' },
    }
    for (const [event, data] of Object.entries(testData)) {
      const result = EVENT_MAP[event](data, ctx)
      assert.ok(result, `Handler for '${event}' returned falsy`)
      assert.ok(Array.isArray(result.messages), `Handler for '${event}' did not return messages array`)
      assert.ok(result.messages.length > 0, `Handler for '${event}' returned empty messages`)
    }
  })
})
