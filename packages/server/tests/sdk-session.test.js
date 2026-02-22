import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { SdkSession } from '../src/sdk-session.js'

/**
 * Tests for SdkSession — permission handling, question handling,
 * agent tracking, model/permission mode changes, and cleanup.
 *
 * These tests instantiate SdkSession without calling start() or
 * sendMessage() and exercise internal methods directly.
 */

function createSession(opts = {}) {
  return new SdkSession({ cwd: '/tmp', ...opts })
}

describe('SdkSession', () => {
  let session

  beforeEach(() => {
    session = createSession()
  })

  afterEach(() => {
    session.destroy()
  })

  // -- Constructor --

  describe('constructor', () => {
    it('sets default values', () => {
      assert.equal(session.cwd, '/tmp')
      assert.equal(session.model, null)
      assert.equal(session.permissionMode, 'approve')
      assert.equal(session._isBusy, false)
      assert.equal(session._processReady, false)
    })

    it('accepts model and permissionMode options', () => {
      const s = createSession({ model: 'opus', permissionMode: 'auto' })
      assert.equal(s.model, 'opus')
      assert.equal(s.permissionMode, 'auto')
      s.destroy()
    })

    it('does not accept allowedTools', () => {
      assert.equal(session.allowedTools, undefined)
    })
  })

  // -- start() --

  describe('start', () => {
    it('emits ready and sets processReady', () => {
      const events = []
      session.on('ready', (data) => events.push(data))
      session.start()
      assert.equal(session._processReady, true)
      assert.equal(events.length, 1)
      assert.equal(events[0].model, null)
    })
  })

  // -- Permission handling --

  describe('_handlePermission', () => {
    it('emits permission_request and resolves on respondToPermission (allow)', async () => {
      const events = []
      session.on('permission_request', (data) => events.push(data))

      const promise = session._handlePermission('Bash', { command: 'ls' }, null)

      assert.equal(events.length, 1)
      assert.equal(events[0].tool, 'Bash')
      assert.ok(events[0].requestId)

      session.respondToPermission(events[0].requestId, 'allow')
      const result = await promise
      assert.equal(result.behavior, 'allow')
      assert.deepEqual(result.updatedInput, { command: 'ls' })
    })

    it('resolves with deny on respondToPermission (deny)', async () => {
      const events = []
      session.on('permission_request', (data) => events.push(data))

      const promise = session._handlePermission('Write', { file_path: '/x' }, null)
      session.respondToPermission(events[0].requestId, 'deny')

      const result = await promise
      assert.equal(result.behavior, 'deny')
    })

    it('resolves with allowAlways on respondToPermission (allowAlways)', async () => {
      const events = []
      session.on('permission_request', (data) => events.push(data))

      const promise = session._handlePermission('Bash', { command: 'npm test' }, null)
      const requestId = events[0].requestId
      assert.ok(session._permissionTimers.has(requestId))

      session.respondToPermission(requestId, 'allowAlways')

      const result = await promise
      assert.equal(result.behavior, 'allowAlways')
      assert.deepEqual(result.updatedInput, { command: 'npm test' })
      assert.ok(!session._pendingPermissions.has(requestId))
      assert.ok(!session._permissionTimers.has(requestId))
    })

    it('auto-denies on abort signal', async () => {
      const controller = new AbortController()
      const promise = session._handlePermission('Bash', {}, controller.signal)
      controller.abort()

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.ok(result.message.includes('cancelled') || result.message.includes('Cancelled'))
    })

    it('clears permission timer on response', async () => {
      const events = []
      session.on('permission_request', (data) => events.push(data))

      session._handlePermission('Read', {}, null)
      const requestId = events[0].requestId
      assert.ok(session._permissionTimers.has(requestId))

      session.respondToPermission(requestId, 'allow')
      assert.ok(!session._permissionTimers.has(requestId))
    })

    it('warns on unknown requestId', () => {
      // Should not throw
      session.respondToPermission('nonexistent', 'allow')
    })
  })

  // -- acceptEdits permission mode --

  describe('acceptEdits permission mode', () => {
    it('auto-approves file operation tools', async () => {
      session.permissionMode = 'acceptEdits'
      const events = []
      session.on('permission_request', (data) => events.push(data))

      const result = await session._handlePermission('Read', { file_path: '/tmp/x' }, null)
      assert.equal(result.behavior, 'allow')
      assert.equal(events.length, 0, 'Should NOT emit permission_request for file ops')
    })

    it('auto-approves all ACCEPT_EDITS_TOOLS', async () => {
      session.permissionMode = 'acceptEdits'
      const tools = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']

      for (const tool of tools) {
        const result = await session._handlePermission(tool, {}, null)
        assert.equal(result.behavior, 'allow', `${tool} should be auto-approved`)
      }
    })

    it('still prompts for Bash tool', async () => {
      session.permissionMode = 'acceptEdits'
      const events = []
      session.on('permission_request', (data) => events.push(data))

      const promise = session._handlePermission('Bash', { command: 'rm -rf /' }, null)

      assert.equal(events.length, 1, 'Should emit permission_request for Bash')
      assert.equal(events[0].tool, 'Bash')

      session.respondToPermission(events[0].requestId, 'allow')
      const result = await promise
      assert.equal(result.behavior, 'allow')
    })

    it('still prompts for WebFetch tool', async () => {
      session.permissionMode = 'acceptEdits'
      const events = []
      session.on('permission_request', (data) => events.push(data))

      const promise = session._handlePermission('WebFetch', { url: 'https://example.com' }, null)
      assert.equal(events.length, 1, 'Should emit permission_request for WebFetch')

      session.respondToPermission(events[0].requestId, 'deny')
      const result = await promise
      assert.equal(result.behavior, 'deny')
    })
  })

  // -- AskUserQuestion handling --

  describe('_handleAskUserQuestion', () => {
    it('emits user_question and resolves on respondToQuestion', async () => {
      const events = []
      session.on('user_question', (data) => events.push(data))

      const questions = [{ question: 'Pick one?', options: [{ label: 'A' }] }]
      const promise = session._handleAskUserQuestion({ questions }, null)

      assert.equal(events.length, 1)
      assert.deepEqual(events[0].questions, questions)
      assert.equal(session._waitingForAnswer, true)

      session.respondToQuestion('A')
      const result = await promise
      assert.equal(result.behavior, 'allow')
      assert.deepEqual(result.updatedInput.answers, { 'Pick one?': 'A' })
      assert.equal(session._waitingForAnswer, false)
    })

    it('auto-denies on abort signal', async () => {
      const controller = new AbortController()
      const promise = session._handleAskUserQuestion({ questions: [] }, controller.signal)
      controller.abort()

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.equal(session._waitingForAnswer, false)
    })

    it('clears question timer on respondToQuestion', async () => {
      session._handleAskUserQuestion({ questions: [] }, null)
      assert.ok(session._questionTimer !== null)

      session.respondToQuestion('answer')
      assert.equal(session._questionTimer, null)
    })

    it('no-ops respondToQuestion when no pending answer', () => {
      // Should not throw
      session.respondToQuestion('stale answer')
    })
  })

  // -- _handlePermission routing --

  describe('_handlePermission routing', () => {
    it('routes AskUserQuestion to _handleAskUserQuestion', async () => {
      const events = []
      session.on('user_question', (data) => events.push(data))

      const promise = session._handlePermission('AskUserQuestion', { questions: [] }, null)
      session.respondToQuestion('ok')

      const result = await promise
      assert.equal(result.behavior, 'allow')
      assert.equal(events.length, 1)
    })
  })

  // -- Agent tracking --

  describe('_handleToolUseBlock', () => {
    it('tracks Task tool as agent', () => {
      const events = []
      session.on('agent_spawned', (data) => events.push(data))

      session._handleToolUseBlock('msg-1', {
        name: 'Task',
        id: 'tool-1',
        input: { description: 'Explore codebase' },
      })

      assert.equal(events.length, 1)
      assert.equal(events[0].toolUseId, 'tool-1')
      assert.equal(events[0].description, 'Explore codebase')
      assert.ok(session._activeAgents.has('tool-1'))
    })

    it('truncates long descriptions to 200 chars', () => {
      const events = []
      session.on('agent_spawned', (data) => events.push(data))

      session._handleToolUseBlock('msg-1', {
        name: 'Task',
        id: 'tool-2',
        input: { description: 'x'.repeat(300) },
      })

      assert.equal(events[0].description.length, 200)
    })

    it('ignores non-Task tools', () => {
      const events = []
      session.on('agent_spawned', (data) => events.push(data))

      session._handleToolUseBlock('msg-1', { name: 'Bash', id: 'tool-3', input: {} })
      assert.equal(events.length, 0)
      assert.equal(session._activeAgents.size, 0)
    })

    it('emits error for oversized tool input', () => {
      const errors = []
      session.on('error', (data) => errors.push(data))

      const bigInput = { data: 'x'.repeat(session._maxToolInput) }
      session._handleToolUseBlock('msg-1', { name: 'Write', id: 'tool-big', input: bigInput })

      assert.equal(errors.length, 1)
      assert.ok(errors[0].message.includes('Tool input too large'))
      assert.ok(errors[0].message.includes('Write'))
    })

    it('skips agent tracking when input exceeds cap', () => {
      const spawned = []
      const errors = []
      session.on('agent_spawned', (data) => spawned.push(data))
      session.on('error', (data) => errors.push(data))

      const bigInput = { description: 'x'.repeat(session._maxToolInput) }
      session._handleToolUseBlock('msg-1', { name: 'Task', id: 'tool-task', input: bigInput })

      assert.equal(spawned.length, 0)
      assert.equal(errors.length, 1)
    })

    it('accepts maxToolInput constructor option', () => {
      const s = createSession({ maxToolInput: 1024 })
      assert.equal(s._maxToolInput, 1024)

      const errors = []
      s.on('error', (data) => errors.push(data))
      s._handleToolUseBlock('msg-1', { name: 'Bash', id: 'tool-4', input: { cmd: 'x'.repeat(2000) } })
      assert.equal(errors.length, 1)
      s.destroy()
    })
  })

  // -- _clearMessageState --

  describe('_clearMessageState', () => {
    it('emits agent_completed for all active agents', () => {
      const events = []
      session.on('agent_completed', (data) => events.push(data))

      session._activeAgents.set('a1', { toolUseId: 'a1', description: 'test', startedAt: 1 })
      session._activeAgents.set('a2', { toolUseId: 'a2', description: 'test', startedAt: 2 })
      session._isBusy = true

      session._clearMessageState()

      assert.equal(events.length, 2)
      assert.equal(session._activeAgents.size, 0)
      assert.equal(session._isBusy, false)
    })

    it('auto-denies pending permissions', async () => {
      const promise = session._handlePermission('Bash', {}, null)
      session._clearMessageState()

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.equal(session._pendingPermissions.size, 0)
    })

    it('auto-denies pending user answer', async () => {
      const promise = session._handleAskUserQuestion({ questions: [] }, null)
      session._clearMessageState()

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.equal(session._pendingUserAnswer, null)
    })

    it('clears result timeout', () => {
      session._resultTimeout = setTimeout(() => {}, 999999)
      session._clearMessageState()
      assert.equal(session._resultTimeout, null)
    })

    it('clears question timer', () => {
      session._questionTimer = setTimeout(() => {}, 999999)
      session._clearMessageState()
      assert.equal(session._questionTimer, null)
    })
  })

  // -- Model / Permission Mode --

  describe('setModel', () => {
    it('changes model when not busy', () => {
      session.setModel('sonnet')
      assert.ok(session.model) // resolveModelId may transform the name
    })

    it('ignores model change when busy', () => {
      session._isBusy = true
      const original = session.model
      session.setModel('opus')
      assert.equal(session.model, original)
    })
  })

  describe('setPermissionMode', () => {
    it('changes permission mode when not busy', () => {
      session.setPermissionMode('auto')
      assert.equal(session.permissionMode, 'auto')
    })

    it('ignores change when busy', () => {
      session._isBusy = true
      session.setPermissionMode('auto')
      assert.equal(session.permissionMode, 'approve')
    })

    it('rejects invalid modes', () => {
      session.setPermissionMode('invalid')
      assert.equal(session.permissionMode, 'approve')
    })

    it('accepts acceptEdits mode', () => {
      session.setPermissionMode('acceptEdits')
      assert.equal(session.permissionMode, 'acceptEdits')
    })
  })

  // -- _sdkPermissionMode --

  describe('_sdkPermissionMode', () => {
    it('maps approve to default', () => {
      session.permissionMode = 'approve'
      assert.equal(session._sdkPermissionMode(), 'default')
    })

    it('maps auto to bypassPermissions', () => {
      session.permissionMode = 'auto'
      assert.equal(session._sdkPermissionMode(), 'bypassPermissions')
    })

    it('maps plan to plan', () => {
      session.permissionMode = 'plan'
      assert.equal(session._sdkPermissionMode(), 'plan')
    })

    it('maps acceptEdits to default (uses canUseTool callback)', () => {
      session.permissionMode = 'acceptEdits'
      assert.equal(session._sdkPermissionMode(), 'default')
    })
  })

  // -- sendMessage while busy --

  describe('sendMessage while busy', () => {
    it('emits error when already processing', () => {
      session._isBusy = true
      const errors = []
      session.on('error', (data) => errors.push(data))

      session.sendMessage('hi')
      assert.equal(errors.length, 1)
      assert.ok(errors[0].message.includes('Already processing'))
    })
  })

  // -- destroy --

  describe('destroy', () => {
    it('cleans up pending permissions', async () => {
      const promise = session._handlePermission('Bash', {}, null)
      session.destroy()

      const result = await promise
      assert.equal(result.behavior, 'deny')
    })

    it('cleans up pending user answer', async () => {
      const promise = session._handleAskUserQuestion({ questions: [] }, null)
      session.destroy()

      const result = await promise
      assert.equal(result.behavior, 'deny')
    })

    it('sets destroying flag and clears processReady', () => {
      session.start()
      session.destroy()
      assert.equal(session._destroying, true)
      assert.equal(session._processReady, false)
    })

    it('removes all listeners', () => {
      session.on('ready', () => {})
      session.on('error', () => {})
      session.destroy()
      assert.equal(session.listenerCount('ready'), 0)
      assert.equal(session.listenerCount('error'), 0)
    })
  })

  // -- Getters --

  // -- Transform integration --

  describe('sendMessage applies transforms', () => {
    it('applies voiceCleanup when configured and isVoice is true', async () => {
      const s = createSession({ transforms: ['voiceCleanup'] })
      s._processReady = true

      // Spy on the pipeline's apply method
      const applyCalls = []
      const originalApply = s._transformPipeline.apply.bind(s._transformPipeline)
      s._transformPipeline.apply = (msg, ctx) => {
        applyCalls.push({ msg, ctx })
        return originalApply(msg, ctx)
      }

      // sendMessage will fail at the SDK query (no real client), but the
      // transform runs synchronously before the async part
      s.on('error', () => {}) // absorb the SDK error
      s.sendMessage('um fix the bug', [], { isVoice: true })

      // Give the async sendMessage a tick to start, then destroy to prevent hang
      await new Promise(r => setTimeout(r, 50))
      s.destroy()

      assert.equal(applyCalls.length, 1)
      assert.equal(applyCalls[0].msg, 'um fix the bug')
      assert.equal(applyCalls[0].ctx.isVoiceInput, true)
      assert.equal(applyCalls[0].ctx.cwd, '/tmp')
    })

    it('does not transform when no transforms configured', async () => {
      const s = createSession() // no transforms
      s._processReady = true

      const applyCalls = []
      const originalApply = s._transformPipeline.apply.bind(s._transformPipeline)
      s._transformPipeline.apply = (msg, ctx) => {
        applyCalls.push({ msg, ctx })
        return originalApply(msg, ctx)
      }

      s.on('error', () => {})
      s.sendMessage('hello world', [])

      await new Promise(r => setTimeout(r, 50))
      s.destroy()

      // Pipeline has no transforms, so apply is skipped (hasTransforms check)
      assert.equal(applyCalls.length, 0)
    })
  })

  describe('getters', () => {
    it('isRunning reflects _isBusy', () => {
      assert.equal(session.isRunning, false)
      session._isBusy = true
      assert.equal(session.isRunning, true)
    })

    it('isReady requires processReady and not busy', () => {
      assert.equal(session.isReady, false)
      session._processReady = true
      assert.equal(session.isReady, true)
      session._isBusy = true
      assert.equal(session.isReady, false)
    })
  })
})
