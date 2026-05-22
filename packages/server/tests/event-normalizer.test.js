import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventNormalizer, EVENT_MAP } from '../src/event-normalizer.js'
import { ServerSkillChangedSchema } from '@chroxy/protocol'

// -- Helper to create a standard multi-session context --
function makeCtx(overrides = {}) {
  return {
    sessionId: 'sess-1',
    mode: 'multi',
    getSessionEntry: () => ({
      session: { model: 'claude-sonnet-4-6', permissionMode: 'approve' },
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

  // ---- EVENT_MAP: session_usage (#4072) ----

  describe('session_usage event', () => {
    it('forwards cumulativeUsage on the wire payload', () => {
      const usage = { inputTokens: 17, outputTokens: 23, cacheReadTokens: 5, cacheCreationTokens: 2, costUsd: 0.00198, turnsBilled: 2 }
      const result = normalizer.normalize('session_usage', { cumulativeUsage: usage }, makeCtx())
      assert.equal(result.messages.length, 1)
      assert.equal(result.messages[0].msg.type, 'session_usage')
      assert.deepEqual(result.messages[0].msg.cumulativeUsage, usage)
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

    // #3687: when the user didn't specify a model, session.model is null
    // but the underlying CLI booted with SOMETHING. The init event carries
    // that real model in data.model — normalizer must surface it instead
    // of reporting `null` to the dashboard.
    it('reports data.model when session.model is null (no user override)', () => {
      const ctx = makeCtx({
        getSessionEntry: () => ({
          session: { model: null, bootedModel: null, permissionMode: 'approve' },
          name: 'Test',
          cwd: '/tmp',
        }),
      })
      const result = normalizer.normalize('ready', { model: 'claude-opus-4-7' }, ctx)
      assert.equal(result.messages[1].msg.type, 'model_changed')
      assert.equal(result.messages[1].msg.model, 'opus')
    })

    it('prefers data.model over session.model when both are set', () => {
      const ctx = makeCtx({
        getSessionEntry: () => ({
          session: { model: 'claude-sonnet-4-6', bootedModel: null, permissionMode: 'approve' },
          name: 'Test',
          cwd: '/tmp',
        }),
      })
      const result = normalizer.normalize('ready', { model: 'claude-opus-4-7' }, ctx)
      assert.equal(result.messages[1].msg.model, 'opus')
    })

    it('falls back to bootedModel when data.model is missing (early ready emit)', () => {
      const ctx = makeCtx({
        getSessionEntry: () => ({
          session: { model: null, bootedModel: 'claude-opus-4-7', permissionMode: 'approve' },
          name: 'Test',
          cwd: '/tmp',
        }),
      })
      const result = normalizer.normalize('ready', {}, ctx)
      assert.equal(result.messages[1].msg.model, 'opus')
    })

    it('falls back to session.model when neither data.model nor bootedModel is set', () => {
      const ctx = makeCtx({
        getSessionEntry: () => ({
          session: { model: 'claude-sonnet-4-6', bootedModel: null, permissionMode: 'approve' },
          name: 'Test',
          cwd: '/tmp',
        }),
      })
      const result = normalizer.normalize('ready', {}, ctx)
      assert.equal(result.messages[1].msg.model, 'sonnet')
    })

    // #3687 / Copilot review: when the user has set an explicit override
    // AND a previous boot has populated bootedModel, the override must
    // win — bootedModel can be stale (SdkSession doesn't restart on
    // setModel) so reporting bootedModel here would mask the user's
    // intent. data.model is missing in this scenario (replay path /
    // sendSessionInfo equivalent / non-init re-emit).
    it('prefers session.model over bootedModel when both are set and data.model is missing', () => {
      const ctx = makeCtx({
        getSessionEntry: () => ({
          session: { model: 'claude-opus-4-7', bootedModel: 'claude-sonnet-4-6', permissionMode: 'approve' },
          name: 'Test',
          cwd: '/tmp',
        }),
      })
      const result = normalizer.normalize('ready', {}, ctx)
      assert.equal(result.messages[1].msg.model, 'opus')
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

  // ---- EVENT_MAP: inactivity_warning (#3899) ----

  describe('inactivity_warning event', () => {
    it('forwards messageId, idleMs, and prefab to the WS payload', () => {
      const data = { messageId: 'm-7', idleMs: 1_800_000, prefab: 'Status update?' }
      const result = normalizer.normalize('inactivity_warning', data, makeCtx())
      assert.equal(result.messages.length, 1)
      assert.deepEqual(result.messages[0].msg, {
        type: 'inactivity_warning',
        messageId: 'm-7',
        idleMs: 1_800_000,
        prefab: 'Status update?',
      })
    })

    it('does not emit agent_idle / result (session stays alive)', () => {
      const data = { messageId: 'm-7', idleMs: 30_000, prefab: 'Status update?' }
      const result = normalizer.normalize('inactivity_warning', data, makeCtx())
      const types = result.messages.map((m) => m.msg.type)
      assert.deepEqual(types, ['inactivity_warning'])
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

  // ---- EVENT_MAP: permission_resolved (#3048) ----

  describe('permission_resolved event', () => {
    it('emits broadcast message with requestId, decision, and ctx.sessionId', () => {
      const data = { requestId: 'req-1', decision: 'allow', reason: 'user' }
      const result = normalizer.normalize('permission_resolved', data, makeCtx({ sessionId: 'sess-7' }))
      assert.equal(result.messages.length, 1)
      assert.deepStrictEqual(result.messages[0].msg, {
        type: 'permission_resolved',
        requestId: 'req-1',
        decision: 'allow',
        sessionId: 'sess-7',
      })
      // Filter must be undefined so all clients (including the resolver) receive it
      assert.equal(result.messages[0].filter, undefined)
    })

    it('forwards deny decision from auto-deny paths (timeout/abort/cleared)', () => {
      const data = { requestId: 'req-2', decision: 'deny', reason: 'timeout' }
      const result = normalizer.normalize('permission_resolved', data, makeCtx({ sessionId: 'sess-7' }))
      assert.equal(result.messages[0].msg.decision, 'deny')
    })
  })

  // ---- EVENT_MAP: skill_changed (#3234) ----

  describe('skill_changed event', () => {
    it('maps loader payload to wire shape with 8-char hash prefixes', () => {
      const data = {
        name: 'coding-style',
        oldHash: 'abcdef0123456789' + '0'.repeat(48),
        newHash: '0123456789abcdef' + '0'.repeat(48),
        blocked: false,
        mode: 'warn',
      }
      const result = normalizer.normalize('skill_changed', data, makeCtx({ sessionId: 'sess-42' }))
      const msg = result.messages[0].msg
      assert.equal(msg.type, 'skill_changed')
      assert.equal(msg.skillName, 'coding-style')
      assert.equal(msg.sessionId, 'sess-42')
      assert.equal(msg.oldHashPrefix, 'abcdef01')
      assert.equal(msg.newHashPrefix, '01234567')
      assert.equal(msg.mode, 'warn')

      // #3239: end-to-end shape — the normaliser's output must validate
      // against the wire schema. A regression that drops a required field
      // (oldHash, newHash, etc.) silently emits an empty prefix today;
      // schema round-trip catches it before the dashboard does.
      const validation = ServerSkillChangedSchema.safeParse(msg)
      assert.ok(
        validation.success,
        `EventNormalizer output must validate against ServerSkillChangedSchema: ${JSON.stringify(validation.error?.issues)}`,
      )
    })

    it('reports mode = "block" when payload mode = "block"', () => {
      const data = {
        name: 'coding-style',
        oldHash: 'a'.repeat(64),
        newHash: 'b'.repeat(64),
        blocked: true,
        mode: 'block',
      }
      const result = normalizer.normalize('skill_changed', data, makeCtx({ sessionId: 's1' }))
      const msg = result.messages[0].msg
      assert.equal(msg.mode, 'block')
      assert.ok(ServerSkillChangedSchema.safeParse(msg).success)
    })

    it('emits null sessionId for legacy single-CLI mode', () => {
      const data = {
        name: 'x',
        oldHash: 'a'.repeat(64),
        newHash: 'b'.repeat(64),
        blocked: false,
        mode: 'warn',
      }
      const result = normalizer.normalize('skill_changed', data, makeCtx({ sessionId: null }))
      const msg = result.messages[0].msg
      assert.equal(msg.sessionId, null)
      assert.ok(ServerSkillChangedSchema.safeParse(msg).success)
    })

    // #3241: explicit mode wins over derived mode. A future trust mode
    // ('block-once', 'soft-block', etc.) could set blocked=true while the
    // operator-facing mode is still 'warn' — the wire signal must reflect
    // the operator config, not the consequence.
    it('prefers explicit mode field over deriving from blocked', () => {
      const data = {
        name: 'x',
        oldHash: 'a'.repeat(64),
        newHash: 'b'.repeat(64),
        blocked: true,
        mode: 'warn',
      }
      const result = normalizer.normalize('skill_changed', data, makeCtx({ sessionId: 's1' }))
      assert.equal(result.messages[0].msg.mode, 'warn')
    })

    // Defensive fallback for older callers that don't carry the explicit
    // mode field — derive from blocked the same way the original handler
    // did. Keeps the component back-compatible in the (unlikely) case
    // someone synthesises a skill_changed event from outside the loader.
    it('falls back to deriving from blocked when mode is absent', () => {
      const data = {
        name: 'x',
        oldHash: 'a'.repeat(64),
        newHash: 'b'.repeat(64),
        blocked: true,
      }
      const result = normalizer.normalize('skill_changed', data, makeCtx({ sessionId: 's1' }))
      assert.equal(result.messages[0].msg.mode, 'block')
    })

    // Defensive against unexpected mode values (typo, future enum value
    // from a newer server build talking to an older normaliser, etc.):
    // ignore the bogus mode and fall back to deriving from blocked. The
    // wire schema only accepts 'warn' | 'block' — emitting anything else
    // would fail validation downstream.
    it('ignores unknown mode strings and falls back to derive', () => {
      const data = {
        name: 'x',
        oldHash: 'a'.repeat(64),
        newHash: 'b'.repeat(64),
        blocked: false,
        mode: 'soft-block',
      }
      const result = normalizer.normalize('skill_changed', data, makeCtx({ sessionId: 's1' }))
      assert.equal(result.messages[0].msg.mode, 'warn')
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

    it('forwards error code when present', () => {
      const data = { code: 'docker_not_running', message: 'Docker is not running.' }
      const result = normalizer.normalize('error', data, makeCtx())
      assert.equal(result.messages[0].msg.code, 'docker_not_running')
      assert.equal(result.messages[0].msg.messageType, 'error')
    })

    it('omits code field when not present in error data', () => {
      const data = { message: 'Generic error' }
      const result = normalizer.normalize('error', data, makeCtx())
      assert.equal(result.messages[0].msg.code, undefined)
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

// ---- EVENT_MAP: stdin_dropped_totals (#3544) ----

describe('stdin_dropped_totals event', () => {
  let normalizer

  beforeEach(() => {
    normalizer = new EventNormalizer({ flushIntervalMs: 10 })
  })

  afterEach(() => {
    normalizer.destroy()
  })

  it('maps the SdkSession event to a wire-shape stdin_dropped_totals message', () => {
    const data = {
      bytes: 350,
      count: 2,
      reason: 'pre-dial-cap',
      escalated: true,
    }
    const result = normalizer.normalize('stdin_dropped_totals', data, makeCtx({ sessionId: 'sess-1' }))
    assert.ok(result, 'normalizer must return a result')
    const msg = result.messages[0].msg
    assert.equal(msg.type, 'stdin_dropped_totals')
    assert.equal(msg.sessionId, 'sess-1')
    assert.equal(msg.bytes, 350)
    assert.equal(msg.count, 2)
    assert.equal(msg.reason, 'pre-dial-cap')
    assert.equal(msg.escalated, true)
  })

  it('emits null sessionId for legacy single-CLI mode', () => {
    const data = { bytes: 1, count: 1, reason: 'pre-dial-cap', escalated: true }
    const result = normalizer.normalize('stdin_dropped_totals', data, makeCtx({ sessionId: null }))
    const msg = result.messages[0].msg
    assert.equal(msg.sessionId, null)
  })

  it('preserves escalated=false for warn-level totals', () => {
    const data = { bytes: 200, count: 4, reason: 'pre-dial-cap', escalated: false }
    const result = normalizer.normalize('stdin_dropped_totals', data, makeCtx({ sessionId: 's1' }))
    assert.equal(result.messages[0].msg.escalated, false)
  })

  it('falls back to "unknown" when reason is missing', () => {
    const data = { bytes: 50, count: 1, escalated: true }
    const result = normalizer.normalize('stdin_dropped_totals', data, makeCtx({ sessionId: 's1' }))
    assert.equal(result.messages[0].msg.reason, 'unknown')
  })

  it('clamps negative bytes to 0 (#3579)', () => {
    const data = { bytes: -50, count: 1, reason: 'pre-dial-cap', escalated: true }
    const result = normalizer.normalize('stdin_dropped_totals', data, makeCtx({ sessionId: 's1' }))
    assert.equal(result.messages[0].msg.bytes, 0)
  })

  it('clamps negative count to 0 (#3579)', () => {
    const data = { bytes: 100, count: -3, reason: 'pre-dial-cap', escalated: true }
    const result = normalizer.normalize('stdin_dropped_totals', data, makeCtx({ sessionId: 's1' }))
    assert.equal(result.messages[0].msg.count, 0)
  })

  it('truncates float bytes to integer (#3579)', () => {
    const data = { bytes: 350.7, count: 1, reason: 'pre-dial-cap', escalated: true }
    const result = normalizer.normalize('stdin_dropped_totals', data, makeCtx({ sessionId: 's1' }))
    assert.equal(result.messages[0].msg.bytes, 350)
    assert.equal(Number.isInteger(result.messages[0].msg.bytes), true)
  })

  it('truncates float count to integer (#3579)', () => {
    const data = { bytes: 100, count: 2.9, reason: 'pre-dial-cap', escalated: true }
    const result = normalizer.normalize('stdin_dropped_totals', data, makeCtx({ sessionId: 's1' }))
    assert.equal(result.messages[0].msg.count, 2)
    assert.equal(Number.isInteger(result.messages[0].msg.count), true)
  })

  it('coerces string "false" escalated to false via strict bool check (#3579)', () => {
    const data = { bytes: 100, count: 1, reason: 'pre-dial-cap', escalated: 'false' }
    const result = normalizer.normalize('stdin_dropped_totals', data, makeCtx({ sessionId: 's1' }))
    assert.equal(result.messages[0].msg.escalated, false)
  })

  it('coerces non-boolean truthy escalated to false via strict bool check (#3579)', () => {
    const data = { bytes: 100, count: 1, reason: 'pre-dial-cap', escalated: 1 }
    const result = normalizer.normalize('stdin_dropped_totals', data, makeCtx({ sessionId: 's1' }))
    assert.equal(result.messages[0].msg.escalated, false)
  })

  it('preserves empty-string sessionId via nullish coalesce (#3579)', () => {
    const data = { bytes: 100, count: 1, reason: 'pre-dial-cap', escalated: true }
    const result = normalizer.normalize('stdin_dropped_totals', data, makeCtx({ sessionId: '' }))
    assert.equal(result.messages[0].msg.sessionId, '')
  })
})

// ---- EVENT_MAP completeness ----

describe('EVENT_MAP', () => {
  it('has handlers for all expected events', () => {
    const expectedEvents = [
      'ready', 'conversation_id', 'stream_start', 'stream_delta', 'stream_end',
      'message', 'tool_start', 'tool_result', 'agent_spawned', 'agent_completed',
      'mcp_servers', 'plan_started', 'plan_ready', 'inactivity_warning', 'result',
      'user_question', 'permission_request', 'error', 'skill_changed',
      'stdin_dropped_totals',
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
      inactivity_warning: { messageId: 'm1', idleMs: 30_000, prefab: 'Status update?' },
      result: { cost: 0, duration: 0, usage: {} },
      cost_update: { sessionCost: 0.05, totalCost: 0.5, budget: 1.0 },
      session_usage: { cumulativeUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.001, turnsBilled: 1 } },
      user_question: { toolUseId: 'tu1', questions: [] },
      permission_request: { requestId: 'r1', tool: 'Bash', description: 'd', input: 'i', remainingMs: 60000 },
      error: { message: 'err' },
      skill_changed: { name: 'coding-style', oldHash: 'a'.repeat(64), newHash: 'b'.repeat(64), blocked: false },
      stdin_dropped_totals: { bytes: 100, count: 1, reason: 'pre-dial-cap', escalated: true },
    }
    for (const [event, data] of Object.entries(testData)) {
      const result = EVENT_MAP[event](data, ctx)
      assert.ok(result, `Handler for '${event}' returned falsy`)
      assert.ok(Array.isArray(result.messages), `Handler for '${event}' did not return messages array`)
      assert.ok(result.messages.length > 0, `Handler for '${event}' returned empty messages`)
    }
  })
})
