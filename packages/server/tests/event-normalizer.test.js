import { describe, it, beforeEach, afterEach, mock } from 'node:test'
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

  // ---- EVENT_MAP: result contextUsage passthrough (#6769) ----

  describe('result event occupancy snapshot (#6769)', () => {
    it('forwards contextOccupancy to the wire when the session emitted one', () => {
      const contextOccupancy = {
        totalTokens: 110_000,
        maxTokens: 200_000,
        autoCompactThreshold: 167_000,
        isAutoCompactEnabled: true,
        source: 'context-usage-api',
      }
      const result = normalizer.normalize(
        'result',
        { cost: 0.01, duration: 5, usage: { input_tokens: 1 }, sessionId: 'sess-1', contextOccupancy },
        makeCtx(),
      )
      const resultMsg = result.messages.find((m) => m.msg.type === 'result')
      assert.deepEqual(resultMsg.msg.contextOccupancy, contextOccupancy)
    })

    it('omits contextOccupancy from the wire when the session did not emit one', () => {
      const result = normalizer.normalize(
        'result',
        { cost: 0.01, duration: 5, usage: { input_tokens: 1 }, sessionId: 'sess-1' },
        makeCtx(),
      )
      const resultMsg = result.messages.find((m) => m.msg.type === 'result')
      assert.equal('contextOccupancy' in resultMsg.msg, false,
        'no-signal providers keep the field off the wire (clients render dash)')
    })
  })

  // ---- EVENT_MAP: result queueLength passthrough (#6819) ----

  describe('result event queueLength passthrough (#6819)', () => {
    it('forwards a finite queueLength to the wire (base-session #6627/#6706 stamp)', () => {
      const result = normalizer.normalize(
        'result',
        { cost: 0.01, duration: 5, usage: { input_tokens: 1 }, sessionId: 'sess-1', queueLength: 2 },
        makeCtx(),
      )
      const resultMsg = result.messages.find((m) => m.msg.type === 'result')
      assert.equal(resultMsg.msg.queueLength, 2)
    })

    it('forwards a zero queueLength (finite, not truthy — must not be treated as absent)', () => {
      const result = normalizer.normalize(
        'result',
        { cost: 0.01, duration: 5, usage: { input_tokens: 1 }, sessionId: 'sess-1', queueLength: 0 },
        makeCtx(),
      )
      const resultMsg = result.messages.find((m) => m.msg.type === 'result')
      assert.equal(resultMsg.msg.queueLength, 0)
    })

    it('omits queueLength from the wire when the session did not stamp one (older/non-finite)', () => {
      const result = normalizer.normalize(
        'result',
        { cost: 0.01, duration: 5, usage: { input_tokens: 1 }, sessionId: 'sess-1' },
        makeCtx(),
      )
      const resultMsg = result.messages.find((m) => m.msg.type === 'result')
      assert.equal('queueLength' in resultMsg.msg, false,
        'absent/non-finite queueLength stays off the wire so clients take the no-op reconcile path')
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

    // #5431 — enriched ready: a session exposing getBackgroundTaskSnapshot()
    // gets its outstanding work attached; a computed-but-empty snapshot still
    // emits backgroundTasks: [] (the authoritative clear — a task-notification
    // that landed mid-turn must not strand a stale client indicator); sessions
    // without the method (or a throwing one) stay byte-identical plain ready.
    it('attaches backgroundTasks + scheduledWakeup from the session snapshot (#5431)', () => {
      const task = { toolUseId: 'toolu_01', kind: 'bash', description: 'Wait for CI', startedAt: 1781068000000 }
      const wakeup = { at: 1781068600000, reason: 'watching CI' }
      const ctx = makeCtx({
        getSessionEntry: () => ({
          session: {
            model: 'claude-sonnet-4-6',
            permissionMode: 'approve',
            getBackgroundTaskSnapshot: () => ({ backgroundTasks: [task], scheduledWakeup: wakeup }),
          },
        }),
      })
      const result = normalizer.normalize('ready', {}, ctx)
      assert.equal(result.messages[0].msg.type, 'claude_ready')
      assert.deepEqual(result.messages[0].msg.backgroundTasks, [task])
      assert.deepEqual(result.messages[0].msg.scheduledWakeup, wakeup)
    })

    it('emits an explicit empty backgroundTasks for a computed empty snapshot (#5431)', () => {
      const ctx = makeCtx({
        getSessionEntry: () => ({
          session: {
            model: 'claude-sonnet-4-6',
            permissionMode: 'approve',
            getBackgroundTaskSnapshot: () => ({ backgroundTasks: [], scheduledWakeup: null }),
          },
        }),
      })
      const result = normalizer.normalize('ready', {}, ctx)
      assert.deepEqual(result.messages[0].msg.backgroundTasks, [])
      assert.equal('scheduledWakeup' in result.messages[0].msg, false)
    })

    it('omits the fields entirely when the session has no snapshot method (#5431)', () => {
      const result = normalizer.normalize('ready', {}, makeCtx())
      assert.equal('backgroundTasks' in result.messages[0].msg, false)
      assert.equal('scheduledWakeup' in result.messages[0].msg, false)
    })

    it('omits the fields and stays plain when the snapshot getter throws (#5431)', () => {
      const ctx = makeCtx({
        getSessionEntry: () => ({
          session: {
            model: 'claude-sonnet-4-6',
            permissionMode: 'approve',
            getBackgroundTaskSnapshot: () => { throw new Error('boom') },
          },
        }),
      })
      const result = normalizer.normalize('ready', {}, ctx)
      assert.equal(result.messages[0].msg.type, 'claude_ready')
      assert.equal('backgroundTasks' in result.messages[0].msg, false)
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
      const result = normalizer.normalize('ready', { model: 'claude-opus-4-8' }, ctx)
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
      const result = normalizer.normalize('ready', { model: 'claude-opus-4-8' }, ctx)
      assert.equal(result.messages[1].msg.model, 'opus')
    })

    it('falls back to bootedModel when data.model is missing (early ready emit)', () => {
      const ctx = makeCtx({
        getSessionEntry: () => ({
          session: { model: null, bootedModel: 'claude-opus-4-8', permissionMode: 'approve' },
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
          session: { model: 'claude-opus-4-8', bootedModel: 'claude-sonnet-4-6', permissionMode: 'approve' },
          name: 'Test',
          cwd: '/tmp',
        }),
      })
      const result = normalizer.normalize('ready', {}, ctx)
      assert.equal(result.messages[1].msg.model, 'opus')
    })
  })

  // ---- EVENT_MAP: conversation_id ----

  // ---- EVENT_MAP: background_tasks_changed (#5431) ----

  describe('background_tasks_changed event', () => {
    it('re-emits claude_ready with the fresh snapshot', () => {
      const task = { toolUseId: 'toolu_02', kind: 'monitor', description: 'tail log', startedAt: 5 }
      const result = normalizer.normalize(
        'background_tasks_changed',
        { backgroundTasks: [task], scheduledWakeup: { at: 9, reason: 'r' } },
        makeCtx()
      )
      assert.equal(result.messages.length, 1)
      assert.equal(result.messages[0].msg.type, 'claude_ready')
      assert.deepEqual(result.messages[0].msg.backgroundTasks, [task])
      assert.deepEqual(result.messages[0].msg.scheduledWakeup, { at: 9, reason: 'r' })
    })

    it('emits the explicit empty-array clear when work drains', () => {
      const result = normalizer.normalize('background_tasks_changed', { backgroundTasks: [], scheduledWakeup: null }, makeCtx())
      assert.deepEqual(result.messages[0].msg.backgroundTasks, [])
      assert.equal('scheduledWakeup' in result.messages[0].msg, false)
    })
  })

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

    // #6756 — a thinking stream_start carries the flag and skips the
    // agent_busy / session_list churn.
    it('tags thinking:true and omits agent_busy / session_list', () => {
      const result = normalizer.normalize('stream_start', { messageId: 'msg-1-thinking-0', thinking: true }, makeCtx())
      assert.equal(result.messages.length, 1)
      assert.equal(result.messages[0].msg.type, 'stream_start')
      assert.equal(result.messages[0].msg.thinking, true)
      assert.ok(!result.sideEffects, 'no session_list churn per thinking block')
    })
  })

  // ---- EVENT_MAP: stream_delta ----

  describe('stream_delta event', () => {
    it('returns buffer flag', () => {
      const result = normalizer.normalize('stream_delta', { messageId: 'msg-1', delta: 'hello' }, makeCtx())
      assert.equal(result.buffer, true)
      assert.equal(result.messages[0].msg.delta, 'hello')
    })

    // #6756 — thinking deltas broadcast immediately (no buffering) with the flag
    // intact; the coalescing buffer can't carry the flag.
    it('thinking delta is NOT buffered and carries thinking:true', () => {
      const result = normalizer.normalize('stream_delta', { messageId: 'msg-1-thinking-0', delta: 'reason', thinking: true }, makeCtx())
      assert.ok(!result.buffer, 'thinking deltas bypass the coalescing buffer')
      assert.equal(result.messages[0].msg.type, 'stream_delta')
      assert.equal(result.messages[0].msg.delta, 'reason')
      assert.equal(result.messages[0].msg.thinking, true)
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

    // #6756 — a thinking stream_end carries the flag and does NOT flush the
    // response-text buffer.
    it('tags thinking:true and omits flush_deltas', () => {
      const result = normalizer.normalize('stream_end', { messageId: 'msg-1-thinking-0', thinking: true }, makeCtx())
      assert.equal(result.messages[0].msg.type, 'stream_end')
      assert.equal(result.messages[0].msg.thinking, true)
      assert.ok(!result.sideEffects, 'thinking end does not flush the text buffer')
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

    it('forwards isError onto the wire so a failed result round-trips (#6712)', () => {
      const data = { toolUseId: 'tu1', result: 'connection refused', truncated: false, isError: true }
      const msg = normalizer.normalize('tool_result', data, makeCtx()).messages[0].msg
      assert.equal(msg.isError, true)
    })

    it('omits isError when not a boolean (successful/legacy results carry no flag)', () => {
      const msg = normalizer.normalize('tool_result', { toolUseId: 'tu1', result: 'ok', truncated: false }, makeCtx()).messages[0].msg
      assert.equal('isError' in msg, false)
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

  describe('agent_event event (#5016 / #5056)', () => {
    it('maps a relayed child wire event to the agent_event message', () => {
      const data = {
        parentToolUseId: 'tu_task',
        type: 'tool_start',
        payload: { toolUseId: 'tu_child', tool: 'Read' },
      }
      const result = normalizer.normalize('agent_event', data, makeCtx())
      assert.equal(result.messages[0].msg.type, 'agent_event')
      assert.equal(result.messages[0].msg.parentToolUseId, 'tu_task')
      assert.equal(result.messages[0].msg.eventType, 'tool_start')
      assert.deepEqual(result.messages[0].msg.payload, { toolUseId: 'tu_child', tool: 'Read' })
      // Non-permission events must NOT register a permissionSessionMap entry.
      assert.equal(result.registrations, undefined)
    })

    it('#5056: a relayed permission_request registers the requestId to the PARENT session id', () => {
      const data = {
        parentToolUseId: 'tu_task',
        type: 'permission_request',
        payload: { requestId: 'perm-child-1', tool: 'mcp__foo__bar', input: { x: 1 } },
      }
      const result = normalizer.normalize('agent_event', data, makeCtx())
      // Bound dashboard clients respond on the parent session, so the map
      // entry MUST point requestId -> parent session id (ctx.sessionId).
      assert.deepEqual(result.registrations, [
        { map: 'permission', key: 'perm-child-1', value: 'sess-1' },
      ])
    })

    it('#5056: a relayed permission_resolved emits the matching delete registration', () => {
      const data = {
        parentToolUseId: 'tu_task',
        type: 'permission_resolved',
        payload: { requestId: 'perm-child-1', decision: 'allow' },
      }
      const result = normalizer.normalize('agent_event', data, makeCtx())
      assert.deepEqual(result.registrations, [
        { map: 'permission', key: 'perm-child-1', action: 'delete' },
      ])
    })

    it('#5056: a relayed permission_request without a requestId registers nothing', () => {
      const data = {
        parentToolUseId: 'tu_task',
        type: 'permission_request',
        payload: {},
      }
      const result = normalizer.normalize('agent_event', data, makeCtx())
      assert.equal(result.registrations, undefined)
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

  // ---- EVENT_MAP: multi_question_intervention (#4653) ----

  describe('multi_question_intervention event', () => {
    it('forwards toolUseId, questionCount, reason and timestamp to the WS payload', () => {
      const data = {
        toolUseId: 'toolu_norm',
        questionCount: 4,
        reason: 'multi_question',
        timestamp: 1700000000000,
      }
      const result = normalizer.normalize('multi_question_intervention', data, makeCtx())
      assert.equal(result.messages.length, 1)
      assert.deepEqual(result.messages[0].msg, {
        type: 'multi_question_intervention',
        toolUseId: 'toolu_norm',
        questionCount: 4,
        reason: 'multi_question',
        timestamp: 1700000000000,
      })
    })

    it('does not emit any sibling messages (session stays alive — no agent_idle/result)', () => {
      const data = { toolUseId: 't', questionCount: 2, reason: 'multi_question', timestamp: 1 }
      const result = normalizer.normalize('multi_question_intervention', data, makeCtx())
      const types = result.messages.map((m) => m.msg.type)
      assert.deepEqual(types, ['multi_question_intervention'])
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

  // ---- EVENT_MAP: stopped (#4756) ----
  //
  // CliSession emits `stopped` after a clean user-initiated SIGINT exit
  // (cli-session.js `_handleChildClose` gated on `_intentionalStop`). The
  // normalizer translates it into `session_stopped` so paired clients can
  // render a quiet confirmation distinct from the louder `session_error`
  // crash toast.

  describe('stopped event (#4756)', () => {
    it('maps to a session_stopped wire message in multi mode', () => {
      const result = normalizer.normalize('stopped', { code: 0 }, makeCtx())
      assert.equal(result.messages.length, 1)
      const msg = result.messages[0].msg
      assert.equal(msg.type, 'session_stopped')
      assert.equal(msg.sessionId, 'sess-1')
      assert.equal(msg.code, 0)
    })

    it('forwards the numeric exit code on the wire', () => {
      // SIGTERM = 143; clients should see the raw code for non-zero exits
      // so they can render a diagnostic detail line.
      const result = normalizer.normalize('stopped', { code: 143 }, makeCtx())
      assert.equal(result.messages[0].msg.code, 143)
    })

    it('omits sessionId in legacy-cli mode (ctx.sessionId is null)', () => {
      const ctx = makeCtx({ sessionId: null, mode: 'legacy-cli' })
      const result = normalizer.normalize('stopped', { code: 0 }, ctx)
      const msg = result.messages[0].msg
      assert.equal(msg.type, 'session_stopped')
      // Do not emit `sessionId: null` — let the receiver treat absence as
      // "applies to the connected legacy CLI". Matches the `error` /
      // `claude_ready` legacy-cli convention.
      assert.ok(!('sessionId' in msg), 'sessionId should be absent in legacy-cli mode')
      assert.equal(msg.code, 0)
    })

    it('omits code when data is missing or non-numeric', () => {
      // Defensive: future providers that adopt `stopped` for parity may
      // not carry an exit code (e.g. in-process SDK session). Schema
      // marks `code` optional.
      const result = normalizer.normalize('stopped', {}, makeCtx())
      const msg = result.messages[0].msg
      assert.equal(msg.type, 'session_stopped')
      assert.equal(msg.sessionId, 'sess-1')
      assert.ok(!('code' in msg), 'code should be omitted when not numeric')
    })

    it('emits no side effects or registrations (informational only)', () => {
      const result = normalizer.normalize('stopped', { code: 0 }, makeCtx())
      assert.equal(result.sideEffects, undefined)
      assert.equal(result.registrations, undefined)
    })

    // Per Copilot review on #4868: the protocol schema is z.number().int(),
    // so the normalizer must reject non-integer numbers (floats, NaN,
    // Infinity) to prevent client-side schema-validation failures. Bare
    // `typeof === 'number'` would let any of these through.
    it('omits code when data.code is a float, NaN, or Infinity', () => {
      for (const badCode of [1.5, NaN, Infinity, -Infinity]) {
        const result = normalizer.normalize('stopped', { code: badCode }, makeCtx())
        const msg = result.messages[0].msg
        assert.ok(!('code' in msg), `code=${badCode} should be dropped (not a finite integer)`)
      }
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

    // #5515 (epic #5514): the buffer carries the FIRST emit monotonic time per
    // key so ws-forwarding can measure emit→broadcast (server-side coalescing).
    it('carries the first emitMonoMs per key through flushSession (#5515)', () => {
      normalizer.bufferDelta('sess-1', 'msg-1', 'Hello', 1000)
      normalizer.bufferDelta('sess-1', 'msg-1', ' World', 1005)
      const entries = normalizer.flushSession('sess-1')
      assert.equal(entries.length, 1)
      // First-write-wins: the oldest token's emit time, not the latest.
      assert.equal(entries[0].emitMonoMs, 1000)
    })

    it('emitMonoMs is undefined when not supplied (additive, #5515)', () => {
      normalizer.bufferDelta('sess-1', 'msg-1', 'Hello')
      const entries = normalizer.flushSession('sess-1')
      assert.equal(entries[0].emitMonoMs, undefined)
    })

    it('does not leak emitMonoMs across flush windows for the same key (#5515)', () => {
      normalizer.bufferDelta('sess-1', 'msg-1', 'A', 1000)
      normalizer.flushSession('sess-1')
      // New window for the same key: a fresh emit time should win.
      normalizer.bufferDelta('sess-1', 'msg-1', 'B', 2000)
      const entries = normalizer.flushSession('sess-1')
      assert.equal(entries[0].emitMonoMs, 2000)
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

    // #5313 (WP-1.3): the timer-driven flush invokes onFlush (a broadcast). A
    // throw there used to escape the setTimeout → uncaughtException → daemon
    // crash. The flush now contains the throw, and clears the buffer in a
    // finally so a throwing flush can't wedge the buffer for every later stream.
    it('does not propagate a throwing onFlush out of the flush timer (#5313)', async () => {
      normalizer.onFlush = () => { throw new Error('boom: broadcast failed') }

      const uncaught = []
      const onUncaught = (err) => { uncaught.push(err) }
      process.on('uncaughtException', onUncaught)
      try {
        normalizer.bufferDelta('sess-1', 'msg-1', 'hello')
        // Wait past the flush interval (10ms) for the timer to fire.
        await new Promise((resolve) => setTimeout(resolve, 40))
      } finally {
        process.removeListener('uncaughtException', onUncaught)
      }

      assert.equal(uncaught.length, 0, 'throwing onFlush must not escape the flush timer')
    })

    it('clears the delta buffer even when onFlush throws (#5313)', async () => {
      normalizer.onFlush = () => { throw new Error('boom') }
      normalizer.bufferDelta('sess-1', 'msg-1', 'hello')
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.equal(normalizer._deltaBuffer.size, 0,
        'buffer must be cleared so a throwing flush does not wedge subsequent streams')
    })

    it('stays functional after a throwing flush — a later flush still delivers (#5313)', async () => {
      let lastFlushed = null
      // First flush throws, then we swap in a good callback for the next round.
      normalizer.onFlush = () => { throw new Error('boom') }
      normalizer.bufferDelta('sess-1', 'msg-1', 'first')
      await new Promise((resolve) => setTimeout(resolve, 40))

      normalizer.onFlush = (entries) => { lastFlushed = entries }
      normalizer.bufferDelta('sess-2', 'msg-2', 'second')
      await new Promise((resolve) => setTimeout(resolve, 40))

      assert.ok(lastFlushed, 'a subsequent flush still fires after a prior throwing flush')
      assert.equal(lastFlushed.length, 1)
      assert.equal(lastFlushed[0].delta, 'second')
    })

    // ---- #5555: residency caps (per-key + total) ----
    //
    // A runaway provider can grow the un-flushed buffer faster than socket
    // backpressure can react (data hasn't reached a socket yet). The caps force
    // an immediate ORDERED flush — never truncation — bounding heap residency.
    describe('residency caps (#5555)', () => {
      it('forces an immediate flush of a key that exceeds the per-key byte cap', () => {
        const flushed = []
        // Tiny caps so the test stays cheap; the production defaults are 256KB/2MB.
        const n = new EventNormalizer({ flushIntervalMs: 10, maxKeyBytes: 100, maxTotalBytes: 10_000 })
        n.onFlush = (entries) => { flushed.push(...entries) }
        try {
          n.bufferDelta('sess-1', 'msg-1', 'a'.repeat(60)) // under cap, buffered
          assert.equal(flushed.length, 0, 'no flush before the cap is crossed')
          n.bufferDelta('sess-1', 'msg-1', 'b'.repeat(50)) // 110 >= 100 → force flush
          assert.equal(flushed.length, 1, 'crossing the per-key cap forces one flush')
          // Content preserved in order, nothing truncated.
          assert.equal(flushed[0].delta, 'a'.repeat(60) + 'b'.repeat(50))
          assert.equal(flushed[0].sessionId, 'sess-1')
          assert.equal(flushed[0].messageId, 'msg-1')
          // Key was flushed out of the buffer; counters reset for it.
          assert.equal(n._deltaBuffer.has('sess-1:msg-1'), false)
          assert.equal(n._deltaTotalBytes, 0)
        } finally {
          n.destroy()
        }
      })

      it('preserves order: post-flush deltas re-buffer behind the flushed chunk', () => {
        const flushed = []
        const n = new EventNormalizer({ flushIntervalMs: 10, maxKeyBytes: 100, maxTotalBytes: 10_000 })
        n.onFlush = (entries) => { flushed.push(...entries) }
        try {
          n.bufferDelta('sess-1', 'msg-1', 'x'.repeat(120)) // force-flush chunk 1
          n.bufferDelta('sess-1', 'msg-1', 'tail') // re-buffers fresh behind it
          const rest = n.flushSession('sess-1')
          assert.equal(flushed.length, 1)
          assert.equal(flushed[0].delta, 'x'.repeat(120))
          assert.equal(rest.length, 1)
          assert.equal(rest[0].delta, 'tail', 'later delta lands after the force-flushed chunk, in order')
        } finally {
          n.destroy()
        }
      })

      it('only one key under the per-key cap does not flush others', () => {
        const flushed = []
        const n = new EventNormalizer({ flushIntervalMs: 10, maxKeyBytes: 100, maxTotalBytes: 10_000 })
        n.onFlush = (entries) => { flushed.push(...entries) }
        try {
          n.bufferDelta('sess-1', 'big', 'z'.repeat(120)) // force-flush this key
          n.bufferDelta('sess-1', 'small', 'tiny') // stays buffered
          assert.equal(flushed.length, 1)
          assert.equal(flushed[0].messageId, 'big')
          assert.equal(n._deltaBuffer.has('sess-1:small'), true, 'under-cap key is untouched')
        } finally {
          n.destroy()
        }
      })

      it('forces a full flush when the aggregate total cap is exceeded', () => {
        const flushed = []
        // Per-key cap high enough that no single key trips it; total cap small
        // so the many-small-streams case is what forces the flush.
        const n = new EventNormalizer({ flushIntervalMs: 10, maxKeyBytes: 10_000, maxTotalBytes: 250 })
        n.onFlush = (entries) => { flushed.push(...entries) }
        try {
          n.bufferDelta('sess-1', 'm1', 'p'.repeat(100))
          n.bufferDelta('sess-1', 'm2', 'q'.repeat(100))
          assert.equal(flushed.length, 0, 'still under the total cap')
          n.bufferDelta('sess-1', 'm3', 'r'.repeat(100)) // 300 >= 250 → full flush
          // All three keys flushed in one pass; content intact.
          assert.equal(flushed.length, 3)
          const byKey = Object.fromEntries(flushed.map(e => [e.messageId, e.delta]))
          assert.equal(byKey.m1, 'p'.repeat(100))
          assert.equal(byKey.m2, 'q'.repeat(100))
          assert.equal(byKey.m3, 'r'.repeat(100))
          assert.equal(n._deltaBuffer.size, 0)
          assert.equal(n._deltaTotalBytes, 0)
        } finally {
          n.destroy()
        }
      })

      it('measures bytes (UTF-8), not chars — multibyte content trips the cap sooner', () => {
        const flushed = []
        const n = new EventNormalizer({ flushIntervalMs: 10, maxKeyBytes: 100, maxTotalBytes: 10_000 })
        n.onFlush = (entries) => { flushed.push(...entries) }
        try {
          // '😀' is 4 UTF-8 bytes. 30 of them = 120 bytes (only 60 UTF-16 units).
          n.bufferDelta('sess-1', 'emoji', '😀'.repeat(30))
          assert.equal(flushed.length, 1, 'byte-counted cap trips on multibyte payload')
          assert.equal(flushed[0].delta, '😀'.repeat(30), 'no truncation of multibyte content')
        } finally {
          n.destroy()
        }
      })
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

// ---- #5516 (epic #5514): adaptive single-client coalescing window ----

describe('EventNormalizer adaptive flush window (#5516)', () => {
  // Capture the delay each bufferDelta schedules its flush timer with, without
  // depending on real wall-clock timing. We spy on global.setTimeout, record
  // the requested delay, and return a dummy handle so the timer never actually
  // fires during the assertion.
  function withSetTimeoutSpy(fn) {
    const delays = []
    const orig = global.setTimeout
    mock.method(global, 'setTimeout', (cb, ms, ...rest) => {
      delays.push(ms)
      // Real handle so clearTimeout works in the reschedule path; we never let
      // it fire (orig with a huge delay would, so use a no-op handle instead).
      return orig(() => {}, 1_000_000, ...rest)
    })
    try { fn(delays) } finally { mock.restoreAll() }
  }

  // #5562: the server micro-batch window was shrunk from 25/50ms to 8/16ms so
  // it no longer stacks on the client's 16-100ms EWMA. These assert the NEW
  // contract (8ms single-subscriber / 16ms otherwise).
  it('uses the 8ms window when a session has exactly one subscriber', () => {
    const n = new EventNormalizer({ getSubscriberCount: () => 1 })
    withSetTimeoutSpy((delays) => {
      n.bufferDelta('sess-1', 'msg-1', 'hi')
      assert.equal(delays[0], 8)
    })
    n.destroy()
  })

  it('uses the default 16ms window when 2+ clients are subscribed', () => {
    const n = new EventNormalizer({ getSubscriberCount: () => 2 })
    withSetTimeoutSpy((delays) => {
      n.bufferDelta('sess-1', 'msg-1', 'hi')
      assert.equal(delays[0], 16)
    })
    n.destroy()
  })

  it('uses the default window when 0 clients (or unknown count) are subscribed', () => {
    const nZero = new EventNormalizer({ getSubscriberCount: () => 0 })
    withSetTimeoutSpy((delays) => {
      nZero.bufferDelta('sess-1', 'msg-1', 'hi')
      assert.equal(delays[0], 16)
    })
    nZero.destroy()

    const nNull = new EventNormalizer({ getSubscriberCount: () => null })
    withSetTimeoutSpy((delays) => {
      nNull.bufferDelta('sess-1', 'msg-1', 'hi')
      assert.equal(delays[0], 16)
    })
    nNull.destroy()
  })

  it('keeps the default window when no subscriber-count resolver is wired (legacy)', () => {
    const n = new EventNormalizer()
    withSetTimeoutSpy((delays) => {
      n.bufferDelta('sess-1', 'msg-1', 'hi')
      assert.equal(delays[0], 16)
    })
    n.destroy()
  })

  it('honors custom interval overrides', () => {
    const n = new EventNormalizer({
      flushIntervalMs: 80,
      singleClientFlushIntervalMs: 12,
      getSubscriberCount: () => 1,
    })
    withSetTimeoutSpy((delays) => {
      n.bufferDelta('sess-1', 'msg-1', 'hi')
      assert.equal(delays[0], 12)
    })
    n.destroy()
  })

  it('a single-client buffer pulls in an already-armed default-window deadline', () => {
    // Per-session subscriber counts: sess-multi has 3 clients, sess-solo has 1.
    const counts = { 'sess-multi': 3, 'sess-solo': 1 }
    const n = new EventNormalizer({ getSubscriberCount: (s) => counts[s] ?? 0 })
    withSetTimeoutSpy((delays) => {
      // Pin the clock the normalizer reads so the pull-in is deterministic.
      // bufferDelta computes `wantDeadline = performance.now() + intervalMs` on
      // each call and only reschedules when the new deadline is SOONER than the
      // armed one. The solo call (now+8) must beat the multi deadline (now0+16),
      // which holds only while < 8ms of wall-clock elapsed between the two
      // synchronous calls. Under a >8ms GC/scheduling stall on a loaded CI runner
      // that window closes and the reschedule is (correctly) skipped — a real
      // flake (#5923). Freeze performance.now so the two reads are equal (0ms
      // elapsed), exercising the pull-in path the assertions below describe.
      mock.method(performance, 'now', () => 1000)
      // Multi-client session arms the 16ms timer first.
      n.bufferDelta('sess-multi', 'm', 'a')
      assert.equal(delays[0], 16)
      // A solo session buffered immediately after must SHORTEN the deadline:
      // the reschedule clears the old timer and arms a sooner one (~8ms).
      n.bufferDelta('sess-solo', 's', 'b')
      assert.equal(delays.length, 2, 'a reschedule must have occurred')
      assert.ok(delays[1] <= 8, `expected reschedule <=8ms, got ${delays[1]}`)
    })
    n.destroy()
  })

  it('does NOT push the deadline out when a multi-client session buffers after a solo one', () => {
    const counts = { 'sess-multi': 3, 'sess-solo': 1 }
    const n = new EventNormalizer({ getSubscriberCount: (s) => counts[s] ?? 0 })
    withSetTimeoutSpy((delays) => {
      n.bufferDelta('sess-solo', 's', 'a')      // arms ~8ms
      assert.equal(delays[0], 8)
      n.bufferDelta('sess-multi', 'm', 'b')     // wants 16ms — but 8ms deadline is sooner
      // No reschedule: the existing sooner deadline stands.
      assert.equal(delays.length, 1, 'must not reschedule to a later deadline')
    })
    n.destroy()
  })

  // #5562 + #5520: real-timer sanity check that the shrunk window actually
  // flushes a buffered delta through the real setTimeout path, and that the
  // #5515/#5520 emitMonoMs instrumentation bufferDelta carries through still
  // round-trips to the flushed entry after the window change. The EXACT 8/16ms
  // contract is locked by the setTimeout-spy tests above; this test deliberately
  // does NOT re-assert it. The upper bound here is a loose ceiling only — proof
  // the flush is no longer near the old 25/50ms-stacked floor — set well above
  // worst-case timer slip so it can't go flaky under CI scheduling jitter. A
  // bounded timeout makes a never-fired callback fail fast instead of hanging,
  // and destroy() runs in finally so an assertion failure can't leak the timer.
  it('flushes a single-subscriber delta via the real timer and round-trips emitMonoMs', async () => {
    const n = new EventNormalizer({ getSubscriberCount: () => 1 })
    try {
      const flushed = []
      let resolveFlush
      const done = new Promise((res) => { resolveFlush = res })
      n.onFlush = (entries) => {
        flushed.push({ at: performance.now(), entries })
        resolveFlush()
      }
      const emitMono = Number(process.hrtime.bigint() / 1_000_000n)
      const buffered = performance.now()
      n.bufferDelta('sess-1', 'msg-1', 'hello', emitMono)
      // Bounded race: if the flush callback never fires, fail fast rather than
      // hang until the test-runner timeout.
      let bail
      const timeout = new Promise((_, rej) => {
        bail = setTimeout(() => rej(new Error('flush callback did not fire within 1000ms')), 1000)
      })
      try {
        await Promise.race([done, timeout])
      } finally {
        clearTimeout(bail)
      }
      const elapsed = flushed[0].at - buffered
      // Loose ceiling — NOT the 8ms contract (that's the spy tests' job). 100ms is
      // far above any realistic single-timer slip yet still well below the old
      // 25/50ms server window stacked on the client EWMA, so it confirms the
      // server half no longer dominates without being jitter-sensitive.
      assert.ok(elapsed < 100, `expected a prompt real-timer flush, got ${elapsed.toFixed(1)}ms`)
      assert.equal(flushed[0].entries.length, 1)
      assert.equal(flushed[0].entries[0].delta, 'hello')
      // The #5520 emitMonoMs instrumentation survives the coalescing path.
      assert.equal(flushed[0].entries[0].emitMonoMs, emitMono)
    } finally {
      n.destroy()
    }
  })
})

describe('EventNormalizer deflate-aware flush window (#5578)', () => {
  // Same setTimeout spy as the #5516 block: record the scheduled flush delay
  // without letting the timer fire.
  function withSetTimeoutSpy(fn) {
    const delays = []
    const orig = global.setTimeout
    mock.method(global, 'setTimeout', (cb, ms, ...rest) => {
      delays.push(ms)
      return orig(() => {}, 1_000_000, ...rest)
    })
    try { fn(delays) } finally { mock.restoreAll() }
  }

  // Policy table (#5578):
  //   subscribers      | all-LAN | any-deflate
  //   ---------------- | ------- | -----------
  //   single (count 1) |   8ms   |    16ms
  //   multi  (count≥2) |  16ms   |    25ms
  // "any-deflate" = at least one subscriber on a deflate-negotiated
  // (tunnel/cellular) socket, where each sub-1024B stream_delta ships
  // uncompressed and the LAN floors triple the small-packet count.

  it('keeps the 8ms LAN floor for a single all-LAN subscriber', () => {
    const n = new EventNormalizer({
      getSubscriberCount: () => 1,
      getHasDeflateSubscriber: () => false,
    })
    withSetTimeoutSpy((delays) => {
      n.bufferDelta('sess-1', 'msg-1', 'hi')
      assert.equal(delays[0], 8)
    })
    n.destroy()
  })

  it('keeps the 16ms LAN floor for multiple all-LAN subscribers', () => {
    const n = new EventNormalizer({
      getSubscriberCount: () => 3,
      getHasDeflateSubscriber: () => false,
    })
    withSetTimeoutSpy((delays) => {
      n.bufferDelta('sess-1', 'msg-1', 'hi')
      assert.equal(delays[0], 16)
    })
    n.destroy()
  })

  it('widens to 16ms when the sole subscriber is on a deflate socket', () => {
    const n = new EventNormalizer({
      getSubscriberCount: () => 1,
      getHasDeflateSubscriber: () => true,
    })
    withSetTimeoutSpy((delays) => {
      n.bufferDelta('sess-1', 'msg-1', 'hi')
      assert.equal(delays[0], 16)
    })
    n.destroy()
  })

  it('widens to 25ms when a multi-client session has any deflate subscriber (mixed)', () => {
    // 3 subscribers, at least one on a deflate socket → the widened multi window.
    const n = new EventNormalizer({
      getSubscriberCount: () => 3,
      getHasDeflateSubscriber: () => true,
    })
    withSetTimeoutSpy((delays) => {
      n.bufferDelta('sess-1', 'msg-1', 'hi')
      assert.equal(delays[0], 25)
    })
    n.destroy()
  })

  it('re-resolves the window when subscribers join/leave mid-session', () => {
    // The predicates are read live on every bufferDelta, so a join (LAN→deflate)
    // or a leave (deflate→LAN) flips the window without any cached state.
    const state = { count: 1, deflate: false }
    const n = new EventNormalizer({
      getSubscriberCount: () => state.count,
      getHasDeflateSubscriber: () => state.deflate,
    })
    withSetTimeoutSpy((delays) => {
      // 1 LAN viewer → 8ms.
      n.bufferDelta('sess-1', 'm1', 'a')
      assert.equal(delays.at(-1), 8)
      // A phone on cellular joins (now a deflate subscriber present, still single
      // would be 16, but it's now 2 clients) → widened multi window 25ms. The
      // delta buffers into the SAME pending window, which only shortens, so to
      // observe the new resolve we flush first.
      n.flushSession('sess-1')
      state.count = 2
      state.deflate = true
      n.bufferDelta('sess-1', 'm2', 'b')
      assert.equal(delays.at(-1), 25)
      // The cellular peer leaves; back to a single LAN viewer → 8ms floor.
      n.flushSession('sess-1')
      state.count = 1
      state.deflate = false
      n.bufferDelta('sess-1', 'm3', 'c')
      assert.equal(delays.at(-1), 8)
    })
    n.destroy()
  })

  it('honors custom deflate interval overrides', () => {
    const n = new EventNormalizer({
      deflateFlushIntervalMs: 40,
      deflateSingleClientFlushIntervalMs: 20,
      getSubscriberCount: () => 1,
      getHasDeflateSubscriber: () => true,
    })
    withSetTimeoutSpy((delays) => {
      n.bufferDelta('sess-1', 'msg-1', 'hi')
      assert.equal(delays[0], 20)
    })
    n.destroy()
  })

  it('ignores the deflate predicate when no subscriber-count resolver is wired (legacy)', () => {
    // Legacy single-session mode has no way to resolve subscribers; the LAN
    // default stands regardless of the deflate predicate.
    const n = new EventNormalizer({ getHasDeflateSubscriber: () => true })
    withSetTimeoutSpy((delays) => {
      n.bufferDelta('sess-1', 'msg-1', 'hi')
      assert.equal(delays[0], 16)
    })
    n.destroy()
  })

  it('does NOT re-scan all clients — resolves via the wired O(subscribers) predicates only', () => {
    // Guard against a regression that reintroduces an O(all-clients) scan on the
    // per-token hot path: bufferDelta must consult ONLY the injected resolvers,
    // once each per call, never iterate a client collection itself.
    let countCalls = 0
    let deflateCalls = 0
    const n = new EventNormalizer({
      getSubscriberCount: () => { countCalls++; return 1 },
      getHasDeflateSubscriber: () => { deflateCalls++; return true },
    })
    withSetTimeoutSpy(() => {
      n.bufferDelta('sess-1', 'm1', 'a')
    })
    assert.equal(countCalls, 1, 'subscriber count resolved exactly once per buffered delta')
    assert.equal(deflateCalls, 1, 'deflate predicate resolved exactly once per buffered delta')
    n.destroy()
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
