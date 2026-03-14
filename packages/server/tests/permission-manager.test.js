import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionManager } from '../src/permission-manager.js'

/**
 * Tests for PermissionManager — permission request lifecycle,
 * question handling, timeouts, abort signals, and cleanup.
 */

const silentLog = { info() {}, warn() {} }

function createManager(opts = {}) {
  return new PermissionManager({ log: silentLog, ...opts })
}

describe('PermissionManager', () => {
  let pm

  beforeEach(() => {
    pm = createManager()
  })

  afterEach(() => {
    pm.destroy()
  })

  // -- Permission requests --

  describe('handlePermission', () => {
    it('emits permission_request and creates entry in pending map', () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')

      assert.equal(events.length, 1)
      assert.equal(events[0].tool, 'Bash')
      assert.ok(events[0].requestId)
      assert.equal(events[0].description, 'ls')
      assert.ok(pm._pendingPermissions.has(events[0].requestId))
      assert.ok(pm._lastPermissionData.has(events[0].requestId))
    })

    it('resolves with allow on respondToPermission', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      const promise = pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
      pm.respondToPermission(events[0].requestId, 'allow')

      const result = await promise
      assert.equal(result.behavior, 'allow')
      assert.deepEqual(result.updatedInput, { command: 'ls' })
    })

    it('resolves with deny on respondToPermission', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      const promise = pm.handlePermission('Write', { file_path: '/x' }, null, 'approve')
      pm.respondToPermission(events[0].requestId, 'deny')

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.equal(result.message, 'User denied')
    })

    it('resolves with allowAlways on respondToPermission', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      const promise = pm.handlePermission('Bash', { command: 'npm test' }, null, 'approve')
      const requestId = events[0].requestId
      assert.ok(pm._permissionTimers.has(requestId))

      pm.respondToPermission(requestId, 'allowAlways')

      const result = await promise
      assert.equal(result.behavior, 'allowAlways')
      assert.deepEqual(result.updatedInput, { command: 'npm test' })
      assert.ok(!pm._pendingPermissions.has(requestId))
      assert.ok(!pm._permissionTimers.has(requestId))
    })

    it('cleans up pending map and timer on response', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      pm.handlePermission('Read', {}, null, 'approve')
      const requestId = events[0].requestId
      assert.ok(pm._pendingPermissions.has(requestId))
      assert.ok(pm._permissionTimers.has(requestId))
      assert.ok(pm._lastPermissionData.has(requestId))

      pm.respondToPermission(requestId, 'allow')
      assert.ok(!pm._pendingPermissions.has(requestId))
      assert.ok(!pm._permissionTimers.has(requestId))
      assert.ok(!pm._lastPermissionData.has(requestId))
    })

    it('auto-denies on abort signal', async () => {
      const controller = new AbortController()
      const promise = pm.handlePermission('Bash', {}, controller.signal, 'approve')
      controller.abort()

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.ok(result.message.includes('cancelled') || result.message.includes('Cancelled'))
    })

    it('warns on unknown requestId', () => {
      // Should not throw
      pm.respondToPermission('nonexistent', 'allow')
    })

    it('uses tool name as description when input is empty', () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      pm.handlePermission('Bash', {}, null, 'approve')
      assert.equal(events[0].description, 'Bash')
    })

    it('uses file_path as description', () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      pm.handlePermission('Read', { file_path: '/tmp/foo.txt' }, null, 'approve')
      assert.equal(events[0].description, '/tmp/foo.txt')
    })

    it('generates unique request IDs', () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      pm.handlePermission('Bash', {}, null, 'approve')
      pm.handlePermission('Read', {}, null, 'approve')

      assert.notEqual(events[0].requestId, events[1].requestId)
    })
  })

  // -- acceptEdits mode --

  describe('acceptEdits permission mode', () => {
    it('auto-approves file operation tools', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      const result = await pm.handlePermission('Read', { file_path: '/tmp/x' }, null, 'acceptEdits')
      assert.equal(result.behavior, 'allow')
      assert.equal(events.length, 0, 'Should NOT emit permission_request for file ops')
    })

    it('auto-approves all ACCEPT_EDITS_TOOLS', async () => {
      const tools = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']

      for (const tool of tools) {
        const result = await pm.handlePermission(tool, {}, null, 'acceptEdits')
        assert.equal(result.behavior, 'allow', `${tool} should be auto-approved`)
      }
    })

    it('still prompts for Bash tool', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      const promise = pm.handlePermission('Bash', { command: 'rm -rf /' }, null, 'acceptEdits')
      assert.equal(events.length, 1, 'Should emit permission_request for Bash')
      assert.equal(events[0].tool, 'Bash')

      pm.respondToPermission(events[0].requestId, 'allow')
      const result = await promise
      assert.equal(result.behavior, 'allow')
    })

    it('still prompts for WebFetch tool', async () => {
      const events = []
      pm.on('permission_request', (data) => events.push(data))

      const promise = pm.handlePermission('WebFetch', { url: 'https://example.com' }, null, 'acceptEdits')
      assert.equal(events.length, 1, 'Should emit permission_request for WebFetch')

      pm.respondToPermission(events[0].requestId, 'deny')
      const result = await promise
      assert.equal(result.behavior, 'deny')
    })
  })

  // -- AskUserQuestion handling --

  describe('AskUserQuestion handling', () => {
    it('routes AskUserQuestion through handlePermission', async () => {
      const events = []
      pm.on('user_question', (data) => events.push(data))

      const promise = pm.handlePermission('AskUserQuestion', { questions: [] }, null, 'approve')
      pm.respondToQuestion('ok')

      const result = await promise
      assert.equal(result.behavior, 'allow')
      assert.equal(events.length, 1)
    })

    it('emits user_question and resolves on respondToQuestion', async () => {
      const events = []
      pm.on('user_question', (data) => events.push(data))

      const questions = [{ question: 'Pick one?', options: [{ label: 'A' }] }]
      const promise = pm._handleAskUserQuestion({ questions }, null)

      assert.equal(events.length, 1)
      assert.deepEqual(events[0].questions, questions)
      assert.equal(pm._waitingForAnswer, true)

      pm.respondToQuestion('A')
      const result = await promise
      assert.equal(result.behavior, 'allow')
      assert.deepEqual(result.updatedInput.answers, { 'Pick one?': 'A' })
      assert.equal(pm._waitingForAnswer, false)
    })

    it('auto-denies on abort signal', async () => {
      const controller = new AbortController()
      const promise = pm._handleAskUserQuestion({ questions: [] }, controller.signal)
      controller.abort()

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.equal(pm._waitingForAnswer, false)
    })

    it('clears question timer on respondToQuestion', async () => {
      pm._handleAskUserQuestion({ questions: [] }, null)
      assert.ok(pm._questionTimer !== null)

      pm.respondToQuestion('answer')
      assert.equal(pm._questionTimer, null)
    })

    it('no-ops respondToQuestion when no pending answer', () => {
      // Should not throw
      pm.respondToQuestion('stale answer')
    })

    it('supports per-question answersMap', async () => {
      const questions = [
        { question: 'Color?', options: [{ label: 'Red' }] },
        { question: 'Size?', options: [{ label: 'Large' }] },
      ]
      const promise = pm._handleAskUserQuestion({ questions }, null)

      pm.respondToQuestion('Red', { 'Color?': 'Red', 'Size?': 'Large' })
      const result = await promise
      assert.deepEqual(result.updatedInput.answers, { 'Color?': 'Red', 'Size?': 'Large' })
    })

    it('filters unknown question keys from answersMap', async () => {
      const questions = [{ question: 'Color?' }]
      const promise = pm._handleAskUserQuestion({ questions }, null)

      pm.respondToQuestion('Red', { 'Color?': 'Red', 'Unknown?': 'x' })
      const result = await promise
      assert.deepEqual(result.updatedInput.answers, { 'Color?': 'Red' })
      assert.ok(!('Unknown?' in result.updatedInput.answers))
    })
  })

  // -- clearAll --

  describe('clearAll', () => {
    it('auto-denies all pending permissions', async () => {
      const promise1 = pm.handlePermission('Bash', {}, null, 'approve')
      const promise2 = pm.handlePermission('Read', {}, null, 'approve')

      pm.clearAll()

      const result1 = await promise1
      const result2 = await promise2
      assert.equal(result1.behavior, 'deny')
      assert.equal(result2.behavior, 'deny')
      assert.equal(pm._pendingPermissions.size, 0)
      assert.equal(pm._lastPermissionData.size, 0)
    })

    it('auto-denies pending user answer', async () => {
      const promise = pm._handleAskUserQuestion({ questions: [] }, null)
      pm.clearAll()

      const result = await promise
      assert.equal(result.behavior, 'deny')
      assert.equal(pm._pendingUserAnswer, null)
      assert.equal(pm._waitingForAnswer, false)
    })

    it('clears question timer', () => {
      pm._questionTimer = setTimeout(() => {}, 999999)
      pm.clearAll()
      assert.equal(pm._questionTimer, null)
    })
  })

  // -- destroy --

  describe('destroy', () => {
    it('cleans up pending permissions', async () => {
      const promise = pm.handlePermission('Bash', {}, null, 'approve')
      pm.destroy()

      const result = await promise
      assert.equal(result.behavior, 'deny')
    })

    it('cleans up pending user answer', async () => {
      const promise = pm._handleAskUserQuestion({ questions: [] }, null)
      pm.destroy()

      const result = await promise
      assert.equal(result.behavior, 'deny')
    })

    it('removes all listeners', () => {
      pm.on('permission_request', () => {})
      pm.on('user_question', () => {})
      pm.destroy()
      assert.equal(pm.listenerCount('permission_request'), 0)
      assert.equal(pm.listenerCount('user_question'), 0)
    })
  })

  // -- Timeout configuration --

  describe('timeout configuration', () => {
    it('uses custom timeout', () => {
      const custom = createManager({ timeoutMs: 60_000 })
      assert.equal(custom._timeoutMs, 60_000)
      custom.destroy()
    })

    it('defaults to 300_000ms', () => {
      assert.equal(pm._timeoutMs, 300_000)
    })

    it('includes remainingMs in permission_request payload', () => {
      const custom = createManager({ timeoutMs: 60_000 })
      const events = []
      custom.on('permission_request', (data) => events.push(data))

      custom.handlePermission('Bash', {}, null, 'approve')
      assert.equal(events[0].remainingMs, 60_000)
      custom.destroy()
    })
  })
})
