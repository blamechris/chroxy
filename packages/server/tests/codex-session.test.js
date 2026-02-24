import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { CodexSession } from '../src/codex-session.js'

/**
 * Tests for CodexSession — constructor, capabilities, start,
 * model/permission changes, event mapping, and cleanup.
 *
 * These tests instantiate CodexSession without spawning real codex
 * processes — they exercise internal methods and event mapping directly.
 */

function createSession(opts = {}) {
  return new CodexSession({ cwd: '/tmp', ...opts })
}

describe('CodexSession', () => {
  let session

  beforeEach(() => {
    session = createSession()
  })

  afterEach(() => {
    session.destroy()
  })

  // -- Capabilities --

  describe('capabilities', () => {
    it('declares correct capabilities', () => {
      const caps = CodexSession.capabilities
      assert.equal(caps.permissions, false)
      assert.equal(caps.inProcessPermissions, false)
      assert.equal(caps.modelSwitch, true)
      assert.equal(caps.permissionModeSwitch, true)
      assert.equal(caps.planMode, false)
      assert.equal(caps.resume, true)
      assert.equal(caps.terminal, false)
    })
  })

  // -- Constructor --

  describe('constructor', () => {
    it('sets default values', () => {
      assert.equal(session.cwd, '/tmp')
      assert.equal(session.model, 'codex-mini')
      assert.equal(session.permissionMode, 'approve')
      assert.equal(session.isRunning, false)
      assert.equal(session.resumeSessionId, null)
    })

    it('accepts model and permissionMode options', () => {
      const s = createSession({ model: 'o4-mini', permissionMode: 'auto' })
      assert.equal(s.model, 'o4-mini')
      assert.equal(s.permissionMode, 'auto')
      s.destroy()
    })

    it('restores threadId from resumeSessionId', () => {
      const s = createSession({ resumeSessionId: 'thread-123' })
      assert.equal(s.resumeSessionId, 'thread-123')
      s.destroy()
    })
  })

  // -- start() --

  describe('start', () => {
    it('emits ready and sets processReady', () => {
      const events = []
      session.on('ready', (data) => events.push(data))
      session.start()
      assert.equal(session._processReady, true)
      assert.equal(session.isReady, true)
      assert.equal(events.length, 1)
      assert.equal(events[0].model, 'codex-mini')
    })
  })

  // -- Model switching --

  describe('setModel', () => {
    it('changes model when not busy', () => {
      session.start()
      session.setModel('o3-mini')
      assert.equal(session.model, 'o3-mini')
    })

    it('ignores model change when busy', () => {
      session.start()
      session._isBusy = true
      session.setModel('o3-mini')
      assert.equal(session.model, 'codex-mini')
    })

    it('falls back to default when null', () => {
      session.start()
      session.setModel(null)
      assert.equal(session.model, 'codex-mini')
    })
  })

  // -- Permission mode switching --

  describe('setPermissionMode', () => {
    it('changes permission mode when not busy', () => {
      session.start()
      session.setPermissionMode('auto')
      assert.equal(session.permissionMode, 'auto')
    })

    it('ignores change when busy', () => {
      session.start()
      session._isBusy = true
      session.setPermissionMode('auto')
      assert.equal(session.permissionMode, 'approve')
    })

    it('ignores invalid modes', () => {
      session.start()
      session.setPermissionMode('bogus')
      assert.equal(session.permissionMode, 'approve')
    })
  })

  // -- Event mapping --

  describe('_handleEvent', () => {
    const messageId = 'msg-1'

    it('captures threadId from thread.started', () => {
      session._handleEvent({ type: 'thread.started', thread_id: 'thread-abc' }, messageId)
      assert.equal(session.resumeSessionId, 'thread-abc')
    })

    it('emits stream_start on agent_message item.started', () => {
      session._isBusy = true
      session._currentMessageId = messageId
      const events = []
      session.on('stream_start', (data) => events.push(data))
      session._handleEvent({ type: 'item.started', item: { id: 'item-1', type: 'agent_message' } }, messageId)
      assert.equal(events.length, 1)
      assert.equal(events[0].messageId, messageId)
      assert.equal(session._hasStreamStarted, true)
    })

    it('emits stream_delta on agent_message item.completed', () => {
      session._isBusy = true
      session._currentMessageId = messageId
      const deltas = []
      session.on('stream_delta', (data) => deltas.push(data))
      session._handleEvent({ type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: 'Hello!' } }, messageId)
      assert.equal(deltas.length, 1)
      assert.equal(deltas[0].delta, 'Hello!')
    })

    it('emits tool_start on command_execution item.started', () => {
      session._isBusy = true
      const events = []
      session.on('tool_start', (data) => events.push(data))
      session._handleEvent({
        type: 'item.started',
        item: { id: 'cmd-1', type: 'command_execution', command: 'ls -la' },
      }, messageId)
      assert.equal(events.length, 1)
      assert.equal(events[0].tool, 'Bash')
      assert.equal(events[0].input.command, 'ls -la')
      assert.equal(events[0].toolUseId, 'cmd-1')
    })

    it('emits tool_result on command_execution item.completed', () => {
      session._isBusy = true
      const events = []
      session.on('tool_result', (data) => events.push(data))
      session._handleEvent({
        type: 'item.completed',
        item: { id: 'cmd-1', type: 'command_execution', output: 'file1.js\nfile2.js' },
      }, messageId)
      assert.equal(events.length, 1)
      assert.equal(events[0].toolUseId, 'cmd-1')
      assert.equal(events[0].result, 'file1.js\nfile2.js')
    })

    it('emits tool_start on file_change item.started', () => {
      session._isBusy = true
      const events = []
      session.on('tool_start', (data) => events.push(data))
      session._handleEvent({
        type: 'item.started',
        item: { id: 'fc-1', type: 'file_change', operation: 'create', file: 'src/index.js' },
      }, messageId)
      assert.equal(events.length, 1)
      assert.equal(events[0].tool, 'Write')
      assert.equal(events[0].input.file_path, 'src/index.js')
    })

    it('emits Edit tool for non-create file_change', () => {
      session._isBusy = true
      const events = []
      session.on('tool_start', (data) => events.push(data))
      session._handleEvent({
        type: 'item.started',
        item: { id: 'fc-2', type: 'file_change', operation: 'modify', file: 'src/index.js' },
      }, messageId)
      assert.equal(events[0].tool, 'Edit')
    })

    it('emits result on turn.completed', () => {
      session._isBusy = true
      session._currentMessageId = messageId
      const results = []
      session.on('result', (data) => results.push(data))
      session._handleEvent({
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 80 },
      }, messageId)
      assert.equal(results.length, 1)
      assert.equal(results[0].usage.input_tokens, 100)
      assert.equal(results[0].usage.output_tokens, 50)
      assert.equal(results[0].usage.cache_read_input_tokens, 80)
      assert.equal(session.isRunning, false)
    })

    it('emits error on turn.failed', () => {
      session._isBusy = true
      session._currentMessageId = messageId
      const errors = []
      session.on('error', (data) => errors.push(data))
      session._handleEvent({ type: 'turn.failed', message: 'Rate limited' }, messageId)
      assert.equal(errors.length, 1)
      assert.equal(errors[0].message, 'Rate limited')
      assert.equal(session.isRunning, false)
    })

    it('emits error on error event', () => {
      const errors = []
      session.on('error', (data) => errors.push(data))
      session._handleEvent({ type: 'error', message: 'Connection lost' }, messageId)
      assert.equal(errors.length, 1)
      assert.equal(errors[0].message, 'Connection lost')
    })

    it('closes stream before result on turn.completed', () => {
      session._isBusy = true
      session._currentMessageId = messageId
      session._hasStreamStarted = true
      const events = []
      session.on('stream_end', (data) => events.push(data))
      session.on('result', () => events.push('result'))
      session._handleEvent({ type: 'turn.completed', usage: {} }, messageId)
      assert.equal(events[0].messageId, messageId)
      assert.equal(events[1], 'result')
    })
  })

  // -- No-op methods --

  describe('no-op methods', () => {
    it('respondToPermission does not throw', () => {
      session.respondToPermission('req-1', 'allow')
    })

    it('respondToQuestion does not throw', () => {
      session.respondToQuestion('test answer')
    })
  })

  // -- Cleanup --

  describe('destroy', () => {
    it('clears state and removes listeners', () => {
      session.start()
      session.on('ready', () => {})
      session.destroy()
      assert.equal(session._processReady, false)
      assert.equal(session._destroying, true)
      assert.equal(session.listenerCount('ready'), 0)
    })
  })
})
